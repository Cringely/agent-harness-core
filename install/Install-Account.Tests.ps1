# install/Install-Account.Tests.ps1
Describe "Install-Account" {
    BeforeAll {
        $script:install = "$PSScriptRoot/Install-Account.ps1"
        $script:repoRoot = Split-Path $PSScriptRoot -Parent

        # A payload shaped like account/claude, planted rather than exported, so these tests
        # never depend on Task 14 having run and never read the operator's live ~/.claude.
        function New-StandInPayload {
            $p = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-payload-" + [guid]::NewGuid())
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

    It "copies the payload tree into the target claude home" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md')          | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'agents/appsec-sme.md')       | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'skills/prose-lint/SKILL.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'tools/prose-lint/.vale.ini') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'hooks/Scan-MemorySecrets.ps1') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'statusline-command.ps1')     | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'statusline-command.sh')      | Should -BeTrue
            # The payload's own files are inputs, not content, and must not land in the target.
            Test-Path -LiteralPath (Join-Path $h 'settings.account.json') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $h 'mcp-servers.json')      | Should -BeFalse
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
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

    It "names every absent prerequisite, and jq only when the Linux fallback needs it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            # PATH emptied to a directory holding nothing, so every probe misses. Without this
            # the assertion would depend on what happens to be installed on the runner.
            $emptyBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-bin-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $emptyBin -Force | Out-Null
            $savedPath = $env:PATH
            try {
                $env:PATH = $emptyBin
                $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                    -ClaudeJson (Join-Path $h 'claude.json') `
                    -CoreRepo $script:repoRoot -TargetIsWindows:$false -NpmGlobal '' *>&1 | Out-String
            }
            finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $emptyBin -EA SilentlyContinue }

            foreach ($tool in 'vale', 'bun', 'node', 'bash', 'uvx', 'jq') {
                $out | Should -Match "\b$tool\b" -Because "every consumer of $tool fails open, so an absent one is invisible without the warning"
            }
            # The install still completes: preflight warns, it does not gate.
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') | Should -BeTrue
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
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
}
