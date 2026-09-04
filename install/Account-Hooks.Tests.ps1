# install/Account-Hooks.Tests.ps1
Describe "Account hooks" {
    BeforeAll {
        # Two possible sources for the same four hooks: the canonical live copy under the
        # operator's ~/.claude, and the exported payload in this repo once Task 14 has run.
        # Both are checked when present, so an export that drops a fix fails here rather than
        # on a receiver.
        $script:hookRoots = @(
            @(
                (Join-Path (Join-Path $HOME '.claude') 'hooks')
                (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'account') 'claude/hooks')
            ) | Where-Object { Test-Path -LiteralPath $_ }
        )

        # Runs a hook in a child pwsh with $HOME pointed at a sandbox. $HOME is read-only
        # in-process, and Set-Variable -Force reaches only the current scope and never a child
        # script, so the redirect has to happen through the environment. On Windows $HOME is
        # derived from USERPROFILE and not from $env:HOME: measured, with USERPROFILE,
        # HOMEDRIVE and HOMEPATH removed and only $env:HOME set, $HOME comes back empty. Both
        # are set here so the same helper works on either platform.
        function Invoke-HookWithHome {
            param(
                [string]$HookPath,
                [string]$SandboxHome,
                [string]$StdinJson,
                [hashtable]$Env = @{},
                # 'pwsh' for every existing caller. 'powershell' drives the same hook under
                # Windows PowerShell 5.1, which settings.json's "shell": "powershell" may hand
                # it and which rejects a third positional Join-Path argument outright.
                [ValidateSet('pwsh', 'powershell')][string]$Shell = 'pwsh'
            )
            $names = @(@('USERPROFILE', 'HOME') + @($Env.Keys))
            $saved = @{}
            foreach ($k in $names) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
            try {
                $env:USERPROFILE = $SandboxHome
                $env:HOME = $SandboxHome
                foreach ($k in @($Env.Keys)) { Set-Item -Path "Env:$k" -Value $Env[$k] }
                $out = @($StdinJson | & $Shell -NoProfile -File $HookPath 2>&1)
                return [pscustomobject]@{
                    ExitCode = $LASTEXITCODE
                    Output   = ($out -join "`n")
                }
            }
            finally {
                foreach ($k in $names) {
                    if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
                    else { Set-Item -Path "Env:$k" -Value $saved[$k] }
                }
            }
        }

        # Lifts one function's source text out of a hook without running the hook.
        function Import-HookFunction {
            param([string]$ScriptPath, [string]$Name)
            $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                $ScriptPath, [ref]$null, [ref]$null)
            $fn = @($ast.FindAll({ param($n)
                        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
                    Where-Object { $_.Name -eq $Name })
            if ($fn.Count -eq 0) { throw "$ScriptPath no longer defines $Name" }
            return $fn[0].Extent.Text
        }

        # Evaluates a path-building expression with $HOME forced to a POSIX value and Join-Path
        # shadowed by a POSIX-only implementation. Without the stub a Windows host cannot tell a
        # correct nested Join-Path from one whose child path carries embedded backslashes:
        # Windows accepts both spellings, so the Linux-only failure is invisible here. Under the
        # stub only the segment-per-argument form comes back separator-clean.
        function Invoke-UnderPosixJoin {
            # -SetEnv pins a variable to an explicit value instead of relying on whatever the
            # host running the suite happens to have set. LOCALAPPDATA is Windows-only: a test
            # that read it ambiently to exercise the "present" branch would go red on any Linux
            # runner, the exact platform this suite exists to cover.
            param([string]$Expression, [string]$HomeValue, [string[]]$ClearEnv = @(), [hashtable]$SetEnv = @{})
            function Join-Path {
                param([Parameter(ValueFromRemainingArguments)]$Parts)
                (@($Parts) -join '/')
            }
            Set-Variable -Name HOME -Value $HomeValue -Scope Local -Force
            $saved = @{}
            foreach ($k in $ClearEnv) {
                $saved[$k] = [Environment]::GetEnvironmentVariable($k)
                Remove-Item "Env:$k" -ErrorAction SilentlyContinue
            }
            foreach ($k in @($SetEnv.Keys)) {
                $saved[$k] = [Environment]::GetEnvironmentVariable($k)
                Set-Item "Env:$k" -Value $SetEnv[$k]
            }
            try { return (& ([scriptblock]::Create($Expression))) }
            finally {
                foreach ($k in (@($ClearEnv) + @($SetEnv.Keys))) {
                    if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
                    else { Set-Item "Env:$k" -Value $saved[$k] }
                }
            }
        }

        function New-HookSandbox {
            $s = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-hooks-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $s -Force | Out-Null
            return $s
        }

        # Lifts the named variable-assignment statements out of a script, in source order, by
        # their extent text. Used to run a hook's own root-derivation lines through a stub
        # instead of a hand-copied stand-in: a stand-in tests what the copy says, not what the
        # hook does, and the two can drift the moment either one is edited alone.
        function Get-VariableAssignmentText {
            param([string]$ScriptPath, [string[]]$Names)
            $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                $ScriptPath, [ref]$null, [ref]$null)
            $stmts = @($ast.FindAll({ param($n)
                        $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                        $n.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
                        $Names -contains $n.Left.VariablePath.UserPath }, $true) |
                    Sort-Object { $_.Extent.StartOffset })
            if ($stmts.Count -ne $Names.Count) {
                throw "$ScriptPath does not assign all of: $($Names -join ', ')"
            }
            return (@($stmts | ForEach-Object { $_.Extent.Text }) -join "`n")
        }
    }

    # Every assertion below iterates $script:hookRoots. An empty list would make all of them
    # pass without evaluating anything, which is the failure patterns/test-falsifiability.md
    # names. Assert the list is populated before relying on it.
    It "resolves at least one hooks directory to run against" {
        $script:hookRoots.Count | Should -BeGreaterThan 0
    }

    It "derives a separator-clean root under a POSIX HOME" {
        foreach ($root in $script:hookRoots) {
            $hook = Join-Path $root 'Scan-MemorySecrets.ps1'
            $code = Get-VariableAssignmentText -ScriptPath $hook -Names @('claudeHome', 'memRoot', 'councilRoot')
            # Appends a literal expression, not a string-interpolated one: the backtick before
            # each $ keeps it text here so it becomes a real variable reference only once
            # Invoke-UnderPosixJoin evaluates the assembled code.
            $result = Invoke-UnderPosixJoin -HomeValue '/home/alice' `
                -Expression ($code + "`n@{ memRoot = `$memRoot; councilRoot = `$councilRoot }")
            $result.memRoot | Should -Not -Match '/' -Because "$root must not leave a POSIX separator inside memRoot"
            $result.councilRoot | Should -Not -Match '/' -Because "$root must not leave a POSIX separator inside councilRoot"
        }
    }

    # IMPROVE-1: an unresolvable HOME falls through to the content scan for an in-scope
    # path instead of blocking outright, since the scan needs no roots either. Three
    # independent rows, each its own It: Pester aborts an It at the first failing Should,
    # so folding these into one block would let an earlier row mask a later one going red.
    It "blocks an in-scope secret when HOME cannot be resolved" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $hook = Join-Path $root 'Scan-MemorySecrets.ps1'
                $unresolvable = @{ USERPROFILE = ''; HOME = ''; HOMEDRIVE = ''; HOMEPATH = '' }
                $json = @{ tool_input = @{
                        file_path = 'C:/Users/jcgam/.claude/projects/X/memory/note.md'
                        content   = 'AKIAIOSFODNN7EXAMPLE'
                    } } | ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome -HookPath $hook -SandboxHome $sandbox -StdinJson $json -Env $unresolvable
                $r.ExitCode | Should -Be 2 -Because "$root must scan and block an in-scope secret even when HOME is unresolvable"
                $r.Output | Should -Match 'BLOCKED'
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "allows a clean in-scope write when HOME cannot be resolved" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $hook = Join-Path $root 'Scan-MemorySecrets.ps1'
                $unresolvable = @{ USERPROFILE = ''; HOME = ''; HOMEDRIVE = ''; HOMEPATH = '' }
                $json = @{ tool_input = @{
                        file_path = 'C:/Users/jcgam/.claude/projects/X/memory/note.md'
                        content   = 'A plain note with no credentials in it.'
                    } } | ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome -HookPath $hook -SandboxHome $sandbox -StdinJson $json -Env $unresolvable
                $r.ExitCode | Should -Be 0 -Because "$root must scan rather than block outright when HOME is unresolvable"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "allows an out-of-scope write when HOME cannot be resolved" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $hook = Join-Path $root 'Scan-MemorySecrets.ps1'
                $unresolvable = @{ USERPROFILE = ''; HOME = ''; HOMEDRIVE = ''; HOMEPATH = '' }
                $json = @{ tool_input = @{
                        file_path = 'C:/Users/jcgam/src/app.ts'
                        content   = 'AKIAIOSFODNN7EXAMPLE'
                    } } | ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome -HookPath $hook -SandboxHome $sandbox -StdinJson $json -Env $unresolvable
                $r.ExitCode | Should -Be 0 -Because "$root must not scan or block an out-of-scope write just because HOME is unresolvable"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "blocks a secret written under a memory root derived from HOME" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'P') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                # Forward slashes: this is the shape Claude Code actually sends, and it is what
                # the hook's own '/'->'\' normalisation at line 28 exists to handle.
                $target = (Join-Path $dir 'note.md') -replace '\\', '/'
                $json = @{ tool_input = @{ file_path = $target; content = 'AKIAIOSFODNN7EXAMPLE' } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Scan-MemorySecrets.ps1') `
                    -SandboxHome $sandbox -StdinJson $json
                $r.ExitCode | Should -Be 2 -Because "$root must scan a memory root under any HOME"
                $r.Output | Should -Match 'BLOCKED'
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "blocks a secret written under a council-transcripts root derived from HOME" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $dir = Join-Path (Join-Path (Join-Path $sandbox '.claude') 'council-transcripts') 'P'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $target = (Join-Path $dir 'round-1.md') -replace '\\', '/'
                $json = @{ tool_input = @{ file_path = $target; content = 'AKIAIOSFODNN7EXAMPLE' } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Scan-MemorySecrets.ps1') `
                    -SandboxHome $sandbox -StdinJson $json
                $r.ExitCode | Should -Be 2 -Because "$root must scan a council root under any HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "still allows a clean memory write and a write outside both roots" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $hook = Join-Path $root 'Scan-MemorySecrets.ps1'
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'P') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null

                $clean = @{ tool_input = @{
                        file_path = ((Join-Path $dir 'note.md') -replace '\\', '/')
                        content   = 'A plain note with no credentials in it.'
                    } } | ConvertTo-Json -Depth 5 -Compress
                (Invoke-HookWithHome -HookPath $hook -SandboxHome $sandbox -StdinJson $clean).ExitCode |
                    Should -Be 0

                # Outside both roots the hook must stay out of the way, secret or not. This is
                # the scoping half of the fix: a root derived too broadly would block ordinary
                # source files carrying test fixtures.
                $outside = @{ tool_input = @{
                        file_path = ((Join-Path $sandbox 'src/app.ts') -replace '\\', '/')
                        content   = 'AKIAIOSFODNN7EXAMPLE'
                    } } | ConvertTo-Json -Depth 5 -Compress
                (Invoke-HookWithHome -HookPath $hook -SandboxHome $sandbox -StdinJson $outside).ExitCode |
                    Should -Be 0
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    # Sync-MemoryToObsidian.ps1 has the same claudeHome -> memRoot/councilRoot derivation
    # shape as Scan-MemorySecrets.ps1 above, so it gets the same POSIX-join check: a second
    # Join-Path off an already-normalised $claudeHome re-inserts the platform separator, and
    # only re-normalising after THAT join catches it. Task 1's suite never ran this check
    # against a hook's real lines and stayed green through a fix that was a no-op on POSIX.
    It "derives separator-clean roots for Sync-MemoryToObsidian under a POSIX HOME" {
        foreach ($root in $script:hookRoots) {
            $hook = Join-Path $root 'Sync-MemoryToObsidian.ps1'
            $code = Get-VariableAssignmentText -ScriptPath $hook -Names @('claudeHome', 'memRoot', 'councilRoot')
            $result = Invoke-UnderPosixJoin -HomeValue '/home/alice' `
                -Expression ($code + "`n@{ claudeHome = `$claudeHome; memRoot = `$memRoot; councilRoot = `$councilRoot }")
            $result.claudeHome | Should -Not -Match '/' -Because "$root must not leave a POSIX separator inside claudeHome"
            $result.memRoot | Should -Not -Match '/' -Because "$root must not leave a POSIX separator inside memRoot"
            $result.councilRoot | Should -Not -Match '/' -Because "$root must not leave a POSIX separator inside councilRoot"
        }
    }

    # Windows PowerShell 5.1 rejects a third positional argument to Join-Path outright
    # (ParameterBindingException), and this hook is registered with "shell": "powershell" in
    # settings.json, a host that may be 5.1. $ErrorActionPreference = 'SilentlyContinue' at the
    # top of the hook swallows that exception, so a reintroduced multi-argument call is a
    # silent no-op copy on a 5.1 receiver, not a visible failure. An AST scan catches the arity
    # without needing a 5.1 interpreter on hand to reproduce it.
    It "keeps every Join-Path call in Sync-MemoryToObsidian at two arguments" {
        foreach ($root in $script:hookRoots) {
            $hook = Join-Path $root 'Sync-MemoryToObsidian.ps1'
            $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                $hook, [ref]$null, [ref]$null)
            $calls = @($ast.FindAll({ param($n)
                        $n -is [System.Management.Automation.Language.CommandAst] -and
                        $n.GetCommandName() -eq 'Join-Path' }, $true))
            $calls.Count | Should -BeGreaterThan 0 -Because "$root must still call Join-Path somewhere for this check to mean anything"
            foreach ($call in $calls) {
                # CommandElements[0] is the command name; the two-argument form is 3 elements
                # total (name, Path, ChildPath). A reintroduced third argument pushes this past 2.
                $argCount = $call.CommandElements.Count - 1
                $argCount | Should -BeLessOrEqual 2 -Because "$($call.Extent.Text) at line $($call.Extent.StartLineNumber) must nest instead of taking a third argument"
            }
        }
    }

    # Stronger than the AST scan: actually drives the hook under Windows PowerShell 5.1 and
    # checks the file lands, the exact failure mode the reviewer measured (exit 0, nothing
    # copied) rather than inferring it from arity alone. Skips rather than passing vacuously
    # when no 5.1 interpreter is on the host running the suite.
    It "copies an ordinary memory write to the vault under Windows PowerShell 5.1" {
        if (-not (Get-Command powershell -ErrorAction SilentlyContinue)) {
            Set-ItResult -Skipped -Because 'no Windows PowerShell 5.1 available to drive this check'
            return
        }
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'E--projects-demo') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'MEMORY.md'
                'note' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault } `
                    -Shell 'powershell'
                $r.ExitCode | Should -Be 0
                $landed = Join-Path (Join-Path (Join-Path $vault 'E--projects-demo') 'Memory') 'MEMORY.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must copy an ordinary memory write under Windows PowerShell 5.1, not silently exit 0"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "copies a memory write into a vault named by CLAUDE_OBSIDIAN_VAULT" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'E--projects-demo') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'MEMORY.md'
                'note' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault }
                $r.ExitCode | Should -Be 0
                $landed = Join-Path (Join-Path (Join-Path $vault 'E--projects-demo') 'Memory') 'MEMORY.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must find a memory root under any HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    # The brief's own ablation for the paired test below names $proj = 'C--Users-jcgam' (the
    # docs/superpowers/{plans,specs} branch), but that branch is unreachable from a bare
    # ~/.claude/specs write: only the global-.claude branch below it runs there, and that one
    # carries a second, distinct slug literal at its own $dest line. Restoring the
    # docs/superpowers branch's literal alone left all 13 tests green, proving it, so this
    # test exists to give that site an ablation target of its own.
    It "routes a docs/superpowers spec write under .claude to the slug of the running HOME" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'docs') 'superpowers') 'specs'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'design.md'
                'spec' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault }
                $r.ExitCode | Should -Be 0
                $slug = $sandbox.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
                $landed = Join-Path (Join-Path (Join-Path $vault $slug) 'Specs') 'design.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must slug the running HOME when the repo root is .claude itself"
                Test-Path -LiteralPath (Join-Path $vault 'C--Users-jcgam') |
                    Should -BeFalse -Because "no receiver may mint this workstation's slug"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "routes a global spec write to the slug of the running HOME, not to C--Users-jcgam" {
        # The sharpest of the four: it fails unless lines 47 and 49 both moved off the
        # workstation literals. A fix that changed only the vault would put the file under
        # <vault>/C--Users-jcgam/Specs on a receiver, a foreign username's tree.
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path $sandbox '.claude') 'specs'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'design.md'
                'spec' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault }
                $r.ExitCode | Should -Be 0
                $slug = $sandbox.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
                $landed = Join-Path (Join-Path (Join-Path $vault $slug) 'Specs') 'design.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must slug the running HOME"
                Test-Path -LiteralPath (Join-Path $vault 'C--Users-jcgam') |
                    Should -BeFalse -Because "no receiver may mint this workstation's slug"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "copies a council transcript into the vault under the project's Council folder" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path (Join-Path $sandbox '.claude') 'council-transcripts') 'E--projects-demo'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'round-1.md'
                'transcript' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault }
                $r.ExitCode | Should -Be 0
                $landed = Join-Path (Join-Path (Join-Path $vault 'E--projects-demo') 'Council') 'round-1.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must find a council root under any HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "falls back to Documents/Obsidian Vault/Claude Code under HOME when the env var is unset" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'P') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'MEMORY.md'
                'note' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                # Empty string, not absent: Invoke-HookWithHome restores whatever the runner
                # had, and the operator's own session may well have this variable set.
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = '' }
                $r.ExitCode | Should -Be 0
                $docs = Join-Path (Join-Path (Join-Path $sandbox 'Documents') 'Obsidian Vault') 'Claude Code'
                $landed = Join-Path (Join-Path (Join-Path $docs 'P') 'Memory') 'MEMORY.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root's fallback must sit under the running HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    # Drives the hook's own call-site assignment (`$config = Get-ValeConfigPath`) alongside the
    # function body, not the function in isolation: a test that only lifts the function passes
    # even when the call site is reverted to the original defective form, since nothing then
    # asserts the hook actually calls it (F1).
    It "builds the Vale config path one segment at a time" {
        foreach ($root in $script:hookRoots) {
            $hook = Join-Path $root 'Lint-DocumentProse.ps1'
            $text = (Import-HookFunction -ScriptPath $hook -Name 'Get-ValeConfigPath') + "`n" +
                    (Get-VariableAssignmentText -ScriptPath $hook -Names @('config'))
            $built = Invoke-UnderPosixJoin -Expression ($text + "`n`$config") -HomeValue '/home/u'
            $built | Should -Be '/home/u/.claude/tools/prose-lint/.vale.ini' `
                -Because "$root must not put separators inside a single path segment, and must call the builder at its call site"
        }
    }

    # Same AST-scan shape as Task 2's check on Sync-MemoryToObsidian.ps1: catches a
    # reintroduced multi-argument Join-Path without needing a 5.1 interpreter on hand to
    # reproduce the silent-no-op failure it causes there.
    It "keeps every Join-Path call in Lint-DocumentProse at two arguments" {
        foreach ($root in $script:hookRoots) {
            $hook = Join-Path $root 'Lint-DocumentProse.ps1'
            $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                $hook, [ref]$null, [ref]$null)
            $calls = @($ast.FindAll({ param($n)
                        $n -is [System.Management.Automation.Language.CommandAst] -and
                        $n.GetCommandName() -eq 'Join-Path' }, $true))
            $calls.Count | Should -BeGreaterThan 0 -Because "$root must still call Join-Path somewhere for this check to mean anything"
            foreach ($call in $calls) {
                $argCount = $call.CommandElements.Count - 1
                $argCount | Should -BeLessOrEqual 2 -Because "$($call.Extent.Text) at line $($call.Extent.StartLineNumber) must nest instead of taking a third argument"
            }
        }
    }

    # Drives the hook's own call-site assignment (`$SkillRoots = @(Get-SkillRoot)`) alongside
    # the function body, not the function in isolation: a test that only lifts the function
    # passes even when the call site is reverted to the original defective form (F1).
    It "builds skill roots from HOME, and drops the bundled root when LOCALAPPDATA is unset" {
        foreach ($root in $script:hookRoots) {
            $hook = Join-Path $root 'Guard-SkillSize.ps1'
            $text = (Import-HookFunction -ScriptPath $hook -Name 'Get-SkillRoot') + "`n" +
                    (Get-VariableAssignmentText -ScriptPath $hook -Names @('SkillRoots'))
            $built = @(Invoke-UnderPosixJoin -Expression ($text + "`n@(`$SkillRoots)") `
                    -HomeValue '/home/u' -ClearEnv @('USERPROFILE', 'LOCALAPPDATA'))
            $built.Count | Should -Be 2 `
                -Because "$root has no bundled-skills root to offer when LOCALAPPDATA is unset"
            $built[0] | Should -Be '/home/u/.claude/skills'
            $built[1] | Should -Be '/home/u/.claude/plugins'

            # LOCALAPPDATA set explicitly via -SetEnv, not read from the ambient environment
            # (F2): LOCALAPPDATA is Windows-only, and this suite must discriminate the
            # LOCALAPPDATA-present case on Linux too, where the ambient variable is always
            # absent. Exact-value assertion, not a suffix match, now that the value is known.
            $win = @(Invoke-UnderPosixJoin -Expression ($text + "`n@(`$SkillRoots)") `
                    -HomeValue '/home/u' -ClearEnv @('USERPROFILE') -SetEnv @{ LOCALAPPDATA = '/x/local' })
            $win.Count | Should -Be 3
            $win[2] | Should -Be '/x/local/Temp/claude/bundled-skills' `
                -Because "$root must nest LOCALAPPDATA under Temp/claude/bundled-skills when it is present"
        }
    }

    # Same AST-scan shape as Task 2's check on Sync-MemoryToObsidian.ps1: catches a
    # reintroduced multi-argument Join-Path without needing a 5.1 interpreter on hand to
    # reproduce the silent-no-op failure it causes there.
    It "keeps every Join-Path call in Guard-SkillSize at two arguments" {
        foreach ($root in $script:hookRoots) {
            $hook = Join-Path $root 'Guard-SkillSize.ps1'
            $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                $hook, [ref]$null, [ref]$null)
            $calls = @($ast.FindAll({ param($n)
                        $n -is [System.Management.Automation.Language.CommandAst] -and
                        $n.GetCommandName() -eq 'Join-Path' }, $true))
            $calls.Count | Should -BeGreaterThan 0 -Because "$root must still call Join-Path somewhere for this check to mean anything"
            foreach ($call in $calls) {
                $argCount = $call.CommandElements.Count - 1
                $argCount | Should -BeLessOrEqual 2 -Because "$($call.Extent.Text) at line $($call.Extent.StartLineNumber) must nest instead of taking a third argument"
            }
        }
    }

    # Guard-SkillSize.ps1 shipped as UTF-8 without a byte-order mark, and Windows PowerShell
    # 5.1 decodes a BOM-less script using the system code page rather than UTF-8. Its (former)
    # em dashes decoded to a byte sequence containing a stray double quote, closing a string
    # early and cascading 14 parse errors under 5.1, while pwsh 7's copy of the same parser
    # decodes UTF-8 correctly regardless and never saw it. settings.json registers this hook
    # with "shell": "powershell", a host that may be 5.1, so a script dead there is dead on
    # that receiver no matter what Join-Path does. Runs the parse inside a real powershell.exe
    # child rather than calling [Parser]::ParseFile from this process (pwsh 7 here), since that
    # would use pwsh's own encoding-correct copy of the API and never reproduce the bug.
    It "parses Guard-SkillSize clean under Windows PowerShell 5.1" {
        if (-not (Get-Command powershell -ErrorAction SilentlyContinue)) {
            Set-ItResult -Skipped -Because 'no Windows PowerShell 5.1 available to drive this check'
            return
        }
        $sandbox = New-HookSandbox
        try {
            $probe = Join-Path $sandbox 'parse-probe.ps1'
            @'
param([string]$HookPath)
[ref]$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile($HookPath, [ref]$null, $errs) | Out-Null
$errs.Value.Count
'@ | Set-Content -LiteralPath $probe
            foreach ($root in $script:hookRoots) {
                $hook = Join-Path $root 'Guard-SkillSize.ps1'
                $errCount = & powershell -NoProfile -File $probe -HookPath $hook
                [int]$errCount | Should -Be 0 -Because "$root's Guard-SkillSize.ps1 must parse under Windows PowerShell 5.1, not only under pwsh 7"
            }
        }
        finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
    }
}
