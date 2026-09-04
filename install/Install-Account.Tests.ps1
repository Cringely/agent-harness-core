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

    # Task 10 review round 2: deny replacing wholesale would silently drop a restriction an
    # operator deliberately added on their own machine, the dangerous direction to fail in.
    # Unioned the same way allow already is.
    It "unions permissions.deny instead of replacing a receiver's own entry" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"permissions":{"deny":["Bash(curl:*)"]}}' | Set-Content (Join-Path $h 'settings.json')
            @{ permissions = @{ deny = @('Bash(rm:*)') } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            @($s.permissions.deny) | Should -Be @('Bash(curl:*)', 'Bash(rm:*)')
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "does not insert a blank entry into permissions.deny when the existing permissions object is empty" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"permissions":{}}' | Set-Content (Join-Path $h 'settings.json')
            @{ permissions = @{ deny = @('Bash(rm:*)') } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            @($s.permissions.deny) | Should -Be @('Bash(rm:*)')
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

    # Task 10 review round 2, finding D: the residual-token scan used to run over the merged
    # output, so a receiver's own {{TOKEN}}-shaped content (their own convention, or
    # coincidence) tripped a warning claiming this install left a hook command broken, when the
    # install never touched that content and had no substitution for it. Scanning the payload
    # alone instead.
    It "does not warn about a receiver's own placeholder-shaped content in settings.json" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            '{"env":{"X":"{{MYSTERY}}"}}' | Set-Content (Join-Path $h 'settings.json')
            @{ effortLevel = 'xhigh' } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight *>&1 | Out-String

            $out | Should -Not -Match 'Unexpanded placeholder'
            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.env.X | Should -Be '{{MYSTERY}}'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "still warns when the payload's own settings carry an unexpanded placeholder" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ env = @{ X = '{{MYSTERY}}' } } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -SkipPreflight *>&1 | Out-String

            $out | Should -Match 'Unexpanded placeholder\(s\) in settings\.json: \{\{MYSTERY\}\}'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Task 11: -ClaudeJson gets the same empty-string guard Task 8 gave -ClaudeHome and
    # -PayloadRoot. Without it, this is the one script that now writes outside ~/.claude at all
    # (~/.claude.json), so a caller that meant to pass a real path and got an empty one from an
    # unset environment variable or a failed lookup would silently fall through to the
    # operator's live ~/.claude.json instead.
    It "refuses an explicitly empty -ClaudeJson instead of falling back to the live default" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            { & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson '' -SkipPreflight } |
                Should -Throw -ExpectedMessage "*-ClaudeJson was passed empty*"
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Task 11: unlike the -PayloadRoot equivalent above, this does not discriminate the
    # canonicalisation line by itself: Merge-McpServer's Test-Path/Get-Content/Set-Content are
    # cmdlets that already resolve a relative path against $PWD correctly (this script never
    # calls Set-Location), so ablating that one line changes nothing here -- verified. Kept as a
    # feature-level regression test that a relative -ClaudeJson still produces a working
    # install, which the canonicalisation line is not itself required to make true today.
    It "resolves a relative -ClaudeJson before merging mcpServers into it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
            ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
        $savedLoc = Get-Location
        try {
            Set-Location $h
            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson 'claude.json' -SkipPreflight | Out-Null
            $j = Get-Content (Join-Path $h 'claude.json') -Raw | ConvertFrom-Json
            $j.mcpServers.garmin.command | Should -Be 'uvx'
        }
        finally {
            Set-Location $savedLoc
            Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue
        }
    }

    It "adds missing mcpServers entries and touches nothing else in claude.json" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{
                userID = 'abc123'
                projects = @{ '/home/u/demo' = @{ lastCost = 2.5 } }
                mcpServers = @{ existing = @{ type = 'stdio'; command = 'keep-me'; args = @() } }
            } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{
                    garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight | Out-Null

            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $j.mcpServers.garmin.command   | Should -Be 'uvx'
            $j.mcpServers.existing.command | Should -Be 'keep-me'
            $j.userID | Should -Be 'abc123'
            $j.projects.'/home/u/demo'.lastCost | Should -Be 2.5
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review F3: Expand-McpServer had no falsifiable coverage. Deleting the function outright,
    # or dropping any one of its three arms (command, args, env), all left the suite green,
    # despite it being one of this task's four required interfaces and the reason expansion is
    # a separate pass before the merge. One token in each of the three positions.
    It "expands tokens in a server's command, one args element and one env value" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{
                    probe = @{ type = 'stdio'
                        command = '{{CLAUDE_HOME}}/hooks/probe.sh'
                        args = @('--home', '{{CLAUDE_HOME}}/data')
                        env = @{ HOME_DIR = '{{CLAUDE_HOME}}' } } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight | Out-Null

            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $homeSlashed = $h -replace '\\', '/'
            $j.mcpServers.probe.command   | Should -Be "$homeSlashed/hooks/probe.sh"
            $j.mcpServers.probe.args[1]   | Should -Be "$homeSlashed/data"
            $j.mcpServers.probe.env.HOME_DIR | Should -Be $homeSlashed
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review F4: nothing pinned -Depth 30 on the ConvertTo-Json call in Merge-McpServer. The
    # value shipped is correct (measured nesting on a real ~/.claude.json is 8), but at -Depth 2
    # every project's allowedTools, mcpServers and similar subtrees collapse from objects and
    # arrays into type-name strings, silently, at exit 0. A real "projects" entry nests about 7
    # deep; this fixture mirrors that.
    It "preserves deeply nested claude.json content through the merge" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{
                mcpServers = @{}
                projects = @{ '/home/u/demo' = @{ a = @{ b = @{ c = @{ d = @{ e = 'leaf' } } } } } }
            } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{
                    garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight | Out-Null

            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $j.projects.'/home/u/demo'.a.b.c.d.e | Should -Be 'leaf'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review F5: claude.json was rewritten on every install, including ones adding nothing.
    # Claude Code rewrites this file continuously while it runs, so an unconditional
    # read-modify-write is a lost-update race against the operator's live session on every
    # install rather than only on ones that change something. Asserted on LastWriteTimeUtc, not
    # content: the two possible writes here (payload-wins-nothing and a byte-identical
    # re-serialisation of the receiver's own data) both leave the content unchanged, so only the
    # timestamp can tell a real write from a skipped one.
    It "does not rewrite claude.json when the payload adds nothing new" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
            $before = (Get-Item $cj).LastWriteTimeUtc

            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight | Out-Null

            (Get-Item $cj).LastWriteTimeUtc | Should -Be $before
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review F7: a non-object mcpServers in an existing claude.json ("mcpServers":"oops" or
    # ":[1,2]") made Add-Member on the retrieved value a no-op that never touches $doc itself,
    # so the install printed "mcpServers: 1 added" and the payload server was silently dropped
    # behind that success message. Same class Task 10 already handles for settings.json one
    # file over.
    It "warns and replaces a non-object mcpServers instead of silently dropping the merge" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            '{"mcpServers":"oops"}' | Set-Content $cj
            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight *>&1 | Out-String

            $out | Should -Match 'mcpServers.*not a JSON object'
            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $j.mcpServers.garmin.command | Should -Be 'uvx'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review F14: "mcpServers": null in an existing claude.json falls through the F7 check
    # above ($null -isnot [pscustomobject] is true) to the generic GetType() fallback, and
    # .GetType() on $null throws "You cannot call a method on a null-valued expression". Not a
    # regression from F7: the reviewer traced the same shape crashing one guard clause later,
    # at $doc.mcpServers.PSObject.Properties[$name] in the merge loop, before F7 existed. F7
    # moved the pre-existing crash earlier rather than introducing it; this closes the one shape
    # its own guard still misses.
    It "warns and replaces an explicit null mcpServers instead of crashing on GetType" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            '{"mcpServers":null}' | Set-Content $cj
            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight *>&1 | Out-String

            $out | Should -Match 'mcpServers.*not a JSON object'
            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $j.mcpServers.garmin.command | Should -Be 'uvx'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review F8: -WhatIf printed "mcpServers: 1 added" while claude.json stayed byte-identical.
    # Defensible as a prediction (the count is computed before the gated Set-Content, same as
    # the settings.json merge above), but Task 10 already named its own equivalent test "under
    # -WhatIf, does not claim a backup it never made", so the house style here is the opposite:
    # say so rather than let the count read as a claim.
    It "marks the mcpServers add count as a dry run under -WhatIf" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight -WhatIf *>&1 | Out-String

            $out | Should -Match 'mcpServers: 1 added \(garmin\) \(dry run\)'
            (Get-Content $cj -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties.Name.Count | Should -Be 0
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "leaves a hand-fixed entry alone across a second install" {
        # The loop this prevents: the receiver hand-fixes 1password in claude.json because the
        # shipped Store path with its embedded version does not exist there, the next pull
        # reverts it, and settings.local.json cannot reach that file to hold the fix.
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{ '1password' = @{ type = 'stdio'
                        command = 'C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe'
                        args = @(); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
            $args = @{
                PayloadRoot = $p; ClaudeHome = $h; ClaudeJson = $cj
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
            }
            & $script:install @args -SkipPreflight | Out-Null

            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $j.mcpServers.'1password'.command = '/usr/local/bin/op-mcp'
            $j | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:install @args -SkipPreflight | Out-Null
            $j2 = Get-Content $cj -Raw | ConvertFrom-Json
            $j2.mcpServers.'1password'.command | Should -Be '/usr/local/bin/op-mcp'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "names both non-portable servers, and nothing that resolves on this machine" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{
                    '1password' = @{ type = 'stdio'
                        command = 'C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe'
                        args = @(); env = @{} }
                    'code-context' = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', '/home/prior/code-context-mcp.sh'); env = @{} }
                    # The real argument list, not a simplified "garmin-mcp": the URL is what
                    # makes Get-UnresolvedPath's drive-letter branch misfire (review F1), and a
                    # fixture that drops it cannot measure the defect it exists to catch.
                    garmin = @{ type = 'stdio'; command = 'uvx'; args = @(
                            '--python', '3.12', '--with', 'mcp<2.0', '--from',
                            'git+https://github.com/Taxuspt/garmin_mcp', 'garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal '/usr/lib/node_modules' `
                -TargetIsWindows:$false -SkipPreflight *>&1 | Out-String

            # Scope every assertion to the report block. The "N added (names)" line above it
            # legitimately names all three servers, so a whole-output match would pass for the
            # wrong reason and a whole-output negative would fail for the wrong reason.
            $parts = @($out -split 'Still carrying a source-machine path')
            $parts.Count | Should -Be 2 -Because "the report must have printed at all"
            $report = $parts[1]

            $report | Should -Match '1password'
            # Review F2: the line above alone does not discriminate either, same mechanism as
            # the code-context fix below -- the trailer sentence names "mcpServers.1password"
            # verbatim once any residual exists at all, so it stayed green in a manual check
            # where Get-UnresolvedPath was rigged to never flag 1password's own dead path while
            # leaving code-context detection intact.
            #
            # Matching just the full path is not enough either: the "Command:" line prints the
            # unmodified, untruncated command text regardless of whether the dead-path fix
            # (review F6) is in place, so a bare substring match on the path passes against the
            # Command line even with F6 reverted. Anchored on "does not exist here: <full path>"
            # instead, which is only true once the report's own Dead field carries the real,
            # untruncated Store path rather than the "C:\Program" fragment F6 fixed.
            $report | Should -Match ([regex]::Escape(
                    'does not exist here: C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe'))
            # code-context is the case Test-ResidualWindowsPath alone cannot see: `wsl -e
            # /home/prior/code-context-mcp.sh` carries no drive letter and no USERPROFILE, so a
            # drive-letter rule would report one of the two entries this exists to name.
            $report | Should -Match 'code-context'
            # The line above alone does not discriminate: the trailer sentence below always
            # names both "mcpServers.1password" and "mcpServers.code-context" verbatim once any
            # residual exists at all, so it stayed green in a manual check where
            # Get-UnresolvedPath was rigged to never flag code-context's own dead path. Matching
            # the actual dead path pins down that the POSIX-shaped entry was genuinely detected,
            # not merely named in that fixed sentence.
            $report | Should -Match ([regex]::Escape('/home/prior/code-context-mcp.sh'))
            $report | Should -Not -Match 'garmin'
            # The expanded hook command points at a file that is really there, so it must not
            # be reported. On a Windows receiver every correctly expanded command carries a
            # drive letter, and a report that names all of them is no report at all.
            $report | Should -Not -Match 'Scan-MemorySecrets'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "completes the install even with residuals outstanding" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{ wsl = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', 'C:\Users\user\x.sh'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') | Should -BeTrue
            (Get-Content $cj -Raw | ConvertFrom-Json).mcpServers.wsl.command | Should -Be 'wsl'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    # Review F9: Test-Path against a UNC-shaped candidate that does not resolve stalls for
    # several seconds on name resolution (measured 11.5s in review) before returning $false,
    # which reads as a hung install rather than a completed one. Skipped before Test-Path
    # instead. Bounded generously above the ~19s the whole 76-test suite normally takes, so a
    # regression back to the per-candidate stall (which this fixture alone would add ~11s to)
    # fails the assertion rather than merely slowing the run down unnoticed.
    It "does not stall on a UNC-shaped candidate, and does not report it as a residual" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{ shares = @{ type = 'stdio'
                        command = '//no-such-host-xyz/share/tool'; args = @(); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight *>&1 | Out-String
            $sw.Stop()

            $sw.Elapsed.TotalSeconds | Should -BeLessThan 5 -Because "a UNC-shaped candidate must be skipped, not probed"
            # Not "$out | Should -Not -Match 'shares'": the "mcpServers: 1 added (shares)" line
            # above the report legitimately names the server it added, same reasoning as the
            # $parts split used elsewhere in this file. With nothing else in this fixture to
            # flag, the correct outcome is no residual report at all.
            $out | Should -Not -Match 'Still carrying a source-machine path'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }
}

Describe "Account layer round trip" {
    BeforeAll {
        $script:export = "$PSScriptRoot/Export-Account.ps1"
        $script:install = "$PSScriptRoot/Install-Account.ps1"
        $script:repoRoot = Split-Path $PSScriptRoot -Parent

        # A stand-in canonical workstation: a ~/.claude carrying one file of each shape that
        # gets folded, plus a settings.json in all three quoting forms.
        function New-CanonicalHome {
            $canonHome = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-canon-" + [guid]::NewGuid())
            $ch = Join-Path $canonHome '.claude'
            foreach ($d in 'rules', 'agents', 'hooks', 'tools/prose-lint',
                'skills/prose-lint', 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $ch $d) -Force | Out-Null
            }
            $chBack = $ch -replace '/', '\'
            $core = 'E:\projects\agent-harness-core'
            $vault = Join-Path $canonHome 'Documents\Obsidian Vault\Claude Code'
            $slug = $canonHome.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'

            'plain rule'                                     | Set-Content (Join-Path $ch 'rules/security.md')
            "Core repo: $core"                               | Set-Content (Join-Path $ch 'rules/harness-core.md')
            'agent def'                                      | Set-Content (Join-Path $ch 'agents/appsec-sme.md')
            "the core at $core"                              | Set-Content (Join-Path $ch 'hooks/harness-core-reminder.sh')
            'StylesPath = styles'                            | Set-Content (Join-Path $ch 'tools/prose-lint/.vale.ini')

            # A real $patterns block, not a stub. The exporter's secret gate lifts this table by
            # AST out of the stand-in hook and throws when the assignment is absent, so 'exit 0'
            # here would fail the export before either round-trip case reached an assertion.
            # Same two rows as the Export-Account fixture, for the same reason.
            @'
$patterns = @(
    @{ Name = 'API token (tk_/sk_/ak_)'; Regex = '(?<![a-zA-Z0-9_])(tk_|sk_|ak_)[a-zA-Z0-9]{10,}' }
    @{ Name = 'AWS-style key';           Regex = 'AKIA[0-9A-Z]{16}' }
)
exit 0
'@ | Set-Content (Join-Path $ch 'hooks/Scan-MemorySecrets.ps1')
            "vale --config `"$chBack\tools\prose-lint\.vale.ini`"" | Set-Content (Join-Path $ch 'skills/prose-lint/SKILL.md')
            "write to $vault\Handoffs\x.md"                  | Set-Content (Join-Path $ch 'skills/handoff/SKILL.md')
            "home folder is $slug"                           | Set-Content (Join-Path $ch 'skills/council/SKILL.md')
            "$slug and $vault\Handoffs"                      | Set-Content (Join-Path $ch 'skills/subagent-prompting/SKILL.md')
            'ps statusline'                                  | Set-Content (Join-Path $ch 'statusline-command.ps1')
            'sh statusline'                                  | Set-Content (Join-Path $ch 'statusline-command.sh')

            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1' }
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '$chBack\hooks\Scan-MemorySecrets.ps1'"
                                    shell = 'powershell'; timeout = 5 }) }) }
                statusLine = @{ type = 'command'
                    command = 'node C:/npm/node_modules/ccstatusline/dist/ccstatusline.js'; padding = 0 }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'
                        args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $canonHome '.claude.json')

            return $canonHome
        }

        $script:exportArgs = {
            param($canonHome, $out)
            @{
                ClaudeHome = (Join-Path $canonHome '.claude')
                ClaudeJson = (Join-Path $canonHome '.claude.json')
                OutputRoot = $out
                CoreRepo = 'E:\projects\agent-harness-core'
                NpmGlobal = 'C:/npm/node_modules'
                VaultPath = (Join-Path $canonHome 'Documents\Obsidian Vault\Claude Code')
                HomeSlug = ($canonHome.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-')
            }
        }
    }

    It "install then export reproduces the payload byte for byte" {
        # The claim this checks: running the installer on the canonical box is safe, because the
        # next export folds the literals back to exactly the tokens they came from. If a fold
        # matched only one separator spelling this would fail, since install writes
        # forward-slash form and the originals here are backslashed.
        $canonHome = New-CanonicalHome
        $out1 = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-rt1-" + [guid]::NewGuid())
        $out2 = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-rt2-" + [guid]::NewGuid())
        try {
            $a = & $script:exportArgs $canonHome $out1
            & $script:export @a | Out-Null

            # -VaultPath and -HomeSlug are what make this a round trip. Without them the
            # installer derives both from the runner's real $HOME, expands {{OBSIDIAN_VAULT}}
            # and {{HOME_SLUG}} to values the canonical fixture never contained, and the second
            # export has nothing to fold back: the two payloads then differ on three files for
            # a reason that has nothing to do with the separator handling under test.
            & $script:install -PayloadRoot $out1 -ClaudeHome (Join-Path $canonHome '.claude') `
                -ClaudeJson (Join-Path $canonHome '.claude.json') `
                -CoreRepo 'E:\projects\agent-harness-core' -NpmGlobal 'C:/npm/node_modules' `
                -VaultPath $a.VaultPath -HomeSlug $a.HomeSlug `
                -TargetIsWindows:$true -SkipPreflight | Out-Null

            $b = & $script:exportArgs $canonHome $out2
            & $script:export @b | Out-Null

            foreach ($rel in 'rules/harness-core.md', 'hooks/harness-core-reminder.sh',
                'skills/prose-lint/SKILL.md', 'skills/handoff/SKILL.md',
                'skills/council/SKILL.md', 'skills/subagent-prompting/SKILL.md') {
                (Get-Content (Join-Path $out2 $rel) -Raw) |
                    Should -Be (Get-Content (Join-Path $out1 $rel) -Raw) -Because "$rel must fold back"
            }
            $s1 = Get-Content (Join-Path $out1 'settings.account.json') -Raw | ConvertFrom-Json
            $s2 = Get-Content (Join-Path $out2 'settings.account.json') -Raw | ConvertFrom-Json
            @(@($s2.hooks.PreToolUse)[0].hooks)[0].command |
                Should -Be @(@($s1.hooks.PreToolUse)[0].hooks)[0].command
            $s2.statusLine.command | Should -Be $s1.statusLine.command
        }
        finally { Remove-Item -Recurse -Force $canonHome, $out1, $out2 -ErrorAction SilentlyContinue }
    }

    It "an install into an empty home leaves every hook command pointing at a real file" {
        $canonHome = New-CanonicalHome
        $out = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-rt3-" + [guid]::NewGuid())
        $fresh = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-fresh-" + [guid]::NewGuid())
        try {
            $a = & $script:exportArgs $canonHome $out
            & $script:export @a | Out-Null

            $freshClaude = Join-Path $fresh '.claude'
            & $script:install -PayloadRoot $out -ClaudeHome $freshClaude `
                -ClaudeJson (Join-Path $fresh '.claude.json') `
                -CoreRepo $script:repoRoot -NpmGlobal 'C:/npm/node_modules' `
                -TargetIsWindows:$true -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $freshClaude 'settings.json') -Raw | ConvertFrom-Json
            $cmd = @(@($s.hooks.PreToolUse)[0].hooks)[0].command
            $cmd | Should -Not -Match '\{\{'
            # Pull the quoted path out of "& 'path'" and confirm the file is there. A command
            # that expands to a plausible path over nothing is the failure mode this catches,
            # and it is invisible until a hook silently stops firing.
            #
            # [regex]::Match, not Should -Match plus $Matches. Pester 5.7.1 evaluates the match
            # inside its own scope, so $Matches is null by the time the next line reads it and
            # $Matches.p yields $null: Test-Path -LiteralPath $null then throws a parameter
            # binding error rather than failing an assertion, which reads as a broken test
            # rather than a broken install.
            $m = [regex]::Match($cmd, "^& '(?<p>[^']+)'$")
            $m.Success | Should -BeTrue -Because "the expanded command must still be a quoted call"
            Test-Path -LiteralPath $m.Groups['p'].Value | Should -BeTrue

            Test-Path -LiteralPath (Join-Path $freshClaude 'hooks/model-tier-gate.ts') | Should -BeTrue
            # -CoreRepo here is $script:repoRoot, so the expected literal is derived from it
            # rather than hardcoded. A hardcoded E:/projects/agent-harness-core would pass on
            # this workstation for the wrong reason and fail on any other clone.
            #
            # $(...) around the -replace, not the bare expression the brief supplied: a static
            # method call's argument list splits on every top-level comma, so
            # Escape($script:repoRoot -replace '\\', '/') parses as TWO arguments to Escape (the
            # -replace with no substitution, then '/'), not one -replace with two operands.
            # Measured: "Cannot find an overload for `"Escape`" and the argument count: `"2`"."
            # The subexpression's parens are not the method call's parens, so the comma inside
            # is no longer top-level and the whole -replace evaluates to one string first.
            $repoSlashed = $(($script:repoRoot -replace '\\', '/'))
            (Get-Content (Join-Path $freshClaude 'rules/harness-core.md') -Raw) |
                Should -Match ([regex]::Escape($repoSlashed))
            (Get-Content (Join-Path $freshClaude 'skills/subagent-prompting/SKILL.md') -Raw) |
                Should -Not -Match '\{\{'
            (Get-Content (Join-Path $fresh '.claude.json') -Raw | ConvertFrom-Json).mcpServers.garmin.command |
                Should -Be 'uvx'
        }
        finally { Remove-Item -Recurse -Force $canonHome, $out, $fresh -ErrorAction SilentlyContinue }
    }
}
