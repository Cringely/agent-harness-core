<#
.SYNOPSIS
    Installs the agent-harness-core layout (agents, hooks, guardrails, settings hooks)
    into a target project's .claude directory.

.DESCRIPTION
    Copies core/claude/agents, core/claude/hooks, and the guardrails template into
    <Target>/.claude, deep-merges the hook registrations from
    core/claude/templates/settings.hooks.json into <Target>/.claude/settings.json,
    and tracks installed-file hashes in <Target>/.claude/.harness-manifest.json so
    re-installs never silently clobber a project-modified file.

    Ceremony components (wave-close-handoff.sh hook, soc-monitor.md agent,
    ceremony-ledger.json and their hook registrations) assume wave/standup ceremony
    infrastructure most projects lack, and are only installed with -IncludeCeremonies.

.PARAMETER Target
    Project root to install into. Must already exist.

.PARAMETER Force
    Overwrite files even if they were modified since the last install.

.PARAMETER IncludeCeremonies
    Also install the ceremony-gated agent, hook, ledger, and hook registration.

.PARAMETER Audit
    Report-only drift check; writes nothing. Three-way compare (core source vs
    manifest hash vs installed file) classifies every managed file:
      in-sync           installed file matches current core
      core-updated      core changed since install, project didn't — re-run installer
      project-modified  project changed it, core didn't — promotion candidate for core
      conflict          both sides changed — reconcile by hand
      missing           in manifest but deleted from the project
      not-installed     new in core since last install
      untracked         present in .claude but never installed via manifest
      orphaned          in manifest but no longer shipped by core
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    [switch]$Force,

    [switch]$IncludeCeremonies,

    [switch]$Audit
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    throw "Target path does not exist or is not a directory: $Target"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$coreDir = Join-Path $repoRoot 'core/claude'
$agentsSrc = Join-Path $coreDir 'agents'
$hooksSrc = Join-Path $coreDir 'hooks'
$templatesSrc = Join-Path $coreDir 'templates'

$claudeDir = Join-Path $Target '.claude'
$agentsDst = Join-Path $claudeDir 'agents'
$hooksDst = Join-Path $claudeDir 'hooks'

