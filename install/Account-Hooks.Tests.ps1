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
                [hashtable]$Env = @{}
            )
            $names = @(@('USERPROFILE', 'HOME') + @($Env.Keys))
            $saved = @{}
            foreach ($k in $names) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
            try {
                $env:USERPROFILE = $SandboxHome
                $env:HOME = $SandboxHome
                foreach ($k in @($Env.Keys)) { Set-Item -Path "Env:$k" -Value $Env[$k] }
                $out = @($StdinJson | pwsh -NoProfile -File $HookPath 2>&1)
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
            param([string]$Expression, [string]$HomeValue, [string[]]$ClearEnv = @())
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
            try { return (& ([scriptblock]::Create($Expression))) }
            finally {
                foreach ($k in $ClearEnv) {
                    if ($null -ne $saved[$k]) { Set-Item "Env:$k" -Value $saved[$k] }
                }
            }
        }

        function New-HookSandbox {
            $s = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-hooks-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $s -Force | Out-Null
            return $s
        }
    }

    # Every assertion below iterates $script:hookRoots. An empty list would make all of them
    # pass without evaluating anything, which is the failure patterns/test-falsifiability.md
    # names. Assert the list is populated before relying on it.
    It "resolves at least one hooks directory to run against" {
        $script:hookRoots.Count | Should -BeGreaterThan 0
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
}
