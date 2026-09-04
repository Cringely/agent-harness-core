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

    It "folds all three quoting forms into forward-slash placeholders" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $chBack = $ch -replace '/', '\'
            $settings = @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'; ENABLE_TOOL_SEARCH = 'auto:5' }
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                hooks = @{
                    PreToolUse = @(
                        @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'
                                    command = "& '$chBack\hooks\Scan-MemorySecrets.ps1'"
                                    shell = 'powershell'; timeout = 5 }) }
                        @{ matcher = 'Agent|Task|Workflow'; hooks = @(
                                @{ type = 'command'
                                    command = "bun `"$chBack\hooks\model-tier-gate.ts`""
                                    timeout = 10 }) }
                    )
                    SessionStart = @(
                        @{ hooks = @(
                                @{ type = 'command'
                                    command = "bash `"$chBack\hooks\harness-core-reminder.sh`""
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
                }
                statusLine = @{ type = 'command'
                    command = 'node C:/npm/ccstatusline/dist/ccstatusline.js'
                    padding = 0 }
                skipDangerousModePermissionPrompt = $true
            }
            $settings | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $raw = Get-Content (Join-Path $out 'settings.account.json') -Raw
            $s = $raw | ConvertFrom-Json

            $cmds = @()
            foreach ($e in $s.hooks.PSObject.Properties.Name) {
                foreach ($g in @($s.hooks.$e)) { foreach ($h in @($g.hooks)) { $cmds += $h.command } }
            }
            $cmds | Should -Contain "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
            $cmds | Should -Contain 'bun "{{CLAUDE_HOME}}/hooks/model-tier-gate.ts"'
            $cmds | Should -Contain 'bash "{{CLAUDE_HOME}}/hooks/harness-core-reminder.sh"'
            $cmds | Should -Contain '{{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook'.Insert(0, 'node ')
            $s.statusLine.command | Should -Be 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js'

            # The whole rewritten path, not only the prefix. A prefix-only fold leaves a
            # receiver with /home/u/.claude\hooks\Scan-MemorySecrets.ps1, which is one string
            # on Linux and not a path at all.
            $raw | Should -Not -Match 'CLAUDE_HOME\}\}\\\\'
            # Assert on the parsed commands, not on $raw. JSON doubles every backslash, so a
            # pattern built by [regex]::Escape($chBack) needs SINGLE backslashes and can never
            # match the doubled text whatever the exporter did. Measured: that form does not
            # match "& 'C:\\Users\\user\\.claude\\hooks\\x.ps1'", so it is an assertion with no
            # failing input, which is what patterns/test-falsifiability.md targets.
            foreach ($c in $cmds) { $c | Should -Not -Match ([regex]::Escape($chBack)) }
            $s.statusLine.command | Should -Not -Match ([regex]::Escape($chBack))
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
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
}
