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
        $script:sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("restore-test-" + [guid]::NewGuid())
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
        Get-ProjectSlug 'C:\Users\user'                    | Should -Be 'C--Users-user'
        Get-ProjectSlug 'E:\projects\ONI\.onimods-upstream' | Should -Be 'E--projects-ONI--onimods-upstream'
        Get-ProjectSlug '/home/user/ghas'                  | Should -Be '-home-user-ghas'
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

    It "makes a repo's own git hook executable regardless of -IncludeHooks" -Skip:($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
        # core.hooksPath commonly points at .claude/hooks, and git hook filenames (pre-commit,
        # pre-push, ...) carry no extension. A restore that only chmod'd *.sh under the separate
        # ~/.claude/hooks tree would leave this at 644, and git skips a non-executable hook
        # silently rather than failing the commit -- so this must not depend on -IncludeHooks,
        # which governs only the ~/.claude/hooks restore, not the repo tree copied in step 1.
        New-Item -ItemType Directory "$script:bundle/repo/.claude/hooks" -Force | Out-Null
        "#!/bin/sh`nexit 0" | Set-Content "$script:bundle/repo/.claude/hooks/pre-commit" -NoNewline
        chmod 644 "$script:bundle/repo/.claude/hooks/pre-commit"

        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null

        (Get-Item "$script:repo/.claude/hooks/pre-commit").UnixMode | Should -Match '^-rwx'
    }

    It "does not mangle a non-path backslash while still rewriting a residual Windows path" {
        # Regression: a blanket backslash-to-slash replace corrupts things like a sed expression
        # that happens to share the command string with an unrelated Windows path.
        $out = Convert-HookCommand "sed 's/\n/ /g' C:\Users\me\.claude\x" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be "sed 's/\n/ /g' /home/me/.claude/x"
    }

    It "truncates a slug past 200 characters the way Claude Code does, with a hash suffix" {
        # Reference value extracted from the installed claude-code bundle's r0()/Nat() functions
        # and independently reproduced under node for this exact 224-character input.
        $long = '/home/cringely/projects/' + ('a' * 200)
        $expected = '-home-cringely-projects-' + ('a' * 176) + '-g1dlmi'
        Get-ProjectSlug $long | Should -Be $expected
    }

    It "slugs a symlinked -RepoPath by its resolved target, not the link path" -Skip:($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
        # Resolve-Path does not follow symlinks on Linux, but Claude Code slugs realpathSync(cwd).
        # A symlinked -RepoPath would otherwise land sessions under a slug claude never creates.
        $real = Join-Path $script:sandbox 'real-repo'
        New-Item -ItemType Directory $real -Force | Out-Null
        New-Item -ItemType SymbolicLink -Path $script:repo -Target $real | Out-Null

        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null

        $slug = Get-ProjectSlug $real
        Test-Path "$script:claudeHome/projects/$slug/abc.jsonl" | Should -BeTrue
    }
}
