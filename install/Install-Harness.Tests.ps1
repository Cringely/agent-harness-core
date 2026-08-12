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
        $m['files']['agents/task-reviewer.md'] = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
        $m | ConvertTo-Json -Depth 20 | Set-Content "$script:target/.claude/.harness-manifest.json"
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+core-updated"
    }

    It "audit classifies missing and orphaned manifest entries" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        Remove-Item "$script:target/.claude/agents/task-reviewer.md"
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired-agent.md'] = 'DEADBEEF'
        $m | ConvertTo-Json -Depth 20 | Set-Content "$script:target/.claude/.harness-manifest.json"
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+missing"
        $out | Should -Match "agents/retired-agent\.md\s+orphaned"
    }

    It "adopts a hand-built file identical to core into the manifest without -Force" {
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        Copy-Item "$PSScriptRoot/../core/claude/agents/task-reviewer.md" "$script:target/.claude/agents/"
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/task-reviewer.md'] | Should -Not -BeNullOrEmpty
        $src = (Get-FileHash "$PSScriptRoot/../core/claude/agents/task-reviewer.md" -Algorithm SHA256).Hash
        $m['files']['agents/task-reviewer.md'] | Should -Be $src
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
        $m['files'].Contains('guardrails.md') | Should -BeTrue
        $m['files'].Contains('agents/task-reviewer.md') | Should -BeTrue
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

    It "migrates a v1 flat manifest to v2, preserving the recorded hashes under files" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $v2 = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $trackedHash = $v2['files']['agents/task-reviewer.md']
        $trackedHash | Should -Not -BeNullOrEmpty

        # Rewrite the manifest into the v1 shape an already-installed project carries: a flat
        # path-to-hash map plus stackDetected, with none of the v2 siblings.
        $v1 = [ordered]@{}
        foreach ($k in $v2['files'].Keys) { $v1[$k] = $v2['files'][$k] }
        # An entry core no longer ships is what makes this test ablation-proof. Every other
        # hash here would be recomputed to the same value by the install itself, so dropping
        # the whole v1 map would still leave them looking correct. This one cannot be
        # recomputed from anything on disk; it survives only if the migration carried it.
        $v1['agents/retired-agent.md'] = 'DEADBEEF'
        $v1['stackDetected'] = $v2['stackDetected']
        $v1 | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target

        $raw = Get-Content $manifestPath -Raw
        # Raw JSON, not only the deserialized value: an empty accepted map has to reach disk
        # as an object rather than collapsing away, and the v1 keys must no longer sit at the
        # top level where every audit lookup would miss them.
        $raw | Should -Match '"files":\s*\{'
        $raw | Should -Match '"accepted":\s*\{'
        $m = $raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired-agent.md'] | Should -Be 'DEADBEEF'
        $m['files']['agents/task-reviewer.md'] | Should -Be $trackedHash
        $m.Contains('agents/task-reviewer.md') | Should -BeFalse
        # stackDetected stays a sibling of files, never a tracked file inside it.
        $m.Contains('stackDetected') | Should -BeTrue
        $m['files'].Contains('stackDetected') | Should -BeFalse
        $m.Contains('coreRepo') | Should -BeTrue
        $m.Contains('coreCommit') | Should -BeTrue
    }

    It "migrates hand-edited manifest shapes without throwing or dropping recorded hashes" {
        # Three shapes a manifest already installed in the wild can actually be in. The
        # migration has to survive all three, because the alternative is an installer that
        # throws on a file the operator cannot easily reconstruct.
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $trackedHash = (Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable)['files']['agents/task-reviewer.md']

        # A v1 map hand-edited down to file hashes alone, with no stackDetected to carry over.
        $flat = [ordered]@{
            'agents/task-reviewer.md'  = $trackedHash
            'agents/retired-agent.md'  = 'DEADBEEF'
        }
        $flat | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target } | Should -Not -Throw
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired-agent.md'] | Should -Be 'DEADBEEF'
        $m['files']['agents/task-reviewer.md'] | Should -Be $trackedHash

        # A v1 map carrying a stray 'files' key that is not a map. Detection goes by shape, so
        # this migrates instead of being mistaken for v2, and the stray value rides along under
        # files where the audit will show it as an orphaned row rather than vanishing.
        $stray = [ordered]@{
            'files'                   = 'not-a-map'
            'agents/retired-agent.md' = 'DEADBEEF'
        }
        $stray | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target } | Should -Not -Throw
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['files'] | Should -Be 'not-a-map'
        $m['files']['agents/retired-agent.md'] | Should -Be 'DEADBEEF'

        # A v2 manifest whose accepted was hand-edited to a scalar. An int has no Contains
        # method at all, which is the shape that actually throws (String and Object[] both
        # answer Contains and would quietly return $false instead).
        $m['accepted'] = 42
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target } | Should -Not -Throw
        $raw = Get-Content $manifestPath -Raw
        $raw | Should -Match '"accepted":\s*\{'
        $m = $raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired-agent.md'] | Should -Be 'DEADBEEF'
    }

    It "preserves accepted pins when migrating a manifest whose files map is missing" {
        # A pin is the one manifest value nothing on disk can recompute: an install rebuilds
        # `files` from the source hashes, and only -Accept ever writes `accepted`. Shape
        # detection keys off `files`, so a manifest holding pins but no usable files map is
        # read as v1 and rebuilt, and every pin goes with it. The operator is left with a
        # permanent audit warning and no record of why the fork was ever accepted.
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        'project fork body' | Set-Content "$script:target/.claude/agents/project-only.md"
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'agents/project-only.md' | Out-Null

        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $pin = $m['accepted']['agents/project-only.md']
        $pin | Should -Not -BeNullOrEmpty

        $m.Remove('files')
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target

        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['accepted']['agents/project-only.md'] | Should -Be $pin
        # Folded under files instead, the pin map reads as a single orphaned row named
        # 'accepted' and no key in it is a pin any more, so assert it did not ride along there.
        $after['files'].Contains('accepted') | Should -BeFalse
        # The operator-visible half: a dropped pin does not merely change the manifest, it
        # takes the overlay's row out of the audit table entirely.
        $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(accepted\)'
    }

    It "keeps coreRepo and coreCommit out of files when migrating a manifest whose files map is missing" {
        # Same fold-in as the pin case, different damage. Neither value is lost, both are
        # rewritten from the current checkout, but folded under `files` they become tracked
        # keys for paths that were never files, and the audit then carries a permanent
        # orphaned row for each. Two junk rows train the operator to skim the table.
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $before = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $before['coreRepo'] | Should -Not -BeNullOrEmpty

        $before.Remove('files')
        $before | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target

        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('coreRepo') | Should -BeFalse
        $after['files'].Contains('coreCommit') | Should -BeFalse
        # Skipped in the fold, still recorded: the keys belong at top level, not nowhere.
        $after['coreRepo'] | Should -Be $before['coreRepo']
        $after.Contains('coreCommit') | Should -BeTrue
        $after['coreCommit'] | Should -Be $before['coreCommit']

        # A tracked key with no core source and no file on disk is reported orphaned, so that
        # is the row shape this guards against.
        $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Not -Match 'coreRepo\s+orphaned'
        $audit | Should -Not -Match 'coreCommit\s+orphaned'
    }

    It "-Accept pins an overlay that the audit reports as accepted and leaves out of the attention count" {
        # -IncludeCeremonies for the baseline: a default install leaves the two ceremony files
        # permanently 'not-installed', so the attention count is never zero without it and the
        # exclusion assertion below would have nothing clean to read.
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -IncludeCeremonies
        'project fork body' | Set-Content "$script:target/.claude/agents/project-only.md"

        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'agents/project-only.md' *>&1 | Out-String -Width 500
        $out | Should -Match "Accepted overlay 'agents/project-only\.md' pinned at [0-9A-Fa-f]{64}"

        $raw = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw
        $raw | Should -Match '"accepted":\s*\{[^}]*"agents/project-only\.md"'

        $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(accepted\)'
        # The pin is worth nothing if the row still counts as drift, so assert the count
        # itself and not just the status string.
        $audit | Should -Match 'All managed files in sync with core\.'
    }

    It "-Accept throws on a file that does not exist" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'agents/no-such-agent.md' } |
            Should -Throw -ExpectedMessage '*file does not exist*'
    }

    It "-Accept throws on a file already tracked in the manifest's files map" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'agents/task-reviewer.md' } |
            Should -Throw -ExpectedMessage '*already tracked*'
    }

    It "-Accept throws on a path that resolves outside the .claude directory" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        # A real file, so the throw under test is the containment check and not the
        # file-does-not-exist guard standing in for it.
        'outside the layer' | Set-Content "$script:target/outside.md"
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $manifestBefore = Get-Content $manifestPath -Raw

        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept '../outside.md' } |
            Should -Throw -ExpectedMessage '*outside the project*'
        # Absolute paths take a separate guard: Join-Path with a rooted second argument does not
        # replace the base, so on Linux '/etc/passwd' would otherwise land back inside the
        # containment check as a contained path and pin a file no install manages.
        $absolute = (Resolve-Path -LiteralPath "$script:target/outside.md").Path
        { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept $absolute } |
            Should -Throw -ExpectedMessage '*absolute paths are not accepted*'

        # Neither rejection may leave a pin behind, and the key must not reach the file at all.
        $raw = Get-Content $manifestPath -Raw
        $raw | Should -Be $manifestBefore
        $raw | Should -Not -Match 'outside\.md'
    }

    It "audit over a v1 manifest migrates in memory only, leaving the file on disk untouched" {
        # The other writes-nothing assertions all run against a manifest that is already v2, and
        # a v2 manifest round-trips byte-identical, so those comparisons cannot tell a write from
        # a no-write. Migration-on-load is the case where an audit-time persist would be visible,
        # and it is the case where it would matter: the operator asked for a report and would get
        # their manifest silently rewritten into a new shape.
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $v2 = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable

        $v1 = [ordered]@{}
        foreach ($k in $v2['files'].Keys) { $v1[$k] = $v2['files'][$k] }
        $v1['stackDetected'] = $v2['stackDetected']
        $v1 | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        $manifestBefore = Get-Content $manifestPath -Raw

        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 500
        # The migration still has to have happened in memory, or the audit reads every tracked
        # file as untracked and the byte compare below passes for the wrong reason.
        $out | Should -Match 'agents/task-reviewer\.md\s+in-sync'

        $raw = Get-Content $manifestPath -Raw
        $raw | Should -Be $manifestBefore
        # Raw JSON, because the v1 shape is what proves nothing was written: a migrated manifest
        # would carry a files map, and this one must still be the flat map that went in.
        $raw | Should -Not -Match '"files":\s*\{'
        $raw | Should -Not -Match '"accepted":'
    }

    It "audit reports overlay (changed) once an accepted overlay is edited again" {
        # -IncludeCeremonies so the attention count below is the changed overlay alone.
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -IncludeCeremonies
        'project fork body' | Set-Content "$script:target/.claude/agents/project-only.md"
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'agents/project-only.md' | Out-Null

        'LATER EDIT' | Add-Content "$script:target/.claude/agents/project-only.md"
        $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(changed\)'
        $audit | Should -Match '1 file\(s\) need attention'
    }

    It "-Accept re-pins an already-accepted overlay to its current hash" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        $overlay = "$script:target/.claude/agents/project-only.md"
        'project fork body' | Set-Content $overlay
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'agents/project-only.md' | Out-Null
        $firstPin = (Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable)['accepted']['agents/project-only.md']

        'REVIEWED AND KEPT' | Add-Content $overlay
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'agents/project-only.md' | Out-Null

        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $secondPin = $m['accepted']['agents/project-only.md']
        $secondPin | Should -Not -Be $firstPin
        $secondPin | Should -Be (Get-FileHash -LiteralPath $overlay -Algorithm SHA256).Hash
        $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(accepted\)'
    }

    It "names -Accept in the warning it prints when it skips a project-modified file" {
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        "PROJECT EDIT" | Add-Content "$script:target/.claude/agents/task-reviewer.md"
        # -Width, because Out-String otherwise folds at the host width and can break the
        # flag name across a line boundary where the match would then miss it.
        $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target *>&1 | Out-String -Width 500
        $out | Should -Match "Skipping 'agents/task-reviewer\.md'"
        $out | Should -Match '-Accept'
    }

    It "keeps an accepted key core never shipped visible in the audit table" {
        # Guards the allKeys union. An accepted overlay core does not ship matches nothing in
        # coreFiles and nothing in files, so a union built from those two alone drops the row
        # entirely: the operator reads the overlay as absent rather than as accepted, which is
        # a worse failure than the noise the pin was meant to remove.
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target
        'local convention notes' | Set-Content "$script:target/.claude/project-overlay.md"
        & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Accept 'project-overlay.md' | Out-Null

        $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'project-overlay\.md\s+overlay \(accepted\)'
        $audit | Should -Not -Match 'project-overlay\.md\s+orphaned'
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