if (-not $Audit) {
    foreach ($dir in @($claudeDir, $agentsDst, $hooksDst)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
}

# Components that require -IncludeCeremonies (wave/standup ceremony infrastructure
# most projects lack).
$ceremonyAgentNames = @('soc-monitor.md')
$ceremonyHookNames = @('wave-close-handoff.sh')
$ceremonyCommandPattern = 'wave-close-handoff\.sh'

function Get-FileHashHex {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$manifestPath = Join-Path $claudeDir '.harness-manifest.json'
$manifest = @{}
if (Test-Path -LiteralPath $manifestPath) {
    $raw = Get-Content -LiteralPath $manifestPath -Raw
    if ($raw.Trim()) {
        $loaded = $raw | ConvertFrom-Json -AsHashtable
        foreach ($key in $loaded.Keys) { $manifest[$key] = $loaded[$key] }
    }
}

$results = New-Object System.Collections.Generic.List[pscustomobject]

if ($Audit) {
    # Map of every file core ships (ceremony files included — if a project installed
    # them, they should be audited regardless of which switches this run got).
    $coreFiles = [ordered]@{}
    Get-ChildItem -LiteralPath $agentsSrc -Filter '*.md' -File | ForEach-Object {
        $coreFiles["agents/$($_.Name)"] = $_.FullName
    }
    Get-ChildItem -LiteralPath $hooksSrc -File | Where-Object { $_.Name -ne '.gitkeep' } | ForEach-Object {
        $coreFiles["hooks/$($_.Name)"] = $_.FullName
    }
    $coreFiles['guardrails.md'] = Join-Path $templatesSrc 'guardrails.template.md'

    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Write-Host "No .harness-manifest.json in $claudeDir — harness was never installed here via the installer."
        Write-Host "Files below compare the project's .claude directly against core:"
    }

    $allKeys = @($coreFiles.Keys) + @($manifest.Keys | Where-Object { $coreFiles.Keys -notcontains $_ }) | Select-Object -Unique
    foreach ($key in $allKeys) {
        # Live-state files are expected to diverge; hash comparison is meaningless.
        if ($key -eq 'ceremony-ledger.json') {
            $results.Add([pscustomobject]@{ File = $key; Status = 'stateful (not audited)' })
            continue
        }

        $srcPath = $coreFiles[$key]
        $dstPath = Join-Path $claudeDir $key
        $inManifest = $manifest.Contains($key)
        $dstExists = Test-Path -LiteralPath $dstPath -PathType Leaf

        if (-not $srcPath) {
            $results.Add([pscustomobject]@{ File = $key; Status = 'orphaned' })
            continue
        }

        $srcHash = Get-FileHashHex -Path $srcPath
        if (-not $dstExists) {
            $status = if ($inManifest) { 'missing' } else { 'not-installed' }
            $results.Add([pscustomobject]@{ File = $key; Status = $status })
            continue
        }

        $dstHash = Get-FileHashHex -Path $dstPath
        if (-not $inManifest) {
            $status = if ($dstHash -eq $srcHash) { 'untracked (matches core)' } else { 'untracked (differs from core)' }
            $results.Add([pscustomobject]@{ File = $key; Status = $status })
            continue
        }

        $recHash = $manifest[$key]
        $status = if ($dstHash -eq $srcHash) { 'in-sync' }
        elseif ($dstHash -eq $recHash) { 'core-updated' }
        elseif ($srcHash -eq $recHash) { 'project-modified' }
        else { 'conflict' }
        $results.Add([pscustomobject]@{ File = $key; Status = $status })
    }

    $results | Format-Table -AutoSize | Out-String | Write-Host

    $attention = @($results | Where-Object { $_.Status -notin @('in-sync', 'stateful (not audited)') })
    if ($attention.Count -eq 0) {
        Write-Host 'All managed files in sync with core.'
    }
    else {
        Write-Host "$($attention.Count) file(s) need attention. project-modified/untracked-differs = candidates to promote into core; core-updated/not-installed = re-run installer to pull down."
    }
    return
}

function Install-ManagedFile {
    param(
        [string]$SourcePath,
        [string]$DestPath,
        [string]$ManifestKey
    )

    $sourceHash = Get-FileHashHex -Path $SourcePath

    if (-not (Test-Path -LiteralPath $DestPath)) {
        Copy-Item -LiteralPath $SourcePath -Destination $DestPath -Force
        $script:manifest[$ManifestKey] = $sourceHash
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'installed' })
        return
    }

    $currentHash = Get-FileHashHex -Path $DestPath
    $recordedHash = $script:manifest[$ManifestKey]

    # Hand-built layer predating the manifest: a file already identical to core is
    # adopted into tracking instead of warned about, so planting a baseline on an
    # existing .claude never requires -Force for files that match.
    if (-not $recordedHash -and $currentHash -eq $sourceHash) {
        $script:manifest[$ManifestKey] = $sourceHash
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'adopted' })
        return
    }

    if ($recordedHash -and $currentHash -eq $recordedHash) {
        if ($currentHash -ne $sourceHash) {
            Copy-Item -LiteralPath $SourcePath -Destination $DestPath -Force
            $script:manifest[$ManifestKey] = $sourceHash
            $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'updated' })
        }
        else {
            $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'unchanged' })
        }
        return
    }

    if ($Force) {
        Copy-Item -LiteralPath $SourcePath -Destination $DestPath -Force
        $script:manifest[$ManifestKey] = $sourceHash
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'forced-overwrite' })
        return
    }

    Write-Warning "Skipping '$ManifestKey': modified since install. Use -Force to overwrite."
    $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'skipped-modified' })
}

# Agents
Get-ChildItem -LiteralPath $agentsSrc -Filter '*.md' -File | ForEach-Object {
    if (-not $IncludeCeremonies -and $ceremonyAgentNames -contains $_.Name) { return }
    Install-ManagedFile -SourcePath $_.FullName -DestPath (Join-Path $agentsDst $_.Name) -ManifestKey "agents/$($_.Name)"
}

# Hooks
Get-ChildItem -LiteralPath $hooksSrc -File | Where-Object { $_.Name -ne '.gitkeep' } | ForEach-Object {
    if (-not $IncludeCeremonies -and $ceremonyHookNames -contains $_.Name) { return }
    Install-ManagedFile -SourcePath $_.FullName -DestPath (Join-Path $hooksDst $_.Name) -ManifestKey "hooks/$($_.Name)"
}

