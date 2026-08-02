# install/Restore-ClaudeProject.Tests.ps1
Describe "Restore-ClaudeProject" {
    BeforeAll {
        $script:restore = "$PSScriptRoot/Restore-ClaudeProject.ps1"

        # The two interesting functions are pure, but they live inside a script that takes
        # mandatory parameters, so dot-sourcing would prompt. Lift them out via the AST instead.
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:restore, [ref]$null, [ref]$null)
        $defs = $ast.FindAll(
            { param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
        foreach ($name in 'Get-ProjectSlug', 'Convert-HookCommand') {
            $fn = $defs | Where-Object { $_.Name -eq $name } | Select-Object -First 1
            # Without this, a rename in the script leaves the function simply undefined and every
            # unit test fails with "not recognized" rather than pointing at the real cause.
            if (-not $fn) { throw "Restore-ClaudeProject.ps1 no longer defines $name" }
            . ([scriptblock]::Create($fn.Extent.Text))
        }
    }

    BeforeEach {
        $script:sandbox = Join-Path $env:TEMP ("restore-test-" + [guid]::NewGuid())
        $script:bundle = Join-Path $script:sandbox 'bundle'
        $script:repo = Join-Path $script:sandbox 'repo'
        $script:claudeHome = Join-Path $script:sandbox 'claudehome'

        New-Item -ItemType Directory "$script:bundle/repo/.git" -Force | Out-Null
        New-Item -ItemType Directory "$script:bundle/claude-project/memory" -Force | Out-Null
        New-Item -ItemType Directory "$script:bundle/claude-global/rules" -Force | Out-Null
        'ref: refs/heads/main' | Set-Content "$script:bundle/repo/.git/HEAD"
        'code'                 | Set-Content "$script:bundle/repo/main.ps1"
        '{}'                   | Set-Content "$script:bundle/claude-project/abc.jsonl"
        'note'                 | Set-Content "$script:bundle/claude-project/memory/MEMORY.md"
        'rule'                 | Set-Content "$script:bundle/claude-global/rules/style.md"

        # Git marks .git hidden on Windows, which is precisely what a wildcard copy skips.
        if ($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
            (Get-Item "$script:bundle/repo/.git" -Force).Attributes = 'Directory, Hidden'
        }
    }

    AfterEach { Remove-Item -Recurse -Force $script:sandbox -ErrorAction SilentlyContinue }

    It "derives the session slug the way Claude Code names project folders" {
        Get-ProjectSlug 'C:\temp\GHAS\GHASalerts'          | Should -Be 'C--temp-GHAS-GHASalerts'
        Get-ProjectSlug 'C:\Users\jcgam'                    | Should -Be 'C--Users-jcgam'
        Get-ProjectSlug 'E:\projects\ONI\.onimods-upstream' | Should -Be 'E--projects-ONI--onimods-upstream'
        Get-ProjectSlug '/home/jcgam/ghas'                  | Should -Be '-home-jcgam-ghas'
    }

    It "ignores a trailing separator when deriving the slug" {
        Get-ProjectSlug 'C:\temp\proj\' | Should -Be (Get-ProjectSlug 'C:\temp\proj')
    }

    It "rewrites a PowerShell hook into a pwsh invocation for Linux" {
        # On Linux the hook string goes to /bin/sh, which has no idea what '&' means here.
        $out = Convert-HookCommand "& 'C:\Users\me\.claude\hooks\Lint.ps1'" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be "pwsh -NoProfile -File '/home/me/.claude/hooks/Lint.ps1'"
    }

    It "leaves the invocation form alone for a Windows target" {
        $out = Convert-HookCommand "& 'C:\Users\me\.claude\hooks\Lint.ps1'" 'C:\Users\me\.claude' 'C:\Users\you\.claude' $true
        $out | Should -Be "& 'C:\Users\you\.claude\hooks\Lint.ps1'"
        $out | Should -Not -Match '/'   # mixed separators read as a bug even though Windows tolerates them
    }

    It "matches a hook path written with forward slashes" {
        $out = Convert-HookCommand 'node C:/Users/me/.claude/x.js' 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be 'node /home/me/.claude/x.js'
    }

    It "restores .git rather than silently dropping it" {
        # Regression: Copy-Item with a 'dir\*' wildcard skips hidden entries on Windows, which
        # produces a working tree with no history and no error anywhere.
        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null
        Test-Path "$script:repo/.git/HEAD" | Should -BeTrue
        Get-Content "$script:repo/.git/HEAD" -Raw | Should -Match 'refs/heads/main'
    }

    It "places sessions under the slug derived from the repo's final path" {
        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null
        $slug = Get-ProjectSlug (Resolve-Path $script:repo).Path
        Test-Path "$script:claudeHome/projects/$slug/abc.jsonl"        | Should -BeTrue
        Test-Path "$script:claudeHome/projects/$slug/memory/MEMORY.md" | Should -BeTrue
    }

    It "refuses to overwrite a populated repo destination without -Force" {
        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null
        { & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome } |
            Should -Throw -ExpectedMessage '*already exists and is not empty*'
    }

    It "leaves hooks and settings alone unless -IncludeHooks is given" {
        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null
        Test-Path "$script:claudeHome/hooks"        | Should -BeFalse
        Test-Path "$script:claudeHome/settings.json" | Should -BeFalse
    }

    It "rejects a source folder that is not an export bundle" {
        $empty = Join-Path $script:sandbox 'empty'
        New-Item -ItemType Directory $empty | Out-Null
        { & $script:restore -Source $empty -RepoPath $script:repo -ClaudeHome $script:claudeHome } |
            Should -Throw -ExpectedMessage "*missing 'repo'*"
    }
}
