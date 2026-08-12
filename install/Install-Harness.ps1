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

    The manifest is v2: installed-file hashes live under `files`, deliberate project
    forks pinned with -Accept live under `accepted`, and `coreRepo`/`coreCommit`
    record where this layer came from. A v1 manifest (a flat path-to-hash map) is
    migrated on load, preserving every hash under `files`.

    Ceremony components (wave-close-handoff.sh hook, soc-monitor.md agent,
    ceremony-ledger.json and their hook registrations) assume wave/standup ceremony
    infrastructure most projects lack, and are only installed with -IncludeCeremonies.

.PARAMETER Target
    Project root to install into. Must already exist.

.PARAMETER Force
    Overwrite files even if they were modified since the last install.

.PARAMETER IncludeCeremonies
    Also install the ceremony-gated agent, hook, ledger, and hook registration.

.PARAMETER Accept
    Pin a project file as an accepted overlay, recording its current hash under the
    manifest's `accepted` map. The audit then reports it as `overlay (accepted)` and
    leaves it out of the attention count until the fork moves again. Takes a path
    relative to the project's .claude directory; a path resolving outside that directory
    is rejected, as is one already tracked in `files`. Writes the manifest and nothing else.

.PARAMETER Audit
    Report-only drift check; writes nothing. Three-way compare (core source vs
    manifest hash vs installed file) classifies every managed file:
      in-sync            installed file matches current core
      core-updated       core changed since install, project didn't — re-run installer
      project-modified   project changed it, core didn't — promotion candidate for core
      conflict           both sides changed — reconcile by hand
      missing            in manifest but deleted from the project
      not-installed      new in core since last install
      untracked          present in .claude but never installed via manifest
      orphaned           in manifest but no longer shipped by core
      overlay (accepted) pinned fork, still at the hash it was pinned at
      overlay (changed)  pinned fork has moved since pinning — re-review, re-pin
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    [switch]$Force,

    [switch]$IncludeCeremonies,

    [string]$Accept,

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
$scratchDst = Join-Path $claudeDir 'scratch'

# -Accept is a standalone action on an existing layer, not an install: it must not
# conjure a .claude tree. A missing directory there is the "file does not exist" case
# its own guard reports, and reporting that beats silently creating an empty layout.
if (-not $Audit -and -not $Accept) {
    foreach ($dir in @($claudeDir, $agentsDst, $hooksDst, $scratchDst)) {
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

# Claude Code plugins install to ~/.claude/plugins/cache/<marketplace>/<plugin>/ at
# account/machine scope, outside anything this installer manages. It cannot install one,
# only detect which are present so a session on this machine knows what to assume.
function Get-DetectedPlugins {
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $pluginsCacheDir = Join-Path $homeDir '.claude/plugins/cache'
    if (-not (Test-Path -LiteralPath $pluginsCacheDir -PathType Container)) {
        return @()
    }
    # This probe must never fail the install: unreadable/permission-denied cache dirs,
    # or files sitting where a directory is expected, all degrade to "no plugins found"
    # rather than propagating under the script's $ErrorActionPreference = 'Stop'.
    # -ErrorAction SilentlyContinue alone isn't enough here (Test-Path above, or a
    # non-filesystem provider error, could still throw), so wrap the whole scan.
    try {
        $found = New-Object System.Collections.Generic.List[string]
        Get-ChildItem -LiteralPath $pluginsCacheDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $marketplace = $_.Name
            Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                $found.Add("$marketplace/$($_.Name)")
            }
        }
        return @($found | Sort-Object)
    } catch {
        return @()
    }
}

