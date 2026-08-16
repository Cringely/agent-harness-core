<#
.SYNOPSIS
    Restores an exported Claude Code project onto a Windows or Linux machine.

.DESCRIPTION
    Moves a project between machines: the repo itself, the Claude Code session history, and the
    global config layer under ~/.claude. Handles the two things that quietly go wrong.

    The first is the session folder name. Claude Code stores a project's transcripts under
    ~/.claude/projects/<slug>, where the slug is derived from the repo's absolute path. Copy the
    sessions to the wrong name and everything looks healthy while --resume reports nothing. This
    script derives the slug from wherever the repo actually lands.

    The second is hooks. Hook commands in settings.json carry absolute paths from the source
    machine, and on Linux the command string goes to /bin/sh rather than to a PowerShell host, so
    '& script.ps1' never runs. With -IncludeHooks the script repoints the paths and rewrites the
    invocation, then reports which hooks still carry source-machine paths inside the script body,
    since no settings rewrite can reach those.

    Runs under PowerShell 7 on either platform, and under Windows PowerShell 5.1 on Windows.

    Expects a bundle laid out as:
        repo/                       the working repo, including .git
        claude-project/             contents of ~/.claude/projects/<slug> on the source machine
        claude-global/              rules, agents, skills, plugins, tools, hooks
        claude-global/settings.json.exported

    Refuses to write into a non-empty repo destination unless -Force is given, and never
    overwrites an existing settings.json; a rewritten copy lands beside it for you to merge.

.PARAMETER Source
    The unzipped export folder. Must contain repo, claude-project, and claude-global.

.PARAMETER RepoPath
    Where the repo goes. Matching the source machine's path exactly reproduces the original
    session folder name and skips any slug guesswork.

.PARAMETER Slug
    Override the derived session folder name. Use only if you have confirmed the real name by
    running claude once in the repo and checking ~/.claude/projects.

.PARAMETER SourceHome
    The source machine's .claude directory, used to find and replace paths in hook commands.
    Auto-detected from settings.json.exported when omitted.

.PARAMETER ClaudeHome
    Override the Claude config root. Defaults to $HOME/.claude. Mainly useful for a dry run into
    a scratch directory before touching the real profile.

.PARAMETER Force
    Proceed even though the repo destination already exists and holds files, overwriting on
    collision. Without it the script stops rather than merging into an existing checkout.

.PARAMETER IncludeHooks
    Also restore the hooks directory and produce a rewritten settings.json. Off by default,
    because most hooks need hand-editing before they work on a new machine.

.PARAMETER TargetIsWindows
    Which platform the restore is being prepared for. Defaults to the platform actually running,
    and a real run should never pass it. It exists so the tests can reach the Linux-only branches
    from a Windows host. Test-only, and named-only: it holds no position, so it can never be set by
    a stray extra positional argument.

.EXAMPLE
    ./Restore-ClaudeProject.ps1 -Source ~/Downloads/export -RepoPath C:\temp\myproject -WhatIf

.EXAMPLE
    pwsh ./Restore-ClaudeProject.ps1 -Source ~/Downloads/export -RepoPath ~/myproject -IncludeHooks
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # Positions are declared explicitly, and that is load-bearing rather than cosmetic. PowerShell
    # auto-assigns a position to every non-switch parameter that lacks one, in declaration order, so
    # the $TargetIsWindows test seam below silently became positional slot 5. A sixth positional
    # argument used to be a binding error; it would instead have set the target platform and let the
    # script run to a wrong result at exit 0. Naming positions here stops the auto-assignment for
    # every parameter that does not declare one, which makes the seam named-only. The values below
    # reproduce the pre-seam mapping exactly. Do not use PositionalBinding=$false instead: that would
    # make -Source and -RepoPath named-only and break existing callers.
    [Parameter(Mandatory, Position = 0)][string]$Source,
    [Parameter(Mandatory, Position = 1)][string]$RepoPath,
    [Parameter(Position = 2)][string]$Slug,
    [Parameter(Position = 3)][string]$SourceHome,
    [Parameter(Position = 4)][string]$ClaudeHome,
    [switch]$IncludeHooks,
    [switch]$Force,

    # Test seam. Everything platform-specific below reads this rather than $IsWindows directly, so
    # a test on a Windows host can drive the Linux branches. It defaults to the running platform,
    # so a real run behaves exactly as it did before this parameter existed. Without the seam the
    # residual-path report in step 6 was unreachable from any test on Windows and the repo runs no
    # Linux CI, which left that whole branch shipping with nothing exercising it.
    #
    # $IsWindows is undefined on Windows PowerShell 5.1, where the answer is always Windows.
    [bool]$TargetIsWindows = $(if ($PSVersionTable.PSVersion.Major -lt 6) { $true } else { $IsWindows })
)

