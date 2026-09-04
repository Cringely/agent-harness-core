# UNWIRED until Task 13 of docs/superpowers/plans/2026-09-03-account-layer-portability.md adds
# its README and rules/harness-core.md registration. Invoke: pwsh -NoProfile -File install/Export-Account.ps1
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

.EXAMPLE
    pwsh -NoProfile -File install/Export-Account.ps1
#>
# PositionalBinding=$false, not a position list: Restore-ClaudeProject.ps1:71-95 records that
# PowerShell auto-assigns a position to every non-switch parameter lacking one, in declaration
# order, so a later-added seam silently becomes positional and a stray extra argument sets it
# without a binding error. Unlike Restore this script has no existing positional callers.
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$ClaudeHome,
    [string]$ClaudeJson,
    [string]$OutputRoot,
    [string]$CoreRepo,
    [string]$NpmGlobal,
    [string]$VaultPath,
    [switch]$SkipSettings,
    [switch]$SkipMcp
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