# Output styles are a different mechanism from plugins entirely: markdown files under
# ~/.claude/output-styles/*.md, plus an active-style pointer in ~/.claude/settings.json's
# `outputStyle` key. Same detect-only contract as plugins — same never-fail requirement,
# since a hand-edited settings.json is exactly the malformed-JSON case this has to survive.
function Get-DetectedOutputStyles {
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $found = New-Object System.Collections.Generic.List[string]

    try {
        $stylesDir = Join-Path $homeDir '.claude/output-styles'
        if (Test-Path -LiteralPath $stylesDir -PathType Container) {
            Get-ChildItem -LiteralPath $stylesDir -Filter '*.md' -File -ErrorAction SilentlyContinue | ForEach-Object {
                $found.Add([System.IO.Path]::GetFileNameWithoutExtension($_.Name))
            }
        }
    } catch { }

    try {
        $homeSettingsPath = Join-Path $homeDir '.claude/settings.json'
        if (Test-Path -LiteralPath $homeSettingsPath -PathType Leaf) {
            $raw = Get-Content -LiteralPath $homeSettingsPath -Raw -ErrorAction Stop
            if ($raw.Trim()) {
                $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
                if ($parsed.PSObject.Properties['outputStyle'] -and $parsed.outputStyle) {
                    $found.Add([string]$parsed.outputStyle)
                }
            }
        }
    } catch { }

    return @($found | Sort-Object -Unique)
}

# MCP servers are configured, not installed as files: the `mcpServers` object in
# ~/.claude/settings.json (account scope) and/or <Target>/.mcp.json (project scope). Same
# detect-only, never-fail contract — a broken .mcp.json is the realistic case here, since
# it's hand-edited far more often than plugins or output styles are.
function Get-DetectedMcpServers {
    param([string]$TargetPath)
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $found = New-Object System.Collections.Generic.List[string]

    $sources = @(
        (Join-Path $homeDir '.claude/settings.json'),
        (Join-Path $TargetPath '.mcp.json')
    )
    foreach ($path in $sources) {
        try {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
                if ($raw.Trim()) {
                    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
                    if ($parsed.PSObject.Properties['mcpServers'] -and $parsed.mcpServers) {
                        foreach ($name in @($parsed.mcpServers.PSObject.Properties.Name)) {
                            $found.Add($name)
                        }
                    }
                }
            }
        } catch { }
    }

    return @($found | Sort-Object -Unique)
}

# Provenance for the manifest's coreCommit. git is optional here for the same reason it is
# optional for the core.hooksPath wiring further down: a core checkout that is not a git
# repository (an exported copy, a vendored drop) still installs, it just records no commit.
# Two failure modes, two guards. A missing git binary raises CommandNotFoundException, which
# is terminating under this script's $ErrorActionPreference and needs the try/catch; a git
# that runs and fails (not a repository, no commits yet) exits non-zero without tripping
# $ErrorActionPreference at all and needs the explicit $LASTEXITCODE check.
function Get-CoreCommit {
    try {
        $out = & git -C $script:repoRoot rev-parse --short HEAD 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $text = ([string]$out).Trim()
        if (-not $text) { return $null }
        return $text
    }
    catch {
        return $null
    }
}

