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

.PARAMETER WslHome
    The literal folded into {{WSL_HOME}} wherever it appears in mcpServers (today, only
    code-context's launcher). Defaults to the default WSL distro's $HOME via
    `wsl -e sh -c 'echo $HOME'`, or $null if wsl is not on PATH. Unlike the other five tokens
    this one has no receiver-side answer: Install-Account.ps1's Get-AccountTokenMap leaves
    {{WSL_HOME}} unexpanded on purpose, since a receiver may have no WSL at all and guessing a
    username would make a dead entry look resolved.

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

$null = New-Item -ItemType Directory -Path $OutputRoot -Force

foreach ($d in $script:AccountTreeDirs) {
    $n = Copy-AccountTree -SourceRoot $ClaudeHome -DestRoot $OutputRoot `
        -Relative $d -SkipRelative $script:AccountSkipFiles -SkipDirs $script:AccountSkipDirs
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
# from $HOME, {{WSL_HOME}} is `wsl -e sh -c 'echo $HOME'`. Order is immaterial: no literal
# contains another, since the npm path and the vault both sit under the bare home rather than
# under .claude, and the slug shares no characters with any path spelling. {{WSL_HOME}} is the
# sixth and needs its own reason: it is POSIX-rooted (`/home/<user>`), and the other four paths
# are all Windows-rooted (`C:\...` or `E:\...`). No Windows-side literal can contain a
# `/`-rooted string as a substring and no POSIX-side literal can contain a drive letter, so the
# two families cannot collide regardless of the actual usernames or paths on either side.
function Get-AccountFoldTable {
    param(
        [string]$ClaudeHome,
        [string]$NpmGlobal,
        [string]$WslHome,
        [string]$CoreRepo,
        [string]$VaultPath,
        [string]$HomeSlug
    )
    return @(
        [pscustomobject]@{ Token = '{{CLAUDE_HOME}}';    Literal = $ClaudeHome; IsPath = $true }
        [pscustomobject]@{ Token = '{{NPM_GLOBAL}}';     Literal = $NpmGlobal;  IsPath = $true }
        [pscustomobject]@{ Token = '{{WSL_HOME}}';       Literal = $WslHome;    IsPath = $true }
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
        Write-Host '  settings.account.json: written'
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
        Set-Content -LiteralPath $target -Value $text -NoNewline
        Write-Host "  ${rel}: folded $substituted of $(@($rowFolds).Count) token(s)"
    }
}

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
                    # separately. Scanning the actual post-fold string for the one shape that must
                    # never survive a successful fold -- a bare /home/<user> segment -- covers all
                    # of those at once, and reuses the same scan-and-throw shape the secret gate
                    # right above already established, rather than adding a second kind of gate.
                    if ($s -match '/home/[^/"''\s]+') {
                        throw "Refusing to export mcpServers entry '$name': carries an unfolded WSL home path ('$($Matches[0])'). -WslHome did not resolve (wsl absent, the distro stopped, or an empty override) so the fold could not apply; pass a real -WslHome, or fix the account layer's WSL entry, before exporting."
                    }
                }
            }

            [pscustomobject]@{ mcpServers = $servers } | ConvertTo-Json -Depth 20 |
                Set-Content -LiteralPath (Join-Path $OutputRoot 'mcp-servers.json') -Encoding utf8
            Write-Host "  mcp-servers.json: $(@($serverNames).Count) server(s)"
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
    Write-Host "Export complete. Review with: git status account/claude"
}
