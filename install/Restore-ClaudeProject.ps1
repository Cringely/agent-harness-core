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

.EXAMPLE
    ./Restore-ClaudeProject.ps1 -Source ~/Downloads/export -RepoPath C:\temp\myproject -WhatIf

.EXAMPLE
    pwsh ./Restore-ClaudeProject.ps1 -Source ~/Downloads/export -RepoPath ~/myproject -IncludeHooks
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$RepoPath,
    [string]$Slug,
    [string]$SourceHome,
    [string]$ClaudeHome,
    [switch]$IncludeHooks,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# $IsWindows is undefined on Windows PowerShell 5.1, where the answer is always Windows.
$onWindows = if ($PSVersionTable.PSVersion.Major -lt 6) { $true } else { $IsWindows }
if (-not $ClaudeHome) { $ClaudeHome = Join-Path $HOME '.claude' }

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
# absolute path with a hyphen. Verified against C--temp-GHAS-GHASalerts, C--Users-user, and
# E--projects-ONI--onimods-upstream. A hyphenated form over 200 characters is truncated to 200
# chars plus a hyphen and a base-36 hash of the untruncated path. Extracted from the r0()/Nat()
# functions in the installed claude-code bundle (~/.local/share/claude/versions/2.1.222) and
# cross-checked against that exact algorithm running under node for paths past the 200-char cut;
# Nat() is a Java-style string hash (h = h*31 + charCode, wrapped to signed 32-bit each step).
function Get-ProjectSlug {
    param([string]$Path)
    $trimmed = $Path.TrimEnd('\', '/')
    $slug = $trimmed -replace '[^A-Za-z0-9]', '-'
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
    # -- e.g. inside a sed expression sharing the string -- is never touched. A blanket
    # backslash-to-slash replace over the whole command did exactly that.
    $newHomeSlashed = $NewHome.Replace('\', '/')
    $continuation = '(?:[\\/][^''"\s]*)*'
    $out = [regex]::Replace($Command, $homePattern + $continuation, {
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
if (-not $onWindows -and (Test-Path $RepoPath)) {
    $repoHooks = @(Get-ChildItem (Join-Path $RepoPath '.claude/hooks') -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($h in $repoHooks) {
        if ($PSCmdlet.ShouldProcess($h.FullName, 'chmod +x')) { & chmod +x $h.FullName }
    }
    if ($repoHooks) { Write-Host "  made $($repoHooks.Count) repo hook(s) executable" }
}

# --- 2. sessions -------------------------------------------------------------
# Resolve-Path does not follow symlinks on Linux, but Claude Code slugs realpathSync(cwd), which
# does. A symlinked -RepoPath would otherwise land the sessions under a slug nothing will ever
# read. realpath (coreutils) matches realpathSync exactly, including ancestor symlinks that
# .NET's ResolveLinkTarget can't reach since it only resolves a path that is itself a reparse
# point; fall back to Resolve-Path where realpath isn't on PATH.
$realpath = if (-not $onWindows) { Get-Command realpath -ErrorAction SilentlyContinue } else { $null }
$resolvedRepo = if (-not (Test-Path $RepoPath)) {
    $RepoPath
}
elseif ($realpath) {
    & realpath -- $RepoPath
}
else {
    (Resolve-Path $RepoPath).Path
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

            foreach ($event in $settings.hooks.PSObject.Properties) {
                foreach ($matcher in $event.Value) {
                    foreach ($hook in $matcher.hooks) {
                        $hook.command = Convert-HookCommand $hook.command $SourceHome $ClaudeHome $onWindows
                    }
                }
            }
            if ($settings.statusLine.command) {
                $settings.statusLine.command =
                    Convert-HookCommand $settings.statusLine.command $SourceHome $ClaudeHome $onWindows
            }
            if (-not $onWindows -and $settings.env.CLAUDE_CODE_USE_POWERSHELL_TOOL) {
                $settings.env.PSObject.Properties.Remove('CLAUDE_CODE_USE_POWERSHELL_TOOL')
                Write-Host '  dropped CLAUDE_CODE_USE_POWERSHELL_TOOL (Windows-only)'
            }

            $live = Join-Path $ClaudeHome 'settings.json'
            $target = if (Test-Path $live) { "$live.restored" } else { $live }
            if ($PSCmdlet.ShouldProcess($target, 'write rewritten settings')) {
                $settings | ConvertTo-Json -Depth 20 | Set-Content $target -Encoding utf8
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
                $t = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
                $t -match '[A-Za-z]:[\\/]' -or $t -match 'USERPROFILE'
            }
    )
    if ($stillBroken) {
        Write-Host ''
        Write-Warning 'These hooks carry Windows paths inside the script body. Rewriting settings.json does not reach them; edit each one before it will run:'
        $stillBroken | ForEach-Object { Write-Host "    $($_.Name)" }
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
foreach ($c in $checks.GetEnumerator()) {
    $ok = Test-Path $c.Value
    Write-Host ("  [{0}] {1}" -f $(if ($ok) { 'ok' } else { '--' }), $c.Key)
}
$transcripts = @(Get-ChildItem $projectDir -Filter *.jsonl -File -ErrorAction SilentlyContinue).Count
Write-Host "  transcripts: $transcripts"

Write-Host ''
Write-Host "Next: run 'claude' in $RepoPath to authenticate, then 'claude --resume' to confirm the"
Write-Host "session list is populated. An empty list means the slug is wrong; rename"
Write-Host "$projectDir to match the folder claude creates on its first run."
