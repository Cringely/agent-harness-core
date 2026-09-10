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
                'skills/prose-lint', 'skills/handoff', 'skills/council', 'skills/subagent-prompting',
                'skills/cloned-skill/.git/refs/heads', 'skills/appsec-kpi-deck/references') {
                New-Item -ItemType Directory -Path (Join-Path $claude $d) -Force | Out-Null
            }
            'rule body'                | Set-Content (Join-Path $claude 'rules/security.md')
            'stale backup'             | Set-Content (Join-Path $claude 'rules/security.md.bak.20260101-000000')
            'homelab specifics'        | Set-Content (Join-Path $claude 'rules/homelab.local.md')
            # F-10: predates change-management.md's *.bak.<timestamp> convention, no timestamp
            # suffix. hooks/Scan-MemorySecrets.ps1.bak is the real file the review found shipping
            # C:\Users\user in the payload.
            'stale backup, no timestamp' | Set-Content (Join-Path $claude 'hooks/Scan-MemorySecrets.ps1.bak')
            'agent def'                | Set-Content (Join-Path $claude 'agents/appsec-sme.md')
            'StylesPath = styles'      | Set-Content (Join-Path $claude 'tools/prose-lint/.vale.ini')
            'rule yaml'                | Set-Content (Join-Path $claude 'tools/prose-lint/styles/Cringely/X.yml')
            'core owned'               | Set-Content (Join-Path $claude 'hooks/model-tier-gate.ts')
            'internal traffic'         | Set-Content (Join-Path $claude 'hooks/Guard-ModelTier.HANDOFF.md')
            'ps statusline'            | Set-Content (Join-Path $claude 'statusline-command.ps1')
            'sh statusline'            | Set-Content (Join-Path $claude 'statusline-command.sh')
            'local override'           | Set-Content (Join-Path $claude 'settings.local.json')
            # Operator ruling, review N1: a corporate deliverable spec that stays in ~/.claude
            # for local use but must never travel in the payload.
            'kpi deck spec'            | Set-Content (Join-Path $claude 'skills/appsec-kpi-deck/SKILL.md')
            'kpi deck detail'          | Set-Content (Join-Path $claude 'skills/appsec-kpi-deck/references/deck-spec.md')

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

            # A cloned skill's .git/ internals: real payload shipped skills/beautiful_prose/.git,
            # 28 files including the operator's committer email in the reflog, before this fix.
            'ref: refs/heads/main'     | Set-Content (Join-Path $claude 'skills/cloned-skill/.git/HEAD')
            'operator@example.com'     | Set-Content (Join-Path $claude 'skills/cloned-skill/.git/refs/heads/main')
            'skill body'               | Set-Content (Join-Path $claude 'skills/cloned-skill/SKILL.md')

            return $standHome
        }

        function New-OutputRoot {
            Join-Path ([System.IO.Path]::GetTempPath()) ("acct-out-" + [guid]::NewGuid())
        }

        # Every identity test writes its own file and passes -IdentityFile. The DEFAULT is the
        # operator's real declaration, and a test that fell back to it would assert against the
        # exact strings this repo exists to keep out -- printing them on the first failure, which
        # is the reasoning the -WslHome stub below already follows.
        #
        # The JSON is built by hand rather than through ConvertTo-Json because the empty case is
        # load-bearing: "declares nothing" must still leave the username arm running, and that
        # branch is worth writing as literal [] rather than trusting a serialiser to emit it.
        function New-IdentityFile {
            param([string[]]$Names = @(), [string[]]$Emails = @(), [string]$Raw)
            $p = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-ident-" + [guid]::NewGuid() + ".json")
            $body = if ($PSBoundParameters.ContainsKey('Raw')) { $Raw }
            else {
                $n = (@($Names) | ForEach-Object { '"' + $_ + '"' }) -join ','
                $e = (@($Emails) | ForEach-Object { '"' + $_ + '"' }) -join ','
                "{`"names`":[$n],`"emails`":[$e]}"
            }
            Set-Content -LiteralPath $p -Value $body
            return $p
        }

        # A username that cannot occur in a real path on the machine running the suite.
        # [System.IO.Path]::GetTempPath() on Windows is under the profile directory, so every
        # stand-in home built above already carries the RUNNER's username in a `Users\<name>`
        # position. Without an explicit -AccountUser the exporter would redact that out of the
        # fixtures, and the suite's behaviour would then depend on whose machine ran it.
        $script:fixtureUser = 'zzfixtureuser'
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
            Test-Path -LiteralPath (Join-Path $out 'rules/homelab.local.md') |
                Should -BeFalse -Because "a .local.md is the per-environment overlay and never travels"
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "drops a plain .bak file with no timestamp suffix, not only the *.bak.<timestamp> form" {
        # F-10: *.bak.* only matches change-management.md's timestamped convention.
        # hooks/Scan-MemorySecrets.ps1.bak predates that convention, carries no timestamp, and
        # shipped C:\Users\user in the real payload before this fix.
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

    It "drops a cloned skill's .git internals, at any depth, while keeping the skill itself" {
        # Real export measured: skills/beautiful_prose/.git shipped 28 files, including the
        # operator's committer email in .git/logs/HEAD, before Copy-AccountTree excluded .git.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null

            Test-Path -LiteralPath (Join-Path $out 'skills/cloned-skill/SKILL.md') | Should -BeTrue `
                -Because "the skill's own content still belongs in the payload"
            Test-Path -LiteralPath (Join-Path $out 'skills/cloned-skill/.git') | Should -BeFalse `
                -Because "a cloned skill's git internals are not the account layer the operator authors"
            $gits = @(Get-ChildItem -LiteralPath $out -Recurse -Force -Directory |
                    Where-Object { $_.Name -eq '.git' })
            @($gits).Count | Should -Be 0 -Because "no .git directory may survive anywhere in the payload"
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "excludes skills/appsec-kpi-deck from the payload, and keeps excluding it on a repeat export" {
        # Operator ruling, review N1: a corporate deliverable spec that must not be published,
        # kept in ~/.claude for local use. AccountSkipDirs is a prefix match, so both files under
        # it (SKILL.md and references/deck-spec.md) are covered by one entry, and the check runs
        # twice against the same source to prove a second export does not resurrect it -- the
        # exporter always removes and recopies the destination (Copy-AccountTree's own doc
        # comment), so nothing here is incremental state that could carry the exclusion forward
        # only once, but the review asked for this proven rather than reasoned about.
        $stand = New-StandInHome
        $out1 = New-OutputRoot
        $out2 = New-OutputRoot
        try {
            $args = @{
                ClaudeHome = (Join-Path $stand '.claude')
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
                VaultPath = 'C:/vault'; SkipSettings = $true; SkipMcp = $true
            }
            & $script:export @args -OutputRoot $out1 | Out-Null
            & $script:export @args -OutputRoot $out2 | Out-Null

            foreach ($out in @($out1, $out2)) {
                Test-Path -LiteralPath (Join-Path $out 'skills/appsec-kpi-deck') | Should -BeFalse `
                    -Because "a corporate deliverable spec must not travel in the payload"
            }
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out1, $out2 -ErrorAction SilentlyContinue
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

    It "refuses when -OutputRoot equals -ClaudeHome even with a trailing separator on only one of them" {
        # F1, final review round: $claudeHomeFull and $outputRootFull are each
        # GetUnresolvedProviderPathFromPSPath output with .TrimEnd('\', '/') applied. Without
        # that TrimEnd, a -ClaudeHome carrying a trailing separator and a -OutputRoot without one
        # (or vice versa) defeats both Equals and StartsWith("$claudeHomeFull$sep"): neither
        # string is a match for the other once exactly one of them carries the extra separator.
        # Demonstrated live: this exact pair reached Copy-AccountTree and took a stand-in from
        # eight files to three before the fix.
        #
        # -ExpectedMessage pinned to the containment guard's own text, not a bare Should -Throw:
        # -OutputRoot here is $claude itself, a non-empty directory with no export marker, so the
        # unrelated "already exists ... carries no marker" guard a few lines below also throws
        # once the containment check stops catching it first. A bare Should -Throw passed under
        # the ablation this test exists to catch, on that second guard's message instead of this
        # one's, which would have hidden exactly the regression this test is for.
        #
        # Issue #74: a trailing Test-Path pair here was dead on arrival and has been removed.
        # Should -Throw -ExpectedMessage fails (and Pester aborts the remaining statements in this
        # try block) whenever the thrown message doesn't match, so any Test-Path placed after it
        # runs only in the branch where the match already succeeded -- which, since the containment
        # guard throws before Copy-AccountTree is ever called, already proves $claude untouched.
        # There is no mutation of this guard that leaves the match passing while $claude has been
        # written to: the two are provably the same fact, not two facts. -ExpectedMessage is the
        # whole assertion.
        $stand = New-StandInHome
        $claude = Join-Path $stand '.claude'
        try {
            { & $script:export -ClaudeHome "$claude\" -OutputRoot $claude `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*must not be the account home or a path inside it*'
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

    It "does not print the completion message under -WhatIf" {
        # review round 2, item 5: round 1's commit claimed moving the completion line below the
        # marker write also stopped it printing under -WhatIf. Write-Host is not
        # ShouldProcess-aware, so that was false -- measured true before this fix. Guarded on
        # -not $WhatIfPreference instead. Write-Host output is captured through the common
        # -InformationVariable parameter, which every advanced script (this one carries
        # [CmdletBinding()]) exposes; Write-Host tees to the Information stream in pwsh 7.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp -WhatIf `
                -InformationVariable info -InformationAction SilentlyContinue | Out-Null
            (@($info) -join "`n") | Should -Not -Match 'Export complete'
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "marks the per-directory file count with (dry run) under -WhatIf" {
        # F4, final review round: Copy-AccountTree's $copied counter increments once per
        # source file regardless of whether Copy-Item actually ran, so under -WhatIf it still
        # reports the real file count with nothing said about none of it having been written.
        # Demonstrated live: "rules: 1 files" printed under -WhatIf before this fix, identical
        # to the non-dry-run wording.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp -WhatIf `
                -InformationVariable info -InformationAction SilentlyContinue | Out-Null
            (@($info) -join "`n") | Should -Match 'rules: \d+ files \(dry run\)'
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

    # Issue #74: a trailing Test-Path pair below was dead on arrival, same reasoning as the F1 test
    # above. Should -Throw -ExpectedMessage aborts this try block on a mismatch, so a Test-Path
    # placed after it only ever runs once the expected message has already matched -- and that
    # message is the C1/C2 guard's own, thrown before Copy-AccountTree is ever called, so a
    # passing match already proves $claude untouched. Removed rather than kept as decoration.
    #
    # The nested-path It directly below shares this exact shape (-ExpectedMessage on the same
    # guard family, Test-Path trailing it) and is provably dead by the identical argument. Left
    # alone here: issue #74 named two instances, not three, and this repo's own convention is a
    # narrow commit per named fix rather than folding in an adjacent one found along the way --
    # worth a follow-up issue if one doesn't already cover it.
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
                # Not appsec-kpi-deck: that key is now stripped by the export-side leak fix below,
                # and this test's job is the opposite one, that an override for a skill NOT on
                # AccountSkipDirs survives untouched. Synthetic name, matches nothing real.
                skillOverrides = @{ 'unrelated-skill' = 'off' }
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
            $s.skillOverrides.'unrelated-skill' | Should -Be 'off'
            $s.env.CLAUDE_CODE_USE_POWERSHELL_TOOL | Should -Be '1'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "strips a skillOverrides entry for a skill excluded by AccountSkipDirs" {
        # Review N1's second check-rather-than-assume: settings.json names a skill by its bare
        # key regardless of whether Copy-AccountTree shipped its files, so excluding the
        # directory alone leaves the name sitting in settings.account.json's skillOverrides map.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            @{
                skillOverrides = @{ 'appsec-kpi-deck' = 'off'; 'unrelated-skill' = 'off' }
                hooks = @{}
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $s = Get-Content (Join-Path $out 'settings.account.json') -Raw | ConvertFrom-Json
            $s.skillOverrides.PSObject.Properties.Name | Should -Not -Contain 'appsec-kpi-deck' `
                -Because "the payload must not reference an excluded skill by name, not just by omitting its files"
            $s.skillOverrides.'unrelated-skill' | Should -Be 'off'
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

            # -AccountUser, because this is the one It that asserts a STAND-IN PATH survives into
            # the payload verbatim, and a stand-in path sits under [System.IO.Path]::GetTempPath(),
            # which on Windows is inside the runner's own profile directory. Without the override
            # the identity redaction rewrites `Users\<runner>` inside $ch and this assertion fails
            # on the operator's machine while passing on one whose temp directory is elsewhere.
            & $script:export -ClaudeHome $ch -OutputRoot $out -CoreRepo $core `
                -NpmGlobal 'C:/npm' -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                -AccountUser $script:fixtureUser | Out-Null

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

    It "folds the longest matching literal when one fold literal is a prefix of another" {
        # Backlog item 30. Get-AccountFoldTable used to state, in a comment, that no literal is a
        # substring of another, and the callers applied the rows in declaration order. Nothing
        # checked the precondition, and the token the item was filed for ({{HOME}}) breaks it: the
        # bare home is a prefix of both the .claude path and the vault path, so folding it first
        # yields {{HOME}}/.claude where {{CLAUDE_HOME}} belongs.
        #
        # NPM_GLOBAL is declared second and CORE_REPO fourth, so a -NpmGlobal that is a prefix of
        # -CoreRepo puts the shorter literal first in declaration order and the assertion below
        # can only pass on the sort. mcpServers rather than a templated file: the model-read fold
        # pass filters $folds down to the tokens each row names, so no single templated file ever
        # sees two colliding literals, while an mcpServers string sees the whole table.
        #
        # -VaultPath is left at C:/vault so New-StandInHome's handoff fixture still folds; a row
        # that folded nothing would now take the export down before this assertion ran.
        #
        # Review round 3: this It used to omit -WslHome entirely, so every run shelled out to the
        # real `wsl -e sh -c 'echo $HOME'` on the operator's box for a value that has nothing to do
        # with fold ordering. The item-24 It below keeps -CoreRepo and -NpmGlobal explicit for that
        # exact reason and stubs `wsl`; this one now passes -WslHome '' instead.
        #
        # The poisoned stub is what makes the omission observable rather than merely tidy. `wsl` on
        # PATH answers /home/poison, and a copied file carries /home/poison/launcher.sh, so if the
        # explicit -WslHome '' is ever dropped again the resolution block picks the stub up, the
        # whole-payload gate fires on rules/security.md, and this It goes red instead of quietly
        # depending on whatever the host's WSL happens to hold.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $stubDir = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-wslstub-" + [guid]::NewGuid())
        $oldPath = $env:PATH
        try {
            New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
            # .cmd for the same reason the item-24 It gives: a .ps1 that never calls exit leaves
            # $LASTEXITCODE at whatever the previous native command set.
            "@echo off`r`necho /home/poison`r`n" |
                Set-Content -LiteralPath (Join-Path $stubDir 'wsl.cmd') -NoNewline
            $env:PATH = $stubDir + [System.IO.Path]::PathSeparator + $oldPath

            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            'the launcher lives at /home/poison/launcher.sh' |
                Set-Content (Join-Path $ch 'rules/security.md')
            @{ mcpServers = @{
                    nested = @{ type = 'stdio'; command = 'node'
                        args = @('E:\projects\agent-harness-core\tools\srv.js'); env = @{} }
                } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'E:/projects' `
                -VaultPath 'C:/vault' -WslHome '' -SkipSettings | Out-Null

            $m = Get-Content (Join-Path $out 'mcp-servers.json') -Raw | ConvertFrom-Json
            @($m.mcpServers.nested.args)[0] | Should -Be '{{CORE_REPO}}/tools/srv.js' `
                -Because "declaration order would fold {{NPM_GLOBAL}} first and swallow the tail"
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeTrue -Because "an explicit -WslHome '' keeps the stub out of the run"
        }
        finally {
            $env:PATH = $oldPath
            Remove-Item -Recurse -Force $stand, $out, $stubDir -ErrorAction SilentlyContinue
        }
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

    It "throws when a table row folds none of its tokens" {
        # The missing-file throw above catches a row whose FILE went missing. It says nothing
        # about a row whose LITERAL stopped matching: an upstream edit that respells the path, or
        # a -CoreRepo/-VaultPath value the file's text no longer contains. Without this, the
        # payload ships the machine path while the console still reports the row as handled.
        #
        # Backlog item 29: this used to assert a Write-Warning. A row that folds zero of its
        # tokens and a row that folds all of them were reported in the same register, one as a
        # warning beside a "folded 0 of 1" status line that reads like completed work. A zero
        # count is the $AccountTemplatedFiles row and the source text having drifted apart, so it
        # is fatal now. The partial case (one token of two) stays a warning and is covered by the
        # It below.
        #
        # Review round 3: the message used to say "The fold table in AccountShared.ps1", which
        # names nothing that is there. Get-AccountFoldTable is defined in Export-Account.ps1; what
        # lives in AccountShared.ps1 is the $AccountTemplatedFiles row this throw is about. The
        # captured-message form below rather than one -ExpectedMessage wildcard, because half the
        # claim is negative -- the message must NOT send the reader after a fold table -- and
        # Should -Throw has no way to say that.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'no machine paths of any kind live in this file' |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            $msg = $null
            try {
                & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null
            }
            catch { $msg = $_.Exception.Message }
            # First, so the two -Not assertions below cannot pass vacuously on a $null message.
            $msg | Should -Not -BeNullOrEmpty -Because "a zero-token fold is fatal, not a warning"
            $msg | Should -BeLike "*rules/harness-core.md*folded none*CORE_REPO*"
            $msg | Should -BeLike '*AccountTemplatedFiles row in AccountShared.ps1*' `
                -Because "that is the row the reader has to fix"
            $msg | Should -Not -BeLike '*fold table*' `
                -Because "Get-AccountFoldTable is in Export-Account.ps1, not the file the message names"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "warns on the unmatched token in a two-token row even when its sibling token matches" {
        # N-2: skills/subagent-prompting/SKILL.md is the ONLY row naming more than one token
        # (OBSIDIAN_VAULT, HOME_SLUG). A per-row check ("did the row substitute anything at
        # all") stays quiet as long as ONE of the two matches, which is exactly how a real
        # export shipped C--Users-user in this file with no warning while the sibling
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

    # WSL_HOME is the sixth fold and the only POSIX-rooted one. code-context's launcher is the
    # one live entry it applies to (task-14-addendum's scrub: mcp-servers.json:14 names the
    # operator's own WSL account as a literal that should not ship). /home/wsluser below is a
    # synthetic fixture value, not the real one: review round 1, B1, the real account name was
    # shipping in this test's own fixture and test name, which is exactly the kind of disclosure
    # this fold exists to prevent.
    Context 'folds a WSL user''s $HOME into {{WSL_HOME}} in mcpServers' {
        BeforeAll {
            $script:wStand = New-StandInHome
            $script:wOut = New-OutputRoot
            $wCh = (Join-Path $script:wStand '.claude')
            $wCj = Join-Path $script:wStand '.claude.json'
            @{
                mcpServers = @{
                    'code-context' = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', '/home/wsluser/code-context-mcp.sh'); env = @{} }
                }
            } | ConvertTo-Json -Depth 20 | Set-Content $wCj

            & $script:export -ClaudeHome $wCh -ClaudeJson $wCj -OutputRoot $script:wOut `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -WslHome '/home/wsluser' -SkipSettings | Out-Null

            $script:wParsed = Get-Content (Join-Path $script:wOut 'mcp-servers.json') -Raw | ConvertFrom-Json
        }
        AfterAll {
            Remove-Item -Recurse -Force $script:wStand, $script:wOut -ErrorAction SilentlyContinue
        }

        It "folds the WSL home segment in code-context's launcher arg" {
            $script:wParsed.mcpServers.'code-context'.args | Should -Contain '{{WSL_HOME}}/code-context-mcp.sh'
        }
        It "leaves no residual /home/wsluser literal behind" {
            $script:wParsed.mcpServers.'code-context'.args | Should -Not -Contain '/home/wsluser/code-context-mcp.sh'
        }
    }

    It "folds a trailing-slash -WslHome to a single separator in mcpServers, not a missing or doubled one" {
        # Issue #81: a prior fix normalised how the fold handles a trailing-slash -WslHome
        # (.Trim().TrimEnd('/') at the producer, :215-221), but nothing pinned the FOLD's own
        # output shape. The trailing-slash rows already in this file (the degenerate-value table
        # above, and "still fails closed on a copied-file literal when -WslHome carries a
        # trailing slash" further down) both exercise the payload-wide fail-closed identity scan,
        # not this. A silent revert of the TrimEnd would build the pattern from
        # '/home/wsluser/' -- ending in '/' -- and the tail group's leading separator would then
        # have to match a SECOND '/' that a real path never has, degrading the fold to a near-
        # total no-op: it would leave 'code-context-mcp.sh' after the token with no leading
        # separator at all, i.e. '{{WSL_HOME}}code-context-mcp.sh', rather than either shipping
        # the literal or doubling the slash.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{
                    'code-context' = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', '/home/wsluser/code-context-mcp.sh'); env = @{} }
                } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -WslHome '/home/wsluser/' -SkipSettings | Out-Null

            $parsed = Get-Content (Join-Path $out 'mcp-servers.json') -Raw | ConvertFrom-Json
            @($parsed.mcpServers.'code-context'.args)[1] |
                Should -Be '{{WSL_HOME}}/code-context-mcp.sh' `
                -Because "not '{{WSL_HOME}}code-context-mcp.sh' (missing separator) or '{{WSL_HOME}}//code-context-mcp.sh' (doubled)"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "fails closed instead of shipping the WSL home verbatim when -WslHome does not resolve" {
        # Review round 1, B3, reproduced: an explicit empty -WslHome (standing in for wsl being
        # absent, its distro stopped, or the shell-out timing out) used to leave the fold's own
        # early return doing nothing, so the export exited 0 and wrote the real literal straight
        # through with no warning naming {{WSL_HOME}} anywhere. Same fixture shape as the
        # successful-fold Context above, -WslHome '' instead of a real value.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{
                    'code-context' = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', '/home/wsluser/code-context-mcp.sh'); env = @{} }
                } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '' -SkipSettings } |
                Should -Throw -ExpectedMessage '*code-context*unfolded POSIX home path*/home/wsluser*'
            Test-Path -LiteralPath (Join-Path $out 'mcp-servers.json') |
                Should -BeFalse -Because "a failed gate must leave nothing behind to commit"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    # A SUPPLIED -WslHome that names no directory is refused at the parameter, not at the scan.
    #
    # This is the hole the merge of fix/exporter-correctness and fix/export-identity-gate opened
    # and then had to close. Each parent fixed a different half of this line, both halves were
    # pinned by their own branch's tests, and the COMBINATION was pinned by nothing: the merge
    # nulled the pattern for a degenerate value and called that fail-safe. Measured end to end, it
    # was fail-open. -WslHome '/' produced a SUCCESSFUL export, marker written, with
    # /home/wsluser/code-context-mcp.sh shipped verbatim in a copied file and mcp-servers.json
    # rewritten to "C:{{WSL_HOME}}tools{{WSL_HOME}}srv.js". The mcpServers shape gate did not
    # catch it either -- the '/' fold rewrites every separator, so $script:PosixHomeShape has no
    # POSIX home left to find. Both gates off, and strictly weaker than either parent alone:
    # under fix/exporter-correctness the empty pattern matched everything and aborted on the first
    # file, loudly.
    #
    # Whitespace is the same defect in different clothes and gets a case of its own: the
    # auto-resolution branch calls .Trim() and the explicit-parameter path did not, so a trailing
    # space built '/home/wsluser\ (?!...)' and degraded the scan the same way.
    #
    # -WslHome '' is deliberately NOT here. An unresolved value is legal and is covered by the It
    # above, which asserts the mcpServers shape gate stands in for the scan in that case.
    It "rejects or normalises a degenerate -WslHome rather than exporting: <label>" -ForEach @(
        @{ Value = '/';                Label = 'a bare slash' }
        @{ Value = '//';               Label = 'two slashes' }
        @{ Value = '   ';              Label = 'whitespace only' }
        @{ Value = '/home/wsluser ';   Label = 'a trailing space' }
        @{ Value = '/home/wsluser/';   Label = 'a trailing slash' }
    ) {
        # The last two are ACCEPTED after normalisation rather than refused -- .Trim().TrimEnd('/')
        # turns both into '/home/wsluser' -- so they assert the normalisation instead of a throw.
        # Kept in the same table because the failure they used to cause is identical to the first
        # three: a pattern that matches nothing and an export that completes anyway.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'wsl home lives at /home/wsluser/code-context-mcp.sh' |
                Set-Content (Join-Path $ch 'rules/ssh.md')

            $run = { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome $Value -SkipSettings -SkipMcp }

            if ($Value.Trim().TrimEnd('/')) {
                # Normalises to a real path, so the scan must fire on the literal in ssh.md.
                $run | Should -Throw -ExpectedMessage '*still carries the WSL home literal*'
            }
            else {
                $run | Should -Throw -ExpectedMessage '*must name an absolute POSIX directory*'
            }

            # Either way the export must not have completed. Asserted separately from the throw
            # because the defect this pins was a throw-free SUCCESS, and a gate that threw after
            # writing the payload would satisfy the Should above while still shipping the file.
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeFalse -Because "a refused export must leave no marker behind to commit"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    # The refusal message must not leak the operator's own profile path.
    #
    # It ends by telling the reader to check what `wsl -e sh -c 'echo $HOME'` returns. That '$HOME'
    # belongs to the POSIX shell the reader is told to run, not to PowerShell -- but the message is
    # a double-quoted PowerShell string, so an unescaped $HOME interpolates at throw time and prints
    # this machine's Windows profile path instead. Two defects from one character: the instruction
    # stops being runnable, and an identifying string reaches console output, CI logs and session
    # transcripts -- the channel the identity scan lower in this same file exists to keep clean.
    #
    # Backslash does not escape in PowerShell; the escape is a backtick. Both existing assertions on
    # this message match its PREFIX, so neither one moves when the tail leaks. Hence a test of its
    # own, asserting on the rendered text rather than on the source.
    It "refuses without interpolating the operator's profile path into the message" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $msg = $null
            try {
                & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '/' -SkipSettings -SkipMcp
            }
            catch { $msg = $_.Exception.Message }

            $msg | Should -Not -BeNullOrEmpty -Because 'the degenerate value must still be refused'
            $msg | Should -BeLike '*must name an absolute POSIX directory*'

            # -Not -Match would treat $HOME as a regex; the path is full of backslashes. Substring.
            $msg.Contains($HOME) |
                Should -BeFalse -Because 'the refusal must not print this machine''s profile path'
            $msg.Contains('$HOME') |
                Should -BeTrue -Because 'the reader is told to run a shell command that uses $HOME'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    # The same judgement on the value the script RESOLVES, not only on one the caller supplied.
    #
    # This pins a regression the first version of the producer guard introduced. That version read
    # `$PSBoundParameters.ContainsKey('WslHome') -and $WslHome`, so it judged a supplied value and
    # skipped a resolved one -- while the commit deleted the consumer-side TrimEnd that had been
    # covering the resolved path. Net effect: a distro whose $HOME ends in '/' went from throwing
    # to completing the export with the literal shipped. A guard that removes a defence from the
    # path it does not cover is worse than no guard, and only a test on the resolution branch
    # catches it, because every other WslHome test passes the parameter explicitly.
    #
    # `wsl -e sh -c 'echo $HOME'` returns that distro's passwd entry. Nothing makes it well-formed.
    It "judges a RESOLVED WslHome too, not only a supplied one: <label>" -ForEach @(
        @{ Echo = '/home/stubwsl/'; Throws = 'literal';   Label = 'a distro whose $HOME ends in a slash' }
        @{ Echo = '/';              Throws = 'predicate'; Label = 'a distro whose $HOME is a bare slash' }
    ) {
        $stand = New-StandInHome
        $out = New-OutputRoot
        $stubDir = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-wslstub-" + [guid]::NewGuid())
        $oldPath = $env:PATH
        try {
            New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
            "@echo off`r`necho $Echo`r`n" |
                Set-Content -LiteralPath (Join-Path $stubDir 'wsl.cmd') -NoNewline
            $env:PATH = $stubDir + [System.IO.Path]::PathSeparator + $oldPath

            $ch = (Join-Path $stand '.claude')
            'wsl home lives at /home/stubwsl/code-context-mcp.sh' |
                Set-Content (Join-Path $ch 'rules/ssh.md')

            # -WslHome deliberately NOT passed. That omission is the whole point of this It, and it
            # is what every other WslHome test in this file forecloses by passing the parameter.
            $run = { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp }

            if ($Throws -eq 'predicate') {
                $run | Should -Throw -ExpectedMessage '*must name an absolute POSIX directory*'
            }
            else {
                # Normalises to /home/stubwsl, so the scan must then fire on the literal in ssh.md.
                $run | Should -Throw -ExpectedMessage '*still carries the WSL home literal*'
            }

            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeFalse -Because "a refused export must leave no marker behind to commit"
        }
        finally {
            $env:PATH = $oldPath
            Remove-Item -Recurse -Force $stand, $out, $stubDir -ErrorAction SilentlyContinue
        }
    }

    # Backlog item 23, first direction. The gate above keyed on a `/home/` prefix, which is one
    # of four spellings a WSL home takes, so its name promised more than its pattern delivered.
    # One It per shape rather than a loop inside one: Pester stops an It at its first failing
    # Should, and a single It here would report the first shape that regressed and stay silent
    # about the other two, which is the F2/F6 defect the two Contexts in this file were split for.
    It "fails closed on an unfolded <Name> in mcpServers" -ForEach @(
        @{ Name = 'WSL root home';         Path = '/root/code-context-mcp.sh';              Shown = '/root' }
        @{ Name = 'distro /Users home';    Path = '/Users/wsluser/code-context-mcp.sh';     Shown = '/Users/wsluser' }
        @{ Name = 'WSL path into Windows'; Path = '/mnt/c/Users/winuser/code-context.sh';   Shown = '/mnt/c/Users/winuser' }
    ) {
        # The third is the one that motivated the item: it carries the WINDOWS username and
        # escapes both sides -- the WSL gate did not know the prefix, and the Windows folds match
        # on backslashes.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{
                    'code-context' = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', $Path); env = @{} }
                } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '' -SkipSettings } |
                Should -Throw -ExpectedMessage "*code-context*unfolded POSIX home path*$Shown*"
            Test-Path -LiteralPath (Join-Path $out 'mcp-servers.json') |
                Should -BeFalse -Because "a failed gate must leave nothing behind to commit"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "does not read a forward-slashed Windows path as a POSIX home" {
        # The falsifying half of the shape list above. `/Users/<name>` and `/home/<user>` are
        # substrings of `C:/Users/<name>` and `C:/home/<name>`, and an mcpServers entry is free to
        # carry a forward-slashed Windows path that no fold happens to own. Without the
        # drive-letter lookbehind in $script:PosixHomeShape this entry throws and a legitimate
        # export dies on a path that is not a POSIX home at all.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{
                    winpath = @{ type = 'stdio'; command = 'node'
                        args = @('C:/Users/winuser/tools/srv.js'); env = @{} }
                } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -WslHome '' -SkipSettings | Out-Null

            $m = Get-Content (Join-Path $out 'mcp-servers.json') -Raw | ConvertFrom-Json
            @($m.mcpServers.winpath.args)[0] | Should -Be 'C:/Users/winuser/tools/srv.js'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "fails closed on a WSL home literal carried by a copied file, not only by mcpServers" {
        # Backlog item 23, second direction. The gate inside the mcpServers loop reads mcpServers
        # strings only, and Copy-AccountTree copies rules, agents, skills, hooks and the two
        # statusline scripts verbatim with no fold pass over any of them. -SkipMcp here so
        # mcpServers is never read at all: this can only pass on the whole-payload scan, not on
        # the loop gate.
        #
        # Review round 3: this used to say the literal also reaches here "through a settings hook
        # command". It cannot -- ConvertTo-TemplatedCommand folds hook commands and statusLine
        # with the whole table, {{WSL_HOME}} included, before this scan runs.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'the launcher lives at /home/wsluser/code-context-mcp.sh' |
                Set-Content (Join-Path $ch 'rules/security.md')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '/home/wsluser' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*rules/security.md*WSL home literal*'

            # Review round 3: this gate throws AFTER the payload is on disk, while every It in this
            # file covering an mcpServers gate asserts the opposite ("a failed gate must leave
            # nothing behind to commit"). Pinned rather than changed, so the file stops stating two
            # opposite things about its own gates without saying which is intended. The behaviour
            # is argued in 2f3b196: staging the payload in a temp tree and moving it on success is
            # the alternative, and it copies 218 files twice on every run. It is bounded for the
            # default -OutputRoot, where account/claude/.export-account-marker is tracked and a
            # re-run therefore still passes the marker check. A FRESH -OutputRoot like this one is
            # left non-empty and marker-less, so every retry against it needs -Force.
            Test-Path -LiteralPath (Join-Path $out 'rules/security.md') |
                Should -BeTrue -Because "the whole-payload gate throws after the copy, by design"
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeFalse -Because "no marker is what makes a fresh -OutputRoot need -Force to retry"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "completes when a payload file names the WSL home as prose rather than as a path" {
        # Review round 3, the blocking defect, reproduced against a0ff0ab:
        #
        #   pwsh -NoProfile -File install/Export-Account.ps1 -OutputRoot <tmp> -WslHome '/root' -SkipMcp
        #
        # exited 1 with "'skills/owasp-mcp/references/05-command-injection-execution.md' still
        # carries the WSL home literal after folding", having written 216 files and no marker. That
        # file is vendored third-party OWASP documentation and its line 79 reads
        # "Access to sensitive paths (/etc/passwd, /root, /proc/, ~/.ssh)." -- /root there is not a
        # machine path at all. /root is also one of the four shapes $script:PosixHomeShape declares
        # supported, and it is what `wsl --import` gives its default user, so every machine whose
        # WSL default user is root had a bricked exporter whose own failure message told the
        # operator to edit an OWASP document.
        #
        # The fixture copies that OWASP line verbatim rather than paraphrasing it: the payload's
        # only /root occurrence is that one line (grepped on the live tree), and the comma after
        # /root is the whole reason a bare .Contains fires.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'Access to sensitive paths (/etc/passwd, /root, /proc/, ~/.ssh).' |
                Set-Content (Join-Path $ch 'rules/security.md')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -WslHome '/root' -SkipSettings -SkipMcp | Out-Null

            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeTrue -Because "the marker is written only once every gate has passed"
            (Get-Content (Join-Path $out 'rules/security.md') -Raw) | Should -Match '/root,' `
                -Because "a copied third-party document is not the exporter's to rewrite"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "still fails closed on /root when it is a real path segment, not prose" {
        # The falsifying half of the boundary above, and the negative space the blocking fix has to
        # keep: a WSL root account's home reaching a copied file must still abort the export.
        # Reverting the boundary leaves this green (a bare .Contains also fires here), so its
        # ablation is the over-permissive mutation -- requiring a '/' after the literal, or dropping
        # the scan -- not the revert.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'the launcher lives at /root/code-context-mcp.sh' |
                Set-Content (Join-Path $ch 'rules/security.md')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '/root' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*rules/security.md*WSL home literal*'
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeFalse -Because "a gate that threw must not have written the marker"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "fails closed on a WSL home literal closed by a bracket, backtick, or markdown link" {
        # Review round 4, F1: the boundary's negated class stopped at '/', '"', "'" and whitespace,
        # so a literal immediately followed by ')', ']', a backtick, or '>' read as clean --
        # '(/root)', '[/root]' and a code span all missed, and a code span is the single most likely
        # way a bare home path lands in a rules or skills file. Reverting the widened class (back to
        # '(?![^/"''\s])') leaves this green: neither shape below satisfies the narrower boundary.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'see the launcher config (/home/wsluser) or `/home/wsluser` for details' |
                Set-Content (Join-Path $ch 'rules/security.md')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '/home/wsluser' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*rules/security.md*WSL home literal*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "fails closed on a WSL home literal at end of line, not only when a path separator follows" {
        # Review round 4, F2: every whole-payload fixture in this file puts a '/' right after the
        # literal ('/home/wsluser/code-context-mcp.sh', '/root/code-context-mcp.sh'), so nothing
        # exercised the quote/whitespace/EOF arm of the boundary. Narrowing
        # '(?![^/"''\s)\]`>])' to the single arm '(?=/)' still passes every other It in this file but
        # leaves this one green, because a bare literal at end of line has no '/' after it. The two
        # code comments at :739-742 and :744-749 assert that ablation is caught; this It is what
        # makes that true.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'the wsl user is /home/wsluser' | Set-Content (Join-Path $ch 'rules/security.md')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '/home/wsluser' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*rules/security.md*WSL home literal*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "still fails closed on a copied-file literal when -WslHome carries a trailing slash" {
        # Review round 4, F3: an operator typo, '-WslHome /home/wsluser/' instead of
        # '/home/wsluser', made the escaped literal end in '/', so the boundary after it then
        # demanded a SECOND separator that a real path never has ('//code-context-mcp.sh' does not
        # occur), and the gate went from fail-closed to a near-total no-op with no error. Dropping
        # the TrimEnd('/') before the pattern is built leaves this green.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            'the launcher lives at /home/wsluser/code-context-mcp.sh' |
                Set-Content (Join-Path $ch 'rules/security.md')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -WslHome '/home/wsluser/' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*rules/security.md*WSL home literal*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "does not text-decode a binary payload file looking for the WSL home" {
        # Review round 3: the scan read every payload file with Get-Content -Raw, including the two
        # PNGs under skills/wiring-diagram/examples/ (600 KB between them). Decoding megabytes of
        # image on every export is waste, and a decoded byte run that happened to match would abort
        # the export pointing at an image the operator cannot edit.
        #
        # The fixture forces that second failure rather than measuring the first: PNG magic, then a
        # NUL, then the WSL home as ASCII bytes. Get-Content -Raw decodes those trailing bytes back
        # into the literal, on a path boundary ('/' follows it), so the gate fires on the image
        # unless the file is skipped as binary. Timing is not asserted -- a wall-clock threshold in
        # a test is a flake, and the false abort is the half that has a correctness answer.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $magic = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D)
            $png = [byte[]]($magic +
                [System.Text.Encoding]::ASCII.GetBytes('/home/wsluser/code-context-mcp.sh'))
            [System.IO.File]::WriteAllBytes(
                (Join-Path $ch 'skills/cloned-skill/diagram.png'), $png)

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -WslHome '/home/wsluser' -SkipSettings -SkipMcp | Out-Null

            Test-Path -LiteralPath (Join-Path $out 'skills/cloned-skill/diagram.png') |
                Should -BeTrue -Because "a binary file is skipped by the gate, not by the copy"
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeTrue -Because "the gate must not abort on bytes it had no business decoding"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    # --- identity redaction and gate -----------------------------------------
    # security.md's mandate: identifying information must never reach a remote repository, and
    # only a human can override it. account/claude/ is generated into a PUBLIC repo, so the
    # generator carries the mandate rather than trusting an upstream scrub. It had not: six
    # payload files held a neutral placeholder where their live sources hold the username, and
    # nothing in this script put it there -- a one-time git-filter-repo run outside the generator
    # did, leaving the next export free to write the username straight back in.
    #
    # The two mechanisms are tested apart because their widths differ on purpose. Redaction is
    # narrow (username in a profile-path position only); the gate is wide (any identifying string
    # anywhere) and is the only mechanism for a declared name or email.

    It "redacts the workstation username where it sits in a profile path, and names the file it changed" {
        # rules/ssh.md, because it is one of the six real files this applies to and it is
        # deliberately NOT in $AccountTemplatedFiles -- no fold pass reaches it, so redaction is
        # the only thing that can take the username out.
        #
        # Ablating the redaction does not merely change the output here, it turns the export into
        # a throw: the gate is wider than the redaction and fires on what redaction would have
        # removed. Both halves are asserted, so a mutation that keeps the file readable while
        # dropping the placeholder is red on the -Match, and one that drops the whole block is red
        # on the marker.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $ident = New-IdentityFile
        try {
            $ch = (Join-Path $stand '.claude')
            "SSH config is at C:\Users\$($script:fixtureUser)\.ssh\config on this workstation." |
                Set-Content (Join-Path $ch 'rules/ssh.md')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                -AccountUser $script:fixtureUser -IdentityFile $ident `
                -InformationVariable info -InformationAction SilentlyContinue | Out-Null

            $ssh = Get-Content (Join-Path $out 'rules/ssh.md') -Raw
            $ssh | Should -Match ([regex]::Escape('C:\Users\user\.ssh\config')) `
                -Because "the sentence keeps naming this machine's path shape, minus the person"
            $ssh | Should -Not -Match ([regex]::Escape($script:fixtureUser))
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeTrue -Because "a redacted payload is a clean payload, not a failed export"
            # The audit trail. A redaction landing anywhere unexpected -- settings.account.json or
            # mcp-servers.json, where a rewritten path is wrong on the receiver rather than merely
            # neutral -- is only visible because every changed file is named on the way past.
            (@($info) -join "`n") |
                Should -Match 'rules/ssh\.md: redacted 1 workstation-username occurrence'
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "refuses when the workstation username survives outside a profile path, where redaction cannot reach" {
        # The negative space the narrow redaction leaves, and the reason the gate is wider than
        # it. A bare mention in prose is a defect in the SOURCE for a human to fix; rewriting
        # arbitrary prose is how a redactor mangles a document, and a username short or common
        # enough to read as an ordinary word (root, admin, user) makes a blind replace the same
        # false-positive failure the WSL gate's /root boundary exists to stop.
        #
        # This It also pins the redaction's narrowness from the other side: widening it to a bare
        # replace turns this green on the export and red on the -Throw.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $ident = New-IdentityFile
        try {
            $ch = (Join-Path $stand '.claude')
            "The account on this box is called $($script:fixtureUser), for what it is worth." |
                Set-Content (Join-Path $ch 'rules/security.md')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                    -AccountUser $script:fixtureUser -IdentityFile $ident } |
                Should -Throw -ExpectedMessage '*rules/security.md*workstation username*'
            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeFalse -Because "a gate that threw must not have written the marker"
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "refuses on a declared name, naming the file and the class but never the value" {
        # A legal name has no automatic rewrite and must not get one: substituting a name means
        # substituting somebody else's. The gate is the whole mechanism for this class.
        #
        # The "never the value" half is not decoration. The mandate covers every channel a run
        # touches, and a message quoting its match copies the string into console output, CI logs
        # and any transcript. Reverting to a message built with the matched value leaves the first
        # two assertions green and only this third one red, which is why it is separate.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $name = 'Zylric Quandsworth'
        $ident = New-IdentityFile -Names @($name)
        try {
            $ch = (Join-Path $stand '.claude')
            "Reviewed by $name on the second pass." |
                Set-Content (Join-Path $ch 'rules/security.md')

            $err = $null
            try {
                & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                    -AccountUser $script:fixtureUser -IdentityFile $ident | Out-Null
            }
            catch { $err = $_ }

            $err | Should -Not -BeNullOrEmpty -Because "a declared name in the payload must abort the export"
            $err.Exception.Message | Should -Match ([regex]::Escape('rules/security.md'))
            $err.Exception.Message | Should -Match 'declared name'
            $err.Exception.Message | Should -Not -Match ([regex]::Escape($name)) `
                -Because "the refusal must not copy the string it exists to contain"
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "refuses on a declared email carried by a file the exporter generated rather than copied" {
        # Coverage claim this It exists to make measurable: the gate reads the WRITTEN PAYLOAD, not
        # the source tree, so it also covers the two files no Copy-AccountTree pass ever touches.
        # settings.account.json is built from parsed JSON above and lands in -OutputRoot before the
        # traversal runs. A scrub wired into the copy instead would leave both generated files
        # unchecked and every assertion here green except this one.
        #
        # A non-command key, because ConvertTo-TemplatedCommand only rewrites hook and statusLine
        # commands; "keeps every non-command key" above pins that such a key survives untouched,
        # which is exactly what makes it a live route into the payload.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $email = 'zq@example.invalid'
        $ident = New-IdentityFile -Emails @($email)
        try {
            $ch = (Join-Path $stand '.claude')
            @{
                env   = @{ REPORT_CONTACT = $email }
                hooks = @{}
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipMcp `
                    -AccountUser $script:fixtureUser -IdentityFile $ident } |
                Should -Throw -ExpectedMessage '*settings.account.json*declared email*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "still checks the workstation username when the identity file declares nothing" {
        # An empty list means "nothing extra to check", never "check nothing". The username arm is
        # derived from the environment and does not depend on the file at all, so a mutation that
        # skips the gate whenever the declared lists are empty -- the plausible one, since that is
        # the common case -- has to be red here.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $ident = New-IdentityFile -Names @() -Emails @()
        try {
            $ch = (Join-Path $stand '.claude')
            "The account on this box is called $($script:fixtureUser)." |
                Set-Content (Join-Path $ch 'rules/security.md')

            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                    -AccountUser $script:fixtureUser -IdentityFile $ident } |
                Should -Throw -ExpectedMessage '*workstation username*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "does not read a declared name out of an ordinary word that contains it" {
        # Measured on the live account layer, and the reason the gate uses lookarounds rather than
        # a substring test: skills/owasp-llm/references/08-vector-and-embedding-weaknesses.md:117
        # reads "adjusting the augmentation process", which contains the operator's declared first
        # name as a substring. A bare containment check aborts every export against a vendored
        # third-party document nobody here may edit -- the same failure the WSL gate's /root
        # boundary already fixed, one class up.
        #
        # The fixture uses a synthetic four-letter declaration rather than the real first name for
        # the obvious reason: writing that name into a test in this repo is the thing being
        # prevented. 'Just' sits inside 'adjusting' exactly as the real one does.
        #
        # Ablation is the over-permissive mutation, not the revert: dropping the lookarounds for a
        # plain -match or .Contains turns this red while every other It in this group stays green.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $ident = New-IdentityFile -Names @('Just')
        try {
            $ch = (Join-Path $stand '.claude')
            'Adversarial suffixes work by adjusting the augmentation process.' |
                Set-Content (Join-Path $ch 'rules/security.md')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                -AccountUser $script:fixtureUser -IdentityFile $ident | Out-Null

            Test-Path -LiteralPath (Join-Path $out '.export-account-marker') |
                Should -BeTrue -Because "a declared name inside an unrelated word is not a leak"
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "throws on a malformed identity file before writing any payload" {
        # A gate reading its own config must not degrade to "checked less than you think" because
        # a comma went missing, and it must say so before 218 files are on disk rather than after.
        # -OutputRoot is never created at all, which is the assertion that separates a fail-fast
        # from a warn-and-continue.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $ident = New-IdentityFile -Raw '{ "names": [ '
        try {
            { & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp `
                    -AccountUser $script:fixtureUser -IdentityFile $ident } |
                Should -Throw -ExpectedMessage '*not valid JSON*'
            Test-Path -LiteralPath $out |
                Should -BeFalse -Because "the identity file is read before the first copy"
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "derives the workstation username from `$HOME when the caller omits -AccountUser" {
        # The same gap backlog item 24 found on -WslHome: every other It in this group passes
        # -AccountUser explicitly, so deleting the default-resolution line leaves all of them green
        # while a real export ships the username. This is the only It that exercises the default.
        #
        # Asserted as BOOLEANS, deliberately. Pester prints the expected and actual value of a
        # failed Should, so `Should -Match $realLeaf` would put the operator's username in the
        # suite's output the first time this broke -- the exact disclosure the whole change exists
        # to prevent, and the reasoning the -WslHome stub below follows for the same reason.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $ident = New-IdentityFile
        try {
            $ch = (Join-Path $stand '.claude')
            $leaf = Split-Path ($HOME.TrimEnd('\', '/')) -Leaf
            "profile lives at C:\Users\$leaf\Documents" |
                Set-Content (Join-Path $ch 'rules/ssh.md')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp -IdentityFile $ident | Out-Null

            $ssh = Get-Content (Join-Path $out 'rules/ssh.md') -Raw

            # Exact equality, wrapped in a boolean. Contains($leaf) had a false-negative mode
            # independent of the exporter: any leaf that is a substring of the replacement
            # literal -- 'u', 'se', 'user' itself -- can never come back false, so a correct
            # redaction fails the assertion. That fired for real. Account-Hooks.Tests.ps1 leaked
            # $HOME='/home/u' across the whole runspace, this test read leaf 'u', wrote
            # C:\Users\u\Documents, and the correctly redacted C:\Users\user\Documents still
            # contains 'u'. Red only in a whole-directory run, green alone and green per-file,
            # which is what leaked global state looks like from here. The leak is fixed next
            # door; this assertion is hardened so the next one reads as a leak and not as a hole
            # in the gate.
            #
            # Comparing the WHOLE line is also strictly stronger than the two Contains calls it
            # replaces: it fails on any surviving spelling of the username anywhere in the file,
            # including one the redaction mangled rather than removed.
            #
            # Boolean, for the reason the original gave: a failed -Be prints its actual operand,
            # which on a real regression is the operator's username in the suite's output. -ceq
            # so a case-only survival is a failure too.
            ($ssh.Trim() -ceq 'profile lives at C:\Users\user\Documents') |
                Should -BeTrue -Because "the default -AccountUser must resolve to this machine's profile leaf, and no spelling of the username may survive into the payload"
        }
        finally { Remove-Item -Recurse -Force $stand, $out, $ident -ErrorAction SilentlyContinue }
    }

    It "resolves -WslHome from wsl when the caller omits the parameter" {
        # Backlog item 24: ablating the default-resolution block left the whole suite green,
        # because every test touching the parameter passed it explicitly -- a populated path in
        # the folding Context above and an empty string in the fail-closed It above it. Neither
        # reaches the `if (-not $PSBoundParameters.ContainsKey('WslHome'))` branch.
        #
        # A stub `wsl` prepended to PATH, not the real one: the real answer is this machine's WSL
        # username, which is the literal this whole fold exists to keep out of the payload, and a
        # test asserting against it would put it in the test name on the first failure. The stub
        # makes the expected value a fixture value the repo can print.
        $stand = New-StandInHome
        $out = New-OutputRoot
        $stubDir = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-wslstub-" + [guid]::NewGuid())
        $oldPath = $env:PATH
        try {
            New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
            # .cmd, not .ps1: a .ps1 that never calls exit leaves $LASTEXITCODE at whatever the
            # previous native command set, and the resolution block reads $LASTEXITCODE.
            "@echo off`r`necho /home/stubwsl`r`n" |
                Set-Content -LiteralPath (Join-Path $stubDir 'wsl.cmd') -NoNewline
            $env:PATH = $stubDir + [System.IO.Path]::PathSeparator + $oldPath

            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{
                    'code-context' = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', '/home/stubwsl/code-context-mcp.sh'); env = @{} }
                } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            # -CoreRepo and -NpmGlobal stay explicit so nothing else shells out to PATH; -WslHome
            # is the one parameter deliberately omitted.
            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings | Out-Null

            $m = Get-Content (Join-Path $out 'mcp-servers.json') -Raw | ConvertFrom-Json
            @($m.mcpServers.'code-context'.args) |
                Should -Contain '{{WSL_HOME}}/code-context-mcp.sh' `
                -Because "the fold can only land if the omitted -WslHome resolved from wsl"
        }
        finally {
            $env:PATH = $oldPath
            Remove-Item -Recurse -Force $stand, $out, $stubDir -ErrorAction SilentlyContinue
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
        # env). The writer serialises the WHOLE server object, so an http/sse server's headers --
        # exactly where MCP auth material lives -- reached the file unscanned. Plants an
        # sk_-shaped token, not the FIXTURE-ONLY-MARKER, so this test isolates the property-walk
        # fix on its own: it stays green regardless of which pattern-table mechanism is behind
        # Get-SecretPattern, and only the marker test above is entangled with the AST lift.
        #
        # review round 2, item 2: the token used to sit in BOTH headers.Authorization (the nested
        # object arm) and url (a plain top-level string property, already reached by the old
        # command/args/env-only walk's sibling args coverage). Reddening on the url plant alone
        # measured nothing new, so removing nested-object recursion left this It green -- it
        # never exercised the shape it is named for. url now carries no secret, so only the
        # nested headers.Authorization plant can make this test pass.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ remote = @{ type = 'http'
                        url = 'https://example.invalid/mcp'
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

    It "gates a secret carried in a property NAME, not only its value" {
        # review round 2, item 1/3: Update-AccountServerStrings's predecessor walked only
        # $p.Value, never $p.Name. The code it replaced scanned $k (the env key) as well as
        # $srv.env.$k, so a server whose env var NAME is itself secret-shaped is the regression
        # this fix restores coverage for. env is a real property the fold pass already knows
        # about (unlike F1's headers/url case), so this isolates the key-vs-value gap on its own.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ named = @{ type = 'stdio'; command = 'x'
                        env = @{ 'sk_livetoken0123456789abcdef' = 'harmless' } } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings } |
                Should -Throw -ExpectedMessage '*named*API token*'
            Test-Path -LiteralPath (Join-Path $out 'mcp-servers.json') |
                Should -BeFalse -Because "a failed gate must leave nothing behind to commit"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "refuses when Scan-MemorySecrets.ps1 defines more than one `$patterns assignment" {
        # review round 1, F2 (discretionary in round 1, required in round 2): the count guard is
        # what stops a decoy $patterns assignment elsewhere in the hook from silently making the
        # gate lift the wrong table. Without a committed test the guard can be reverted to the
        # old -eq 0 check with the suite still green.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @'
$patterns = @(@{ Name = 'decoy'; Regex = 'nomatch12345' })
$patterns = @(
    @{ Name = 'API token (tk_/sk_/ak_)'; Regex = '(?<![a-zA-Z0-9_])(tk_|sk_|ak_)[a-zA-Z0-9]{10,}' }
)
exit 0
'@ | Set-Content (Join-Path $ch 'hooks/Scan-MemorySecrets.ps1')
            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings } |
                Should -Throw -ExpectedMessage '*defines 2*patterns assignments*expected exactly 1*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "refuses when Scan-MemorySecrets.ps1's `$patterns table lifts empty" {
        # review round 1, F2 (discretionary in round 1, required in round 2): a single, otherwise
        # well-formed assignment whose right side evaluates to zero rows is the other silent
        # no-op shape -- one assignment passes the count guard, so only the emptiness check below
        # it stops the gate from lifting nothing.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            '$patterns = @()' + "`n" + 'exit 0' | Set-Content (Join-Path $ch 'hooks/Scan-MemorySecrets.ps1')
            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'; env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings } |
                Should -Throw -ExpectedMessage '*patterns*table lifted empty*'
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

    It "folds a machine path carried in a non-stdio server's headers, not only command/args/env" {
        # Issue #69: the fold used to walk a hand-maintained command/args/env list while the
        # gate above (see "gates a secret carried in a property the fold pass has no rule for")
        # already walked every string reachable under the entry, so an http/sse server's headers
        # or url -- exactly where MCP auth material and per-machine config live -- shipped any
        # machine path they carried unfolded even though the gate scanned it correctly on the way
        # in. Update-AccountServerStrings replaces both walks with one, so this asserts the FOLD
        # side of that unification: the header value must come out as the token, not the literal.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            $chBackslashed = $ch -replace '/', '\'
            @{ mcpServers = @{ remote = @{ type = 'http'
                        url = 'https://example.invalid/mcp'
                        headers = @{ 'X-Client-Root' = "$chBackslashed\tools\srv" } } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings | Out-Null

            $m = Get-Content (Join-Path $out 'mcp-servers.json') -Raw | ConvertFrom-Json
            $m.mcpServers.remote.headers.'X-Client-Root' | Should -Be '{{CLAUDE_HOME}}/tools/srv'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }
}
