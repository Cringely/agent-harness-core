# install/Start-CappedCopilot.Tests.ps1
Describe "Start-CappedCopilot" {
    BeforeAll {
        $script:wrapper = "$PSScriptRoot/Start-CappedCopilot.ps1"
        # Full path, so a test can empty PATH (hiding git) and still start the child.
        $script:pwshExe = (Get-Command pwsh).Source

        # Makes a link to $Target at $Link: a junction on Windows, a symlink elsewhere.
        function New-DirLink([string]$Link, [string]$Target) {
            if ($IsWindows) { New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null }
            else { New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null }
        }
        function Remove-DirLink([string]$Link) {
            [System.IO.Directory]::Delete($Link)
        }

        # A stand-in for the copilot CLI. '--help' prints a help text whose flag list the
        # STUB_HELP variable picks, so the wrapper's capability probe can be driven both ways.
        # Any other call records its argument vector as JSON and exits with STUB_EXIT.
        $script:stubSource = @'
if ($args -contains '--help') {
    $lines = @('Usage: copilot [OPTIONS] [COMMAND]')
    if ($env:STUB_HELP -ne 'nocap') {
        $lines += '      --max-ai-credits <credits>'
        $lines += '          Set max AI credits for this session'
    }
    if ($env:STUB_HELP -eq 'full') {
        $lines += '      --usage-output-file <file>'
        $lines += '          Write final usage statistics as JSON to the specified file'
    }
    $lines
    exit 0
}
ConvertTo-Json -InputObject @($args) | Set-Content -LiteralPath $env:STUB_ARGS_FILE
exit ([int]$env:STUB_EXIT)
'@

        # Runs the wrapper in a child pwsh, the way an operator launches it, so the exit code and
        # both output streams are real rather than whatever an in-process call leaves behind.
        function Invoke-Wrapper {
            param([string[]]$WrapperArgs, [string]$Help = 'full', [int]$StubExit = 0)
            $env:STUB_HELP = $Help
            $env:STUB_EXIT = "$StubExit"
            $env:STUB_ARGS_FILE = $script:argsFile
            $out = & $script:pwshExe -NoProfile -File $script:wrapper -CopilotPath $script:stub @WrapperArgs 2>&1
            [pscustomobject]@{
                Exit   = $LASTEXITCODE
                Output = (@($out) | ForEach-Object { "$_" }) -join "`n"
                Argv   = if (Test-Path -LiteralPath $script:argsFile) {
                    @(Get-Content -Raw -LiteralPath $script:argsFile | ConvertFrom-Json)
                } else { $null }
            }
        }
    }

    BeforeEach {
        $script:sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("capped-copilot-test-" + [guid]::NewGuid())
        New-Item -ItemType Directory $script:sandbox -Force | Out-Null
        $script:stub = Join-Path $script:sandbox 'copilot-stub.ps1'
        Set-Content -LiteralPath $script:stub -Value $script:stubSource
        $script:argsFile = Join-Path $script:sandbox 'argv.json'
        $script:usageDir = Join-Path $script:sandbox 'usage'
    }

    AfterEach {
        Remove-Item -Recurse -Force $script:sandbox -ErrorAction SilentlyContinue
        Remove-Item Env:STUB_HELP, Env:STUB_EXIT, Env:STUB_ARGS_FILE -ErrorAction SilentlyContinue
    }

    It "launches with the default cap and passes every other argument through in order" {
        $user = @('-p', 'hello world', '--model=claude-sonnet-5', '-s', '--allow-all-tools')
        $r = Invoke-Wrapper (@('-UsageDir', $script:usageDir) + $user)

        $r.Exit | Should -Be 0
        $r.Argv[0..1] | Should -Be @('--max-ai-credits', '500')
        $r.Argv[2] | Should -Be '--usage-output-file'
        ($r.Argv[4..($r.Argv.Count - 1)] -join '|') | Should -Be ($user -join '|')
    }

    It "takes the cap from -MaxAiCredits and accepts the documented minimum of 30" {
        $r = Invoke-Wrapper @('-MaxAiCredits', '30', '-UsageDir', $script:usageDir, '-p', 'x')
        $r.Exit | Should -Be 0
        $r.Argv[0..1] | Should -Be @('--max-ai-credits', '30')
    }

    It "refuses a cap below 30 and never launches copilot" {
        $r = Invoke-Wrapper @('-MaxAiCredits', '29', '-UsageDir', $script:usageDir)
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'minimum is 30'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "refuses a cap that is not a whole number: <Value>" -ForEach @(
        @{ Value = 'abc' }, @{ Value = '45.5' }, @{ Value = '-100' }, @{ Value = '' }
    ) {
        $r = Invoke-Wrapper @('-MaxAiCredits', $Value, '-UsageDir', $script:usageDir)
        $r.Exit | Should -Be 2
        $r.Argv | Should -BeNullOrEmpty
    }

    It "refuses -MaxAiCredits given with no value" {
        $r = Invoke-Wrapper @('-UsageDir', $script:usageDir, '-MaxAiCredits')
        $r.Exit | Should -Be 2
        $r.Argv | Should -BeNullOrEmpty
    }

    It "refuses a pass-through flag that would compete with the wrapper's own: <Flag>" -ForEach @(
        @{ Flag = @('--max-ai-credits', '9999') },
        @{ Flag = @('--max-ai-credits=9999') },
        @{ Flag = @('--usage-output-file', 'elsewhere.json') },
        @{ Flag = @('--USAGE-OUTPUT-FILE=elsewhere.json') }
    ) {
        $r = Invoke-Wrapper (@('-UsageDir', $script:usageDir, '-p', 'x') + $Flag)
        $r.Exit | Should -Be 2
        $r.Argv | Should -BeNullOrEmpty
    }

    It "writes the usage file into the usage directory, creating it" {
        $r = Invoke-Wrapper @('-UsageDir', $script:usageDir)
        $r.Exit | Should -Be 0
        $usage = $r.Argv[3]
        Split-Path -Parent $usage | Should -Be (Resolve-Path -LiteralPath $script:usageDir).Path
        $usage | Should -Match 'copilot-usage-\d{8}T\d{6}Z-\d+\.json$'
        Test-Path -LiteralPath $script:usageDir -PathType Container | Should -BeTrue
    }

    It "refuses a usage directory inside a git work tree" {
        $repo = Join-Path $script:sandbox 'repo'
        New-Item -ItemType Directory (Join-Path $repo '.git') -Force | Out-Null
        $r = Invoke-Wrapper @('-UsageDir', (Join-Path $repo 'out/usage'))
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'git work tree'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "refuses a usage directory when git fails for a reason other than not-a-repository" {
        # A stub git earlier on PATH stands in for dubious ownership / safe.directory refusals.
        $bin = Join-Path $script:sandbox 'fakebin'
        New-Item -ItemType Directory $bin -Force | Out-Null
        if ($IsWindows) {
            Set-Content -LiteralPath (Join-Path $bin 'git.cmd') -Value "@echo off`r`necho fatal: detected dubious ownership in repository 1>&2`r`nexit /b 128"
        } else {
            $g = Join-Path $bin 'git'
            Set-Content -LiteralPath $g -Value "#!/bin/sh`necho 'fatal: detected dubious ownership in repository' >&2`nexit 128"
            & chmod +x $g
        }
        $savedPath = $env:PATH
        try {
            $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$savedPath"
            $r = Invoke-Wrapper @('-UsageDir', $script:usageDir)
        } finally {
            $env:PATH = $savedPath
        }
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'dubious ownership'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "allows a usage directory outside any repository when the caller's locale is not English" {
        # A stub git that answers in English only under LC_ALL=C and in German otherwise, as a
        # translated git does. The wrapper must pin the locale for its git call.
        $bin = Join-Path $script:sandbox 'localebin'
        New-Item -ItemType Directory $bin -Force | Out-Null
        if ($IsWindows) {
            Set-Content -LiteralPath (Join-Path $bin 'git.cmd') -Value "@echo off`r`nif `"%LC_ALL%`"==`"C`" (echo fatal: not a git repository 1>&2) else (echo fatal: kein Git-Repository 1>&2)`r`nexit /b 128"
        } else {
            $g = Join-Path $bin 'git'
            Set-Content -LiteralPath $g -Value "#!/bin/sh`nif [ `"`$LC_ALL`" = C ]; then echo 'fatal: not a git repository' >&2; else echo 'fatal: kein Git-Repository' >&2; fi`nexit 128"
            & chmod +x $g
        }
        $savedPath = $env:PATH; $savedAll = $env:LC_ALL; $savedLang = $env:LANGUAGE
        try {
            $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$savedPath"
            $env:LC_ALL = 'de_DE.UTF-8'
            $env:LANGUAGE = 'de'
            $r = Invoke-Wrapper @('-UsageDir', $script:usageDir)
        } finally {
            $env:PATH = $savedPath; $env:LC_ALL = $savedAll; $env:LANGUAGE = $savedLang
        }
        $r.Exit | Should -Be 0
        $r.Argv | Should -Not -BeNullOrEmpty
    }
    It "refuses a usage directory reached through a symlink into a git work tree" -Skip:($IsWindows) {
        $repo = Join-Path $script:sandbox 'srepo'
        New-Item -ItemType Directory (Join-Path $repo 'sub') -Force | Out-Null
        git -C $repo init -q
        $link = Join-Path $script:sandbox 'slink'
        New-Item -ItemType SymbolicLink -Path $link -Target (Join-Path $repo 'sub') | Out-Null
        $r = Invoke-Wrapper @('-UsageDir', (Join-Path $link 'usage'))
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'git work tree'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "refuses a usage directory reached through a junction into a git work tree" -Skip:(-not $IsWindows) {
        $repo = Join-Path $script:sandbox 'jrepo'
        New-Item -ItemType Directory (Join-Path $repo 'sub') -Force | Out-Null
        git -C $repo init -q
        $link = Join-Path $script:sandbox 'link'
        New-Item -ItemType Junction -Path $link -Target (Join-Path $repo 'sub') | Out-Null
        try {
            $r = Invoke-Wrapper @('-UsageDir', (Join-Path $link 'usage'))
        } finally {
            [System.IO.Directory]::Delete($link)
        }
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'git work tree'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "refuses a usage directory reached through a link into a repository when git is not on PATH" {
        $repo = Join-Path $script:sandbox 'nogit-repo'
        New-Item -ItemType Directory (Join-Path $repo 'sub') -Force | Out-Null
        New-Item -ItemType Directory (Join-Path $repo '.git') -Force | Out-Null
        $link = Join-Path $script:sandbox 'nogit-link'
        New-DirLink $link (Join-Path $repo 'sub')
        $empty = Join-Path $script:sandbox 'emptybin'
        New-Item -ItemType Directory $empty -Force | Out-Null
        $savedPath = $env:PATH
        try {
            $env:PATH = $empty
            $r = Invoke-Wrapper @('-UsageDir', (Join-Path $link 'usage'))
        } finally {
            $env:PATH = $savedPath
            Remove-DirLink $link
        }
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'git work tree'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "allows a plain usage directory when git is not on PATH" {
        $empty = Join-Path $script:sandbox 'emptybin2'
        New-Item -ItemType Directory $empty -Force | Out-Null
        $savedPath = $env:PATH
        try {
            $env:PATH = $empty
            $r = Invoke-Wrapper @('-UsageDir', $script:usageDir)
        } finally {
            $env:PATH = $savedPath
        }
        $r.Exit | Should -Be 0
    }

    It "is not redirected by an inherited GIT_DIR when judging a linked usage directory" {
        $repo = Join-Path $script:sandbox 'env-repo'
        New-Item -ItemType Directory (Join-Path $repo 'sub') -Force | Out-Null
        git -C $repo init -q
        $bare = Join-Path $script:sandbox 'env-bare.git'
        git init -q --bare $bare
        $link = Join-Path $script:sandbox 'env-link'
        New-DirLink $link (Join-Path $repo 'sub')
        $savedGitDir = $env:GIT_DIR
        try {
            # Pointing git at a bare repository makes it answer "false" for any directory.
            $env:GIT_DIR = $bare
            $r = Invoke-Wrapper @('-UsageDir', (Join-Path $link 'usage'))
        } finally {
            $env:GIT_DIR = $savedGitDir
            Remove-DirLink $link
        }
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'git work tree'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "defaults the usage directory to a per-user location outside this repo" {
        # The wrapper reads LOCALAPPDATA first, so point it at TestDrive: the run must not create
        # agent-harness/copilot-usage under the real local application data folder.
        $fakeBase = Join-Path $TestDrive 'localappdata'
        $saved = $env:LOCALAPPDATA
        try {
            $env:LOCALAPPDATA = $fakeBase
            $r = Invoke-Wrapper @('-p', 'x')
        } finally {
            if ($null -eq $saved) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $saved }
        }
        $r.Exit | Should -Be 0
        $usage = $r.Argv[3]
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        $usage.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) | Should -BeFalse
        $usage.StartsWith((Join-Path $fakeBase 'agent-harness'), [System.StringComparison]::OrdinalIgnoreCase) |
            Should -BeTrue
        (Split-Path -Parent $usage) | Should -Be (Join-Path (Join-Path $fakeBase 'agent-harness') 'copilot-usage')
    }

    It "launches capped without a usage file when the CLI lacks --usage-output-file" {
        $r = Invoke-Wrapper @('-UsageDir', $script:usageDir, '-p', 'x') -Help 'nousage'
        $r.Exit | Should -Be 0
        ($r.Argv -join '|') | Should -Be '--max-ai-credits|500|-p|x'
        $r.Output | Should -Match 'usage-output-file'
    }

    It "refuses to launch when the CLI lacks --max-ai-credits" {
        $r = Invoke-Wrapper @('-UsageDir', $script:usageDir, '-p', 'x') -Help 'nocap'
        $r.Exit | Should -Be 2
        $r.Output | Should -Match 'max-ai-credits'
        $r.Argv | Should -BeNullOrEmpty
    }

    It "returns the CLI's exit code" {
        $r = Invoke-Wrapper @('-UsageDir', $script:usageDir) -StubExit 7
        $r.Exit | Should -Be 7
    }

    It "prints no token value present in the environment" {
        $sentinel = 'sentinel-' + [guid]::NewGuid()
        $saved = @{}
        foreach ($n in 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN') {
            $saved[$n] = [Environment]::GetEnvironmentVariable($n)
            [Environment]::SetEnvironmentVariable($n, $sentinel)
        }
        try {
            $ok = Invoke-Wrapper @('-UsageDir', $script:usageDir, '-p', 'x')
            $bad = Invoke-Wrapper @('-MaxAiCredits', '1', '-UsageDir', $script:usageDir)
        } finally {
            foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
        }
        $ok.Output | Should -Not -Match $sentinel
        $bad.Output | Should -Not -Match $sentinel
    }

    It "never reads a token: the script names no token variable or token command" {
        $text = Get-Content -Raw -LiteralPath $script:wrapper
        $text | Should -Not -Match 'GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|auth\s+token'
    }
}
