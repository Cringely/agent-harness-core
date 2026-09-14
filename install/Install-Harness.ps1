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
    forks pinned with -Accept live under `accepted`, and `coreCommit` records which
    core commit this layer was installed from. A v1 manifest (a flat path-to-hash map)
    is migrated on load, preserving every hash under `files`. Migration also carries any
    `accepted` pins through unchanged, since only -Accept can write one and nothing on
    disk can recompute it. The record keys stay at top level either way: they are not
    tracked files, and one folded in under `files` becomes an audit row for a file
    that does not exist.

    `coreRepo` (an absolute filesystem path) and `stackDetected` (the per-machine plugin,
    output-style, and MCP-server inventory, plus the timestamp of the scan that found
    them) never go in the committed manifest: neither travels between clones, and a
    public target repo has no business publishing an operator's local directory layout
    or installed toolset (issue #137). Both live in a second file the installer writes
    alongside it and gitignores in the target: `.harness-manifest.local.json`. A manifest
    written before this fix still carries them embedded at top level; the next run of
    any installer command splits them out into the sidecar and drops them from the
    committed file.

    Ceremony components (wave-close-handoff.sh hook, soc-monitor.md agent,
    ceremony-ledger.json and their hook registrations) assume wave/standup ceremony
    infrastructure most projects lack, and are only installed with -IncludeCeremonies.

    A file dropped from core since a project's last install stays in that project's manifest
    forever, flagged 'orphaned' by -Audit with no repair path, unless the operator prunes it
    with -Prune. That is deliberately a standalone command rather than an automatic step on
    every install. Two earlier designs pruned by deleting a file, and adversarial review
    executed a real deletion against both: an automatic loop keyed off whatever manifest entry
    core no longer recognized, where an untrusted key like '../../victim.txt' carrying that
    file's real hash drove Remove-Item with no containment check at all; and a standalone
    -Prune whose containment check turned out to be textual (GetUnresolvedProviderPathFromPSPath
    plus GetRelativePath on unresolved strings), so a directory symlink placed inside .claude
    walked Remove-Item straight to a target the check never resolved and deleted the identity
    gate a second time. -Prune now carries no delete primitive at all: it drops the manifest
    record and tells the operator the file, if one still exists, is theirs to keep or remove by
    hand.

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
    is rejected, as is one already tracked in `files`. Writes the manifest, plus the sidecar step
    every command shares (see -Prune below), which is decided before the manifest is written: when
    it refuses, neither file changes.

.PARAMETER Unaccept
    Drop an accepted-overlay pin, removing the key from the manifest's `accepted` map. Takes
    the manifest key, or a path relative to the project's .claude directory that resolves to
    one; the file itself need not still exist, since a pin outliving its file is one of the
    reasons to drop one. Throws when the key is not pinned. Writes the manifest, plus the same
    shared sidecar step as -Accept, decided before the manifest is written, and never restores or
    deletes the pinned file.

.PARAMETER Prune
    Retire a manifest key for a file core no longer ships. A standalone action, matching -Accept
    and -Unaccept — never composed with an install. Takes a path relative to the project's
    .claude directory, or the literal manifest key itself when that key does not round-trip
    through path resolution — the same literal-key-first lookup -Unaccept already does — falling
    back to the same resolve-and-contain check -Accept and -Unaccept use for everything else.

    Refuses when core still ships the key (this is not an orphan — re-run the installer, or with
    -IncludeCeremonies, instead) and when the key is pinned in the manifest's `accepted` map (a
    pin means the project owns the file; drop the pin first with -Unaccept). ceremony-ledger.json
    is refused too: it is live state core never shipped a source for, not an orphan of one it
    dropped. These are coherence checks now, not a safety boundary — nothing below them can
    destroy the pruned file.

    Otherwise, drops the manifest record and nothing else about the pruned file itself. -Prune's
    own logic never deletes it. Two earlier designs did, and adversarial review executed a real
    file deletion against each one: an automatic loop with an untrusted manifest key driving
    Remove-Item with no containment check, then a standalone -Prune whose containment check was
    textual and never saw a directory symlink placed inside .claude. A manifest key is untrusted,
    PR-modifiable input — core/claude/hooks/session-start-drift-check.sh's own SECURITY block
    says so — and this command no longer trusts it with anything sharper than a hashtable key
    removal. If the file still exists on disk it is left exactly where it is, now untracked,
    which is what then lets -Accept pin it as an overlay without a hand-edited manifest. Delete
    it yourself if it is unwanted.

    Every -Prune call, like -Accept and -Unaccept, still persists a legacy carry-forward through
    the shared sidecar step (Get-SidecarPlan decides, Invoke-SidecarPlan acts), which is a
    separate mechanism from the pruned-file logic above and never touches the pruned file. It can
    remove `.harness-manifest.local.json` itself when that sidecar is stale, not ignored, and
    confirmed untracked — never an unconditional delete. When a sidecar is on disk and git cannot
    say whether it is tracked, the step refuses before the manifest is written, so nothing
    changes and a retry once git answers still has its record to drop.

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
      orphaned (already removed)
                         in manifest, no longer shipped by core, already gone from disk —
                         -Prune drops the stale record
      orphaned (unmodified)
                         in manifest, no longer shipped by core, on-disk copy still matches
                         the recorded hash — -Prune drops the record; the file is left on disk
      orphaned (modified)
                         in manifest, no longer shipped by core, on-disk copy has diverged —
                         -Prune drops the record; the file is left on disk, then -Accept
                         pins it as an overlay
      overlay (accepted) pinned fork, still at the hash it was pinned at
      overlay (changed)  pinned fork has moved since pinning — re-review, re-pin
      not-installed (ceremony-gated)
                         shipped by core but held back by the -IncludeCeremonies gate and
                         never installed here. Listed, deliberately not counted as drift:
                         the gate working is not a fault, and the response is to re-run with
                         -IncludeCeremonies if this project wants ceremonies at all.

.PARAMETER Quiet
    Audit only. Drops every human-facing line of the report — the no-manifest notice, the
    status table, the in-sync/attention summary, and the three stack-drift blocks — and
    prints one row per file needing attention instead, as `<status><TAB><relative path>`.
    Prints nothing at all when nothing needs attention. For hook consumption:
    core/claude/hooks/session-start-drift-check.sh counts those rows by status.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    [switch]$Force,

    [switch]$IncludeCeremonies,

    [string]$Accept,

    [string]$Unaccept,

    [string]$Prune,

    [switch]$Audit,

    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# -Quiet reaches nothing outside the -Audit block, so on an install run it is a switch that
# silently does nothing. Rejected the simpler alternative of ignoring it: an operator who typed
# it on an install would read the ordinary flood of install output as a broken flag rather than
# as a misused one, and go looking in the wrong place.
if ($Quiet -and -not $Audit) {
    throw "-Quiet applies to -Audit only. Re-run with -Audit -Quiet for the machine-readable drift report, or drop -Quiet."
}

# All three take [string], so `-Accept ""` binds an empty string rather than leaving the
# parameter unset. `if ($Accept)` (and the -Unaccept/-Prune checks below it) then read that
# empty string as falsy and fall straight through to a full install -- silently doing the one
# thing none of these three commands are supposed to compose with. PSBoundParameters is what
# tells "typed empty" apart from "not typed at all"; the plain variable cannot.
foreach ($flagName in @('Accept', 'Unaccept', 'Prune')) {
    if ($PSBoundParameters.ContainsKey($flagName) -and -not $PSBoundParameters[$flagName]) {
        throw "-$flagName requires a non-empty path or manifest key; an empty string would otherwise fall through to an install instead of running -$flagName's own guard."
    }
}

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

# Components that require -IncludeCeremonies (wave/standup ceremony infrastructure
# most projects lack).
$ceremonyAgentNames = @('soc-monitor.md')
$ceremonyHookNames = @('wave-close-handoff.sh')
$ceremonyCommandPattern = 'wave-close-handoff\.sh'

