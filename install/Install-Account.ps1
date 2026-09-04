# UNWIRED until Task 13 of docs/superpowers/plans/2026-09-03-account-layer-portability.md adds
# its README and rules/harness-core.md registration. Invoke: pwsh -NoProfile -File install/Install-Account.ps1
<#
.SYNOPSIS
    Installs this repo's account/claude payload onto a workstation's ~/.claude.

.DESCRIPTION
    Runs on any workstation from a clone, on Windows or Linux. Content directories are copied
    over the top of ~/.claude. Four things the copy cannot do on its own are handled here:
    placeholder expansion, the Linux invocation rewrite, a settings merge that does not clobber
    what Claude Code writes into settings.json itself, and a residual-path report.

    The update path is `git pull` then re-run this script. Install overwrites;
    settings.local.json is the per-machine escape hatch. Removal does not propagate to a
    receiver and a receiver's own edit to an installed file is reverted without comment. Both
    follow from having no manifest, and both are intended.

.PARAMETER ClaudeHome
    Where to install. Defaults to $HOME/.claude.

.PARAMETER ClaudeJson
    The file holding mcpServers. Defaults to $HOME/.claude.json.

.PARAMETER PayloadRoot
    Where to install from. Defaults to account/claude under the running clone.

.PARAMETER CoreRepo
    Expands {{CORE_REPO}} and sources model-tier-gate.ts. Defaults to the running clone.

.PARAMETER NpmGlobal
    Expands {{NPM_GLOBAL}}. Defaults to `npm root -g`. Pass an empty string to take the
    npm-absent branch, which drops the two ccstatusline hook entries and points
    statusLine.command at the shipped script for the platform.

.PARAMETER TargetIsWindows
    Which platform the install is being prepared for. Defaults to the platform actually
    running. A real run should never pass it; it exists so the tests can reach the Linux-only
    branches from a Windows host, which is the same seam and the same reason as
    Restore-ClaudeProject.ps1:88-95.

.PARAMETER SkipPreflight
    Skip the prerequisite probe. Test seam.

.EXAMPLE
    pwsh -NoProfile -File install/Install-Account.ps1
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$ClaudeHome,
    [string]$ClaudeJson,
    [string]$PayloadRoot,
    [string]$CoreRepo,
    [string]$NpmGlobal,
    [bool]$TargetIsWindows = $(if ($PSVersionTable.PSVersion.Major -lt 6) { $true } else { $IsWindows }),
    [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AccountShared.ps1')

$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $ClaudeHome)  { $ClaudeHome = Join-Path $HOME '.claude' }
if (-not $ClaudeJson)  { $ClaudeJson = Join-Path $HOME '.claude.json' }
if (-not $PayloadRoot) { $PayloadRoot = Join-Path (Join-Path $repoRoot 'account') 'claude' }

# Same reasoning and same placement as Export-Account.ps1's guard: right after the defaults
# that determine what gets read from and written into land, before CoreRepo/NpmGlobal resolve
# and before anything under -ClaudeHome is touched. This script is the more dangerous half,
# since -ClaudeHome defaults to the operator's live ~/.claude and the copy below writes over
# it, so a bare `. install/Install-Account.ps1` with no arguments overwrites the live account
# layer from whatever payload happens to sit in this clone.
if ($MyInvocation.InvocationName -eq '.') {
    throw "Install-Account.ps1 runs the install on load; dot-sourcing it installs against live defaults. Run it: pwsh -NoProfile -File install/Install-Account.ps1"
}

if (-not $CoreRepo)    { $CoreRepo = $repoRoot }

# ContainsKey, not a truthiness check: an explicitly passed empty string means "npm is absent"
# and is how the tests reach that branch, while an omitted parameter means "go look".
# Get-Command first: calling a native command that is not on PATH is a terminating
# CommandNotFoundException, which 2>$null does not swallow, so a clean box without npm would
# take the installer down on line 1 instead of reaching the npm-absent branch this file exists
# to serve.
if (-not $PSBoundParameters.ContainsKey('NpmGlobal')) {
    $NpmGlobal = if (Get-Command npm -ErrorAction SilentlyContinue) {
        $v = (& npm root -g 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0) { $v } else { $null }
    } else { $null }
}
$npmPresent = [bool]$NpmGlobal

