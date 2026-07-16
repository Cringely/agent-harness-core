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
}