# The same gate expressed as manifest keys, for the audit. Derived from the two lists above
# rather than written out a third time: a separate literal list is one rename away from
# disagreeing with the copy the install path uses, and the disagreement would be silent.
$ceremonyKeys = @($ceremonyAgentNames | ForEach-Object { "agents/$_" }) +
    @($ceremonyHookNames | ForEach-Object { "hooks/$_" })

function Get-FileHashHex {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# One resolver for -Accept and -Unaccept rather than the obvious copy of the block into the second
# flag: containment is the security-relevant half of both, and two copies rot apart the first time
# one of them is fixed. Returns the canonical full path beside the key because -Accept needs the
# path to hash the file and to say where a rejected argument actually landed.
#
# Both flags document their argument as relative to .claude, and everything downstream depends on
# that holding: the manifest key is matched against audit rows built from that directory, and a pin
# only means anything for a file inside the layer this installer manages. Without the containment
# check an operator typo pins a file no install will ever touch, and the audit then carries a row
# for a path outside the project's .claude forever.
function Resolve-LayerPath {
    param(
        [string]$RelativePath,
        [string]$LayerDir,
        [string]$Flag
    )

    # Join-Path with a rooted second argument produces a nonsense path rather than replacing the
    # base, which is why the rooted case is rejected here instead of being left to the check below.
    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "$Flag '$RelativePath': absolute paths are not accepted. Pass a path relative to the project's .claude directory."
    }

    # PowerShell's location and [Environment]::CurrentDirectory are separate values, so
    # [System.IO.Path]::GetFullPath would canonicalize a relative -Target against the wrong base;
    # GetUnresolvedProviderPathFromPSPath uses PowerShell's own location, and unlike Resolve-Path
    # it does not require the path to exist. Missing files are each caller's business, and the
    # callers say something more useful than a resolver error would.
    $layerFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LayerDir)
    $fullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Join-Path $LayerDir $RelativePath))

    # GetRelativePath rather than a string prefix compare, because it applies the platform's own
    # path comparison rules: it will not miss a case-variant escape on Windows, and it will not
    # reject a legitimately case-distinct sibling on Linux. It also returns a rooted path when
    # the two sit on different volumes, which the same test catches.
    $relative = [System.IO.Path]::GetRelativePath($layerFull, $fullPath)
    $escapes = [System.IO.Path]::IsPathRooted($relative) -or
        $relative -eq '..' -or
        $relative.StartsWith('..' + [System.IO.Path]::DirectorySeparatorChar)
    if ($escapes) {
        throw "$Flag '$RelativePath': resolves to '$fullPath', outside the project's .claude directory. Pass a path relative to that directory."
    }

    # Manifest keys are written with forward slashes. A path tab-completed on Windows arrives with
    # backslashes and would otherwise name a key that never matches an audit row. Taking the key
    # from the canonical relative path also collapses an interior '..' segment, so
    # 'agents/../guardrails.md' names the key the audit already uses for that same file rather
    # than a second key naming it a different way.
    return [pscustomobject]@{
        Key      = ($relative -replace '\\', '/')
        FullPath = $fullPath
    }
}

# Map of every file core ships (ceremony files included — if a project installed them, they
# should be audited/pruned regardless of which switches this run got). Shared by -Audit and
# -Prune: both need the identical answer to "does core still ship this key", and two copies of
# that scan are two chances for one to drift from the other and call a still-shipped ceremony
# file orphaned.
function Get-CoreFilesMap {
    # Get-ChildItem on a MISSING directory throws under this script's Stop preference, which is
    # already fail-closed. A directory that EXISTS but lists zero files does not throw, and this
    # map answering "core ships no agents" or "core ships no hooks" from that state is the same
    # defect security.md's scope-filter rule names: a filter that resolves empty must refuse,
    # never widen (here, to "everything installed is an orphan"). Measured: an empty
    # core/claude/agents made a normally-installed project audit as 18 'orphaned (unmodified)'
    # rows, and -Prune following -Audit's own printed command through those rows deleted the
    # identity gate and every other agent/hook with it, no manifest tampering required. Refuse
    # instead of answering "core ships nothing".
    $agentFiles = @(Get-ChildItem -LiteralPath $agentsSrc -Filter '*.md' -File)
    if ($agentFiles.Count -eq 0) {
        throw "Get-CoreFilesMap: $agentsSrc exists but contains no agent files. Refusing rather than reporting every installed agent as orphaned."
    }
    $hookFiles = @(Get-ChildItem -LiteralPath $hooksSrc -File | Where-Object { $_.Name -ne '.gitkeep' })
    if ($hookFiles.Count -eq 0) {
        throw "Get-CoreFilesMap: $hooksSrc exists but contains no hook files. Refusing rather than reporting every installed hook as orphaned."
    }

    $map = [ordered]@{}
    foreach ($f in $agentFiles) { $map["agents/$($f.Name)"] = $f.FullName }
    foreach ($f in $hookFiles) { $map["hooks/$($f.Name)"] = $f.FullName }
    $map['guardrails.md'] = Join-Path $templatesSrc 'guardrails.template.md'
    $map['scratch/.gitignore'] = Join-Path $templatesSrc 'scratch.gitignore'
    $map['.gitignore'] = Join-Path $templatesSrc 'manifest-local.gitignore'
    return $map
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
# v2 moves that map under `files` and adds two siblings: `accepted`, which pins deliberate
# project forks at their own hash, and `coreCommit`. Every load migrates, so the rest of the
# script only ever sees v2; the migrated shape reaches disk only where the script already
# writes the manifest, which is why -Audit still writes nothing.
#
# coreRepo and stackDetected never appear in the value this function returns, regardless of
# input shape. Both are machine-specific (an absolute path; a per-machine plugin/MCP inventory)
# and belong in the gitignored sidecar the caller loads separately, never in the file a target
# repo commits (issue #137). A manifest reaching here still carrying either -- v1's shape, or a
# v2 manifest written before this fix -- has them stripped below rather than folded into
# `files`, and the caller is responsible for carrying a legacy value forward into the sidecar
# before calling this function, since this function's return value cannot carry it any more.
#
# Hand-edited manifests in the wild are the reason this is a function with a shape check
# rather than three inline assignments. Four cases it has to survive without losing data:
# a v1 map with no stackDetected, a v1 map carrying a stray `files` key from something else,
# a v2 map whose `accepted` was hand-edited to a non-map, and a map carrying pins under
# `accepted` whose `files` is missing or the wrong shape, which the check below reads as v1.
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
        # The four skipped keys are manifest records rather than tracked files (coreRepo and
        # stackDetected are dropped outright below; folding either into `files` buys it a row
        # in the audit table for a file that does not exist, the same false alarm the pin
        # mechanism exists to remove). Only coreCommit needs carrying here: it is rewritten
        # from the current checkout at the bottom of this block, so its stale value is meant
        # to be dropped.
        $files = @{}
        foreach ($key in @($m.Keys)) {
            if ($key -in @('stackDetected', 'accepted', 'coreRepo', 'coreCommit')) { continue }
            $files[$key] = $m[$key]
        }

        # accepted rides through for a stronger reason than the dropped keys: a pin is an
        # operator decision that nothing on disk can recompute, so a manifest reaching here
        # with pins but no usable `files` must not have them rebuilt away. Carried
        # unconditionally, because the degrade below already replaces a non-map with an empty
        # one, exactly as it does for a manifest that was already v2.
        $accepted = $m['accepted']

        $m = @{ files = $files }
        $m['accepted'] = $accepted
        $m['coreCommit'] = Get-CoreCommit
    }

    # coreRepo and stackDetected belong in the sidecar, never here, whether this manifest just
    # migrated from v1 (which never set them above) or was already v2-shaped and carried them
    # in from disk as top-level siblings of `files` (the pre-fix committed shape).
    $null = $m.Remove('coreRepo')
    $null = $m.Remove('stackDetected')

    # Degrade a missing or wrong-typed map to an empty one rather than throwing, matching how
    # the audit already treats a hand-edited stackDetected. A non-map `accepted` holds no pin
    # data worth preserving, and every caller below assumes it answers .Contains().
    if ($m['files'] -isnot [System.Collections.IDictionary]) { $m['files'] = @{} }
    if ($m['accepted'] -isnot [System.Collections.IDictionary]) { $m['accepted'] = @{} }

    return $m
}

