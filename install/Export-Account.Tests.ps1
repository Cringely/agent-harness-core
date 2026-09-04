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
            # F-10: predates change-management.md's *.bak.<timestamp> convention, no timestamp
            # suffix. hooks/Scan-MemorySecrets.ps1.bak is the real file the review found shipping
            # C:\Users\jcgam in the payload.
            'stale backup, no timestamp' | Set-Content (Join-Path $claude 'hooks/Scan-MemorySecrets.ps1.bak')
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
            #
            # review round 1, F3: FIXTURE-ONLY-MARKER exists nowhere else in the repo. A
            # hardcoded copy of the live seven rules inside Export-Account.ps1 would still pass
            # every test that only plants sk_/AKIA tokens, since both are also live rules; this
            # third row is what makes the AST lift measured rather than asserted in a comment.
            @'
$patterns = @(
    @{ Name = 'API token (tk_/sk_/ak_)'; Regex = '(?<![a-zA-Z0-9_])(tk_|sk_|ak_)[a-zA-Z0-9]{10,}' }
    @{ Name = 'AWS-style key';           Regex = 'AKIA[0-9A-Z]{16}' }
    @{ Name = 'FIXTURE-ONLY-MARKER';     Regex = 'QQZZ-fixture-marker' }
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
        Get-ProjectSlug 'C:\Users\jcgam' | Should -Be 'C--Users-jcgam'
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

    It "drops a plain .bak file with no timestamp suffix, not only the *.bak.<timestamp> form" {
        # F-10: *.bak.* only matches change-management.md's timestamped convention.
        # hooks/Scan-MemorySecrets.ps1.bak predates that convention, carries no timestamp, and
        # shipped C:\Users\jcgam in the real payload before this fix.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null

            Test-Path -LiteralPath (Join-Path $out 'hooks/Scan-MemorySecrets.ps1.bak') |
                Should -BeFalse -Because "an untimestamped .bak is still a backup and must not ship"
            # No file anywhere in the payload matches either form, not just the one fixture path.
            $baks = @(Get-ChildItem -LiteralPath $out -Recurse -File |
                    Where-Object { $_.Name -like '*.bak.*' -or $_.Name -like '*.bak' })
            @($baks).Count | Should -Be 0 -Because "the payload must carry neither .bak spelling"
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
            # match "& 'C:\\Users\\jcgam\\.claude\\hooks\\x.ps1'", so it is an assertion with no
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
            $vault = 'C:\Users\jcgam\Documents\Obsidian Vault\Claude Code'
            # NOT $stand's own -creplace slug: $stand nests under the real $HOME, so that slug
            # carries the default Get-ProjectSlug $HOME slug as a PREFIX. HOME_SLUG is the one
            # IsPath=$false fold (a plain String.Replace), so a passing -HomeSlug and a leftover
            # `$homeSlug = Get-ProjectSlug $HOME` after the new `if` (the exact bug the brief's
            # Step 2 warns about) both satisfy `Should -Match '\{\{HOME_SLUG\}\}'` on the
            # prefixed string, and the regression goes undetected. A literal disjoint from the
            # default makes the two distinguishable.
            $slug = 'ZZ-HOMESLUG-FIXTURE-ZZ'
            $defaultSlug = $HOME.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
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
            $council = Get-Content (Join-Path $out 'skills/council/SKILL.md') -Raw
            $council | Should -Match '\{\{HOME_SLUG\}\}'
            # F-1: without a $slug disjoint from the default, this line alone cannot tell a
            # correctly-wired -HomeSlug apart from a leftover `Get-ProjectSlug $HOME` that
            # silently overwrote it, because the default slug is a prefix of the wired one.
            $council | Should -Not -Match ([regex]::Escape($defaultSlug)) `
                -Because "a leftover 'Get-ProjectSlug `$HOME' after the caller's -HomeSlug would leave the default slug in the output"
            $sub = Get-Content (Join-Path $out 'skills/subagent-prompting/SKILL.md') -Raw
            $sub | Should -Match '\{\{HOME_SLUG\}\}'
            $sub | Should -Match '\{\{OBSIDIAN_VAULT\}\}/Handoffs/handoff-latest\.md'
            $sub | Should -Not -Match ([regex]::Escape($defaultSlug))

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

    It "folds the default -HomeSlug when the caller omits it" {
        # N-3: the sibling branch of the same `if (-not $HomeSlug) { ... }` that F-1 fixed. F-1
        # covers the caller-supplied half (-HomeSlug passed explicitly); this covers the OTHER
        # half, -HomeSlug omitted so the exporter falls back to Get-ProjectSlug $HOME. Deleting
        # that line entirely left the suite green while a real export shipped the raw default
        # slug in two of the six files -- measured directly. New-StandInHome's own default
        # skills/council/SKILL.md fixture already carries the default slug literal
        # ($slugLiteral, computed the same way Get-ProjectSlug does), so no new fixture is needed
        # here, only the assertion.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null
            (Get-Content (Join-Path $out 'skills/council/SKILL.md') -Raw) |
                Should -Match '\{\{HOME_SLUG\}\}'
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

    It "warns when a table row's tokens do not match the file's text" {
        # The missing-file throw above catches a row whose FILE went missing. It says nothing
        # about a row whose LITERAL stopped matching: an upstream edit that respells the path, or
        # a -CoreRepo/-VaultPath value the file's text no longer contains. Without this, the
        # payload ships the machine path while the console still reports the row as handled.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'no machine paths of any kind live in this file' |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                -WarningVariable warnings -WarningAction SilentlyContinue | Out-Null
            $warned = @($warnings) -join "`n"
            $warned | Should -Match 'rules/harness-core\.md'
            $warned | Should -Match '\{\{CORE_REPO\}\}'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "warns on the unmatched token in a two-token row even when its sibling token matches" {
        # N-2: skills/subagent-prompting/SKILL.md is the ONLY row naming more than one token
        # (OBSIDIAN_VAULT, HOME_SLUG). A per-row check ("did the row substitute anything at
        # all") stays quiet as long as ONE of the two matches, which is exactly how a real
        # export shipped C--Users-jcgam in this file with no warning while the sibling
        # OBSIDIAN_VAULT token folded cleanly. Plant HOME_SLUG's literal only; leave
        # OBSIDIAN_VAULT's out of the file entirely. Uses the exporter's DEFAULT -HomeSlug
        # (Get-ProjectSlug $HOME), matching New-StandInHome's own default council.md fixture, so
        # this test does not itself cause an unrelated warning on a sibling file by passing a
        # -HomeSlug that no longer matches what New-StandInHome already planted elsewhere.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $slug = $HOME.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
            "the slug is $slug, no vault path mentioned anywhere in this file" |
                Set-Content (Join-Path $ch 'skills/subagent-prompting/SKILL.md')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                -WarningVariable warnings -WarningAction SilentlyContinue | Out-Null
            # Scoped to the one file under test: New-StandInHome's other fixtures are free to
            # warn about their own unrelated tokens without this assertion picking that up.
            $subWarning = (@($warnings) |
                    Where-Object { $_ -match 'skills/subagent-prompting/SKILL\.md' }) -join "`n"
            $subWarning | Should -Not -BeNullOrEmpty
            $subWarning | Should -Match '\{\{OBSIDIAN_VAULT\}\}'
            # The sibling token that DID match must not also be reported as unmatched, and must
            # still have been folded.
            $subWarning | Should -Not -Match '\{\{HOME_SLUG\}\}'
            (Get-Content (Join-Path $out 'skills/subagent-prompting/SKILL.md') -Raw) |
                Should -Match '\{\{HOME_SLUG\}\}'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    # review round 1, F6: the original single It here packed six assertions into one Should
    # chain. Pester stops an It at its first failing Should, so a break in one of the three
    # functional assertions (garmin's command, 1password's command, the top-level key set) would
    # leave the three secrecy assertions (userID/anonymousId/lastCost must not travel) unrun --
    # exactly the assertions that matter for this test's name. Shared BeforeAll/AfterAll, one It
    # per independently-falsifiable claim, matching the file's own C1 convention at :205-250 and
    # the "folds all three quoting forms" Context above.
    Context "lifts only the mcpServers key out of claude.json" {
        BeforeAll {
            $script:mStand = New-StandInHome
            $script:mOut = New-OutputRoot
            $mCh = (Join-Path $script:mStand '.claude')
            $mCj = Join-Path $script:mStand '.claude.json'
            @{
                userID = 'abc123'
                anonymousId = 'def456'
                projects = @{ 'E:\projects\demo' = @{ lastCost = 1.5 } }
                mcpServers = @{
                    garmin = @{ type = 'stdio'; command = 'uvx'
                        args = @('--from', 'git+https://github.com/Taxuspt/garmin_mcp', 'garmin-mcp')
                        env = @{} }
                    '1password' = @{ type = 'stdio'
                        command = 'C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe'
                        args = @(); env = @{} }
                }
            } | ConvertTo-Json -Depth 20 | Set-Content $mCj

            & $script:export -ClaudeHome $mCh -ClaudeJson $mCj -OutputRoot $script:mOut `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings | Out-Null

            $script:mRaw = Get-Content (Join-Path $script:mOut 'mcp-servers.json') -Raw
            $script:mParsed = $script:mRaw | ConvertFrom-Json
        }
        AfterAll {
            Remove-Item -Recurse -Force $script:mStand, $script:mOut -ErrorAction SilentlyContinue
        }

        It "keeps garmin's command" {
            $script:mParsed.mcpServers.garmin.command | Should -Be 'uvx'
        }
        It "keeps 1password's command" {
            $script:mParsed.mcpServers.'1password'.command | Should -Match 'onepassword-mcp\.exe$'
        }
        It "carries only the mcpServers top-level key" {
            @($script:mParsed.PSObject.Properties.Name) | Should -Be @('mcpServers')
        }
        # None of the rest of claude.json may travel: it is 46 project entries and two
        # identifiers, and one of them names the operator. Each in its own It so a break in one
        # cannot mask the other two, which is the whole point of this Context.
        It "drops userID" {
            $script:mRaw | Should -Not -Match 'userID'
        }
        It "drops anonymousId" {
            $script:mRaw | Should -Not -Match 'anonymousId'
        }
        It "drops lastCost" {
            $script:mRaw | Should -Not -Match 'lastCost'
        }
    }

    It "fails closed when any mcpServers string trips the secret scanner's own patterns" {
        # Server entries reach secrets through 1Password or an environment variable, never
        # inline. Measured against today's live mcpServers: all 15 strings clean, 0 hits.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ leaky = @{ type = 'stdio'; command = 'x'
                        args = @('--token', 'sk_livetoken0123456789abcdef'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            # review round 1, F7: '*leaky*' alone pins the fixture's server name and matches any
            # throw that happens to interpolate it, including one from an unrelated cause. Pin
            # both the entry name and the pattern name that actually fired, so this test can only
            # pass on the gate this file is named for.
            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings } |
                Should -Throw -ExpectedMessage '*leaky*API token*'
            Test-Path -LiteralPath (Join-Path $out 'mcp-servers.json') |
                Should -BeFalse -Because "a failed gate must leave nothing behind to commit"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "names the pattern that fired when the AST lift, not a hardcoded copy, is what caught it" {
        # review round 1, F3: FIXTURE-ONLY-MARKER exists only in New-StandInHome's stand-in hook.
        # A hardcoded seven-row copy of the live table inside Export-Account.ps1 passes every
        # other mcpServers test unchanged, because sk_ and AKIA are both live rules too -- this
        # is the one assertion a hardcoded copy cannot satisfy, since it has no row named
        # FIXTURE-ONLY-MARKER at all.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ marked = @{ type = 'stdio'; command = 'x'
                        args = @('--flag', 'QQZZ-fixture-marker'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings } |
                Should -Throw -ExpectedMessage '*marked*FIXTURE-ONLY-MARKER*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "gates a secret carried in a property the fold pass has no rule for" {
        # review round 1, F1: the gate used to scan a fixed property list (name, command, args,
        # env). The writer serialises the WHOLE server object, so an http/sse server's headers or
        # url -- exactly where MCP auth material lives -- reached the file unscanned. Plants an
        # sk_-shaped token, not the FIXTURE-ONLY-MARKER, so this test isolates the property-walk
        # fix on its own: it stays green regardless of which pattern-table mechanism is behind
        # Get-SecretPattern, and only the marker test above is entangled with the AST lift. Both
        # a nested object property (headers.Authorization) and a plain string property (url) are
        # planted, neither of which the fold pass touches, since neither shape is command, args,
        # or env.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ remote = @{ type = 'http'
                        url = 'https://example.invalid/mcp?tok=sk_livetoken0123456789abcdef'
                        headers = @{ Authorization = 'Bearer sk_livetoken0123456789abcdef' } } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings } |
                Should -Throw -ExpectedMessage '*remote*API token*'
            Test-Path -LiteralPath (Join-Path $out 'mcp-servers.json') |
                Should -BeFalse -Because "a failed gate must leave nothing behind to commit"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "refuses to run when dot-sourced, before touching -ClaudeHome or -OutputRoot" {
        # ANSWER-4(b): the script performs its work at load time, so a bare dot-source runs the
        # whole export against every default, including a repo-internal -OutputRoot and a live
        # -ClaudeHome/-ClaudeJson. Uses stand-in paths here regardless, so a regression in the
        # guard writes into a throwaway TEMP directory rather than anything live.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            { . $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*dot-sourcing*'
            Test-Path -LiteralPath $out |
                Should -BeFalse -Because "the guard fires before -OutputRoot is created"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "folds a server command that sits under the account home" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ local = @{ type = 'stdio'
                        command = 'node'
                        args = @(($ch -replace '/', '\') + '\tools\srv\index.js')
                        env = @{} } } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings | Out-Null

            $m = Get-Content (Join-Path $out 'mcp-servers.json') -Raw | ConvertFrom-Json
            @($m.mcpServers.local.args)[0] | Should -Be '{{CLAUDE_HOME}}/tools/srv/index.js'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }
}