# Manifest v2. v1 was a flat map of relative path to SHA256 (plus the stackDetected record).
# v2 moves that map under `files` and adds three siblings: `accepted`, which pins deliberate
# project forks at their own hash, plus `coreRepo` and `coreCommit`. Every load migrates, so
# the rest of the script only ever sees v2; the migrated shape reaches disk only where the
# script already writes the manifest, which is why -Audit still writes nothing.
#
# Hand-edited manifests in the wild are the reason this is a function with a shape check
# rather than three inline assignments. Three cases it has to survive without losing data:
# a v1 map with no stackDetected, a v1 map carrying a stray `files` key from something else,
# and a v2 map whose `accepted` was hand-edited to a non-map.
function ConvertTo-ManifestV2 {
    param($Loaded)

    $m = @{}
    if ($Loaded -is [System.Collections.IDictionary]) {
        # Snapshot the keys: the loop below writes into $m, and enumerating a dictionary
        # while it is being modified throws.
        foreach ($key in @($Loaded.Keys)) { $m[$key] = $Loaded[$key] }
    }

    # A `files` key alone does not make a manifest v2, so the shape is what decides. Both
    # System.String and Object[] answer .Contains() without throwing, so trusting mere
    # presence would let a hand-edited `"files": "yes"` substring-match every file path the
    # audit looks up, and report nonsense instead of failing. Only a real map counts.
    # Anything else falls through to migration, which folds the stray value in with the rest
    # under `files` rather than dropping it, and the audit then shows it as an orphaned row.
    $isV2 = $m.Contains('files') -and $m['files'] -is [System.Collections.IDictionary]

    if (-not $isV2) {
        $files = @{}
        foreach ($key in @($m.Keys)) {
            if ($key -eq 'stackDetected') { continue }
            $files[$key] = $m[$key]
        }

        # stackDetected stays a top-level sibling of files/accepted/coreRepo/coreCommit.
        # It is a record of the machine's plugin and MCP stack, not a tracked file, and
        # folding it into `files` would put it through the hash audit as an orphan.
        $stack = $null
        $hadStack = $m.Contains('stackDetected')
        if ($hadStack) { $stack = $m['stackDetected'] }

        $m = @{ files = $files }
        if ($hadStack) { $m['stackDetected'] = $stack }
        $m['coreRepo'] = $script:repoRoot
        $m['coreCommit'] = Get-CoreCommit
    }

    # Degrade a missing or wrong-typed map to an empty one rather than throwing, matching how
    # the audit already treats a hand-edited stackDetected. A non-map `accepted` holds no pin
    # data worth preserving, and every caller below assumes it answers .Contains().
    if ($m['files'] -isnot [System.Collections.IDictionary]) { $m['files'] = @{} }
    if ($m['accepted'] -isnot [System.Collections.IDictionary]) { $m['accepted'] = @{} }

    return $m
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
$manifest = ConvertTo-ManifestV2 -Loaded $manifest

# -Accept: a standalone action, deliberately not composed with an install. Pinning a fork and
# copying core files over the project are opposite intentions, and running an install to get a
# pin would mean the pin arrives alongside overwrites the operator did not ask for.
if ($Accept) {
    # The argument is documented as relative to .claude, and everything downstream depends on
    # that holding: the manifest key is matched against audit rows built from that directory, and
    # a pin only means anything for a file inside the layer this installer manages. So the path
    # is canonicalized and checked for containment before anything else happens. Without this an
    # operator typo pins a file no install will ever touch, and the audit then carries a row for
    # a path outside the project's .claude forever.
    if ([System.IO.Path]::IsPathRooted($Accept)) {
        throw "-Accept '$Accept': absolute paths are not accepted. Pass a path relative to the project's .claude directory."
    }

    # Join-Path with a rooted second argument produces a nonsense path rather than replacing the
    # base, which is why the rooted case is rejected above instead of being left to the check
    # below. PowerShell's location and [Environment]::CurrentDirectory are separate values, so
    # [System.IO.Path]::GetFullPath would canonicalize a relative -Target against the wrong base;
    # GetUnresolvedProviderPathFromPSPath uses PowerShell's own location, and unlike Resolve-Path
    # it does not require the path to exist. Missing files are reported by their own guard below,
    # which says something more useful than a resolver error would.
    $claudeFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($claudeDir)
    $acceptPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Join-Path $claudeDir $Accept))

    # GetRelativePath rather than a string prefix compare, because it applies the platform's own
    # path comparison rules: it will not miss a case-variant escape on Windows, and it will not
    # reject a legitimately case-distinct sibling on Linux. It also returns a rooted path when
    # the two sit on different volumes, which the same test catches.
    $relative = [System.IO.Path]::GetRelativePath($claudeFull, $acceptPath)
    $escapes = [System.IO.Path]::IsPathRooted($relative) -or
        $relative -eq '..' -or
        $relative.StartsWith('..' + [System.IO.Path]::DirectorySeparatorChar)
    if ($escapes) {
        throw "-Accept '$Accept': resolves to '$acceptPath', outside the project's .claude directory. Pass a path relative to that directory."
    }

    # Manifest keys are written with forward slashes. A path tab-completed on Windows arrives
    # with backslashes and would otherwise pin a key that never matches an audit row. Taking the
    # key from the canonical relative path also collapses an interior '..' segment, so
    # 'agents/../guardrails.md' pins the key the audit already uses for that same file rather
    # than a second key naming it a different way.
    $acceptKey = $relative -replace '\\', '/'

    if (-not (Test-Path -LiteralPath $acceptPath -PathType Leaf)) {
        throw "-Accept '$Accept': file does not exist at $acceptPath. Pass a path relative to the project's .claude directory."
    }

    if ($manifest['files'].Contains($acceptKey)) {
        throw "-Accept '$acceptKey': already tracked in the manifest's files map, so it is an installed file rather than an overlay. Accepting it would drop the record of which core version it came from. Promote the change into core, or drop it from files first."
    }

    $manifest['accepted'][$acceptKey] = Get-FileHashHex -Path $acceptPath
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath
    Write-Host "Accepted overlay '$acceptKey' pinned at $($manifest['accepted'][$acceptKey])."
    return
}

