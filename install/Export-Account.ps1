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
    *.bak.* is dropped.

    A second export with nothing changed produces no diff, which makes `git status` after an
    export a usable review of what changed in the account layer.

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

.PARAMETER VaultPath
    The literal folded into {{OBSIDIAN_VAULT}}. Defaults to $env:CLAUDE_OBSIDIAN_VAULT, else
    $HOME/Documents/Obsidian Vault/Claude Code.

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
# UNWIRED until Task 13 of docs/superpowers/plans/2026-09-03-account-layer-portability.md adds
# its README and rules/harness-core.md registration. Invoke: pwsh -NoProfile -File install/Export-Account.ps1
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
    [string]$VaultPath,
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
        [string[]]$SkipRelative
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
        if ($f.Name -like '*.bak.*') { continue }
        if ($SkipRelative -contains "$Relative/$rel") { continue }
        $dest = Join-Path $to $rel
        $null = New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $copied++
    }
    return $copied
}

$null = New-Item -ItemType Directory -Path $OutputRoot -Force

foreach ($d in $script:AccountTreeDirs) {
    $n = Copy-AccountTree -SourceRoot $ClaudeHome -DestRoot $OutputRoot `
        -Relative $d -SkipRelative $script:AccountSkipFiles
    Write-Host "  ${d}: $n files"
}

foreach ($f in $script:AccountRootFiles) {
    $src = Join-Path $ClaudeHome $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $OutputRoot $f) -Force
        Write-Host "  ${f}: copied"
    }
    else { Write-Warning "absent, skipping: $src" }
}

# --- fold table --------------------------------------------------------------
# Each fold has one named source. {{CLAUDE_HOME}} is the -ClaudeHome value, {{NPM_GLOBAL}} is
# `npm root -g`, {{CORE_REPO}} is the main checkout, {{OBSIDIAN_VAULT}} and {{HOME_SLUG}} come
# from $HOME. Order is immaterial: no literal contains another, since the npm path and the
# vault both sit under the bare home rather than under .claude, and the slug shares no
# characters with any path spelling.
function Get-AccountFoldTable {
    param(
        [string]$ClaudeHome,
        [string]$NpmGlobal,
        [string]$CoreRepo,
        [string]$VaultPath,
        [string]$HomeSlug
    )
    return @(
        [pscustomobject]@{ Token = '{{CLAUDE_HOME}}';    Literal = $ClaudeHome; IsPath = $true }
        [pscustomobject]@{ Token = '{{NPM_GLOBAL}}';     Literal = $NpmGlobal;  IsPath = $true }
        [pscustomobject]@{ Token = '{{CORE_REPO}}';      Literal = $CoreRepo;   IsPath = $true }
        [pscustomobject]@{ Token = '{{OBSIDIAN_VAULT}}'; Literal = $VaultPath;  IsPath = $true }
        [pscustomobject]@{ Token = '{{HOME_SLUG}}';      Literal = $HomeSlug;   IsPath = $false }
    )
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

$homeSlug = Get-ProjectSlug ($HOME)
$folds = @(Get-AccountFoldTable -ClaudeHome $ClaudeHome -NpmGlobal $NpmGlobal `
        -CoreRepo $CoreRepo -VaultPath $VaultPath -HomeSlug $homeSlug)

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

        foreach ($event in $settings.hooks.PSObject.Properties.Name) {
            # Wrap the pipeline OUTPUT, not just the input: a single-match result unwraps to a
            # bare scalar and would serialise "hooks": {...} instead of "hooks": [...], which
            # Claude Code cannot load (install/Install-Harness.ps1:822-826).
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
        Write-Host '  settings.account.json: written'
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
