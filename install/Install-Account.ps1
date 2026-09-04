# UNWIRED until Task 13 of docs/superpowers/plans/2026-09-03-account-layer-portability.md adds
# its README and rules/harness-core.md registration. Invoke: pwsh -NoProfile -File install/Install-Account.ps1
<#
.SYNOPSIS
    Installs this repo's account/claude payload onto a workstation's ~/.claude.

.DESCRIPTION
    Runs on any workstation from a clone, on Windows or Linux. Content directories are copied
    over the top of ~/.claude and model-tier-gate.ts is sourced from core rather than the
    payload, so the repo holds one copy of it. A preflight warns about every prerequisite tool
    absent from PATH without gating the install. On a Linux target every .sh hook under
    hooks/ is chmod +x'd; the operator gets the same warning either way if chmod is missing or
    if it runs and fails. Supports -WhatIf: every file write is a built-in cmdlet that honours
    $WhatIfPreference on its own, and the one write that is not, the chmod call, is wrapped in
    its own $PSCmdlet.ShouldProcess check so a dry run does not mark hooks executable either.

    -PayloadRoot and -ClaudeHome are canonicalised and refused if they are the same directory
    or nested inside each other, since the copy reads recursively from one while writing into
    the other. A failure partway through the copy leaves the target in a mixed state; rather
    than attempting to make the copy atomic, the script warns and says to re-run, since every
    copy here is an unconditional overwrite and safe to repeat.

    Placeholder expansion, the Linux invocation rewrite, a settings merge that does not clobber
    what Claude Code writes into settings.json itself, and a residual-path report are not in
    this half; Tasks 9 through 12 add them to this same script.

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

.PARAMETER VaultPath
    Expands {{OBSIDIAN_VAULT}}. Defaults to $env:CLAUDE_OBSIDIAN_VAULT, then to
    $HOME/Documents/Obsidian Vault/Claude Code.