$results = New-Object System.Collections.Generic.List[pscustomobject]
# Wrap the call, not just the function's internal `return @()`: a function's empty-array
# return crosses the pipeline like any other output, and zero pipeline objects captured
# into a variable collapse to $null rather than an empty array (same scalar-collapse
# hazard as the single-element case noted elsewhere in this file, zero-element variant).
$detectedPlugins = @(Get-DetectedPlugins)
$detectedOutputStyles = @(Get-DetectedOutputStyles)
$detectedMcpServers = @(Get-DetectedMcpServers -TargetPath $Target)

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
    $coreFiles['scratch/.gitignore'] = Join-Path $templatesSrc 'scratch.gitignore'

    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Write-Host "No .harness-manifest.json in $claudeDir — harness was never installed here via the installer."
        Write-Host "Files below compare the project's .claude directly against core:"
    }

    # Three sources, because each one holds keys the other two do not. Core ships files a
    # project has not installed yet; the manifest's files map holds files core has since
    # dropped; and `accepted` holds project forks core may never have shipped at all. Leaving
    # accepted out of the union is the subtle one: such a key matches nothing in the other two
    # sources, so its row disappears from the table entirely and the operator reads an
    # accepted overlay as absent rather than as accepted.
    # stackDetected, coreRepo, and coreCommit are manifest records rather than tracked files
    # and live outside `files`, so nothing here has to filter them out.
    $acceptedMap = $manifest['accepted']
    $allKeys = @($coreFiles.Keys) + @($manifest['files'].Keys) + @($acceptedMap.Keys) | Select-Object -Unique
    foreach ($key in $allKeys) {
        # Live-state files are expected to diverge; hash comparison is meaningless.
        if ($key -eq 'ceremony-ledger.json') {
            $results.Add([pscustomobject]@{ File = $key; Status = 'stateful (not audited)' })
            continue
        }

        $srcPath = $coreFiles[$key]
        $dstPath = Join-Path $claudeDir $key
        $inManifest = $manifest['files'].Contains($key)
        $dstExists = Test-Path -LiteralPath $dstPath -PathType Leaf

        # An accepted overlay is judged against the hash it was pinned at, never against core:
        # the whole point of the pin is that the project's version is the intended one. That
        # holds whether or not core ships the file, so this runs ahead of the orphaned check.
        # Routing it through that check instead would label a fork core never shipped
        # 'orphaned', which reads as leftover junk rather than as a deliberate overlay.
        if ($acceptedMap.Contains($key)) {
            if (-not $dstExists) {
                $results.Add([pscustomobject]@{ File = $key; Status = 'missing' })
                continue
            }
            $pinnedHash = $acceptedMap[$key]
            $dstHash = Get-FileHashHex -Path $dstPath
            $status = if ($dstHash -eq $pinnedHash) { 'overlay (accepted)' } else { 'overlay (changed)' }
            $results.Add([pscustomobject]@{ File = $key; Status = $status })
            continue
        }

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

        $recHash = $manifest['files'][$key]
        $status = if ($dstHash -eq $srcHash) { 'in-sync' }
        elseif ($dstHash -eq $recHash) { 'core-updated' }
        elseif ($srcHash -eq $recHash) { 'project-modified' }
        else { 'conflict' }
        $results.Add([pscustomobject]@{ File = $key; Status = $status })
    }

    $results | Format-Table -AutoSize | Out-String | Write-Host

    # 'overlay (accepted)' is silent by design: the pin exists precisely so a deliberate fork
    # stops counting as drift. 'overlay (changed)' is not on this list, because a fork that
    # moved since pinning is exactly what the operator asked to be told about.
    $attention = @($results | Where-Object { $_.Status -notin @('in-sync', 'stateful (not audited)', 'overlay (accepted)') })
    if ($attention.Count -eq 0) {
        Write-Host 'All managed files in sync with core.'
    }
    else {
        Write-Host "$($attention.Count) file(s) need attention. project-modified/untracked-differs = candidates to promote into core; core-updated/not-installed = re-run installer to pull down; overlay-changed = re-review the fork, then re-pin with -Accept."
    }

    # Stack drift: report-only, same as the file audit above — never writes the manifest.
    # Covers all three stackDetected categories, not just plugins.
    function Show-StackDrift {
        param([string]$Label, [string[]]$Detected, [string[]]$Recorded)
        $added = @($Detected | Where-Object { $Recorded -notcontains $_ })
        $removed = @($Recorded | Where-Object { $Detected -notcontains $_ })
        Write-Host "`n$Label detected: $($Detected.Count) (manifest last recorded: $($Recorded.Count))"
        if ($added.Count -eq 0 -and $removed.Count -eq 0) {
            Write-Host "No $Label drift since last scan."
        }
        else {
            foreach ($p in $added) { Write-Host "  + $p (newly detected)" }
            foreach ($p in $removed) { Write-Host "  - $p (no longer detected)" }
        }
    }

    # Not `$x = if (...) { @(...) } else { @() }`: an if/else used as an expression
    # collapses an empty (or single-element) array result the same way a pipeline
    # capture does. Initialize, then conditionally overwrite, as elsewhere in this file.
    $recordedStack = @{}
    if ($manifest.Contains('stackDetected')) { $recordedStack = $manifest['stackDetected'] }

    # A hand-edited manifest can set stackDetected to null or to a non-object value
    # (string, number, array) — ConvertFrom-Json -AsHashtable passes those through as-is.
    # .Contains() below assumes a hashtable, so treat anything else as "nothing recorded"
    # rather than throw. -Audit is report-only and must never abort or rewrite the manifest.
    if ($recordedStack -isnot [hashtable]) { $recordedStack = @{} }

    $recordedPlugins = @()
    if ($recordedStack.Contains('plugins')) { $recordedPlugins = @($recordedStack['plugins']) }

    $recordedOutputStyles = @()
    if ($recordedStack.Contains('outputStyles')) { $recordedOutputStyles = @($recordedStack['outputStyles']) }

    $recordedMcpServers = @()
    if ($recordedStack.Contains('mcpServers')) { $recordedMcpServers = @($recordedStack['mcpServers']) }

    Show-StackDrift -Label 'Plugins' -Detected $detectedPlugins -Recorded $recordedPlugins
    Show-StackDrift -Label 'Output styles' -Detected $detectedOutputStyles -Recorded $recordedOutputStyles
    Show-StackDrift -Label 'MCP servers' -Detected $detectedMcpServers -Recorded $recordedMcpServers
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
        $script:manifest['files'][$ManifestKey] = $sourceHash
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'installed' })
        return
    }

    $currentHash = Get-FileHashHex -Path $DestPath
    $recordedHash = $script:manifest['files'][$ManifestKey]

    # Hand-built layer predating the manifest: a file already identical to core is
    # adopted into tracking instead of warned about, so planting a baseline on an
    # existing .claude never requires -Force for files that match.
    if (-not $recordedHash -and $currentHash -eq $sourceHash) {
        $script:manifest['files'][$ManifestKey] = $sourceHash
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'adopted' })
        return
    }

    if ($recordedHash -and $currentHash -eq $recordedHash) {
        if ($currentHash -ne $sourceHash) {
            Copy-Item -LiteralPath $SourcePath -Destination $DestPath -Force
            $script:manifest['files'][$ManifestKey] = $sourceHash
            $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'updated' })
        }
        else {
            $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'unchanged' })
        }
        return
    }

    if ($Force) {
        Copy-Item -LiteralPath $SourcePath -Destination $DestPath -Force
        $script:manifest['files'][$ManifestKey] = $sourceHash
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'forced-overwrite' })
        return
    }

    # The -Accept hint currently names a path -Accept's own guard rejects: a skipped-modified
    # file is by definition tracked in `files`, and -Accept throws on anything tracked there
    # (the spec's literal wording). Flagged rather than papered over, because reinterpreting
    # the guard here would decide issue #7, which is deferred with three live options: relax
    # the guard, move the key from files to accepted, or point the hint somewhere else.
    # The hint still earns its place: it names the mechanism the operator wants and the issue
    # tracks how they reach it.
    Write-Warning "Skipping '$ManifestKey': modified since install. Use -Force to overwrite, or -Accept '$ManifestKey' to pin the fork as an accepted overlay so the audit stops flagging it."
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

