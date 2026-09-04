# install/Export-Account.Tests.ps1
Describe "Export-Account" {
    BeforeAll {
        $script:export = "$PSScriptRoot/Export-Account.ps1"
        $script:shared = "$PSScriptRoot/AccountShared.ps1"

        # Plants a stand-in ~/.claude holding one file of every shape the exporter has a rule
        # about. No test asserts a count against the operator's live ~/.claude, which moves
        # under any session that edits it.
        function New-StandInHome {
            $standHome = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-export-" + [guid]::NewGuid())
            $claude = Join-Path $standHome '.claude'
            foreach ($d in 'rules', 'agents', 'hooks', 'tools/prose-lint/styles/Cringely',
                'skills/prose-lint', 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $claude $d) -Force | Out-Null
            }
            'rule body'                | Set-Content (Join-Path $claude 'rules/security.md')
            'stale backup'             | Set-Content (Join-Path $claude 'rules/security.md.bak.20260101-000000')
            'agent def'                | Set-Content (Join-Path $claude 'agents/appsec-sme.md')
            'StylesPath = styles'      | Set-Content (Join-Path $claude 'tools/prose-lint/.vale.ini')
            'rule yaml'                | Set-Content (Join-Path $claude 'tools/prose-lint/styles/Cringely/X.yml')
            'core owned'               | Set-Content (Join-Path $claude 'hooks/model-tier-gate.ts')
            'internal traffic'         | Set-Content (Join-Path $claude 'hooks/Guard-ModelTier.HANDOFF.md')
            'ps statusline'            | Set-Content (Join-Path $claude 'statusline-command.ps1')
            'sh statusline'            | Set-Content (Join-Path $claude 'statusline-command.sh')
            'local override'           | Set-Content (Join-Path $claude 'settings.local.json')

            # All six rows of $AccountTemplatedFiles, each carrying a foldable literal. The fold
            # pass throws on a row it cannot find, by design, so a fixture missing any of them
            # takes down every other test in this file rather than failing one.
            "Core repo: E:\projects\agent-harness-core"                    | Set-Content (Join-Path $claude 'rules/harness-core.md')
            "the core at E:\projects\agent-harness-core"                   | Set-Content (Join-Path $claude 'hooks/harness-core-reminder.sh')
            "vale --config `"$($claude -replace '/', '\')\tools\prose-lint\.vale.ini`"" |
                Set-Content (Join-Path $claude 'skills/prose-lint/SKILL.md')
            'write to C:\vault\Handoffs\x.md'                              | Set-Content (Join-Path $claude 'skills/handoff/SKILL.md')
            # Foldable under the exporter's default -HomeSlug, which is Get-ProjectSlug $HOME.
            # Same -creplace, inlined, because this fixture runs before AccountShared is loaded.
            $slugLiteral = $HOME.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
            "home folder is $slugLiteral"                                  | Set-Content (Join-Path $claude 'skills/council/SKILL.md')
            "$slugLiteral and C:\vault\Handoffs"                           | Set-Content (Join-Path $claude 'skills/subagent-prompting/SKILL.md')

            # A real $patterns block, not a stub. Get-SecretPattern lifts this table out of the
            # STAND-IN hook, not the live one, and throws when the AST has no such assignment,
            # which would take Task 7's three tests and both round-trip tests with it. Two rows
            # is enough, and the sk_ rule is the one the planted-token test depends on.
            @'
$patterns = @(
    @{ Name = 'API token (tk_/sk_/ak_)'; Regex = '(?<![a-zA-Z0-9_])(tk_|sk_|ak_)[a-zA-Z0-9]{10,}' }
    @{ Name = 'AWS-style key';           Regex = 'AKIA[0-9A-Z]{16}' }
)
exit 0
'@ | Set-Content (Join-Path $claude 'hooks/Scan-MemorySecrets.ps1')

            # Two things the allowlist must leave behind: a directory nobody named, and a
            # credential sitting at the account root.
            New-Item -ItemType Directory -Path (Join-Path $claude 'shell-snapshots') -Force | Out-Null
            'runtime state'            | Set-Content (Join-Path $claude 'shell-snapshots/snap-1.ps1')
            '{"token":"x"}'            | Set-Content (Join-Path $claude '.credentials.json')

            return $standHome
        }

        function New-OutputRoot {
            Join-Path ([System.IO.Path]::GetTempPath()) ("acct-out-" + [guid]::NewGuid())
        }
    }

    It "lifts all three path functions out of Restore-ClaudeProject.ps1" {
        # A rename in Restore would otherwise leave both new scripts calling an undefined
        # function at run time, with no signal until someone ran an export.
        { . $script:shared } | Should -Not -Throw
        . $script:shared
        (Get-Command Get-ProjectSlug -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
        (Get-Command Test-ResidualWindowsPath -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
        (Get-Command Convert-HookCommand -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
        Get-ProjectSlug 'C:\Users\user' | Should -Be 'C--Users-user'
        Get-ProjectSlug '/home/u' | Should -Be '-home-u'
    }

    It "resolves the main checkout from a worktree as well as from the checkout itself" {
        . $script:shared
        $main = Get-MainCheckout -StartDir (Split-Path $PSScriptRoot -Parent)
        $main | Should -Not -Match '\\'
        Test-Path -LiteralPath (Join-Path $main 'CONTRIBUTING.md') | Should -BeTrue
        # Assert the returned path is not itself a worktree. Testing whether the main checkout
        # CONTAINS a worktrees directory is a different question and the wrong one: this repo's
        # own write-agent gate puts checkouts under .claude/worktrees/, so that directory is
        # present in the main checkout and the assertion would be red on a healthy tree.
        $main | Should -Not -Match '(?i)worktrees' `
            -Because "a worktree path would mean the fold folds the wrong literal"
    }

    It "copies only the allowlisted tree and drops .bak, core-owned and handoff files" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null

            Test-Path -LiteralPath (Join-Path $out 'rules/security.md')                 | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'agents/appsec-sme.md')              | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'skills/prose-lint/SKILL.md')        | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'tools/prose-lint/.vale.ini')        | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'tools/prose-lint/styles/Cringely/X.yml') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'hooks/Scan-MemorySecrets.ps1')      | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'statusline-command.ps1')            | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'statusline-command.sh')             | Should -BeTrue

            Test-Path -LiteralPath (Join-Path $out 'rules/security.md.bak.20260101-000000') |
                Should -BeFalse -Because "change-management.md mints one .bak per edit and none belong in the repo"
            Test-Path -LiteralPath (Join-Path $out 'hooks/model-tier-gate.ts') |
                Should -BeFalse -Because "core/claude/hooks/model-tier-gate.ts is the authoritative copy"
            Test-Path -LiteralPath (Join-Path $out 'hooks/Guard-ModelTier.HANDOFF.md') |
                Should -BeFalse -Because "handoffs are internal agent traffic"
            Test-Path -LiteralPath (Join-Path $out 'shell-snapshots') |
                Should -BeFalse -Because "an unnamed directory is excluded by default, not swept in"
            Test-Path -LiteralPath (Join-Path $out '.credentials.json') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $out 'settings.local.json') |
                Should -BeFalse -Because "settings.local.json is the per-machine escape hatch"
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "mirrors rather than overlays, so a deleted source file leaves the payload" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $args = @{
                ClaudeHome = (Join-Path $stand '.claude'); OutputRoot = $out
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
                VaultPath = 'C:/vault'
            }
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'agents/appsec-sme.md') | Should -BeTrue

            Remove-Item -LiteralPath (Join-Path $stand '.claude/agents/appsec-sme.md')
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'agents/appsec-sme.md') |
                Should -BeFalse -Because "an overlay export would accrete deleted files forever"
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "is idempotent: a second export with nothing changed writes identical bytes" {
        # This is what makes `git status` after an export a usable review of what changed in
        # the account layer. Without it every export is a diff and the signal is worthless.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $args = @{
                ClaudeHome = (Join-Path $stand '.claude'); OutputRoot = $out
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
                VaultPath = 'C:/vault'
            }
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            $first = @(Get-ChildItem -LiteralPath $out -Recurse -File | Sort-Object FullName |
                ForEach-Object { "$($_.FullName.Substring($out.Length))=$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" })
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            $second = @(Get-ChildItem -LiteralPath $out -Recurse -File | Sort-Object FullName |
                ForEach-Object { "$($_.FullName.Substring($out.Length))=$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" })
            ($second -join "`n") | Should -Be ($first -join "`n")
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    # C1: Copy-AccountTree removes each allowlisted directory under -OutputRoot before recopying
    # it, so an -OutputRoot equal to, or nested inside, -ClaudeHome would delete the live account
    # layer instead of the export destination. Four Its, each asserting one thing, so a failure
    # in one cannot mask the others.

    It "still exports normally when -OutputRoot is outside -ClaudeHome" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'rules/security.md') | Should -BeTrue
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "refuses when -OutputRoot equals -ClaudeHome, and deletes nothing" {
        $stand = New-StandInHome
        $claude = Join-Path $stand '.claude'
        try {
            { & $script:export -ClaudeHome $claude -OutputRoot $claude `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } | Should -Throw
            Test-Path -LiteralPath (Join-Path $claude 'rules/security.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $claude 'agents/appsec-sme.md') | Should -BeTrue
        }
        finally {
            Remove-Item -Recurse -Force $stand -ErrorAction SilentlyContinue
        }
    }

    It "refuses when -OutputRoot is nested inside -ClaudeHome, and deletes nothing" {
        $stand = New-StandInHome
        $claude = Join-Path $stand '.claude'
        $nestedOut = Join-Path $claude 'export-output'
        try {
            { & $script:export -ClaudeHome $claude -OutputRoot $nestedOut `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } | Should -Throw
            Test-Path -LiteralPath (Join-Path $claude 'rules/security.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $claude 'agents/appsec-sme.md') | Should -BeTrue
        }
        finally {
            Remove-Item -Recurse -Force $stand -ErrorAction SilentlyContinue
        }
    }

    It "supports -WhatIf, leaving the destination untouched" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp -WhatIf | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'rules/security.md') | Should -BeFalse
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    # C2: [System.IO.Path]::GetFullPath resolves a relative path against the .NET process
    # current directory, which Set-Location does not move; Remove-Item and Copy-Item resolve a
    # relative path against $PWD instead. Set-Location from this repo (E:) into a stand-in under
    # %TEMP% (C:) reproduces the divergence: crossing drives is what leaves the two apart in this
    # environment. Both Its restore the starting location in `finally`, before removing the
    # stand-in, so a later test never runs from a moved location.
    #
    # -ExpectedMessage pins the throw to the C1/C2 guard's own text. Without it these two tests
    # cannot tell a real guard refusal apart from an unrelated incidental throw: under the
    # process-CWD divergence a broken resolution lands on this repo's own root, which the I1
    # marker guard below then refuses on its own ("already exists, is not empty, and carries no
    # marker"), a different failure that would otherwise make Should -Throw pass for the wrong
    # reason and hide a C2 regression the same way an unrelated Copy-Item self-copy error did in
    # fix round 1.

    It "refuses -OutputRoot equal to -ClaudeHome when the session location and the process CWD have diverged" {
        $stand = New-StandInHome
        $claude = Join-Path $stand '.claude'
        $startLocation = Get-Location
        try {
            Set-Location -LiteralPath $claude
            { & $script:export -ClaudeHome $claude -OutputRoot '.' `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*must not be the account home*'
            Test-Path -LiteralPath (Join-Path $claude 'rules/security.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $claude 'agents/appsec-sme.md') | Should -BeTrue
        }
        finally {
            Set-Location -LiteralPath $startLocation
            Remove-Item -Recurse -Force $stand -ErrorAction SilentlyContinue
        }
    }

    It "refuses a relative -OutputRoot nested inside -ClaudeHome when the session location and the process CWD have diverged" {
        $stand = New-StandInHome
        $claude = Join-Path $stand '.claude'
        $startLocation = Get-Location
        try {
            Set-Location -LiteralPath $claude
            { & $script:export -ClaudeHome $claude -OutputRoot './evil-nested' `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*must not be the account home*'
            Test-Path -LiteralPath (Join-Path $claude 'rules/security.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $claude 'agents/appsec-sme.md') | Should -BeTrue
        }
        finally {
            Set-Location -LiteralPath $startLocation
            Remove-Item -Recurse -Force $stand -ErrorAction SilentlyContinue
        }
    }

    # I1: the equality/nesting guard above only covers -OutputRoot landing on the account home
    # itself. -OutputRoot aimed at some unrelated tree that happens to hold files under an
    # allowlisted directory name (rules/, hooks/, ...) is still silently destructive without a
    # second, independent check.

    It "gains a marker file after a fresh export" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') | Should -BeTrue
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "exports again over its own marked output without -Force" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        $claude = Join-Path $stand '.claude'
        try {
            & $script:export -ClaudeHome $claude -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null
            { & $script:export -ClaudeHome $claude -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } | Should -Not -Throw
            Test-Path -LiteralPath (Join-Path $out 'rules/security.md') | Should -BeTrue
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "refuses an unrelated non-empty -OutputRoot with no marker, and deletes nothing" {
        $stand = New-StandInHome
        $victim = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-victim-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path (Join-Path $victim 'rules') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $victim 'hooks') -Force | Out-Null
        'my rule notes' | Set-Content (Join-Path $victim 'rules/my-notes.md')
        'my hook'        | Set-Content (Join-Path $victim 'hooks/my-hook.ps1')
        'unrelated'      | Set-Content (Join-Path $victim 'readme.txt')
        try {
            { & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $victim `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } | Should -Throw
            Test-Path -LiteralPath (Join-Path $victim 'rules/my-notes.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $victim 'hooks/my-hook.ps1') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $victim 'readme.txt') | Should -BeTrue
        }
        finally {
            Remove-Item -Recurse -Force $stand, $victim -ErrorAction SilentlyContinue
        }
    }

    # Fix round 1 (task-5-review.md, F2): the original single It here carried nine assertions.
    # Pester aborts an It at its first failing Should, so the Step-5 tail-slashing ablation
    # reported one failure and silently skipped the rest -- proven independently reproducible.
    # One BeforeAll/AfterAll builds the stand-in and runs the real export exactly once; each It
    # below asserts exactly one thing against that shared, already-computed output, so a failure
    # in one can never mask another. This is the one Context in the file: every other It in it
    # stays self-contained per the file's existing convention, because this is the one place
    # where nine independent assertions would otherwise need nine near-identical fixtures.
    Context "folds all three quoting forms into forward-slash placeholders" {
        BeforeAll {
            $script:qStand = New-StandInHome
            $script:qOut = New-OutputRoot
            $qCh = (Join-Path $script:qStand '.claude')
            $script:qChBack = $qCh -replace '/', '\'
            $settings = @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'; ENABLE_TOOL_SEARCH = 'auto:5' }
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                hooks = @{
                    PreToolUse = @(
                        @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'
                                    command = "& '$script:qChBack\hooks\Scan-MemorySecrets.ps1'"
                                    shell = 'powershell'; timeout = 5 }) }
                        @{ matcher = 'Agent|Task|Workflow'; hooks = @(
                                @{ type = 'command'
                                    command = "bun `"$script:qChBack\hooks\model-tier-gate.ts`""
                                    timeout = 10 }) }
                    )
                    SessionStart = @(
                        @{ hooks = @(
                                @{ type = 'command'
                                    command = "bash `"$script:qChBack\hooks\harness-core-reminder.sh`""
                                    timeout = 10 }) }
                    )
                    UserPromptSubmit = @(
                        @{ hooks = @(
                                @{ type = 'command'
                                    # -NpmGlobal below is 'C:/npm', a stand-in for the whole
                                    # `npm root -g` value, which already IS the node_modules
                                    # directory (.SYNOPSIS: -NpmGlobal defaults to `npm root -g`).
                                    # A package therefore sits directly under it, with no second
                                    # node_modules segment to fold past.
                                    command = 'node C:/npm/ccstatusline/dist/ccstatusline.js --hook'
                                    timeout = 15 }) }
                    )
                    # Fix round 1 (A1/A2): closes the plan's worst-defect coverage gap. -ClaudeHome
                    # here is already backslash-spelled ([System.IO.Path]::GetTempPath() on
                    # Windows), so the CLAUDE_HOME fold above never exercises the
                    # forward-slashed-literal-vs-backslash-text case the normalisation in
                    # ConvertTo-TemplatedText exists for. -CoreRepo is the one literal every test
                    # in this file already passes forward-slashed ('E:/projects/agent-harness-core'),
                    # matching what Get-MainCheckout actually returns in production, while a
                    # hand-typed command referencing the repo is the realistic backslash-spelled
                    # case. This hook is synthetic (the operator's live settings.json carries no
                    # CORE_REPO literal today), but it puts the shared normalisation line under a
                    # Task-5-owned test instead of waiting on Task 6's $AccountTemplatedFiles wiring.
                    Notification = @(
                        @{ hooks = @(
                                @{ type = 'command'
                                    command = 'bash "E:\projects\agent-harness-core\core\claude\hooks\harness-core-reminder.sh"'
                                    timeout = 10 }) }
                    )
                }
                statusLine = @{ type = 'command'
                    command = 'node C:/npm/ccstatusline/dist/ccstatusline.js'
                    padding = 0 }
                skipDangerousModePermissionPrompt = $true
            }
            $settings | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $qCh 'settings.json')

            & $script:export -ClaudeHome $qCh -OutputRoot $script:qOut `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $script:qRaw = Get-Content (Join-Path $script:qOut 'settings.account.json') -Raw
            $script:qParsed = $script:qRaw | ConvertFrom-Json

            $script:qCmds = @()
            foreach ($e in $script:qParsed.hooks.PSObject.Properties.Name) {
                foreach ($g in @($script:qParsed.hooks.$e)) {
                    foreach ($h in @($g.hooks)) { $script:qCmds += $h.command }
                }
            }
        }
        AfterAll {
            Remove-Item -Recurse -Force $script:qStand, $script:qOut -ErrorAction SilentlyContinue
        }

        It "folds the quoted powershell hook command, & 'path'" {
            $script:qCmds | Should -Contain "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
        }
        It "folds the bun double-quoted hook command" {
            $script:qCmds | Should -Contain 'bun "{{CLAUDE_HOME}}/hooks/model-tier-gate.ts"'
        }
        It "folds the bash double-quoted hook command" {
            $script:qCmds | Should -Contain 'bash "{{CLAUDE_HOME}}/hooks/harness-core-reminder.sh"'
        }
        It "folds the unquoted node hook command" {
            $script:qCmds | Should -Contain '{{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook'.Insert(0, 'node ')
        }
        It "folds a CORE_REPO-rooted command from a forward-slashed -CoreRepo against backslash-spelled text" {
            $script:qCmds | Should -Contain 'bash "{{CORE_REPO}}/core/claude/hooks/harness-core-reminder.sh"'
        }
        It "folds statusLine.command" {
            $script:qParsed.statusLine.command | Should -Be 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js'
        }
        It "forward-slashes the whole rewritten tail, not only the prefix" {
            # A prefix-only fold leaves a receiver with /home/u/.claude\hooks\Scan-MemorySecrets.ps1,
            # which is one string on Linux and not a path at all.
            $script:qRaw | Should -Not -Match 'CLAUDE_HOME\}\}\\\\'
        }
        It "leaves no folded hook command carrying the original backslashed CLAUDE_HOME path" {
            # Assert on the parsed commands, not on $qRaw. JSON doubles every backslash, so a
            # pattern built by [regex]::Escape($qChBack) needs SINGLE backslashes and can never
            # match the doubled text whatever the exporter did. Measured: that form does not
            # match "& 'C:\\Users\\user\\.claude\\hooks\\x.ps1'", so it is an assertion with no
            # failing input, which is what patterns/test-falsifiability.md targets.
            foreach ($c in $script:qCmds) { $c | Should -Not -Match ([regex]::Escape($script:qChBack)) }
        }
        It "leaves statusLine.command carrying no residual NPM_GLOBAL literal" {
            # Fix round 1 (A3): the prior form asserted against $qChBack (the CLAUDE_HOME literal),
            # which this string never contained before or after folding, so it had no failing
            # input. statusLine.command's pre-fold text carries 'C:/npm' (the NPM_GLOBAL literal),
            # so that is the value whose survival would mean the fold failed.
            $script:qParsed.statusLine.command | Should -Not -Match ([regex]::Escape('C:/npm'))
        }
    }

    It "keeps every non-command key, including the two the operator chose to ship" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1' }
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                skillOverrides = @{ 'appsec-kpi-deck' = 'off' }
                enabledPlugins = @{ 'superpowers@claude-plugins-official' = $true }
                skipDangerousModePermissionPrompt = $true
                effortLevel = 'xhigh'
                hooks = @{}
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $s = Get-Content (Join-Path $out 'settings.account.json') -Raw | ConvertFrom-Json
            $s.permissions.defaultMode | Should -Be 'auto'
            # Decision 8: excluding these was recommended and the operator overruled it. The
            # cost is recorded in the design; the test's job is to notice if they silently stop
            # shipping, in either direction.
            $s.skipDangerousModePermissionPrompt | Should -BeTrue
            $s.effortLevel | Should -Be 'xhigh'
            $s.skillOverrides.'appsec-kpi-deck' | Should -Be 'off'
            $s.env.CLAUDE_CODE_USE_POWERSHELL_TOOL | Should -Be '1'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "serialises a one-hook matcher group as a JSON array" {
        # A round trip through ConvertFrom-Json is not a reliable check: the file's raw text is
        # the only faithful signal of what got written. Install-Harness.Tests.ps1 makes the same
        # assertion the same way, for the same reason.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $chBack = $ch -replace '/', '\'
            @{ hooks = @{ PreToolUse = @(
                        @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '$chBack\hooks\Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $raw = Get-Content (Join-Path $out 'settings.account.json') -Raw
            $raw | Should -Not -Match '"hooks":\s*\{\s*"type"'
            $raw | Should -Match '"hooks":\s*\['
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "leaves settings.json itself out of the payload" {
        # Only the templated copy travels. Shipping the literal file would put this
        # workstation's absolute paths on every receiver.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            '{"hooks":{}}' | Set-Content (Join-Path $ch 'settings.json')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'settings.json') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $out 'settings.account.json') | Should -BeTrue
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "folds each templated file with only the tokens its table row names" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $core = 'E:\projects\agent-harness-core'
            $vault = 'C:\Users\user\Documents\Obsidian Vault\Claude Code'
            $slug = $stand.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
            foreach ($d in 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $ch $d) -Force | Out-Null
            }
            "Core repo: ``$core``. Run pwsh $core\install\Install-Harness.ps1" |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            "The core repo at $core is the baseline. Run $core\install\Install-Harness.ps1" |
                Set-Content (Join-Path $ch 'hooks/harness-core-reminder.sh')
            "vale --config `"$ch\tools\prose-lint\.vale.ini`" --output=line" |
                Set-Content (Join-Path $ch 'skills/prose-lint/SKILL.md')
            "write to $vault\Handoffs\<slug>\handoff-latest.md" |
                Set-Content (Join-Path $ch 'skills/handoff/SKILL.md')
            "home directory maps to project folder $slug" |
                Set-Content (Join-Path $ch 'skills/council/SKILL.md')
            "~/.claude/projects/$slug/memory/MEMORY.md and $vault\Handoffs\handoff-latest.md" |
                Set-Content (Join-Path $ch 'skills/subagent-prompting/SKILL.md')

            # rules/ssh.md and rules/change-management.md are NOT in the table and describe this
            # machine on purpose. Plant one carrying a foldable literal and prove it survives.
            "SSH config is at $ch\..\.ssh\config and the core repo is $core" |
                Set-Content (Join-Path $ch 'rules/ssh.md')

            & $script:export -ClaudeHome $ch -OutputRoot $out -CoreRepo $core `
                -NpmGlobal 'C:/npm' -VaultPath $vault -HomeSlug $slug -SkipSettings -SkipMcp | Out-Null

            (Get-Content (Join-Path $out 'rules/harness-core.md') -Raw) |
                Should -Match '\{\{CORE_REPO\}\}/install/Install-Harness\.ps1'
            (Get-Content (Join-Path $out 'hooks/harness-core-reminder.sh') -Raw) |
                Should -Match '\{\{CORE_REPO\}\}/install/Install-Harness\.ps1'
            (Get-Content (Join-Path $out 'skills/prose-lint/SKILL.md') -Raw) |
                Should -Match '\{\{CLAUDE_HOME\}\}/tools/prose-lint/\.vale\.ini'
            (Get-Content (Join-Path $out 'skills/handoff/SKILL.md') -Raw) |
                Should -Match '\{\{OBSIDIAN_VAULT\}\}/Handoffs/'
            (Get-Content (Join-Path $out 'skills/council/SKILL.md') -Raw) |
                Should -Match '\{\{HOME_SLUG\}\}'
            $sub = Get-Content (Join-Path $out 'skills/subagent-prompting/SKILL.md') -Raw
            $sub | Should -Match '\{\{HOME_SLUG\}\}'
            $sub | Should -Match '\{\{OBSIDIAN_VAULT\}\}/Handoffs/handoff-latest\.md'

            # The allowlist half. ssh.md is outside the table, so both literals stay.
            $ssh = Get-Content (Join-Path $out 'rules/ssh.md') -Raw
            $ssh | Should -Not -Match '\{\{'
            $ssh | Should -Match ([regex]::Escape($core))
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "leaves a token unfolded in a file whose table row does not name it" {
        # The table row's token list has no falsifying input in the fixture above: none of the
        # six files there carries a literal for a token outside its own row, so setting
        # $rowFolds = @($folds) (every file gets every token) leaves every assertion in that It
        # green -- measured directly, not assumed. rules/harness-core.md's row is @('CORE_REPO')
        # only; planting the CLAUDE_HOME literal in its text and asserting it survives is what
        # actually exercises the per-row $wanted filter rather than only the file-level allowlist
        # ssh.md already covers.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $core = 'E:\projects\agent-harness-core'
            "Core repo: $core. Account home is $ch, which this row does not list." |
                Set-Content (Join-Path $ch 'rules/harness-core.md')

            & $script:export -ClaudeHome $ch -OutputRoot $out -CoreRepo $core `
                -NpmGlobal 'C:/npm' -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null

            $t = Get-Content (Join-Path $out 'rules/harness-core.md') -Raw
            $t | Should -Match '\{\{CORE_REPO\}\}'
            $t | Should -Not -Match '\{\{CLAUDE_HOME\}\}'
            $t | Should -Match ([regex]::Escape($ch)) `
                -Because "CLAUDE_HOME is not in this file's table row, so its literal must survive"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "folds a literal written with either separator spelling" {
        # Install writes forward-slash form, so after an install on the canonical box
        # harness-core.md reads E:/projects/agent-harness-core. A backslash-only fold would
        # leave that literal and break the round trip.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            "backslash E:\projects\agent-harness-core\install and slash E:/projects/agent-harness-core/install" |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:\projects\agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null
            $t = Get-Content (Join-Path $out 'rules/harness-core.md') -Raw
            $t | Should -Not -Match 'agent-harness-core'
            @([regex]::Matches($t, '\{\{CORE_REPO\}\}/install')).Count | Should -Be 2
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "folds a forward-slashed literal against backslashed text" {
        # The case that owns the real export. Get-MainCheckout returns a forward-slashed path,
        # and both live {{CORE_REPO}} source files spell it with backslashes, so this is the
        # exact combination a default `pwsh -NoProfile -File install/Export-Account.ps1` runs.
        # Every other folding test here passes -CoreRepo backslashed and cannot see it: with the
        # pattern built straight from the literal, [regex]::Escape leaves '/' alone, the
        # both-separator substitution has nothing to rewrite, and the fold silently no-ops while
        # the whole suite stays green.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            "Core repo: E:\projects\agent-harness-core\install\Install-Harness.ps1" |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            "the core at E:\projects\agent-harness-core" |
                Set-Content (Join-Path $ch 'hooks/harness-core-reminder.sh')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null

            $t = Get-Content (Join-Path $out 'rules/harness-core.md') -Raw
            $t | Should -Match '\{\{CORE_REPO\}\}/install/Install-Harness\.ps1'
            $t | Should -Not -Match 'agent-harness-core'
            (Get-Content (Join-Path $out 'hooks/harness-core-reminder.sh') -Raw) |
                Should -Not -Match 'agent-harness-core'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "throws when a table row names a file the payload does not carry" {
        # A silent skip here is how a fold quietly stops happening: the file gets renamed
        # upstream, the row goes stale, and the payload ships a machine path with nothing
        # reporting it. The exporter must say so.
        #
        # $AccountTemplatedFiles is [ordered] and rules/harness-core.md is iterated first, so
        # the row removed here has to be that one for the message to name it. Removing a later
        # row would throw about the first absent file rather than the one under test.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            Remove-Item -LiteralPath (Join-Path $ch 'rules/harness-core.md')
            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*rules/harness-core.md*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }
}
