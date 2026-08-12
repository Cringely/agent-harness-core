# install/Restore-ClaudeProject.Tests.ps1
Describe "Restore-ClaudeProject" {
    BeforeAll {
        $script:restore = "$PSScriptRoot/Restore-ClaudeProject.ps1"

        # These functions are pure, but they live inside a script that takes mandatory parameters,
        # so dot-sourcing would prompt. Lift them out via the AST instead.
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:restore, [ref]$null, [ref]$null)
        $defs = $ast.FindAll(
            { param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
        foreach ($name in 'Get-ProjectSlug', 'Convert-HookCommand', 'Test-ResidualWindowsPath') {
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

    It "falls back to Resolve-Path when realpath answers with more than one line" {
        # Regression: the result was consumed without a shape check, and PowerShell hands back a
        # bare string for one output line but an object array for more than one. The array then
        # bound to Get-ProjectSlug's [string] parameter as its elements joined by a space, so a
        # two-line answer produced the session folder '-fake-one--fake-two' -- a plausible-looking
        # wrong slug at exit 0, which is the same silent failure the exit-code check next to it
        # already guards against. Reproduced against the unguarded script before the fix.
        #
        # The stand-in stands for a non-coreutils realpath on PATH: a busybox applet, or a wrapper
        # script that prints a notice line ahead of the answer. Coreutils given one operand answers
        # in one line, so nothing on a healthy box reaches this.
        $fakeBinDir = Join-Path $script:sandbox 'fakebin-multiline'
        New-Item -ItemType Directory $fakeBinDir -Force | Out-Null
        if ($IsWindows -or $PSVersionTable.PSVersion.Major -lt 6) {
            # -TargetIsWindows:$false drives the Linux branch from a Windows host, and Get-Command
            # resolves a .cmd through PATHEXT, so this case actually executes here rather than
            # joining the -Skip'd ones. A .sh stand-in would need chmod and could not run.
            "@echo off`r`necho /fake/one`r`necho /fake/two`r`nexit /b 0" |
                Set-Content "$fakeBinDir/realpath.cmd"
        }
        else {
            "#!/bin/sh`nprintf '%s\n' /fake/one /fake/two`nexit 0" |
                Set-Content "$fakeBinDir/realpath" -NoNewline
            chmod +x "$fakeBinDir/realpath"
        }

        $oldPath = $env:PATH
        try {
            $env:PATH = $fakeBinDir + [System.IO.Path]::PathSeparator + $oldPath
            $out = & $script:restore -Source $script:bundle -RepoPath $script:repo `
                -ClaudeHome $script:claudeHome -TargetIsWindows:$false 6>&1 | Out-String
        }
        finally {
            $env:PATH = $oldPath
        }

        # First, because it names the defect directly: the space-joined slug is the whole tell, and
        # a runner that stops the case at its first failed assertion should report that one.
        $out | Should -Not -Match 'Session folder  : -fake-one--fake-two'

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

    It "previews the slug for the absolute repo path when -RepoPath is relative" {
        # Regression: step 1's copy is ShouldProcess-gated, so under -WhatIf the destination is
        # never created and the slug fell through to the raw relative string. The preview then
        # named a session folder no real run would ever create, which defeats the point of -WhatIf.
        Push-Location $script:sandbox
        try {
            $expected = Get-ProjectSlug (Join-Path (Get-Location).Path 'relrepo')
            $out = & $script:restore -Source $script:bundle -RepoPath 'relrepo' `
                -ClaudeHome $script:claudeHome -WhatIf 6>&1 | Out-String
        }
        finally { Pop-Location }

        $out | Should -Match ([regex]::Escape("Session folder  : $expected"))
        $out | Should -Not -Match 'Session folder  : relrepo'
    }

    It "treats a leftover Windows path in a rewritten command as still needing hands" {
        # Regression: step 6 scanned hook script files only, so a command string that
        # Convert-HookCommand left half-converted (a second, unrelated Windows path sharing the
        # command) came out of a run with nothing reported anywhere.
        Test-ResidualWindowsPath "pwsh -NoProfile -File '/home/me/.claude/hooks/Lint.ps1'" | Should -BeFalse
        Test-ResidualWindowsPath 'pwsh /home/me/.claude/x.ps1 && C:\tools\foo.exe'          | Should -BeTrue
        Test-ResidualWindowsPath 'sh -c "$USERPROFILE/.claude/x.sh"'                        | Should -BeTrue
        Test-ResidualWindowsPath ''                                                         | Should -BeFalse
    }

    It "names a settings.json command that still carries a Windows path, at its real JSON path" {
        # Windows-target runs are excluded from the whole step 6 scan, since a C:\ path is correct
        # there, so this asserts against a Linux target. -TargetIsWindows drives that from whatever
        # host runs the suite; this case used to be -Skip'd on Windows and no Linux CI exists, so
        # it had never executed anywhere and the branch it covers was shipping untested.
        #
        # The fixture puts two hooks under one matcher and then a second matcher on purpose. A
        # single matcher holding a single hook is the one shape where a flat per-event counter and
        # a real matcher index agree, so a fixture built that way passes against either spelling
        # and measures nothing.
        $exported = @{
            hooks = @{
                PreToolUse = @(
                    @{ matcher = 'Bash'; hooks = @(
                            @{ type = 'command'; command = "pwsh 'C:\Users\me\.claude\hooks\Lint.ps1' && C:\tools\foo.exe" }
                            @{ type = 'command'; command = "pwsh 'C:\Users\me\.claude\hooks\Guard.ps1' && C:\tools\bar.exe" }) }
                    @{ matcher = 'Write'; hooks = @(
                            @{ type = 'command'; command = "pwsh 'C:\Users\me\.claude\hooks\Sync.ps1' && C:\tools\baz.exe" }) })
            }
        }
        $exported | ConvertTo-Json -Depth 20 | Set-Content "$script:bundle/claude-global/settings.json.exported"

        $out = & $script:restore -Source $script:bundle -RepoPath $script:repo `
            -ClaudeHome $script:claudeHome -IncludeHooks -TargetIsWindows:$false 3>&1 6>&1 | Out-String

        $out | Should -Match ([regex]::Escape('hooks.PreToolUse[0].hooks[0].command'))
        $out | Should -Match ([regex]::Escape('hooks.PreToolUse[0].hooks[1].command'))
        $out | Should -Match ([regex]::Escape('hooks.PreToolUse[1].hooks[0].command'))

        # The flat spelling rendered these as hooks.PreToolUse[0..2].command, so an index sitting
        # directly before '.command' is the tell, and [2] names a matcher the file does not have.
        $out | Should -Not -Match 'hooks\.PreToolUse\[\d+\]\.command'
        $out | Should -Not -Match 'hooks\.PreToolUse\[2\]'
    }

    It "reports settings.json as not rewritten when the source home cannot be detected" {
        # Regression: -IncludeHooks against an exported settings.json carrying no drive path warned
        # once, skipped the rewrite, then exited 0 through a verification table that never
        # mentioned settings.json, so the run read as clean.
        '{ "hooks": {} }' | Set-Content "$script:bundle/claude-global/settings.json.exported"

        $out = & $script:restore -Source $script:bundle -RepoPath $script:repo `
            -ClaudeHome $script:claudeHome -IncludeHooks -WarningAction SilentlyContinue 6>&1 | Out-String

        $out | Should -Match '\[--\] settings\.json rewritten'
    }

    It "reports settings.json as rewritten only when -IncludeHooks asked for one" {
        $exported = @{
            hooks = @{
                PreToolUse = @(
                    @{ matcher = ''; hooks = @(
                            @{ type = 'command'; command = "& 'C:\Users\me\.claude\hooks\Lint.ps1'" }) })
            }
        }
        $exported | ConvertTo-Json -Depth 20 | Set-Content "$script:bundle/claude-global/settings.json.exported"

        $withHooks = & $script:restore -Source $script:bundle -RepoPath $script:repo `
            -ClaudeHome $script:claudeHome -IncludeHooks 6>&1 | Out-String
        $withHooks | Should -Match '\[ok\] settings\.json rewritten'

        # Without -IncludeHooks no rewrite was ever asked for, so the row would be noise.
        $plain = & $script:restore -Source $script:bundle -RepoPath (Join-Path $script:sandbox 'repo2') `
            -ClaudeHome $script:claudeHome 6>&1 | Out-String
        $plain | Should -Not -Match 'settings\.json rewritten'
    }

    It "repoints core.hooksPath when it names a source-machine directory that is now missing" {
        # Regression: .git/config is copied byte for byte, so core.hooksPath survived the move
        # pointing at the source machine. Git skips a hooks directory that does not exist without
        # a word, so the repo's pre-commit hook stops running and nothing says why.
        $stale = Join-Path $script:sandbox 'gone/.claude/hooks'
        New-Item -ItemType Directory "$script:bundle/repo/.claude/hooks" -Force | Out-Null
        'hook' | Set-Content "$script:bundle/repo/.claude/hooks/pre-commit"
        & git init -q "$script:bundle/repo" 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
        & git -C "$script:bundle/repo" config core.hooksPath $stale
        $LASTEXITCODE | Should -Be 0

        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null

        $got = & git -C $script:repo config --get core.hooksPath
        $LASTEXITCODE | Should -Be 0
        $got | Should -Be (Resolve-Path "$script:repo/.claude/hooks").Path
    }

    It "leaves core.hooksPath alone when the directory it names still exists" {
        # The rewrite must not steal a repo that deliberately points core.hooksPath elsewhere.
        # This one is spelled as a .claude/hooks path too, so only the existence check separates it
        # from the case above.
        $keep = Join-Path $script:sandbox 'other/.claude/hooks'
        New-Item -ItemType Directory $keep -Force | Out-Null
        New-Item -ItemType Directory "$script:bundle/repo/.claude/hooks" -Force | Out-Null
        & git init -q "$script:bundle/repo" 2>&1 | Out-Null
        & git -C "$script:bundle/repo" config core.hooksPath $keep
        $LASTEXITCODE | Should -Be 0

        & $script:restore -Source $script:bundle -RepoPath $script:repo -ClaudeHome $script:claudeHome | Out-Null

        (& git -C $script:repo config --get core.hooksPath) | Should -Be $keep
    }

    It "keeps the test seam named-only, and pins the positional mapping it nearly changed" {
        # PowerShell hands out positional slots in declaration order to every non-switch parameter
        # that does not declare one. That is how -TargetIsWindows became slot 5 the moment it was
        # added: a sixth positional argument stopped being a binding error and started choosing the
        # target platform, with the script then running to a wrong answer at exit 0. Explicit
        # Position values on the real parameters turn the auto-assignment off, so anything without
        # one is named-only. Assert the whole table, because the failure mode is a parameter added
        # later quietly picking up slot 5 again.
        $params = (Get-Command $script:restore).Parameters
        $positional = $params.Values |
            Where-Object { $_.Attributes.Position -ge 0 } |
            ForEach-Object { "$($_.Name)=$(($_.Attributes | Where-Object Position -ge 0).Position)" } |
            Sort-Object

        ($positional -join ',') | Should -Be 'ClaudeHome=4,RepoPath=1,Slug=2,Source=0,SourceHome=3'

        # Named-only, and still bindable by name, which the Linux-branch tests depend on.
        $params['TargetIsWindows'].Attributes.Position | Should -Be ([int]::MinValue)
        { & $script:restore -Source $script:bundle -RepoPath $script:repo `
                -ClaudeHome $script:claudeHome -TargetIsWindows $false -WhatIf } | Should -Not -Throw
    }
}