$manifestPath = Join-Path $claudeDir '.harness-manifest.json'
$sidecarPath = Join-Path $claudeDir '.harness-manifest.local.json'
$manifest = @{}
if (Test-Path -LiteralPath $manifestPath) {
    $raw = Get-Content -LiteralPath $manifestPath -Raw
    if ($raw.Trim()) {
        $loaded = $raw | ConvertFrom-Json -AsHashtable
        foreach ($key in $loaded.Keys) { $manifest[$key] = $loaded[$key] }
    }
}

# Captured before migration, which strips both from the returned manifest unconditionally: a
# manifest written before this fix carries them embedded at top level, and this is the one
# chance to carry that value forward into the sidecar instead of losing it outright.
$legacyCoreRepo = $manifest['coreRepo']
$legacyStackDetected = $manifest['stackDetected']

$manifest = ConvertTo-ManifestV2 -Loaded $manifest

# Sidecar: coreRepo (absolute path to the core checkout) and stackDetected (the per-machine
# plugin/output-style/MCP-server inventory). Neither travels between clones, so neither goes in
# the manifest a target repo commits -- this file is gitignored by the .gitignore installed
# alongside it. Loaded the same permissive way as the manifest: a missing or empty file degrades
# to nothing recorded rather than throwing.
$sidecar = @{}
if (Test-Path -LiteralPath $sidecarPath) {
    $rawSidecar = Get-Content -LiteralPath $sidecarPath -Raw
    if ($rawSidecar.Trim()) {
        $loadedSidecar = $rawSidecar | ConvertFrom-Json -AsHashtable
        foreach ($key in $loadedSidecar.Keys) { $sidecar[$key] = $loadedSidecar[$key] }
    }
}
# One-time carry-forward for a manifest written before this fix: adopt the legacy embedded
# values only where the sidecar does not already have its own, so a real scan on this run (the
# refresh at the bottom of the script, reached only by a plain install) is never overwritten by
# a stale value read out of the old manifest.
if (-not $sidecar.Contains('coreRepo') -and $legacyCoreRepo) { $sidecar['coreRepo'] = $legacyCoreRepo }
if (-not $sidecar.Contains('stackDetected') -and $legacyStackDetected) { $sidecar['stackDetected'] = $legacyStackDetected }

# Shared gate for every place below that writes the sidecar (the plain-install refresh, and the
# legacy carry-forward persisted by -Accept/-Unaccept/-Prune): an absolute host path and a
# per-machine inventory must never land in a working tree git cannot be shown to ignore.
# Install-ManagedFile can leave a pre-existing, differing .claude/.gitignore untouched
# ('skipped-untracked' / 'skipped-modified') rather than overwriting an operator's fork, so
# having attempted to install the ignore file earlier in this run is not proof the sidecar is
# actually covered. `git check-ignore` is the mechanism `git add` itself consults, so it is the
# source of truth here instead of re-parsing a file this script may have just declined to touch
# -- it also credits an ignore rule declared elsewhere (a root .gitignore, .git/info/exclude)
# without this needing to know either exists (issue #137's live-probe follow-up, round 2).
#
# Split in two since round 4: Get-SidecarPlan decides and Invoke-SidecarPlan acts. Round 3 had
# one function that decided and wrote together, called after -Accept/-Unaccept/-Prune had already
# written the manifest and after a plain install had already run its copy loop, so a refusal
# thrown from inside it left those writes behind while its message said nothing was written.
# Every caller now runs Get-SidecarPlan before its first write, which is the only place a refusal
# can be thrown, and Invoke-SidecarPlan after, which never throws a refusal.