# Guardrails
Install-ManagedFile -SourcePath (Join-Path $templatesSrc 'guardrails.template.md') `
    -DestPath (Join-Path $claudeDir 'guardrails.md') `
    -ManifestKey 'guardrails.md'

# Ceremony ledger: never overwritten once it exists (it holds live state), and only
# installed at all under -IncludeCeremonies.
if ($IncludeCeremonies) {
    $ledgerDst = Join-Path $claudeDir 'ceremony-ledger.json'
    if (Test-Path -LiteralPath $ledgerDst) {
        $results.Add([pscustomobject]@{ File = 'ceremony-ledger.json'; Action = 'skipped-exists' })
    }
    else {
        $ledgerSrc = Join-Path $templatesSrc 'ceremony-ledger.template.json'
        Copy-Item -LiteralPath $ledgerSrc -Destination $ledgerDst -Force
        $manifest['ceremony-ledger.json'] = Get-FileHashHex -Path $ledgerDst
        $results.Add([pscustomobject]@{ File = 'ceremony-ledger.json'; Action = 'installed' })
    }
}

# Settings merge
$settingsPath = Join-Path $claudeDir 'settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
    $raw = Get-Content -LiteralPath $settingsPath -Raw
    if ($raw.Trim()) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }
}
else {
    [pscustomobject]@{}
}

if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}

$hooksTemplate = (Get-Content -LiteralPath (Join-Path $templatesSrc 'settings.hooks.json') -Raw | ConvertFrom-Json).hooks

foreach ($eventType in $hooksTemplate.PSObject.Properties.Name) {
    $templateGroups = @($hooksTemplate.$eventType)

    # Drop ceremony-gated hook entries unless -IncludeCeremonies was passed.
    $filteredGroups = New-Object System.Collections.Generic.List[pscustomobject]
    foreach ($group in $templateGroups) {
        # Wrap the pipeline OUTPUT (not just the input) in @(): PowerShell unwraps a
        # single-match Where-Object result to a bare scalar, which would later
        # serialize "hooks": {...} instead of "hooks": [...] in settings.json.
        $groupHooks = @($group.hooks | Where-Object {
            $IncludeCeremonies -or ($_.command -notmatch $ceremonyCommandPattern)
        })
        if ($groupHooks.Count -gt 0) {
            $newGroup = [pscustomobject]@{}
            if ($group.PSObject.Properties['matcher']) {
                $newGroup | Add-Member -NotePropertyName matcher -NotePropertyValue $group.matcher
            }
            $newGroup | Add-Member -NotePropertyName hooks -NotePropertyValue $groupHooks
            $filteredGroups.Add($newGroup)
        }
    }
    if ($filteredGroups.Count -eq 0) { continue }

    if (-not $settings.hooks.PSObject.Properties[$eventType]) {
        $settings.hooks | Add-Member -NotePropertyName $eventType -NotePropertyValue @()
    }
    $existingGroups = New-Object System.Collections.Generic.List[pscustomobject]
    foreach ($g in @($settings.hooks.$eventType)) { $existingGroups.Add($g) }

    $existingCommands = New-Object System.Collections.Generic.List[string]
    foreach ($g in $existingGroups) {
        foreach ($h in @($g.hooks)) { $existingCommands.Add($h.command) }
    }

    foreach ($group in $filteredGroups) {
        # Same scalar-collapse hazard as above: wrap the pipeline output, not the input.
        $newHooks = @($group.hooks | Where-Object { -not $existingCommands.Contains($_.command) })
        if ($newHooks.Count -gt 0) {
            $newGroup = [pscustomobject]@{}
            if ($group.PSObject.Properties['matcher']) {
                $newGroup | Add-Member -NotePropertyName matcher -NotePropertyValue $group.matcher
            }
            $newGroup | Add-Member -NotePropertyName hooks -NotePropertyValue $newHooks
            $existingGroups.Add($newGroup)
            foreach ($h in $newHooks) { $existingCommands.Add($h.command) }
            $results.Add([pscustomobject]@{ File = "settings.json:$eventType"; Action = 'merged' })
        }
    }
    $settings.hooks.$eventType = $existingGroups.ToArray()
}

$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath

$results | Format-Table -AutoSize | Out-String | Write-Host