$ErrorActionPreference = 'Stop'

$onWindows = $TargetIsWindows
if (-not $ClaudeHome) { $ClaudeHome = Join-Path $HOME '.claude' }

# Resolve -RepoPath to an absolute path before anything reads it. Step 1's copy is
# ShouldProcess-gated, so under -WhatIf the directory is never created, and the step 2 branch that
# handles a not-yet-existing destination fell through to whatever string was passed in. A relative
# one then produced a preview slug derived from 'myrepo' instead of from where the repo would
# actually land, which is the one thing -WhatIf exists to show.
#
# GetUnresolvedProviderPathFromPSPath rather than [System.IO.Path]::GetFullPath: it expands '~',
# which the ~/myproject example in the header relies on, and it resolves a relative path against
# PowerShell's current location, which Set-Location moves and the process working directory that
# GetFullPath reads does not.
$RepoPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RepoPath)

$Source = (Resolve-Path $Source).Path
foreach ($required in 'repo', 'claude-project', 'claude-global') {
    if (-not (Test-Path (Join-Path $Source $required))) {
        throw "Source is missing '$required'. Point -Source at the unzipped export root."
    }
}

function Copy-Tree {
    param([string]$From, [string]$To)
    if (-not (Test-Path $From)) { Write-Verbose "absent, skipping: $From"; return 0 }
    if (-not (Test-Path $To)) { $null = New-Item -ItemType Directory -Path $To -Force }

    # Enumerate with -Force and copy each child by literal path. A 'dir\*' wildcard silently skips
    # hidden entries on Windows, which drops .git and leaves a repo with no history. Copy-Item
    # -Force is required on the way in too, because git object files are read-only.
    $items = @(Get-ChildItem $From -Force)
    if (-not $items) { return 0 }
    foreach ($item in $items) {
        Copy-Item -LiteralPath $item.FullName -Destination $To -Recurse -Force
    }
    return @(Get-ChildItem $To -Recurse -File -Force).Count
}

