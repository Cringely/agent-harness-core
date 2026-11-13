# install/Install-Harness.Tests.ps1
Describe "Install-Harness" {
    BeforeAll {
        # Dependency preflight seams (Task 15). Every installer call in this suite passes
        # @script:dep, a stub runner that reports every probe present, so no case probes or
        # installs a real tool. The cases that test the preflight itself build their own runner
        # and a fixture manifest.
        $script:hostWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
        $script:depsStubRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-deps-stub-" + [guid]::NewGuid())
        # A Git for Windows layout, so the git-bash entry resolves without the real one.
        New-Item -ItemType Directory -Path (Join-Path $script:depsStubRoot 'git/mingw64/libexec/git-core') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:depsStubRoot 'git/usr/bin') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:depsStubRoot 'git/usr/bin/bash.exe') -Value 'stub'
        $script:depsStubExecPath = Join-Path $script:depsStubRoot 'git/mingw64/libexec/git-core'
        $script:depsPresentBanner = 'GNU bash, version 99.9.9(1)-release ccstatusline@99.9.9'

        # A runner that records (argv, timeout, cwd) and answers through -Answer, which gets
        # (argv, cwd) and returns a hashtable of ExitCode/Output/TimedOut, or $null for "present".
        function New-DepsRecorder {
            param([scriptblock]$Answer)
            $calls = [System.Collections.Generic.List[object]]::new()
            $banner = $script:depsPresentBanner
            $runner = {
                param($argv, $timeout, $cwd)
                $argv = [string[]]@($argv)
                $calls.Add([pscustomobject]@{ Argv = $argv; Timeout = $timeout; Cwd = $cwd })
                $r = $null
                if ($Answer) { $r = & $Answer $argv $cwd }
                if ($null -eq $r) { $r = @{ ExitCode = 0; Output = $banner } }
                [pscustomobject]@{ ExitCode = [int]$r['ExitCode']; Output = [string]$r['Output']; TimedOut = [bool]$r['TimedOut'] }
            }.GetNewClosure()
            [pscustomobject]@{ Runner = $runner; Calls = $calls }
        }

        # A stateful stand-in for the claude plugin CLI, layered on New-DepsRecorder. -Installed
        # maps a plugin id to scope, installPath and optionally projectPath, enabled and version.
        # -AnyProject makes every project-scope row answer for the call's cwd. -Marketplaces maps a
        # marketplace name to its folder. -OnAdd maps a marketplace add source to @{ Name; Location }.
        # -OnInstall maps a plugin id to the row an install adds, its projectPath being the cwd.
        # -Head answers git rev-parse. -ExtraRowJson is spliced into the plugin list verbatim.
        # A command named in -Absent, or missing from a non-null -OnlyPresent, answers 127.
        function New-PluginMock {
            param([hashtable]$Installed = @{}, [switch]$AnyProject, [hashtable]$Marketplaces = @{},
                [hashtable]$OnAdd = @{}, [hashtable]$OnInstall = @{}, [string]$Head, [string]$ExtraRowJson,
                [string[]]$Absent = @(), [string[]]$OnlyPresent, [switch]$FailUninstall, [switch]$UninstallLeavesIt,
                [switch]$FailUpdate, [ValidateSet('', 'UntilUninstall', 'Always')][string]$ListBrokenAfterInstall = '',
                [switch]$ListEmptyAfterUninstall, [string]$HeadAfterInstall, [switch]$WriteSettingsOnInstall)
            $state = @{
                Installed = $Installed; AnyProject = [bool]$AnyProject; Marketplaces = $Marketplaces
                OnAdd = $OnAdd; OnInstall = $OnInstall; Head = $Head; Extra = $ExtraRowJson; FailUninstall = [bool]$FailUninstall; LeavesIt = [bool]$UninstallLeavesIt
                FailUpdate = [bool]$FailUpdate; ListBroken = $ListBrokenAfterInstall; ListEmpty = [bool]$ListEmptyAfterUninstall
                HeadAfter = $HeadAfterInstall; WriteSettings = [bool]$WriteSettingsOnInstall; InstallRan = $false; UninstallRan = $false; Broken = $false
            }
            $execPath = $script:depsStubExecPath
            $only = $OnlyPresent
            $answer = {
                param($argv, $cwd)
                if ($argv[0] -eq 'git' -and $argv[1] -eq '--exec-path') { return @{ ExitCode = 0; Output = $execPath } }
                if ($null -ne $only -and $only -notcontains $argv[0] -and $only -notcontains (Split-Path -Leaf $argv[0])) { return @{ ExitCode = 127; Output = '' } }
                if ($Absent -contains $argv[0]) { return @{ ExitCode = 127; Output = '' } }
                $line = @($argv) -join ' '
                if ($line -eq 'claude plugin list --json') {
                    if ($state.Broken) { return @{ ExitCode = 1; Output = 'list failed' } }
                    if ($state.ListEmpty -and $state.UninstallRan) { return @{ ExitCode = 0; Output = '' } }
                    $rows = [System.Collections.Generic.List[object]]::new()
                    foreach ($k in @($state.Installed.Keys)) {
                        $v = $state.Installed[$k]
                        $row = [ordered]@{ id = $k; version = '1.0.0'; scope = $v['scope']; enabled = $true; installPath = $v['installPath'] }
                        if ($v.Contains('enabled')) { $row['enabled'] = $v['enabled'] }
                        if ($v.Contains('projectPath')) { $row['projectPath'] = $v['projectPath'] }
                        if ($state.AnyProject -and $v['scope'] -eq 'project') { $row['projectPath'] = $cwd }
                        $rows.Add($row)
                    }
                    $json = ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 6 -Compress
                    if ($state.Extra) {
                        $json = if ($rows.Count -gt 0) { $json.Substring(0, $json.Length - 1) + ',' + $state.Extra + ']' } else { '[' + $state.Extra + ']' }
                    }
                    return @{ ExitCode = 0; Output = $json }
                }
                if ($line -eq 'claude plugin marketplace list --json') {
                    # A value is a folder, or @{ Location; Repo } to register the name from another repo.
                    $firstPartyRepos = @{ 'claude-plugins-official' = 'anthropics/claude-plugins-official'; 'anthropic-agent-skills' = 'anthropics/skills' }
                    $rows = @(foreach ($k in @($state.Marketplaces.Keys)) {
                            # A list value lists the name once per element, in order.
                            foreach ($v in @($state.Marketplaces[$k])) {
                                $loc = $v; $repo = $firstPartyRepos[$k]
                                if (-not $repo) { $repo = "example/$k" }
                                if ($v -is [System.Collections.IDictionary]) { $loc = $v['Location']; $repo = $v['Repo'] }
                                [ordered]@{ name = $k; source = 'github'; repo = $repo; installLocation = $loc }
                            }
                        })
                    return @{ ExitCode = 0; Output = (ConvertTo-Json -InputObject $rows -Depth 4 -Compress) }
                }
                if ($argv[0] -eq 'claude' -and $argv[2] -eq 'marketplace' -and $argv[3] -eq 'add') {
                    if ($state.OnAdd.Contains($argv[4])) { $a = $state.OnAdd[$argv[4]]; $state.Marketplaces[$a.Name] = @{ Location = $a.Location; Repo = $argv[4] } }
                    return @{ ExitCode = 0; Output = '' }
                }
                if ($argv[0] -eq 'claude' -and $argv[2] -eq 'install') {
                    if ($state.OnInstall.Contains($argv[3])) {
                        $row = @{} + $state.OnInstall[$argv[3]]
                        if ($row['scope'] -eq 'project') { $row['projectPath'] = $cwd }
                        $state.Installed[$argv[3]] = $row
                    }
                    $state.InstallRan = $true
                    if ($state.ListBroken) { $state.Broken = $true }
                    # As the real CLI does for project scope: enable the plugin in the project's
                    # own settings.json.
                    if ($state.WriteSettings) {
                        $sp = Join-Path (Join-Path $cwd '.claude') 'settings.json'
                        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $sp) -Force
                        $cur = @{}
                        if (Test-Path -LiteralPath $sp) { $cur = Get-Content -LiteralPath $sp -Raw | ConvertFrom-Json -AsHashtable }
                        if (-not $cur.Contains('enabledPlugins')) { $cur['enabledPlugins'] = @{} }
                        $cur['enabledPlugins'][$argv[3]] = $true
                        $cur | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $sp
                    }
                    return @{ ExitCode = 0; Output = '' }
                }
                if ($argv[0] -eq 'claude' -and $argv[2] -eq 'uninstall') {
                    $state.UninstallRan = $true
                    if ($state.ListBroken -eq 'UntilUninstall') { $state.Broken = $false }
                    if ($state.ListEmpty) { return @{ ExitCode = 0; Output = '' } }
                    if ($state.FailUninstall) { return @{ ExitCode = 1; Output = 'uninstall failed' } }
                    if ($state.LeavesIt) { return @{ ExitCode = 0; Output = '' } }
                    $state.Installed.Remove($argv[3]); return @{ ExitCode = 0; Output = '' }
                }
                if ($argv[0] -eq 'claude' -and $argv[2] -eq 'update') {
                    if ($state.FailUpdate) { return @{ ExitCode = 1; Output = 'update failed' } }
                    return @{ ExitCode = 0; Output = '' }
                }
                if ($argv[0] -eq 'git' -and $argv[3] -eq 'rev-parse') {
                    if ($state.HeadAfter -and $state.InstallRan) { return @{ ExitCode = 0; Output = $state.HeadAfter } }
                    return @{ ExitCode = 0; Output = $state.Head }
                }
                return $null
            }.GetNewClosure()
            $rec = New-DepsRecorder -Answer $answer
            $rec | Add-Member -NotePropertyName State -NotePropertyValue $state
            $rec
        }

        # The shipped deps.json's plugins, all installed and enabled where it declares them, with
        # every first-party sha and the one directory commit as the marketplaces would list them.
        # Each plugin folder sits alone in a version-style parent, as Claude Code's cache lays them
        # out, so the audit's newer-sibling check sees no unrelated folders beside it.
        $script:depsStubPluginDir = Join-Path $script:depsStubRoot 'cache/stub-plugin/1.0.0'
        New-Item -ItemType Directory -Path $script:depsStubPluginDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:depsStubPluginDir 'plugin.json') -Value '{}'
        $script:depsStubMarketplaceDir = Join-Path $script:depsStubRoot 'marketplace'
        New-Item -ItemType Directory -Path (Join-Path $script:depsStubMarketplaceDir '.claude-plugin') -Force | Out-Null
        $shipped = Get-Content -LiteralPath "$PSScriptRoot/../core/claude/deps.json" -Raw | ConvertFrom-Json -AsHashtable
        $script:depsStubInstalled = @{}
        $script:depsStubMarketplaces = @{}
        $script:depsStubHead = $null
        $listed = [System.Collections.Generic.List[object]]::new()
        foreach ($e in @($shipped['deps'] | Where-Object { $_['kind'] -eq 'plugin' })) {
            $script:depsStubInstalled[$e['plugin']] = @{ scope = $e['scope']; installPath = $script:depsStubPluginDir }
            $script:depsStubMarketplaces[$e['marketplace']['name']] = $script:depsStubMarketplaceDir
            if ($e['pin'].Contains('commit')) { $script:depsStubHead = $e['pin']['commit'] }
            $src = [ordered]@{ source = 'url' }
            if ($e['pin'].Contains('sha')) { $src['sha'] = $e['pin']['sha'] }
            $listed.Add([ordered]@{ name = ($e['plugin'] -split '@')[0]; source = $src })
        }
        [ordered]@{ plugins = @($listed.ToArray()) } | ConvertTo-Json -Depth 6 |
            Set-Content -LiteralPath (Join-Path $script:depsStubMarketplaceDir '.claude-plugin/marketplace.json')

        # Every probe present, except a command named in -Absent, or, with -OnlyPresent, every
        # probe absent except the commands it names.
        function New-DepsStub {
            param([string[]]$Absent = @(), [string[]]$OnlyPresent)
            New-PluginMock -Installed (@{} + $script:depsStubInstalled) -AnyProject -Marketplaces (@{} + $script:depsStubMarketplaces) `
                -Head $script:depsStubHead -Absent $Absent -OnlyPresent $OnlyPresent
        }

        function New-FakePlugin {
            param([string]$Name = 'fake-plugin', [hashtable]$Severity = @{ code = 'optional' }, [string]$Scope = 'project',
                [string]$Marketplace = 'claude-plugins-official', [hashtable]$Source = @{ github = 'anthropics/claude-plugins-official' },
                [System.Collections.IDictionary]$Pin = ([ordered]@{ firstParty = $true }))
            [ordered]@{
                kind = 'plugin'; name = $Name; plugin = "$Name@$Marketplace"
                marketplace = [ordered]@{ name = $Marketplace; source = $Source }
                pin = $Pin; scope = $Scope; severity = $Severity
                failMode = "Without $Name, the fake skills are absent."
            }
        }

        # A plugin install directory with a little content, so its hash means something.
        function New-FakePluginDir {
            $d = Join-Path $script:depsStubRoot ("cache/" + [guid]::NewGuid() + '/1.0.0')
            New-Item -ItemType Directory -Path (Join-Path $d 'skills/one') -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $d 'skills/one/SKILL.md') -Value 'a skill'
            Set-Content -LiteralPath (Join-Path $d 'plugin.json') -Value '{"name":"fake-plugin"}'
            $d
        }

        # A registered marketplace folder whose marketplace.json lists fake-plugin, at -Sha if given.
        function New-FakeMarketplaceDir {
            param([string]$Sha, [string]$Path)
            $d = if ($Path) { $Path } else { Join-Path $script:depsStubRoot ("marketplace-" + [guid]::NewGuid()) }
            New-Item -ItemType Directory -Path (Join-Path $d '.claude-plugin') -Force | Out-Null
            $src = [ordered]@{ source = 'url'; url = 'https://example.invalid/fake-plugin.git' }
            if ($Sha) { $src['sha'] = $Sha }
            [ordered]@{ plugins = @([ordered]@{ name = 'fake-plugin'; source = $src }) } | ConvertTo-Json -Depth 5 |
                Set-Content -LiteralPath (Join-Path $d '.claude-plugin/marketplace.json')
            $d
        }

        function Read-PluginRecord {
            param([string]$Target, [string]$Id = 'fake-plugin@claude-plugins-official')
            $sidecar = Get-Content -LiteralPath "$Target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
            $sidecar['pluginHashes'][$Id]
        }

        # -Mutate edits the record in place, or returns a value that replaces the whole entry.
        function Set-BrokenPluginRecord {
            param([scriptblock]$Mutate)
            $path = "$script:target/.claude/.harness-manifest.local.json"
            $sidecar = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
            $id = 'fake-plugin@claude-plugins-official'
            $replacement = & $Mutate $sidecar['pluginHashes'][$id]
            if ($null -ne $replacement) { $sidecar['pluginHashes'][$id] = $replacement }
            $sidecar | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path
        }

        function Get-DepsInstallCalls {
            param($Recorder)
            @($Recorder.Calls | Where-Object { @('winget', 'sudo', 'npm') -contains $_.Argv[0] -and (@($_.Argv) -join ' ') -match 'install' })
        }

        function New-FakeDep {
            param([string]$Name = 'harness-fake-hard', [hashtable]$Severity = @{ kernel = 'hard' },
                [string]$Winget = 'Example.FakeHard', [string]$Apt = 'fake-hard', [switch]$NoInstall)
            $d = [ordered]@{
                name = $Name; severity = $Severity; minVersion = '1.2.0'
                failMode = "Without $Name, the fake gate fails open."; probe = @($Name, '--version')
            }
            if (-not $NoInstall) {
                $d['install'] = [ordered]@{
                    windows = [ordered]@{ winget = $Winget; version = '1.2.3' }
                    linux   = [ordered]@{ apt = $Apt; version = '1.2.3' }
                }
            }
            $d
        }

        function New-DepsFixture {
            param([object[]]$Deps)
            $path = Join-Path $script:depsStubRoot ("deps-" + [guid]::NewGuid() + '.json')
            [ordered]@{ schemaVersion = 1; deps = @($Deps) } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path
            $path
        }

        # The pinned command's platform-specific head, as the refusal and warning print it.
        function Get-FakeCommandText {
            param([string]$Winget = 'Example.FakeHard', [string]$Apt = 'fake-hard')
            if ($script:hostWin) { return "winget install --id $Winget --version 1.2.3 --exact --source winget" }
            return "sudo apt-get install -y $Apt=1.2.3"
        }

        $script:dep = @{ DepsRunner = (New-DepsStub).Runner }
    }
    AfterAll {
        Remove-Item -Recurse -Force $script:depsStubRoot -ErrorAction SilentlyContinue
    }
    BeforeEach {
        $script:target = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:target | Out-Null
        # Every install registers its checkout in the per-user drift-check allowlist (issue
        # #265). Point it at the sandbox so the suite never writes the real profile.
        $script:savedAllowlist = $env:HARNESS_CORE_ALLOWLIST
        $env:HARNESS_CORE_ALLOWLIST = "$($script:target)-allowlist/harness-core-checkouts"
    }
    AfterEach {
        $env:HARNESS_CORE_ALLOWLIST = $script:savedAllowlist
        Remove-Item -Recurse -Force "$($script:target)-allowlist" -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $script:target
    }

    It "copies agents, hooks, and templates into .claude" {
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
        Test-Path "$script:target/.claude/agents/task-reviewer.md" | Should -BeTrue
        Test-Path "$script:target/.claude/hooks/agent-worktree-gate.ts" | Should -BeTrue
        Test-Path "$script:target/.claude/hooks/write-scope-parse.ts" | Should -BeTrue
        Test-Path "$script:target/.claude/guardrails.md" | Should -BeTrue
        # Scratch drop box: the directory must exist and carry the self-ignoring rule, or agent
        # working files land in the project's commits.
        Test-Path "$script:target/.claude/scratch" -PathType Container | Should -BeTrue
        # Keeps the coreRepo/stackDetected sidecar out of every commit (issue #137).
        Test-Path "$script:target/.claude/.gitignore" -PathType Leaf | Should -BeTrue
        # \r? before the anchor: the template is LF in the index and core.autocrlf=true
        # checks it out as CRLF, so in -Raw text `$` sits behind a carriage return and a
        # bare `^\*$` never matches on Windows.
        Get-Content "$script:target/.claude/scratch/.gitignore" -Raw | Should -Match '(?m)^\*\r?$'
        # Negative control for the bun-absent refusal below: the stub runner reports bun present,
        # so a mutant that refused unconditionally would throw before reaching this line, and one
        # that printed the refusal text without throwing is caught here.
        $out | Should -Not -Match 'missing hard dependenc'
    }

    It "installs the guardrails template with the invariant-promotion, spec-before-implementation, and review-termination rules from issue #21" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $guardrails = Get-Content "$script:target/.claude/guardrails.md" -Raw
        # Gap 1: the promotion lifecycle's negative half (what never promotes) is the part most
        # likely to get cut for space, so the marker checks that half, not just the header.
        $guardrails | Should -Match 'real subject is a single machine'
        # Gap 2: the spec-and-plan-before-implementation requirement, new in this repo, quoted
        # verbatim from the issue thread's own plugin-independent restatement.
        $guardrails | Should -Match 'exist as artifacts before implementation starts'
        # Ported from account/claude/rules/fix-quality.md's "Work has to be able to end".
        $guardrails | Should -Match 'never opens an issue of its own'
        # #217: the Docs verdict top-block line, above the session-start-end marker so the
        # SessionStart hook reprints it every session.
        $guardrails | Should -Match 'Docs: README still accurate'
    }

    It "merges hook registrations into existing settings.json without clobbering" {
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        '{"permissions":{"allow":["Bash(ls:*)"]}}' | Set-Content "$script:target/.claude/settings.json"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $s = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $s.permissions.allow[0] | Should -Be "Bash(ls:*)"
        $s.hooks | Should -Not -BeNullOrEmpty
    }

    It "builds matcher groups from scratch, one per template matcher, when the target has no hooks key at all" {
        # Collection edge case: no "hooks" property on settings.json at all, so the merge
        # loop's Add-Member scaffolding (line 1004-1006) runs, not the merge path.
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        '{"permissions":{"allow":["Bash(ls:*)"]}}' | Set-Content "$script:target/.claude/settings.json"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $s = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        # core/claude/templates/settings.hooks.json has 3 PreToolUse matcher groups (Agent|Task,
        # Write|Edit|NotebookEdit, Agent|Task|Workflow) and no sibling-merge opportunity exists
        # yet, so each becomes its own group with no duplicates.
        @($s.hooks.PreToolUse).Count | Should -Be 3
        $matchers = @($s.hooks.PreToolUse | ForEach-Object { $_.matcher })
        ($matchers | Sort-Object -Unique).Count | Should -Be 3
    }

    It "merges a template hook into an existing group sharing its matcher instead of appending a duplicate sibling" {
        # Direct regression test for the bug: seed a PreToolUse group under the same matcher
        # the real template also uses (Write|Edit|NotebookEdit), carrying a hook the template
        # does not know about. This is what a prior install (under an older template, or a
        # hand-edited settings.json) leaves behind. On 5d00a41 the loop at lines 1044-1057
        # never checks $existingGroups for a matching .matcher before appending, so this
        # produces two "Write|Edit|NotebookEdit" groups instead of one merged group.
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        @'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|NotebookEdit", "hooks": [ { "type": "command", "command": "echo project-pretooluse-hook" } ] }
    ]
  }
}
'@ | Set-Content "$script:target/.claude/settings.json"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $s = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $sameMatcher = @($s.hooks.PreToolUse | Where-Object { $_.matcher -eq 'Write|Edit|NotebookEdit' })
        # The core assertion: exactly one group carries this matcher, not two siblings.
        $sameMatcher.Count | Should -Be 1
        $commands = @($sameMatcher[0].hooks | ForEach-Object { $_.command })
        $commands | Should -Contain 'echo project-pretooluse-hook'
        ($commands | Where-Object { $_ -match 'agent-write-scope\.ts' }) | Should -Not -BeNullOrEmpty
        # Total PreToolUse groups: the merged one plus the template's other two matchers
        # (Agent|Task and Agent|Task|Workflow) that had nothing to merge into.
        @($s.hooks.PreToolUse).Count | Should -Be 3
    }

    It "leaves the target's own group under an unrelated matcher untouched, in its original position" {
        # Collection edge case: an existing matcher-group on the same event whose matcher the
        # template never uses. It must survive unmerged, unmoved, and unduplicated, while the
        # template's own groups are appended alongside it.
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        @'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "SomeOtherTool", "hooks": [ { "type": "command", "command": "echo unrelated-hook" } ] }
    ]
  }
}
'@ | Set-Content "$script:target/.claude/settings.json"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $s = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $groups = @($s.hooks.PreToolUse)
        $groups.Count | Should -Be 4
        $groups[0].matcher | Should -Be 'SomeOtherTool'
        @($groups[0].hooks | ForEach-Object { $_.command }) | Should -Be @('echo unrelated-hook')
        $unrelated = @($groups | Where-Object { $_.matcher -eq 'SomeOtherTool' })
        $unrelated.Count | Should -Be 1
    }

    It "produces byte-identical settings.json on a second install with no target or template changes" {
        # "Installing twice must equal installing once", checked literally: run the installer
        # twice back-to-back against the same target and diff the raw file text.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $first = Get-Content "$script:target/.claude/settings.json" -Raw
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $second = Get-Content "$script:target/.claude/settings.json" -Raw
        $second | Should -Be $first
    }

    It "does not inject a null hook entry when an existing group has a matcher but no hooks property" {
        # An existing group can carry `matcher` with nothing under `hooks` at all. Merging into
        # it must not concatenate that missing property's $null straight into the array: that
        # serializes a literal `null` entry ahead of the real hooks, which Claude Code can't load.
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        @'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|NotebookEdit" }
    ]
  }
}
'@ | Set-Content "$script:target/.claude/settings.json"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $raw = Get-Content "$script:target/.claude/settings.json" -Raw
        $raw | Should -Not -Match '"hooks":\s*\[\s*null'
        $s = $raw | ConvertFrom-Json
        $matched = @($s.hooks.PreToolUse | Where-Object { $_.matcher -eq 'Write|Edit|NotebookEdit' })
        $matched.Count | Should -Be 1
        (@($matched[0].hooks) | Where-Object { $null -eq $_ }) | Should -BeNullOrEmpty
        (@($matched[0].hooks | ForEach-Object { $_.command }) | Where-Object { $_ -match 'agent-write-scope\.ts' }) | Should -Not -BeNullOrEmpty
    }

    It "treats matcher comparison as case-sensitive, since Claude Code matchers are case-sensitive regexes" {
        # Template uses "Agent|Task" for this event. A target group differing only by case
        # ("agent|task") is a different matcher to Claude Code and must not absorb the
        # template's hooks into a matcher that will never actually fire.
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        @'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "agent|task", "hooks": [ { "type": "command", "command": "echo lowercase-agent-task-hook" } ] }
    ]
  }
}
'@ | Set-Content "$script:target/.claude/settings.json"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $s = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $lowerGroups = @($s.hooks.PreToolUse | Where-Object { $_.matcher -ceq 'agent|task' })
        $properGroups = @($s.hooks.PreToolUse | Where-Object { $_.matcher -ceq 'Agent|Task' })
        # The pre-existing lowercase group must survive untouched, on its own.
        $lowerGroups.Count | Should -Be 1
        @($lowerGroups[0].hooks | ForEach-Object { $_.command }) | Should -Be @('echo lowercase-agent-task-hook')
        # The template's correctly-cased matcher gets its own group rather than being folded
        # into the lowercase one.
        $properGroups.Count | Should -Be 1
        (@($properGroups[0].hooks | ForEach-Object { $_.command }) | Where-Object { $_ -match 'agent-worktree-gate\.ts' }) | Should -Not -BeNullOrEmpty
    }

    It "serializes each matcher group's hooks as a JSON array, even with a single hook" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
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
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        "PROJECT EDIT" | Add-Content "$script:target/.claude/agents/task-reviewer.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        (Get-Content "$script:target/.claude/agents/task-reviewer.md" -Raw) | Should -Match "PROJECT EDIT"
    }

    It "installs ceremony files and their hook registrations only with -IncludeCeremonies" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
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
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -IncludeCeremonies
        Test-Path "$script:target/.claude/agents/soc-monitor.md" | Should -BeTrue
        Test-Path "$script:target/.claude/hooks/wave-close-handoff.sh" | Should -BeTrue
        Test-Path "$script:target/.claude/ceremony-ledger.json" | Should -BeTrue
        $ledger = Get-Content "$script:target/.claude/ceremony-ledger.json" -Raw | ConvertFrom-Json
        $ledger.PSObject.Properties.Name | Should -Not -Contain "council"
        $ledger.PSObject.Properties.Name | Should -Contain "standup"
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
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestBefore = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw
        $settingsBefore = Get-Content "$script:target/.claude/settings.json" -Raw
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "in-sync"
        # File statuses only — the trailing guidance line legitimately names every status.
        $out | Should -Not -Match "\.(md|ts|sh)\s+(project-modified|core-updated|conflict|missing)"
        (Get-Content "$script:target/.claude/.harness-manifest.json" -Raw) | Should -Be $manifestBefore
        (Get-Content "$script:target/.claude/settings.json" -Raw) | Should -Be $settingsBefore
    }

    It "audit classifies a project-modified file" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        "PROJECT EDIT" | Add-Content "$script:target/.claude/agents/task-reviewer.md"
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+project-modified"
    }

    It "audit classifies core-updated when core moved on but the project did not" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        # Simulate "core changed since install": rewrite the installed file AND its
        # recorded manifest hash to agree with each other but not with core source.
        $dst = "$script:target/.claude/agents/task-reviewer.md"
        "OLD CORE VERSION" | Set-Content $dst
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/task-reviewer.md'] = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
        $m | ConvertTo-Json -Depth 20 | Set-Content "$script:target/.claude/.harness-manifest.json"
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+core-updated"
    }

    It "audit classifies missing and orphaned manifest entries" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        Remove-Item "$script:target/.claude/agents/task-reviewer.md"
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired-agent.md'] = 'DEADBEEF'
        $m | ConvertTo-Json -Depth 20 | Set-Content "$script:target/.claude/.harness-manifest.json"
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "agents/task-reviewer\.md\s+missing"
        $out | Should -Match "agents/retired-agent\.md\s+orphaned"
    }

    It "adopts a hand-built file identical to core into the manifest without -Force" {
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        Copy-Item "$PSScriptRoot/../core/claude/agents/task-reviewer.md" "$script:target/.claude/agents/"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/task-reviewer.md'] | Should -Not -BeNullOrEmpty
        $src = (Get-FileHash "$PSScriptRoot/../core/claude/agents/task-reviewer.md" -Algorithm SHA256).Hash
        $m['files']['agents/task-reviewer.md'] | Should -Be $src
    }

    It "records an empty stackDetected.plugins array in the sidecar when the plugin cache dir is missing, without throwing" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $fakeHome | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } | Should -Not -Throw
            $m = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
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
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
            $m = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
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
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } | Should -Not -Throw
            $m = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
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
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
            # Same collapse hazard as the settings.json hooks array: a single-match result
            # captured into a variable can serialize as a bare string instead of a
            # 1-element array. Assert the raw JSON shape, not just the deserialized value.
            $raw = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw
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
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
            $m = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
            @($m['stackDetected']['mcpServers']) | Should -Be @('code-context')
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "does not throw and returns an empty mcpServers array when the target's .mcp.json is malformed" {
        '{ this is not valid json' | Set-Content "$script:target/.mcp.json"
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } | Should -Not -Throw
        $m = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
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
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } | Should -Not -Throw
        }
        finally {
            # Restore permissions before Remove-Item, or cleanup itself fails on the
            # now-unreadable/unlistable directory.
            & chmod 755 $cacheDir
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "keeps stackDetected and coreRepo out of the committed manifest, recording them in the sidecar instead, and drops the old pluginsDetected key" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files'].Contains('guardrails.md') | Should -BeTrue
        $m['files'].Contains('agents/task-reviewer.md') | Should -BeTrue
        $m.Contains('pluginsDetected') | Should -BeFalse
        # No absolute path, no per-run timestamp, no per-machine plugin inventory in the file a
        # target repo commits (issue #137). coreCommit is the provenance that travels.
        $m.Contains('stackDetected') | Should -BeFalse
        $m.Contains('coreRepo') | Should -BeFalse
        $m.Contains('coreCommit') | Should -BeTrue

        $sidecar = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
        $sidecar.Contains('coreRepo') | Should -BeTrue
        $sidecar.Contains('stackDetected') | Should -BeTrue
        $sidecar['stackDetected'].Contains('scannedAt') | Should -BeTrue
        $sidecar['stackDetected'].Contains('plugins') | Should -BeTrue
        $sidecar['stackDetected'].Contains('outputStyles') | Should -BeTrue
        $sidecar['stackDetected'].Contains('mcpServers') | Should -BeTrue
    }

    It "the sidecar is gitignored and never reaches git status in a real repo" {
        & git -C $script:target init -q *>&1 | Out-Null
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        Test-Path "$script:target/.claude/.gitignore" -PathType Leaf | Should -BeTrue
        & git -C $script:target check-ignore -q '.claude/.harness-manifest.local.json'
        $LASTEXITCODE | Should -Be 0
        $status = & git -C $script:target status --porcelain '.claude/.harness-manifest.local.json'
        $status | Should -BeNullOrEmpty
    }

    It "audit reports plugin drift against the sidecar without writing the manifest or the sidecar" {
        $fakeHome = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakehome-" + [guid]::NewGuid())
        $cacheDir = Join-Path $fakeHome '.claude/plugins/cache'
        New-Item -ItemType Directory -Path (Join-Path $cacheDir 'mp/plugin-one') -Force | Out-Null
        $prevUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeHome
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
            New-Item -ItemType Directory -Path (Join-Path $cacheDir 'mp/plugin-two') -Force | Out-Null
            $manifestBefore = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw
            $sidecarBefore = Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
            $pattern = [regex]::Escape('+ mp/plugin-two')
            $out | Should -Match $pattern
            (Get-Content "$script:target/.claude/.harness-manifest.json" -Raw) | Should -Be $manifestBefore
            (Get-Content "$script:target/.claude/.harness-manifest.local.json" -Raw) | Should -Be $sidecarBefore
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
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
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
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
            $sidecarPath = "$script:target/.claude/.harness-manifest.local.json"
            $s = Get-Content $sidecarPath -Raw | ConvertFrom-Json -AsHashtable
            $s['stackDetected'] = $null
            ($s | ConvertTo-Json -Depth 20) | Set-Content $sidecarPath
            $sidecarBefore = Get-Content $sidecarPath -Raw

            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit } | Should -Not -Throw
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
            $out | Should -Match "Plugins detected: 1 \(manifest last recorded: 0\)"
            $pattern = [regex]::Escape('+ mp/plugin-one (newly detected)')
            $out | Should -Match $pattern
            (Get-Content $sidecarPath -Raw) | Should -Be $sidecarBefore
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
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
            $sidecarPath = "$script:target/.claude/.harness-manifest.local.json"
            $s = Get-Content $sidecarPath -Raw | ConvertFrom-Json -AsHashtable
            $s['stackDetected'] = 42
            ($s | ConvertTo-Json -Depth 20) | Set-Content $sidecarPath
            $sidecarBefore = Get-Content $sidecarPath -Raw

            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit } | Should -Not -Throw
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
            $out | Should -Match "Plugins detected: 1 \(manifest last recorded: 0\)"
            $pattern = [regex]::Escape('+ mp/plugin-one (newly detected)')
            $out | Should -Match $pattern
            (Get-Content $sidecarPath -Raw) | Should -Be $sidecarBefore
        }
        finally {
            $env:USERPROFILE = $prevUserProfile
            Remove-Item -Recurse -Force $fakeHome
        }
    }

    It "audit handles a hand-built .claude with no manifest as untracked" {
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        Copy-Item "$PSScriptRoot/../core/claude/agents/task-reviewer.md" "$script:target/.claude/agents/"
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String
        $out | Should -Match "never installed here"
        $out | Should -Match "agents/task-reviewer\.md\s+untracked \(matches core\)"
        $out | Should -Match "not-installed"
        Test-Path "$script:target/.claude/.harness-manifest.json" | Should -BeFalse
        Test-Path "$script:target/.claude/settings.json" | Should -BeFalse
    }

    It "wires git core.hooksPath and the reported row agrees with git itself" {
        & git -C $script:target init -q *>&1 | Out-Null
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String
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

    It "install prints a plain warning naming the three git hooks and pointing at guardrails.md when core.hooksPath is already set" {
        # #136/#126: the pre-fix message only named "the harness pre-commit hook", which
        # undersold the finding -- commit-msg and pre-push are equally inert, not just pre-commit.
        & git -C $script:target init -q *>&1 | Out-Null
        & git -C $script:target config core.hooksPath '.githooks' *>&1 | Out-Null
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
        $out | Should -Match 'skipped-already-set'
        $out | Should -Match 'none of the harness''s git hooks \(commit-msg, pre-commit, pre-push\) will run'
        $out | Should -Match 'core\.hooksPath and other hook managers.*\.claude/guardrails\.md'
    }

    It "audit reports an installed git hook as unreachable, naming core.hooksPath, when core.hooksPath already pointed elsewhere at install time" {
        # #136: the installer still writes the hook files under .claude/hooks/ when wiring is
        # skipped, and a pre-fix audit compared their content against core and reported
        # 'in-sync' -- true and misleading, since git never reads that directory here.
        & git -C $script:target init -q *>&1 | Out-Null
        & git -C $script:target config core.hooksPath '.githooks' *>&1 | Out-Null
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target | Out-Null

        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'hooks/pre-commit\s+in-sync \(unreachable: core\.hooksPath -> \.githooks\)'
        $audit | Should -Match 'hooks/commit-msg\s+in-sync \(unreachable: core\.hooksPath -> \.githooks\)'
        $audit | Should -Match 'hooks/pre-push\s+in-sync \(unreachable: core\.hooksPath -> \.githooks\)'
        # The whole point: an unreachable hook must count as needing attention, not disappear
        # into the 'in-sync' exclusion the way it did before the reachability note changed the
        # status string.
        $audit | Should -Not -Match 'All managed files in sync with core\.'
    }

    It "audit reports git hooks as unreachable when core.hooksPath is redirected after a clean install" {
        # #126's point: wiring is decided once, at install time, but core.hooksPath can change
        # any time afterward (a project adopting husky, or hand-editing config), and only a
        # live re-check at audit time catches that.
        & git -C $script:target init -q *>&1 | Out-Null
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target | Out-Null
        $wiredAudit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $wiredAudit | Should -Match '(?m)hooks/pre-commit\s+in-sync\s*\r?$'
        $wiredAudit | Should -Not -Match 'unreachable'

        & git -C $script:target config core.hooksPath '.githooks' *>&1 | Out-Null
        $driftedAudit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $driftedAudit | Should -Match 'hooks/pre-commit\s+in-sync \(unreachable: core\.hooksPath -> \.githooks\)'
    }

    It "audit resolves a relative core.hooksPath against the worktree toplevel, not against the target, for a subdirectory target" {
        # #136 round-2: git resolves a relative core.hooksPath against the repository's
        # toplevel, never against the -C directory it was asked through. A subdirectory
        # target installs its own .claude/hooks, and the pre-fix Join-Path-onto-$AbsTarget
        # resolution happened to land on that same directory, so the audit reported
        # reachable while git actually read the toplevel's .claude/hooks (verified live: a
        # commit from the subdirectory target fires the toplevel's hook, not the
        # subdirectory's).
        & git -C $script:target init -q *>&1 | Out-Null
        $sub = Join-Path $script:target 'sub'
        New-Item -ItemType Directory -Path $sub | Out-Null
        & git -C $script:target config core.hooksPath '.claude/hooks' *>&1 | Out-Null

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $sub | Out-Null
        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $sub -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'hooks/pre-commit\s+in-sync \(unreachable: core\.hooksPath -> \.claude/hooks\)'
        $audit | Should -Not -Match 'All managed files in sync with core\.'
    }

    It "install-time wiring resolves a relative core.hooksPath against the worktree toplevel, not against the target, for a subdirectory target" {
        # #204: same defect as the audit-time case above (#136 round-2), one level earlier.
        # The install-time $alreadyWired check joined a relative core.hooksPath onto $Target
        # instead of asking git to resolve it, and for a subdirectory target that join landed
        # on the subdirectory's own .claude/hooks -- which this same run had just created a
        # moment earlier, copying the template files in regardless of wiring -- so the two
        # paths coincided and the row falsely claimed 'unchanged'. Git itself never reads that
        # directory here: a relative core.hooksPath resolves against the toplevel, so git
        # reads the toplevel's .claude/hooks, which this test never creates.
        & git -C $script:target init -q *>&1 | Out-Null
        $sub = Join-Path $script:target 'sub'
        New-Item -ItemType Directory -Path $sub | Out-Null
        & git -C $script:target config core.hooksPath '.claude/hooks' *>&1 | Out-Null

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $sub *>&1 | Out-String -Width 500
        # The honest answer here is 'skipped-already-set': core.hooksPath is set, so the
        # installer must not claim it points at the harness's hooks when git resolves it
        # elsewhere, and must not overwrite it without being told to.
        $out | Should -Match 'git:core\.hooksPath\s+skipped-already-set'
        $out | Should -Not -Match 'git:core\.hooksPath\s+unchanged'

        # Cross-check against git's own resolution, the same way the top-level wiring test
        # above does: the claim in the table has to agree with the repository's actual
        # behaviour, not just with whichever branch the installer happened to take. git
        # prints a relative path here (discovered, not named, via -C), so join it onto $sub
        # before resolving -- Resolve-Path alone would resolve it against the test's own
        # working directory instead. GetFullPath, not Resolve-Path, because git's real answer
        # (the toplevel's .claude/hooks) is never created by this test -- that absence is the
        # point, and Resolve-Path would throw on it.
        $actualHooksDirRaw = & git -C $sub rev-parse --git-path hooks
        $LASTEXITCODE | Should -Be 0
        $actualHooksDirAbs = if ([System.IO.Path]::IsPathRooted($actualHooksDirRaw)) { $actualHooksDirRaw } else { Join-Path $sub $actualHooksDirRaw }
        $actualHooksDirAbs = [System.IO.Path]::GetFullPath($actualHooksDirAbs).TrimEnd([char[]]@('\', '/'))
        $topLevelHooksAbs = (Join-Path (Resolve-Path -LiteralPath $script:target).Path '.claude\hooks').TrimEnd([char[]]@('\', '/'))
        $subHooksDstAbs = (Resolve-Path -LiteralPath (Join-Path $sub '.claude/hooks')).Path.TrimEnd([char[]]@('\', '/'))
        # git reads the toplevel's .claude/hooks, not the subdirectory's -- the exact
        # coincidence the buggy Join-Path resolution missed.
        $actualHooksDirAbs | Should -Be $topLevelHooksAbs
        $actualHooksDirAbs | Should -Not -Be $subHooksDstAbs
    }

    It "install-time wiring does not falsely report skipped-already-set for a relative -Target and a relative core.hooksPath when the session location and the process CWD have diverged" {
        # #222 round-2 repair, the opposite failure from the two tests above: the #204 fix
        # resolved $currentHooksPath correctly, but still joined the relative
        # `rev-parse --git-path hooks` output onto the raw, possibly-relative $Target and
        # called [System.IO.Path]::GetFullPath, which resolves against the .NET process
        # directory rather than PowerShell's own location (documented above
        # Resolve-LayerPath, and exercised the same way by the C1/C2 tests in
        # Export-Account.Tests.ps1: Set-Location from this repo's drive into a stand-in on
        # another drive is what leaves the two apart in this environment).
        #
        # A relative -Target alone does not reach the buggy branch: when core.hooksPath was
        # set by this installer it is always the absolute $hooksDstAbs, so `rev-parse
        # --git-path hooks` echoes it back already rooted and the Join-Path/GetFullPath
        # pair is skipped. The branch needs core.hooksPath itself to be relative too, which
        # `git rev-parse --git-path hooks` then also prints relative when asked through a
        # relative -C -- the situation an operator who wired hooks by hand with a relative
        # value (a Husky-style setup, or an older harness install) leaves behind. Reproduced
        # live against the pre-fix code before this test was written: the wrongly-joined
        # path landed on this worktree's own .claude/hooks (wherever the .NET process
        # directory happened to still point) instead of the stand-in target's, so 'unchanged'
        # never matched and the row read 'skipped-already-set' for a target that was already
        # correctly wired.
        & git -C $script:target init -q *>&1 | Out-Null
        & git -C $script:target config core.hooksPath '.claude/hooks' *>&1 | Out-Null

        $startLocation = Get-Location
        try {
            Set-Location -LiteralPath $script:target
            # The copy step that installs .claude/hooks's contents runs unconditionally,
            # ahead of the wiring branch under test, so the relative core.hooksPath set
            # above already names the directory the harness just populated.
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target '.' *>&1 | Out-String -Width 500
            $out | Should -Match 'git:core\.hooksPath\s+unchanged'
            $out | Should -Not -Match 'skipped-already-set'
        }
        finally {
            Set-Location -LiteralPath $startLocation
        }
    }

    It "skips core.hooksPath wiring, and writes into no repository at all, when a foreign GIT_DIR is exported" {
        # Issue #145. Every probe in the wiring block asks git through `-C $Target`, and git
        # exports GIT_DIR into every hook it runs, so an installer launched from a hook in
        # another repository (or from any shell where the variable is set) read THAT
        # repository's core.hooksPath and then wrote this target's hooks directory into its
        # config, redirecting or disabling the other project's hooks. Same class as the
        # sidecar probe's round-4 A finding, which #140 closed with Test-GitAnswersForTarget.
        & git -C $script:target init -q *>&1 | Out-Null
        $other = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-other-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $other | Out-Null
        try {
            & git -C $other init -q *>&1 | Out-Null
            # Saved and restored, not merely removed (#165): a suite launched from an environment
            # that already exports GIT_DIR (a git hook, an operator's shell) must see it back
            # afterward, or every later test in this run inherits the leak instead of asking git
            # about its own target.
            $savedGitDir = Get-Item -LiteralPath 'Env:GIT_DIR' -ErrorAction SilentlyContinue
            $env:GIT_DIR = (Join-Path $other '.git')
            try {
                $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            }
            finally {
                if ($savedGitDir) { Set-Item -LiteralPath 'Env:GIT_DIR' -Value $savedGitDir.Value }
                else { Remove-Item -LiteralPath 'Env:GIT_DIR' -ErrorAction SilentlyContinue }
            }

            # The results table is the operator's only signal, so the skip carries a named
            # reason rather than passing silently: a silent skip reads exactly like a wiring
            # that happened.
            $out | Should -Match 'skipped-foreign-git'
            $out | Should -Match "git answered, but not for this target's own repository"

            # The defect itself: the foreign repository's config was written. `config --get`
            # exits 1 when the key is unset, so this asserts nothing was written there.
            & git -C $other config --get core.hooksPath *>$null
            $LASTEXITCODE | Should -Be 1
            # And nothing landed in the target either. Wiring the target anyway would mean
            # trusting the same answers the guard just rejected; the installer is told to
            # skip with a reason, not to guess which repository was meant.
            & git -C $script:target config --get core.hooksPath *>$null
            $LASTEXITCODE | Should -Be 1
        }
        finally {
            Remove-Item -Recurse -Force $other
        }
    }

    It "wires git core.hooksPath when GIT_INDEX_FILE points inside the target's own git directory" {
        # Issue #164. Git exports a temporary lock file (e.g. `<gitdir>/next-index-NNNNN.lock`)
        # into hooks it runs during `commit --only`, rebase, stash and merge, so an installer
        # launched from one of those hooks in the TARGET's own repository saw a GIT_INDEX_FILE
        # that did not match the default `.git/index` path and refused, even though git was
        # answering for the target the whole time. This is the legitimate case the guard must
        # accept: toplevel, absolute-git-dir and git-common-dir all still name the target.
        & git -C $script:target init -q *>&1 | Out-Null
        $gitDir = (Resolve-Path -LiteralPath "$script:target/.git").Path
        # Saved and restored, not merely removed (#165): see the foreign-GIT_DIR test above.
        $savedGitIndexFile = Get-Item -LiteralPath 'Env:GIT_INDEX_FILE' -ErrorAction SilentlyContinue
        $env:GIT_INDEX_FILE = Join-Path $gitDir 'next-index-12345.lock'
        try {
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
        }
        finally {
            if ($savedGitIndexFile) { Set-Item -LiteralPath 'Env:GIT_INDEX_FILE' -Value $savedGitIndexFile.Value }
            else { Remove-Item -LiteralPath 'Env:GIT_INDEX_FILE' -ErrorAction SilentlyContinue }
        }

        $out | Should -Not -Match 'skipped-foreign-git'
        $out | Should -Match 'git:core\.hooksPath'
        $out | Should -Match 'set to '
        $actual = & git -C $script:target config --get core.hooksPath
        $LASTEXITCODE | Should -Be 0
        (Resolve-Path -LiteralPath $actual).Path |
            Should -Be (Resolve-Path -LiteralPath "$script:target/.claude/hooks").Path
    }

    It "throws the sidecar refusal instead of leaking a staged sidecar when GIT_INDEX_FILE names a hook's temporary index (#181 R2-1)" {
        # #164's carve-out let a hook's temporary index (`<gitdir>/next-index-NNNNN.lock`,
        # exported during `commit --only`, rebase, stash and merge) pass the shared guard as
        # "git answering for the target." That guard also gates the sidecar's tracked probe, and
        # the probe's answer has to depend on what the index CONTAINS, not where the index file
        # sits: a sidecar staged in the real index but absent from a hook's temporary one -- what
        # `commit --only` builds when the sidecar is not one of the paths named on that commit --
        # read as untracked, and Get-SidecarPlan deleted the working copy while the staged entry
        # reached the next commit untouched (round-3's R2-1). Fixed by requiring an exact index
        # match for this caller instead of the carve-out, so a hook's temporary index now answers
        # "git cannot answer" here too, and this throws the refusal instead of guessing.
        & git -C $script:target init -q *>&1 | Out-Null
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target | Out-Null

        # Un-ignore the sidecar so a plain `git add` stages it without -f, the same as a sidecar
        # force-added or staged by hand before this gate existed (round-3's original R2-1 case).
        'nothing ignored here' | Set-Content "$script:target/.claude/.gitignore"
        & git -C $script:target add -- .claude/.harness-manifest.local.json
        $LASTEXITCODE | Should -Be 0
        & git -C $script:target diff --cached --name-only -- .claude/.harness-manifest.local.json |
            Should -Match 'harness-manifest\.local\.json'

        $gitDir = (Resolve-Path -LiteralPath "$script:target/.git").Path
        # Saved and restored, not merely removed (#165): see the foreign-GIT_DIR test above.
        $savedGitIndexFile = Get-Item -LiteralPath 'Env:GIT_INDEX_FILE' -ErrorAction SilentlyContinue
        $env:GIT_INDEX_FILE = Join-Path $gitDir 'next-index-77777.lock'
        try {
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } |
                Should -Throw -ExpectedMessage '*could not confirm whether it is already tracked*'
        }
        finally {
            if ($savedGitIndexFile) { Set-Item -LiteralPath 'Env:GIT_INDEX_FILE' -Value $savedGitIndexFile.Value }
            else { Remove-Item -LiteralPath 'Env:GIT_INDEX_FILE' -ErrorAction SilentlyContinue }
        }

        # The refusal's own promise: nothing was written. The working copy must still be there
        # (the pre-fix defect deleted it) and the real index's staged entry untouched.
        Test-Path -LiteralPath "$script:target/.claude/.harness-manifest.local.json" | Should -BeTrue
        & git -C $script:target diff --cached --name-only -- .claude/.harness-manifest.local.json |
            Should -Match 'harness-manifest\.local\.json'
    }

    It "wires core.hooksPath but still declines the sidecar when GIT_INDEX_FILE points outside the target's git directory" {
        # #181 round 2: the #164 carve-out lived in the shared guard, so it also loosened the
        # sidecar's tracked probe, which depends on what the index CONTAINS rather than where the
        # index file sits (the R2-1 leak). Fixed by splitting the two callers instead of sharing
        # one answer: hooksPath wiring passes -IgnoreIndex, since `git config core.hooksPath`
        # writes by toplevel, absolute-git-dir and git-common-dir and the index plays no part in
        # where that write lands, so an unrelated GIT_INDEX_FILE has nothing to say about it. The
        # sidecar probe still calls with no switch and requires an exact index match. This one
        # environment now produces both halves of that split in a single run: wiring proceeds,
        # and the sidecar write is declined pending a git that can actually confirm it.
        & git -C $script:target init -q *>&1 | Out-Null
        $outsideDir = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-outside-index-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $outsideDir | Out-Null
        try {
            # Saved and restored, not merely removed (#165): see the foreign-GIT_DIR test above.
            $savedGitIndexFile = Get-Item -LiteralPath 'Env:GIT_INDEX_FILE' -ErrorAction SilentlyContinue
            $env:GIT_INDEX_FILE = Join-Path $outsideDir 'index'
            try {
                $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            }
            finally {
                if ($savedGitIndexFile) { Set-Item -LiteralPath 'Env:GIT_INDEX_FILE' -Value $savedGitIndexFile.Value }
                else { Remove-Item -LiteralPath 'Env:GIT_INDEX_FILE' -ErrorAction SilentlyContinue }
            }

            $out | Should -Not -Match 'skipped-foreign-git'
            $out | Should -Match 'git:core\.hooksPath'
            $out | Should -Match 'set to '
            $actual = & git -C $script:target config --get core.hooksPath
            $LASTEXITCODE | Should -Be 0
            (Resolve-Path -LiteralPath $actual).Path |
                Should -Be (Resolve-Path -LiteralPath "$script:target/.claude/hooks").Path

            # The sidecar question is a separate call with no -IgnoreIndex, so the same
            # unrelated GIT_INDEX_FILE still reads as "git cannot answer" there, and no sidecar
            # is written on an unconfirmed answer.
            $out | Should -Match "git could not answer for this target's own repository"
            Test-Path -LiteralPath "$script:target/.claude/.harness-manifest.local.json" | Should -BeFalse
        }
        finally {
            Remove-Item -Recurse -Force $outsideDir
        }
    }

    It "skips core.hooksPath wiring when GIT_WORK_TREE redirects the target's toplevel to another directory" {
        # #165 item 3: GIT_DIR and GIT_INDEX_FILE were exercised above, GIT_WORK_TREE and
        # GIT_COMMON_DIR were not, though Test-GitAnswersForTarget compares all four. GIT_WORK_TREE
        # alone (no GIT_DIR needed) redirects `rev-parse --show-toplevel` away from the target
        # while `--absolute-git-dir` stays put -- the toplevel mismatch the guard's field
        # comparison exists to catch. Verified live: `git -C <target> rev-parse --show-toplevel`
        # with only GIT_WORK_TREE exported prints the GIT_WORK_TREE path, not the target.
        & git -C $script:target init -q *>&1 | Out-Null
        $other = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-worktree-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $other | Out-Null
        try {
            # Saved and restored, not merely removed (#165): see the foreign-GIT_DIR test above.
            $savedGitWorkTree = Get-Item -LiteralPath 'Env:GIT_WORK_TREE' -ErrorAction SilentlyContinue
            $env:GIT_WORK_TREE = $other
            try {
                $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            }
            finally {
                if ($savedGitWorkTree) { Set-Item -LiteralPath 'Env:GIT_WORK_TREE' -Value $savedGitWorkTree.Value }
                else { Remove-Item -LiteralPath 'Env:GIT_WORK_TREE' -ErrorAction SilentlyContinue }
            }

            $out | Should -Match 'skipped-foreign-git'
            $out | Should -Match "git answered, but not for this target's own repository"
            & git -C $script:target config --get core.hooksPath *>$null
            $LASTEXITCODE | Should -Be 1
        }
        finally {
            Remove-Item -Recurse -Force $other
        }
    }

    It "skips core.hooksPath wiring when GIT_COMMON_DIR alone redirects the target's common dir to another repository" {
        # #165 item 3, the field #165 itself named as unexercised. GIT_COMMON_DIR alone (no GIT_DIR
        # pinned) redirects `rev-parse --git-common-dir` to the other repository while toplevel and
        # absolute-git-dir stay at the target's own -- the mismatch the guard's third field
        # comparison exists to catch. Verified live on git 2.53.0.windows.1: with only GIT_COMMON_DIR
        # exported, `git -C <target> rev-parse --show-toplevel --absolute-git-dir --git-common-dir
        # --git-path index` exits 0 and prints the target's own toplevel and git-dir alongside the
        # foreign common-dir, and a plain `git -C <target> config core.hooksPath X` with no guard
        # writes into the OTHER repository's .git/config, not the target's -- a live one-variable
        # route to the cross-repo write this guard exists to stop. An earlier version of this test
        # pinned GIT_DIR here on the belief that GIT_COMMON_DIR needs it. That belief was wrong.
        & git -C $script:target init -q *>&1 | Out-Null
        $other = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-commondir-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $other | Out-Null
        try {
            & git -C $other init -q *>&1 | Out-Null
            $otherGitDir = (Resolve-Path -LiteralPath "$other/.git").Path
            # Saved and restored, not merely removed (#165): see the foreign-GIT_DIR test above.
            $savedGitCommonDir = Get-Item -LiteralPath 'Env:GIT_COMMON_DIR' -ErrorAction SilentlyContinue
            $env:GIT_COMMON_DIR = $otherGitDir
            try {
                $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            }
            finally {
                if ($savedGitCommonDir) { Set-Item -LiteralPath 'Env:GIT_COMMON_DIR' -Value $savedGitCommonDir.Value }
                else { Remove-Item -LiteralPath 'Env:GIT_COMMON_DIR' -ErrorAction SilentlyContinue }
            }

            $out | Should -Match 'skipped-foreign-git'
            $out | Should -Match "git answered, but not for this target's own repository"
            & git -C $script:target config --get core.hooksPath *>$null
            $LASTEXITCODE | Should -Be 1
            & git -C $other config --get core.hooksPath *>$null
            $LASTEXITCODE | Should -Be 1
        }
        finally {
            Remove-Item -Recurse -Force $other
        }
    }

    It "wires core.hooksPath into the target's own local config, not a GIT_CONFIG redirect" {
        # Issue #191. `git config` with no --file redirects through GIT_CONFIG when that
        # variable is exported, and GIT_CONFIG is none of the four location variables
        # Test-GitAnswersForTarget compares (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
        # GIT_COMMON_DIR), so an exported GIT_CONFIG sails through that guard untouched and
        # reaches the write plain. Without --local the write lands in whatever file
        # GIT_CONFIG names, the results row still claims "set to $hooksDstAbs", and the
        # target's own .git/config keeps no core.hooksPath at all.
        & git -C $script:target init -q *>&1 | Out-Null
        $redirectFile = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-gitconfig-" + [guid]::NewGuid())
        # Saved and restored, not merely removed (#165): see the foreign-GIT_DIR test above.
        $savedGitConfig = Get-Item -LiteralPath 'Env:GIT_CONFIG' -ErrorAction SilentlyContinue
        $env:GIT_CONFIG = $redirectFile
        try {
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
        }
        finally {
            if ($savedGitConfig) { Set-Item -LiteralPath 'Env:GIT_CONFIG' -Value $savedGitConfig.Value }
            else { Remove-Item -LiteralPath 'Env:GIT_CONFIG' -ErrorAction SilentlyContinue }
        }

        $out | Should -Match 'git:core\.hooksPath'
        $out | Should -Match 'set to '

        # The defect itself: the write must reach the target's own repository config, not the
        # file GIT_CONFIG named. --local pins the read to that file regardless of GIT_CONFIG.
        $actual = & git -C $script:target config --local --get core.hooksPath
        $LASTEXITCODE | Should -Be 0
        (Resolve-Path -LiteralPath $actual).Path |
            Should -Be (Resolve-Path -LiteralPath "$script:target/.claude/hooks").Path

        # And nothing was ever written into the GIT_CONFIG file: it was never created, because
        # the write never opened it. A row claiming "set to" while this file is what actually
        # changed would be the exact silent redirect #191 named.
        Test-Path -LiteralPath $redirectFile | Should -BeFalse
    }

    It "does not overwrite an existing local core.hooksPath when GIT_CONFIG is exported to an empty or missing file" {
        # Load-bearing review finding on #218. The first #191 fix cleared GIT_CONFIG only
        # around the final write, but the `--get core.hooksPath` probe that decides
        # skipped-already-set still read through it unguarded. Against an exported GIT_CONFIG
        # naming an empty or missing file, git's `--get` on that file reports unset even
        # though the target's own local config already has a real core.hooksPath (a
        # Husky-style .husky setup, here), so the probe hid the existing wiring, the
        # skipped-already-set branch never fired, and the plain --local write that followed
        # replaced .husky while still reporting "set to $hooksDstAbs".
        & git -C $script:target init -q *>&1 | Out-Null
        & git -C $script:target config --local core.hooksPath '.husky' *>&1 | Out-Null
        $redirectFile = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-test-gitconfig-empty-" + [guid]::NewGuid())
        # $redirectFile is deliberately never created: git's `--get` on a GIT_CONFIG file that
        # does not exist yet exits non-zero the same way it does against a present-but-empty
        # one, so this exercises the "empty or missing" case the finding names without a
        # second variant.
        $savedGitConfig = Get-Item -LiteralPath 'Env:GIT_CONFIG' -ErrorAction SilentlyContinue
        $env:GIT_CONFIG = $redirectFile
        try {
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
        }
        finally {
            if ($savedGitConfig) { Set-Item -LiteralPath 'Env:GIT_CONFIG' -Value $savedGitConfig.Value }
            else { Remove-Item -LiteralPath 'Env:GIT_CONFIG' -ErrorAction SilentlyContinue }
        }

        $out | Should -Match 'skipped-already-set'
        # Not a plain 'set to ' check: the skipped-already-set warning text itself contains
        # "is already set to '.husky'", so only the results-table row can tell a real write
        # apart from that message.
        $out | Should -Not -Match 'git:core\.hooksPath\s+set to '

        # The invariant: .husky survives untouched, in the target's own local config.
        $actual = & git -C $script:target config --local --get core.hooksPath
        $LASTEXITCODE | Should -Be 0
        $actual | Should -Be '.husky'

        Test-Path -LiteralPath $redirectFile | Should -BeFalse
    }

    It "installs the pre-commit hook with the owner execute bit actually set" -Skip:$IsWindows {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $hook = Get-Item -LiteralPath "$script:target/.claude/hooks/pre-commit"
        # git skips a hook without the execute bit and says nothing, so the bit is what
        # makes the hook real rather than merely present. Copy-Item does not carry it and
        # the source file is 0644 in the repo, so this asserts the installer's chmod landed
        # on the hook file itself. Asserting only that a chmod failure gets reported would
        # pass just as happily with the chmod pointed at the wrong path.
        $hook.UnixMode | Should -Match '^.{3}x'
    }

    # commit-msg and pre-push get the same assertion for the same reason. Both were added to
    # the chmod loop after pre-commit and neither had a test, which is how one of them would
    # have been dropped from that list without anything noticing: git skips an unmarked hook
    # silently, so a missing execute bit looks exactly like a gate that examined the commit
    # and approved it.
    It "installs the <Name> hook with the owner execute bit actually set" -Skip:$IsWindows -ForEach @(
        @{ Name = 'pre-push' }
        @{ Name = 'commit-msg' }
    ) {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        (Get-Item -LiteralPath "$script:target/.claude/hooks/$Name").UnixMode | Should -Match '^.{3}x'
    }

    It "installs commit-msg, the AI-attribution guard, into the payload at all" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $hook = "$script:target/.claude/hooks/commit-msg"
        Test-Path -LiteralPath $hook | Should -BeTrue -Because 'a guard that ships nowhere protects one machine'
        # Not merely present: present and still refusing what it exists to refuse.
        (Get-Content -LiteralPath $hook -Raw) | Should -Match 'Co-authored-by'
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
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String
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

    It "installs pre-push and identity-patterns.sh alongside pre-commit (issue #64)" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        # A gate that ships in core/claude/hooks/ but is never copied into a project
        # enforces nothing while looking like a control -- issue #64's whole complaint
        # about core/claude/hooks/pre-commit before this installer wired it. Asserting
        # both files land is what would have caught that for pre-push and its shared
        # library too.
        Test-Path "$script:target/.claude/hooks/pre-push" | Should -BeTrue
        Test-Path "$script:target/.claude/hooks/identity-patterns.sh" | Should -BeTrue
    }

    It "installs the pre-push hook with the owner execute bit actually set" -Skip:$IsWindows {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        # git skips a hook without the execute bit and says nothing, same trap
        # pre-commit's own version of this test guards against. pre-push is issue #64's
        # authoritative whole-range identity sweep; a silently-non-executable copy is a
        # gate that looks wired and is not.
        $hook = Get-Item -LiteralPath "$script:target/.claude/hooks/pre-push"
        $hook.UnixMode | Should -Match '^.{3}x'
    }

    It "reports a failed chmod for pre-push too, not only pre-commit" -Skip:$IsWindows {
        # Same shim as pre-commit's version of this test: a `chmod` that always fails,
        # placed first on PATH. Both git-invoked hooks go through the same chmod loop,
        # so both rows must report the failure -- a mutant that only wired the loop for
        # pre-commit would leave pre-push silently non-executable with a clean report.
        $shimDir = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-shim-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $shimDir | Out-Null
        $shim = Join-Path $shimDir 'chmod'
        Set-Content -LiteralPath $shim -Value "#!/bin/sh`nexit 1`n"
        & /bin/chmod +x $shim
        $prevPath = $env:PATH
        $env:PATH = $shimDir + [System.IO.Path]::PathSeparator + $prevPath
        try {
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String
            $out | Should -Match 'chmod:hooks/pre-commit'
            $out | Should -Match 'chmod:hooks/pre-push'
            $out | Should -Match 'hooks/pre-push\s+installed'
        }
        finally {
            $env:PATH = $prevPath
            Remove-Item -Recurse -Force $shimDir
        }
    }

    It "migrates a v1 flat manifest to v2, preserving the recorded hashes under files" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $v2 = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $trackedHash = $v2['files']['agents/task-reviewer.md']
        $trackedHash | Should -Not -BeNullOrEmpty

        # Rewrite the manifest into the v1 shape an already-installed project carries: a flat
        # path-to-hash map plus stackDetected and coreRepo embedded directly, the shape written
        # before this fix moved both into the gitignored sidecar (issue #137).
        $v1 = [ordered]@{}
        foreach ($k in $v2['files'].Keys) { $v1[$k] = $v2['files'][$k] }
        # An entry core no longer ships is what makes this test ablation-proof. Every other
        # hash here would be recomputed to the same value by the install itself, so dropping
        # the whole v1 map would still leave them looking correct. This one cannot be
        # recomputed from anything on disk; it survives only if the migration carried it.
        $v1['agents/retired-agent.md'] = 'DEADBEEF'
        $v1['stackDetected'] = @{ scannedAt = '2020-01-01T00:00:00Z'; plugins = @(); outputStyles = @(); mcpServers = @() }
        $v1['coreRepo'] = 'C:\an\old\absolute\path'
        $v1 | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target

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
        # Neither field ever reaches the committed manifest: no per-machine plugin inventory,
        # no absolute path (issue #137). A plain install always refreshes both in the sidecar
        # from a live scan, which this run is, so the fabricated legacy values above are not
        # expected to survive into it -- this test's job is only to prove they do not leak into
        # $manifestPath.
        $m.Contains('stackDetected') | Should -BeFalse
        $m.Contains('coreRepo') | Should -BeFalse
        $m['files'].Contains('stackDetected') | Should -BeFalse
        $m['files'].Contains('coreRepo') | Should -BeFalse
        $m.Contains('coreCommit') | Should -BeTrue
    }

    It "migrates hand-edited manifest shapes without throwing or dropping recorded hashes" {
        # Three shapes a manifest already installed in the wild can actually be in. The
        # migration has to survive all three, because the alternative is an installer that
        # throws on a file the operator cannot easily reconstruct.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $trackedHash = (Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable)['files']['agents/task-reviewer.md']

        # A v1 map hand-edited down to file hashes alone, with no stackDetected to carry over.
        $flat = [ordered]@{
            'agents/task-reviewer.md'  = $trackedHash
            'agents/retired-agent.md'  = 'DEADBEEF'
        }
        $flat | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } | Should -Not -Throw
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
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } | Should -Not -Throw
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['files'] | Should -Be 'not-a-map'
        $m['files']['agents/retired-agent.md'] | Should -Be 'DEADBEEF'

        # A v2 manifest whose accepted was hand-edited to a scalar. An int has no Contains
        # method at all, which is the shape that actually throws (String and Object[] both
        # answer Contains and would quietly return $false instead).
        $m['accepted'] = 42
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target } | Should -Not -Throw
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
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        'project fork body' | Set-Content "$script:target/.claude/agents/project-only.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/project-only.md' | Out-Null

        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $pin = $m['accepted']['agents/project-only.md']
        $pin | Should -Not -BeNullOrEmpty

        $m.Remove('files')
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target

        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['accepted']['agents/project-only.md'] | Should -Be $pin
        # Folded under files instead, the pin map reads as a single orphaned row named
        # 'accepted' and no key in it is a pin any more, so assert it did not ride along there.
        $after['files'].Contains('accepted') | Should -BeFalse
        # The operator-visible half: a dropped pin does not merely change the manifest, it
        # takes the overlay's row out of the audit table entirely.
        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(accepted\)'
    }

    It "keeps coreCommit out of files when migrating a manifest whose files map is missing, and leaves the sidecar's coreRepo alone" {
        # Same fold-in risk as the pin case, different damage. coreCommit is rewritten from the
        # current checkout, but folded under `files` it becomes a tracked key for a path that
        # was never a file, and the audit then carries a permanent orphaned row for it.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $sidecarPath = "$script:target/.claude/.harness-manifest.local.json"
        $before = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $before['coreCommit'] | Should -Not -BeNullOrEmpty
        $sidecarBefore = Get-Content $sidecarPath -Raw | ConvertFrom-Json -AsHashtable
        $sidecarBefore['coreRepo'] | Should -Not -BeNullOrEmpty

        $before.Remove('files')
        $before | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target

        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('coreCommit') | Should -BeFalse
        # Skipped in the fold, still recorded: the key belongs at top level, not nowhere.
        $after.Contains('coreCommit') | Should -BeTrue
        $after['coreCommit'] | Should -Be $before['coreCommit']
        # coreRepo never sat in this manifest to begin with (post-fix), so migrating it is not
        # this test's concern; the sidecar the migration never touches is.
        $after.Contains('coreRepo') | Should -BeFalse
        $sidecarAfter = Get-Content $sidecarPath -Raw | ConvertFrom-Json -AsHashtable
        $sidecarAfter['coreRepo'] | Should -Be $sidecarBefore['coreRepo']

        # A tracked key with no core source and no file on disk is reported orphaned, so that
        # is the row shape this guards against.
        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Not -Match 'coreCommit\s+orphaned'
    }

    It "-Accept pins an overlay that the audit reports as accepted and leaves out of the attention count" {
        # A plain install is a clean baseline: the two ceremony-gated files report under their
        # own status and stay out of the attention count, so the exclusion assertion below has
        # only the pin to read.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        'project fork body' | Set-Content "$script:target/.claude/agents/project-only.md"

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/project-only.md' *>&1 | Out-String -Width 500
        $out | Should -Match "Accepted overlay 'agents/project-only\.md' pinned at [0-9A-Fa-f]{64}"

        $raw = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw
        $raw | Should -Match '"accepted":\s*\{[^}]*"agents/project-only\.md"'

        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(accepted\)'
        # The pin is worth nothing if the row still counts as drift, so assert the count
        # itself and not just the status string.
        $audit | Should -Match 'All managed files in sync with core\.'
    }

    It "-Accept throws on a file that does not exist" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/no-such-agent.md' } |
            Should -Throw -ExpectedMessage '*file does not exist*'
    }

    It "-Accept throws on a file already tracked in the manifest's files map" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/task-reviewer.md' } |
            Should -Throw -ExpectedMessage '*already tracked*'
    }

    It "-Accept throws on a path that resolves outside the .claude directory" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        # A real file, so the throw under test is the containment check and not the
        # file-does-not-exist guard standing in for it.
        'outside the layer' | Set-Content "$script:target/outside.md"
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $manifestBefore = Get-Content $manifestPath -Raw

        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept '../outside.md' } |
            Should -Throw -ExpectedMessage '*outside the project*'
        # Absolute paths take a separate guard: Join-Path with a rooted second argument does not
        # replace the base, so on Linux '/etc/passwd' would otherwise land back inside the
        # containment check as a contained path and pin a file no install manages.
        $absolute = (Resolve-Path -LiteralPath "$script:target/outside.md").Path
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept $absolute } |
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
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $sidecarPath = "$script:target/.claude/.harness-manifest.local.json"
        $v2 = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable

        $v1 = [ordered]@{}
        foreach ($k in $v2['files'].Keys) { $v1[$k] = $v2['files'][$k] }
        # A synthetic legacy value: stackDetected no longer sits on $v2, since it moved to the
        # sidecar, so this simulates the shape a manifest written before that fix still carries.
        $v1['stackDetected'] = @{ scannedAt = '2020-01-01T00:00:00Z'; plugins = @(); outputStyles = @(); mcpServers = @() }
        $v1 | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        $manifestBefore = Get-Content $manifestPath -Raw
        $sidecarBefore = Get-Content $sidecarPath -Raw

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        # The migration still has to have happened in memory, or the audit reads every tracked
        # file as untracked and the byte compare below passes for the wrong reason.
        $out | Should -Match 'agents/task-reviewer\.md\s+in-sync'

        $raw = Get-Content $manifestPath -Raw
        $raw | Should -Be $manifestBefore
        # Raw JSON, because the v1 shape is what proves nothing was written: a migrated manifest
        # would carry a files map, and this one must still be the flat map that went in.
        $raw | Should -Not -Match '"files":\s*\{'
        $raw | Should -Not -Match '"accepted":'
        # -Audit never persists the sidecar either, migration or not.
        (Get-Content $sidecarPath -Raw) | Should -Be $sidecarBefore
    }

    It "audit reports overlay (changed) once an accepted overlay is edited again" {
        # A plain install leaves the attention count at zero, so the count below is the
        # changed overlay alone.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        'project fork body' | Set-Content "$script:target/.claude/agents/project-only.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/project-only.md' | Out-Null

        'LATER EDIT' | Add-Content "$script:target/.claude/agents/project-only.md"
        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(changed\)'
        $audit | Should -Match '1 file\(s\) need attention'
    }

    It "-Accept re-pins an already-accepted overlay to its current hash" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $overlay = "$script:target/.claude/agents/project-only.md"
        'project fork body' | Set-Content $overlay
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/project-only.md' | Out-Null
        $firstPin = (Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable)['accepted']['agents/project-only.md']

        'REVIEWED AND KEPT' | Add-Content $overlay
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/project-only.md' | Out-Null

        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $secondPin = $m['accepted']['agents/project-only.md']
        $secondPin | Should -Not -Be $firstPin
        $secondPin | Should -Be (Get-FileHash -LiteralPath $overlay -Algorithm SHA256).Hash
        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/project-only\.md\s+overlay \(accepted\)'
    }

    It "names -Accept in the skip warning for an untracked overlay of a file core also ships" {
        # The untracked overlay is the one branch where -Accept is a live option, since -Accept
        # refuses any key tracked in `files`. Built before the first install so the fork never
        # enters that map: a file planted afterwards would be tracked and take a different branch.
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        'project fork of a core agent' | Set-Content "$script:target/.claude/agents/task-reviewer.md"
        # -Width, because Out-String otherwise folds at the host width and can break the
        # flag name across a line boundary where the match would then miss it.
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
        $out | Should -Match "-Accept 'agents/task-reviewer\.md'"
        $out | Should -Match "Skipping 'agents/task-reviewer\.md'"
        # The hint is only worth printing if the command it names runs. Asserting the string
        # alone is what let the old wording ship pointing at a guard that rejects it.
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/task-reviewer.md' } |
            Should -Not -Throw
    }

    It "sends a modified installed file to promotion before -Force, and never to -Accept" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        "PROJECT EDIT" | Add-Content "$script:target/.claude/agents/task-reviewer.md"
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500

        # First, because it is the assertion the old single warning failed: a key tracked in
        # `files` is exactly what -Accept throws on, so naming it here is a dead end.
        $out | Should -Not -Match '-Accept'
        $out | Should -Match "Skipping 'agents/task-reviewer\.md'"
        # Order, not just presence. This text ships into every project that installs the harness,
        # and the first remedy an operator reads must not be the one that overwrites their edit.
        $promoteAt = $out.IndexOf('Promote the change into core')
        $forceAt = $out.IndexOf('-Force')
        $promoteAt | Should -BeGreaterThan -1
        $forceAt | Should -BeGreaterThan $promoteAt
        # The branch's own premise, asserted rather than assumed.
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/task-reviewer.md' } |
            Should -Throw -ExpectedMessage '*already tracked*'
    }

    It "reports an already-pinned overlay as needing no action instead of warning about it" {
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        'project fork of a core agent' | Set-Content "$script:target/.claude/agents/task-reviewer.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/task-reviewer.md' | Out-Null

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
        # The operator already settled this file, so a run that re-offers -Accept or -Force is
        # asking them to decide it a second time.
        $out | Should -Not -Match '-Accept'
        $out | Should -Not -Match '-Force'
        $out | Should -Not -Match 'WARNING'
        $out | Should -Match "Keeping 'agents/task-reviewer\.md'"
        # The pin still holds: no branch of this may end with core's version on disk.
        (Get-Content "$script:target/.claude/agents/task-reviewer.md" -Raw) | Should -Match 'project fork of a core agent'
    }

    It "refuses a malformed target settings.json before copying anything" {
        New-Item -ItemType Directory -Path "$script:target/.claude" -Force | Out-Null
        '{ "hooks": ' | Set-Content "$script:target/.claude/settings.json"

        $err = $null
        try { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target | Out-Null }
        catch { $err = $_ }

        # Placement first, message second. A guard at the settings merge throws just as loudly
        # with every agent, every hook, guardrails.md and the scratch box already copied and no
        # manifest recording any of them, which the next audit reads as untracked top to bottom.
        # A case asserting only the throw passes under that patch too.
        Test-Path "$script:target/.claude/.harness-manifest.json" | Should -BeFalse
        Test-Path "$script:target/.claude/agents/task-reviewer.md" | Should -BeFalse
        Test-Path "$script:target/.claude/guardrails.md" | Should -BeFalse
        # The fixture's own settings.json and nothing else. Counting rather than naming files
        # keeps this from asserting how many files core happens to ship today.
        @(Get-ChildItem -LiteralPath "$script:target/.claude" -Recurse -File).Count | Should -Be 1
        $err | Should -Not -BeNullOrEmpty
        "$err" | Should -Match 'does not parse as JSON'
        # The operator's own file is left byte-for-byte alone, not rewritten into something
        # that parses.
        (Get-Content "$script:target/.claude/settings.json" -Raw) | Should -Match '"hooks":'
    }

    It "-Unaccept drops a pin whose file is already gone, and refuses a key that is not pinned" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $overlay = "$script:target/.claude/agents/project-only.md"
        'project fork body' | Set-Content $overlay
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/project-only.md' | Out-Null

        # A pin outliving its file is the case a straight mirror of -Accept would have blocked:
        # -Accept refuses a path with no file behind it, and un-pinning has to work anyway, since
        # a deleted overlay is one of the two reasons a pin stops being wanted.
        Remove-Item -LiteralPath $overlay
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $sidecarPath = "$script:target/.claude/.harness-manifest.local.json"
        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Unaccept 'agents/project-only.md' *>&1 | Out-String -Width 500

        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['accepted'].Contains('agents/project-only.md') | Should -BeFalse
        # The rest of the manifest survives the rewrite: a drop that rebuilt the file would take
        # the tracked hashes with it. stackDetected never sits here in the first place.
        $m['files'].Contains('agents/task-reviewer.md') | Should -BeTrue
        $m.Contains('stackDetected') | Should -BeFalse
        # The sidecar's own record survives -Unaccept untouched.
        $sidecar = Get-Content $sidecarPath -Raw | ConvertFrom-Json -AsHashtable
        $sidecar.Contains('stackDetected') | Should -BeTrue
        $out | Should -Match "Dropped the accepted-overlay pin on 'agents/project-only\.md'"

        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Unaccept 'agents/project-only.md' } |
            Should -Throw -ExpectedMessage '*not pinned*'
    }

    It "-Unaccept takes a literal manifest key that canonicalization would not reproduce" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        # A pin whose stored key no longer canonicalizes to itself: hand-edited, carried in from
        # another machine, or written by an older installer. Canonicalizing before the lookup
        # turns this into 'agents/project-only.md' and reports a pin sitting in plain sight as
        # absent, leaving it droppable only by hand-editing the file.
        $m['accepted'] = @{ 'agents/retired/../project-only.md' = 'DEADBEEF' }
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Unaccept 'agents/retired/../project-only.md' | Out-Null

        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['accepted'].Contains('agents/retired/../project-only.md') | Should -BeFalse
    }

    It "audit after -Unaccept falls back to not-installed, and the missing hint names both repairs" {
        # Hand-built fork of a file core also ships, planted before the first install so it is
        # never tracked in `files` and -Accept will take it.
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        'project fork of a core agent' | Set-Content "$script:target/.claude/agents/task-reviewer.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/task-reviewer.md' | Out-Null
        Remove-Item "$script:target/.claude/agents/task-reviewer.md"

        $auditPinned = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $auditPinned | Should -Match 'agents/task-reviewer\.md\s+missing'
        # One status, two repairs, and only one of them is a re-run. Told to re-run, an operator
        # with a deleted overlay gets core's version silently standing in for their own file.
        $auditPinned | Should -Match 'missing = re-run the installer if the row is a tracked file'
        $auditPinned | Should -Match 'drop the pin with -Unaccept'

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Unaccept 'agents/task-reviewer.md' | Out-Null
        $auditDropped = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        # Core ships this path, so dropping the pin does not take the row away with it: the key
        # falls back to the class core's own copy earns, which with no file on disk is
        # not-installed. A test asserting the row vanished would be asserting a bug.
        $auditDropped | Should -Match 'agents/task-reviewer\.md\s+not-installed'
    }

    It "keeps an accepted key core never shipped visible in the audit table" {
        # Guards the allKeys union. An accepted overlay core does not ship matches nothing in
        # coreFiles and nothing in files, so a union built from those two alone drops the row
        # entirely: the operator reads the overlay as absent rather than as accepted, which is
        # a worse failure than the noise the pin was meant to remove.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        'local convention notes' | Set-Content "$script:target/.claude/project-overlay.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'project-overlay.md' | Out-Null

        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
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
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String
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

    It "leaves a default install with nothing needing attention, and the gated rows still visible" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null

        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        # First, because it is the whole point: without the ceremony-gated class every default
        # install carries two permanent attention rows that no command clears. A re-run skips
        # those files by design and -Accept refuses a file that does not exist, so the count
        # would never reach zero and the SessionStart hook would print at every session start
        # forever. That is the "rows map to no response" failure CONTRIBUTING.md:51 names.
        $audit | Should -Match 'All managed files in sync with core\.'
        $audit | Should -Not -Match 'file\(s\) need attention'
        # Out of the count, still in the table: absent-and-available is worth seeing, and an
        # assertion that the rows vanished would be asserting a different bug.
        $audit | Should -Match 'agents/soc-monitor\.md\s+not-installed \(ceremony-gated\)'
        $audit | Should -Match 'hooks/wave-close-handoff\.sh\s+not-installed \(ceremony-gated\)'
    }

    It "still counts a ceremony file that was installed and then deleted" {
        # The exclusion must not swallow a real loss. Tracked in `files`, the file is 'missing'
        # rather than gated, and a re-run with -IncludeCeremonies genuinely restores it.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -IncludeCeremonies *>&1 | Out-Null
        Remove-Item "$script:target/.claude/agents/soc-monitor.md"

        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/soc-monitor\.md\s+missing'
        $audit | Should -Match '1 file\(s\) need attention'
    }

    It "-Quiet prints nothing when nothing needs attention" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
        'project fork body' | Set-Content "$script:target/.claude/project-overlay.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'project-overlay.md' | Out-Null

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
        # Nothing at all, not "no table": on a clean run the summary line and the three
        # stack-drift blocks below it all print, so a half-quiet audit would still open every
        # session with that block.
        [string]$out | Should -BeNullOrEmpty
    }

    It "-Quiet prints one tab-separated row per file needing attention and nothing else" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
        "PROJECT EDIT" | Add-Content "$script:target/.claude/agents/task-reviewer.md"

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
        $out | Should -Match 'project-modified\tagents/task-reviewer\.md'
        # Every human-facing line the hook would otherwise have to parse around.
        $out | Should -Not -Match 'file\(s\) need attention'
        $out | Should -Not -Match 'All managed files in sync'
        $out | Should -Not -Match 'never installed here'
        $out | Should -Not -Match 'Plugins detected'
        $out | Should -Not -Match 'drift since last scan'
        $out | Should -Not -Match 'Status'
        # \r? because Out-String renders host lines with the platform's own ending, and a
        # bare \n split leaves a stray \r that reads as a non-empty second line on Windows.
        @($out -split '\r?\n' | Where-Object { $_.Trim() }).Count | Should -Be 1
    }

    It "-Quiet suppresses the no-manifest notice but still reports the rows" {
        New-Item -ItemType Directory -Path "$script:target/.claude/agents" -Force | Out-Null
        Copy-Item "$PSScriptRoot/../core/claude/agents/task-reviewer.md" "$script:target/.claude/agents/"

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
        $out | Should -Not -Match 'No \.harness-manifest\.json'
        $out | Should -Not -Match 'compare the project'
        # The rows still print, or a suppression bug would be indistinguishable from the
        # audit never having run.
        $out | Should -Match 'untracked \(matches core\)\tagents/task-reviewer\.md'
    }

    It "-Quiet without -Audit throws instead of silently doing nothing" {
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Quiet } |
            Should -Throw -ExpectedMessage '*-Quiet applies to -Audit only*'
    }

    It "-<Name> '' throws instead of falling through to a full install" -ForEach @(
        @{ Name = 'Accept' }
        @{ Name = 'Unaccept' }
        @{ Name = 'Prune' }
    ) {
        # All three bind [string], so an explicitly empty argument still satisfies
        # $PSBoundParameters.ContainsKey and reads as "flag not passed" under a plain
        # `if ($Accept)` check -- which falls straight through every one of these standalone
        # commands into a full install, the one thing none of them may compose with.
        $params = @{ Target = $script:target; $Name = '' }
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep @params } |
            Should -Throw -ExpectedMessage "*-$Name requires a non-empty*"
        Test-Path "$script:target/.claude/.harness-manifest.json" | Should -BeFalse
    }

    # bun's absence comes from the stub runner answering 127 for it, not from narrowing PATH, so
    # the case means the same thing on every runner. It used to warn and install anyway; every
    # TypeScript gate is registered as a bare bun command, so a layer installed without bun looked
    # complete while each gate failed open.
    It "refuses when bun is missing, because every TypeScript gate would fail open" {
        $stub = New-DepsStub -Absent 'bun'
        $msg = $null
        try { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsRunner $stub.Runner *>&1 | Out-Null }
        catch { $msg = $_.Exception.Message }
        $msg | Should -Match 'missing hard dependency'
        $msg | Should -Match '\bbun\b'
        $msg | Should -Match 'every TypeScript gate fails open'
        Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
    }

    # -Prune retires a manifest key for a file core no longer ships. Built the same way the
    # existing 'orphaned' audit test above builds one: a hand-edited manifest key with no real
    # core source, since no currently-shipped file can stand in for "core stopped shipping this".
    # This replaces an automatic prune loop that shipped and was reverted after adversarial
    # review executed four defects against it (arbitrary file deletion via an untrusted manifest
    # key, a mid-loop abort that left files gone and the manifest not yet updated, a silently
    # overridden -Accept pin, and a settings.json hook registration left pointing at a deleted
    # file) -- -Prune is the standalone, operator-invoked, one-key-at-a-time replacement.
    It "-Prune drops the manifest record for an orphaned file and leaves the file on disk, even when the hash still matches" {
        # The whole point of removing the delete primitive: an on-disk copy matching the
        # recorded hash used to be exactly the case -Prune deleted outright. It must not any
        # more -- the file survives no matter which of the three orphaned sub-statuses applies.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $orphanPath = "$script:target/.claude/agents/retired-agent.md"
        'retired agent body' | Set-Content $orphanPath
        $orphanHash = (Get-FileHash -LiteralPath $orphanPath -Algorithm SHA256).Hash

        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired-agent.md'] = $orphanHash
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/retired-agent.md' *>&1 |
            Out-String -Width 500
        $out | Should -Match "Dropped the manifest record for 'agents/retired-agent\.md'"
        $out | Should -Not -Match 'deleted the file'

        Test-Path -LiteralPath $orphanPath | Should -BeTrue
        (Get-Content -LiteralPath $orphanPath -Raw) | Should -Match 'retired agent body'
        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('agents/retired-agent.md') | Should -BeFalse
    }

    It "-Prune keeps a modified orphaned file, drops only the manifest record, and -Accept then pins it" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $orphanPath = "$script:target/.claude/agents/retired-agent.md"
        'retired agent body' | Set-Content $orphanPath

        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        # 'DEADBEEF' is not SHA256 hex, so it can never equal the real file's hash -- the same
        # non-recomputable sentinel the migration tests above use, proving the record was left
        # alone rather than happening to match.
        $m['files']['agents/retired-agent.md'] = 'DEADBEEF'
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/retired-agent.md' *>&1 |
            Out-String -Width 500
        $out | Should -Match "Dropped the manifest record for 'agents/retired-agent\.md'"
        $out | Should -Match "-Accept 'agents/retired-agent\.md'"

        (Get-Content $orphanPath -Raw) | Should -Match 'retired agent body'
        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('agents/retired-agent.md') | Should -BeFalse

        # The two-step this unlocks: -Accept refuses any key tracked in `files`, and -Prune just
        # dropped this one from `files`, so -Accept now takes it without a hand-edited manifest.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'agents/retired-agent.md' | Out-Null
        $pinned = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $pinned['accepted']['agents/retired-agent.md'] | Should -Be (Get-FileHash -LiteralPath $orphanPath -Algorithm SHA256).Hash
    }

    It "-Prune drops a stale manifest record when the orphaned file is already gone from disk" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired-agent.md'] = 'DEADBEEF'
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        # No backing file created at all: the "already removed" case, not "unmodified".

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/retired-agent.md' *>&1 |
            Out-String -Width 500
        $out | Should -Match "Pruned manifest record 'agents/retired-agent\.md': already gone from disk"

        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('agents/retired-agent.md') | Should -BeFalse
    }

    It "-Prune refuses a key core still ships, leaving the file and record untouched" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/task-reviewer.md' } |
            Should -Throw -ExpectedMessage '*core still ships this file*'
        Test-Path "$script:target/.claude/agents/task-reviewer.md" | Should -BeTrue
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files'].Contains('agents/task-reviewer.md') | Should -BeTrue
    }

    It "-Prune refuses a ceremony file even when this project never installed it" {
        # Get-CoreFilesMap lists every ceremony file unconditionally (the same map -Audit uses),
        # so a ceremony-gated file this run's switches withheld still reads 'core still ships
        # this' -- the gate holding it back is not core dropping it.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/soc-monitor.md' } |
            Should -Throw -ExpectedMessage '*core still ships this file*'
    }

    It "-Prune refuses ceremony-ledger.json, live state core never shipped a source for" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -IncludeCeremonies
        $ledgerPath = "$script:target/.claude/ceremony-ledger.json"
        Test-Path -LiteralPath $ledgerPath | Should -BeTrue

        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'ceremony-ledger.json' } |
            Should -Throw -ExpectedMessage '*live ceremony state*'
        Test-Path -LiteralPath $ledgerPath | Should -BeTrue
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['files'].Contains('ceremony-ledger.json') | Should -BeTrue
    }

    It "-Prune refuses a key pinned as an accepted overlay, naming -Unaccept" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        'project fork body' | Set-Content "$script:target/.claude/project-overlay.md"
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Accept 'project-overlay.md' | Out-Null

        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'project-overlay.md' } |
            Should -Throw -ExpectedMessage '*-Unaccept*'
        Test-Path "$script:target/.claude/project-overlay.md" | Should -BeTrue
        $m = Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
        $m['accepted'].Contains('project-overlay.md') | Should -BeTrue
    }

    It "-Prune refuses a key that is not tracked in the manifest at all" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/never-existed.md' } |
            Should -Throw -ExpectedMessage '*nothing to prune*'
    }

    It "-Prune drops a manifest key that resolves outside the project's .claude directory, without touching the outside file" {
        # The defect the deleted automatic prune loop shipped with was Join-Path plus Remove-Item
        # on an untrusted manifest key, with no containment check at all. -Prune now contains no
        # Remove-Item anywhere in its path, so an outside-resolving key is harmless by
        # construction rather than by a containment check catching it in time: the worst it can
        # do is drop a manifest record that was already sitting in the manifest, which is exactly
        # what this asserts. (This key also matches literally in manifest['files'], so it takes
        # -Prune's literal-key branch and never reaches Resolve-LayerPath's escape check at all --
        # coherent now that neither branch can reach a file-destroying operation.)
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        'do not delete me' | Set-Content "$script:target/OUTSIDE.txt"
        $outsideHash = (Get-FileHash -LiteralPath "$script:target/OUTSIDE.txt" -Algorithm SHA256).Hash
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['../OUTSIDE.txt'] = $outsideHash
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune '../OUTSIDE.txt' } | Should -Not -Throw
        Test-Path "$script:target/OUTSIDE.txt" | Should -BeTrue
        (Get-Content "$script:target/OUTSIDE.txt" -Raw) | Should -Match 'do not delete me'
        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('../OUTSIDE.txt') | Should -BeFalse
    }

    It "-Prune given the round-1 alias key for the identity gate never deletes the real hook" {
        # The round-1 attack: a manifest key like '../.claude/hooks/pre-commit' carrying the
        # legitimate file's own hash, so the old automatic loop's hash-equality branch matched
        # and deleted the real file through the alias. -Prune no longer has a hash-equality
        # branch or a Remove-Item to reach through one.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $realHookPath = "$script:target/.claude/hooks/pre-commit"
        $realHash = (Get-FileHash -LiteralPath $realHookPath -Algorithm SHA256).Hash

        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['../.claude/hooks/pre-commit'] = $realHash
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune '../.claude/hooks/pre-commit' | Out-Null

        Test-Path -LiteralPath $realHookPath | Should -BeTrue
        (Get-FileHash -LiteralPath $realHookPath -Algorithm SHA256).Hash | Should -Be $realHash
        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('hooks/pre-commit') | Should -BeTrue
        $after['files'].Contains('../.claude/hooks/pre-commit') | Should -BeFalse
    }

    It "-Prune takes a literal manifest key that canonicalization would not reproduce" {
        # Same shape as -Unaccept's own version of this regression: a key that does not
        # canonicalize back to itself. Resolving first would read it as
        # 'agents/retired-agent.md', report the literal key as untracked, and leave it
        # undroppable by any command -- the exact no-repair-path defect -Prune exists to close.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['agents/retired/../retired-agent.md'] = 'DEADBEEF'
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/retired/../retired-agent.md' *>&1 |
            Out-String -Width 500
        $out | Should -Match "Pruned manifest record 'agents/retired/\.\./retired-agent\.md': already gone from disk"

        $after = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $after['files'].Contains('agents/retired/../retired-agent.md') | Should -BeFalse
    }

    It "-Prune drops the record and never touches the file, so a settings.json hook registration for it keeps working" {
        # The warning this test used to check for existed only because the deleted design left a
        # registration pointing at a file that was no longer there. -Prune contains no delete any
        # more, so the registration is still correct once this runs, and there is nothing to warn
        # about -- the finding the warning existed to surface is gone along with the delete.
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $orphanPath = "$script:target/.claude/hooks/retired-hook.ts"
        'retired hook body' | Set-Content $orphanPath
        $orphanHash = (Get-FileHash -LiteralPath $orphanPath -Algorithm SHA256).Hash

        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
        $m['files']['hooks/retired-hook.ts'] = $orphanHash
        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath

        $settingsPath = "$script:target/.claude/settings.json"
        $s = Get-Content $settingsPath -Raw | ConvertFrom-Json
        $s.hooks | Add-Member -NotePropertyName 'CustomTestEvent' -NotePropertyValue @(
            [pscustomobject]@{
                hooks = @([pscustomobject]@{
                    type    = 'command'
                    command = 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/retired-hook.ts"'
                })
            }
        )
        $s | ConvertTo-Json -Depth 20 | Set-Content $settingsPath

        $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'hooks/retired-hook.ts' *>&1 |
            Out-String -Width 500
        $out | Should -Not -Match 'settings\.json still registers'
        $out | Should -Not -Match 'WARNING'
        Test-Path -LiteralPath $orphanPath | Should -BeTrue
        # The registration still names a real file at the path it points to.
        (Get-Content $settingsPath -Raw | ConvertFrom-Json).hooks.CustomTestEvent[0].hooks[0].command |
            Should -Match 'retired-hook\.ts'
    }

    It "audit distinguishes the three orphaned sub-statuses and counts all three as needing attention" {
        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $manifestPath = "$script:target/.claude/.harness-manifest.json"
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable

        'retired agent body' | Set-Content "$script:target/.claude/agents/retired-unmodified.md"
        $m['files']['agents/retired-unmodified.md'] =
            (Get-FileHash -LiteralPath "$script:target/.claude/agents/retired-unmodified.md" -Algorithm SHA256).Hash

        'retired agent body, edited' | Set-Content "$script:target/.claude/agents/retired-modified.md"
        $m['files']['agents/retired-modified.md'] = 'DEADBEEF'

        $m['files']['agents/retired-gone.md'] = 'DEADBEEF'

        $m | ConvertTo-Json -Depth 20 | Set-Content $manifestPath
        $manifestBefore = Get-Content $manifestPath -Raw

        $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
        $audit | Should -Match 'agents/retired-unmodified\.md\s+orphaned \(unmodified\)'
        $audit | Should -Match 'agents/retired-modified\.md\s+orphaned \(modified\)'
        $audit | Should -Match 'agents/retired-gone\.md\s+orphaned \(already removed\)'
        # Every one of the three now has a clearing command (-Prune, or -Prune then -Accept for
        # the modified case), unlike 'not-installed (ceremony-gated)', which no command clears
        # and which is excluded from the count for exactly that reason -- so all three count here
        # rather than being excluded the way that class is.
        $audit | Should -Match '3 file\(s\) need attention'

        # -Audit's own contract: report-only, nothing written.
        (Get-Content $manifestPath -Raw) | Should -Be $manifestBefore
    }

    # Get-CoreFilesMap is shared by -Audit and -Prune. Get-ChildItem on a MISSING core source
    # directory already throws under this script's Stop preference; a directory that EXISTS but
    # lists zero files does not, and answering "core ships zero agents/hooks" from that state
    # read a normally-installed project as 18 'orphaned (unmodified)' rows, with -Prune following
    # -Audit's own printed command through them deleting the identity gate and every other
    # agent/hook, no manifest tampering required. Both directories run under a copied installer +
    # core checkout, because $repoRoot is derived from $PSScriptRoot at the top of the real
    # script and there is no parameter to point it elsewhere.
    It "throws instead of reporting every installed agent as orphaned when core/claude/agents exists but is empty" {
        $fakeRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakerepo-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path (Join-Path $fakeRepo 'install') -Force | Out-Null
        Copy-Item "$PSScriptRoot/Install-Harness.ps1" (Join-Path $fakeRepo 'install/Install-Harness.ps1')
        Copy-Item "$PSScriptRoot/Deps.ps1" (Join-Path $fakeRepo 'install/Deps.ps1')
        Copy-Item -Recurse "$PSScriptRoot/../core" (Join-Path $fakeRepo 'core')
        Get-ChildItem -LiteralPath (Join-Path $fakeRepo 'core/claude/agents') -File | Remove-Item -Force

        try {
            { & (Join-Path $fakeRepo 'install/Install-Harness.ps1') @script:dep -Target $script:target -Audit } |
                Should -Throw -ExpectedMessage '*contains no agent files*'
        }
        finally {
            Remove-Item -Recurse -Force $fakeRepo
        }
    }

    It "throws instead of reporting every installed hook as orphaned when core/claude/hooks exists but is empty" {
        $fakeRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("harness-fakerepo-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path (Join-Path $fakeRepo 'install') -Force | Out-Null
        Copy-Item "$PSScriptRoot/Install-Harness.ps1" (Join-Path $fakeRepo 'install/Install-Harness.ps1')
        Copy-Item "$PSScriptRoot/Deps.ps1" (Join-Path $fakeRepo 'install/Deps.ps1')
        Copy-Item -Recurse "$PSScriptRoot/../core" (Join-Path $fakeRepo 'core')
        Get-ChildItem -LiteralPath (Join-Path $fakeRepo 'core/claude/hooks') -File | Remove-Item -Force

        try {
            { & (Join-Path $fakeRepo 'install/Install-Harness.ps1') @script:dep -Target $script:target -Audit } |
                Should -Throw -ExpectedMessage '*contains no hook files*'
        }
        finally {
            Remove-Item -Recurse -Force $fakeRepo
        }
    }

    # Issue #227. Copilot CLI on Windows runs these command strings through PowerShell, where
    # "$CLAUDE_PROJECT_DIR" inside double quotes is an empty PowerShell variable rather than the env
    # var, so the old strings ran sh on /.claude/hooks/... and failed every session start. The
    # template now hands the expansion to sh. sh is resolved here the way test/posix-sh.ts does it,
    # and a missing sh throws: a skip would pass on exactly the host this case exists for.
    It "runs each SessionStart template command through pwsh -Command and reaches its script" {
        $shCmd = Get-Command sh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $shDir = $null
        if ($shCmd) { $shDir = Split-Path -Parent $shCmd.Source }
        else {
            $execPath = (& git --exec-path 2>$null | Out-String).Trim()
            if ($execPath) {
                $gitRoot = $execPath -replace '[\\/](?:mingw\d*|usr|clang\d*)[\\/]libexec[\\/]git-core[\\/]?$', ''
                $candidate = Join-Path $gitRoot 'usr/bin/sh.exe'
                if (Test-Path -LiteralPath $candidate) { $shDir = Split-Path -Parent $candidate }
            }
        }
        if (-not $shDir) { throw 'no POSIX sh: not on PATH, and none under git --exec-path' }

        # The space is the point: a host that strips the inner double quotes splits this path.
        $projectDir = Join-Path $script:target 'my project'
        $claudeDir = Join-Path $projectDir '.claude'
        New-Item -ItemType Directory -Path (Join-Path $claudeDir 'hooks') -Force | Out-Null
        $expected = @{
            'session-start-guardrails.sh'  = '=== Guardrails'
            'session-start-drift-check.sh' = 'sidecar unavailable'
        }
        foreach ($name in $expected.Keys) {
            Copy-Item "$PSScriptRoot/../core/claude/hooks/$name" (Join-Path $claudeDir "hooks/$name")
        }
        "RULE ONE`nguardrails:session-start-end`n" | Set-Content -NoNewline (Join-Path $claudeDir 'guardrails.md')
        # A committed manifest with no sidecar makes the drift check speak without a core checkout.
        '{}' | Set-Content (Join-Path $claudeDir '.harness-manifest.json')

        $template = (Get-Content "$PSScriptRoot/../core/claude/templates/settings.hooks.json" -Raw | ConvertFrom-Json).hooks
        $commands = @($template.SessionStart | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
        $commands.Count | Should -Be 2

        $pwsh = Join-Path $PSHOME $(if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' })
        $saved = @{
            PATH = $env:PATH; CLAUDE_PROJECT_DIR = $env:CLAUDE_PROJECT_DIR
            CLAUDECODE = $env:CLAUDECODE; COPILOT_CLI = $env:COPILOT_CLI
        }
        try {
            $env:PATH = "$shDir$([System.IO.Path]::PathSeparator)$env:PATH"
            $env:CLAUDE_PROJECT_DIR = $projectDir
            $env:CLAUDECODE = '1'
            $env:COPILOT_CLI = $null
            foreach ($command in $commands) {
                $hookName = @($expected.Keys | Where-Object { $command.Contains("/.claude/hooks/$_") })
                $hookName.Count | Should -Be 1
                $out = & $pwsh -NoProfile -NonInteractive -Command $command 2>&1 | Out-String
                $LASTEXITCODE | Should -Be 0 -Because $out
                $out | Should -Not -Match 'No such file'
                $out | Should -Match ([regex]::Escape($expected[$hookName[0]]))
            }
        }
        finally {
            foreach ($k in $saved.Keys) {
                if ($null -eq $saved[$k]) { Remove-Item -Path "env:$k" -ErrorAction SilentlyContinue }
                else { Set-Item -Path "env:$k" -Value $saved[$k] }
            }
        }
    }

    It "rewrites the legacy SessionStart strings in place, once each, and keeps a project hook beside them" {
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        @'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-guardrails.sh\"" },
          { "type": "command", "command": "echo project-session-hook" },
          { "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-drift-check.sh\"" }
        ]
      }
    ]
  }
}
'@ | Set-Content "$script:target/.claude/settings.json"

        $template = (Get-Content "$PSScriptRoot/../core/claude/templates/settings.hooks.json" -Raw | ConvertFrom-Json).hooks
        $templateCommands = @($template.SessionStart | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
        $newGuardrails = @($templateCommands | Where-Object { $_.Contains('/session-start-guardrails.sh') })[0]
        $newDrift = @($templateCommands | Where-Object { $_.Contains('/session-start-drift-check.sh') })[0]
        $newGuardrails | Should -Not -Be 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-guardrails.sh"'
        $newDrift | Should -Not -Be 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-drift-check.sh"'

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $first = Get-Content "$script:target/.claude/settings.json" -Raw
        $s = $first | ConvertFrom-Json
        @($s.hooks.SessionStart).Count | Should -Be 1
        $commands = @($s.hooks.SessionStart[0].hooks | ForEach-Object { $_.command })
        # In place and in order: the project hook keeps its slot between the two harness hooks.
        $commands | Should -Be @($newGuardrails, 'echo project-session-hook', $newDrift)

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        Get-Content "$script:target/.claude/settings.json" -Raw | Should -Be $first
    }

    It "migrates a legacy SessionStart entry in place when its replacement sits only in a sibling group with a matcher" {
        # The sibling fires only on startup. Dropping the matcherless group's legacy entry because
        # the replacement exists elsewhere in the event would stop the script running on resume.
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        $template = (Get-Content "$PSScriptRoot/../core/claude/templates/settings.hooks.json" -Raw | ConvertFrom-Json).hooks
        $templateCommands = @($template.SessionStart | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
        $newGuardrails = @($templateCommands | Where-Object { $_.Contains('/session-start-guardrails.sh') })[0]
        $settings = [ordered]@{
            hooks = [ordered]@{
                SessionStart = @(
                    [ordered]@{ matcher = 'startup'; hooks = @(@{ type = 'command'; command = $newGuardrails }) },
                    [ordered]@{ hooks = @(@{ type = 'command'; command = 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-guardrails.sh"' }) }
                )
            }
        }
        $settings | ConvertTo-Json -Depth 10 | Set-Content "$script:target/.claude/settings.json"

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target
        $s = Get-Content "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json
        $matcherless = @($s.hooks.SessionStart | Where-Object { -not $_.PSObject.Properties['matcher'] })
        $matcherless.Count | Should -Be 1
        @($matcherless[0].hooks | ForEach-Object { $_.command }) | Should -Contain $newGuardrails
        $startup = @($s.hooks.SessionStart | Where-Object { $_.PSObject.Properties['matcher'] -and $_.matcher -ceq 'startup' })
        $startup.Count | Should -Be 1
        @($startup[0].hooks | ForEach-Object { $_.command }) | Should -Be @($newGuardrails)
    }

    It "rewrites the legacy wave-close string in place, exactly once, on a ceremony install" {
        # Copilot's shell tool fires the Bash matcher, and under PowerShell the legacy string ran sh
        # on /.claude/hooks/wave-close-handoff.sh on every shell call (verified live, #227).
        $legacyWave = 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/wave-close-handoff.sh"'
        New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
        $settings = [ordered]@{
            hooks = [ordered]@{
                PostToolUse = @(
                    [ordered]@{
                        matcher = 'Bash'
                        hooks   = @(
                            [ordered]@{ type = 'command'; command = 'echo project-bash-hook' },
                            [ordered]@{ type = 'command'; command = $legacyWave }
                        )
                    }
                )
            }
        }
        $settings | ConvertTo-Json -Depth 10 | Set-Content "$script:target/.claude/settings.json"

        $template = (Get-Content "$PSScriptRoot/../core/claude/templates/settings.hooks.json" -Raw | ConvertFrom-Json).hooks
        $newWave = @($template.PostToolUse | ForEach-Object { $_.hooks } | ForEach-Object { $_.command } |
            Where-Object { $_.Contains('/wave-close-handoff.sh') })
        $newWave.Count | Should -Be 1
        $newWave[0] | Should -Not -Be $legacyWave

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -IncludeCeremonies
        $first = Get-Content "$script:target/.claude/settings.json" -Raw
        $s = $first | ConvertFrom-Json
        $all = @($s.hooks.PostToolUse | ForEach-Object { @($_.hooks) } | ForEach-Object { $_.command })
        @($all | Where-Object { $_ -ceq $newWave[0] }).Count | Should -Be 1
        @($all | Where-Object { $_ -ceq $legacyWave }).Count | Should -Be 0
        $bash = @($s.hooks.PostToolUse | Where-Object { $_.PSObject.Properties['matcher'] -and $_.matcher -ceq 'Bash' })
        $bash.Count | Should -Be 1
        # In place: the project hook keeps its slot ahead of the harness hook.
        @($bash[0].hooks | ForEach-Object { $_.command }) | Should -Be @('echo project-bash-hook', $newWave[0])

        & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -IncludeCeremonies
        Get-Content "$script:target/.claude/settings.json" -Raw | Should -Be $first
    }

    Context 'layers and settings' {
        BeforeAll {
            function Read-TestManifest {
                param([string]$Root)
                Get-Content -LiteralPath "$Root/.claude/.harness-manifest.json" -Raw | ConvertFrom-Json -AsHashtable
            }
            function Write-TestManifest {
                param([string]$Root, $Manifest)
                $Manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath "$Root/.claude/.harness-manifest.json"
            }
        }

        It "records schemaVersion 3 and layers code on a fresh install and installs the code rules" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            Test-Path "$script:target/.claude/rules/harness/change-management-code.md" -PathType Leaf | Should -BeTrue
            Test-Path "$script:target/.claude/rules/harness/fix-quality.md" -PathType Leaf | Should -BeTrue
            $m = Read-TestManifest $script:target
            $m['schemaVersion'] | Should -Be 3
            @($m['layers']) | Should -Be @('code')
            # A one-element array unrolled to a scalar serialises as a string and fails the next load.
            Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | Should -Match '"layers":\s*\[\s*"code"\s*\]'
            $m['files'].Contains('rules/harness/fix-quality.md') | Should -BeTrue
            $m['files'].Contains('rules/harness/project-settings.md') | Should -BeFalse
            $m['settings']['statusCadence'] | Should -Be 'silent'
            $m['settings']['audience'] | Should -Be 'peer-engineer'
            $m['settings'].Contains('lengthBudgetDefault') | Should -BeTrue
            $m['settings']['lengthBudgetDefault'] | Should -BeNullOrEmpty
            $text = Get-Content "$script:target/.claude/rules/harness/project-settings.md" -Raw
            $text | Should -Match 'Status cadence, `silent`'
            $text | Should -Match 'Layers: kernel \(always on\), code\.'
            $text | Should -Not -Match '\{\{'
            $text.Contains("`r") | Should -BeFalse
        }

        It "a comma list binds from a spawned shell" {
            # A spawned shell cannot take a scriptblock runner, so this one reads a fixture whose
            # only entry probes pwsh, which is on PATH wherever this suite runs.
            $pwshOnly = New-DepsFixture -Deps @([ordered]@{
                    name = 'pwsh'; severity = @{ kernel = 'optional' }; minVersion = '7.0.0'
                    failMode = 'Without pwsh, nothing in this fixture runs.'; probe = @('pwsh', '--version')
                })
            & pwsh -NoProfile -File "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Layers 'code,documents' -DepsManifestPath $pwshOnly *>&1 | Out-Null
            $LASTEXITCODE | Should -Be 0
            @((Read-TestManifest $script:target)['layers']) | Should -Be @('code', 'documents')
        }

        It "migrates a v2 manifest with no layers key as the code layer" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            foreach ($k in 'schemaVersion', 'layers', 'settings') { $m.Remove($k) }
            foreach ($f in 'change-management-code.md', 'fix-quality.md') {
                $m['files'].Remove("rules/harness/$f")
                Remove-Item -LiteralPath "$script:target/.claude/rules/harness/$f"
            }
            Write-TestManifest $script:target $m

            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            $m['schemaVersion'] | Should -Be 3
            @($m['layers']) | Should -Be @('code')
            Test-Path "$script:target/.claude/rules/harness/change-management-code.md" -PathType Leaf | Should -BeTrue
            Test-Path "$script:target/.claude/rules/harness/fix-quality.md" -PathType Leaf | Should -BeTrue
            # The v2 fields ride through untouched.
            $m['files'].Contains('agents/task-reviewer.md') | Should -BeTrue
            $m.Contains('accepted') | Should -BeTrue
        }

        It "-Layers documents installs no code rules and derives heartbeat and plain-all-roles" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers documents *>&1 | Out-Null
            Test-Path "$script:target/.claude/rules/harness/fix-quality.md" | Should -BeFalse
            Test-Path "$script:target/.claude/rules/harness/change-management-code.md" | Should -BeFalse
            $m = Read-TestManifest $script:target
            @($m['layers']) | Should -Be @('documents')
            $m['settings']['statusCadence'] | Should -Be 'heartbeat'
            $m['settings']['audience'] | Should -Be 'plain-all-roles'
            Get-Content "$script:target/.claude/rules/harness/project-settings.md" -Raw | Should -Match 'Audience, `plain-all-roles`'
        }

        It "-Layers none records an empty list and installs no layer rules" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers none *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            $m.Contains('layers') | Should -BeTrue
            @($m['layers']).Count | Should -Be 0
            Get-Content "$script:target/.claude/.harness-manifest.json" -Raw | Should -Match '"layers":\s*\[\s*\]'
            @(Get-ChildItem -LiteralPath "$script:target/.claude/rules/harness" -Force | ForEach-Object { $_.Name }) |
                Should -Be @('project-settings.md')
            Get-Content "$script:target/.claude/rules/harness/project-settings.md" -Raw | Should -Match 'no project layers'
        }

        It "an empty layer list survives a re-run with no flags" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers none *>&1 | Out-Null
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            $m.Contains('layers') | Should -BeTrue
            @($m['layers']).Count | Should -Be 0
            Test-Path "$script:target/.claude/rules/harness/fix-quality.md" | Should -BeFalse
        }

        It "rejects none combined with a layer, kernel, and an unknown name" {
            foreach ($bad in @(@('none', 'code'), @('kernel'), @('prose'), @('none,code'))) {
                { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers $bad *>&1 | Out-Null } |
                    Should -Throw -ExpectedMessage '*code, documents, physical, or none*'
            }
            Test-Path "$script:target/.claude" | Should -BeFalse
        }

        It "keeps recorded settings when -Layers changes and sets them when a flag is given" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers code *>&1 | Out-Null
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers code, documents *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            @($m['layers']) | Should -Be @('code', 'documents')
            $m['settings']['statusCadence'] | Should -Be 'silent'
            $m['settings']['audience'] | Should -Be 'peer-engineer'

            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -StatusCadence heartbeat -LengthBudget 1200 *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            @($m['layers']) | Should -Be @('code', 'documents')
            $m['settings']['statusCadence'] | Should -Be 'heartbeat'
            $m['settings']['lengthBudgetDefault'] | Should -Be 1200
            $text = Get-Content "$script:target/.claude/rules/harness/project-settings.md" -Raw
            $text | Should -Match '1200 words or fewer'
            $text | Should -Not -Match '\{\{WORDS\}\}'

            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -LengthBudget 0 *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            $m['settings'].Contains('lengthBudgetDefault') | Should -BeTrue
            $m['settings']['lengthBudgetDefault'] | Should -BeNullOrEmpty
            $m['settings']['statusCadence'] | Should -Be 'heartbeat'
            Get-Content "$script:target/.claude/rules/harness/project-settings.md" -Raw | Should -Match 'No default length budget'
        }

        It "a dropped layer's rule file is left in place, warned about, and counted by the audit" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers code *>&1 | Out-Null
            $rule = "$script:target/.claude/rules/harness/fix-quality.md"
            "PROJECT EDIT" | Add-Content -LiteralPath $rule

            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers documents *>&1 | Out-String -Width 500
            Test-Path -LiteralPath $rule -PathType Leaf | Should -BeTrue
            Get-Content -LiteralPath $rule -Raw | Should -Match 'PROJECT EDIT'
            $out | Should -Match 'layer not selected'
            $out | Should -Match "'rules/harness/fix-quality\.md' belongs to a layer this project no longer records"

            $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
            $audit | Should -Match "installed \(layer not selected\)`trules/harness/fix-quality\.md"

            Remove-Item -LiteralPath $rule
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            $out | Should -Match 'record-dropped \(layer not selected\)'
            $m = Read-TestManifest $script:target
            $m['files'].Contains('rules/harness/fix-quality.md') | Should -BeFalse
            # The unmodified sibling is still on disk, so its record stays.
            $m['files'].Contains('rules/harness/change-management-code.md') | Should -BeTrue
        }

        It "an invalid recorded layers value fails before any write and is reported under -Quiet" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $manifestFile = "$script:target/.claude/.harness-manifest.json"
            $settingsFile = "$script:target/.claude/settings.json"
            foreach ($bad in @('code', @('kernel'), @('prose'))) {
                $m = Read-TestManifest $script:target
                $m['layers'] = $bad
                Write-TestManifest $script:target $m
                $before = @((Get-FileHash $manifestFile).Hash, (Get-FileHash $settingsFile).Hash)

                { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null } |
                    Should -Throw -ExpectedMessage '*layers*'
                @((Get-FileHash $manifestFile).Hash, (Get-FileHash $settingsFile).Hash) | Should -Be $before

                $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
                $audit | Should -Match "manifest-invalid`t\.harness-manifest\.json"
                @($audit -split '\r?\n' | Where-Object { $_.Trim() }).Count | Should -Be 1
                $loud = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
                $loud | Should -Match 'manifest-invalid = fix the layers or settings value the error names'
                @((Get-FileHash $manifestFile).Hash, (Get-FileHash $settingsFile).Hash) | Should -Be $before
            }
        }

        It "an invalid recorded settings value fails before any write" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $m = Read-TestManifest $script:target
            $m['settings']['audience'] = 'everyone'
            Write-TestManifest $script:target $m
            $before = (Get-FileHash "$script:target/.claude/.harness-manifest.json").Hash
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*peer-engineer*plain-all-roles*'
            (Get-FileHash "$script:target/.claude/.harness-manifest.json").Hash | Should -Be $before
        }

        It "a hand-written rule file at the install path is kept and reported" {
            New-Item -ItemType Directory -Path "$script:target/.claude/rules/harness" -Force | Out-Null
            $rule = "$script:target/.claude/rules/harness/fix-quality.md"
            'project rule' | Set-Content -LiteralPath $rule
            $before = (Get-FileHash -LiteralPath $rule).Hash
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            (Get-FileHash -LiteralPath $rule).Hash | Should -Be $before
            $out | Should -Match "Skipping 'rules/harness/fix-quality\.md'"
        }

        It "audit reports settings-modified after a hand edit and settings-stale after a manifest change, ignores CRLF, and writes nothing" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $settingsMd = "$script:target/.claude/rules/harness/project-settings.md"
            $manifestFile = "$script:target/.claude/.harness-manifest.json"

            $lf = [System.IO.File]::ReadAllText($settingsMd)
            [System.IO.File]::WriteAllText($settingsMd, $lf.Replace("`r`n", "`n").Replace("`n", "`r`n"))
            [System.IO.File]::ReadAllText($settingsMd).Contains("`r`n") | Should -BeTrue
            $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
            $audit | Should -Not -Match 'settings-(stale|modified)'
            $audit | Should -Match 'All managed files in sync with core\.'

            # A valid marker over a body the manifest no longer renders: stale, and a re-run fixes it.
            $m = Read-TestManifest $script:target
            $m['settings']['statusCadence'] = 'heartbeat'
            Write-TestManifest $script:target $m
            $before = (Get-FileHash $manifestFile).Hash
            $quiet = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
            $quiet | Should -Match "settings-stale`trules/harness/project-settings\.md"
            $quiet | Should -Not -Match 'settings-modified'

            'hand edit' | Add-Content -LiteralPath $settingsMd
            $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
            $audit | Should -Match 'rules/harness/project-settings\.md\s+settings-modified'
            $quiet = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
            $quiet | Should -Match "settings-modified`trules/harness/project-settings\.md"

            Remove-Item -LiteralPath $settingsMd
            $quiet = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
            $quiet | Should -Match "settings-missing`trules/harness/project-settings\.md"
            Test-Path -LiteralPath $settingsMd | Should -BeFalse
            (Get-FileHash $manifestFile).Hash | Should -Be $before
        }

        It "writes an absent settings file and regenerates an unmodified one, behind a hash marker" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $settingsMd = "$script:target/.claude/rules/harness/project-settings.md"
            $first = [System.IO.File]::ReadAllText($settingsMd)
            $first | Should -Match '\A<!-- harness-generated sha256:[0-9a-f]{64} -->\n# Project settings\n'

            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -StatusCadence heartbeat *>&1 | Out-Null
            $second = [System.IO.File]::ReadAllText($settingsMd)
            $second | Should -Match 'Status cadence, `heartbeat`'
            $second | Should -Not -Be $first

            Remove-Item -LiteralPath $settingsMd
            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            [System.IO.File]::ReadAllText($settingsMd) | Should -Be $second
            $out | Should -Not -Match 'kept \(modified\)'
        }

        It "keeps a hand-edited settings file with a warning, and -Force replaces it" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            $settingsMd = "$script:target/.claude/rules/harness/project-settings.md"
            'PROJECT EDIT' | Add-Content -LiteralPath $settingsMd
            $before = (Get-FileHash -LiteralPath $settingsMd).Hash

            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -StatusCadence heartbeat *>&1 | Out-String -Width 500
            (Get-FileHash -LiteralPath $settingsMd).Hash | Should -Be $before
            $out | Should -Match 'kept \(modified\)'
            $out | Should -Match "Keeping 'rules/harness/project-settings\.md'"
            # The manifest still records the flag, so the edit and the record now disagree, which
            # is what the audit row is for.
            (Read-TestManifest $script:target)['settings']['statusCadence'] | Should -Be 'heartbeat'

            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Force *>&1 | Out-Null
            $text = [System.IO.File]::ReadAllText($settingsMd)
            $text | Should -Not -Match 'PROJECT EDIT'
            $text | Should -Match 'Status cadence, `heartbeat`'
        }

        It "keeps a pre-existing settings file the installer never wrote" {
            New-Item -ItemType Directory -Path "$script:target/.claude/rules/harness" -Force | Out-Null
            $settingsMd = "$script:target/.claude/rules/harness/project-settings.md"
            'project-owned settings' | Set-Content -LiteralPath $settingsMd
            $before = (Get-FileHash -LiteralPath $settingsMd).Hash

            $out = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-String -Width 500
            (Get-FileHash -LiteralPath $settingsMd).Hash | Should -Be $before
            $out | Should -Match 'kept \(modified\)'
            $quiet = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Quiet *>&1 | Out-String -Width 500
            $quiet | Should -Match "settings-modified`trules/harness/project-settings\.md"
        }

        It "audit leaves rules of unselected layers uncounted" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Layers documents *>&1 | Out-Null
            $audit = & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit *>&1 | Out-String -Width 500
            $audit | Should -Match 'rules/harness/fix-quality\.md\s+not-installed \(layer not selected\)'
            $audit | Should -Match 'All managed files in sync with core\.'
        }

        It "the layer and settings flags are refused with -Audit" {
            & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -Layers code } |
                Should -Throw -ExpectedMessage '*applies to an install run only*'
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -StatusCadence silent } |
                Should -Throw -ExpectedMessage '*applies to an install run only*'
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Prune 'agents/x.md' -LengthBudget 10 } |
                Should -Throw -ExpectedMessage '*applies to an install run only*'
        }

        It "each settings ValidateSet matches layers.json" {
            $params = (Get-Command "$PSScriptRoot/Install-Harness.ps1").Parameters
            $registry = Get-Content "$PSScriptRoot/../core/claude/rules/layers.json" -Raw | ConvertFrom-Json -AsHashtable
            foreach ($pair in @(@('StatusCadence', 'statusCadence'), @('Audience', 'audience'))) {
                $set = @($params[$pair[0]].Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] })
                $set.Count | Should -Be 1
                @($set[0].ValidValues | Sort-Object) | Should -Be @($registry['settings'][$pair[1]].Keys | Sort-Object)
            }
        }
    }

    Context 'dependencies' {
        BeforeAll {
            . "$PSScriptRoot/Deps.ps1"
            $script:shippedDeps = "$PSScriptRoot/../core/claude/deps.json"
        }

        It "a missing hard dependency refuses before any write and prints the pinned command" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } }
            $msg = $null
            try { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match '^missing hard dependency'
            $msg.Contains((Get-FakeCommandText)) | Should -BeTrue
            Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
            @(Get-DepsInstallCalls $rec).Count | Should -Be 0
            # Positive control: the probe itself ran, so the empty install list is not vacuous.
            @($rec.Calls | Where-Object { $_.Argv[0] -eq 'harness-fake-hard' }).Count | Should -Be 1
        }

        It "a missing optional dependency warns, installs nothing, and the install completes" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep -Name 'harness-fake-opt' -Severity @{ kernel = 'optional' } -Winget 'Example.FakeOpt' -Apt 'fake-opt')
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-opt') { @{ ExitCode = 127 } } }
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-String -Width 500
            $out | Should -Match 'missing optional dependency harness-fake-opt'
            $out.Contains((Get-FakeCommandText -Winget 'Example.FakeOpt' -Apt 'fake-opt')) | Should -BeTrue
            Test-Path -LiteralPath "$script:target/.claude/.harness-manifest.json" | Should -BeTrue
            @(Get-DepsInstallCalls $rec).Count | Should -Be 0
        }

        It "a probe that exits non-zero is absent even when its output carries a version" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 1; Output = 'harness-fake-hard 1.2.3' } } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage 'missing hard dependency*'
            Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
        }

        It "a probe that times out is absent" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            # Exit 0 with a version on purpose: TimedOut alone has to make it absent, not the 124
            # the real runner pairs it with, which the exit-code check would catch on its own.
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 0; Output = 'harness-fake-hard 1.2.3'; TimedOut = $true } } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage 'missing hard dependency*'
        }

        It "one entry per tool, strictest severity wins" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep -Severity @{ kernel = 'optional'; code = 'hard' })
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Layers code -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage 'missing hard dependency*'
            @($rec.Calls | Where-Object { $_.Argv[0] -eq 'harness-fake-hard' }).Count | Should -Be 1

            $rec2 = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } }
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Layers none -DepsManifestPath $fixture -DepsRunner $rec2.Runner *>&1 | Out-String -Width 500
            $out | Should -Match 'missing optional dependency harness-fake-hard'

            $probes = [System.Collections.Generic.List[int]]::new()
            $rec3 = New-DepsRecorder -Answer {
                param($argv)
                if ($argv[0] -eq 'harness-fake-hard') {
                    $probes.Add(1)
                    if ($probes.Count -eq 1) { return @{ ExitCode = 127 } }
                    return @{ ExitCode = 0; Output = 'harness-fake-hard 1.2.3' }
                }
            }.GetNewClosure()
            $target2 = "$($script:target)-strict"
            New-Item -ItemType Directory -Path $target2 | Out-Null
            try {
                & "$PSScriptRoot/Install-Harness.ps1" -Target $target2 -Layers code -InstallDeps -DepsManifestPath $fixture -DepsRunner $rec3.Runner *>&1 | Out-Null
                @(Get-DepsInstallCalls $rec3).Count | Should -Be 1
            }
            finally { Remove-Item -Recurse -Force $target2 -ErrorAction SilentlyContinue }
        }

        It "-InstallDeps -WhatIf runs nothing" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } }
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -WhatIf -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-String -Width 500
            @(Get-DepsInstallCalls $rec).Count | Should -Be 0
            Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
            $out.Contains("WhatIf: would run $(Get-FakeCommandText)") | Should -BeTrue
            $out | Should -Match 'WhatIf: stopped before writing'
        }

        It "-Audit -InstallDeps is refused with a message" {
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target -Audit -InstallDeps } |
                Should -Throw -ExpectedMessage '*applies to an install run only*'
        }

        It "Git Bash resolves from Git for Windows: the bash under the Git root is probed by absolute path" {
            $tmp = Join-Path $script:depsStubRoot ("gitroot-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cmd'), (Join-Path $tmp 'usr/bin') -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $tmp 'cmd/git.exe') -Value 'stub'
            Set-Content -LiteralPath (Join-Path $tmp 'usr/bin/bash.exe') -Value 'stub'
            $bashPath = [System.IO.Path]::GetFullPath((Join-Path $tmp 'usr/bin/bash.exe'))
            $rec = New-DepsRecorder -Answer {
                param($argv)
                if ($argv[0] -eq 'git') { return @{ ExitCode = 1 } }
                if ($argv[0] -eq $bashPath) { return @{ ExitCode = 0; Output = 'GNU bash, version 5.2.21(1)-release' } }
                return @{ ExitCode = 127 }
            }.GetNewClosure()
            $gitBash = @((Get-DepsManifest -Path $script:shippedDeps)['deps'] | Where-Object { $_['name'] -eq 'git-bash' })[0]
            $r = Test-Dep -Dep $gitBash -Runner $rec.Runner -GitExe (Join-Path $tmp 'cmd/git.exe') -IsWindows $true
            $r.Present | Should -BeTrue
            $probe = @($rec.Calls | Where-Object { $_.Argv[0] -ne 'git' })
            $probe.Count | Should -Be 1
            $probe[0].Argv[0] | Should -Be $bashPath
            $probe[0].Argv[1] | Should -Be '--version'
        }

        It "Git Bash resolves from Git for Windows: a PATH bash is never probed" {
            $rec = New-DepsRecorder -Answer {
                param($argv)
                if ($argv[0] -eq 'git') { return @{ ExitCode = 1 } }
                if (@('bash', 'bash.exe') -contains (Split-Path -Leaf $argv[0])) { return @{ ExitCode = 0; Output = 'GNU bash, version 5.2.21(1)-release' } }
                return @{ ExitCode = 127 }
            }
            $gitBash = @((Get-DepsManifest -Path $script:shippedDeps)['deps'] | Where-Object { $_['name'] -eq 'git-bash' })[0]
            $r = Test-Dep -Dep $gitBash -Runner $rec.Runner -GitExe $null -IsWindows $true
            $r.Present | Should -BeFalse
            @($rec.Calls | Where-Object { $_.Argv[0] -eq 'bash' -or $_.Argv[0] -match '[\\/]System32[\\/]' }).Count | Should -Be 0
        }

        It "the default runner returns 127 for a command that is not on PATH, without throwing" {
            $r = Invoke-DefaultDepsRunner @("harness-absent-$([guid]::NewGuid())") 10
            $r.ExitCode | Should -Be 127
            $r.TimedOut | Should -BeFalse
        }

        It "the default runner kills a process that outlives its limit" {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $r = Invoke-DefaultDepsRunner @('pwsh', '-NoProfile', '-Command', 'Start-Sleep 30') 2
            $sw.Elapsed.TotalSeconds | Should -BeLessThan 6
            $r.TimedOut | Should -BeTrue
            $r.ExitCode | Should -Be 124
        }

        It "the default runner closes stdin" {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $r = Invoke-DefaultDepsRunner @('pwsh', '-NoProfile', '-Command', '[Console]::In.ReadToEnd() | Out-Null; exit 0') 10
            $r.TimedOut | Should -BeFalse
            $r.ExitCode | Should -Be 0
            $sw.Elapsed.TotalSeconds | Should -BeLessThan 10
        }

        It "-InstallDeps runs the pinned command, re-probes, and proceeds" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            $probes = [System.Collections.Generic.List[int]]::new()
            $rec = New-DepsRecorder -Answer {
                param($argv)
                if ($argv[0] -eq 'harness-fake-hard') {
                    $probes.Add(1)
                    if ($probes.Count -eq 1) { return @{ ExitCode = 127 } }
                    return @{ ExitCode = 0; Output = 'harness-fake-hard 1.2.3' }
                }
                return @{ ExitCode = 0; Output = '' }
            }.GetNewClosure()
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null
            $calls = @($rec.Calls)
            $calls.Count | Should -Be 3
            $calls[0].Argv[0] | Should -Be 'harness-fake-hard'
            (@($calls[1].Argv) -join ' ').StartsWith((Get-FakeCommandText)) | Should -BeTrue
            $calls[1].Timeout | Should -Be 900
            $calls[2].Argv[0] | Should -Be 'harness-fake-hard'
            $calls[0].Timeout | Should -Be 10
            Test-Path -LiteralPath "$script:target/.claude/.harness-manifest.json" | Should -BeTrue
        }

        It "-InstallDeps refuses when the re-probe still fails" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } else { @{ ExitCode = 0; Output = '' } } }
            $msg = $null
            try { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match '^missing hard dependency'
            $msg | Should -Match 'harness-fake-hard'
            $msg | Should -Match 'did not verify'
            Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
        }

        It "a version below minVersion counts as missing" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 0; Output = 'harness-fake-hard 1.1.9' } } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*below minVersion 1.2.0*'
        }

        It "a hard dependency with no pinned install for this platform refuses with install-by-hand guidance" {
            $dep = New-FakeDep
            $other = if ($script:hostWin) { 'linux' } else { 'windows' }
            $dep['install'] = [ordered]@{ $other = $dep['install'][$other] }
            $fixture = New-DepsFixture -Deps @($dep)
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } }
            $plat = if ($script:hostWin) { 'windows' } else { 'linux' }
            $msg = $null
            try { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match '^missing hard dependency'
            $msg.Contains("no pinned install for ${plat}: install harness-fake-hard 1.2.0 or later from a pinned release, then re-run") | Should -BeTrue
            @(Get-DepsInstallCalls $rec).Count | Should -Be 0
        }

        It "a missing prerequisite is named first, and -InstallDeps installs it before the tool" {
            # Unit level, with a Linux target, because `needs` applies to npm installs and the
            # Windows install grammar has no npm form.
            $prereq = [ordered]@{
                name = 'harness-fake-npm'; severity = @{ kernel = 'optional' }; minVersion = '1.2.0'
                failMode = 'Without harness-fake-npm, nothing installs.'; probe = @('harness-fake-npm', '--version')
                install = [ordered]@{ linux = [ordered]@{ apt = 'fake-npm'; version = '1.2.3' } }
            }
            $tool = [ordered]@{
                name = 'harness-fake-tool'; severity = @{ kernel = 'hard' }; needs = @('harness-fake-npm'); minVersion = '1.2.0'
                failMode = 'Without harness-fake-tool, the fake gate fails open.'; probe = @('harness-fake-tool', '--version')
                install = [ordered]@{ linux = [ordered]@{ npm = 'fake-tool'; version = '1.2.3' } }
            }
            $m = Get-DepsManifest -Path (New-DepsFixture -Deps @($prereq, $tool))
            $absent = { param($argv) if ($argv[0] -like 'harness-fake-*') { @{ ExitCode = 127 } } }
            $rec = New-DepsRecorder -Answer $absent
            $msg = $null
            try { Invoke-DepsPreflight -Manifest $m -Layers @('kernel') -IsWindows $false -InstallDeps $false -Runner $rec.Runner -ShouldInstall { $true } 3>$null }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match '^missing hard dependency'
            $aptAt = $msg.IndexOf('sudo apt-get install -y fake-npm=1.2.3')
            $npmAt = $msg.IndexOf('npm install -g fake-tool@1.2.3')
            $aptAt | Should -BeGreaterThan -1
            $npmAt | Should -BeGreaterThan $aptAt

            $installed = [System.Collections.Generic.List[string]]::new()
            $rec2 = New-DepsRecorder -Answer {
                param($argv)
                $line = @($argv) -join ' '
                if ($line -match 'fake-npm=1\.2\.3') { $installed.Add('harness-fake-npm'); return @{ ExitCode = 0 } }
                if ($line -match 'fake-tool@1\.2\.3') { $installed.Add('harness-fake-tool'); return @{ ExitCode = 0 } }
                if ($argv[0] -like 'harness-fake-*') {
                    if ($installed -contains $argv[0]) { return @{ ExitCode = 0; Output = "$($argv[0]) 1.2.3" } }
                    return @{ ExitCode = 127 }
                }
            }.GetNewClosure()
            { Invoke-DepsPreflight -Manifest $m -Layers @('kernel') -IsWindows $false -InstallDeps $true -Runner $rec2.Runner -ShouldInstall { $true } 3>$null } |
                Should -Not -Throw
            @($installed) | Should -Be @('harness-fake-npm', 'harness-fake-tool')
        }

        It "the dependency preflight is skipped by -Audit" {
            $fixture = New-DepsFixture -Deps @(New-FakeDep)
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -DepsManifestPath $fixture -DepsRunner $rec.Runner *>&1 | Out-Null } |
                Should -Not -Throw
            @($rec.Calls | Where-Object { $_.Argv[0] -eq 'harness-fake-hard' }).Count | Should -Be 0
        }

        It "the shipped deps.json validates" {
            $m = Get-DepsManifest -Path $script:shippedDeps
            $tools = @($m['deps'] | Where-Object { -not $_.Contains('kind') })
            $byName = @{}
            foreach ($e in $tools) { $byName[$e['name']] = $e }
            $byName['bun']['severity']['kernel'] | Should -Be 'hard'
            $byName['git-bash']['severity']['kernel'] | Should -Be 'hard'
            @($byName['git-bash']['platforms']) | Should -Be @('windows')
            $byName['git-bash']['resolve'] | Should -Be 'git-bash'
            $byName['bun']['install']['linux'].Contains('npm') | Should -BeTrue
            @($byName['bun']['needs']) | Should -Be @('npm')
            @($tools | Where-Object { $_['name'] -eq 'git' }).Count | Should -Be 1
            $gitSev = $byName['git']['severity']
            @($gitSev.Keys | Sort-Object) | Should -Be @('code', 'kernel')
            $gitSev['kernel'] | Should -Be 'optional'
            $gitSev['code'] | Should -Be 'hard'
            # node, uvx and Linux bash came back as kernel optional: the ccstatusline hooks run
            # node, the MCP server entries launch through uvx, and the account hooks need bash.
            foreach ($n in 'node', 'uvx', 'bash') { $byName[$n]['severity']['kernel'] | Should -Be 'optional' }
            @($byName['bash']['platforms']) | Should -Be @('linux')
            $byName.Contains('pwsh') | Should -BeFalse
            $specs = @($tools | Where-Object { $_.Contains('install') } | ForEach-Object { $i = $_['install']; @($i.Keys) | ForEach-Object { $i[$_] } })
            $specs.Count | Should -BeGreaterThan 5
            foreach ($spec in $specs) {
                $spec.Contains('brew') | Should -BeFalse
                if ($spec.Contains('unpinned')) {
                    # The one named exception: git on Linux (operator ruling 2026-11-12, #310).
                    $spec.Contains('version') | Should -BeFalse
                    $spec.Contains('apt') | Should -BeTrue
                    continue
                }
                $src = @($spec.Keys | Where-Object { $_ -ne 'version' })[0]
                $grammar = @{ winget = '^\d+(\.\d+){1,3}$'; npm = '^\d+\.\d+\.\d+$'; apt = '^(\d+:)?[0-9][A-Za-z0-9.+~-]*$' }[$src]
                $spec['version'] | Should -Match $grammar
            }
            # Git is the only unpinned install in the shipped manifest.
            $unpinnedOwners = @($tools | Where-Object { $_.Contains('install') -and @($_['install'].Values | Where-Object { $_.Contains('unpinned') }).Count -gt 0 } | ForEach-Object { $_['name'] })
            $unpinnedOwners | Should -Be @('git')
        }

        It "git's Linux install is an unpinned apt install, and its argv carries no version" {
            $m = Get-DepsManifest -Path $script:shippedDeps
            $gitEntry = @($m['deps'] | Where-Object { $_['name'] -eq 'git' })[0]
            $spec = $gitEntry['install']['linux']
            $spec['apt'] | Should -Be 'git'
            $spec['unpinned'] | Should -BeOfType [string]
            $spec['unpinned'].Trim().Length | Should -BeGreaterThan 0
            $cmd = Get-DepInstallCommand -Dep $gitEntry -IsWindows $false
            @($cmd).Count | Should -Be 5
            $cmd | Should -Be @('sudo', 'apt-get', 'install', '-y', 'git')
            # The Windows install stays pinned.
            $gitEntry['install']['windows']['version'] | Should -Be '2.53.0'
        }

        It "an unpinned apt spec builds an argv array with the bare package name" {
            $dep = New-FakeDep
            $dep['install'] = [ordered]@{ linux = [ordered]@{ apt = 'fake-hard'; unpinned = 'The archive keeps only the current patched build.' } }
            $m = Get-DepsManifest -Path (New-DepsFixture -Deps @($dep))
            $cmd = Get-DepInstallCommand -Dep $m['deps'][0] -IsWindows $false
            $cmd -is [string[]] | Should -BeTrue
            $cmd | Should -Be @('sudo', 'apt-get', 'install', '-y', 'fake-hard')
            (Get-DepGuidance -Dep $m['deps'][0] -IsWindows $false) | Should -Be 'install with: sudo apt-get install -y fake-hard'
        }

        It "Get-DepsManifest refuses an unpinned install: <Case>" -ForEach @(
            @{ Case = 'on winget'; Plat = 'windows'; Spec = [ordered]@{ winget = 'Example.FakeHard'; unpinned = 'a reason' } }
            @{ Case = 'on npm'; Plat = 'linux'; Spec = [ordered]@{ npm = 'fake-tool'; unpinned = 'a reason' } }
            @{ Case = 'with an empty reason'; Plat = 'linux'; Spec = [ordered]@{ apt = 'fake-hard'; unpinned = '' } }
            @{ Case = 'with a blank reason'; Plat = 'linux'; Spec = [ordered]@{ apt = 'fake-hard'; unpinned = '   ' } }
            @{ Case = 'with a non-string reason'; Plat = 'linux'; Spec = [ordered]@{ apt = 'fake-hard'; unpinned = $true } }
            @{ Case = 'beside a version'; Plat = 'linux'; Spec = [ordered]@{ apt = 'fake-hard'; version = '1.2.3'; unpinned = 'a reason' } }
        ) {
            $dep = New-FakeDep
            $dep['install'] = [ordered]@{ $Plat = $Spec }
            { Get-DepsManifest -Path (New-DepsFixture -Deps @($dep)) } | Should -Throw -ExpectedMessage '*unpinned*'
        }

        It "Get-DepsManifest rejects <Version> as a <Source> version" -ForEach @(
            @{ Source = 'winget'; Version = 'latest' }, @{ Source = 'winget'; Version = '1.x' },
            @{ Source = 'winget'; Version = '>=1.2' }, @{ Source = 'winget'; Version = '^1.2.3' },
            @{ Source = 'winget'; Version = '' },
            @{ Source = 'npm'; Version = 'latest' }, @{ Source = 'npm'; Version = '1.x' },
            @{ Source = 'npm'; Version = '>=1.2' }, @{ Source = 'npm'; Version = '^1.2.3' },
            @{ Source = 'npm'; Version = '' },
            @{ Source = 'apt'; Version = '*' }, @{ Source = 'apt'; Version = '1.2.*' },
            @{ Source = 'apt'; Version = '>=1.2.3' }
        ) {
            $dep = New-FakeDep
            $dep['install'] = if ($Source -eq 'winget') { [ordered]@{ windows = [ordered]@{ winget = 'Example.FakeHard'; version = $Version } } }
            else { [ordered]@{ linux = [ordered]@{ $Source = 'fake-hard'; version = $Version } } }
            $fixture = New-DepsFixture -Deps @($dep)
            { Get-DepsManifest -Path $fixture } | Should -Throw -ExpectedMessage '*not an exact*'
        }

        It "Get-DepsManifest accepts the Debian version <_>" -ForEach '1:2.43.0-1ubuntu7.1', '1.7.1-1build1' {
            $dep = New-FakeDep
            $dep['install'] = [ordered]@{ linux = [ordered]@{ apt = 'fake-hard'; version = $_ } }
            $fixture = New-DepsFixture -Deps @($dep)
            { Get-DepsManifest -Path $fixture } | Should -Not -Throw
        }

        # --- plugins (part 2) ---------------------------------------------------------------

        It "a missing project-scope plugin with -InstallDeps adds its marketplace, installs at project scope in the target, and records the hash" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            $dir = New-FakePluginDir
            $mock = New-PluginMock -OnAdd @{ 'anthropics/claude-plugins-official' = @{ Name = 'claude-plugins-official'; Location = (New-FakeMarketplaceDir) } } `
                -OnInstall @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; installPath = $dir } }
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $plugin = @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' })
            @($plugin | ForEach-Object { @($_.Argv) -join ' ' }) | Should -Be @(
                'claude plugin list --json',
                'claude plugin marketplace list --json',
                'claude plugin marketplace add anthropics/claude-plugins-official',
                'claude plugin install fake-plugin@claude-plugins-official --scope project',
                'claude plugin list --json')
            foreach ($c in $plugin) { $c.Cwd | Should -Be $abs }
            $sidecar = Get-Content -LiteralPath "$script:target/.claude/.harness-manifest.local.json" -Raw | ConvertFrom-Json -AsHashtable
            $sidecar['pluginHashes']['fake-plugin@claude-plugins-official']['hash'] | Should -Be (Get-PluginContentHash -Path $dir)
            $sidecar['pluginHashes']['fake-plugin@claude-plugins-official']['installPath'] | Should -Be $dir
        }

        It "Install-Harness skips user-scope plugins" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Name 'fake-kernel' -Severity @{ kernel = 'optional' } -Scope 'user')
            $mock = New-PluginMock
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500
            @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' }).Count | Should -Be 0
            $out | Should -Match 'user-scope plugin fake-kernel@claude-plugins-official: Install-Account owns user scope'
        }

        It "a known marketplace is not added again" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            $dir = New-FakePluginDir
            $mock = New-PluginMock -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) } `
                -OnInstall @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; installPath = $dir } }
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            $lines = @($mock.Calls | ForEach-Object { @($_.Argv) -join ' ' })
            @($lines | Where-Object { $_ -match 'marketplace add' }).Count | Should -Be 0
            $lines | Should -Contain 'claude plugin install fake-plugin@claude-plugins-official --scope project'
        }

        It "a first-party plugin whose content changed warns, and -InstallDeps re-records it" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            $dir = New-FakePluginDir
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $mock = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = $dir } } `
                -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) }
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            $first = Get-PluginContentHash -Path $dir
            (Read-PluginRecord $script:target)['hash'] | Should -Be $first

            Set-Content -LiteralPath (Join-Path $dir 'skills/one/SKILL.md') -Value 'changed after recording'
            $second = Get-PluginContentHash -Path $dir
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500
            $out | Should -Match 'changed since recorded'
            (Read-PluginRecord $script:target)['hash'] | Should -Be $first

            $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500
            $audit | Should -Match 'plugin-changed'
            $audit | Should -Match 're-run the installer with -InstallDeps to re-record after reviewing the change'

            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            (Read-PluginRecord $script:target)['hash'] | Should -Be $second
            $after = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500
            $after | Should -Not -Match 'plugin-changed'
        }

        # A record the sidecar holds but that cannot vouch for the installed copy must never read
        # as unchanged: it is re-recorded like a first sighting, and -Audit never calls it clean.
        Context "a plugin record that cannot vouch for the installed copy" {
            BeforeEach {
                $script:brokenFixture = New-DepsFixture -Deps @(New-FakePlugin)
                $script:brokenDir = New-FakePluginDir
                $abs = (Resolve-Path -LiteralPath $script:target).Path
                $script:brokenMock = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = $script:brokenDir } } `
                    -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) }
                & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-Null
                $script:brokenGoodHash = Get-PluginContentHash -Path $script:brokenDir
            }

            It "<Name>: -Audit does not report it clean, and a plain run re-records it with a warning" -TestCases @(
                @{ Name = 'hash key missing'; Mutate = { param($r) $r.Remove('hash') } }
                @{ Name = 'hash empty'; Mutate = { param($r) $r['hash'] = '' } }
                @{ Name = 'hash is a number'; Mutate = { param($r) $r['hash'] = 5 } }
                @{ Name = 'hash is an array'; Mutate = { param($r) $r['hash'] = @('a', 'b') } }
                @{ Name = 'entry is a string'; Mutate = { param($r) 'not a record' } }
                @{ Name = 'entry is a number'; Mutate = { param($r) 42 } }
                @{ Name = 'entry is an array'; Mutate = { param($r) , @('a', 'b') } }
            ) {
                Set-BrokenPluginRecord $Mutate
                $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -Quiet -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String
                $audit | Should -Match 'plugin-unverified\tplugin:fake-plugin@claude-plugins-official'
                $audit | Should -Not -Match 'plugin-changed'

                $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String -Width 500
                $out | Should -Match 'recorded entry has no usable hash'
                $rec = Read-PluginRecord $script:target
                $rec['hash'] | Should -Be $script:brokenGoodHash
                $rec['installPath'] | Should -Be $script:brokenDir

                $after = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -Quiet -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String
                $after | Should -Not -Match 'plugin-'
            }

            It "-InstallDeps also re-records a hashless record" {
                Set-BrokenPluginRecord { param($r) $r.Remove('hash') }
                & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-Null
                (Read-PluginRecord $script:target)['hash'] | Should -Be $script:brokenGoodHash
            }

            # A record with a usable hash can still detect a change without its installPath: the
            # preflight hashes the path the plugin listing gives, so only an unchanged copy may be
            # re-recorded on a plain run.
            It "a record with a hash but no installPath: an unchanged copy gets its installPath recorded" {
                Set-BrokenPluginRecord { param($r) $r.Remove('installPath') }
                $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -Quiet -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String
                $audit | Should -Match 'plugin-unverified	plugin:fake-plugin@claude-plugins-official'
                $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String -Width 500
                $out | Should -Not -Match 'changed since recorded'
                $rec = Read-PluginRecord $script:target
                $rec['hash'] | Should -Be $script:brokenGoodHash
                $rec['installPath'] | Should -Be $script:brokenDir
                $after = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -Quiet -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String
                $after | Should -Not -Match 'plugin-'
            }

            It "a record with a hash but no installPath does not hide a changed copy, and only -InstallDeps re-records it" {
                Set-BrokenPluginRecord { param($r) $r.Remove('installPath') }
                Set-Content -LiteralPath (Join-Path $script:brokenDir 'skills/one/SKILL.md') -Value 'changed before the repair'
                $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String -Width 500
                $out | Should -Match 'changed since recorded'
                $out | Should -Not -Match 'could not vouch'
                $rec = Read-PluginRecord $script:target
                $rec['hash'] | Should -Be $script:brokenGoodHash
                $rec.Contains('installPath') | Should -BeFalse

                & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-Null
                $rec = Read-PluginRecord $script:target
                $rec['hash'] | Should -Be (Get-PluginContentHash -Path $script:brokenDir)
                $rec['installPath'] | Should -Be $script:brokenDir
            }

            It "a hashless record does not hide a later content change" {
                Set-BrokenPluginRecord { param($r) $r.Remove('hash') }
                & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-Null
                Set-Content -LiteralPath (Join-Path $script:brokenDir 'skills/one/SKILL.md') -Value 'changed after the repair'
                $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String -Width 500
                $out | Should -Match 'changed since recorded'
            }

            # A folder that exists but cannot be read cannot be hashed. Without the CLI, -Audit has
            # no other evidence, so it reports unverified rather than calling the copy changed or clean.
            It "-Audit reports plugin-unverified when the recorded folder cannot be hashed" {
                $locked = Join-Path $script:brokenDir 'skills/one/SKILL.md'
                $handle = $null
                try {
                    if ($script:hostWin) {
                        $handle = [System.IO.File]::Open($locked, 'Open', 'Read', 'None')
                    }
                    else { chmod 000 $locked }
                    $hashes = $true
                    try { $null = Get-PluginContentHash -Path $script:brokenDir } catch { $hashes = $false }
                    if ($hashes) { Set-ItResult -Skipped -Because 'this host can still read the locked file, so the folder stays hashable'; return }

                    $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -Quiet -DepsManifestPath $script:brokenFixture -DepsRunner $script:brokenMock.Runner *>&1 | Out-String
                    $audit | Should -Match "plugin-unverified`tplugin:fake-plugin@claude-plugins-official"
                    $audit | Should -Not -Match 'plugin-changed'
                }
                finally {
                    if ($handle) { $handle.Dispose() }
                    elseif (-not $script:hostWin) { chmod 644 $locked }
                }
            }
        }

        It "Get-PluginContentHash is order- and line-ending-stable" {
            $a = Join-Path $script:depsStubRoot ("hash-a-" + [guid]::NewGuid())
            $b = Join-Path $script:depsStubRoot ("hash-b-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path (Join-Path $a 'sub'), (Join-Path $b 'sub') -Force | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $a 'one.md'), "first`nline`n")
            [System.IO.File]::WriteAllText((Join-Path $a 'sub/two.md'), "second`n")
            [System.IO.File]::WriteAllText((Join-Path $b 'sub/two.md'), "second`r`n")
            [System.IO.File]::WriteAllText((Join-Path $b 'one.md'), "first`r`nline`r`n")
            $hashA = Get-PluginContentHash -Path $a
            $hashA | Should -Match '^sha256:[0-9a-f]{64}$'
            Get-PluginContentHash -Path $b | Should -Be $hashA
            # A .git directory is not plugin content.
            New-Item -ItemType Directory -Path (Join-Path $b '.git') | Out-Null
            Set-Content -LiteralPath (Join-Path $b '.git/HEAD') -Value 'ref: refs/heads/main'
            Get-PluginContentHash -Path $b | Should -Be $hashA

            [System.IO.File]::WriteAllText((Join-Path $b 'one.md'), "first`r`nlinE`r`n")
            Get-PluginContentHash -Path $b | Should -Not -Be $hashA
            [System.IO.File]::WriteAllText((Join-Path $b 'one.md'), "first`nline`n")
            Get-PluginContentHash -Path $b | Should -Be $hashA
            Rename-Item -LiteralPath (Join-Path $b 'one.md') -NewName 'uno.md'
            Get-PluginContentHash -Path $b | Should -Not -Be $hashA
        }

        It "a first-party plugin's sha move warns, and -InstallDeps re-records" {
            $shaA = 'a' * 40
            $shaB = 'b' * 40
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Pin ([ordered]@{ firstParty = $true; sha = $shaA }))
            $dir = New-FakePluginDir
            $mpDir = New-FakeMarketplaceDir -Sha $shaA
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $mock = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = $dir } } `
                -Marketplaces @{ 'claude-plugins-official' = $mpDir }
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            $rec = Read-PluginRecord $script:target
            $rec['sha'] | Should -Be $shaA
            $oldHash = $rec['hash']

            New-FakeMarketplaceDir -Sha $shaB -Path $mpDir | Out-Null
            Set-Content -LiteralPath (Join-Path $dir 'skills/one/SKILL.md') -Value 'version 7.0.2'
            $mock.Calls.Clear()
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500
            $out | Should -Match $shaA
            $out | Should -Match $shaB
            @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and @('install', 'update', 'uninstall') -contains $_.Argv[2] }).Count | Should -Be 0
            $same = Read-PluginRecord $script:target
            $same['sha'] | Should -Be $shaA
            $same['hash'] | Should -Be $oldHash

            $mock.Calls.Clear()
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null } |
                Should -Not -Throw
            @($mock.Calls | Where-Object { (@($_.Argv) -join ' ') -eq 'claude plugin update fake-plugin@claude-plugins-official --scope project' }).Count | Should -Be 1
            @($mock.Calls | Where-Object { $_.Argv[2] -eq 'uninstall' }).Count | Should -Be 0
            $new = Read-PluginRecord $script:target
            $new['sha'] | Should -Be $shaB
            $new['hash'] | Should -Be (Get-PluginContentHash -Path $dir)
        }

        It "a third-party sha-pinned plugin is checked before install" {
            $pin = [ordered]@{ sha = ('a' * 40); contentHash = ('sha256:' + ('0' * 64)) }
            foreach ($sev in 'hard', 'optional') {
                $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = $sev })
                $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha ('b' * 40)) } `
                    -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
                $target = "$($script:target)-$sev"
                New-Item -ItemType Directory -Path $target | Out-Null
                try {
                    $msg = $null
                    $out = $null
                    try { $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500 }
                    catch { $msg = $_.Exception.Message }
                    if ($sev -eq 'hard') { $msg | Should -Match '^missing hard dependency'; $msg | Should -Match 'not the pinned' }
                    else { $msg | Should -BeNullOrEmpty; $out | Should -Match 'missing optional dependency plugin fake-plugin@fake-mp' }
                    @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'install' }).Count | Should -Be 0
                }
                finally { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
            }
        }

        It "a third-party pinned plugin is rolled back when the installed copy does not verify" {
            $sha = 'a' * 40
            $pin = [ordered]@{ sha = $sha; contentHash = ('sha256:' + ('0' * 64)) }
            foreach ($sev in 'hard', 'optional') {
                $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = $sev })
                $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha $sha) } `
                    -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
                $target = "$($script:target)-$sev"
                New-Item -ItemType Directory -Path $target | Out-Null
                try {
                    $msg = $null
                    $out = $null
                    try { $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500 }
                    catch { $msg = $_.Exception.Message }
                    $plugin = @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' })
                    $installAt = [array]::FindIndex([object[]]$plugin, [Predicate[object]] { param($c) $c.Argv[2] -eq 'install' })
                    $installAt | Should -BeGreaterThan -1
                    (@($plugin[$installAt + 1].Argv) -join ' ') | Should -Be 'claude plugin list --json'
                    (@($plugin[$installAt + 2].Argv) -join ' ') | Should -Be 'claude plugin uninstall fake-plugin@fake-mp --scope project'
                    $plugin[$installAt + 2].Cwd | Should -Be $plugin[$installAt].Cwd
                    if ($sev -eq 'hard') { $msg | Should -Match '^missing hard dependency'; $msg | Should -Match 'uninstalled again' }
                    else { $msg | Should -BeNullOrEmpty; $out | Should -Match 'uninstalled again' }
                }
                finally { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
            }
        }

        It "a first-party marketplace name registered from another repo is refused, and nothing is installed or recorded" {
            # Optional on purpose: the refusal must not depend on the plugin's own severity.
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            # A registered value carrying a credential, as an internal mirror URL can. It must never
            # reach a message.
            $token = "TOKEN-$([guid]::NewGuid())"
            $spoof = @{ 'claude-plugins-official' = @{ Location = (New-FakeMarketplaceDir); Repo = "https://oauth2:$token@git.example.invalid/mirror/claude-plugins-official.git" } }
            $mock = New-PluginMock -Marketplaces $spoof -OnInstall @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            $msg = $null
            $out = $null
            try { $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 2000 }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match '^missing hard dependency'
            $msg | Should -Match 'field marketplace\.repo of claude-plugins-official does not match: expected anthropics/claude-plugins-official'
            "$msg $out".Contains($token) | Should -BeFalse
            $msg | Should -Not -Match 'git\.example\.invalid'
            @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and @('install', 'update') -contains $_.Argv[2] }).Count | Should -Be 0
            Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse

            # Already installed from the spoofed registration: no trust, so no hash is recorded.
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $present = New-PluginMock -Marketplaces $spoof -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = (New-FakePluginDir) } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $present.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*expected anthropics/claude-plugins-official, and the registered value differs (not shown)*'
            Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
        }


        # --- review round (B1-B8) ---------------------------------------------------------------

        It "a declined install of a hard dependency refuses, naming it" {
            $m = Get-DepsManifest -Path (New-DepsFixture -Deps @(New-FakeDep))
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-hard') { @{ ExitCode = 127 } } }
            { Invoke-DepsPreflight -Manifest $m -Layers @('kernel') -IsWindows $script:hostWin -InstallDeps $true -Runner $rec.Runner -ShouldInstall { $false } 3>$null 6>$null } |
                Should -Throw -ExpectedMessage '*harness-fake-hard*the install was declined*'
            @(Get-DepsInstallCalls $rec).Count | Should -Be 0
        }

        It "a declined install of an optional dependency warns, naming it" {
            $m = Get-DepsManifest -Path (New-DepsFixture -Deps @(New-FakeDep -Name 'harness-fake-opt' -Severity @{ kernel = 'optional' } -Winget 'Example.FakeOpt' -Apt 'fake-opt'))
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'harness-fake-opt') { @{ ExitCode = 127 } } }
            $warnings = @(Invoke-DepsPreflight -Manifest $m -Layers @('kernel') -IsWindows $script:hostWin -InstallDeps $true -Runner $rec.Runner -ShouldInstall { $false } 3>&1 6>$null |
                    Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
            ($warnings.Message -join "`n") | Should -Match 'missing optional dependency harness-fake-opt .*the install was declined'
        }

        It "a declined plugin install is reported, not dropped" {
            $m = Get-DepsManifest -Path (New-DepsFixture -Deps @(New-FakePlugin -Severity @{ code = 'hard' }))
            $mock = New-PluginMock -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) }
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            { Invoke-DepsPreflight -Manifest $m -Layers @('kernel', 'code') -IsWindows $script:hostWin -InstallDeps $true -Runner $mock.Runner `
                    -ShouldInstall { $false } -PluginScope 'project' -PluginCwd $abs 3>$null 6>$null } |
                Should -Throw -ExpectedMessage '*fake-plugin@claude-plugins-official*was declined*'
        }

        It "a third-party install whose post-install listing does not answer is rolled back" {
            $sha = 'a' * 40
            $pin = [ordered]@{ sha = $sha; contentHash = ('sha256:' + ('0' * 64)) }
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = 'optional' })
            $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha $sha) } -ListBrokenAfterInstall UntilUninstall `
                -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 1000
            @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'uninstall' }).Count | Should -Be 1
            $mock.State.Installed.Contains('fake-plugin@fake-mp') | Should -BeFalse
            $out | Should -Match 'could not be verified \(the plugin list did not answer\), so it was uninstalled again'
        }

        It "a third-party install whose listing never answers again throws, naming it as still installed" {
            $sha = 'a' * 40
            $pin = [ordered]@{ sha = $sha; contentHash = ('sha256:' + ('0' * 64)) }
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = 'optional' })
            $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha $sha) } -ListBrokenAfterInstall Always `
                -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*IS STILL INSTALLED*the plugin list did not answer after the uninstall*'
        }

        It "an empty plugin listing is not an answer, so an empty listing after an uninstall proves nothing" {
            foreach ($text in '', '   ', 'null', '{}', '{"id":"x"}') {
                $runner = { param($a, $t, $c) [pscustomobject]@{ ExitCode = 0; Output = $text; TimedOut = $false } }.GetNewClosure()
                Invoke-DepsJsonListing -Runner $runner -Argv @('claude', 'plugin', 'list', '--json') -Cwd $null | Should -BeNullOrEmpty -Because "'$text' is not a JSON array"
            }
            $empty = Invoke-DepsJsonListing -Runner { param($a, $t, $c) [pscustomobject]@{ ExitCode = 0; Output = '[]'; TimedOut = $false } } -Argv @('x') -Cwd $null
            $empty | Should -Not -BeNullOrEmpty
            @($empty.Rows).Count | Should -Be 0
            $one = Invoke-DepsJsonListing -Runner { param($a, $t, $c) [pscustomobject]@{ ExitCode = 0; Output = '[{"id":"x"}]'; TimedOut = $false } } -Argv @('x') -Cwd $null
            @($one.Rows).Count | Should -Be 1

            $sha = 'a' * 40
            $pin = [ordered]@{ sha = $sha; contentHash = ('sha256:' + ('0' * 64)) }
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = 'optional' })
            $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha $sha) } -ListEmptyAfterUninstall `
                -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            $msg = $null
            try { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match 'IS STILL INSTALLED'
            $msg | Should -Not -Match 'uninstalled again'
        }

        It "a failed plugin update leaves the record unchanged and is reported" {
            $shaA = 'a' * 40
            $shaB = 'b' * 40
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Pin ([ordered]@{ firstParty = $true; sha = $shaA }))
            $dir = New-FakePluginDir
            $mpDir = New-FakeMarketplaceDir -Sha $shaA
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $mock = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = $dir } } `
                -Marketplaces @{ 'claude-plugins-official' = $mpDir } -FailUpdate
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            $before = Read-PluginRecord $script:target
            $before['sha'] | Should -Be $shaA

            New-FakeMarketplaceDir -Sha $shaB -Path $mpDir | Out-Null
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 1000
            @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'update' }).Count | Should -Be 1
            $out | Should -Match 'claude plugin update did not succeed, so its record was left unchanged'
            $after = Read-PluginRecord $script:target
            $after['sha'] | Should -Be $shaA
            $after['hash'] | Should -Be $before['hash']
        }

        It "a plugin install's enabledPlugins entry survives the installer's settings write" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            $mock = New-PluginMock -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) } -WriteSettingsOnInstall `
                -OnInstall @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            $s = Get-Content -LiteralPath "$script:target/.claude/settings.json" -Raw | ConvertFrom-Json -AsHashtable
            $s['enabledPlugins']['fake-plugin@claude-plugins-official'] | Should -BeTrue
            $s['hooks'] | Should -Not -BeNullOrEmpty
        }

        It "after a winget install on Windows the re-probe sees PATH from the Machine and User scopes, and Git Bash is resolved again" {
            $root = Join-Path $script:depsStubRoot ("winget-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path (Join-Path $root 'cmd'), (Join-Path $root 'usr/bin') -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $root 'cmd/git.exe') -Value 'stub'
            Set-Content -LiteralPath (Join-Path $root 'usr/bin/bash.exe') -Value 'stub'
            $marker = [System.IO.Path]::GetFullPath((Join-Path $root 'cmd'))
            $bash = [System.IO.Path]::GetFullPath((Join-Path $root 'usr/bin/bash.exe'))
            $dep = [ordered]@{
                name = 'harness-fake-bash'; severity = @{ kernel = 'hard' }; resolve = 'git-bash'; minVersion = '5.0.0'
                failMode = 'Without harness-fake-bash, the fake shell gate fails open.'; probe = @('bash', '--version')
                versionPattern = 'GNU bash, version (\d+\.\d+(?:\.\d+)?)'
                install = [ordered]@{ windows = [ordered]@{ winget = 'Example.FakeGit'; version = '1.2.3' } }
            }
            $m = Get-DepsManifest -Path (New-DepsFixture -Deps @($dep))
            $rec = New-DepsRecorder -Answer {
                param($argv)
                if ($argv[0] -eq 'git') { return @{ ExitCode = 1 } }
                if ($argv[0] -eq $bash) { return @{ ExitCode = 0; Output = 'GNU bash, version 5.2.37(1)-release' } }
                if ($argv[0] -eq 'winget') { return @{ ExitCode = 0 } }
                return @{ ExitCode = 127 }
            }.GetNewClosure()
            $readScoped = { param($Scope) if ($Scope -eq 'Machine') { $marker } else { '' } }.GetNewClosure()
            $resolveGit = {
                $sep = [System.IO.Path]::PathSeparator
                if (@(([string]$env:PATH) -split [regex]::Escape([string]$sep)) -contains $marker) { return (Join-Path $marker 'git.exe') }
                return $null
            }.GetNewClosure()
            $savedPath = $env:PATH
            try {
                { Invoke-DepsPreflight -Manifest $m -Layers @('kernel') -IsWindows $true -InstallDeps $true -Runner $rec.Runner -ShouldInstall { $true } `
                        -ReadScopedPath $readScoped -ResolveGitExe $resolveGit 3>$null 6>$null } | Should -Not -Throw
                @(([string]$env:PATH) -split [regex]::Escape([string][System.IO.Path]::PathSeparator)) | Should -Contain $marker
                @($rec.Calls | Where-Object { $_.Argv[0] -eq $bash }).Count | Should -Be 1
            }
            finally { $env:PATH = $savedPath }
        }

        It "a commit-pinned plugin whose marketplace is not at the pinned commit is not installed (and installs when it is)" {
            $commit = 'c' * 40
            foreach ($case in @(@{ Head = ('d' * 40); Refused = $true }, @{ Head = $commit; Refused = $false })) {
                $dir = New-FakePluginDir
                $pin = [ordered]@{ commit = $commit; contentHash = (Get-PluginContentHash -Path $dir) }
                $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ directory = $true } -Pin $pin -Severity @{ code = 'hard' })
                $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir) } -Head $case.Head `
                    -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = $dir } }
                $target = "$($script:target)-$($case.Refused)"
                New-Item -ItemType Directory -Path $target | Out-Null
                try {
                    $msg = $null
                    try { & "$PSScriptRoot/Install-Harness.ps1" -Target $target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null }
                    catch { $msg = $_.Exception.Message }
                    $installs = @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'install' }).Count
                    if ($case.Refused) { $msg | Should -Match "not the pinned commit $commit, so nothing was installed"; $installs | Should -Be 0 }
                    else { $msg | Should -BeNullOrEmpty; $installs | Should -Be 1 }
                }
                finally { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
            }
        }

        It "a commit-pinned plugin whose marketplace moves off the pinned commit during the install is rolled back (and kept when it stays)" {
            $commit = 'c' * 40
            foreach ($case in @(@{ After = ('d' * 40); Refused = $true }, @{ After = $commit; Refused = $false })) {
                $dir = New-FakePluginDir
                $pin = [ordered]@{ commit = $commit; contentHash = (Get-PluginContentHash -Path $dir) }
                $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ directory = $true } -Pin $pin -Severity @{ code = 'hard' })
                $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir) } -Head $commit -HeadAfterInstall $case.After `
                    -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = $dir } }
                $target = "$($script:target)-$($case.Refused)"
                New-Item -ItemType Directory -Path $target | Out-Null
                try {
                    $msg = $null
                    try { & "$PSScriptRoot/Install-Harness.ps1" -Target $target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null }
                    catch { $msg = $_.Exception.Message }
                    $uninstalls = @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'uninstall' }).Count
                    if ($case.Refused) { $msg | Should -Match 'did not verify against its pin, so it was uninstalled again'; $uninstalls | Should -Be 1 }
                    else { $msg | Should -BeNullOrEmpty; $uninstalls | Should -Be 0 }
                }
                finally { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
            }
        }

        It "an installed commit-pinned plugin whose marketplace is not at the pinned commit refuses (and passes when it is)" {
            $commit = 'c' * 40
            foreach ($case in @(@{ Head = ('d' * 40); Refused = $true }, @{ Head = $commit; Refused = $false })) {
                $dir = New-FakePluginDir
                $pin = [ordered]@{ commit = $commit; contentHash = (Get-PluginContentHash -Path $dir) }
                $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ directory = $true } -Pin $pin -Severity @{ code = 'hard' })
                $target = "$($script:target)-$($case.Refused)"
                New-Item -ItemType Directory -Path $target | Out-Null
                try {
                    $abs = (Resolve-Path -LiteralPath $target).Path
                    $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir) } -Head $case.Head `
                        -Installed @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; projectPath = $abs; installPath = $dir } }
                    $msg = $null
                    try { & "$PSScriptRoot/Install-Harness.ps1" -Target $target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null }
                    catch { $msg = $_.Exception.Message }
                    if ($case.Refused) { $msg | Should -Match "its registered marketplace is not at the pinned commit $commit" }
                    else { $msg | Should -BeNullOrEmpty }
                }
                finally { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
            }
        }


        It "a first-party marketplace name listed twice refuses, in either order, and echoes no registered value" {
            $good = @{ Location = (New-FakeMarketplaceDir); Repo = 'anthropics/claude-plugins-official' }
            $token = "TOKEN-$([guid]::NewGuid())"
            $foreign = @{ Location = (New-FakeMarketplaceDir); Repo = "https://oauth2:$token@git.example.invalid/claude-plugins-official.git" }
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            foreach ($order in @(@($good, $foreign), @($foreign, $good))) {
                $mock = New-PluginMock -Marketplaces @{ 'claude-plugins-official' = $order } `
                    -OnInstall @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
                $msg = $null
                $out = $null
                try { $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 2000 }
                catch { $msg = $_.Exception.Message }
                $msg | Should -Match '^missing hard dependency'
                $msg | Should -Match 'field marketplace\.repo of claude-plugins-official cannot be confirmed: expected anthropics/claude-plugins-official, and the name is registered 2 times'
                "$msg $out".Contains($token) | Should -BeFalse
                @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'install' }).Count | Should -Be 0
                Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
            }
        }

        It "-Audit reports plugin-unverified when a newer copy sits beside the recorded one" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            $dir = New-FakePluginDir
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $mock = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = $dir } } `
                -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) }
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            (Get-Item -LiteralPath $dir).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-2)
            $sibling = Join-Path (Split-Path -Parent $dir) '1.0.1'
            New-Item -ItemType Directory -Path $sibling | Out-Null
            (Get-Item -LiteralPath $sibling).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-1)
            $quiet = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -Quiet *>&1 | Out-String
            $quiet | Should -Match "plugin-unverified`tplugin:fake-plugin@claude-plugins-official"
            $quiet | Should -Not -Match 'plugin-changed'
            $audit = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit *>&1 | Out-String -Width 2000
            $audit | Should -Match 'plugin-unverified = a newer copy exists than the recorded one'
        }

        It "-Audit stays silent when the only copy beside the recorded one is older" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin)
            $dir = New-FakePluginDir
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $mock = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = $dir } } `
                -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) }
            & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null
            $sibling = Join-Path (Split-Path -Parent $dir) '0.9.0'
            New-Item -ItemType Directory -Path $sibling | Out-Null
            (Get-Item -LiteralPath $sibling).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-2)
            (Get-Item -LiteralPath $dir).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-1)
            $quiet = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -Audit -Quiet *>&1 | Out-String
            $quiet | Should -Not -Match 'plugin-unverified'
            $quiet | Should -Not -Match 'plugin-changed'
        }

        It "a rollback whose uninstall fails throws, naming the plugin as still installed" {
            $sha = 'a' * 40
            $pin = [ordered]@{ sha = $sha; contentHash = ('sha256:' + ('0' * 64)) }
            # Optional on purpose: a failed rollback is a hard stop whatever the severity.
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = 'optional' })
            $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha $sha) } -FailUninstall `
                -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            $msg = $null
            try { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match 'IS STILL INSTALLED'
            $msg | Should -Match 'the uninstall exited 1'
            $msg.Contains('claude plugin uninstall fake-plugin@fake-mp --scope project') | Should -BeTrue
            $msg | Should -Not -Match 'uninstalled again'
            Test-Path -LiteralPath "$script:target/.claude" | Should -BeFalse
        }

        It "a rollback whose uninstall exits 0 but leaves the plugin listed throws, naming it as still installed" {
            $sha = 'a' * 40
            $pin = [ordered]@{ sha = $sha; contentHash = ('sha256:' + ('0' * 64)) }
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = 'optional' })
            $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha $sha) } -UninstallLeavesIt `
                -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*IS STILL INSTALLED*the plugin list still shows it after the uninstall*'
            # The uninstall ran, then the list was read again to confirm it.
            $last = @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' })
            (@($last[-2].Argv) -join ' ') | Should -Be 'claude plugin uninstall fake-plugin@fake-mp --scope project'
            (@($last[-1].Argv) -join ' ') | Should -Be 'claude plugin list --json'
        }

        It "a declined rollback throws, naming the plugin as still installed" {
            $sha = 'a' * 40
            $pin = [ordered]@{ sha = $sha; contentHash = ('sha256:' + ('0' * 64)) }
            $m = Get-DepsManifest -Path (New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin $pin -Severity @{ code = 'optional' }))
            $mock = New-PluginMock -Marketplaces @{ 'fake-mp' = (New-FakeMarketplaceDir -Sha $sha) } `
                -OnInstall @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; installPath = (New-FakePluginDir) } }
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $msg = $null
            try {
                Invoke-DepsPreflight -Manifest $m -Layers @('kernel', 'code') -IsWindows $script:hostWin -InstallDeps $true -Runner $mock.Runner `
                    -ShouldInstall { param($What, $Action) $Action -ne 'uninstall' } -PluginScope 'project' -PluginCwd $abs 3>$null 6>$null | Out-Null
            }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match 'IS STILL INSTALLED'
            $msg | Should -Match 'the uninstall was declined'
            @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'uninstall' }).Count | Should -Be 0
        }

        It "git installs on Linux through an unpinned apt command, so a Linux code layer refuses with that command rather than install-by-hand guidance" {
            $m = Get-DepsManifest -Path $script:shippedDeps
            $gitEntry = @($m['deps'] | Where-Object { $_['name'] -eq 'git' })[0]
            $gitEntry['install'].Contains('linux') | Should -BeTrue
            $rec = New-DepsRecorder -Answer { param($argv) if ($argv[0] -eq 'git') { @{ ExitCode = 127 } } }
            $msg = $null
            try { Invoke-DepsPreflight -Manifest $m -Layers @('kernel', 'code') -IsWindows $false -InstallDeps $false -Runner $rec.Runner -ShouldInstall { $true } 3>$null 6>$null | Out-Null }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match 'missing hard dependency'
            $msg.Contains('sudo apt-get install -y git') | Should -BeTrue
            $msg.Contains('git=') | Should -BeFalse
            $msg.Contains('no pinned install') | Should -BeFalse
        }

        It "a plugin present but not enabled at the declared scope counts as missing" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Severity @{ code = 'hard' })
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $mock = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = (New-FakePluginDir); enabled = $false } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*not enabled at project scope*'
            # Installed at another project's path is not installed here either.
            $mock2 = New-PluginMock -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = "$abs-elsewhere"; installPath = (New-FakePluginDir) } }
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock2.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*not installed at project scope*'
        }

        It "an unpinned third-party plugin is refused without the project opt-in" {
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Marketplace 'fake-mp' -Source @{ github = 'example/fake-mp' } -Pin @{ unpinned = $true } -Severity @{ code = 'hard' })
            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $installed = @{ 'fake-plugin@fake-mp' = @{ scope = 'project'; projectPath = $abs; installPath = (New-FakePluginDir) } }
            $mock = New-PluginMock -Installed $installed -OnInstall $installed
            { & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -InstallDeps -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*allowUnpinnedPlugins*'
            @($mock.Calls | Where-Object { $_.Argv[0] -eq 'claude' -and $_.Argv[2] -eq 'install' }).Count | Should -Be 0

            New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
            $risk = 'Example risk: this plugin runs unreviewed hooks from a personal repository.'
            @{ files = @{}; allowUnpinnedPlugins = @(@{ plugin = 'fake-plugin@fake-mp'; risk = $risk }) } | ConvertTo-Json -Depth 5 |
                Set-Content -LiteralPath "$script:target/.claude/.harness-manifest.json"
            $out = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $mock.Runner *>&1 | Out-String -Width 500
            $out.Contains($risk) | Should -BeTrue
            Test-Path -LiteralPath "$script:target/.claude/agents/task-reviewer.md" | Should -BeTrue
        }

        It "an allowUnpinnedPlugins entry with no risk sentence is refused before any write" {
            New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
            @{ files = @{}; allowUnpinnedPlugins = @(@{ plugin = 'fake-plugin@fake-mp'; risk = '' }) } | ConvertTo-Json -Depth 5 |
                Set-Content -LiteralPath "$script:target/.claude/.harness-manifest.json"
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*allowUnpinnedPlugins*'
            Test-Path -LiteralPath "$script:target/.claude/agents" | Should -BeFalse
        }

        It "an allowUnpinnedPlugins entry naming no unpinned third-party plugin is refused before any write" {
            New-Item -ItemType Directory -Path "$script:target/.claude" | Out-Null
            # superpowers is first-party, so an opt-in for it accepts a risk nothing carries.
            @{ files = @{}; allowUnpinnedPlugins = @(@{ plugin = 'superpowers@claude-plugins-official'; risk = 'Example risk sentence.' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$script:target/.claude/.harness-manifest.json"
            { & "$PSScriptRoot/Install-Harness.ps1" @script:dep -Target $script:target *>&1 | Out-Null } |
                Should -Throw -ExpectedMessage '*does not declare as an unpinned third-party plugin*'
            Test-Path -LiteralPath "$script:target/.claude/agents" | Should -BeFalse
        }

        It "plugin list output is never echoed" {
            $secret = "harness-secret-$([guid]::NewGuid())"
            $extra = '{"id":"mcp-carrier@elsewhere","scope":"user","enabled":true,"mcpServers":{"api":{"headers":{"Authorization":"Bearer ' + $secret + '"}}}}'
            $fixture = New-DepsFixture -Deps @(New-FakePlugin -Severity @{ code = 'hard' })
            $failing = New-PluginMock -ExtraRowJson $extra
            $msg = $null
            $out1 = $null
            try { $out1 = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $failing.Runner *>&1 | Out-String -Width 2000 }
            catch { $msg = $_.Exception.Message }
            $msg | Should -Match '^missing hard dependency'
            "$out1 $msg".Contains($secret) | Should -BeFalse

            $abs = (Resolve-Path -LiteralPath $script:target).Path
            $passing = New-PluginMock -ExtraRowJson $extra -Installed @{ 'fake-plugin@claude-plugins-official' = @{ scope = 'project'; projectPath = $abs; installPath = (New-FakePluginDir) } } `
                -Marketplaces @{ 'claude-plugins-official' = (New-FakeMarketplaceDir) }
            $warnings = $null
            $out2 = & "$PSScriptRoot/Install-Harness.ps1" -Target $script:target -DepsManifestPath $fixture -DepsRunner $passing.Runner -WarningVariable warnings *>&1 | Out-String -Width 2000
            $out2.Contains($secret) | Should -BeFalse
            (@($warnings) -join "`n").Contains($secret) | Should -BeFalse
            Test-Path -LiteralPath "$script:target/.claude/.harness-manifest.local.json" | Should -BeTrue
            foreach ($f in @(Get-ChildItem -LiteralPath $script:target -Recurse -File -Force)) {
                ([System.IO.File]::ReadAllText($f.FullName)).Contains($secret) | Should -BeFalse -Because "$($f.FullName) must not carry the plugin list"
            }
        }

        It "the shipped deps.json plugin entries validate" {
            $m = Get-DepsManifest -Path $script:shippedDeps
            $plugins = @($m['deps'] | Where-Object { $_['kind'] -eq 'plugin' })
            $plugins.Count | Should -BeGreaterThan 0
            $byName = @{}
            foreach ($p in $plugins) {
                $byName[$p['plugin']] = $p
                if ($p['severity'].Contains('kernel')) { $p['scope'] | Should -Be 'user' } else { $p['scope'] | Should -Be 'project' }
                if ($p['pin'].Contains('firstParty')) {
                    @('claude-plugins-official', 'anthropic-agent-skills') | Should -Contain $p['marketplace']['name']
                }
            }
            $sp = $byName['superpowers@claude-plugins-official']
            $sp['pin']['firstParty'] | Should -BeTrue
            $sp['pin']['sha'] | Should -Match '^[0-9a-f]{40}$'
            $sp['pin'].Contains('contentHash') | Should -BeFalse
            $cp = $byName['core-presentations@agent-skills-core']
            $cp['pin']['commit'] | Should -Match '^[0-9a-f]{40}$'
            $cp['pin']['contentHash'] | Should -Match '^sha256:[0-9a-f]{64}$'
            $ds = $byName['document-skills@anthropic-agent-skills']
            $ds['pin']['firstParty'] | Should -BeTrue
            $ds['pin'].Contains('unpinned') | Should -BeFalse
            foreach ($gone in 'caveman@caveman', 'ponytail@ponytail', 'core-workflow@agent-skills-core') { $byName.Contains($gone) | Should -BeFalse }
            foreach ($code in 'code-review', 'feature-dev', 'security-guidance', 'github') {
                $byName["$code@claude-plugins-official"]['severity'].Contains('code') | Should -BeTrue
            }
        }

        It "Get-DepsManifest refuses <Case>" -ForEach @(
            @{ Case = 'a kernel plugin at project scope'; Expect = '*kernel plugin, so its scope must be user*'; Over = @{ severity = @{ kernel = 'optional' }; scope = 'project' } },
            @{ Case = 'a layer plugin at user scope'; Expect = '*layer plugin, so its scope must be project*'; Over = @{ scope = 'user' } },
            @{ Case = 'firstParty on another marketplace'; Expect = '*marks firstParty on marketplace*'; Over = @{ marketplace = @{ name = 'fake-mp'; source = @{ github = 'example/fake-mp' } }; plugin = 'fake-plugin@fake-mp' } },
            @{ Case = 'firstParty under a first-party name at another source'; Expect = '*marks firstParty on marketplace*'; Over = @{ marketplace = @{ name = 'claude-plugins-official'; source = @{ github = 'example/claude-plugins-official' } } } },
            @{ Case = 'a third-party entry with no sha, commit or unpinned'; Expect = '*none of sha, commit or unpinned*'; Over = @{ marketplace = @{ name = 'fake-mp'; source = @{ github = 'example/fake-mp' } }; plugin = 'fake-plugin@fake-mp'; pin = @{ contentHash = ('sha256:' + ('0' * 64)) } } }
        ) {
            $p = New-FakePlugin
            foreach ($k in $Over.Keys) { $p[$k] = $Over[$k] }
            { Get-DepsManifest -Path (New-DepsFixture -Deps @($p)) } | Should -Throw -ExpectedMessage $Expect
        }
    }
}