# Where git says the target's repository lives: toplevel, git dir, common dir, and index, each
# made absolute and normalised. $null when git cannot run or does not answer cleanly.
function Get-GitLocation {
    param([string]$AbsTarget)
    $out = $null
    try {
        $out = @(& git -C $AbsTarget rev-parse --show-toplevel --absolute-git-dir --git-common-dir --git-path index 2>$null)
    }
    catch {
        return $null
    }
    if ($LASTEXITCODE -ne 0 -or $out.Count -ne 4) { return $null }
    $normalised = New-Object System.Collections.Generic.List[string]
    foreach ($line in $out) {
        $p = [string]$line
        if ($IsWindows) { $p = $p.Replace('/', '\') }
        # --git-common-dir and --git-path print relative to the -C directory when the repository
        # was discovered rather than named, and absolute when an environment variable named it.
        if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path $AbsTarget $p }
        $normalised.Add([System.IO.Path]::GetFullPath($p).TrimEnd([char[]]@('\', '/')))
    }
    return , $normalised.ToArray()
}

# round-4 A: whether git's answers about the sidecar come from the target's OWN repository.
# GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and GIT_COMMON_DIR override discovery, and git exports
# GIT_DIR into every hook it runs, so an installer launched from a hook in another repository
# asked `ls-files --error-unmatch` a question the foreign index answered: exit 1, read as
# "untracked", and a committed or staged sidecar was deleted. check-ignore had the same exposure.
#
# The reference is git's own discovery from the target with those four variables absent, asked in
# a second probe; the answers actually used come from the environment as the operator set it, and
# the variables are restored before this function returns. Nothing is cleared for the real calls,
# since an operator may set them on purpose, and GIT_DIR naming the target's own .git (a hook in
# the target itself) compares equal and passes. Any difference in the four locations is "git cannot
# answer". Two simpler checks were measured and rejected (2026-09-14): comparing --show-toplevel
# alone misses the hook case, because a foreign GIT_DIR with no GIT_WORK_TREE makes the -C
# directory the toplevel, so it still names the target; and comparing against the `.git` walk
# below misreports a junction target, because git resolves the junction and the walk does not.
function Test-GitAnswersForTarget {
    param([string]$AbsTarget)

    $asRun = Get-GitLocation -AbsTarget $AbsTarget
    if ($null -eq $asRun) { return $false }

    # Removed and restored through the Env: provider, not [Environment]::SetEnvironmentVariable:
    # PowerShell binds $null to that method's [string] parameter as "", which leaves the variable
    # SET to an empty value, so the reference probe ran with an empty GIT_DIR and every later git
    # call in the run inherited all four empty variables (measured 2026-09-14).
    $names = @('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR')
    $saved = @{}
    foreach ($name in $names) {
        $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        if ($item) { $saved[$name] = $item.Value }
    }
    $own = $null
    try {
        foreach ($name in $names) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        $own = Get-GitLocation -AbsTarget $AbsTarget
    }
    finally {
        foreach ($name in $names) {
            if ($saved.Contains($name)) { Set-Item -LiteralPath "Env:$name" -Value $saved[$name] }
            else { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        }
    }
    if ($null -eq $own) { return $false }

    for ($i = 0; $i -lt $asRun.Count; $i++) {
        $same = if ($IsWindows) { $asRun[$i] -ieq $own[$i] } else { $asRun[$i] -ceq $own[$i] }
        if (-not $same) { return $false }
    }
    return $true
}

# Decision step. Reads on-disk presence, the tracked answer and the ignored answer, applies the
# round-3 rulings, and returns what Invoke-SidecarPlan should do. Throws the R2-2 refusal, and is
# the only sidecar function that can. Writes nothing.
#
# -Facts: the plain install calls this twice, once before its copy loop so a refusal lands ahead
# of every write, and once after it, because the loop may install .claude/.gitignore and change
# the ignored answer (a first install into a fresh repository is exactly that case). The second
# call passes the first call's facts and re-reads only the ignored answer. Presence, the tracked
# answer and whether git answers for the target at all are the refusal's inputs, and the copy loop
# changes none of them, so the second call cannot throw after the loop has written.
function Get-SidecarPlan {
    param($TargetDir, $Facts)

    if ($null -eq $Facts) {
        # Recomputed here from a resolved absolute target rather than trusting a caller-supplied
        # path: a relative -Target made an earlier version's own $sidecarPath relative too, and
        # handing that to `git -C $TargetDir check-ignore` doubled it onto $TargetDir a second
        # time (round-2 F3). Built from two hardcoded literal segments, never from anything the
        # manifest or sidecar content could influence -- this repo's -Prune history (see the
        # comment above the -Prune block) is two earlier designs that trusted a computed path for
        # a delete and got executed against an attacker-chosen one; the removal in
        # Invoke-SidecarPlan holds itself to the same rule.
        # -Target already passed the top-of-script guard ("Target path does not exist or is not a directory"), so this resolves.
        $absTarget = (Resolve-Path -LiteralPath $TargetDir).Path
        $sidecarAbs = Join-Path (Join-Path $absTarget '.claude') '.harness-manifest.local.json'

        # In a repository if a `.git` entry (a directory for a normal clone, a file for a linked
        # worktree or submodule) exists at or above the target -- read straight off disk rather
        # than asking git, so a git process that CAN'T answer for a reason other than "no
        # repository here" (dubious ownership, a foreign filesystem, a uid mismatch) is never
        # misread as "nothing to protect" (round-2 F1). `git rev-parse --git-dir`'s exit code used
        # to be that signal, and it conflates "not a repo" with "a repo git refuses to touch,"
        # which is exactly backwards: the second case is the one this function exists to fail
        # closed on.
        $inRepo = $false
        $probe = $absTarget
        while ($probe) {
            if (Test-Path -LiteralPath (Join-Path $probe '.git')) { $inRepo = $true; break }
            $parent = Split-Path -Parent $probe
            if (-not $parent -or $parent -eq $probe) { break }
            $probe = $parent
        }
        # round-5: a location variable can define a repository no `.git` walk sees (GIT_DIR and
        # GIT_WORK_TREE naming one elsewhere stage the sidecar with no .git near the target). Any
        # of the four set counts as in a repository, so Test-GitAnswersForTarget decides whether
        # git's answers count, and the cannot-answer rulings apply when they do not.
        foreach ($name in @('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR')) {
            if (Test-Path -LiteralPath "Env:$name") { $inRepo = $true }
        }

        # round-3 R2-1: ask git whether the path is TRACKED -- staged or committed -- not merely
        # whether it is currently ignored. A sidecar force-added before this gate existed, or
        # staged by hand, still has an index entry after the working-tree copy is removed, and
        # that entry reaches the next plain `git commit` untouched. `git ls-files --error-unmatch`
        # is the same primitive `git status` itself uses to answer tracked-vs-untracked.
        #
        # Measured live against a real repo (2026-09-14): a staged-only file and a committed file
        # both exit 0; an untracked file, and a path that never existed, both exit 1 with "did not
        # match any file(s) known to git" on stderr; GIT_TEST_ASSUME_DIFFERENT_OWNER=1 (round-2
        # F1's dubious-ownership reproduction) exits 128 with "fatal: detected dubious ownership."
        # 0 and 1 are the only answers, and only from a git answering for the target's own
        # repository (round-4 A, Test-GitAnswersForTarget); everything else -- 128, any other
        # fatal exit, a missing git binary, or a location variable naming another repository --
        # leaves $tracked $null, "cannot tell."
        $tracked = $false
        if ($inRepo) {
            $tracked = $null
            if (Test-GitAnswersForTarget -AbsTarget $absTarget) {
                try {
                    & git -C $absTarget ls-files --error-unmatch -- $sidecarAbs 1>$null 2>$null
                    if ($LASTEXITCODE -eq 0) { $tracked = $true }
                    elseif ($LASTEXITCODE -eq 1) { $tracked = $false }
                }
                catch {
                    # git vanished between the two probes: same "cannot tell."
                }
            }
        }

        $Facts = [pscustomobject]@{
            SidecarAbs = $sidecarAbs
            AbsTarget  = $absTarget
            InRepo     = $inRepo
            OnDisk     = (Test-Path -LiteralPath $sidecarAbs)
            Tracked    = $tracked
        }

        if ($Facts.OnDisk -and $null -eq $Facts.Tracked) {
            # round-3 R2-2 (owner ruling, 2026-09-14): git cannot say whether the sidecar on disk
            # is tracked. Guessing either way is wrong -- deleting risks exactly the leak R2-1
            # exists to close if the untold answer was actually "tracked"; silently leaving it
            # risks an unprotected copy nobody was told about. Refuse the whole command instead.
            # Every caller reaches this before its first write (round 4), so the message can say
            # nothing was written and be true. Scoped to a sidecar that exists (owner ruling,
            # 2026-09-14): with nothing on disk there is nothing to delete or keep, and the plan
            # below warns and continues.
            throw "Refusing to touch the machine-specific sidecar ('.claude/.harness-manifest.local.json') at ${sidecarAbs}: git could not confirm whether it is already tracked (dubious ownership, git missing from PATH, GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_COMMON_DIR naming a repository other than this target's own, or another unexpected result). Deleting it on an unknown answer risks leaving a tracked copy's index entry to reach a commit, so this command stopped before writing anything: no managed file, settings.json, manifest or sidecar was changed, and the sidecar is exactly as it was. Resolve the git error (for dubious ownership: git config --global --add safe.directory <path>; for an exported location variable: unset it, or point it at this target's repository) and re-run the command."
        }
    }

    # The ignored answer is trusted only from a git that has already answered the tracked question
    # cleanly for this target. Tracked files are never reported ignored, so a tracked sidecar
    # falls through to the tracked branches below.
    #
    # round-5: with no repository there is no repository git can answer for, and "nothing to
    # protect" was the wrong reading, since a later `git init` stages whatever is on disk.
    #
    # round-6: an exact-line read of .claude/.gitignore said ignored where git does not (a later
    # negation, a UTF-16/32 BOM, CR CR LF, a symlinked file, an oversized file), so git answers
    # instead: a throwaway bare repository whose work tree is the target's own .claude, reading
    # .claude/.gitignore in place. The deepest ignore file's last match wins, so a parent
    # .gitignore or a global excludes file could only add an ignore that .claude/.gitignore does
    # not provide; both are excluded, which errs toward not ignored. --template= keeps a user
    # init.templateDir's info/exclude out, and -c core.excludesFile= keeps the global one out;
    # without either, the probe can say ignored where the future repository would not. Any
    # failure, git missing from PATH included, reads as not ignored. Asked here, not in the facts:
    # the plain install's second call follows a copy loop that may have just installed that file.
    $ignored = $false
    if (-not $Facts.InRepo) {
        $claudeAbs = Join-Path $Facts.AbsTarget '.claude'
        if (Test-Path -LiteralPath $claudeAbs -PathType Container) {
            # The only path the finally block may remove: a fresh GUID-named child of the temp
            # directory, removed only once New-Item has created it in this call.
            $probeGitDir = Join-Path ([IO.Path]::GetTempPath()) ('harness-sidecar-probe-' + [guid]::NewGuid().ToString('N'))
            $probeCreated = $false
            try {
                $null = New-Item -ItemType Directory -Path $probeGitDir -ErrorAction Stop
                $probeCreated = $true
                & git init -q --bare --template= -- $probeGitDir 1>$null 2>$null
                if ($LASTEXITCODE -eq 0) {
                    & git -C $claudeAbs "--git-dir=$probeGitDir" "--work-tree=$claudeAbs" -c core.excludesFile= check-ignore -q -- .harness-manifest.local.json 1>$null 2>$null
                    $ignored = ($LASTEXITCODE -eq 0)
                }
            }
            catch {
                $ignored = $false
            }
            finally {
                if ($probeCreated) {
                    Remove-Item -LiteralPath $probeGitDir -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    if ($Facts.InRepo -and $null -ne $Facts.Tracked) {
        try {
            & git -C $Facts.AbsTarget check-ignore -q -- $Facts.SidecarAbs 2>$null
            $ignored = ($LASTEXITCODE -eq 0)
        }
        catch {
            # git missing from PATH, or otherwise unable to run at all (the native-command
            # invocation throws rather than setting $LASTEXITCODE): cannot verify, so this write
            # fails closed exactly like a git that runs and answers "not ignored" (round-2 F4).
            $ignored = $false
        }
    }

    $skipWarning = "Skipping the machine-specific sidecar ('.claude/.harness-manifest.local.json'): git does not confirm it is ignored, so writing it here risks a future 'git add' committing an absolute host path. Fix '.claude/.gitignore' so it covers '.harness-manifest.local.json' (-Accept '.gitignore' pins the CURRENT fork as-is -- it does not add the missing line for you -- and -Force overwrites EVERY differing managed file with core's version, not only this one, discarding any of your own lines in them), or add an equivalent ignore rule elsewhere (a root .gitignore, .git/info/exclude), then re-run the installer. If this file is already tracked in git (for example, force-added before this check existed), untrack it first: git rm --cached .claude/.harness-manifest.local.json"

    if ($ignored) {
        return [pscustomobject]@{ Facts = $Facts; Action = 'write'; Warning = $null }
    }

    if ($null -eq $Facts.Tracked) {
        # Reached only with no sidecar on disk; the on-disk case threw above.
        return [pscustomobject]@{
            Facts   = $Facts
            Action  = 'skip'
            Warning = "Skipping the machine-specific sidecar ('.claude/.harness-manifest.local.json'): git could not answer for this target's own repository (dubious ownership, git missing from PATH, or GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_COMMON_DIR naming another repository), so whether it is ignored is not confirmed and its tracked state is unknown. No sidecar is on disk, so there was nothing to keep or delete, and the rest of this command continues without writing one. Resolve the git error and re-run the installer to record it. If an earlier commit already tracks this file, untrack it once git answers: git rm --cached .claude/.harness-manifest.local.json"
        }
    }

    if ($Facts.Tracked) {
        if ($Facts.OnDisk) {
            return [pscustomobject]@{
                Facts   = $Facts
                Action  = 'skip'
                Warning = "Not removing the machine-specific sidecar ('.claude/.harness-manifest.local.json') at $($Facts.SidecarAbs): git does not confirm it is ignored, and the file is already tracked (staged or committed), so deleting only the working-tree copy would leave the index entry -- and whatever it holds -- to reach the next commit untouched. It was left exactly as it was, not removed. Untrack it first: git rm --cached .claude/.harness-manifest.local.json -- then fix '.claude/.gitignore' so it covers '.harness-manifest.local.json' and re-run the installer."
            }
        }
        # round-4 scope ruling (owner, 2026-09-14): git answers, and its index holds a sidecar
        # absent from disk. Nothing to delete; writing a fresh one would put this machine's values
        # into a tracked file. Warn with the command that clears the entry, and continue.
        return [pscustomobject]@{
            Facts   = $Facts
            Action  = 'skip'
            Warning = "Skipping the machine-specific sidecar ('.claude/.harness-manifest.local.json'): no copy is on disk, but git's index still tracks it (staged or committed), so the next commit carries whatever that entry holds, and writing a fresh copy here would put this machine's values into a tracked file. Untrack it: git rm --cached .claude/.harness-manifest.local.json -- then make sure '.claude/.gitignore' covers '.harness-manifest.local.json' and re-run the installer."
        }
    }

    if ($Facts.OnDisk) {
        # round-2 F2: a sidecar that WAS covered and no longer is (the ignore line got dropped, or
        # a fork never had it) must not sit on disk still holding an absolute host path just
        # because this run declined to refresh it. Confirmed untracked by a git answering for this
        # target, so removing it is safe.
        return [pscustomobject]@{
            Facts   = $Facts
            Action  = 'remove'
            Warning = $skipWarning.Replace(" Fix '.claude/.gitignore'", " An existing sidecar was removed: it was not confirmed ignored and still held an absolute host path. Fix '.claude/.gitignore'")
        }
    }

    return [pscustomobject]@{ Facts = $Facts; Action = 'skip'; Warning = $skipWarning }
}

# Write step. Carries out a plan from Get-SidecarPlan: writes the sidecar, or removes a stale
# untracked copy, or neither, and prints the plan's warning. Returns $true only when it wrote. The
# path it writes or removes is the fixed literal Get-SidecarPlan built, never anything computed
# from $Sidecar's content.
function Invoke-SidecarPlan {
    param($Plan, $Sidecar)

    if ($Plan.Action -eq 'write') {
        # round-6: with neither field there is nothing to persist. A `{}` file passes the drift
        # hook's missing-sidecar check and silences its "sidecar unavailable" advisory, so an
        # -Accept, -Unaccept or -Prune with no sidecar and no legacy fields leaves the file absent.
        if (-not ($Sidecar.Contains('coreRepo') -or $Sidecar.Contains('stackDetected'))) { return $false }
        $Sidecar | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Plan.Facts.SidecarAbs
        return $true
    }
    if ($Plan.Action -eq 'remove') {
        Remove-Item -LiteralPath $Plan.Facts.SidecarAbs -Force
    }
    if ($Plan.Warning) { Write-Warning $Plan.Warning }
    return $false
}

# The target's other piece of pre-existing state, read here beside the manifest because every mode
# has to know what is already on disk before it decides anything. Invariant: the target's
# settings.json parses before the first file is copied into the layer. A parse failure is recorded
# rather than thrown here, because -Audit is report-only and -Accept/-Unaccept touch the manifest
# alone; the install path turns the recorded failure into a throw above the agents loop, ahead of
# every copy. Reading once also removes the second parse the merge below used to do, which is where
# the raw ConvertFrom-Json exception used to escape.
# `-and $rawSettings` before .Trim(): Get-Content -Raw yields $null for a zero-byte file, and a
# method call on $null inside this try would report an empty file as a parse error, which it is not.
$settingsPath = Join-Path $claudeDir 'settings.json'
$settings = [pscustomobject]@{}
$settingsParseError = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try {
        $rawSettings = Get-Content -LiteralPath $settingsPath -Raw
        if ($rawSettings -and $rawSettings.Trim()) { $settings = $rawSettings | ConvertFrom-Json }
    }
    catch {
        $settingsParseError = $_.Exception.Message
    }
}

# -Accept: a standalone action, deliberately not composed with an install. Pinning a fork and
# copying core files over the project are opposite intentions, and running an install to get a
# pin would mean the pin arrives alongside overwrites the operator did not ask for.
if ($Accept) {
    $resolvedAccept = Resolve-LayerPath -RelativePath $Accept -LayerDir $claudeDir -Flag '-Accept'
    $acceptKey = $resolvedAccept.Key
    $acceptPath = $resolvedAccept.FullPath

    if (-not (Test-Path -LiteralPath $acceptPath -PathType Leaf)) {
        throw "-Accept '$Accept': file does not exist at $acceptPath. Pass a path relative to the project's .claude directory."
    }

    if ($manifest['files'].Contains($acceptKey)) {
        throw "-Accept '$acceptKey': already tracked in the manifest's files map, so it is an installed file rather than an overlay. Accepting it would drop the record of which core version it came from. Promote the change into core, or drop it from files first."
    }

    # -Accept touches the manifest, not the sidecar's own values -- but a legacy carry-forward
    # above may have populated $sidecar in memory only, and this is the write that gives a
    # target upgrading via -Accept (rather than a plain re-install) a persisted sidecar too.
    # Decided before the manifest write, so an R2-2 refusal leaves the manifest untouched and a
    # retry once git answers still has its pin to make (round-4 B). See Get-SidecarPlan.
    $sidecarPlan = Get-SidecarPlan -TargetDir $Target
    $manifest['accepted'][$acceptKey] = Get-FileHashHex -Path $acceptPath
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath
    $null = Invoke-SidecarPlan -Plan $sidecarPlan -Sidecar $sidecar
    Write-Host "Accepted overlay '$acceptKey' pinned at $($manifest['accepted'][$acceptKey])."
    return
}

# -Unaccept: the inverse of -Accept, standalone for the same reason. A pin outlives its reason
# routinely (the fork gets promoted into core, the file gets deleted, the overlay turns out to be
# a mistake), and without an inverse the only way to drop one is to hand-edit the manifest, which
# is the file the manifest mechanism exists to keep hands off.
if ($Unaccept) {
    # Literal key first, canonicalized second. -Accept writes whatever key canonicalization
    # produced at pin time, and a pin can outlive the path resolving that way at all: a manifest
    # hand-edited, carried in from another machine, or written by an older installer. Resolving
    # first would then miss a key sitting in plain sight in the map, leaving it undroppable by
    # any supported command. There is deliberately no Test-Path leaf guard either, unlike -Accept:
    # un-pinning a file that is already gone is the main thing this flag is for.
    $unacceptKey = $null
    if ($manifest['accepted'].Contains($Unaccept)) {
        $unacceptKey = $Unaccept
    }
    else {
        $unacceptKey = (Resolve-LayerPath -RelativePath $Unaccept -LayerDir $claudeDir -Flag '-Unaccept').Key
    }

    if (-not $manifest['accepted'].Contains($unacceptKey)) {
        throw "-Unaccept '$unacceptKey': not pinned as an accepted overlay, so there is nothing to drop. Run -Audit to see which files are pinned."
    }

    # See the matching comment in the -Accept block: persists a legacy carry-forward the
    # in-memory $sidecar may hold even though -Unaccept itself never changes it, and is decided
    # before the manifest write for the same reason.
    $sidecarPlan = Get-SidecarPlan -TargetDir $Target
    $manifest['accepted'].Remove($unacceptKey)
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath
    $null = Invoke-SidecarPlan -Plan $sidecarPlan -Sidecar $sidecar
    Write-Host "Dropped the accepted-overlay pin on '$unacceptKey'. The file itself was left alone; the audit now judges it against core again."
    return
}

# -Prune: standalone for the same reason as -Accept and -Unaccept, and deliberately one key per
# invocation rather than a loop over every orphan. Two earlier designs pruned by deleting, and
# adversarial review executed a real file deletion against each one: an automatic loop keyed off
# whatever manifest entry core no longer recognized, where an untrusted key like
# '../../victim.txt' carrying that file's real hash drove Remove-Item with no containment check
# at all; and a standalone -Prune resolving its argument through Resolve-LayerPath's containment
# check before deleting, where the check turned out to be textual
# (GetUnresolvedProviderPathFromPSPath plus GetRelativePath on unresolved strings, so it never
# resolves a reparse point) and a directory symlink placed inside .claude walked Remove-Item
# straight past it to a target the check never saw. The pruned-file logic below now contains no
# delete primitive of its own: it only ever removes a key from $manifest['files'], which cannot
# destroy anything no matter what the key resolves to. That closes the whole class rather than
# the instances -- a traversal or symlink key can still slip the checks below, but the worst it
# now does is drop a manifest record that was already sitting in the manifest, which harms
# nothing. (The Get-SidecarPlan and Invoke-SidecarPlan calls further down are a separate
# mechanism, gated on their own tracked-check, and never act on $pruneKey or $prunePath.)
if ($Prune) {
    # Literal key first, canonicalized second -- exactly -Unaccept's lookup at the branch above.
    # A manifest key can outlive the path resolving that way at all (hand-edited, carried in from
    # another machine, an older installer's canonicalization), and resolving first would leave
    # such a key undroppable by any command: the 'orphaned' row with no repair path this whole
    # command exists to close. The literal branch skips Resolve-LayerPath's containment check
    # entirely, same as -Unaccept's does -- coherent now that neither branch can reach a
    # Remove-Item, so there is nothing left for that check to protect here.
    $pruneKey = $null
    $prunePath = $null
    if ($manifest['files'].Contains($Prune)) {
        $pruneKey = $Prune
        $prunePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Join-Path $claudeDir $pruneKey))
    }
    else {
        $resolvedPrune = Resolve-LayerPath -RelativePath $Prune -LayerDir $claudeDir -Flag '-Prune'
        $pruneKey = $resolvedPrune.Key
        $prunePath = $resolvedPrune.FullPath
    }

    # Live ceremony state, not a file core ships or ever shipped a source for — -Audit already
    # carves this key out of every hash-based classification for the same reason ('stateful (not
    # audited)'). Refusing here is coherence, not safety: -Prune cannot delete the ledger any
    # more than it can delete anything else. It still refuses, because dropping the tracking
    # record for live state that -Audit already treats as untracked is not what this command is
    # for, and the message points at the right one instead of a silent no-op.
    if ($pruneKey -eq 'ceremony-ledger.json') {
        throw "-Prune 'ceremony-ledger.json': this is live ceremony state, not a file core ships or ever shipped, so pruning it is not what this command is for. Delete it by hand if it is genuinely unwanted."
    }

    $coreFiles = Get-CoreFilesMap
    if ($coreFiles.Contains($pruneKey)) {
        throw "-Prune '$pruneKey': core still ships this file, so it is not an orphan. Re-run the installer to bring it back in sync, or with -IncludeCeremonies if it is gated on that switch."
    }

    if ($manifest['accepted'].Contains($pruneKey)) {
        throw "-Prune '$pruneKey': pinned as an accepted overlay. A pin means the project owns this file, so -Prune must not silently override it. Run -Unaccept '$pruneKey' first if the pin should go too."
    }

    if (-not $manifest['files'].Contains($pruneKey)) {
        throw "-Prune '$pruneKey': not tracked in the manifest's files map, so there is nothing to prune. Run -Audit to see which keys are orphaned."
    }

    # See the matching comment in the -Accept block: persists a legacy carry-forward the
    # in-memory $sidecar may hold even though -Prune itself never changes it, and is decided
    # before the manifest write for the same reason.
    $sidecarPlan = Get-SidecarPlan -TargetDir $Target
    $manifest['files'].Remove($pruneKey)
    $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath
    $null = Invoke-SidecarPlan -Plan $sidecarPlan -Sidecar $sidecar

    if (-not (Test-Path -LiteralPath $prunePath -PathType Leaf)) {
        Write-Host "Pruned manifest record '$pruneKey': already gone from disk."
    }
    else {
        Write-Host "Dropped the manifest record for '$pruneKey'. The file is still on disk at $prunePath, now untracked by the harness -- delete it yourself if it is unwanted, or run -Accept '$pruneKey' to pin it as an overlay."
    }
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
    $coreFiles = Get-CoreFilesMap

    if (-not $Quiet -and -not (Test-Path -LiteralPath $manifestPath)) {
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
            # Every key reaching here came from manifest['files'].Keys (an accepted key already
            # returned above, and a coreFiles key always carries a non-null srcPath), so
            # $manifest['files'][$key] is always a real recorded hash. Still split three ways for
            # the operator's own information -- -Prune's action is identical across all three
            # now, but whether the on-disk copy matches what was last installed is worth knowing
            # before deciding whether to delete it by hand afterward.
            if (-not $dstExists) {
                $results.Add([pscustomobject]@{ File = $key; Status = 'orphaned (already removed)' })
                continue
            }
            $dstHash = Get-FileHashHex -Path $dstPath
            $recHash = $manifest['files'][$key]
            $status = if ($dstHash -eq $recHash) { 'orphaned (unmodified)' } else { 'orphaned (modified)' }
            $results.Add([pscustomobject]@{ File = $key; Status = $status })
            continue
        }

        $srcHash = Get-FileHashHex -Path $srcPath
        if (-not $dstExists) {
            # A ceremony-gated file core ships and this project never installed is the gate
            # doing its job, not drift. Classified apart from plain 'not-installed' because
            # the two take opposite responses: a re-run pulls a genuinely new core file down,
            # and a re-run deliberately skips this one, so a shared status sends the operator
            # at a command that will not change anything. Left in the table rather than
            # dropped from it: absent-and-available is worth seeing, and the response is to
            # re-run with -IncludeCeremonies if the project wants ceremonies.
            # 'missing' still wins the tracked case: a ceremony file recorded in `files` was
            # installed and then lost, which a re-run with that switch really does repair.
            $status = if ($inManifest) { 'missing' }
            elseif ($ceremonyKeys -contains $key) { 'not-installed (ceremony-gated)' }
            else { 'not-installed' }
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

    if (-not $Quiet) { $results | Format-Table -AutoSize | Out-String | Write-Host }

    # 'overlay (accepted)' is silent by design: the pin exists precisely so a deliberate fork
    # stops counting as drift. 'overlay (changed)' is not on this list, because a fork that
    # moved since pinning is exactly what the operator asked to be told about.
    # 'not-installed (ceremony-gated)' joins them for the same reason and a sharper one: it is
    # the one class no command clears, since a re-run skips the file by design and -Accept
    # refuses a file that does not exist. Counted, it would put two permanent rows in front of
    # every default install forever, which is the decoration CONTRIBUTING.md's drift gate names.
    $attention = @($results | Where-Object { $_.Status -notin @('in-sync', 'stateful (not audited)', 'overlay (accepted)', 'not-installed (ceremony-gated)') })

    # -Quiet returns here rather than guarding each Write-Host below it. Everything past this
    # point prints on a clean run: the summary line, and then a header plus a
    # "No <label> drift since last scan." line from each of the three Show-StackDrift calls at
    # the bottom of this block. Suppressing only the table would still open every session with
    # that block, which is the flood the flag exists to prevent.
    # Status first, tab-separated: a status carries spaces ('untracked (differs from core)')
    # and a manifest key cannot carry a tab, so one split on the tab is unambiguous either way
    # round. Rejected reprinting the table for the hook to parse: its column padding moves with
    # the longest path on the run, so there is no stable column to split on.
    if ($Quiet) {
        foreach ($row in $attention) { Write-Host "$($row.Status)`t$($row.File)" }
        return
    }

    if ($attention.Count -eq 0) {
        Write-Host 'All managed files in sync with core.'
    }
    else {
        # 'missing' takes two answers because one status covers two different losses. A tracked
        # file that was deleted is restored by a re-run, safely, because core still holds it. A
        # pinned overlay that was deleted is a file only the project ever had: no re-run can bring
        # it back, and anything that tried would be inventing content. So the hint names the
        # recovery for one and the pin-drop for the other rather than sending both to the
        # installer. (CONTRIBUTING.md's drift-detection gate: every class the audit reports needs
        # a standing response, and the classes that must never be auto-repaired are named as such.)
        Write-Host "$($attention.Count) file(s) need attention. project-modified/untracked-differs = candidates to promote into core; core-updated/not-installed = re-run installer to pull down; overlay-changed = re-review the fork, then re-pin with -Accept; missing = re-run the installer if the row is a tracked file, but a missing pinned overlay exists only in the project's own history, so restore it from there or drop the pin with -Unaccept; orphaned (already removed/unmodified/modified) = -Prune the key to drop the stale manifest record -- the file, if any is still there, is left on disk for you to delete by hand or -Accept to pin as an overlay."
    }

    # Stack drift: report-only, same as the file audit above — never writes the manifest or
    # the sidecar. Covers all three stackDetected categories, not just plugins.
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
    # stackDetected lives in the sidecar, not the manifest — see the ConvertTo-ManifestV2
    # comment above for why.
    $recordedStack = @{}
    if ($sidecar.Contains('stackDetected')) { $recordedStack = $sidecar['stackDetected'] }

    # A hand-edited sidecar can set stackDetected to null or to a non-object value
    # (string, number, array) — ConvertFrom-Json -AsHashtable passes those through as-is.
    # .Contains() below assumes a hashtable, so treat anything else as "nothing recorded"
    # rather than throw. -Audit is report-only and must never abort or rewrite the manifest
    # or the sidecar.
    if ($recordedStack -isnot [hashtable]) { $recordedStack = @{} }

    $recordedPlugins = @()
    if ($recordedStack.Contains('plugins')) { $recordedPlugins = @($recordedStack['plugins']) }

    $recordedOutputStyles = @()
    if ($recordedStack.Contains('outputStyles')) { $recordedOutputStyles = @($recordedStack['outputStyles']) }

    $recordedMcpServers = @()
    if ($recordedStack.Contains('mcpServers')) { $recordedMcpServers = @($recordedStack['mcpServers']) }

    # round-2 F9: "0 recorded" and "never recorded" are different facts, and comparing against
    # zero when it is really "unknown" reports every currently-detected plugin/output-style/MCP
    # server as newly added, which is wrong on any project whose sidecar the installer refused
    # to write (issue #137's live-probe follow-up) -- not merely on one that has genuinely never
    # seen this feature. One line saying the comparison did not run beats a wall of false
    # "newly detected" rows.
    if (-not $sidecar.Contains('stackDetected')) {
        Write-Host "`nStack drift: not recorded (no sidecar, or the last install could not confirm it is git-ignored) -- plugin/output-style/MCP-server drift cannot be compared this run."
        return
    }

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

    # Three states reach this point and each takes a different remedy, so one message for all
    # three sends two thirds of operators at a command that will refuse them: -Accept throws on
    # any key tracked in `files` (the guard in the -Accept block above), which is exactly what a
    # file skipped after a prior install is.
    $acceptedHash = $script:manifest['accepted'][$ManifestKey]

    if ($acceptedHash -and $acceptedHash -eq $currentHash) {
        # Already pinned, and still at the hash it was pinned at. The operator settled this file
        # once; core's version is deliberately not copied over it and there is nothing to act on,
        # which is why this is the one branch on the normal stream rather than a warning.
        Write-Host "Keeping '$ManifestKey': accepted overlay, still at the hash it was pinned at. Core's version was not copied over it."
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'skipped-pinned' })
        return
    }

    if ($recordedHash) {
        # Tracked in `files`, so -Accept is not available and naming it would be a dead end.
        # Promotion is named before -Force on purpose: this line ships into every project that
        # installs the harness, and -Force replaces the project's own edit with core's version.
        Write-Warning "Skipping '$ManifestKey': tracked as an installed file and modified since install. Promote the change into core, or re-run with -Force to overwrite it with core's version."
        $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'skipped-modified' })
        return
    }

    # Untracked overlay: a project file core also ships, never installed through the manifest, or
    # a pin whose file has moved since it was pinned. -Accept takes both, and re-pinning is what
    # the moved-pin case wants, so one branch covers them.
    Write-Warning "Skipping '$ManifestKey': differs from core and is not tracked as an installed file. Pin it with -Accept '$ManifestKey' to keep the fork and stop the audit flagging it, or re-run with -Force to replace it with core's version."
    $script:results.Add([pscustomobject]@{ File = $ManifestKey; Action = 'skipped-untracked' })
}

# Refused above the first copy, not at the settings merge further down. By the time the merge runs,
# every agent, every hook, guardrails.md and the scratch box are already on disk and the manifest
# that records them has not been written yet, so a throw down there leaves a layer the next -Audit
# reads as untracked top to bottom. Improving the message at the merge site would have left that
# damage exactly where it was.
if ($settingsParseError) {
    throw "Target settings.json does not parse as JSON: $settingsPath. Merging the hook registrations into it would destroy whatever it holds, so nothing was copied and the manifest was not written. Fix or move that file, then re-run. Parser reported: $settingsParseError"
}

# Prerequisite probe. Every TypeScript hook this installs is registered below as a bare
# `bun ...` command, so on a machine without bun the layer installs looking complete and the
# gates never run. README.md's install section is the only place that has said so, and a
# documented prerequisite nothing checks is a prerequisite that gets skipped.
#   Warns rather than throws: installing the layer before installing bun is legitimate (a fresh
# clone being equipped ahead of its toolchain), and nothing this run writes is wrong without it:
# the registrations are correct either way, so bun arriving later needs no re-install.
#   Only bun is probed, not the whole prerequisite list Install-Account.ps1 warns about. A vale
# probe would be noise, since its consumer degrades to a documented advisory skip by design; an
# sh probe would rest on an unverified claim about how Claude Code resolves `sh` for a hook
# command, which is not resolved against this script's PATH. Widen this when either turns into
# a measured failure rather than a guess.
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Warning "bun is not on PATH. The TypeScript hooks installed below are registered as bare 'bun' commands, so the gates stop enforcing and Claude Code surfaces an error notice on stderr per dispatch. Install bun to make them enforce; the registrations this run writes are already correct, so no re-install is needed."
}

# Sidecar decision, ahead of every write this install makes (round-4 C). Round 3 threw the R2-2
# refusal from the sidecar write at the bottom of the script, after the copy loops below had
# already updated agents, hooks and guardrails, so a refused run left a half-updated layer while
# its message said nothing was written. The refusal can only be thrown here now; the second
# Get-SidecarPlan call after the loops re-reads only the ignored answer (see that function).
$sidecarPlan = Get-SidecarPlan -TargetDir $Target

# Created here, after the decision above, not at the top of the script: a refused run must not
# leave new directories behind either. Only a plain install reaches this point. -Accept, -Unaccept,
# -Prune and -Audit all return earlier, and none of them may conjure a .claude tree: a missing
# directory there is the "file does not exist" / "nothing is pinned" case each one's own guard
# reports, and reporting that beats silently creating an empty layout.
foreach ($dir in @($claudeDir, $agentsDst, $hooksDst, $scratchDst)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
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

# Copy-Item doesn't carry the source executable bit, and a git hook git
# won't invoke without one on a platform that has the concept at all.
# Windows has none, so this is a no-op there — Git for Windows runs the hook
# by its shebang regardless of the (meaningless) NTFS permission bits.
#
# All three git-invoked entry points, not only pre-commit: core/claude/hooks/
# pre-push (issue #64's whole-range identity sweep) and commit-msg (the
# AI-attribution refusal, promoted from a hand-placed .git/hooks copy that
# existed on one machine and in no repository) are real git hooks too, and
# git skips either the same silent way it skips an unmarked pre-commit.
# identity-patterns.sh is deliberately absent from this list — it is a
# sourced function library, never executed directly by git or anything
# else, so it needs no executable bit at all.
if (-not $IsWindows) {
    foreach ($gitHookName in @('pre-commit', 'pre-push', 'commit-msg')) {
        $gitHookDst = Join-Path $hooksDst $gitHookName
        if (Test-Path -LiteralPath $gitHookDst) {
            & chmod +x $gitHookDst
            # Same trap as the core.hooksPath write below: a native command's non-zero exit
            # does not trip $ErrorActionPreference = 'Stop'. Failure reports, success stays
            # silent. The rule behind that, and behind why core.hooksPath reports its success
            # while this does not: a row reports success only where nothing else reports it.
            # core.hooksPath has no other row, so it prints one; the chmod is covered by the
            # hooks/<name> row already saying 'installed', so only a failure adds anything,
            # and it has to, because git skips a hook lacking the executable bit without saying
            # so. Silence here conflates three states (chmod succeeded, Windows skip above,
            # no hook file found), which is tolerable only because the one state an operator
            # can act on is the one that prints.
            # Real triggers are filesystems with no POSIX permission bits (CIFS/SMB, exFAT,
            # WSL DrvFs mounted without `metadata`) and a checkout owned by another uid.
            if ($LASTEXITCODE -ne 0) {
                $results.Add([pscustomobject]@{ File = "chmod:hooks/$gitHookName"; Action = "FAILED (chmod exit $LASTEXITCODE) - hook not executable" })
            }
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

# .claude/.gitignore: keeps the coreRepo/stackDetected sidecar (.harness-manifest.local.json)
# out of every commit, the same way scratch/.gitignore above keeps the drop box untracked.
# A project's own .gitignore at its root is never touched by this.
Install-ManagedFile -SourcePath (Join-Path $templatesSrc 'manifest-local.gitignore') `
    -DestPath (Join-Path $claudeDir '.gitignore') `
    -ManifestKey '.gitignore'

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

# Settings merge. $settingsPath and $settings come from the parse at the top of the script, which
# is also what the guard above the agents loop checked, so the shape merged here is the shape that
# was approved before anything was copied. Nothing this run writes touches settings.json between
# the two points.
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
        if ($newHooks.Count -eq 0) { continue }

        # Before appending a new sibling group, look for an existing group (either carried
        # over from the target, or added earlier in this same loop) whose matcher already
        # equals this one's. "No matcher property" and an explicit null matcher are the same
        # case on both sides, so a $null-vs-$null comparison must not fall through to -eq
        # (which is unreliable with $null on the right-hand side). The non-null comparison is
        # -ceq: Claude Code matchers are case-sensitive regexes ("Bash" and "bash" are
        # different matchers), and the command dedup above (List[string].Contains) is already
        # ordinal, so a case-insensitive matcher match here would silently fold a target's
        # differently-cased matcher into the template's group.
        $groupMatcher = if ($group.PSObject.Properties['matcher']) { $group.matcher } else { $null }
        $existingMatch = $null
        foreach ($eg in $existingGroups) {
            $egMatcher = if ($eg.PSObject.Properties['matcher']) { $eg.matcher } else { $null }
            $sameMatcher = if ($null -eq $groupMatcher) { $null -eq $egMatcher } else { $groupMatcher -ceq $egMatcher }
            if ($sameMatcher) { $existingMatch = $eg; break }
        }

        if ($null -ne $existingMatch) {
            # An existing group can carry `matcher` with no `hooks` property at all (or an
            # explicit null), so filter nulls out before concatenating rather than trusting
            # @($existingMatch.hooks) to already be a clean array. And when `hooks` is absent
            # rather than merely null, dot-assignment throws ("property cannot be found") since
            # PSCustomObject doesn't auto-vivify a missing property on set — only Add-Member
            # creates one.
            $existingHooks = @(@($existingMatch.hooks) | Where-Object { $_ })
            $mergedHooks = @($existingHooks + $newHooks)
            if ($existingMatch.PSObject.Properties['hooks']) {
                $existingMatch.hooks = $mergedHooks
            }
            else {
                $existingMatch | Add-Member -NotePropertyName hooks -NotePropertyValue $mergedHooks
            }
        }
        else {
            $newGroup = [pscustomobject]@{}
            if ($group.PSObject.Properties['matcher']) {
                $newGroup | Add-Member -NotePropertyName matcher -NotePropertyValue $group.matcher
            }
            $newGroup | Add-Member -NotePropertyName hooks -NotePropertyValue $newHooks
            $existingGroups.Add($newGroup)
        }
        foreach ($h in $newHooks) { $existingCommands.Add($h.command) }
        $results.Add([pscustomobject]@{ File = "settings.json:$eventType"; Action = 'merged' })
    }
    $settings.hooks.$eventType = $existingGroups.ToArray()
}

# Install-time provenance, refreshed on every install. A project that re-installs from a
# newer core should record the commit it actually got, not the one it first got. coreCommit
# travels (it names a commit, not a place) and stays in the committed manifest; coreRepo and
# stackDetected do not travel and go in the gitignored sidecar instead (issue #137). Hooks
# reading coreRepo to locate core need a path that survives the core repo being moved, which
# is exactly the sidecar's job.
$manifest['coreCommit'] = Get-CoreCommit

$sidecar['coreRepo'] = $repoRoot
$sidecar['stackDetected'] = [ordered]@{
    scannedAt     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    plugins       = $detectedPlugins
    outputStyles  = $detectedOutputStyles
    mcpServers    = $detectedMcpServers
}
Write-Host "Plugins detected: $($detectedPlugins.Count); output styles: $($detectedOutputStyles.Count); MCP servers: $($detectedMcpServers.Count)"

# Installing manifest-local.gitignore above is not proof the sidecar just populated is actually
# covered, so the ignored answer is asked again here, after the copy loops. The refusal was already
# decided above the loops, before any write, so this call passes those facts through and cannot
# refuse. It fails closed rather than persisting these two fields into a file git cannot be shown
# to ignore: it warns, leaves a tracked copy in place, and removes a stale copy only once a git
# answering for this target confirms it is untracked.
$sidecarPlan = Get-SidecarPlan -TargetDir $Target -Facts $sidecarPlan.Facts
if (Invoke-SidecarPlan -Plan $sidecarPlan -Sidecar $sidecar) {
    $results.Add([pscustomobject]@{ File = '.harness-manifest.local.json'; Action = 'written' })
}
else {
    $results.Add([pscustomobject]@{ File = '.harness-manifest.local.json'; Action = 'skipped-unprotected' })
}

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
