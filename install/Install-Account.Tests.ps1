# install/Install-Account.Tests.ps1
Describe "Install-Account" {
    BeforeAll {
        $script:install = "$PSScriptRoot/Install-Account.ps1"
        $script:repoRoot = Split-Path $PSScriptRoot -Parent

        # A payload shaped like account/claude, planted rather than exported, so these tests
        # never depend on Task 14 having run and never read the operator's live ~/.claude.
        function New-StandInPayload {
            # -Path is round 3's addition: every caller before now took the auto-generated guid
            # path, so a caller that needs the payload's content at a specific directory (the
            # $sep sibling-name test, the containment-guard canonicalisation test) can still get
            # the same file set without duplicating it.
            param([string]$Path)
            $p = if ($Path) { $Path } else { Join-Path ([System.IO.Path]::GetTempPath()) ("acct-payload-" + [guid]::NewGuid()) }
            foreach ($d in 'rules', 'agents', 'hooks', 'skills/prose-lint', 'tools/prose-lint') {
                New-Item -ItemType Directory -Path (Join-Path $p $d) -Force | Out-Null
            }
            'rule body'           | Set-Content (Join-Path $p 'rules/security.md')
            'Core repo: {{CORE_REPO}}' | Set-Content (Join-Path $p 'rules/harness-core.md')
            'agent def'           | Set-Content (Join-Path $p 'agents/appsec-sme.md')
            'vale --config "{{CLAUDE_HOME}}/tools/prose-lint/.vale.ini"' |
                Set-Content (Join-Path $p 'skills/prose-lint/SKILL.md')
            'StylesPath = styles' | Set-Content (Join-Path $p 'tools/prose-lint/.vale.ini')
            'exit 0'              | Set-Content (Join-Path $p 'hooks/Scan-MemorySecrets.ps1')
            'the core is at {{CORE_REPO}}' | Set-Content (Join-Path $p 'hooks/harness-core-reminder.sh')
            'ps statusline'       | Set-Content (Join-Path $p 'statusline-command.ps1')
            'sh statusline'       | Set-Content (Join-Path $p 'statusline-command.sh')
            '{"hooks":{}}'        | Set-Content (Join-Path $p 'settings.account.json')
            '{"mcpServers":{}}'   | Set-Content (Join-Path $p 'mcp-servers.json')
            return $p
        }

        function New-StandInClaudeHome {
            $h = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-home-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $h -Force | Out-Null
            return $h
        }
    }

    # Review round 2, item C: one assertion per It. Nine assertions used to share one It, so
    # three different coverage-table ablations (recursive tree copy, root-file copy, the
    # root-file allowlist) each broke a different assertion and each still only ever reported
    # as the same single failing It, since Pester aborts an It at the first failing Should. The
    # install itself runs once in BeforeAll; every It below only asserts against its result.
    Context "copies the payload tree into the target claude home" {
        BeforeAll {
            $script:t1p = New-StandInPayload
            $script:t1h = New-StandInClaudeHome
            & $script:install -PayloadRoot $script:t1p -ClaudeHome $script:t1h `
                -ClaudeJson (Join-Path $script:t1h 'claude.json') -SkipPreflight | Out-Null
        }
        AfterAll {
            Remove-Item -Recurse -Force $script:t1p, $script:t1h -ErrorAction SilentlyContinue
        }

        It "copies rules/security.md" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'rules/security.md') | Should -BeTrue
        }
        It "copies agents/appsec-sme.md" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'agents/appsec-sme.md') | Should -BeTrue
        }
        It "copies skills/prose-lint/SKILL.md" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'skills/prose-lint/SKILL.md') | Should -BeTrue
        }
        It "copies tools/prose-lint/.vale.ini" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'tools/prose-lint/.vale.ini') | Should -BeTrue
        }
        It "copies hooks/Scan-MemorySecrets.ps1" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'hooks/Scan-MemorySecrets.ps1') | Should -BeTrue
        }
        It "copies statusline-command.ps1" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'statusline-command.ps1') | Should -BeTrue
        }
        It "copies statusline-command.sh" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'statusline-command.sh') | Should -BeTrue
        }
        # The payload's own files are inputs, not content, and must not land in the target.
        It "does not copy the payload's own settings.account.json" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'settings.account.json') | Should -BeFalse
        }
        It "does not copy the payload's own mcp-servers.json" {
            Test-Path -LiteralPath (Join-Path $script:t1h 'mcp-servers.json') | Should -BeFalse
        }
    }

    It "installs model-tier-gate.ts from core, byte-identical, though the payload lacks it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            Test-Path -LiteralPath (Join-Path $p 'hooks/model-tier-gate.ts') |
                Should -BeFalse -Because "core owns that file and the exporter skips it"
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') `
                -CoreRepo $script:repoRoot -SkipPreflight | Out-Null
            $installed = Join-Path $h 'hooks/model-tier-gate.ts'
            Test-Path -LiteralPath $installed | Should -BeTrue
            (Get-FileHash $installed -Algorithm SHA256).Hash |
                Should -Be (Get-FileHash (Join-Path $script:repoRoot 'core/claude/hooks/model-tier-gate.ts') -Algorithm SHA256).Hash
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 2, item C: -ForEach makes each tool its own It. Measured: dropping vale, uvx
    # and jq from the prerequisite list at once used to produce one failure line naming only
    # vale, since Pester stops at the first failing Should in a bundled It. The install runs
    # once in BeforeAll, under the same emptied PATH the original test used.
    Context "names every absent prerequisite, and jq only when the Linux fallback needs it" {
        BeforeAll {
            $script:t3p = New-StandInPayload
            $script:t3h = New-StandInClaudeHome
            # PATH emptied to a directory holding nothing, so every probe misses. Without this
            # the assertion would depend on what happens to be installed on the runner.
            $emptyBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-bin-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $emptyBin -Force | Out-Null
            $savedPath = $env:PATH
            try {
                $env:PATH = $emptyBin
                $script:t3out = & $script:install -PayloadRoot $script:t3p -ClaudeHome $script:t3h `
                    -ClaudeJson (Join-Path $script:t3h 'claude.json') `
                    -CoreRepo $script:repoRoot -TargetIsWindows:$false -NpmGlobal '' *>&1 | Out-String
            }
            finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $emptyBin -EA SilentlyContinue }
        }
        AfterAll {
            Remove-Item -Recurse -Force $script:t3p, $script:t3h -ErrorAction SilentlyContinue
        }

        It "names <_> as an absent prerequisite" -ForEach 'vale', 'bun', 'node', 'bash', 'uvx', 'jq' {
            $script:t3out | Should -Match "\b$_\b" -Because "every consumer of $_ fails open, so an absent one is invisible without the warning"
        }

        It "still completes the install: preflight warns, it does not gate" {
            Test-Path -LiteralPath (Join-Path $script:t3h 'rules/security.md') | Should -BeTrue
        }
    }

    It "does not offer jq when npm is present, since the shell statusline is never reached" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            # Same PATH-emptying test 3 uses, and for the same reason: on a runner where every
            # prerequisite except jq happens to already be installed, the preflight warning
            # never fires at all, and 'jq' is absent from $out whether or not the jq condition
            # actually works. Review round 1, item 4: measured this test passing for that wrong
            # reason on this box, since nothing but jq was ever missing here to begin with.
            $emptyBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-bin-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $emptyBin -Force | Out-Null
            $savedPath = $env:PATH
            try {
                $env:PATH = $emptyBin
                $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                    -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo $script:repoRoot `
                    -TargetIsWindows:$false -NpmGlobal '/usr/lib/node_modules' *>&1 | Out-String
            }
            finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $emptyBin -EA SilentlyContinue }

            # Positive control: without this, a broken jq condition and an empty $out are
            # indistinguishable from a working one, since both leave 'jq' absent from $out.
            $out | Should -Match '\bvale\b' -Because "the warning must actually fire for the jq check below to mean anything"
            $out | Should -Not -Match '\bjq\b'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "refuses to run when dot-sourced, before touching -ClaudeHome" {
        # This script defaults -ClaudeHome to the live ~/.claude and copies over it, so a bare
        # dot-source with no arguments would overwrite the operator's live account layer. Uses
        # stand-in paths here regardless, so a regression in the guard writes into a throwaway
        # TEMP directory rather than anything live.
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            { . $script:install -PayloadRoot $p -ClaudeHome $h `
                    -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight } |
                Should -Throw -ExpectedMessage '*dot-sourcing*'
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') |
                Should -BeFalse -Because "the guard fires before the payload tree is copied"
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 1: a relative -PayloadRoot used to garble every tree-copied
    # destination, because Copy-PayloadTree's $f.FullName.Substring($from.Length) chopped an
    # arbitrary number of characters off an absolute FullName using the length of whatever
    # Join-Path made of the raw, unresolved -PayloadRoot. The install still reported success.
    It "resolves a relative -PayloadRoot before copying, instead of garbling every destination" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $parent = Split-Path $p -Parent
        $leaf = Split-Path $p -Leaf
        $savedLoc = Get-Location
        try {
            Set-Location $parent
            & $script:install -PayloadRoot $leaf -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') | Should -BeTrue
        }
        finally {
            Set-Location $savedLoc
            Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue
        }
    }

    It "resolves a -PayloadRoot containing .. before copying" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $nested = Join-Path $p 'nested'
        New-Item -ItemType Directory -Path $nested -Force | Out-Null
        $savedLoc = Get-Location
        try {
            Set-Location $nested
            & $script:install -PayloadRoot '..' -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') | Should -BeTrue
        }
        finally {
            Set-Location $savedLoc
            Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue
        }
    }

    # Review round 2 addendum: -PayloadRoot and -ClaudeHome must be refused when equal, and when
    # either is nested inside the other, since Copy-PayloadTree reads recursively from one while
    # writing into the other. "Test both directions and the equality case." The containment check
    # runs before the -PayloadRoot existence check (Install-Account.ps1's "No payload at" throw),
    # so none of these three need a real payload on disk to prove the guard fires first.
    It "refuses when -PayloadRoot and -ClaudeHome are the same directory" {
        $h = New-StandInClaudeHome
        try {
            { & $script:install -PayloadRoot $h -ClaudeHome $h -SkipPreflight } |
                Should -Throw -ExpectedMessage '*must not be the same directory or nested*'
        }
        finally { Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue }
    }

    It "refuses when -PayloadRoot is nested inside -ClaudeHome" {
        $h = New-StandInClaudeHome
        $nestedPayload = Join-Path $h 'payload'
        try {
            { & $script:install -PayloadRoot $nestedPayload -ClaudeHome $h -SkipPreflight } |
                Should -Throw -ExpectedMessage '*must not be the same directory or nested*'
        }
        finally { Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue }
    }

    It "refuses when -ClaudeHome is nested inside -PayloadRoot" {
        $p = New-StandInPayload
        $nestedHome = Join-Path $p 'nested-home'
        try {
            { & $script:install -PayloadRoot $p -ClaudeHome $nestedHome -SkipPreflight } |
                Should -Throw -ExpectedMessage '*must not be the same directory or nested*'
        }
        finally { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
    }

    # Round 3, item B: $sep anchors the StartsWith comparisons above so a raw name-prefix match
    # ('.claude-backup' textually starts with '.claude') is not mistaken for real nesting. Two
    # sibling directories under one parent, sharing a name prefix without either containing the
    # other, pin that the guard accepts the pair rather than only asserting it rejects genuine
    # nesting. Both orderings, since either could be the one that regresses.
    It "accepts '.claude' and '.claude-backup' as siblings when -PayloadRoot is '.claude'" {
        $parent = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-sep-" + [guid]::NewGuid())
        $claudeDir = Join-Path $parent '.claude'
        $backupDir = Join-Path $parent '.claude-backup'
        New-StandInPayload -Path $claudeDir | Out-Null
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        try {
            & $script:install -PayloadRoot $claudeDir -ClaudeHome $backupDir `
                -ClaudeJson (Join-Path $backupDir 'claude.json') -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $backupDir 'rules/security.md') | Should -BeTrue
        }
        finally { Remove-Item -Recurse -Force $parent -ErrorAction SilentlyContinue }
    }

    It "accepts '.claude' and '.claude-backup' as siblings when -PayloadRoot is '.claude-backup'" {
        $parent = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-sep-" + [guid]::NewGuid())
        $claudeDir = Join-Path $parent '.claude'
        $backupDir = Join-Path $parent '.claude-backup'
        New-StandInPayload -Path $backupDir | Out-Null
        New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
        try {
            & $script:install -PayloadRoot $backupDir -ClaudeHome $claudeDir `
                -ClaudeJson (Join-Path $claudeDir 'claude.json') -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $claudeDir 'rules/security.md') | Should -BeTrue
        }
        finally { Remove-Item -Recurse -Force $parent -ErrorAction SilentlyContinue }
    }

    # Round 3, item C: the containment guard reads $ClaudeHome/$PayloadRoot only after both are
    # canonicalised at the top of the script. That dependency is already pinned for
    # Copy-PayloadTree by the relative-path tests above; this pins it for the guard itself, since
    # a guard reading the raw, uncanonicalised parameters would compare '.' against an absolute
    # string and never catch a relative -ClaudeHome equal to an absolute -PayloadRoot.
    It "recognizes a relative -ClaudeHome and its absolute -PayloadRoot as the same directory" {
        $shared = New-StandInClaudeHome
        $savedLoc = Get-Location
        try {
            Set-Location $shared
            { & $script:install -PayloadRoot $shared -ClaudeHome '.' -SkipPreflight } |
                Should -Throw -ExpectedMessage '*must not be the same directory or nested*'
        }
        finally {
            Set-Location $savedLoc
            Remove-Item -Recurse -Force $shared -ErrorAction SilentlyContinue
        }
    }

    # Review round 1, item 2: an explicitly empty or $null -ClaudeHome used to fall through to
    # the live $HOME/.claude default, since `if (-not $ClaudeHome)` cannot tell "the caller did
    # not ask" from "the caller asked for nothing". This never touches the live account layer:
    # a regression here throws before -ClaudeHome is read, so there is nothing to clean up.
    It "refuses an explicitly empty -ClaudeHome instead of falling back to the live default" {
        { & $script:install -ClaudeHome '' -PayloadRoot 'irrelevant' -SkipPreflight } |
            Should -Throw -ExpectedMessage "*-ClaudeHome was passed empty*"
    }

    It "refuses an explicitly empty -PayloadRoot instead of falling back to the default" {
        $h = New-StandInClaudeHome
        try {
            { & $script:install -ClaudeHome $h -PayloadRoot '' -SkipPreflight } |
                Should -Throw -ExpectedMessage "*-PayloadRoot was passed empty*"
        }
        finally { Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 3: the script that overwrites the live account layer was the one
    # script in install/ without a dry run.
    It "supports -WhatIf, leaving the target claude home untouched" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight -WhatIf | Out-Null
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') | Should -BeFalse
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Round 3, item A: `& $chmod.Source` is a native call, not a cmdlet, so it does not honour
    # $WhatIfPreference on its own. A dry run used to chmod real hooks on an already-installed
    # target anyway, the one write -WhatIf did not actually prevent. Pre-populating
    # ClaudeHome's hooks with a real .sh file, simulating a re-run against an existing install
    # (the only shape that gives the chmod loop something to find), makes the invocation
    # observable through the same logging stub used elsewhere.
    It "does not invoke chmod under -WhatIf, even against an already-installed target" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        New-Item -ItemType Directory -Path (Join-Path $h 'hooks') -Force | Out-Null
        'existing hook' | Set-Content (Join-Path $h 'hooks/existing-hook.sh')
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-chmodstub-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        $log = Join-Path $stubBin 'invoked.log'
        Set-Content (Join-Path $stubBin 'chmod.cmd') "@echo off`r`necho called %* >> `"$log`"`r`nexit /b 0"
        $savedPath = $env:PATH
        $logExisted = $false
        try {
            $env:PATH = "$stubBin;$savedPath"
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight -TargetIsWindows:$false -WhatIf | Out-Null
            $logExisted = Test-Path -LiteralPath $log
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $logExisted | Should -BeFalse
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 5, coverage row: the overwrite is the script's whole documented
    # purpose ("Install overwrites") and, before this test, no test had ever installed twice
    # onto a non-empty target. Both copy loops (tree and root-file) are exercised, and a
    # receiver-only file the payload never mentions proves the copy overlays rather than mirrors.
    It "overwrites an already-installed tree file and root file, leaving a receiver-only file alone" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null
            'receiver only, never in the payload' | Set-Content (Join-Path $h 'rules/local-only.md')

            'rule body v2' | Set-Content (Join-Path $p 'rules/security.md')
            'ps statusline v2' | Set-Content (Join-Path $p 'statusline-command.ps1')
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null

            Get-Content -Raw (Join-Path $h 'rules/security.md') | Should -Match 'rule body v2'
            Get-Content -Raw (Join-Path $h 'statusline-command.ps1') | Should -Match 'ps statusline v2'
            Test-Path -LiteralPath (Join-Path $h 'rules/local-only.md') | Should -BeTrue
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 5, coverage row: the message an operator sees on a fresh clone
    # before an export has ever run.
    It "throws an actionable message when -PayloadRoot does not exist" {
        $h = New-StandInClaudeHome
        $missing = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-nopayload-" + [guid]::NewGuid())
        try {
            { & $script:install -PayloadRoot $missing -ClaudeHome $h `
                    -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight } |
                Should -Throw -ExpectedMessage '*Run install/Export-Account.ps1*'
        }
        finally { Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 5, coverage row: the only signal that a model-less Agent dispatch
    # will go unblocked on the receiving box.
    It "warns when the core-sourced model-tier-gate.ts is absent, and installs nothing for it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $emptyCore = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-nocore-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $emptyCore -Force | Out-Null
        try {
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo $emptyCore `
                -SkipPreflight *>&1 | Out-String
            $out | Should -Match 'Absent:.*model-tier-gate\.ts'
            Test-Path -LiteralPath (Join-Path $h 'hooks/model-tier-gate.ts') | Should -BeFalse
        }
        finally { Remove-Item -Recurse -Force $p, $h, $emptyCore -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 5, coverage row: -SkipPreflight actually skips, proven with the same
    # emptied-PATH setup test 3 uses to show the probe fires when it is not skipped.
    It "suppresses the preflight warning under -SkipPreflight even with every tool absent" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $emptyBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-bin-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $emptyBin -Force | Out-Null
        $savedPath = $env:PATH
        $out = $null
        try {
            $env:PATH = $emptyBin
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight *>&1 | Out-String
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $emptyBin -EA SilentlyContinue }
        try {
            $out | Should -Not -Match 'Not on PATH'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 5, coverage row: when -NpmGlobal is omitted the script must go look
    # via `npm root -g` rather than assuming npm absent. A stub npm.cmd on an otherwise-empty
    # PATH stands in for a real npm install; finding it and treating npm as present is what
    # suppresses jq from the missing-tool list below.
    It "probes npm for -NpmGlobal when the parameter is omitted, and finds it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-npmstub-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        Set-Content (Join-Path $stubBin 'npm.cmd') "@echo off`r`necho C:\fake\global`r`nexit /b 0"
        $savedPath = $env:PATH
        $out = $null
        try {
            $env:PATH = $stubBin
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo $script:repoRoot `
                -TargetIsWindows:$false *>&1 | Out-String
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $out | Should -Not -Match '\bjq\b'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 5, coverage row: jq only matters on the Linux npm-absent path; the
    # commit message's own claim ("jq joins the list only on Linux with npm absent") was
    # unpinned, since dropping the -not $TargetIsWindows term left the suite green.
    It "does not add jq on Windows even with npm absent" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $emptyBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-bin-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $emptyBin -Force | Out-Null
        $savedPath = $env:PATH
        $out = $null
        try {
            $env:PATH = $emptyBin
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo $script:repoRoot `
                -TargetIsWindows:$true -NpmGlobal '' *>&1 | Out-String
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $emptyBin -EA SilentlyContinue }
        try {
            $out | Should -Match '\bvale\b' -Because "the warning must fire for the jq check below to mean anything"
            $out | Should -Not -Match '\bjq\b' -Because "jq only matters on the Linux npm-absent path"
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 6: a copy failure partway through left the target half-old,
    # half-new, with the console record stopping mid-copy and nothing telling the operator
    # what to do about it. Locks a target file open so the second install's Copy-Item onto it
    # throws, the same reproduction technique the review used.
    It "reports a mixed-state warning and re-throws when the copy fails partway through" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null
            $locked = Join-Path $h 'agents/appsec-sme.md'
            $stream = [System.IO.File]::Open($locked, 'Open', 'Read', 'None')
            $threw = $false
            $warnings = $null
            try {
                try {
                    & $script:install -PayloadRoot $p -ClaudeHome $h `
                        -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight `
                        -WarningVariable warnings -WarningAction SilentlyContinue *>$null
                }
                catch { $threw = $true }
            }
            finally { $stream.Dispose() }
            $threw | Should -BeTrue -Because "a partial failure must still fail the run, not swallow it"
            (@($warnings) -join "`n") | Should -Match 'mixed state|did not complete|Re-run this script'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 7: at this process's default (PSNativeCommandUseErrorActionPreference
    # false), a chmod that is present but exits non-zero does not throw, so the failure used to
    # print raw stderr and nothing else, while the absent-chmod case got a sentence telling the
    # operator to run chmod themselves. A chmod.cmd stub on the front of PATH stands in for the
    # failing build; prepending rather than replacing PATH keeps the rest of the preflight probe
    # answering from the real environment, since this test is not exercising that.
    It "warns the same way when a present chmod fails as when chmod is absent" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-chmodfail-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        Set-Content (Join-Path $stubBin 'chmod.cmd') "@echo off`r`necho chmod-stub: cannot operate 1>&2`r`nexit /b 1"
        $savedPath = $env:PATH
        $out = $null
        try {
            $env:PATH = "$stubBin;$savedPath"
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight -TargetIsWindows:$false *>&1 | Out-String
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $out | Should -Match 'chmod not on PATH'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, item 8: the chmod branch had no test in either direction. Rewriting its
    # condition to skip left the suite green, and test 4 was already executing chmod.exe against
    # Windows-style paths on every run with nothing asserting anything about it. A chmod stub
    # that logs its own invocations makes both directions observable without depending on what
    # chmod happens to do to a Windows-style path's permission bits.
    It "does not invoke chmod when preparing a Windows target" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-chmodstub-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        $log = Join-Path $stubBin 'invoked.log'
        Set-Content (Join-Path $stubBin 'chmod.cmd') "@echo off`r`necho called %* >> `"$log`"`r`nexit /b 0"
        $savedPath = $env:PATH
        $logExisted = $false
        try {
            $env:PATH = "$stubBin;$savedPath"
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight -TargetIsWindows:$true | Out-Null
            # Checked before $stubBin is removed below: deleting the stub first would make
            # Test-Path return $false unconditionally, whether or not chmod had actually run.
            $logExisted = Test-Path -LiteralPath $log
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $logExisted | Should -BeFalse -Because "chmod must not run when preparing a Windows target"
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "invokes chmod +x on each .sh hook when preparing a Linux target" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-chmodstub-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        $log = Join-Path $stubBin 'invoked.log'
        Set-Content (Join-Path $stubBin 'chmod.cmd') "@echo off`r`necho called %* >> `"$log`"`r`nexit /b 0"
        $savedPath = $env:PATH
        $logContent = $null
        try {
            $env:PATH = "$stubBin;$savedPath"
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight -TargetIsWindows:$false | Out-Null
            # Read the log before the stub directory is removed below: the earlier version of
            # this test deleted $stubBin (and invoked.log with it) in this same finally, then
            # tried to read the log afterward, so it always failed with "does not exist"
            # regardless of whether chmod had actually run.
            if (Test-Path -LiteralPath $log) { $logContent = Get-Content -Raw $log }
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $logContent | Should -Match 'harness-core-reminder\.sh'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 2 addendum: the chmod pass's Get-ChildItem used positional -Path, which
    # treats [ and ] as wildcard delimiters instead of literal characters. A -ClaudeHome
    # containing brackets (a Windows username in brackets, a bracketed repo checkout dir) would
    # silently match nothing, chmod nothing, and warn nothing, since a non-matching wildcard is
    # not an error. -LiteralPath takes the hooks directory as a literal string instead.
    It "chmods .sh hooks under a -ClaudeHome path containing bracket characters" {
        $p = New-StandInPayload
        $hParent = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-home-[br]-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $hParent -Force | Out-Null
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-chmodstub-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        $log = Join-Path $stubBin 'invoked.log'
        Set-Content (Join-Path $stubBin 'chmod.cmd') "@echo off`r`necho called %* >> `"$log`"`r`nexit /b 0"
        $savedPath = $env:PATH
        $logContent = $null
        try {
            $env:PATH = "$stubBin;$savedPath"
            & $script:install -PayloadRoot $p -ClaudeHome $hParent `
                -ClaudeJson (Join-Path $hParent 'claude.json') -SkipPreflight -TargetIsWindows:$false | Out-Null
            if (Test-Path -LiteralPath $log) { $logContent = Get-Content -Raw $log }
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $logContent | Should -Match 'harness-core-reminder\.sh'
        }
        # Round 4: -LiteralPath, not positional -Path. $hParent's name carries literal [ and ]
        # (the whole point of this test), so without it the pattern matches nothing, the miss is
        # swallowed by -ErrorAction SilentlyContinue, and the fixture leaks. Same defect class as
        # the chmod Get-ChildItem this test exists to pin, just in the test's own cleanup instead
        # of the code under test.
        # Round 4: -LiteralPath, not positional -Path. $hParent's name carries literal [ and ]
        # (the whole point of this test), so without it the pattern matches nothing, the miss is
        # swallowed by -ErrorAction SilentlyContinue, and the fixture leaks. Same defect class as
        # the chmod Get-ChildItem this test exists to pin, just in the test's own cleanup instead
        # of the code under test.
        finally { Remove-Item -Recurse -Force -LiteralPath $p, $hParent -ErrorAction SilentlyContinue }
    }

    # Round 3, item D: the two tests above only assert that a hook's filename reaches the log,
    # not what mode string chmod was called with. A typo turning +x into -x, or dropping it,
    # would pass both of them silently.
    It "passes +x as the chmod mode argument, not some other string" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-chmodstub-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        $log = Join-Path $stubBin 'invoked.log'
        Set-Content (Join-Path $stubBin 'chmod.cmd') "@echo off`r`necho called %* >> `"$log`"`r`nexit /b 0"
        $savedPath = $env:PATH
        $logContent = $null
        try {
            $env:PATH = "$stubBin;$savedPath"
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight -TargetIsWindows:$false | Out-Null
            if (Test-Path -LiteralPath $log) { $logContent = Get-Content -Raw $log }
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $logContent | Should -Match 'called \+x '
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Round 3, item D: -Filter *.sh is asserted only by omission elsewhere, never by a payload
    # that actually carries a non-.sh file under hooks/ to prove it gets skipped.
    It "does not chmod a non-.sh file under hooks/" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        'not a shell hook' | Set-Content (Join-Path $p 'hooks/reference-notes.txt')
        $stubBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-chmodstub-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $stubBin -Force | Out-Null
        $log = Join-Path $stubBin 'invoked.log'
        Set-Content (Join-Path $stubBin 'chmod.cmd') "@echo off`r`necho called %* >> `"$log`"`r`nexit /b 0"
        $savedPath = $env:PATH
        $logContent = ''
        try {
            $env:PATH = "$stubBin;$savedPath"
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight -TargetIsWindows:$false | Out-Null
            if (Test-Path -LiteralPath $log) { $logContent = Get-Content -Raw $log }
        }
        finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $stubBin -EA SilentlyContinue }
        try {
            $logContent | Should -Not -Match 'reference-notes\.txt'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "expands all five tokens in the files that carry them" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            foreach ($d in 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $p $d) -Force | Out-Null
            }
            'write to {{OBSIDIAN_VAULT}}/Handoffs/<slug>/handoff-latest.md' |
                Set-Content (Join-Path $p 'skills/handoff/SKILL.md')
            'home maps to {{HOME_SLUG}}' | Set-Content (Join-Path $p 'skills/council/SKILL.md')
            '~/.claude/projects/{{HOME_SLUG}}/memory and {{OBSIDIAN_VAULT}}/Handoffs' |
                Set-Content (Join-Path $p 'skills/subagent-prompting/SKILL.md')
            @{
                hooks = @{ PreToolUse = @( @{ matcher = 'Skill'; hooks = @(
                                @{ type = 'command'
                                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook' }) }) }
                statusLine = @{ type = 'command'
                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js' }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            # Backslashed on purpose. Review round 1, F5: forward-slashing was pinned for
            # {{CLAUDE_HOME}} only, since {{CORE_REPO}} and {{NPM_GLOBAL}} were both handed in
            # already forward-slashed and the -replace was a no-op under test. -VaultPath and
            # -HomeSlug, review round 1 F4: both parameters could be deleted without reddening
            # anything, since nothing ever asserted the skills/handoff/SKILL.md fixture this It
            # already plants.
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:\projects\agent-harness-core' `
                -NpmGlobal 'C:\npm\node_modules' -VaultPath 'D:\My Vault\Claude Code' `
                -HomeSlug 'STUB-SLUG' -SkipPreflight | Out-Null

            $expectedHome = $h -replace '\\', '/'
            (Get-Content (Join-Path $h 'rules/harness-core.md') -Raw) |
                Should -Match ([regex]::Escape('E:/projects/agent-harness-core'))
            (Get-Content (Join-Path $h 'hooks/harness-core-reminder.sh') -Raw) |
                Should -Match ([regex]::Escape('E:/projects/agent-harness-core'))
            (Get-Content (Join-Path $h 'skills/prose-lint/SKILL.md') -Raw) |
                Should -Match ([regex]::Escape("$expectedHome/tools/prose-lint/.vale.ini"))
            (Get-Content (Join-Path $h 'skills/council/SKILL.md') -Raw) |
                Should -Match ([regex]::Escape('STUB-SLUG'))
            # -VaultPath and its forward-slashing. Review round 1, F4: this fixture was already
            # planted and never checked.
            (Get-Content (Join-Path $h 'skills/handoff/SKILL.md') -Raw) |
                Should -Match ([regex]::Escape('D:/My Vault/Claude Code'))
            $sub = Get-Content (Join-Path $h 'skills/subagent-prompting/SKILL.md') -Raw
            $sub | Should -Match ([regex]::Escape('STUB-SLUG'))
            $sub | Should -Not -Match '\{\{'

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            @($s.hooks.PreToolUse)[0].hooks[0].command |
                Should -Be 'node C:/npm/node_modules/ccstatusline/dist/ccstatusline.js --hook'
            # npm-present statusLine expansion. Review round 1, F3: the primary path every
            # ordinary install with npm on the box takes, and no fixture exercised it.
            $s.statusLine.command |
                Should -Be 'node C:/npm/node_modules/ccstatusline/dist/ccstatusline.js'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "rewrites a PowerShell hook entry for Linux and removes its shell key" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'; ENABLE_TOOL_SEARCH = 'auto:5' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'
                                    command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell'; timeout = 5 }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal '/usr/lib/node_modules' -TargetIsWindows:$false -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $hook = @(@($s.hooks.PreToolUse)[0].hooks)[0]
            $hook.command | Should -Be "pwsh -NoProfile -File '$($h -replace '\\', '/')/hooks/Scan-MemorySecrets.ps1'"
            # Without the removal the command string still goes to a PowerShell host and the
            # pwsh rewrite is pointless.
            $hook.PSObject.Properties.Name | Should -Not -Contain 'shell'
            $s.env.PSObject.Properties.Name | Should -Not -Contain 'CLAUDE_CODE_USE_POWERSHELL_TOOL'
            $s.env.ENABLE_TOOL_SEARCH | Should -Be 'auto:5'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "leaves the invocation form, the shell key and the env var alone on Windows" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'
                                    command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal 'C:/npm' -TargetIsWindows:$true -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $hook = @(@($s.hooks.PreToolUse)[0].hooks)[0]
            $hook.command | Should -Be "& '$($h -replace '\\', '/')/hooks/Scan-MemorySecrets.ps1'"
            $hook.shell | Should -Be 'powershell'
            $s.env.CLAUDE_CODE_USE_POWERSHELL_TOOL | Should -Be '1'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "drops the ccstatusline entries and repoints statusLine when npm is absent" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                hooks = @{
                    PreToolUse = @( @{ matcher = 'Skill'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Guard-SkillSize.ps1'"
                                    shell = 'powershell' }
                                @{ type = 'command'
                                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook' }) })
                    UserPromptSubmit = @( @{ hooks = @(
                                @{ type = 'command'
                                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook' }) })
                }
                statusLine = @{ type = 'command'
                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js'; padding = 0 }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal '' -TargetIsWindows:$true -SkipPreflight *>&1 | Out-String

            $raw = Get-Content (Join-Path $h 'settings.json') -Raw
            $raw | Should -Not -Match 'ccstatusline'
            $raw | Should -Not -Match '\{\{NPM_GLOBAL\}\}'
            # @() around the Where-Object output. Review round 1, F2: dropping it serialises a
            # single surviving hook as "hooks": {...} instead of "hooks": [...], which the
            # assertions below cannot see, since ConvertFrom-Json's own @() re-wrap on read
            # normalises the scalar back into a one-element array and hides the defect. Assert
            # on the raw JSON text instead, before it goes through that re-wrap.
            $raw | Should -Match '"hooks":\s*\['
            $s = $raw | ConvertFrom-Json
            $s.statusLine.command | Should -Be "pwsh -NoProfile -File '$($h -replace '\\', '/')/statusline-command.ps1'"
            # The Guard-SkillSize entry in the same matcher group must survive: the branch drops
            # two commands, not a whole group.
            @(@($s.hooks.PreToolUse)[0].hooks).Count | Should -Be 1
            # A UserPromptSubmit group left with no hooks must go, not serialise as an empty
            # array Claude Code then has to skip.
            $s.hooks.PSObject.Properties.Name | Should -Not -Contain 'UserPromptSubmit'
            $out | Should -Match 'npm'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "points the statusline fallback at the shell script on Linux" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ hooks = @{}; statusLine = @{ type = 'command'
                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js' } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal '' -TargetIsWindows:$false -SkipPreflight | Out-Null
            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.statusLine.command | Should -Be "bash '$($h -replace '\\', '/')/statusline-command.sh'"
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, F1: the phantom-null defect the implementer diagnosed and fixed at the
    # $event enumeration recurs at three more @()-wrapped sites in the same function, all
    # reachable from a receiver-authored settings.account.json even though none is reachable
    # from today's real payload. Task 10 routes receiver JSON through this same function, which
    # is why these three earn a fix now rather than a deferral. One It per site, matching this
    # file's own one-assertion-per-It convention, since the three sites are fixed independently.
    It "does not crash when a hook event's group list is explicitly null" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"hooks":{"PreToolUse":null}}' | Set-Content (Join-Path $p 'settings.account.json')
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null
            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.hooks.PSObject.Properties.Name | Should -Not -Contain 'PreToolUse'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "does not crash when a hook group has no hooks key, or an explicit null one" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ hooks = @{ PreToolUse = @(
                        @{ matcher = 'Write' },
                        @{ matcher = 'Edit'; hooks = $null }
                    ) } } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null
            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.hooks.PSObject.Properties.Name | Should -Not -Contain 'PreToolUse'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "leaves a hook entry with no command property alone instead of crashing on it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Write'; hooks = @(
                                @{ type = 'command' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null
            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $hook = @(@($s.hooks.PreToolUse)[0].hooks)[0]
            $hook.type | Should -Be 'command'
            $hook.PSObject.Properties.Name | Should -Not -Contain 'command'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review round 1, F6: a surviving {{TOKEN}} was neither expanded, reported, nor tested.
    # Passthrough stays deliberate rather than a hard stop, since a receiver still gets an
    # install over one bad file, but a silent survivor lands in a model-read file or a hook
    # command that cannot run, so it is reported instead of left invisible.
    It "warns about a surviving unknown placeholder without failing the install" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            'core {{CORE_REPO}} mystery {{MYSTERY}}' | Set-Content (Join-Path $p 'rules/harness-core.md')
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight *>&1 | Out-String
            $out | Should -Match 'MYSTERY'
            $content = Get-Content (Join-Path $h 'rules/harness-core.md') -Raw
            $content | Should -Match ([regex]::Escape('E:/projects/agent-harness-core'))
            $content | Should -Match '\{\{MYSTERY\}\}'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "keeps receiver-only settings keys the payload does not carry" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                enabledPlugins = @{ 'superpowers@claude-plugins-official' = $true }
                effortLevel = 'xhigh'
                teammateMode = 'auto'
                permissions = @{ allow = @('Bash(ls:*)') }
                hooks = @{ SessionStart = @( @{ hooks = @(
                                @{ type = 'command'; command = 'echo receiver-only' }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $h 'settings.json')

            @{
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal 'C:/npm' -TargetIsWindows:$true -SkipPreflight | Out-Null

            $raw = Get-Content (Join-Path $h 'settings.json') -Raw
            $s = $raw | ConvertFrom-Json
            # An overwrite would revert every one of these on the receiver on every pull.
            $s.enabledPlugins.'superpowers@claude-plugins-official' | Should -BeTrue
            $s.effortLevel | Should -Be 'xhigh'
            $s.teammateMode | Should -Be 'auto'
            # permissions.allow is an ordered set union, receiver entries first.
            @($s.permissions.allow) | Should -Be @('Bash(ls:*)', 'mcp__code-context')
            $s.permissions.defaultMode | Should -Be 'auto'
            # A receiver-only hook event survives untouched beside the payload's.
            @(@($s.hooks.SessionStart)[0].hooks)[0].command | Should -Be 'echo receiver-only'
            @(@($s.hooks.PreToolUse)[0].hooks)[0].command | Should -Match 'Scan-MemorySecrets\.ps1'
            # Task 10 review, finding 3: the line above re-wraps $s.hooks.PreToolUse in @() before
            # reading it, so it reads the same whether the merged event serialised as a genuine
            # one-element JSON array or a bare object (the single-element pipeline-output collapse
            # Install-Harness.ps1:822-826 already names). Asserted against the raw file text, which
            # a re-parse cannot paper over.
            $raw | Should -Match '"PreToolUse":\s*\['
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "is idempotent: a second install adds no duplicate hook entry" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')
            $args = @{
                PayloadRoot = $p; ClaudeHome = $h; ClaudeJson = (Join-Path $h 'claude.json')
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
                TargetIsWindows = $true
            }
            & $script:install @args -SkipPreflight | Out-Null
            & $script:install @args -SkipPreflight | Out-Null

            $raw = Get-Content (Join-Path $h 'settings.json') -Raw
            $s = $raw | ConvertFrom-Json
            $cmds = @()
            foreach ($g in @($s.hooks.PreToolUse)) { foreach ($x in @($g.hooks)) { $cmds += $x.command } }
            @($cmds | Where-Object { $_ -match 'Scan-MemorySecrets' }).Count | Should -Be 1
            @($s.hooks.PreToolUse).Count | Should -Be 1
            # Task 10 review, finding 3: both checks above wrap $s.hooks.PreToolUse in @() before
            # reading it, so they read "1" whether that property is a genuine one-element JSON
            # array or a bare object PowerShell's own read-back re-wraps on the way in. Asserted
            # against the raw file text instead, before any parse can paper over the shape.
            $raw | Should -Match '"PreToolUse":\s*\['
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "replaces statusLine whole and lets the payload win a shared scalar" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ statusLine = @{ type = 'command'; command = 'old'; padding = 4; refreshInterval = 99 }
                effortLevel = 'low' } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $h 'settings.json')
            @{ hooks = @{}; statusLine = @{ type = 'command'; command = 'node {{NPM_GLOBAL}}/x.js'; padding = 0 }
                effortLevel = 'xhigh' } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal 'C:/npm' -TargetIsWindows:$true -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.statusLine.command | Should -Be 'node C:/npm/x.js'
            $s.statusLine.padding | Should -Be 0
            # Whole replacement, not a deep merge: a stale refreshInterval from the receiver's
            # previous statusline would silently apply to the new one.
            $s.statusLine.PSObject.Properties.Name | Should -Not -Contain 'refreshInterval'
            $s.effortLevel | Should -Be 'xhigh'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # The brief's three tests above only ever feed the phantom-null shapes through the payload,
    # which Convert-SettingsForTarget already sanitises before Merge-AccountSettings ever sees
    # it. The receiver's own settings.json takes no such pass, and Merge-AccountSettings and
    # Merge-HookEvent do their own @()-wrapping of its properties, so the same phantom-null
    # hazard documented at Install-Account.ps1:366-371 recurs here, fed this time by hand-edited
    # data instead of the exporter's own output. Four cases below, one It per site, matching
    # this file's convention for the three sites already pinned on the payload side.
    It "merges a payload hook event into an existing settings.json whose same event is explicitly null" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"hooks":{"PreToolUse":null}}' | Set-Content (Join-Path $h 'settings.json')
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Write'; hooks = @(
                                @{ type = 'command'; command = 'echo from-payload' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null

            $raw = Get-Content (Join-Path $h 'settings.json') -Raw
            $s = $raw | ConvertFrom-Json
            @(@($s.hooks.PreToolUse)[0].hooks)[0].command | Should -Be 'echo from-payload'
            # Task 10 review, finding 3: same re-wrap gap as the other two hooks assertions above.
            $raw | Should -Match '"PreToolUse":\s*\['
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "does not splice a null hook entry when the matched existing group has no hooks key, or an explicit null one" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ hooks = @{ PreToolUse = @(
                        @{ matcher = 'Write' },
                        @{ matcher = 'Edit'; hooks = $null }
                    ) } } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $h 'settings.json')
            @{ hooks = @{ PreToolUse = @(
                        @{ matcher = 'Write'; hooks = @(@{ type = 'command'; command = 'echo write' }) },
                        @{ matcher = 'Edit'; hooks = @(@{ type = 'command'; command = 'echo edit' }) }
                    ) } } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $groups = @($s.hooks.PreToolUse)
            $writeHooks = @(($groups | Where-Object { $_.matcher -eq 'Write' }).hooks)
            $editHooks = @(($groups | Where-Object { $_.matcher -eq 'Edit' }).hooks)
            $writeHooks.Count | Should -Be 1
            $writeHooks[0].command | Should -Be 'echo write'
            $editHooks.Count | Should -Be 1
            $editHooks[0].command | Should -Be 'echo edit'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "does not insert a blank entry into permissions.allow when the existing permissions object is empty" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"permissions":{}}' | Set-Content (Join-Path $h 'settings.json')
            @{ permissions = @{ allow = @('Bash(ls:*)') } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            @($s.permissions.allow) | Should -Be @('Bash(ls:*)')
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Task 10 review, finding 1: "hooks": null and "permissions": null at the top of an existing
    # settings.json crashed the merge with "Cannot index into a null array", since the hooks and
    # permissions branches assume $ev has properties to look up. A receiver-only key alongside
    # proves this is a real merge (payload's hooks installed, receiver's own key kept), not the
    # old overwrite happening to survive a shape it never had to read.
    It "replaces a null hooks object wholesale instead of crashing on it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"hooks":null,"effortLevel":"keep-me"}' | Set-Content (Join-Path $h 'settings.json')
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Write'; hooks = @(
                                @{ type = 'command'; command = 'echo from-payload' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            @(@($s.hooks.PreToolUse)[0].hooks)[0].command | Should -Be 'echo from-payload'
            $s.effortLevel | Should -Be 'keep-me'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "replaces a null permissions object wholesale instead of crashing on it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"permissions":null,"effortLevel":"keep-me"}' | Set-Content (Join-Path $h 'settings.json')
            @{ permissions = @{ allow = @('Bash(ls:*)') } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            @($s.permissions.allow) | Should -Be @('Bash(ls:*)')
            $s.effortLevel | Should -Be 'keep-me'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Task 10 review, finding 2 (top-level): a receiver's settings.json can parse cleanly to
    # something that is not a JSON object at all. Worst measured case was a bare string, written
    # back byte for byte at exit 0 with no warning, silently dropping the entire payload.
    It "backs up and proceeds when the existing settings.json parses to a bare array, not an object" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '[1,2,3]' | Set-Content (Join-Path $h 'settings.json')
            @{ effortLevel = 'xhigh' } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight -WarningAction SilentlyContinue | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.effortLevel | Should -Be 'xhigh'
            @(Get-ChildItem -LiteralPath $h -Filter 'settings.json.bak.*').Count | Should -Be 1
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "backs up and proceeds instead of writing the receiver's file back unchanged when it parses to a bare string" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '"hello"' | Set-Content (Join-Path $h 'settings.json')
            @{ effortLevel = 'xhigh' } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight *>&1 | Out-String

            # The defect this pins: the install used to report success and leave the receiver's
            # file byte for byte unchanged, silently dropping every hook, permission and
            # statusLine the account layer ships.
            $out | Should -Match 'not a JSON object|is a String'
            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.effortLevel | Should -Be 'xhigh'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Task 10 review: a failure anywhere in the settings-merge block used to land outside every
    # catch in the script, past Task 8's mixed-state warning, surfacing as a bare exception with
    # no word that $ClaudeHome was left half-installed. Locks settings.json for write exclusion
    # only (FileShare.Read), so the second install's own read of the existing file still
    # succeeds and the failure is isolated to the final write, the same reproduction technique
    # Task 8's own test uses for the tree-copy catch.
    It "reports the mixed-state warning when the settings.json write fails, not just the tree copy" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null
            $liveSettings = Join-Path $h 'settings.json'
            $stream = [System.IO.File]::Open($liveSettings, 'Open', 'Read', 'Read')
            $threw = $false
            $warnings = $null
            try {
                try {
                    & $script:install -PayloadRoot $p -ClaudeHome $h `
                        -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight `
                        -WarningVariable warnings -WarningAction SilentlyContinue *>$null
                }
                catch { $threw = $true }
            }
            finally { $stream.Dispose() }
            $threw | Should -BeTrue -Because "a settings merge failure must still fail the run, not swallow it"
            (@($warnings) -join "`n") | Should -Match 'mixed state|did not complete|Re-run this script'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review: an existing settings.json that fails to parse is not a shape Merge-AccountSettings
    # can merge against, and Claude Code could not have read it either. Silently overwriting it
    # would still lose whatever the operator was mid-edit on, so it is backed up instead
    # (change-management.md's *.bak.<timestamp> convention) and the install proceeds as though
    # the file were absent, rather than leaving the run half done the way an uncaught throw here
    # would (Task 8's mixed-state catch does not wrap this later block).
    It "backs up and proceeds when the existing settings.json fails to parse" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            'not valid { json' | Set-Content (Join-Path $h 'settings.json')
            @{ effortLevel = 'xhigh' } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            { & $script:install -PayloadRoot $p -ClaudeHome $h `
                    -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                    -SkipPreflight -WarningAction SilentlyContinue | Out-Null } | Should -Not -Throw

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.effortLevel | Should -Be 'xhigh'
            @(Get-ChildItem -LiteralPath $h -Filter 'settings.json.bak.*').Count | Should -Be 1
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Task 10 review, finding 7: Copy-Item correctly no-ops under -WhatIf, but the warning text
    # unconditionally claimed "Backed up to '<path>'" regardless, which is a dry run reporting
    # work it did not do.
    It "under -WhatIf, does not claim a backup it never made" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            'not valid { json' | Set-Content (Join-Path $h 'settings.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight -WhatIf *>&1 | Out-String

            $out | Should -Not -Match 'Backed up to'
            @(Get-ChildItem -LiteralPath $h -Filter 'settings.json.bak.*').Count | Should -Be 0
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }
}