if (-not (Test-Path -LiteralPath $PayloadRoot)) {
    throw "No payload at '$PayloadRoot'. Run install/Export-Account.ps1 on the canonical workstation first."
}

Write-Host "Target platform : $(if ($TargetIsWindows) { 'Windows' } else { 'Linux' })"
Write-Host "Payload         : $PayloadRoot"
Write-Host "Claude home     : $ClaudeHome"

# Every consumer of these fails open when the tool is absent, so without this the kit goes
# silently dead on a fresh box and looks installed. jq only matters on Linux when the
# npm-absent branch points statusLine.command at statusline-command.sh, which calls jq three
# times.
function Test-Prerequisite {
    param([bool]$NeedJq)
    $wanted = @('pwsh', 'vale', 'bun', 'node', 'bash', 'uvx')
    if ($NeedJq) { $wanted += 'jq' }
    $missing = @()
    foreach ($t in $wanted) {
        if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { $missing += $t }
    }
    return @($missing)
}

if (-not $SkipPreflight) {
    $needJq = (-not $TargetIsWindows) -and (-not $npmPresent)
    $missing = @(Test-Prerequisite -NeedJq $needJq)
    if ($missing.Count -gt 0) {
        Write-Warning "Not on PATH: $($missing -join ', '). Each one's consumer fails open, so the feature it drives will be silently absent rather than reporting an error."
    }
}

function Copy-PayloadTree {
    param([string]$PayloadRoot, [string]$ClaudeHome, [string]$Relative)
    $from = Join-Path $PayloadRoot $Relative
    $to = Join-Path $ClaudeHome $Relative
    if (-not (Test-Path -LiteralPath $from)) { return 0 }
    $null = New-Item -ItemType Directory -Path $to -Force
    $copied = 0
    foreach ($f in @(Get-ChildItem -LiteralPath $from -Recurse -File -Force)) {
        $rel = ($f.FullName.Substring($from.Length).TrimStart('\', '/')) -replace '\\', '/'
        $dest = Join-Path $to $rel
        $null = New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $copied++
    }
    return $copied
}

$null = New-Item -ItemType Directory -Path $ClaudeHome -Force

foreach ($d in $script:AccountTreeDirs) {
    $n = Copy-PayloadTree -PayloadRoot $PayloadRoot -ClaudeHome $ClaudeHome -Relative $d
    Write-Host "  ${d}: $n files"
}
foreach ($f in $script:AccountRootFiles) {
    $src = Join-Path $PayloadRoot $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $ClaudeHome $f) -Force
    }
}

# Core is authoritative for this one file, so it comes out of core/ in the same clone rather
# than out of the payload. Two copies in one repo would drift the moment either was edited.
$gateSrc = Join-Path $CoreRepo 'core/claude/hooks/model-tier-gate.ts'
if (Test-Path -LiteralPath $gateSrc) {
    $null = New-Item -ItemType Directory -Path (Join-Path $ClaudeHome 'hooks') -Force
    Copy-Item -LiteralPath $gateSrc -Destination (Join-Path $ClaudeHome 'hooks/model-tier-gate.ts') -Force
    Write-Host '  hooks/model-tier-gate.ts: from core'
}
else {
    Write-Warning "Absent: $gateSrc. The model-tier gate will not be installed, and a model-less Agent dispatch will not be blocked."
}

# Same CommandNotFoundException hazard as npm above, and this one fires on the Windows box
# whenever a test drives the Linux branch: `& chmod` with no chmod on PATH is terminating, so
# the round-trip test in Task 12 would die here rather than assert on the installed tree.
$chmod = Get-Command chmod -ErrorAction SilentlyContinue
if (-not $TargetIsWindows -and $chmod) {
    foreach ($s in @(Get-ChildItem (Join-Path $ClaudeHome 'hooks') -Recurse -File -Filter *.sh -ErrorAction SilentlyContinue)) {
        & $chmod.Source +x $s.FullName
    }
}
elseif (-not $TargetIsWindows) {
    Write-Warning 'chmod not on PATH: .sh hooks are not marked executable. Run `chmod +x ~/.claude/hooks/*.sh` on the target.'
}