# Copy-Item doesn't carry the source executable bit, and a git pre-commit hook
# git won't invoke without one on a platform that has the concept at all.
# Windows has none, so this is a no-op there — Git for Windows runs the hook
# by its shebang regardless of the (meaningless) NTFS permission bits.
if (-not $IsWindows) {
    $preCommitDst = Join-Path $hooksDst 'pre-commit'
    if (Test-Path -LiteralPath $preCommitDst) {
        & chmod +x $preCommitDst
        # Same trap as the core.hooksPath write below: a native command's non-zero exit
        # does not trip $ErrorActionPreference = 'Stop'. Failure reports, success stays
        # silent. The rule behind that, and behind why core.hooksPath reports its success
        # while this does not: a row reports success only where nothing else reports it.
        # core.hooksPath has no other row, so it prints one; the chmod is covered by the
        # hooks/pre-commit row already saying 'installed', so only a failure adds anything,
        # and it has to, because git skips a hook lacking the executable bit without saying
        # so. Silence here conflates three states (chmod succeeded, Windows skip above,
        # no hook file found), which is tolerable only because the one state an operator
        # can act on is the one that prints.
        # Real triggers are filesystems with no POSIX permission bits (CIFS/SMB, exFAT,
        # WSL DrvFs mounted without `metadata`) and a checkout owned by another uid.
        if ($LASTEXITCODE -ne 0) {
            $results.Add([pscustomobject]@{ File = 'chmod:hooks/pre-commit'; Action = "FAILED (chmod exit $LASTEXITCODE) - hook not executable" })
        }
    }
}