# Claude Code names a project folder by replacing every non-alphanumeric character in the repo's
# absolute path with a hyphen. Verified against C--temp-GHAS-GHASalerts, C--Users-jcgam, and
# E--projects-ONI--onimods-upstream. A hyphenated form over 200 characters is truncated to 200
# chars plus a hyphen and a base-36 hash of the untruncated path. Extracted from the r0()/Nat()
# functions in the installed claude-code bundle (~/.local/share/claude/versions/2.1.222) and
# cross-checked against that exact algorithm running under node for paths past the 200-char cut;
# Nat() is a Java-style string hash: the source is (t<<5)-t+charCode|0, which is (t*31+charCode)
# wrapped to signed 32-bit each step, since a left-shift by 5 mod 2^32 is multiplication by 32.
#
# -creplace, not -replace: PowerShell's -replace is case-insensitive by default, and .NET's
# IgnoreCase regex folds some non-ASCII characters onto ASCII ones outside the class -- U+212A
# KELVIN SIGN folds to 'k' -- so '[^A-Za-z0-9]' silently let it through unreplaced. Claude Code's
# JS regex has no /i flag and is ordinal, so it always replaces such characters.
function Get-ProjectSlug {
    param([string]$Path)
    $trimmed = $Path.TrimEnd('\', '/')
    $slug = $trimmed -creplace '[^A-Za-z0-9]', '-'
    if ($slug.Length -le 200) { return $slug }

    [int64]$hash = 0
    foreach ($ch in $trimmed.ToCharArray()) {
        $hash = ($hash * 31 + [int64][char]$ch) -band 0xFFFFFFFFL
        if ($hash -ge 0x80000000L) { $hash -= 0x100000000L }
    }
    $digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    $n = [Math]::Abs($hash)
    $base36 = if ($n -eq 0) { '0' } else { '' }
    while ($n -gt 0) {
        $base36 = $digits[$n % 36] + $base36
        $n = [Math]::Floor($n / 36)
    }
    return "$($slug.Substring(0, 200))-$base36"
}

function Get-SourceHome {
    param([string]$SettingsPath)
    if (-not (Test-Path $SettingsPath)) { return $null }
    $raw = Get-Content $SettingsPath -Raw
    $m = [regex]::Match($raw, '(?<h>[A-Za-z]:(?:\\\\|/)(?:[^"\\/]+(?:\\\\|/))*?\.claude)')
    if ($m.Success) { return $m.Groups['h'].Value -replace '\\\\', '\' }
    return $null
}

# One definition of "this string still names a source-machine path", shared by the hook script-body
# scan and the settings.json command scan in step 6, so the two cannot drift apart.
function Test-ResidualWindowsPath {
    param([string]$Text)
    if (-not $Text) { return $false }
    return ($Text -match '[A-Za-z]:[\\/]') -or ($Text -match 'USERPROFILE')
}

function Convert-HookCommand {
    param([string]$Command, [string]$OldHome, [string]$NewHome, [bool]$TargetIsWindows)

    # Match both C:\Users\me\.claude and C:/Users/me/.claude spellings.
    $homePattern = [regex]::Escape($OldHome) -replace '\\\\', '[\\\\/]'

    if ($TargetIsWindows) {
        # '$' is a group reference in a -replace replacement string; double it to keep it literal.
        return $Command -replace $homePattern, $NewHome.Replace('$', '$$')
    }

    # Rewrite $OldHome and whatever path continues past it (e.g. \hooks\Lint.ps1) in one pass, so
    # a full source-machine path ends up forward-slashed. The match always starts at the known
    # $OldHome text, never at a bare backslash, so an unrelated backslash elsewhere in the command
    # -- e.g. inside a sed expression sharing the string, or a wholly separate Windows path like
    # C:\tools\foo.exe -- is never touched. That separate path stays backslash-spelled and just as
    # broken on Linux either way, so leaving it alone costs nothing; a blanket backslash-to-slash
    # replace over the whole command corrupted the sed case for no corresponding gain. This
    # description covers the Linux branch only: the Windows branch just above has no boundary or
    # quote handling at all, since Windows tolerates both separators and that behavior predates
    # this function.
    #
    # Two branches, because a path continuation must stop at different places depending on
    # whether it's quoted: a quoted path (the common case for anything that can contain a space,
    # e.g. 'My Hooks\run.ps1') runs up to its closing quote and may contain spaces; a bare path
    # has no quote to bound it and must stop at the first space instead, or it swallows whatever
    # shell token follows. Either way, a boundary assertion right after $OldHome requires the next
    # character to be a separator, quote, space, a handful of common shell metacharacters
    # (; , ) & | < >), or end of string, so a sibling directory that merely shares $OldHome as a
    # text prefix (.claude-backup, .claude.bak) is left alone entirely rather than half-rewritten,
    # while a bare path followed by e.g. a semicolon (cd C:\...\.claude; pwsh ...) still terminates
    # and gets rewritten. That allowlist is deliberately short, not exhaustive: a denylist keyed on
    # "could the next character continue an identifier" was tried and reverted, because '.' isn't
    # an identifier character either, and it silently rewrote .claude.bak as though it were
    # .claude. Most punctuation is simply uncovered here, which fails safe -- it leaves a visible,
    # unconverted Windows path rather than emitting a plausible wrong one.
    #
    # A path merely sitting inside a wider quoted string, e.g. sh -c 'pwsh C:\...\My Hooks\run.ps1',
    # is a known, deliberately unfixed limitation: the quoted branch only recognizes a quote
    # immediately before $OldHome, so this case falls to the bare branch and keeps one backslash
    # after the first space. Tracking quoted regions to close this was tried and reverted: letting
    # a match's tail run to the enclosing quote's close also extends it across any unrelated
    # backslash sharing that quoted region, corrupting things like a sed expression in the same
    # command. A half-converted path beats a corrupted sed expression.
    $newHomeSlashed = $NewHome.Replace('\', '/')
    $boundary = '(?=[\\/]|[''"]|\s|[;,)&|<>]|$)'
    $quotedBranch = '(?<=(?<qa>[''"]))' + $homePattern + $boundary + '(?:(?!\k<qa>).)*'
    $bareBranch = $homePattern + $boundary + '(?:[\\/][^''"\s]*)*'
    $out = [regex]::Replace($Command, $quotedBranch + '|' + $bareBranch, {
        param($m)
        $tail = $m.Value.Substring($OldHome.Length).Replace('\', '/')
        "$newHomeSlashed$tail"
    })

    # '& script.ps1' assumes a PowerShell host. On Linux the hook string goes to /bin/sh,
    # which needs pwsh invoked explicitly.
    if ($out -match "^\s*&\s*['""](?<p>[^'""]+\.ps1)['""](?<rest>.*)$") {
        $out = "pwsh -NoProfile -File '$($Matches.p)'$($Matches.rest)"
    }
    return $out
}

if ((Test-Path $RepoPath) -and @(Get-ChildItem $RepoPath -Force -ErrorAction SilentlyContinue) -and -not $Force) {
    throw "$RepoPath already exists and is not empty. Re-run with -Force to overwrite it, or pick a different -RepoPath."
}

Write-Host "Target platform : $(if ($onWindows) {'Windows'} else {'Linux'})"
Write-Host "Repo            : $RepoPath"

# --- 1. repo -----------------------------------------------------------------
if ($PSCmdlet.ShouldProcess($RepoPath, 'restore repo')) {
    $n = Copy-Tree (Join-Path $Source 'repo') $RepoPath
    Write-Host "  repo files restored: $n"
}

# A repo's own .claude/hooks runs on every restore, wired in via core.hooksPath, independent of
# -IncludeHooks (which only governs the separate ~/.claude/hooks restore in step 5 below). Zip
# extraction commonly drops the Unix execute bit, and git hook filenames (pre-commit, pre-push,
# ...) carry no extension, so this can't reuse the *.sh filter further down either; git silently
# skips a non-executable hook rather than failing the commit, which is what makes this a producer
# fix rather than a nice-to-have.
#
# Scoped to exactly what the bundle's repo/.claude/hooks holds, not to whatever the destination
# directory happens to contain: enumerating the destination would also chmod a file left over from
# an earlier restore that this run never touched. Top-level only, no -Recurse, since git hooks are
# never nested; filtered to extension-less names or *.sh, since a hook directory can otherwise
# carry ordinary tracked files (README.md, a .ts hook meant to run through an interpreter, ...)
# that have no business being marked executable.
if (-not $onWindows -and (Test-Path $RepoPath)) {
    $sourceHooks = Join-Path $Source 'repo/.claude/hooks'
    $repoHooks = @(Get-ChildItem $sourceHooks -File -ErrorAction SilentlyContinue |
        Where-Object { -not $_.Extension -or $_.Extension -eq '.sh' })
    $made = 0
    foreach ($h in $repoHooks) {
        $dest = Join-Path $RepoPath ".claude/hooks/$($h.Name)"
        if ((Test-Path $dest) -and $PSCmdlet.ShouldProcess($dest, 'chmod +x')) {
            & chmod +x $dest
            if ($LASTEXITCODE -eq 0) { $made++ }
        }
    }
    if ($made) { Write-Host "  made $made repo hook(s) executable" }
}

# --- 1b. git core.hooksPath --------------------------------------------------
# .git/config is copied byte for byte, so core.hooksPath still names the source machine's
# .claude/hooks. Git skips a hooks directory that does not exist without saying anything, so the
# symptom is a repo whose pre-commit hook stops running after the move and nothing reports why.
# Like the chmod pass above, this concerns the repo's own hooks and runs on every restore,
# independent of -IncludeHooks.
#
# Repointed only when the recorded directory has gone missing and this repo carries a .claude/hooks
# of its own, so a project that deliberately points core.hooksPath at something else that still
# exists keeps it. Mirrors the wiring block in Install-Harness.ps1.
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd -and (Test-Path $RepoPath)) {
    $repoHooksDir = Join-Path $RepoPath '.claude/hooks'

    # git exits non-zero both for "not a repository" and for "key not set", and a native command's
    # non-zero exit does not trip $ErrorActionPreference = 'Stop', so the exit code is read
    # explicitly. @() because a single output line comes back as a bare string: the shape check
    # wants a countable collection, and anything other than exactly one line is not a path worth
    # acting on.
    $chpLines = @(& git -C $RepoPath config --get core.hooksPath 2>$null)
    $recordedHooksPath = if ($LASTEXITCODE -eq 0 -and $chpLines.Count -eq 1) { "$($chpLines[0])".TrimEnd() } else { $null }

    if ($recordedHooksPath -and (Test-Path $repoHooksDir)) {
        $recordedAbs = if ([System.IO.Path]::IsPathRooted($recordedHooksPath)) {
            $recordedHooksPath
        }
        else {
            Join-Path $RepoPath $recordedHooksPath
        }
        if (($recordedHooksPath -match '[\\/]\.claude[\\/]hooks[\\/]?$') -and -not (Test-Path $recordedAbs)) {
            $repoHooksAbs = (Resolve-Path $repoHooksDir).Path
            if ($PSCmdlet.ShouldProcess($RepoPath, "repoint core.hooksPath to $repoHooksAbs")) {
                & git -C $RepoPath config core.hooksPath $repoHooksAbs
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "  core.hooksPath repointed to $repoHooksAbs"
                }
                else {
                    Write-Warning "core.hooksPath still names the missing '$recordedHooksPath' (git exit $LASTEXITCODE). Repo hooks will not run until it is corrected."
                }
            }
        }
    }
}

# --- 2. sessions -------------------------------------------------------------
# Resolve-Path does not follow symlinks on Linux, but Claude Code slugs realpathSync(cwd), which
# does. A symlinked -RepoPath would otherwise land the sessions under a slug nothing will ever
# read. realpath (coreutils) matches realpathSync exactly, including ancestor symlinks that
# .NET's ResolveLinkTarget can't reach since it only resolves a path that is itself a reparse
# point; fall back to Resolve-Path where realpath isn't on PATH, where it's on PATH but fails
# (permission, dangling link mid-chain), or where it answers in any shape other than a single
# line. An unchecked failure here would leave $resolvedRepo $null, Get-ProjectSlug $null would come
# back empty, and sessions would land at <ClaudeHome>/projects/ -- silently, at exit 0, which is
# the exact class of bug this exists to close.
$realpath = if (-not $onWindows) { Get-Command realpath -ErrorAction SilentlyContinue } else { $null }
$resolvedRepo = if (-not (Test-Path $RepoPath)) {
    $RepoPath
}
else {
    $viaRealpath = $null
    if ($realpath) {
        # @() because PowerShell hands back a bare string for one output line and an object array
        # for more than one, and only one line is a resolved path. A two-line result binds to
        # Get-ProjectSlug's [string] parameter as its elements joined by a space, which produced
        # the slug '-fake-one--fake-two' from a two-line stand-in: a plausible-looking wrong
        # session folder at exit 0, the same silent-wrong-slug failure the exit-code check above
        # exists to close. Whatever put a non-coreutils realpath on PATH (a busybox applet, a
        # wrapper script printing a notice line ahead of the answer) is exactly the case where the
        # symlink resolution cannot be trusted, so fall back rather than reading line one and
        # hoping -- indexing [0] was the simpler alternative, and it accepts the malformed result
        # instead of rejecting it. Same shape and same reasoning as the core.hooksPath probe above.
        $lines = @(& realpath -- $RepoPath 2>$null)
        if ($LASTEXITCODE -eq 0 -and $lines.Count -eq 1) { $viaRealpath = "$($lines[0])".TrimEnd() }
    }
    if ($viaRealpath) { $viaRealpath } else { (Resolve-Path $RepoPath).Path }
}
if (-not $Slug) { $Slug = Get-ProjectSlug $resolvedRepo }
$projectDir = Join-Path (Join-Path $ClaudeHome 'projects') $Slug

Write-Host "Session folder  : $Slug"
if ($PSCmdlet.ShouldProcess($projectDir, 'restore sessions')) {
    $n = Copy-Tree (Join-Path $Source 'claude-project') $projectDir
    Write-Host "  session files restored: $n"
}

# --- 3. global config --------------------------------------------------------
$globalDirs = @('rules', 'agents', 'skills', 'plugins', 'tools')
if ($IncludeHooks) { $globalDirs += 'hooks' }

foreach ($d in $globalDirs) {
    $dest = Join-Path $ClaudeHome $d
    if ($PSCmdlet.ShouldProcess($dest, 'restore global config')) {
        $n = Copy-Tree (Join-Path $Source "claude-global/$d") $dest
        Write-Host "  $d`: $n files"
    }
}

# --- 4. settings.json --------------------------------------------------------
# Declared out here because steps 6 and 7 read them. Both stay at their initial value on any path
# that skips the rewrite, which is the state step 7 has to be able to report on.
$rewrittenCommands = [System.Collections.Generic.List[object]]::new()
$settingsTarget = $null

if ($IncludeHooks) {
    $exported = Join-Path $Source 'claude-global/settings.json.exported'
    if (Test-Path $exported) {
        if (-not $SourceHome) { $SourceHome = Get-SourceHome $exported }
        if (-not $SourceHome) {
            Write-Warning 'Could not detect the source .claude path in settings.json.exported. Pass -SourceHome to rewrite hook paths.'
        }
        else {
            Write-Host "Source home     : $SourceHome"
            $settings = Get-Content $exported -Raw | ConvertFrom-Json

            # Two counters, not one. The label's only job is to send a person to the exact string
            # that still needs hands, so it has to spell the location the way settings.json is
            # actually shaped: a matcher index, then a hook index that restarts inside each matcher.
            # A single counter incrementing per hook but printed in matcher-index notation agrees
            # with the file only while every matcher holds exactly one hook, and names a position
            # that does not exist the moment one holds two.
            foreach ($event in $settings.hooks.PSObject.Properties) {
                $matcherIndex = 0
                foreach ($matcher in @($event.Value)) {
                    $hookIndex = 0
                    foreach ($hook in @($matcher.hooks)) {
                        $hook.command = Convert-HookCommand $hook.command $SourceHome $ClaudeHome $onWindows
                        $rewrittenCommands.Add([pscustomobject]@{
                                Label   = "hooks.$($event.Name)[$matcherIndex].hooks[$hookIndex].command"
                                Command = $hook.command
                            })
                        $hookIndex++
                    }
                    $matcherIndex++
                }
            }
            if ($settings.statusLine.command) {
                $settings.statusLine.command =
                    Convert-HookCommand $settings.statusLine.command $SourceHome $ClaudeHome $onWindows
                $rewrittenCommands.Add([pscustomobject]@{
                        Label   = 'statusLine.command'
                        Command = $settings.statusLine.command
                    })
            }
            if (-not $onWindows -and $settings.env.CLAUDE_CODE_USE_POWERSHELL_TOOL) {
                $settings.env.PSObject.Properties.Remove('CLAUDE_CODE_USE_POWERSHELL_TOOL')
                Write-Host '  dropped CLAUDE_CODE_USE_POWERSHELL_TOOL (Windows-only)'
            }

            $live = Join-Path $ClaudeHome 'settings.json'
            $target = if (Test-Path $live) { "$live.restored" } else { $live }
            if ($PSCmdlet.ShouldProcess($target, 'write rewritten settings')) {
                $settings | ConvertTo-Json -Depth 20 | Set-Content $target -Encoding utf8
                $settingsTarget = $target
                Write-Host "  settings written to: $target"
                if ($target -ne $live) { Write-Host '  existing settings.json left untouched; merge by hand' }
            }
        }
    }
}

# --- 5. Linux execute bits ---------------------------------------------------
if (-not $onWindows -and $IncludeHooks) {
    $scripts = @(Get-ChildItem (Join-Path $ClaudeHome 'hooks') -Recurse -File -Filter *.sh -ErrorAction SilentlyContinue)
    foreach ($s in $scripts) {
        if ($PSCmdlet.ShouldProcess($s.FullName, 'chmod +x')) { & chmod +x $s.FullName }
    }
    if ($scripts) { Write-Host "  made $($scripts.Count) shell script(s) executable" }
}

# --- 6. report what still needs hands ----------------------------------------
if ($IncludeHooks -and -not $onWindows) {
    $hookDir = Join-Path $ClaudeHome 'hooks'
    $stillBroken = @(
        Get-ChildItem $hookDir -Recurse -File -Include *.ps1, *.sh, *.ts -ErrorAction SilentlyContinue |
            Where-Object {
                Test-ResidualWindowsPath (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue)
            }
    )

    # The scan above reads hook script files and never saw the command strings step 4 rewrote.
    # Convert-HookCommand only touches what it recognizes as the source home, so a command carrying
    # a second, unrelated Windows path comes back out of step 4 still broken, and a run that left
    # one behind reported nothing at all.
    $brokenCommands = @($rewrittenCommands | Where-Object { Test-ResidualWindowsPath $_.Command })

    if ($stillBroken -or $brokenCommands) {
        Write-Host ''
        Write-Warning 'These still carry Windows paths after the rewrite. Edit each one before it will run:'
        foreach ($f in $stillBroken) { Write-Host "    $($f.Name) (inside the script body; no settings rewrite reaches it)" }
        foreach ($c in $brokenCommands) { Write-Host "    $($c.Label) (command string in settings.json)" }
    }
}

# --- 7. verify ---------------------------------------------------------------
Write-Host ''
Write-Host 'Verification:'
$checks = [ordered]@{
    'repo/.git'       = Join-Path $RepoPath '.git'
    'repo/.claude'    = Join-Path $RepoPath '.claude'
    'sessions'        = $projectDir
    'sessions/memory' = Join-Path $projectDir 'memory'
    'rules'           = Join-Path $ClaudeHome 'rules'
}

# A run given -IncludeHooks whose source home could not be detected warns once, skips the rewrite
# entirely, and then exits 0 through a table that never mentioned settings.json, so the whole run
# read as clean. The row appears whenever -IncludeHooks was asked for, not only when the write
# happened, which is what makes the skip visible. $settingsTarget stays $null on every path that
# skipped it, and -and short-circuits before Test-Path sees a null.
if ($IncludeHooks) { $checks['settings.json rewritten'] = $settingsTarget }

foreach ($c in $checks.GetEnumerator()) {
    $ok = $c.Value -and (Test-Path $c.Value)
    Write-Host ("  [{0}] {1}" -f $(if ($ok) { 'ok' } else { '--' }), $c.Key)
}
$transcripts = @(Get-ChildItem $projectDir -Filter *.jsonl -File -ErrorAction SilentlyContinue).Count
Write-Host "  transcripts: $transcripts"

Write-Host ''
Write-Host "Next: run 'claude' in $RepoPath to authenticate, then 'claude --resume' to confirm the"
Write-Host "session list is populated. An empty list means the slug is wrong; rename"
Write-Host "$projectDir to match the folder claude creates on its first run."