.PARAMETER HomeSlug
    Expands {{HOME_SLUG}}. Defaults to Get-ProjectSlug $HOME. Test seam: a child pwsh takes
    $HOME from USERPROFILE, not from $env:HOME, so a test cannot steer the default from outside.

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
# SupportsShouldProcess makes -WhatIf and -Confirm valid on the script and sets
# $WhatIfPreference for the whole run. No explicit $PSCmdlet.ShouldProcess call is needed to
# act on it: every write below (New-Item, Copy-Item) is a built-in cmdlet that already
# implements ShouldProcess itself and reads $WhatIfPreference from the calling scope, the same
# way Export-Account.ps1:68-74 already established for its own copy loop.
[CmdletBinding(PositionalBinding = $false, SupportsShouldProcess)]
param(
    [string]$ClaudeHome,
    [string]$ClaudeJson,
    [string]$PayloadRoot,
    [string]$CoreRepo,
    [string]$NpmGlobal,
    [string]$VaultPath,
    [string]$HomeSlug,
    [bool]$TargetIsWindows = $(if ($PSVersionTable.PSVersion.Major -lt 6) { $true } else { $IsWindows }),
    [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AccountShared.ps1')

$repoRoot = Split-Path $PSScriptRoot -Parent

# An explicitly passed empty string or $null is a caller error, not "no preference": falling
# through to the default here would silently target the operator's live ~/.claude (-ClaudeHome)
# or this clone's own payload (-PayloadRoot) for a caller that meant to supply a real path and
# got an empty one from an unset environment variable or a failed lookup. ContainsKey
# distinguishes "passed empty" from "omitted", the same test -NpmGlobal already uses below for
# the opposite reason: there, an explicit empty is a real request rather than an error.
foreach ($n in 'ClaudeHome', 'PayloadRoot') {
    if ($PSBoundParameters.ContainsKey($n) -and -not $PSBoundParameters[$n]) {
        throw "-$n was passed empty. Omit it to take the default, or pass a real path."
    }
}

if (-not $ClaudeHome)  { $ClaudeHome = Join-Path $HOME '.claude' }
if (-not $ClaudeJson)  { $ClaudeJson = Join-Path $HOME '.claude.json' }
if (-not $PayloadRoot) { $PayloadRoot = Join-Path (Join-Path $repoRoot 'account') 'claude' }

# GetUnresolvedProviderPathFromPSPath, not [System.IO.Path]::GetFullPath: see
# Export-Account.ps1:130-138 for the full reasoning (GetFullPath resolves a relative path
# against the .NET process working directory, which Set-Location does not move, while
# Copy-Item and New-Item resolve against $PWD instead). Canonicalising both paths here, before
# anything reads or writes through either, is what makes Copy-PayloadTree's
# `$f.FullName.Substring($from.Length)` arithmetic below safe: a relative -PayloadRoot used to
# produce a $from that did not match the prefix of Get-ChildItem's absolute FullName values,
# scattering every tree-copied file into a garbled destination while the install still reported
# success and exited 0.
$ClaudeHome  = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ClaudeHome).TrimEnd('\', '/')
$PayloadRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PayloadRoot).TrimEnd('\', '/')

# Review round 2 addendum: -PayloadRoot and -ClaudeHome must not be the same directory, or
# nested inside each other. Copy-PayloadTree reads recursively from -PayloadRoot while writing
# into -ClaudeHome, so either direction of nesting means the copy walks a tree it is
# concurrently writing into. Same failure class Export-Account.ps1:141-151 guards against for
# its own -OutputRoot/-ClaudeHome pair, though the shape of the damage differs there (its
# mirror deletes each allowlisted directory before recopying, so containment would delete the
# live account layer; here it would make the copy read from inside its own destination).
# Compares the canonical paths resolved just above, not the raw parameter strings, so a
# relative '.' or a trailing separator cannot slip past. This is a string comparison, not a
# filesystem resolution: it does not see through an NTFS junction, a symlink, an 8.3 short
# name, or a \\?\-prefixed path, so a -PayloadRoot that reaches -ClaudeHome through one of
# those is not caught here. Filed as backlog item 19 (a shared reparse-point-aware helper in
# AccountShared.ps1, since Export-Account.ps1 has the identical gap in its own guard) rather
# than fixed in this pass.
$onWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$pathComparison = if ($onWindowsHost) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
$sep = [System.IO.Path]::DirectorySeparatorChar
if ($PayloadRoot.Equals($ClaudeHome, $pathComparison) -or
    $PayloadRoot.StartsWith("$ClaudeHome$sep", $pathComparison) -or
    $ClaudeHome.StartsWith("$PayloadRoot$sep", $pathComparison)) {
    throw "-PayloadRoot ('$PayloadRoot') and -ClaudeHome ('$ClaudeHome') must not be the same " +
        "directory or nested inside each other; the copy reads recursively from one while " +
        "writing into the other."
}

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

# There is no manifest and no staging-and-swap: a failure partway through this block leaves
# $ClaudeHome holding whatever had already copied plus whatever was there before. That is not
# made atomic here (would break the shape Tasks 9 through 12 build on); what the catch below
# adds is telling the operator the run did not finish and that a re-run repairs it, since every
# copy in this block is an unconditional overwrite and safe to repeat.
try {
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

    # Core is authoritative for this one file, so it comes out of core/ in the same clone
    # rather than out of the payload. Two copies in one repo would drift the moment either was
    # edited.
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
    # whenever a test drives the Linux branch: `& chmod` with no chmod on PATH is terminating,
    # so the round-trip test in Task 12 would die here rather than assert on the installed tree.
    $chmod = Get-Command chmod -ErrorAction SilentlyContinue
    # Same message either way: an operator does not need to know whether chmod was missing or
    # failed, only that they need to run it themselves. Review round 1, item 7: at this
    # process's $PSNativeCommandUseErrorActionPreference default (false), a chmod that exits
    # non-zero does not throw, so a failure here used to print raw stderr and nothing else,
    # while the absent case got this same sentence. Checking $LASTEXITCODE and reusing the
    # warning closes that gap without touching the preference itself, which Export-Account.ps1's
    # npm probe already relies on staying false (it checks $LASTEXITCODE explicitly too, rather
    # than letting a non-zero exit throw), and which the next two tasks would otherwise inherit
    # as a silent semantics change for every native call in this file.
    $chmodWarning = 'chmod not on PATH: .sh hooks are not marked executable. Run `chmod +x ~/.claude/hooks/*.sh` on the target.'
    if (-not $TargetIsWindows -and $chmod) {
        # Round 3: `& $chmod.Source` is a native executable, not a cmdlet, so it does not read
        # $WhatIfPreference on its own the way New-Item and Copy-Item above do. A dry run used to
        # chmod the real target's hooks anyway, the one write in this script -WhatIf did not
        # actually prevent. Gated the same way Export-Account.ps1:346 gates its own plain-script-
        # logic step that isn't a self-aware cmdlet either.
        if ($PSCmdlet.ShouldProcess($ClaudeHome, 'chmod +x .sh hooks')) {
            $chmodFailed = $false
            foreach ($s in @(Get-ChildItem -LiteralPath (Join-Path $ClaudeHome 'hooks') -Recurse -File -Filter *.sh -Force -ErrorAction SilentlyContinue)) {
                & $chmod.Source +x $s.FullName
                if ($LASTEXITCODE -ne 0) { $chmodFailed = $true }
            }
            if ($chmodFailed) { Write-Warning $chmodWarning }
        }
    }
    elseif (-not $TargetIsWindows) {
        Write-Warning $chmodWarning
    }
}
catch {
    Write-Warning "Install failed partway through: '$ClaudeHome' is left in a mixed state, holding some content from before this run alongside whatever copied before the failure. The install did not complete. Re-run this script: every copy above is an unconditional overwrite, so re-running is idempotent and finishes what this one left unfinished."
    throw
}

# --- token expansion ---------------------------------------------------------
# Every value is forward-slashed. PowerShell on Windows accepts & 'C:/...' and Linux accepts
# nothing else, so one spelling covers both platforms and the export folds it back cleanly.
function Get-AccountTokenMap {
    param(
        [string]$ClaudeHome,
        [string]$NpmGlobal,
        [string]$CoreRepo,
        [string]$VaultPath,
        [string]$HomeSlug
    )
    return @{
        '{{CLAUDE_HOME}}'    = ($ClaudeHome -replace '\\', '/')
        '{{NPM_GLOBAL}}'     = ($NpmGlobal  -replace '\\', '/')
        '{{CORE_REPO}}'      = ($CoreRepo   -replace '\\', '/')
        '{{OBSIDIAN_VAULT}}' = ($VaultPath  -replace '\\', '/')
        '{{HOME_SLUG}}'      = $HomeSlug
    }
}

function Expand-AccountToken {
    param([string]$Text, [hashtable]$Tokens)
    if (-not $Text) { return $Text }
    $out = $Text
    foreach ($k in @($Tokens.Keys)) { $out = $out.Replace($k, [string]$Tokens[$k]) }
    return $out
}

# A payload can name a token this script does not know: a stale placeholder from a plan that
# renamed one, or a typo. Passthrough stays deliberate rather than a hard stop, since a receiver
# still gets an install over one bad file, but a silent survivor lands in a model-read file or a
# hook command that cannot run, so it is reported instead of left invisible.
function Get-ResidualToken {
    param([string]$Text)
    if (-not $Text) { return @() }
    return @(([regex]::Matches($Text, '\{\{[A-Z_]+\}\}') | ForEach-Object { $_.Value } | Select-Object -Unique))
}

# Parameters, not locals. A test drives this script as a child process with a stand-in $HOME
# that the child does not inherit, so an internally derived vault path and slug would expand to
# the runner's real values and the round trip in Task 12 could not assert on either.
if (-not $VaultPath) {
    $VaultPath = if ($env:CLAUDE_OBSIDIAN_VAULT) { $env:CLAUDE_OBSIDIAN_VAULT }
    else { Join-Path (Join-Path (Join-Path $HOME 'Documents') 'Obsidian Vault') 'Claude Code' }
}
if (-not $HomeSlug) { $HomeSlug = Get-ProjectSlug $HOME }

$tokens = Get-AccountTokenMap -ClaudeHome $ClaudeHome -NpmGlobal $NpmGlobal `
    -CoreRepo $CoreRepo -VaultPath $VaultPath -HomeSlug $HomeSlug

foreach ($rel in $script:AccountTemplatedFiles.Keys) {
    $target = Join-Path $ClaudeHome $rel
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $text = Get-Content -LiteralPath $target -Raw
    $expanded = Expand-AccountToken -Text $text -Tokens $tokens
    $residual = Get-ResidualToken -Text $expanded
    if ($residual.Count -gt 0) {
        Write-Warning "Unexpanded placeholder(s) in ${rel}: $($residual -join ', '). Left verbatim; a model reading this file sees the literal token."
    }
    Set-Content -LiteralPath $target -Value $expanded -NoNewline
}

# --- settings ----------------------------------------------------------------
# Convert-HookCommand does the {{CLAUDE_HOME}} expansion and, on Linux only, the
# "& '...ps1'" to "pwsh -NoProfile -File" rewrite in one pass. It never touches the shell key,
# so that removal is new code below. {{NPM_GLOBAL}} is not under {{CLAUDE_HOME}} and is left
# alone by that function, so it takes the plain token replace.
function Convert-SettingsForTarget {
    param(
        [pscustomobject]$Settings,
        [string]$ClaudeHome,
        [hashtable]$Tokens,
        [bool]$TargetIsWindows,
        [bool]$NpmPresent
    )
    $homeSlashed = $ClaudeHome -replace '\\', '/'

    # Where-Object { $_ }, not just @(): on a genuinely empty hooks object, .Properties.Name is
    # $null, and @($null) is a ONE-element array holding $null, not an empty array. Without the
    # filter the loop below ran once with $event = '', $group = $null, and $kept ended up
    # holding that $null hook whenever $NpmPresent short-circuited the filter, so
    # "$hook.command = ..." tried to set a property on $null. Reproduced against the default
    # test payload's {"hooks":{}}, not just the empty-hooks fixture that first exposed it.
    foreach ($event in @($Settings.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        $keptGroups = New-Object System.Collections.Generic.List[pscustomobject]
        # Where-Object { $_ } again: $Settings.hooks.$event can itself be an explicit JSON null
        # (a receiver-authored {"hooks":{"PreToolUse":null}}), and the same @($null) collapse
        # applies at this locus independently of the filter below.
        foreach ($group in @(@($Settings.hooks.$event) | Where-Object { $_ })) {
            # $_ -and (...), not just the ccstatusline test: a group with no "hooks" key, or an
            # explicit "hooks": null, makes $group.hooks itself $null, and @($null) is the same
            # one-element phantom. An explicit $null piped into Where-Object still passes
            # through as one item, so the ccstatusline test alone does not filter it out
            # whenever $NpmPresent short-circuits the OR.
            #
            # Also wraps the pipeline OUTPUT: a single surviving hook unwraps to a bare scalar
            # and would serialise "hooks": {...} instead of "hooks": [...]
            # (install/Install-Harness.ps1:822-826).
            $kept = @(@($group.hooks) | Where-Object {
                    $_ -and ($NpmPresent -or ($_.command -notmatch 'ccstatusline'))
                })
            if ($kept.Count -eq 0) { continue }
            foreach ($hook in $kept) {
                # A hook entry with no "command" property has nothing to rewrite.
                # PSCustomObject assignment to a NoteProperty that does not already exist
                # throws rather than creating one, so leave the entry alone instead of
                # crashing on it.
                if (-not $hook.PSObject.Properties['command']) { continue }
                $hook.command = Convert-HookCommand $hook.command '{{CLAUDE_HOME}}' $homeSlashed $TargetIsWindows
                $hook.command = Expand-AccountToken -Text $hook.command -Tokens $Tokens
                if (-not $TargetIsWindows -and $hook.PSObject.Properties['shell']) {
                    # On Linux the command string goes to /bin/sh. Leaving the key would send
                    # the rewritten pwsh command back to a PowerShell host that is not there.
                    $hook.PSObject.Properties.Remove('shell')
                }
            }
            $group.hooks = $kept
            $keptGroups.Add($group)
        }
        if ($keptGroups.Count -eq 0) { $Settings.hooks.PSObject.Properties.Remove($event) }
        else { $Settings.hooks.$event = $keptGroups.ToArray() }
    }

    if ($Settings.statusLine.command) {
        if ($NpmPresent) {
            $Settings.statusLine.command =
                Expand-AccountToken -Text $Settings.statusLine.command -Tokens $Tokens
        }
        else {
            # Point at a script that exists rather than write a command that cannot run.
            # Whether these two scripts still work is untested: nothing has invoked them since
            # ccstatusline took over, and this branch is the first thing that will.
            $Settings.statusLine.command = if ($TargetIsWindows) {
                "pwsh -NoProfile -File '$homeSlashed/statusline-command.ps1'"
            }
            else {
                "bash '$homeSlashed/statusline-command.sh'"
            }
        }
    }

    if (-not $TargetIsWindows -and $Settings.env -and
        $Settings.env.PSObject.Properties['CLAUDE_CODE_USE_POWERSHELL_TOOL']) {
        $Settings.env.PSObject.Properties.Remove('CLAUDE_CODE_USE_POWERSHELL_TOOL')
    }

    return $Settings
}

# A hook entry's identity is its event, its matcher and its expanded command. A present entry
# is replaced in place, a missing one is appended, and a receiver-only one is left alone.
# Install-Harness.ps1's merge keys on the command string alone (L808-866) and knows nothing
# about matchers or events, so it is not reusable here.
function Merge-HookEvent {
    param([object[]]$PayloadGroups, [object[]]$ExistingGroups)
    $result = New-Object System.Collections.Generic.List[pscustomobject]
    foreach ($g in @($ExistingGroups)) { $result.Add($g) }

    foreach ($pg in @($PayloadGroups)) {
        $pMatcher = if ($pg.PSObject.Properties['matcher']) { $pg.matcher } else { $null }
        $target = $null
        foreach ($eg in $result) {
            $eMatcher = if ($eg.PSObject.Properties['matcher']) { $eg.matcher } else { $null }
            if ($eMatcher -eq $pMatcher) { $target = $eg; break }
        }
        if (-not $target) { $result.Add($pg); continue }

        $merged = New-Object System.Collections.Generic.List[pscustomobject]
        # Where-Object { $_ }: the matched existing group can be hand-edited into a group with
        # no "hooks" key, or an explicit "hooks": null. Either way $target.hooks reads as $null
        # and @($null) is a ONE-element array holding $null, not an empty one; left unfiltered
        # it would splice a literal null into the merged hooks array below.
        foreach ($h in @(@($target.hooks) | Where-Object { $_ })) { $merged.Add($h) }
        foreach ($ph in @($pg.hooks)) {
            $idx = -1
            for ($i = 0; $i -lt $merged.Count; $i++) {
                if ($merged[$i].command -eq $ph.command) { $idx = $i; break }
            }
            if ($idx -ge 0) { $merged[$idx] = $ph } else { $merged.Add($ph) }
        }
        # Add-Member -Force, not a plain assignment: a PSCustomObject throws
        # "The property 'hooks' cannot be found" on `.hooks =` when the property was never
        # there to begin with, which is exactly the no-hooks-key group this comment already
        # names. -Force makes the same call work whether the property pre-exists or not.
        $target | Add-Member -NotePropertyName hooks -NotePropertyValue $merged.ToArray() -Force
    }
    return $result.ToArray()
}

function Merge-AccountSettings {
    param([pscustomobject]$Payload, [pscustomobject]$Existing)
    if (-not $Existing) { return $Payload }

    foreach ($prop in @($Payload.PSObject.Properties)) {
        $name = $prop.Name
        $pv = $prop.Value

        if (-not $Existing.PSObject.Properties[$name]) {
            $Existing | Add-Member -NotePropertyName $name -NotePropertyValue $pv -Force
            continue
        }
        $ev = $Existing.$name

        if ($name -eq 'statusLine') {
            # Replaced whole. A deep merge would leave a stale refreshInterval or padding from
            # whatever statusline the receiver had before.
            $Existing.$name = $pv
        }
        elseif ($name -eq 'hooks') {
            foreach ($event in @($pv.PSObject.Properties.Name | Where-Object { $_ })) {
                # Not `$existingGroups = if (...) {...} else { @() }`: PowerShell collapses an
                # if-expression's @() branch to $null, since @() with nothing inside it produces
                # no pipeline output for the branch to capture, rather than to the empty array a
                # direct assignment would give. Measured: an existing settings.json that simply
                # does not carry $event yet (the ordinary case for a hook event installed for
                # the first time) fed that $null into Merge-HookEvent's ExistingGroups, where
                # @($null) is a one-element array holding $null, and the matcher lookup then
                # threw "Cannot index into a null array" on it. The statement form below assigns
                # a real empty array directly instead of going through a branch's output.
                # Where-Object { $_ } inside the true branch: $ev.$event can itself be an
                # explicit JSON null ("hooks":{"PreToolUse":null}), the same one-element phantom
                # by a different route, filtered out the same way.
                $existingGroups = @()
                if ($ev.PSObject.Properties[$event]) {
                    $existingGroups = @(@($ev.$event) | Where-Object { $_ })
                }
                $mergedEvent = @(Merge-HookEvent -PayloadGroups @($pv.$event) -ExistingGroups $existingGroups)
                if ($ev.PSObject.Properties[$event]) { $ev.$event = $mergedEvent }
                else { $ev | Add-Member -NotePropertyName $event -NotePropertyValue $mergedEvent -Force }
            }
        }
        elseif ($name -eq 'permissions') {
            foreach ($sub in @($pv.PSObject.Properties.Name | Where-Object { $_ })) {
                if ($sub -eq 'allow') {
                    # Ordered set union, receiver entries first, so a receiver's own grants keep
                    # their position and the payload's are appended once. Where-Object { $_ } on
                    # both sides: a receiver's permissions object can be present but empty
                    # ({"permissions":{}}), so $ev.allow reads as a missing property (also
                    # $null) and @($null) is the same one-element phantom as above, which
                    # without the filter adds a blank entry to the union.
                    $union = New-Object System.Collections.Generic.List[string]
                    foreach ($a in @(@($ev.allow) | Where-Object { $_ })) { if (-not $union.Contains($a)) { $union.Add($a) } }
                    foreach ($a in @(@($pv.allow) | Where-Object { $_ })) { if (-not $union.Contains($a)) { $union.Add($a) } }
                    if ($ev.PSObject.Properties['allow']) { $ev.allow = $union.ToArray() }
                    else { $ev | Add-Member -NotePropertyName allow -NotePropertyValue $union.ToArray() -Force }
                }
                else {
                    $ev | Add-Member -NotePropertyName $sub -NotePropertyValue $pv.$sub -Force
                }
            }
        }
        elseif ($pv -is [pscustomobject] -and $ev -is [pscustomobject]) {
            # env, enabledPlugins, extraKnownMarketplaces, skillOverrides: payload wins on a
            # shared key, receiver-only keys are kept.
            $Existing.$name = Merge-AccountSettings -Payload $pv -Existing $ev
        }
        else {
            $Existing.$name = $pv
        }
    }
    return $Existing
}

$settingsSrc = Join-Path $PayloadRoot 'settings.account.json'
if (Test-Path -LiteralPath $settingsSrc) {
    if (-not $npmPresent) {
        Write-Warning 'npm is absent: dropping the two ccstatusline hook entries and pointing statusLine.command at the shipped statusline script for this platform.'
    }
    $payloadSettings = Get-Content -LiteralPath $settingsSrc -Raw | ConvertFrom-Json
    $payloadSettings = Convert-SettingsForTarget -Settings $payloadSettings `
        -ClaudeHome $ClaudeHome -Tokens $tokens `
        -TargetIsWindows $TargetIsWindows -NpmPresent $npmPresent

    $liveSettings = Join-Path $ClaudeHome 'settings.json'
    $existing = $null
    if (Test-Path -LiteralPath $liveSettings) {
        try {
            $existing = Get-Content -LiteralPath $liveSettings -Raw | ConvertFrom-Json
        }
        catch {
            # A hand-edited settings.json that fails to parse is not a shape Merge-AccountSettings
            # can merge against, and Claude Code could not have read it either. Overwriting it
            # silently would still lose whatever the operator was mid-edit on, so it is backed up
            # (change-management.md's *.bak.<timestamp> convention, the same one
            # Export-Account.ps1 already drops from the exported payload) and the install
            # proceeds as though the file were absent, rather than leaving the run half done the
            # way an uncaught throw here would (Task 8's mixed-state catch does not wrap this
            # later block, so a throw here would surface as a bare parser exception).
            $bak = "$liveSettings.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Copy-Item -LiteralPath $liveSettings -Destination $bak -Force
            Write-Warning "Existing settings.json is not valid JSON: $($_.Exception.Message). Backed up to '$bak' and installing the payload's settings as the starting point."
        }
    }
    $merged = Merge-AccountSettings -Payload $payloadSettings -Existing $existing
    $settingsJson = $merged | ConvertTo-Json -Depth 20
    $residual = Get-ResidualToken -Text $settingsJson
    if ($residual.Count -gt 0) {
        Write-Warning "Unexpanded placeholder(s) in settings.json: $($residual -join ', '). Left verbatim; a hook command carrying one cannot run."
    }
    $settingsJson | Set-Content -LiteralPath $liveSettings -Encoding utf8
    Write-Host '  settings.json: merged'
}