# Guardrails
Install-ManagedFile -SourcePath (Join-Path $templatesSrc 'guardrails.template.md') `
    -DestPath (Join-Path $claudeDir 'guardrails.md') `
    -ManifestKey 'guardrails.md'

# Scratch drop box. A dispatcher writes the diff, requirements, or earlier findings here and
# names the path in the brief, instead of pasting the body into every agent's prompt; agents
# that hold write access hand long output back the same way. Its own .gitignore keeps the
# directory tracked and everything inside it untracked, so no project .gitignore is touched.
Install-ManagedFile -SourcePath (Join-Path $templatesSrc 'scratch.gitignore') `
    -DestPath (Join-Path $scratchDst '.gitignore') `
    -ManifestKey 'scratch/.gitignore'

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
        $manifest['files']['ceremony-ledger.json'] = Get-FileHashHex -Path $ledgerDst
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

# Install-time provenance, refreshed on every install. A project that re-installs from a
# newer core should record the commit it actually got, not the one it first got, and hooks
# reading coreRepo to locate core need a path that survives the core repo being moved.
$manifest['coreRepo'] = $repoRoot
$manifest['coreCommit'] = Get-CoreCommit

$manifest['stackDetected'] = [ordered]@{
    scannedAt     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    plugins       = $detectedPlugins
    outputStyles  = $detectedOutputStyles
    mcpServers    = $detectedMcpServers
}
Write-Host "Plugins detected: $($detectedPlugins.Count); output styles: $($detectedOutputStyles.Count); MCP servers: $($detectedMcpServers.Count)"

