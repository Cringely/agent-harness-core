<#
.SYNOPSIS
    Exports this workstation's ~/.claude account layer into account/claude/ in this repo.

.DESCRIPTION
    Runs on the canonical workstation only. Config is authored in ~/.claude here, exported
    into the repo, and consumed elsewhere; a divergence on a receiver is a bug rather than a
    fork to preserve.

    The copy works from an allowlist in AccountShared.ps1 and never a denylist, and it mirrors
    rather than overlays: each allowlisted directory is removed and recopied, so a file deleted
    from ~/.claude leaves the repo instead of accreting there. Within those directories every
    *.bak.* (change-management.md's timestamped convention) and every plain *.bak (an older,
    untimestamped backup predating that convention) is dropped.

    A second export with nothing changed produces no content diff, which makes `git diff
    account/claude` after an export a usable review of what changed in the account layer.

    Use `git diff` and not `git status` for that review. On a Windows clone with
    core.autocrlf=true the checkout filter writes CRLF while this script writes LF, so a
    no-change re-export leaves the index untouched but flips the working-tree line endings,
    and `git status` then lists every file it rewrote. Measured 2026-09-05 against a clean
    tree: `git status --short` reported 203 modified paths where `git diff --exit-code`
    returned 0. `git ls-files --eol account/claude` shows the same transition as
    i/lf w/crlf becoming i/lf w/lf.

.PARAMETER ClaudeHome
    The account home to export. Defaults to $HOME/.claude.

.PARAMETER ClaudeJson
    The file holding mcpServers. Defaults to $HOME/.claude.json.

.PARAMETER OutputRoot
    Destination. Defaults to account/claude/ under the running clone.

.PARAMETER CoreRepo
    The literal folded into {{CORE_REPO}}. Defaults to the main checkout resolved through git.

.PARAMETER NpmGlobal
    The literal folded into {{NPM_GLOBAL}}. Defaults to `npm root -g`.

