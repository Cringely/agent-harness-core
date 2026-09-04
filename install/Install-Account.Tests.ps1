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
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo $script:repoRoot `
                -TargetIsWindows:$false -NpmGlobal '/usr/lib/node_modules' *>&1 | Out-String
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
}