$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath

# Git hooksPath wiring. The Claude Code PostToolUse hooks above only see this
# session's direct Write/Edit tool calls — a script-applied OLD/NEW patch
# over Bash, or a hand-edit outside Claude Code entirely, never fires them.
# core.hooksPath makes .claude/hooks/pre-commit run on every commit no matter
# how the file got edited. Guarded, because core.hooksPath REPLACES the whole
# hooks directory for the repo: a project with its own .git/hooks/pre-push
# would silently stop running it. Only wired when nothing is there to lose.
$gitDirRaw = $null
$gitCheck = & git -C $Target rev-parse --git-dir 2>$null
if ($LASTEXITCODE -eq 0) { $gitDirRaw = $gitCheck }

if (-not $gitDirRaw) {
    # Not a git repository (or git missing from PATH) — nothing to wire.
}
else {
    $gitDir = if ([System.IO.Path]::IsPathRooted($gitDirRaw)) { $gitDirRaw } else { Join-Path $Target $gitDirRaw }
    $gitDir = (Resolve-Path -LiteralPath $gitDir).Path
    $gitHooksDir = Join-Path $gitDir 'hooks'

    $currentHooksPath = $null
    $chpCheck = & git -C $Target config --get core.hooksPath 2>$null
    if ($LASTEXITCODE -eq 0) { $currentHooksPath = $chpCheck }

    # Absolute so the value is correct regardless of which subdirectory a
    # later `git commit` runs from.
    $hooksDstAbs = (Resolve-Path -LiteralPath $hooksDst).Path

    $alreadyWired = $false
    if ($currentHooksPath) {
        $currentResolved = if ([System.IO.Path]::IsPathRooted($currentHooksPath)) { $currentHooksPath } else { Join-Path $Target $currentHooksPath }
        if (Test-Path -LiteralPath $currentResolved) {
            $alreadyWired = (Resolve-Path -LiteralPath $currentResolved).Path -ieq $hooksDstAbs
        }
    }

    $existingHookFiles = @()
    if (Test-Path -LiteralPath $gitHooksDir) {
        $existingHookFiles = @(Get-ChildItem -LiteralPath $gitHooksDir -File | Where-Object { $_.Extension -ne '.sample' })
    }

    if ($alreadyWired) {
        $results.Add([pscustomobject]@{ File = 'git:core.hooksPath'; Action = 'unchanged' })
    }
    elseif ($currentHooksPath) {
        Write-Host "Skipping git hooksPath wiring: core.hooksPath is already set to '$currentHooksPath'. To use the harness pre-commit hook instead, run: git -C `"$Target`" config core.hooksPath `"$hooksDstAbs`""
        $results.Add([pscustomobject]@{ File = 'git:core.hooksPath'; Action = 'skipped-already-set' })
    }
    elseif ($existingHookFiles.Count -gt 0) {
        $names = ($existingHookFiles | Select-Object -ExpandProperty Name) -join ', '
        Write-Host "Skipping git hooksPath wiring: $gitHooksDir already has hook(s) ($names) that core.hooksPath would replace. To wire the harness pre-commit hook anyway, run: git -C `"$Target`" config core.hooksPath `"$hooksDstAbs`""
        $results.Add([pscustomobject]@{ File = 'git:core.hooksPath'; Action = 'skipped-existing-hooks' })
    }
    else {
        & git -C $Target config core.hooksPath $hooksDstAbs
        # A native command's non-zero exit does not trip $ErrorActionPreference = 'Stop',
        # so this write needs the same explicit check as the rev-parse and config --get
        # probes above. Without it the row below claims a wiring that never happened, and
        # that table is the only signal the operator gets.
        if ($LASTEXITCODE -eq 0) {
            $results.Add([pscustomobject]@{ File = 'git:core.hooksPath'; Action = "set to $hooksDstAbs" })
        }
        else {
            $results.Add([pscustomobject]@{ File = 'git:core.hooksPath'; Action = "FAILED (git exit $LASTEXITCODE) - hook not wired" })
        }
    }
}

$results | Format-Table -AutoSize | Out-String | Write-Host