.PARAMETER WslHome
    The literal folded into {{WSL_HOME}} wherever it appears in mcpServers (today, only
    code-context's launcher). Defaults to the default WSL distro's $HOME via
    `wsl -e sh -c 'echo $HOME'`, or $null if wsl is not on PATH. Unlike the other five tokens
    this one has no receiver-side answer: Install-Account.ps1's Get-AccountTokenMap leaves
    {{WSL_HOME}} unexpanded on purpose, since a receiver may have no WSL at all and guessing a
    username would make a dead entry look resolved.

    The FOLD applies to mcpServers strings. The GATE that catches an unfolded WSL home applies to
    every file the export writes: the same literal reaches the payload through a rules file, a
    settings hook command or a templated file just as easily. Where -WslHome resolved, the gate
    scans for that literal exactly; where it did not, the mcpServers gate falls back to the
    POSIX-home shapes enumerated at $script:PosixHomeShape.

.PARAMETER VaultPath
    The literal folded into {{OBSIDIAN_VAULT}}. Defaults to $env:CLAUDE_OBSIDIAN_VAULT, else
    $HOME/Documents/Obsidian Vault/Claude Code.

.PARAMETER HomeSlug
    The literal folded into {{HOME_SLUG}}. Defaults to Get-ProjectSlug $HOME.

.PARAMETER SkipSettings
    Skip the settings.account.json rewrite. Test seam.

.PARAMETER SkipMcp
    Skip the mcp-servers.json lift. Test seam.

.PARAMETER Force
    Overwrite a non-empty -OutputRoot that carries no marker from a previous export. Does not
    bypass the refusal on -OutputRoot equal to, or inside, -ClaudeHome; that refusal is
    unconditional.

.EXAMPLE
    pwsh -NoProfile -File install/Export-Account.ps1
#>
#
# Moved below the comment-based help block rather than above it: PowerShell only recognises
# help text that begins at the top of the file (or right after param()), so a notice placed
# above <# .SYNOPSIS #> made Get-Help return the auto-generated syntax line and one parameter
# instead of the synopsis and all eight. Task 13 deletes this notice; the help block stays.
#
# PositionalBinding=$false, not a position list: Restore-ClaudeProject.ps1:71-95 records that
# PowerShell auto-assigns a position to every non-switch parameter lacking one, in declaration
# order, so a later-added seam silently becomes positional and a stray extra argument sets it
# without a binding error. Unlike Restore this script has no existing positional callers.
#
# SupportsShouldProcess makes -WhatIf and -Confirm valid on the script and sets
# $WhatIfPreference for the whole run. No explicit $PSCmdlet.ShouldProcess call is needed to act
# on it: Copy-AccountTree's Remove-Item, New-Item and Copy-Item are all built-in cmdlets that
# already implement ShouldProcess themselves, and they read $WhatIfPreference from the calling
# scope the same way any nested function call does. Adding a manual ShouldProcess wrap around
# the call site was tried and measured to do nothing: ablating it left the -WhatIf test green,
# because the underlying cmdlets were already honouring it on their own.
[CmdletBinding(PositionalBinding = $false, SupportsShouldProcess)]
param(
    [string]$ClaudeHome,
    [string]$ClaudeJson,
    [string]$OutputRoot,
    [string]$CoreRepo,
    [string]$NpmGlobal,
    [string]$WslHome,
    [string]$VaultPath,
    [string]$HomeSlug,
    [switch]$SkipSettings,
    [switch]$SkipMcp,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AccountShared.ps1')

$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $ClaudeHome) { $ClaudeHome = Join-Path $HOME '.claude' }
if (-not $ClaudeJson) { $ClaudeJson = Join-Path $HOME '.claude.json' }
if (-not $OutputRoot) { $OutputRoot = Join-Path (Join-Path $repoRoot 'account') 'claude' }

# review round 1, ANSWER-4(b): the script performs its work at load time, so dot-sourcing runs
# the whole export against every default -- including -OutputRoot defaulted to this repo's own
# account/claude and -ClaudeHome/-ClaudeJson defaulted to the live account layer. Placed here,
# right after -OutputRoot resolves, so it fires before anything is read or written.
if ($MyInvocation.InvocationName -eq '.') {
    throw "Export-Account.ps1 runs the export on load; dot-sourcing it exports against live defaults. Run it: pwsh -NoProfile -File install/Export-Account.ps1"
}

if (-not $CoreRepo)   { $CoreRepo = Get-MainCheckout -StartDir $repoRoot }
if (-not $VaultPath) {
    $VaultPath = if ($env:CLAUDE_OBSIDIAN_VAULT) { $env:CLAUDE_OBSIDIAN_VAULT }
    else { Join-Path (Join-Path (Join-Path $HOME 'Documents') 'Obsidian Vault') 'Claude Code' }
}
# Get-Command before the call: invoking a native command that is not on PATH throws a
# terminating CommandNotFoundException, and `2>$null` does not catch it. Under
# $ErrorActionPreference = 'Stop' that takes the exporter down instead of leaving $NpmGlobal
# null, which is the value the rest of this file is written to handle.
if (-not $PSBoundParameters.ContainsKey('NpmGlobal')) {
    $NpmGlobal = if (Get-Command npm -ErrorAction SilentlyContinue) {
        $v = (& npm root -g 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0) { $v } else { $null }
    } else { $null }
}
# Same shape as $NpmGlobal above: no environment variable exposes a WSL distro's $HOME to a
# Windows process, so this shells out and tolerates absence the same way. Unlike NpmGlobal this
# fold has no receiver-side answer at all (Install-Account.ps1 leaves {{WSL_HOME}} unexpanded on
# purpose, see Get-AccountTokenMap's comment there), so a live value here only needs to be right
# on the machine running THIS export, not on whatever eventually installs the payload.
if (-not $PSBoundParameters.ContainsKey('WslHome')) {
    $WslHome = if (Get-Command wsl -ErrorAction SilentlyContinue) {
        $v = (& wsl -e sh -c 'echo $HOME' 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $v) { $v.Trim() } else { $null }
    } else { $null }
}

if (-not (Test-Path -LiteralPath $ClaudeHome)) { throw "No account layer at '$ClaudeHome'." }

# Copy-AccountTree removes each allowlisted directory under -OutputRoot before recopying it;
# that removal is what makes the mirror an actual mirror rather than an overlay. If -OutputRoot
# resolves to -ClaudeHome itself, or to a path inside it, that same removal deletes the live
# account layer instead of the export destination. Refuse before anything is touched. Compare
# canonical absolute paths, not the raw parameter strings, so a relative '.' or a trailing slash
# cannot slip past the check.
#
# GetUnresolvedProviderPathFromPSPath, not [System.IO.Path]::GetFullPath: GetFullPath resolves a
# relative path against the .NET process current directory, which Set-Location does not move, so
# once a session's location and process CWD diverge, GetFullPath silently compares different
# paths than the ones Remove-Item and Copy-Item actually act on (they resolve against $PWD).
# Measured destroying a stand-in this way: absolute -ClaudeHome plus -OutputRoot '.' with the
# location diverged took a 7-file stand-in to 2, no refusal. Resolve-Path and Convert-Path are
# not substitutes; both throw on -OutputRoot, which usually does not exist yet.
# GetUnresolvedProviderPathFromPSPath resolves against the session's actual location and accepts
# a path that is not there yet.
$claudeHomeFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ClaudeHome).TrimEnd('\', '/')
$outputRootFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputRoot).TrimEnd('\', '/')
# Windows paths are case-insensitive; Linux paths are not. $IsWindows is undefined on Windows
# PowerShell 5.1, where the answer is always Windows -- the same platform line
# Restore-ClaudeProject.ps1's $TargetIsWindows default draws.
$onWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$pathComparison = if ($onWindowsHost) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
$sep = [System.IO.Path]::DirectorySeparatorChar
if ($outputRootFull.Equals($claudeHomeFull, $pathComparison) -or
    $outputRootFull.StartsWith("$claudeHomeFull$sep", $pathComparison)) {
    throw "-OutputRoot ('$outputRootFull') must not be the account home or a path inside it " +
        "('$claudeHomeFull'); the mirror deletes each allowlisted directory before recopying."
}

# The guard above closes -OutputRoot landing on the account home itself. It does not cover
# -OutputRoot aimed at some unrelated tree that happens to hold files under an allowlisted name
# (rules/, agents/, skills/, hooks/, tools/prose-lint/): Copy-AccountTree would delete those
# without ever noticing they belong to something else. Same shape Restore-ClaudeProject.ps1:247
# uses for -RepoPath: refuse a non-empty destination unless it carries the marker a previous
# export leaves behind, or the operator overrides with -Force. -Force reaches only this check;
# the equality/nesting guard above is unconditional and -Force does not touch it.
$exportMarker = Join-Path $outputRootFull '.export-account-marker'
if ((Test-Path -LiteralPath $outputRootFull) -and
    @(Get-ChildItem -LiteralPath $outputRootFull -Force -ErrorAction SilentlyContinue) -and
    -not (Test-Path -LiteralPath $exportMarker) -and
    -not $Force) {
    throw "-OutputRoot ('$outputRootFull') already exists, is not empty, and carries no marker " +
        "from a previous export. Re-run with -Force if overwriting it is intentional, or pick a " +
        "different -OutputRoot."
}

Write-Host "Account home : $ClaudeHome"
Write-Host "Output root  : $OutputRoot"

# Mirror one allowlisted directory. The destination subtree is removed first, which is the
# whole difference between a mirror and an overlay: without it a file deleted from ~/.claude
# stays in the repo forever and every receiver keeps installing it.
function Copy-AccountTree {
    param(
        [string]$SourceRoot,
        [string]$DestRoot,
        [string]$Relative,
        [string[]]$SkipRelative,
        [string[]]$SkipDirs
    )
    $from = Join-Path $SourceRoot $Relative
    $to = Join-Path $DestRoot $Relative
    if (-not (Test-Path -LiteralPath $from)) {
        Write-Warning "absent, skipping: $from"
        return 0
    }
    if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $to -Force

    $copied = 0
    # -Force so hidden entries are enumerated; a dir\* wildcard silently skips them on Windows.
    foreach ($f in @(Get-ChildItem -LiteralPath $from -Recurse -File -Force)) {
        $rel = ($f.FullName.Substring($from.Length).TrimStart('\', '/')) -replace '\\', '/'
        # A cloned skill (e.g. skills/beautiful_prose, installed from a marketplace) carries its
        # own .git/ internals: refs, packed-refs, and a reflog with the operator's committer
        # email in plain text. None of that is the account layer the operator authors, and none
        # of it belongs in a payload meant to ship to another machine. Checked on every path
        # segment, not just the leaf, so a .git/ at any depth under an allowlisted directory is
        # excluded, the same way *.bak.* is checked on the leaf name rather than only at the top.
        if (@($rel -split '/') -contains '.git') { continue }
        # *.bak.* is change-management.md's timestamped convention. *.bak on its own catches
        # older, untimestamped backups (e.g. hooks/Scan-MemorySecrets.ps1.bak) that predate it
        # and would otherwise ship a machine path in the payload.
        if ($f.Name -like '*.bak.*' -or $f.Name -like '*.bak') { continue }
        $full = "$Relative/$rel"
        if ($SkipRelative -contains $full) { continue }
        # Prefix, not an exact match: a whole excluded skill can hold any number of files, and
        # this must catch all of them without a second entry in AccountShared.ps1 per file.
        if (@($SkipDirs | Where-Object { $full -eq $_ -or $full.StartsWith("$_/") })) { continue }
        $dest = Join-Path $to $rel
        $null = New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $copied++
    }
    return $copied
}

# F4, final review round: Copy-Item/New-Item/Remove-Item are ShouldProcess-aware and no-op under
# -WhatIf on their own, but the status lines below are plain Write-Host built from script counters
# ($copied, $n) that increment whether or not the underlying cmdlet actually wrote anything, so
# they read as completed work under a dry run unless told otherwise. One flag computed once,
# reused at every status line rather than re-testing $WhatIfPreference at each site.
$dryRun = if ($WhatIfPreference) { ' (dry run)' } else { '' }

$null = New-Item -ItemType Directory -Path $OutputRoot -Force

foreach ($d in $script:AccountTreeDirs) {
    $n = Copy-AccountTree -SourceRoot $ClaudeHome -DestRoot $OutputRoot `
        -Relative $d -SkipRelative $script:AccountSkipFiles -SkipDirs $script:AccountSkipDirs
    Write-Host "  ${d}: $n files$dryRun"
}

foreach ($f in $script:AccountRootFiles) {
    $src = Join-Path $ClaudeHome $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $OutputRoot $f) -Force
        Write-Host "  ${f}: copied$dryRun"
    }
    else { Write-Warning "absent, skipping: $src" }
}

# --- fold table --------------------------------------------------------------
# Each fold has one named source. {{CLAUDE_HOME}} is the -ClaudeHome value, {{NPM_GLOBAL}} is
# `npm root -g`, {{CORE_REPO}} is the main checkout, {{OBSIDIAN_VAULT}} and {{HOME_SLUG}} come
# from $HOME, {{WSL_HOME}} is `wsl -e sh -c 'echo $HOME'`.
#
# The rows are declared in the order a reader wants to meet them and RETURNED longest-literal
# first, because the callers apply them in the order they arrive and a literal that is a prefix
# of another must not go first. Today's six do not overlap -- the npm path and the vault both
# sit under the bare home rather than under .claude, the slug shares no characters with any path
# spelling, and {{WSL_HOME}} is POSIX-rooted while the other four are Windows-rooted, so no
# Windows literal can contain a `/`-rooted string and no POSIX literal can contain a drive
# letter. That held by luck of which paths were needed, not by construction: a {{HOME}} token
# (backlog item 30) is a literal prefix of both the .claude path and the vault path, so folding
# it first would yield `{{HOME}}/.claude` where `{{CLAUDE_HOME}}` belongs.
#
# Sorting here rather than restating the precondition in a comment: the precondition was already
# written down, nothing checked it, and the sort is one line. The smaller alternative -- keep the
# comment and hand-order the rows -- makes the next person to add a row rediscover the rule,
# which is how item 30 came to be filed in the first place.
#
# No tie-break key is needed. Two literals of equal length cannot contain one another unless they
# are the same string, so the relative order of equal-length rows cannot change any output.
function Get-AccountFoldTable {
    param(
        [string]$ClaudeHome,
        [string]$NpmGlobal,
        [string]$WslHome,
        [string]$CoreRepo,
        [string]$VaultPath,
        [string]$HomeSlug
    )
    $rows = @(
        [pscustomobject]@{ Token = '{{CLAUDE_HOME}}';    Literal = $ClaudeHome; IsPath = $true }
        [pscustomobject]@{ Token = '{{NPM_GLOBAL}}';     Literal = $NpmGlobal;  IsPath = $true }
        [pscustomobject]@{ Token = '{{WSL_HOME}}';       Literal = $WslHome;    IsPath = $true }
        [pscustomobject]@{ Token = '{{CORE_REPO}}';      Literal = $CoreRepo;   IsPath = $true }
        [pscustomobject]@{ Token = '{{OBSIDIAN_VAULT}}'; Literal = $VaultPath;  IsPath = $true }
        [pscustomobject]@{ Token = '{{HOME_SLUG}}';      Literal = $HomeSlug;   IsPath = $false }
    )
    return @($rows | Sort-Object -Property { if ($_.Literal) { $_.Literal.Length } else { 0 } } -Descending)
}

# Folds one literal into its token. A path fold matches both separator spellings and
# forward-slashes the whole tail, not only the prefix: install writes forward-slash form, and
# this box's originals are backslashed, so a fold that matched one spelling would leave the
# other literal and break the round trip the design depends on.
#
# Only the $homePattern idiom is reused from Convert-HookCommand (Restore-ClaudeProject.ps1:192).
# Calling that function whole here is wrong in both directions: its Linux branch welds the
# "& '...ps1'" to "pwsh -NoProfile -File" rewrite in at L245-247, which would ship Linux
# commands to Windows receivers, and its Windows branch at L195-197 leaves the tail
# backslashed. The installer may call it whole, with $OldHome set to '{{CLAUDE_HOME}}'.
function ConvertTo-TemplatedText {
    param([string]$Text, [pscustomobject]$Fold)
    if (-not $Fold.Literal -or -not $Text) { return $Text }
    if (-not $Fold.IsPath) { return $Text.Replace($Fold.Literal, $Fold.Token) }

    # Normalise the literal to backslashes BEFORE escaping. [regex]::Escape leaves '/' alone, so
    # building the pattern straight from a forward-slashed literal produces a forward-only
    # pattern and the both-separator substitution below matches nothing to rewrite. That is not
    # hypothetical: Get-MainCheckout returns a forward-slashed path, and both live {{CORE_REPO}}
    # source files spell it with backslashes, so without this line the real export folds nothing
    # and ships E:\projects\agent-harness-core to every receiver with the whole suite green.
    # Measured: Escape('E:/projects/...') -> 'E:/projects/...' (no separator class);
    # Escape('E:\projects\...') -> 'E:[\\/]projects[\\/]...' which matches both spellings.
    $pattern = [regex]::Escape(($Fold.Literal -replace '/', '\')) -replace '\\\\', '[\\\\/]'
    $token = $Fold.Token
    $tail = '(?<tail>(?:[\\/][^"''\s]*)*)'
    return [regex]::Replace($Text, $pattern + $tail, {
            param($m)
            $token + $m.Groups['tail'].Value.Replace('\', '/')
        })
}

function ConvertTo-TemplatedCommand {
    param([string]$Text, [pscustomobject[]]$Folds)
    $out = $Text
    foreach ($f in @($Folds)) { $out = ConvertTo-TemplatedText -Text $out -Fold $f }
    return $out
}

if (-not $HomeSlug) { $HomeSlug = Get-ProjectSlug $HOME }
$folds = @(Get-AccountFoldTable -ClaudeHome $ClaudeHome -NpmGlobal $NpmGlobal -WslHome $WslHome `
        -CoreRepo $CoreRepo -VaultPath $VaultPath -HomeSlug $HomeSlug)

# --- settings.account.json ---------------------------------------------------
if (-not $SkipSettings) {
    $settingsSrc = Join-Path $ClaudeHome 'settings.json'
    if (-not (Test-Path -LiteralPath $settingsSrc)) {
        Write-Warning "absent, skipping: $settingsSrc"
    }
    else {
        # Parse and rewrite the command strings rather than text-replacing the whole file: the
        # JSON encoding doubles every backslash, so a text pass would have to match two
        # spellings of two spellings and would also reach strings that are not paths.
        $settings = Get-Content -LiteralPath $settingsSrc -Raw | ConvertFrom-Json

        # AccountSkipDirs keeps an excluded skill's files out of the payload, but settings.json's
        # per-skill enable/disable map names skills by their bare key regardless of whether the
        # skill ships, so a straight copy-through re-discloses the name Copy-AccountTree just
        # removed the files for. Caught by Task 14's own review (N1): the operator's ruling on
        # skills/appsec-kpi-deck was that the payload must not reference it by name OR path, and
        # this map is a path-shaped exclusion's remaining name-shaped leak.
        if ($settings.skillOverrides) {
            $excludedSkillNames = @($script:AccountSkipDirs | Where-Object { $_ -like 'skills/*' } |
                    ForEach-Object { ($_ -split '/', 2)[1] })
            foreach ($name in @($settings.skillOverrides.PSObject.Properties.Name)) {
                if ($excludedSkillNames -contains $name) {
                    $settings.skillOverrides.PSObject.Properties.Remove($name)
                }
            }
        }

        foreach ($event in $settings.hooks.PSObject.Properties.Name) {
            # Defensive, not load-bearing today: this loop is straight-line property access, and
            # measured on both pwsh 7.6.5 and Windows PowerShell 5.1, ConvertFrom-Json already
            # preserves a single-element JSON array as Object[] through both $settings.hooks.$event
            # and $group.hooks, with or without this wrap, for every fixture in this file. The
            # hazard these @() guard against is a single-match FILTERING pipeline result (a
            # Where-Object or ForEach-Object -First 1) unwrapping to a bare scalar, which would
            # then serialise "hooks": {...} instead of "hooks": [...]
            # (install/Install-Harness.ps1:822-826). Nothing in this loop is a pipeline today, so
            # removing either @() here currently changes nothing observable. Kept anyway, so a
            # future edit that does introduce a filtering step here does not reintroduce that
            # exact defect silently.
            $groups = @($settings.hooks.$event)
            foreach ($group in $groups) {
                $hooks = @($group.hooks)
                foreach ($hook in $hooks) {
                    $hook.command = ConvertTo-TemplatedCommand -Text $hook.command -Folds $folds
                }
                $group.hooks = $hooks
            }
            $settings.hooks.$event = $groups
        }
        if ($settings.statusLine.command) {
            $settings.statusLine.command =
                ConvertTo-TemplatedCommand -Text $settings.statusLine.command -Folds $folds
        }

        $settings | ConvertTo-Json -Depth 20 |
            Set-Content -LiteralPath (Join-Path $OutputRoot 'settings.account.json') -Encoding utf8
        Write-Host "  settings.account.json: written$dryRun"
    }
}

# --- model-read folds --------------------------------------------------------
# Executed hooks derive their paths at run time and were fixed at source. These six cannot be:
# a placeholder written into the live file is read literally by the model on this box, so the
# fold happens on the way out and the installer expands it on the way in.
#
# Gated on ShouldProcess, unlike Copy-AccountTree's call site: Test-Path and throw are plain
# script logic, not a built-in cmdlet that already honours -WhatIf on its own, so under -WhatIf
# nothing was actually copied into $OutputRoot and the missing-file check below would throw on
# the first row instead of leaving the destination untouched.
if ($PSCmdlet.ShouldProcess($OutputRoot, 'fold model-read machine paths')) {
    foreach ($rel in $script:AccountTemplatedFiles.Keys) {
        $target = Join-Path $OutputRoot $rel
        if (-not (Test-Path -LiteralPath $target)) {
            # Loud, not skipped. A stale row is how a fold quietly stops happening: the file
            # gets renamed upstream and the payload then ships a machine path with nothing
            # reporting it.
            throw "Templated file '$rel' is named in AccountShared.ps1 but absent from the payload. Update the table or the allowlist."
        }
        $wanted = @($script:AccountTemplatedFiles[$rel])
        $rowFolds = @($folds | Where-Object { $wanted -contains ($_.Token -replace '[{}]', '') })
        $text = Get-Content -LiteralPath $target -Raw
        # Count matches, not attempts, and check per TOKEN, not per row. The row names which
        # tokens apply; it does not promise the file's text still contains every one of their
        # literals. A row-wide check ("did anything in this row match") is not enough: on a real
        # export, skills/subagent-prompting/SKILL.md (the one two-token row) shipped
        # C--Users-user with no warning at all, because its OBSIDIAN_VAULT token matched and
        # that alone made the row-wide check pass while HOME_SLUG silently did not. Warn on the
        # specific token that stopped matching, not on whether the row as a whole did.
        $substituted = 0
        foreach ($f in $rowFolds) {
            $before = $text
            $text = ConvertTo-TemplatedText -Text $text -Fold $f
            if ($text -ne $before) {
                $substituted++
            }
            else {
                # Loud for the same reason the missing-file throw above is loud: a token that
                # stopped matching ships the machine path with the console still saying the file
                # was handled, and a sibling token in the same row matching would otherwise hide it.
                Write-Warning "${rel}: token $($f.Token) did not match the file's text; it still carries whatever machine path it had."
            }
        }
        # A row that folds NONE of its tokens is a different failure from a row that folds some
        # of them, and printing both through the same Write-Host below put them in the same
        # register. Every row in the table exists because that file carries a machine path; a
        # zero count says the file no longer carries any of the literals the row names, which
        # means the table and the source text have drifted apart. That is the failure the report
        # was added to catch, so it throws rather than warns.
        #
        # Zero, not "fewer than all". A partial match (the two-token row where one token lands)
        # is a real signal too, and the per-token Write-Warning above already names exactly which
        # token stopped matching; promoting that to a throw would make a file legitimately losing
        # one of its two literals block every export until the table was edited.
        #
        # Scope note: backlog item 29 asked for this on "the two files where a fold is required
        # rather than incidental" and named neither. Nothing in the repo records which two. All
        # six rows have the same character -- each is model-read text that a placeholder cannot
        # be written into at source -- so this applies to all six. Measured against the live
        # account layer before shipping it: every row folds at least one token today (five at
        # 1 of 1, subagent-prompting at 2 of 2), so no real export changes behaviour.
        if ($substituted -eq 0) {
            throw "Templated file '$rel' folded none of its $(@($rowFolds).Count) token(s) ($($wanted -join ', ')). The fold table in AccountShared.ps1 and the file's text have drifted apart; the payload would ship whatever machine path this file carries. Fix the row or the source text."
        }
        Set-Content -LiteralPath $target -Value $text -NoNewline
        Write-Host "  ${rel}: folded $substituted of $(@($rowFolds).Count) token(s)$dryRun"
    }
}

# --- POSIX home shapes -------------------------------------------------------
# The shapes a WSL home takes, for the gate that runs when -WslHome did not resolve and there is
# therefore no literal to scan for. Enumerated rather than keyed on `/home/`, which was one of
# four spellings and named the gate after the narrowest of them (backlog item 23):
#
#   /home/<user>          the default for a distro-created user account
#   /root                 a WSL root account, which has no /home entry at all
#   /Users/<name>         distro images that mirror the macOS layout
#   /mnt/<drive>/Users/<name>   a WSL path reaching back into Windows. This is the awkward one:
#                         it carries the WINDOWS username, and it escapes both sides -- this gate
#                         did not know the prefix, and the Windows folds match on backslashes.
#
# The drive-letter lookbehind keeps a forward-slashed Windows path out of it: `C:/Users/<name>`
# is not a POSIX home and an mcpServers entry is free to carry one. `--flag=/home/<user>` still
# matches, which a whitespace-or-quote lookbehind would have missed.
#
# Two-valued over an unenumerated domain is the failure change-management.md's scope-filter
# invariant records, so the enumeration is the fix and this comment is the enumeration.
$script:PosixHomeShape =
    '(?<![A-Za-z]:)(?:/mnt/[A-Za-z]/Users/[^/"''\s]+|/home/[^/"''\s]+|/Users/[^/"''\s]+|/root(?![^/"''\s]))'

# --- mcpServers --------------------------------------------------------------
# The pattern table is read out of the live secret scanner rather than copied, so the gate here
# and the gate on every memory write are the same seven patterns. A copy would drift, and the
# drift would be invisible: both sides would still pass their own tests.
#
# Rejected the alternative of piping each string through Scan-MemorySecrets.ps1 as a child
# process. It exercises the control end to end, which is better, but it costs one process spawn
# per string and the hook only reports a boolean verdict, so a failure could not name which
# pattern matched.
function Get-SecretPattern {
    param([string]$ScanHookPath)
    if (-not (Test-Path -LiteralPath $ScanHookPath)) {
        throw "Cannot read the secret pattern table: '$ScanHookPath' is absent."
    }
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $ScanHookPath, [ref]$null, [ref]$null)
    $assign = @($ast.FindAll({ param($n)
                $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                $n.Left.Extent.Text -eq '$patterns' }, $true))
    # review round 1, F2: a lone -eq 0 check fails OPEN on a second $patterns assignment (picks
    # $assign[0], ignores the rest) and on an assignment whose right side lifts empty. Both are
    # plausible refactors of Scan-MemorySecrets.ps1 and both turned the gate into a silent no-op
    # under the earlier check, with the whole suite still green. Require exactly one assignment
    # and a non-empty lifted table.
    if ($assign.Count -ne 1) {
        throw "Scan-MemorySecrets.ps1 defines $($assign.Count) `$patterns assignments; expected exactly 1."
    }
    # The right-hand side is EXECUTED here, not merely parsed: [scriptblock]::Create builds a
    # scriptblock from the assignment's extent text and & invokes it. The file is the operator's
    # own and already runs as a hook on every Write/Edit, so the trust boundary is unchanged, but
    # a reader should not assume the AST route is inert.
    $table = @(& ([scriptblock]::Create($assign[0].Right.Extent.Text)))
    if ($table.Count -eq 0) {
        throw "Scan-MemorySecrets.ps1's `$patterns table lifted empty."
    }
    return $table
}

function Test-AccountSecret {
    param([string]$Text, [hashtable[]]$Patterns)
    $hits = @()
    if (-not $Text) { return $hits }
    foreach ($p in @($Patterns)) {
        if ($Text -match $p.Regex) { $hits += $p.Name }
    }
    return @($hits)
}

# review round 1, F1: walks an arbitrary JSON-shaped value (PSCustomObject / array / scalar, the
# shapes ConvertFrom-Json produces) and returns every string reachable inside it. The gate's
# input must be built from the same object the writer below serialises, not a hand-maintained
# list of property names -- a fixed list of command/args/env covers today's three stdio servers
# and misses an http or sse server's headers or url, which is exactly where MCP auth material
# lives. A non-string scalar (bool, number, $null) has no secret shape and contributes nothing.
function Get-AccountString {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [string]) { return @($Value) }
    # review round 2, item 1 (F1 entry-name regression): scans the KEY as well as the value on
    # both object shapes. The code this walk replaced scanned $k (the env key name) as well as
    # $srv.env.$k; without the key, a secret-shaped property or header name reaches the payload
    # unscanned, which is a coverage regression against what was deleted.
    #
    # review round 2, item 6: [System.Collections.IDictionary] handled on this same branch,
    # rather than falling through to the generic IEnumerable branch below, where foreach over a
    # Hashtable yields the hashtable itself rather than its entries and recurses forever. Nothing
    # in this file calls ConvertFrom-Json with -AsHashtable (every object node is a
    # PSCustomObject), so this path is unreachable today; left deliberately untested since there
    # is no live call path that reaches it.
    if ($Value -is [System.Management.Automation.PSCustomObject] -or $Value -is [System.Collections.IDictionary]) {
        $out = @()
        if ($Value -is [System.Collections.IDictionary]) {
            foreach ($k in @($Value.Keys)) { $out += @($k) + @(Get-AccountString -Value $Value[$k]) }
        }
        else {
            foreach ($p in @($Value.PSObject.Properties)) { $out += @($p.Name) + @(Get-AccountString -Value $p.Value) }
        }
        return @($out)
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $out = @()
        foreach ($item in $Value) { $out += @(Get-AccountString -Value $item) }
        return @($out)
    }
    return @()
}

if (-not $SkipMcp) {
    if (-not (Test-Path -LiteralPath $ClaudeJson)) {
        Write-Warning "absent, skipping: $ClaudeJson"
    }
    else {
        $claudeJsonObj = Get-Content -LiteralPath $ClaudeJson -Raw | ConvertFrom-Json
        $servers = $claudeJsonObj.mcpServers
        if (-not $servers) {
            Write-Warning "no mcpServers key in $ClaudeJson"
        }
        else {
            $patterns = @(Get-SecretPattern -ScanHookPath (Join-Path $ClaudeHome 'hooks/Scan-MemorySecrets.ps1'))

            # review round 1, F4: .PSObject.Properties.Name on a PSCustomObject with zero
            # NoteProperties (the round trip for "mcpServers": {}) is $null rather than an empty
            # collection, and @($null) is a one-element array holding $null, not an empty one --
            # the same shape as the env loop's phantom-null defect below. Computed once and
            # reused for both the loop and the reported count, so "mcpServers": {} runs zero
            # iterations and reports 0 servers rather than a phantom 1.
            $serverNames = @($servers.PSObject.Properties.Name) | Where-Object { $_ }

            # Fold and gate in one pass. The gate throws before anything is written, so a failed
            # export leaves no half-written file for someone to commit.
            foreach ($name in $serverNames) {
                $srv = $servers.$name
                if ($srv.command) {
                    $srv.command = ConvertTo-TemplatedCommand -Text $srv.command -Folds $folds
                }
                if ($null -ne $srv.args) {
                    $srv.args = @(@($srv.args) | ForEach-Object {
                            ConvertTo-TemplatedCommand -Text $_ -Folds $folds })
                }
                if ($srv.env) {
                    # ConvertFrom-Json on an empty JSON object ("env": {}) yields a PSCustomObject
                    # with zero NoteProperties. Its .PSObject.Properties.Name is $null rather than
                    # an empty collection (measured on pwsh 7.6.5), and @($null) is a one-element
                    # array holding $null, not an empty array. Without the filter, a server with
                    # no env vars (the common case: garmin, 1password) iterates once with $k =
                    # $null, and $srv.env.$k = ... throws PSArgumentException on the null name.
                    foreach ($k in @($srv.env.PSObject.Properties.Name) | Where-Object { $_ }) {
                        $srv.env.$k = ConvertTo-TemplatedCommand -Text $srv.env.$k -Folds $folds
                    }
                }

                # review round 1, F1: gate every string reachable under the POST-FOLD entry, not
                # only command/args/env. The write below serialises the whole $srv object, so a
                # property the fold pass has no rule for reached the file unscanned under the
                # earlier hand-maintained list.
                $strings = @($name) + @(Get-AccountString -Value $srv)
                foreach ($s in $strings) {
                    $hits = @(Test-AccountSecret -Text $s -Patterns $patterns)
                    if ($hits.Count -gt 0) {
                        throw "Refusing to export mcpServers entry '$name': $($hits -join ', '). Server entries reach secrets through 1Password or an environment variable, never inline."
                    }
                    # review round 1, B3: $WslHome can be $null (wsl absent, the distro stopped,
                    # or the shell-out timed out) or an explicit empty string, and either leaves
                    # ConvertTo-TemplatedText's "if (-not $Fold.Literal ...) { return $Text }"
                    # early return doing nothing -- the fold is then silently conditional on wsl
                    # answering at export time, and a run where it does not ships the WSL
                    # username verbatim with exit 0 and no warning naming {{WSL_HOME}}. Gating on
                    # "$WslHome is falsy" directly would need this file to reason about every
                    # falsy shape ($null, '', a value that resolves but happens not to match)
                    # separately. Scanning the post-fold string for the shapes that must never
                    # survive a successful fold covers all of those at once, and reuses the same
                    # scan-and-throw shape the secret gate right above already established,
                    # rather than adding a second kind of gate.
                    #
                    # Backlog item 23: the shape list used to be `/home/<user>` alone, which is
                    # one of four spellings a WSL home takes. $script:PosixHomeShape carries the
                    # enumeration and the reason for each entry.
                    if ($s -match $script:PosixHomeShape) {
                        throw "Refusing to export mcpServers entry '$name': carries an unfolded POSIX home path ('$($Matches[0])'). -WslHome did not resolve (wsl absent, the distro stopped, or an empty override) so the fold could not apply; pass a real -WslHome, or fix the account layer's WSL entry, before exporting."
                    }
                }
            }

            [pscustomobject]@{ mcpServers = $servers } | ConvertTo-Json -Depth 20 |
                Set-Content -LiteralPath (Join-Path $OutputRoot 'mcp-servers.json') -Encoding utf8
            Write-Host "  mcp-servers.json: $(@($serverNames).Count) server(s)$dryRun"
        }
    }
}

# --- residual WSL home, whole payload ----------------------------------------
# The gate inside the mcpServers loop sees mcpServers strings and nothing else. The same WSL home
# literal can reach the payload through a settings hook command, through a copied rules file, or
# through any templated file, and every one of those is on disk by the time this runs. That was
# the second half of backlog item 23: the gate's guarantee read wider than its scope.
#
# Scans for the resolved LITERAL, not for $script:PosixHomeShape. The shape cannot be used over
# the whole tree: the payload legitimately names POSIX home paths in prose, and
# skills/owasp-mcp/references/05-command-injection-execution.md names /root beside /etc/passwd
# and /proc, so a shape scan across 218 files fails on documentation rather than on drift.
# Measured on the live payload before choosing this: an exact-literal scan for the WSL home
# matches nothing there, and the same scan for {{CORE_REPO}} or {{CLAUDE_HOME}} matches nine
# prose-lint calibration comments that carry those paths on purpose -- which is why this scans
# for the one literal that must never survive and not for every fold literal.
#
# When -WslHome did not resolve there is no literal to scan for, and the shape gate on mcpServers
# is what stands. The two are complements: exact where a literal exists, shape where none does.
#
# Throws after the copy rather than before it, unlike the mcpServers gate. Rejected the
# alternative of staging the payload in a temp tree and moving it on success: the marker below is
# what a repeat export trusts, it is written only once every gate has passed, and a destination
# left without one already demands -Force. The cost of the small fix is a partially written
# -OutputRoot on a failed run; the cost of the large one is copying 218 files twice on every run.
if ($WslHome -and -not $WhatIfPreference) {
    # Boundary, not a bare substring test. Review round 3, reproduced on the live payload:
    # $body.Contains($WslHome) reads ANY occurrence of the literal as a machine path, and /root --
    # one of the four shapes $script:PosixHomeShape above declares supported, and what a
    # `wsl --import` distro gives its default user -- is also a substring of the vendored
    # skills/owasp-mcp/references/05-command-injection-execution.md line
    # "Access to sensitive paths (/etc/passwd, /root, /proc/, ~/.ssh)." So `-WslHome /root` aborted
    # after writing 216 files and no marker, and told the operator to edit a third-party OWASP
    # document where the string is not a machine path at all. Direction 1 of item 23 declared
    # /root supported; direction 2 made it fatal. The literal scan chosen above is still the right
    # scan -- it is the BOUNDARY that was missing, not the mechanism.
    #
    # Same idiom $script:PosixHomeShape already uses on its own /root arm, so the two gates agree
    # on where a POSIX home ends: the next character must be a separator, a quote, whitespace, or
    # nothing at all. `/root/x` and a bare `/root` at end of line still fire; `/root,` and
    # `/rootkit` do not.
    #
    # Rejected \b, the obvious smaller boundary: `t` is a word character and `,` is not, so \b
    # matches at exactly the position that has to stop matching and the OWASP line still takes the
    # export down. Rejected excluding vendored trees from the scan: that is a denylist, and it
    # would blind the gate to a vendored file that did carry the operator's own home.
    #
    # -cmatch and not -match: POSIX paths are case-sensitive and .Contains was ordinal, so the
    # case-insensitive default would widen the gate past the boundary this is here to add.
    $wslHomePattern = [regex]::Escape($WslHome) + '(?![^/"''\s])'
    # One buffer for the whole scan, not one per file. IndexOf below is bounded by $read, so bytes
    # left over from a longer previous file are never looked at.
    $head = [byte[]]::new(8000)
    # $outputRootFull, not $OutputRoot: FullName below is absolute, and -OutputRoot may be
    # relative, so the Substring that builds $rel has to be taken against the resolved root.
    foreach ($f in @(Get-ChildItem -LiteralPath $outputRootFull -Recurse -File -Force)) {
        # Skip binary files instead of text-decoding them. Get-Content -Raw decodes every byte of
        # skills/wiring-diagram/examples/'s two PNGs on every export, 600 KB between them, and a
        # decoded byte run that happened to match would abort the export pointing at an image the
        # operator cannot edit. A NUL byte in the head is git's own binary test.
        #
        # Rejected an extension ALLOWLIST of text types: a new text extension would silently drop
        # OUT of the gate, which is the one failure a gate must not have. Rejected a denylist of
        # binary extensions: it needs a new entry per format shipped, and this needs none. Head
        # only, not ReadAllBytes, so the megabyte is never read at all. Measured on the live
        # 218-file payload: exactly the two PNGs carry a NUL byte, the other 216 files carry none.
        $stream = [System.IO.File]::OpenRead($f.FullName)
        try { $read = $stream.Read($head, 0, $head.Length) } finally { $stream.Dispose() }
        if ($read -gt 0 -and [System.Array]::IndexOf($head, [byte]0, 0, $read) -ge 0) { continue }

        $body = Get-Content -LiteralPath $f.FullName -Raw
        if ($body -and $body -cmatch $wslHomePattern) {
            $rel = ($f.FullName.Substring($outputRootFull.Length).TrimStart('\', '/')) -replace '\\', '/'
            throw "Refusing to complete the export: '$rel' still carries the WSL home literal after folding. {{WSL_HOME}} is folded in mcpServers only, so a copy of that path in a rules file, a hook command or a templated file ships verbatim. Remove it at source, or add the file to AccountTemplatedFiles with a WSL_HOME row."
        }
    }
}

# Written only after every copy above completes without throwing, so its presence means this
# -OutputRoot really was produced by a prior export and the non-empty-destination refusal above
# can trust it next time. Sits at the output root rather than inside an allowlisted directory, so
# Copy-AccountTree's per-directory remove-and-recreate never touches it. Set-Content is itself
# ShouldProcess-aware, so under -WhatIf it does not write, matching every other step here.
Set-Content -LiteralPath $exportMarker -Value (
    "Written by Export-Account.ps1. Marks this directory as a known export destination so a " +
    "repeat export does not need -Force. Delete this file (or the whole directory) to require " +
    "-Force again.")

# review round 1, F9: this used to sit above the marker write, so the script announced
# completion before its own last write.
#
# review round 2, item 5: round 1's commit claimed moving the line also stopped it printing
# under -WhatIf. That was false: Write-Host is not ShouldProcess-aware, so a lower position in
# the file does not change whether it runs. This -not $WhatIfPreference guard is what actually
# suppresses it; the position move above is only about ordering relative to the marker write.
if (-not $WhatIfPreference) {
    Write-Host "Export complete. Review with: git diff account/claude"
}
