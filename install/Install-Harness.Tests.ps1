# install/Install-Harness.Tests.ps1
Describe "Install-Harness" {
    BeforeEach {
        $script:target = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:target | Out-Null
    }
    AfterEach { Remove-Item -Recurse -Force $script:target }

    It "copies agents, hooks, and templates into .claude" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        Test-Path "$script:target/.claude/agents/task-reviewer.md" | Should -BeTrue
        Test-Path "$script:target/.claude/hooks/agent-worktree-gate.ts" | Should -BeTrue
        Test-Path "$script:target/.claude/guardrails.md" | Should -BeTrue
        # Scratch drop box: the directory must exist and carry the self-ignoring rule, or agent
        # working files land in the project's commits.
        Test-Path "$script:target/.claude/scratch" -PathType Container | Should -BeTrue
        # \r? before the anchor: the template is LF in the index and core.autocrlf=true
        # checks it out as CRLF, so in -Raw text `$` sits behind a carriage return and a
        # bare `^\*$` never matches on Windows.
        Get-Content "$script:target/.claude/scratch/.gitignore" -Raw | Should -Match '(?m)^\*\r?$'
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

    It "records an empty stackDetected.plugins array when the plugin cache dir is missing, without throwing" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $fakeHome | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target } | Should -Not -Throw
            $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
            $m.Contains('stackDetected') | Should -BeTrue
            @($m['stackDetected']['plugins']).Count | Should -Be 0
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "detects plugins from the two-level cache layout as sorted marketplace/plugin entries" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        $cacheDir = Join-Path $fakeHome '.claude/plugins/cache'
        New-Item -ItemType Directory -Path (Join-Path $cacheDir 'zeta-market/zeta-plugin') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $cacheDir 'alpha-market/alpha-plugin') -Force | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
            $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
            @($m['stackDetected']['plugins']) | Should -Be @('alpha-market/alpha-plugin', 'zeta-market/zeta-plugin')
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "records an empty outputStyles array when the output-styles dir is missing, without throwing" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $fakeHome | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target } | Should -Not -Throw
            $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
            @($m['stackDetected']['outputStyles']).Count | Should -Be 0
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "serializes a single detected output style as a JSON array, not a bare string" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        $stylesDir = Join-Path $fakeHome '.claude/output-styles'
        New-Item -ItemType Directory -Path $stylesDir -Force | Out-Null
        'body' | Set-Content (Join-Path $stylesDir 'learning.md')
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
            # Same collapse hazard as the settings.json hooks array: a single-match result
            # captured into a variable can serialize as a bare string instead of a
            # 1-element array. Assert the raw JSON shape, not just the deserialized value.
            $raw = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw
            $raw | Should -Match '"outputStyles":\s*\['
            $m = $raw | ConvertFrom-Json -AsHashtable
            @($m['stackDetected']['outputStyles']) | Should -Be @('learning')
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "collects mcpServers from ~/.claude/settings.json" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path (Join-Path $fakeHome '.claude') -Force | Out-Null
        '{"mcpServers":{"code-context":{"command":"whatever"}}}' | Set-Content (Join-Path $fakeHome '.claude/settings.json')
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
            $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
            @($m['stackDetected']['mcpServers']) | Should -Be @('code-context')
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "does not throw and returns an empty mcpServers array when the target's .mcp.json is malformed" {
        '{ this is not valid json' | Set-Content "$script:target/.mcp.json"
        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target } | Should -Not -Throw
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        @($m['stackDetected']['mcpServers']).Count | Should -Be 0
    }

    It "does not throw when the plugin cache dir is unreadable (permission denied)" -Skip:(-not $IsLinux) {
        if ((& id -u) -eq '0') {
            Set-ItResult -Skipped -Because "running as root; permission bits are not enforced, test would false-pass"
            return
        }
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        $cacheDir = Join-Path $fakeHome '.claude/plugins/cache'
        New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & chmod 000 $cacheDir
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target } | Should -Not -Throw
        }
        finally {
            # Restore permissions before Remove-Item, or cleanup itself fails on the
            # now-unreadable/unlistable directory.
            & chmod 755 $cacheDir
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "gains stackDetected without losing existing manifest keys, and drops the old pluginsDetected key" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m.Contains('guardrails.md') | Should -BeTrue
        $m.Contains('agents/task-reviewer.md') | Should -BeTrue
        $m.Contains('pluginsDetected') | Should -BeFalse
        $m.Contains('stackDetected') | Should -BeTrue
        $m['stackDetected'].Contains('scannedAt') | Should -BeTrue
        $m['stackDetected'].Contains('plugins') | Should -BeTrue
        $m['stackDetected'].Contains('outputStyles') | Should -BeTrue
        $m['stackDetected'].Contains('mcpServers') | Should -BeTrue
    }

    It "audit reports plugin drift against the manifest without writing it" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        $cacheDir = Join-Path $fakeHome '.claude/plugins/cache'
        New-Item -ItemType Directory -Path (Join-Path $cacheDir 'mp/plugin-one') -Force | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
            New-Item -ItemType Directory -Path (Join-Path $cacheDir 'mp/plugin-two') -Force | Out-Null
            $manifestBefore = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
            $pattern = [regex]::Escape('+ mp/plugin-two')
            $out | Should -Match $pattern
            (Get-Content "$script:target/.claude/.harness-manifest.json" -Raw) | Should -Be $manifestBefore
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "audit reports no output-styles/mcpServers drift after a clean install with none detected" {
        # Regression: recorded-count arrays were built with `$x = if (...) { @(...) } else
        # { @() }`, and an if/else used as an expression collapses an empty array result to
        # $null the same way a pipeline capture does — an empty recorded list then reads
        # back as "removed" one blank entry instead of "no drift".
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "No Output styles drift since last scan\."
        $out | Should -Match "No MCP servers drift since last scan\."
        $out | Should -Not -Match '\s-\s+\(no longer detected\)'
    }

    It "audit degrades a null stackDetected to nothing recorded, without throwing" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        $cacheDir = Join-Path $fakeHome '.claude/plugins/cache'
        New-Item -ItemType Directory -Path (Join-Path $cacheDir 'mp/plugin-one') -Force | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
            $manifestPath = "$script:target/.claude/.harness-manifest.json"
            $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
            $m['stackDetected'] = $null
            ($m | ConvertTo-Json -Depth 20) | Set-Content $manifestPath
            $manifestBefore = Get-Content $manifestPath -Raw

            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit } | Should -Not -Throw
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
            $out | Should -Match "Plugins detected: 1 \(manifest last recorded: 0\)"
            $pattern = [regex]::Escape('+ mp/plugin-one (newly detected)')
            $out | Should -Match $pattern
            (Get-Content $manifestPath -Raw) | Should -Be $manifestBefore
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "audit degrades a wrong-typed stackDetected (number) to nothing recorded, without throwing" {
        # Not a string: System.String and Object[] both expose a Contains(object) method
        # that returns $false instead of throwing, so those two "wrong-typed" shapes
        # happen not to reproduce the crash (verified by ablation). A scalar with no
        # Contains method at all (e.g. an int, from a hand-edited `"stackDetected": 42`)
        # is what actually throws "does not contain a method named 'Contains'".
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        $cacheDir = Join-Path $fakeHome '.claude/plugins/cache'
        New-Item -ItemType Directory -Path (Join-Path $cacheDir 'mp/plugin-one') -Force | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
            $manifestPath = "$script:target/.claude/.harness-manifest.json"
            $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
            $m['stackDetected'] = 42
            ($m | ConvertTo-Json -Depth 20) | Set-Content $manifestPath
            $manifestBefore = Get-Content $manifestPath -Raw

            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit } | Should -Not -Throw
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
            $out | Should -Match "Plugins detected: 1 \(manifest last recorded: 0\)"
            $pattern = [regex]::Escape('+ mp/plugin-one (newly detected)')
            $out | Should -Match $pattern
            (Get-Content $manifestPath -Raw) | Should -Be $manifestBefore
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
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

    It "wires git core.hooksPath and the reported row agrees with git itself" {
        & git -C $script:target init -q *>&1 | Out-Null
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target *>&1 | Out-String
        $out | Should -Match 'git:core\.hooksPath'
        $out | Should -Match 'set to '
        # The results table is the operator's only signal that wiring happened, so the
        # claim has to agree with the repo's actual config rather than with the fact
        # that the command was issued.
        $actual = & git -C $script:target config --get core.hooksPath
        $LASTEXITCODE | Should -Be 0
        (Resolve-Path -LiteralPath $actual).Path |
            Should -Be (Resolve-Path -LiteralPath "$script:target/.claude/hooks").Path
    }

    It "installs the pre-commit hook with the owner execute bit actually set" -Skip:$IsWindows {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $hook = Get-Item -LiteralPath "$script:target/.claude/hooks/pre-commit"
        # git skips a hook without the execute bit and says nothing, so the bit is what
        # makes the hook real rather than merely present. Copy-Item does not carry it and
        # the source file is 0644 in the repo, so this asserts the installer's chmod landed
        # on the hook file itself. Asserting only that a chmod failure gets reported would
        # pass just as happily with the chmod pointed at the wrong path.
        $hook.UnixMode | Should -Match '^.{3}x'
    }

    It "reports a failed chmod instead of leaving the pre-commit hook silently non-executable" -Skip:$IsWindows {
        # The real triggers are filesystems with no POSIX permission bits (CIFS/SMB, exFAT,
        # WSL DrvFs without `metadata`) and a checkout owned by another uid. None of those
        # is reproducible in a temp directory, so the call itself is shimmed: a `chmod` that
        # always fails, placed first on PATH for the duration of this test.
        $shimDir = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-shim-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $shimDir | Out-Null
        $shim = Join-Path $shimDir 'chmod'
        Set-Content -LiteralPath $shim -Value "#!/bin/sh`nexit 1`n"
        # Absolute path so this call is the real chmod, not the shim being installed.
        & /bin/chmod +x $shim
        $prevPath = $env:PATH
        $env:PATH = $shimDir + [System.IO.Path]::PathSeparator + $prevPath
        try {
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target *>&1 | Out-String
            $out | Should -Match 'chmod:hooks/pre-commit'
            $out | Should -Match 'FAILED'
            # The file still installs; the point is that the table no longer implies it
            # is runnable when it is not.
            $out | Should -Match 'hooks/pre-commit\s+installed'
        }
        finally {
            $env:PATH = $prevPath
            Remove-Item -Recurse -Force $shimDir
        }
    }

    It "reports a failed core.hooksPath write as FAILED instead of claiming it was set" -Skip:$IsWindows {
        & git -C $script:target init -q *>&1 | Out-Null
        $gitDir = Join-Path $script:target '.git'
        # git writes config through a lock file created in .git/, so it is the directory's
        # mode that blocks the write. Making .git/config itself read-only does not: git
        # replaces the file rather than writing through the existing inode, and the write
        # succeeds with exit 0. Verified both ways before settling on this.
        & chmod 0555 $gitDir
        try {
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target *>&1 | Out-String
            # A native command's non-zero exit does not trip $ErrorActionPreference = 'Stop',
            # so without an explicit $LASTEXITCODE check this row reads "set to ..." for a
            # write that never landed.
            $out | Should -Match 'FAILED'
            $out | Should -Not -Match 'set to '
        }
        finally {
            & chmod 0755 $gitDir
        }
    }
}
