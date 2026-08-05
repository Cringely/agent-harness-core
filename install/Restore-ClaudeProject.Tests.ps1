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

    It "falls back to Resolve-Path when realpath is on PATH but fails" -Skip:($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
        # Regression: an unchecked realpath failure left $resolvedRepo $null, Get-ProjectSlug $null
        # came back empty, and sessions landed at <ClaudeHome>/projects/ -- silently, at exit 0.
        # A fake realpath earlier on PATH stands in for a real-world failure (permission denied,
        # a dangling link mid-chain) that the coreutils binary itself would rarely hit here.
        $fakeBinDir = Join-Path $script:sandbox 'fakebin'
        New-Item -ItemType Directory $fakeBinDir -Force | Out-Null
        "#!/bin/sh`nexit 1" | Set-Content "$fakeBinDir/realpath" -NoNewline
        chmod +x "$fakeBinDir/realpath"

        $oldPath = $env:PATH
        try {
            $env:PATH = $fakeBinDir + [System.IO.Path]::PathSeparator + $oldPath
            & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null
        }
        finally {
            $env:PATH = $oldPath
        }

        $slug = Get-ProjectSlug (Resolve-Path $script:repo).Path
        Test-Path "$script:claudeHome/projects/$slug/abc.jsonl" | Should -BeTrue
    }

    It "keeps a path segment containing a space intact when rewriting a hook command" {
        # Regression: the continuation regex stopped at the first space, so a quoted path with a
        # space in it (a very ordinary thing for a Windows path to have) came out half-converted.
        $out = Convert-HookCommand "pwsh 'C:\Users\me\.claude\My Hooks\run.ps1'" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be "pwsh '/home/me/.claude/My Hooks/run.ps1'"
    }

    It "leaves a sibling directory that merely starts with OldHome untouched" {
        # Regression: .claude-backup shares the literal text 'C:\Users\me\.claude' as a prefix but
        # is a different directory. Rewriting just the shared prefix produced mixed separators;
        # the fix requires a separator/quote/space/end boundary right after OldHome, so this whole
        # occurrence is left alone instead of half-rewritten.
        $out = Convert-HookCommand "cat 'C:\Users\me\.claude-backup\hooks\A.ps1'" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be "cat 'C:\Users\me\.claude-backup\hooks\A.ps1'"
    }

    It "replaces a case-folding Unicode character the way JavaScript's ordinal regex would" {
        # Regression: PowerShell's -replace is case-insensitive by default, and .NET's IgnoreCase
        # regex folds U+212A KELVIN SIGN onto ASCII 'k', so '[^A-Za-z0-9]' let it through
        # unreplaced. Claude Code's JS regex carries no /i flag and is ordinal, so it always
        # replaces it. Reference value cross-checked under node.
        $kelvin = [char]0x212A
        Get-ProjectSlug "/tmp/x${kelvin}y" | Should -Be '-tmp-x-y'
    }

    It "only makes the bundle's own hook files executable, not siblings or pre-existing files" -Skip:($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
        # Regression: scanning the destination directory recursively with no extension filter also
        # chmod'd files the bundle never shipped (a .ts hook meant to run through an interpreter,
        # an unrelated README.md) and files already sitting in the destination from an earlier
        # restore that this run's Copy-Tree never touched.
        New-Item -ItemType Directory "$script:bundle/repo/.claude/hooks" -Force | Out-Null
        "#!/bin/sh`nexit 0" | Set-Content "$script:bundle/repo/.claude/hooks/pre-commit" -NoNewline
        "console.log(1)"    | Set-Content "$script:bundle/repo/.claude/hooks/lint.ts" -NoNewline
        "# readme"           | Set-Content "$script:bundle/repo/.claude/hooks/README.md" -NoNewline
        chmod 644 "$script:bundle/repo/.claude/hooks/pre-commit"
        chmod 644 "$script:bundle/repo/.claude/hooks/lint.ts"
        chmod 644 "$script:bundle/repo/.claude/hooks/README.md"

        New-Item -ItemType Directory "$script:repo/.claude/hooks" -Force | Out-Null
        "old" | Set-Content "$script:repo/.claude/hooks/not-from-bundle.md" -NoNewline
        chmod 644 "$script:repo/.claude/hooks/not-from-bundle.md"

        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome -Force | Out-Null

        (Get-Item "$script:repo/.claude/hooks/pre-commit").UnixMode         | Should -Match '^-rwx'
        (Get-Item "$script:repo/.claude/hooks/lint.ts").UnixMode           | Should -Not -Match '^-rwx'
        (Get-Item "$script:repo/.claude/hooks/README.md").UnixMode         | Should -Not -Match '^-rwx'
        (Get-Item "$script:repo/.claude/hooks/not-from-bundle.md").UnixMode | Should -Not -Match '^-rwx'
    }

    It "rewrites a bare path followed by a common shell metacharacter, and still protects a sibling" {
        # Regression: the original boundary assertion only allowed a separator, quote, whitespace,
        # or end of string right after $OldHome, so 'cd C:\...\.claude; pwsh ...' -- $OldHome
        # followed by a semicolon -- silently kept its Windows path on a Linux target. The fix adds
        # a short, deliberately non-exhaustive allowlist of common shell metacharacters rather than
        # a denylist of "identifier characters": a denylist was tried and reverted because '.' is
        # not an identifier character either, and it silently rewrote .claude.bak as though it were
        # .claude (in addition to still correctly leaving .claude-backup, a hyphen sibling, alone).
        $out = Convert-HookCommand "cd C:\Users\me\.claude; pwsh " 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be "cd /home/me/.claude; pwsh "

        foreach ($c in ';', ',', ')', '&', '|', '<', '>') {
            $got = Convert-HookCommand "C:\Users\me\.claude$c" 'C:\Users\me\.claude' '/home/me/.claude' $false
            $got | Should -Be "/home/me/.claude$c" -Because "'$c' is in the allowlist and should terminate the match"
        }

        # Punctuation outside that short allowlist is left alone rather than guessed at -- failing
        # safe with a visible, unconverted Windows path instead of risking another silent wrong one.
        foreach ($c in ':', '=', '?', '*', '#', '!', '}', ']', '%', '@', '+', '~', '^') {
            $got = Convert-HookCommand "C:\Users\me\.claude$c" 'C:\Users\me\.claude' '/home/me/.claude' $false
            $got | Should -Be "C:\Users\me\.claude$c" -Because "'$c' is outside the allowlist and must not be guessed at"
        }

        $hyphenSibling = Convert-HookCommand "cat 'C:\Users\me\.claude-backup\hooks\A.ps1'" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $hyphenSibling | Should -Be "cat 'C:\Users\me\.claude-backup\hooks\A.ps1'"

        $dotSibling = Convert-HookCommand "cat 'C:\Users\me\.claude.bak\hooks\A.ps1'" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $dotSibling | Should -Be "cat 'C:\Users\me\.claude.bak\hooks\A.ps1'"
    }

    It "does not corrupt an unrelated backslash sharing a wider quoted region with a path" {
        # This is the guard that would have caught the merge blocker that came back: an earlier
        # attempt let a match's tail run all the way to its enclosing quote's close, so it could
        # recognize a path merely inside a wider quote (sh -c 'pwsh C:\...\path'). That also
        # extended the tail across anything else sharing the same quoted region, so a sed
        # expression in the same command lost its escape: 's/\n/ /g' became 's//n/ /g'. Reverted in
        # favor of the narrower, safer rule: only a quote immediately before $OldHome counts.
        $out = Convert-HookCommand "sh -c ""pwsh C:\Users\me\.claude\a.ps1 && sed 's/\n/ /g'""" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be "sh -c ""pwsh /home/me/.claude/a.ps1 && sed 's/\n/ /g'"""
    }

    It "pins a known, deliberately unfixed limitation: a path inside a wider quote keeps one backslash" {
        # Not a target for a future fix without also re-solving the corruption above: recognizing
        # this case needs quote-region tracking, and two attempts at that each traded this mild,
        # visible defect for the more severe one pinned in the test above. If this assertion ever
        # needs to change, the sed-corruption guard above needs to still pass afterward.
        $out = Convert-HookCommand "sh -c 'pwsh C:\Users\me\.claude\My Hooks\run.ps1'" 'C:\Users\me\.claude' '/home/me/.claude' $false
        $out | Should -Be "sh -c 'pwsh /home/me/.claude/My Hooks\run.ps1'"
    }
}
