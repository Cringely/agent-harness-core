# install/Install-Harness.Tests.ps1
Describe "Install-Harness" {
    BeforeEach {
        $script:target = Join-Path $env:TEMP ("harness-test-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:target | Out-Null
    }
    AfterEach { Remove-Item -Recurse -Force $script:target }

    It "copies agents, hooks, and templates into .claude" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        Test-Path "$script:target/.claude/agents/task-reviewer.md" | Should -BeTrue
        Test-Path "$script:target/.claude/hooks/agent-worktree-gate.ts" | Should -BeTrue
        Test-Path "$script:target/.claude/guardrails.md" | Should -BeTrue
    }

    It "merges hook registrations into existing settings.json without clobbering" {
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        '{"permissions":{"allow":["Bash(ls:*)"]}}' | Set-Content "$script:target/.claude/settings.json"
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $s = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $s.permissions.allow[0] | Should -Be "Bash(ls:*)"
        $s.hooks | Should -Not -BeNullOrEmpty
    }

    It "serializes each matcher group's hooks as a JSON array, even with a single hook" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $raw = Get-Content "$script:target/.claude/settings.json" -Raw
        # A single-match PowerShell pipeline can unwrap to a bare object instead of a
        # 1-element array; that would serialize "hooks": { "type": ... } instead of
        # "hooks": [ { "type": ... } ], which Claude Code cannot load. Assert it never does.
        # (A round-trip through ConvertFrom-Json is not a reliable check here: PowerShell's
        # own JSON deserializer collapses a 1-element JSON array back to a scalar
        # PSCustomObject, so the file's raw text is the only faithful signal of what
        # actually got written.)
        $raw | Should -Not -Match '"hooks":\s*\{\s*"type"'
        $raw | Should -Match '"hooks":\s*\['
    }

    It "does not overwrite a project-modified installed file" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        "PROJECT EDIT" | Add-Content "$script:target/.claude/agents/task-reviewer.md"
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        (Get-Content "$script:target/.claude/agents/task-reviewer.md" -Raw) | Should -Match "PROJECT EDIT"
    }

    It "installs ceremony files and their hook registrations only with -IncludeCeremonies" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        Test-Path "$script:target/.claude/agents/soc-monitor.md" | Should -BeFalse
        Test-Path "$script:target/.claude/hooks/wave-close-handoff.sh" | Should -BeFalse
        Test-Path "$script:target/.claude/ceremony-ledger.json" | Should -BeFalse
        $sDefault = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $defaultCommands = @()
        foreach ($event in $sDefault.hooks.PSObject.Properties.Name) {
            foreach ($group in @($sDefault.hooks.$event)) {
                foreach ($h in @($group.hooks)) { $defaultCommands += $h.command }
            }
        }
        $defaultCommands | Where-Object { $_ -match "wave-close-handoff\.sh" } | Should -BeNullOrEmpty

        Remove-Item -Recurse -Force $script:target
        New-Item -ItemType Directory -Path $script:target | Out-Null
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -IncludeCeremonies
        Test-Path "$script:target/.claude/agents/soc-monitor.md" | Should -BeTrue
        Test-Path "$script:target/.claude/hooks/wave-close-handoff.sh" | Should -BeTrue
        Test-Path "$script:target/.claude/ceremony-ledger.json" | Should -BeTrue
        $sCeremony = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $ceremonyCommands = @()
        foreach ($event in $sCeremony.hooks.PSObject.Properties.Name) {
            foreach ($group in @($sCeremony.hooks.$event)) {
                foreach ($h in @($group.hooks)) { $ceremonyCommands += $h.command }
            }
        }
        $ceremonyCommands | Where-Object { $_ -match "wave-close-handoff\.sh" } | Should -Not -BeNullOrEmpty
    }

    It "audit reports in-sync after a clean install and writes nothing" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $manifestBefore = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw
        $settingsBefore = Get-Content "$script:target/.claude/settings.json" -Raw
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "in-sync"
        # File statuses only — the trailing guidance line legitimately names every status.
        $out | Should -Not -Match "\.(md|ts|sh)\s+(project-modified|core-updated|conflict|missing)"
        (Get-Content "$script:target/.claude/.harness-manifest.json" -Raw) | Should -Be $manifestBefore
        (Get-Content "$script:target/.claude/settings.json" -Raw) | Should -Be $settingsBefore
    }

    It "audit classifies a project-modified file" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        "PROJECT EDIT" | Add-Content "$script:target/.claude/agents/task-reviewer.md"
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+project-modified"
    }

    It "audit classifies core-updated when core moved on but the project did not" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        # Simulate "core changed since install": rewrite the installed file AND its
        # recorded manifest hash to agree with each other but not with core source.
        $dst = "$script:target/.claude/agents/task-reviewer.md"
        "OLD CORE VERSION" | Set-Content $dst
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['agents/task-reviewer.md'] = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
        $m | ConvertTo-Json -Depth 5 | Set-Content "$script:target/.claude/.harness-manifest.json"
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+core-updated"
    }

    It "audit classifies missing and orphaned manifest entries" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        Remove-Item "$script:target/.claude/agents/task-reviewer.md"
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['agents/retired-agent.md'] = 'DEADBEEF'
        $m | ConvertTo-Json -Depth 5 | Set-Content "$script:target/.claude/.harness-manifest.json"
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+missing"
        $out | Should -Match "agents/retired-agent\.md\s+orphaned"
    }

    It "adopts a hand-built file identical to core into the manifest without -Force" {
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        Copy-Item "$PSScriptRoot/../core/claude/agents/task-reviewer.md" "$script:target/.claude/agents/"
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['agents/task-reviewer.md'] | Should -Not -BeNullOrEmpty
        $src = (Get-FileHash "$PSScriptRoot/../core/claude/agents/task-reviewer.md" -Algorithm SHA256).Hash
        $m['agents/task-reviewer.md'] | Should -Be $src
    }

    It "audit handles a hand-built .claude with no manifest as untracked" {
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        Copy-Item "$PSScriptRoot/../core/claude/agents/task-reviewer.md" "$script:target/.claude/agents/"
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "never installed here"
        $out | Should -Match "agents/task-reviewer\.md\s+untracked \(matches core\)"
        $out | Should -Match "not-installed"
        Test-Path "$script:target/.claude/.harness-manifest.json" | Should -BeFalse
        Test-Path "$script:target/.claude/settings.json" | Should -BeFalse
    }
}
