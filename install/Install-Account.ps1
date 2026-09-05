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

    Placeholder expansion, the Linux invocation rewrite, and a settings.json merge that does not
    clobber what Claude Code writes into that file itself are all here (Tasks 9 and 10). An
    mcpServers add-if-missing merge into ~/.claude.json and a residual-path report naming what no
    settings rewrite can reach (a Store path with an embedded version, a WSL launcher into
    another user's home) are here too (Task 11). Task 12 follows.

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
# through to the default here would silently target the operator's live ~/.claude (-ClaudeHome),
# this clone's own payload (-PayloadRoot), or the operator's live ~/.claude.json (-ClaudeJson,
# Task 11) for a caller that meant to supply a real path and got an empty one from an unset
# environment variable or a failed lookup. ContainsKey distinguishes "passed empty" from
# "omitted", the same test -NpmGlobal already uses below for the opposite reason: there, an
# explicit empty is a real request rather than an error.
foreach ($n in 'ClaudeHome', 'PayloadRoot', 'ClaudeJson') {
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
# Task 11: -ClaudeJson gets the same canonicalisation for consistency with the two paths above,
# though the reason differs. Every consumer of -ClaudeJson (Test-Path, Get-Content, Set-Content
# in Merge-McpServer and the residual report below) is a cmdlet that already resolves a relative
# path against $PWD correctly on its own, and this script never calls Set-Location, so a relative
# -ClaudeJson works correctly either way; ablating this line changes no test's outcome. It is
# kept because -ClaudeHome and -PayloadRoot need it for a real reason (Copy-PayloadTree's string-
# prefix arithmetic below cannot use a relative path), and a caller comparing all three -- or a
# future consumer of -ClaudeJson that does string work instead of cmdlet-based I/O -- should not
# find the third one alone left relative. GetUnresolvedProviderPathFromPSPath resolves a path
# that does not exist yet on disk (confirmed against a fresh -ClaudeJson under a not-yet-created
# -ClaudeHome), so this is safe to do unconditionally, same as the other two.
$ClaudeJson  = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ClaudeJson)

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
#
# Shared with the settings-merge try/catch further down: a failure there also leaves
# $ClaudeHome in the same mixed state, since the merge writes settings.json after this block
# has already copied content. Task 10 review: that later failure used to land outside any
# catch at all, surfacing as a bare parser or IO exception with no word that the target was
# left half-installed. One message, one meaning, wherever the run stops.
$mixedStateWarning = "Install failed partway through: '$ClaudeHome' is left in a mixed state, holding some content from before this run alongside whatever copied before the failure. The install did not complete. Re-run this script: every copy above is an unconditional overwrite, so re-running is idempotent and finishes what this one left unfinished."

# F4, final review round: Copy-Item/New-Item/Set-Content are ShouldProcess-aware and no-op under
# -WhatIf on their own, but the status lines below are plain Write-Host built from script counters
# ($copied, $n, $added.Count) that are computed whether or not the underlying cmdlet actually
# wrote anything, so they read as completed work under a dry run unless told otherwise. One flag
# computed once at script scope, reused at every status line below rather than re-testing
# $WhatIfPreference at each site. Same pattern as Export-Account.ps1's own $dryRun.
$dryRun = if ($WhatIfPreference) { ' (dry run)' } else { '' }

try {
    $null = New-Item -ItemType Directory -Path $ClaudeHome -Force

    foreach ($d in $script:AccountTreeDirs) {
        $n = Copy-PayloadTree -PayloadRoot $PayloadRoot -ClaudeHome $ClaudeHome -Relative $d
        Write-Host "  ${d}: $n files$dryRun"
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
        Write-Host "  hooks/model-tier-gate.ts: from core$dryRun"
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
    Write-Warning $mixedStateWarning
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
    # {{WSL_HOME}} is deliberately absent from this map. Export-Account.ps1 folds a WSL user's
    # $HOME into that token wherever it appears in mcpServers (today, only code-context's
    # launcher), but the other five tokens here all have a receiver-side answer this process can
    # derive from something present on ANY host: $HOME, npm, git, an env var. A receiver's WSL
    # username has none of that; many receivers have no WSL at all, and guessing one (this
    # machine's, or the receiver's Windows username) would make a dead entry look resolved,
    # which is worse than naming it. The residual-token check right after Expand-McpServer below
    # reports it explicitly instead of silently expanding it to something untested.
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
# hook command that cannot run, so it is reported instead of left invisible. The pattern stays
# the general [A-Z_]+ on purpose, not narrowed to Get-AccountTokenMap's five keys, because a
# renamed or mistyped token is by definition not one of the five this script already knows.
#
# F2, final review round: rules/harness-core.md:13 names {{PROJECT}} in prose, inside a markdown
# code span, describing Install-Harness.ps1's own per-project placeholder convention rather than
# anything this script folds. A blanket "skip a backtick-wrapped match" rule was considered and
# rejected: that same file's real {{CORE_REPO}} substitution is ALSO backtick-wrapped at one of
# its occurrences (line 3), so a backtick exemption would carry a blind spot for that exact
# occurrence if a future edit ever made every {{CORE_REPO}} mention backtick-styled -- silent,
# and in the direction a genuine renamed-token warning exists to catch. An exemption keyed to
# the specific known-harmless literal does not touch the general pattern at all.
$script:AccountResidualExemptLiterals = @('{{PROJECT}}')
function Get-ResidualToken {
    param([string]$Text)
    if (-not $Text) { return @() }
    $found = [regex]::Matches($Text, '\{\{[A-Z_]+\}\}') | ForEach-Object { $_.Value } | Select-Object -Unique
    return @($found | Where-Object { $script:AccountResidualExemptLiterals -notcontains $_ })
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
        # Same filter on the payload side. Not reachable through this file's one caller, since
        # Convert-SettingsForTarget already drops a payload group with no surviving hooks before
        # the merge runs, but Merge-HookEvent is a named produced interface, not private to that
        # one call site, so it should not depend on a caller it cannot see to keep it clean.
        foreach ($ph in @(@($pg.hooks) | Where-Object { $_ })) {
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

        if ($name -eq 'statusLine' -or $ev -isnot [System.Management.Automation.PSCustomObject]) {
            # Replaced whole. A deep merge would leave a stale refreshInterval or padding from
            # whatever statusline the receiver had before. The type check catches every other
            # key too: a hand-edited settings.json can hold "hooks": null, "permissions": null,
            # or either one as a string or an array instead of an object. Task 10 review,
            # findings 1 and 2: the hooks/permissions branches below assume $ev has properties to
            # look up, so "hooks": null crashed with "Cannot index into a null array", and
            # "hooks": "nope" or "hooks": [] fed a String or an empty array into Add-Member,
            # which is a silent no-op there, so the payload's own hooks or permissions were
            # dropped with no warning and an exit-0 "settings.json: merged". Nothing below this
            # point can descend into a value that is not an object, so it is replaced instead,
            # the same way the else branch at the bottom already replaces an ordinary scalar.
            #
            # F3, final review round: skipDangerousModePermissionPrompt is the one top-level
            # scalar whose replacement changes what the receiver is protected against, the same
            # class of change as permissions.defaultMode below. Verified live: installing onto a
            # conservative stand-in flipped it from false to true with nothing printed. Not made
            # receiver-wins, since that is the operator's call and is being put to them
            # separately; a warning is correct either way that gets decided.
            if ($name -eq 'skipDangerousModePermissionPrompt' -and $ev -ne $pv) {
                Write-Warning "settings.json: skipDangerousModePermissionPrompt changes from $ev to $pv (the account layer's value overwrites the receiver's own)."
            }
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
                if ($sub -eq 'allow' -or $sub -eq 'deny') {
                    # Ordered set union, receiver entries first, so a receiver's own grants or
                    # denials keep their position and the payload's are appended once.
                    # Where-Object { $_ } on both sides: a receiver's permissions object can be
                    # present but empty ({"permissions":{}}), so $ev.$sub reads as a missing
                    # property (also $null) and @($null) is the same one-element phantom as
                    # above, which without the filter adds a blank entry to the union.
                    #
                    # deny unions the same as allow, not the wholesale replace every other
                    # sub-key gets below. Task 10 review round 2: a receiver's own deny entry is
                    # how an operator locks something off on that machine, and replacing it
                    # wholesale from a payload that does not name it would silently remove a
                    # restriction someone deliberately added. Between the two ways this key can
                    # be wrong, dropping a deny fails in the dangerous direction (loosens
                    # security) and dropping nothing fails in the safe one, so it is unioned.
                    $union = New-Object System.Collections.Generic.List[string]
                    foreach ($a in @(@($ev.$sub) | Where-Object { $_ })) { if (-not $union.Contains($a)) { $union.Add($a) } }
                    foreach ($a in @(@($pv.$sub) | Where-Object { $_ })) { if (-not $union.Contains($a)) { $union.Add($a) } }
                    if ($ev.PSObject.Properties[$sub]) { $ev.$sub = $union.ToArray() }
                    else { $ev | Add-Member -NotePropertyName $sub -NotePropertyValue $union.ToArray() -Force }
                }
                else {
                    # Every other permissions sub-key (defaultMode, and anything not yet
                    # invented) is a scalar or otherwise not a grant/deny list, so there is
                    # nothing to union: replaced wholesale, same as an ordinary settings key.
                    #
                    # F3, final review round: defaultMode governs whether a tool call runs
                    # unattended, so a silent replace here is the same class of change as
                    # skipDangerousModePermissionPrompt above. Verified live: installing onto a
                    # conservative stand-in flipped it from default to auto with nothing printed.
                    # Warned, not made receiver-wins, for the same reason.
                    if ($sub -eq 'defaultMode' -and $ev.PSObject.Properties[$sub] -and $ev.$sub -ne $pv.$sub) {
                        Write-Warning "settings.json: permissions.defaultMode changes from '$($ev.$sub)' to '$($pv.$sub)' (the account layer's value overwrites the receiver's own)."
                    }
                    $ev | Add-Member -NotePropertyName $sub -NotePropertyValue $pv.$sub -Force
                }
            }
        }
        elseif ($pv -is [System.Management.Automation.PSCustomObject] -and $ev -is [System.Management.Automation.PSCustomObject]) {
            # env, enabledPlugins, extraKnownMarketplaces, skillOverrides: payload wins on a
            # shared key, receiver-only keys are kept. The accelerator, not [pscustomobject]:
            # that one resolves to PSObject, which a ConvertFrom-Json string, number or boolean
            # also satisfies at the top level (nested values arrive unwrapped as their real
            # .NET type, so the gap is invisible in ordinary fixtures). The branch above already
            # routes every non-object $ev away before reaching here, so this mainly guards $pv;
            # kept correct rather than provably dead, since a future caller of this function is
            # not bound by today's one call site.
            $Existing.$name = Merge-AccountSettings -Payload $pv -Existing $ev
        }
        else {
            $Existing.$name = $pv
        }
    }
    return $Existing
}

# Shared by both "the existing file cannot be merged" cases below: a parse failure, and a file
# that parses cleanly but is not an object (a bare array, string, or number). Neither is a shape
# Merge-AccountSettings can descend into, and Claude Code could not have made sense of either.
# change-management.md's *.bak.<timestamp> convention, the same one Export-Account.ps1 already
# drops from the exported payload. Gated on ShouldProcess rather than left to Copy-Item alone:
# Task 10 review, finding 7, found the warning claiming a backup under -WhatIf that Copy-Item
# correctly never wrote, so the message itself now depends on whether the operation would
# really run.
function Backup-BrokenSettings {
    param([string]$LiveSettings, [string]$Reason)
    if ($PSCmdlet.ShouldProcess($LiveSettings, 'back up unmergeable settings.json')) {
        $bak = "$LiveSettings.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $LiveSettings -Destination $bak -Force
        Write-Warning "Existing settings.json $Reason. Backed up to '$bak' and installing the payload's settings as the starting point."
    }
    else {
        Write-Warning "Existing settings.json $Reason. Would be backed up and replaced with the payload's settings; re-run without -WhatIf to do it."
    }
}

$settingsSrc = Join-Path $PayloadRoot 'settings.account.json'
if (Test-Path -LiteralPath $settingsSrc) {
    # Task 10 review: a failure anywhere in this block (a lock on settings.json, or any
    # unanticipated shape past the two handled explicitly below) used to throw past every catch
    # in the script, since Task 8's catch above only wraps the tree copy. The merge writes
    # settings.json after that copy has already run, so a failure here leaves the same
    # half-installed $ClaudeHome, just later in the run; it gets the same warning and the same
    # re-throw instead of surfacing as a bare, unexplained exception.
    try {
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
                Backup-BrokenSettings -LiveSettings $liveSettings `
                    -Reason "is not valid JSON: $($_.Exception.Message)"
            }
        }
        if ($null -ne $existing -and $existing -isnot [System.Management.Automation.PSCustomObject]) {
            # A receiver's settings.json that parses cleanly to a bare array, string, or number
            # (`[1,2,3]`, `"hello"`, `42`) is just as far from a mergeable shape as the
            # unparseable case above, and the worst measured outcome was silent: a bare string
            # gets written back byte for byte, with no warning, at exit 0, dropping the entire
            # payload.
            $kind = if ($existing -is [string]) { 'a string value' }
            elseif ($existing -is [array]) { 'an array' }
            else { "a $($existing.GetType().Name) value" }
            Backup-BrokenSettings -LiveSettings $liveSettings -Reason "parses to $kind, not a JSON object"
            $existing = $null
        }
        # Scanned against the payload alone, not the merged result: the warning below claims a
        # hook command from THIS install carries an unexpanded token, which is only true of
        # content this install itself wrote. Task 10 review round 2, finding D: scanning the
        # merged output picked up a receiver's own pre-existing {{TOKEN}}-shaped content too
        # (their own convention, or coincidence), which this install never touched and has no
        # substitution for, firing a warning that wrongly blames the merge for it. $payloadSettings
        # is already fully resolved by Convert-SettingsForTarget at this point, so this checks
        # exactly what the install controls.
        $residual = Get-ResidualToken -Text ($payloadSettings | ConvertTo-Json -Depth 20)
        if ($residual.Count -gt 0) {
            Write-Warning "Unexpanded placeholder(s) in settings.json: $($residual -join ', '). Left verbatim; a hook command carrying one cannot run."
        }
        $merged = Merge-AccountSettings -Payload $payloadSettings -Existing $existing
        $settingsJson = $merged | ConvertTo-Json -Depth 20
        $settingsJson | Set-Content -LiteralPath $liveSettings -Encoding utf8
        Write-Host "  settings.json: merged$dryRun"
    }
    catch {
        Write-Warning $mixedStateWarning
        throw
    }
}

# --- mcpServers --------------------------------------------------------------
# Add-if-missing, receiver wins on an existing entry. Payload-wins would loop with shipping
# 1password and code-context as-is: the receiver hand-fixes those two, the next pull reverts
# them, and settings.local.json cannot reach ~/.claude.json to hold the fix. Nothing else in
# that file is touched.
# Expansion is its own pass over every server, run before the merge. Doing it inside the merge
# loop would expand only the servers that get added, because the loop skips the ones the
# receiver already has, and the residual report below reads the same object: an unexpanded
# {{CLAUDE_HOME}} would then be reported as a source-machine path on every receiver that
# already had that server.
function Expand-McpServer {
    param([pscustomobject]$Servers, [hashtable]$Tokens)
    if (-not $Servers) { return $Servers }
    foreach ($name in @($Servers.PSObject.Properties.Name | Where-Object { $_ })) {
        $srv = $Servers.$name
        if ($srv.command) { $srv.command = Expand-AccountToken -Text $srv.command -Tokens $Tokens }
        if ($null -ne $srv.args) {
            $srv.args = @(@($srv.args) | ForEach-Object { Expand-AccountToken -Text $_ -Tokens $Tokens })
        }
        if ($srv.env) {
            # Where-Object { $_ }: an mcpServers entry with "env": {} (every fixture below ships
            # one) makes .PSObject.Properties.Name $null, and @($null) is a ONE-element array
            # holding $null, not an empty one. Unfiltered, the loop ran once with $k = $null and
            # $srv.env.$null = ... is a property SET with a null name, which throws
            # (SetValueInvocationException: "the value of argument 'name' is not valid"),
            # terminating the whole install on the first server carrying an empty env object.
            # Reproduced against this exact shape before adding the filter.
            foreach ($k in @($srv.env.PSObject.Properties.Name | Where-Object { $_ })) {
                $srv.env.$k = Expand-AccountToken -Text $srv.env.$k -Tokens $Tokens
            }
        }
    }
    return $Servers
}

function Merge-McpServer {
    param([pscustomobject]$PayloadServers, [string]$ClaudeJsonPath)
    $added = @()
    if (-not $PayloadServers) { return $added }

    $doc = if (Test-Path -LiteralPath $ClaudeJsonPath) {
        Get-Content -LiteralPath $ClaudeJsonPath -Raw | ConvertFrom-Json
    }
    else { [pscustomobject]@{} }
    if ($doc.PSObject.Properties['mcpServers'] -and
        $doc.mcpServers -isnot [System.Management.Automation.PSCustomObject]) {
        # Review F7: a receiver's claude.json can carry "mcpServers":"oops" or ":[1,2]" (external
        # corruption, or Claude Code writing partway through a crash). Add-Member on a retrieved
        # string or array is a silent no-op that never touches $doc.mcpServers itself, so the
        # loop below found nothing to skip, "added" every payload server by its own count, and
        # the install printed a success message for a merge that changed nothing on disk. Task
        # 10 handles the parallel shape mismatch for settings.json one file over; same handling
        # here, warn and start from empty rather than silently drop the payload.
        # Review F14: an explicit "mcpServers": null in the existing file is not a
        # [pscustomobject], same as the string and array cases above, but it has no .GetType()
        # to call: $doc.mcpServers is $null itself, and a method call on $null throws
        # "You cannot call a method on a null-valued expression". Not a regression introduced
        # here; the reviewer traced the same shape crashing one guard clause later, at
        # $doc.mcpServers.PSObject.Properties[$name] in the merge loop, before this guard
        # existed. This is the one shape that guard still missed.
        $kind = if ($null -eq $doc.mcpServers) { 'null' }
        elseif ($doc.mcpServers -is [string]) { 'a string value' }
        elseif ($doc.mcpServers -is [array]) { 'an array' }
        else { "a $($doc.mcpServers.GetType().Name) value" }
        Write-Warning "Existing mcpServers in claude.json is $kind, not a JSON object. Replacing it with an empty object before merging; whatever it held is lost."
        $doc.mcpServers = [pscustomobject]@{}
    }
    if (-not $doc.PSObject.Properties['mcpServers']) {
        $doc | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    foreach ($name in @($PayloadServers.PSObject.Properties.Name | Where-Object { $_ })) {
        if ($doc.mcpServers.PSObject.Properties[$name]) { continue }
        $doc.mcpServers | Add-Member -NotePropertyName $name -NotePropertyValue $PayloadServers.$name -Force
        $added += $name
    }

    # Review F5: gated on there being something to add. Claude Code rewrites this file
    # continuously while it runs, so an unconditional read-modify-write here is a lost-update
    # race against the operator's live session on every install, not only on ones that change
    # something. A run that adds nothing (every mcpServers entry the payload names already
    # exists) has nothing worth that window, and leaves claude.json uncreated on a fresh
    # -ClaudeJson if the payload's own mcpServers is empty, which is the same "nothing to do"
    # case rather than a new one.
    if ($added.Count -gt 0) {
        $doc | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ClaudeJsonPath -Encoding utf8
    }
    return @($added)
}

$mcpSrc = Join-Path $PayloadRoot 'mcp-servers.json'
if (Test-Path -LiteralPath $mcpSrc) {
    # Same reasoning and placement as the settings-merge try/catch above: this writes
    # -ClaudeJson after the tree copy and settings merge have already run, so a failure here
    # leaves $ClaudeHome (and now -ClaudeJson) in the same mixed state, just later in the run.
    try {
        $payloadServers = Expand-McpServer -Tokens $tokens `
            -Servers ((Get-Content -LiteralPath $mcpSrc -Raw | ConvertFrom-Json).mcpServers)
        # {{WSL_HOME}} has no entry in $tokens (Get-AccountTokenMap says why), so it survives
        # Expand-McpServer verbatim on the one entry the exporter folds it into today,
        # code-context's WSL launcher. The residual-path report further down still catches the
        # dead path this leaves behind, but only as a truncated fragment after the token -- the
        # regex there is path-shaped, not token-aware, and stops matching at the { that starts
        # the placeholder. This check names the actual token directly, on the same fields
        # Expand-McpServer just walked, so an operator sees the real cause instead of only a
        # partial path.
        $mcpResidual = @()
        if ($payloadServers) {
            foreach ($name in @($payloadServers.PSObject.Properties.Name | Where-Object { $_ })) {
                $srv = $payloadServers.$name
                $mcpResidual += Get-ResidualToken -Text $srv.command
                foreach ($a in @($srv.args)) { $mcpResidual += Get-ResidualToken -Text $a }
                if ($srv.env) {
                    foreach ($k in @($srv.env.PSObject.Properties.Name | Where-Object { $_ })) {
                        $mcpResidual += Get-ResidualToken -Text $srv.env.$k
                    }
                }
            }
        }
        $mcpResidual = @($mcpResidual | Select-Object -Unique)
        if ($mcpResidual.Count -gt 0) {
            Write-Warning "Unexpanded placeholder(s) in mcpServers: $($mcpResidual -join ', '). Left verbatim; this entry cannot run as shipped on this host."
        }
        $added = @(Merge-McpServer -PayloadServers $payloadServers -ClaudeJsonPath $ClaudeJson)
        # Review F8: the count is computed before Merge-McpServer's own gated Set-Content, so it
        # is a prediction under -WhatIf, not a report of what landed on disk. House style, per
        # Task 10's own equivalent ("under -WhatIf, does not claim a backup it never made"), is
        # to say so rather than let it read as a claim. $dryRun itself is now hoisted to script
        # scope, alongside $mixedStateWarning, and reused by every status line in this file.
        Write-Host "  mcpServers: $($added.Count) added$(if ($added.Count) { " ($($added -join ', '))" })$dryRun"
    }
    catch {
        Write-Warning $mixedStateWarning
        throw
    }
}

# --- residual report ---------------------------------------------------------
# No settings rewrite can reach a path baked into a Store filename or a WSL user's home, so the
# honest move is to name them rather than pretend a placeholder covers them.
#
# The test is "carries an absolute path that does not exist here", not Test-ResidualWindowsPath
# alone. That function answers a different question, and the design's own acceptance criterion
# ("names 1password and code-context; anything else it names is an exporter bug") cannot hold
# under it in either direction. On a Windows receiver every correctly expanded command carries a
# drive letter, so a drive-letter rule reports all of them and the report stops meaning
# anything. And it never fires on code-context's `wsl -e /home/wsluser/code-context-mcp.sh`, which
# has no drive letter and no USERPROFILE, so one of the two entries the report exists to name is
# invisible to it. Test-ResidualWindowsPath is kept as the classifier on the printed line, which
# is what tells the operator whether a dead path is Windows-shaped.
function Get-UnresolvedPath {
    param([string]$Text)
    $out = @()
    if (-not $Text) { return $out }
    # A drive-letter path or a POSIX-rooted one, stopping at a quote or whitespace. Flags like
    # -NoProfile and bare command names carry no leading separator and are never matched.
    #
    # Both branches are anchored (review F1). Unanchored, the drive-letter branch matches the
    # tail of a URL scheme: in "git+https://github.com/...", the "s" in "https" satisfies
    # [A-Za-z], and the "://" that follows reads as the drive separator, so the match runs on as
    # "s://github.com/...". Test-Path on that returns $false (no throw; drive s: simply does not
    # resolve), so a real server carrying a git+https install command -- garmin, on this machine
    # -- was reported as a source-machine path, though it is not one. The negative lookbehind
    # rejects a drive letter preceded by a word character, "+", "." or "-", which a URL scheme
    # always is. The POSIX branch gets the matching guard for "//host/..." inside a URL for the
    # same reason, rejecting a "/" preceded by ":", "/" or a word character.
    foreach ($m in [regex]::Matches($Text, '(?:(?<![\w+.\-])[A-Za-z]:[\\/]|(?<![:/\w])/)[^"''\s]*')) {
        $p = $m.Value.TrimEnd(',', ';', ')')
        # A UNC-shaped candidate ("//host/share/...") is skipped before Test-Path rather than
        # tested: Test-Path against a host that does not resolve stalls for several seconds on
        # name resolution before returning $false (review F9, measured at 11.5s), which reads as
        # a hung install rather than a completed one. Trades away detecting a genuine UNC
        # residual, which no entry on this machine carries.
        if ($p -match '^//[^/]') { continue }
        if ($p -and -not (Test-Path -LiteralPath $p)) { $out += $p }
    }
    return @($out)
}

function Get-ResidualCommand {
    param([pscustomobject]$Settings, [pscustomobject]$Servers)
    $found = @()

    function Add-IfDead {
        param([string]$Where, [string]$Command, [string]$Whole, [System.Collections.IList]$Into)
        $dead = @(Get-UnresolvedPath -Text $Command)
        # $Whole (review F6): mcpServers builds $Command by joining $srv.command and its args
        # with plain spaces, unquoted, so Get-UnresolvedPath's regex stops at the first internal
        # space. A genuine, space-containing rooted path -- 1password's Store path, on this
        # machine -- truncates to the text before the space (e.g. "C:\Program" out of
        # "C:\Program Files\...\onepassword-mcp.exe") before Test-Path ever sees it, and the
        # verdict then hangs on whether that unrelated fragment happens to exist rather than on
        # the real path. Only mcpServers passes $Whole: hooks and statusLine commands are single
        # shell strings the regex already scans correctly (a hook path is single-quoted, which
        # bounds it without help).
        if ($Whole -and $Whole -match '^(?:[A-Za-z]:[\\/]|/)' -and $Whole -notmatch '^//[^/]') {
            # Drop whatever truncated fragment of $Whole the regex above already found -- it is
            # the same defect, not a second one -- before testing the real, untruncated path.
            # Same UNC skip as Get-UnresolvedPath above: $Whole reaches Test-Path directly here,
            # so it needs its own guard rather than inheriting the one inside that function's loop.
            $dead = @($dead | Where-Object { -not $Whole.StartsWith($_) })
            if (-not (Test-Path -LiteralPath $Whole) -and $dead -notcontains $Whole) { $dead += $Whole }
        }
        if ($dead.Count -eq 0) { return }
        $shape = if (Test-ResidualWindowsPath $Command) { 'Windows-shaped' } else { 'POSIX-shaped' }
        $Into.Add([pscustomobject]@{
                Where = $Where; Command = $Command; Dead = ($dead -join ', '); Shape = $shape
            })
    }

    $list = New-Object System.Collections.Generic.List[pscustomobject]
    # Where-Object { $_ } at all three levels, matching Convert-SettingsForTarget's identical
    # walk over $Settings.hooks above: an empty hooks object (every fixture that reaches this
    # function ships one) makes .PSObject.Properties.Name $null and @($null) a one-element
    # array holding $null. Currently harmless here specifically because Add-IfDead's own
    # Get-UnresolvedPath returns @() for a falsy $Command, so the phantom iteration this produced
    # unfiltered was a silent no-op rather than a wrong report line -- verified by removing the
    # filters and re-running rather than assumed. Filtered anyway, so a future change to either
    # of those two functions cannot turn a currently-inert phantom iteration into a live bug.
    foreach ($event in @($Settings.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
        foreach ($g in @(@($Settings.hooks.$event) | Where-Object { $_ })) {
            foreach ($x in @(@($g.hooks) | Where-Object { $_ })) { Add-IfDead -Where "hooks.$event" -Command $x.command -Into $list }
        }
    }
    if ($Settings.statusLine.command) {
        Add-IfDead -Where 'statusLine' -Command $Settings.statusLine.command -Into $list
    }
    foreach ($name in @($Servers.PSObject.Properties.Name | Where-Object { $_ })) {
        $srv = $Servers.$name
        # One line per server, not one per string: two dead args on one entry are one problem.
        $joined = (@($srv.command) + @($srv.args)) -join ' '
        Add-IfDead -Where "mcpServers.$name" -Command $joined -Whole $srv.command -Into $list
    }
    $found = @($list.ToArray())
    return $found
}

# Both halves of this report read the INSTALLED state, never the payload: settings.json as it
# now sits under $ClaudeHome, and mcpServers as they now sit in -ClaudeJson. One source, so the
# report says what is on this machine rather than half of that and half of what shipped.
# Reading the payload's servers instead would re-name 1password and code-context on every
# install after the receiver hand-fixed them, and preserving that hand-fix is the whole reason
# the merge above is add-if-missing.
#
# Both reads are wrapped: under -WhatIf a pre-existing, unparseable settings.json is left
# exactly as it was, since Set-Content's own ShouldProcess check skips the write that would
# otherwise have replaced it (Backup-BrokenSettings already warned about the same file during
# the merge above). Reproduced: "under -WhatIf, does not claim a backup it never made" crashed
# here with a raw JsonReaderException before this try/catch existed, reading the same malformed
# text a second time. Scanning malformed JSON for residual paths is not a meaning that exists,
# so this falls back to "nothing to scan" instead of taking the whole dry run down with it.
$liveForReport = Join-Path $ClaudeHome 'settings.json'
$reportSettings = [pscustomobject]@{ hooks = [pscustomobject]@{} }
if (Test-Path -LiteralPath $liveForReport) {
    try { $reportSettings = Get-Content -LiteralPath $liveForReport -Raw | ConvertFrom-Json }
    catch { }
}

$reportServers = $null
if (Test-Path -LiteralPath $ClaudeJson) {
    try { $reportServers = (Get-Content -LiteralPath $ClaudeJson -Raw | ConvertFrom-Json).mcpServers }
    catch { }
}

$residuals = @(Get-ResidualCommand -Settings $reportSettings -Servers $reportServers)
if ($residuals.Count -gt 0) {
    Write-Host ''
    Write-Host 'Still carrying a source-machine path, and no settings rewrite can reach them:'
    foreach ($r in $residuals) {
        Write-Host "  $($r.Where) [$($r.Shape)]: $($r.Command)"
        Write-Host "    does not exist here: $($r.Dead)"
    }
    Write-Host 'Expected here: mcpServers.1password (a Store path with an embedded version) and mcpServers.code-context (a WSL launcher into another user home). Anything else on this list is an exporter bug.'
}
# F4, final review round: unlike the status lines above, "Install complete" is not a report that
# can be softened with a "(dry run)" suffix; it claims the whole run finished. Full gate, not a
# suffix, matching Export-Account.ps1's own "Export complete" guard.
if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host 'Install complete. Restart Claude Code to pick up the new settings.'
}
