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

    A second export with nothing changed produces no content diff, which makes `git diff
    account/claude` after an export a usable review of what changed in the account layer.

    Use `git diff` and not `git status` for that review. On a Windows clone with
    core.autocrlf=true the checkout filter writes CRLF while this script writes LF, so a
    no-change re-export leaves the index untouched but flips the working-tree line endings,
    and `git status` then lists every file it rewrote. Measured 2026-09-05 against a clean
    tree: `git status --short` reported 203 modified paths where `git diff --exit-code`
    returned 0. `git ls-files --eol account/claude` shows the same transition as
    i/lf w/crlf becoming i/lf w/lf.

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

    The FOLD applies to mcpServers strings and to settings.json's hook and statusLine commands,
    both of which ConvertTo-TemplatedCommand rewrites with the whole fold table. The GATE that
    catches an unfolded WSL home applies to every file the export writes, because those are the
    ones no WSL_HOME fold reaches: a copied rules, agents, skills, hooks or statusline file gets
    no fold pass at all, and a templated file is folded only for the tokens its own
    AccountTemplatedFiles row names, none of which is WSL_HOME. Where -WslHome resolved, the gate
    scans for that literal on a path boundary; where it did not, the mcpServers gate falls back to
    the POSIX-home shapes enumerated at $script:PosixHomeShape.

.PARAMETER VaultPath
    The literal folded into {{OBSIDIAN_VAULT}}. Defaults to $env:CLAUDE_OBSIDIAN_VAULT, else
    $HOME/Documents/Obsidian Vault/Claude Code.

.PARAMETER HomeSlug
    The literal folded into {{HOME_SLUG}}. Defaults to Get-ProjectSlug $HOME.

.PARAMETER AccountUser
    The workstation username. Redacted to a neutral placeholder wherever it appears as a profile
    path segment in the payload, and refused by the identity gate wherever it survives anywhere
    else. Defaults to the leaf of $HOME, which is the spelling every occurrence in the live
    account layer actually carries. A test seam as much as an override: the default is this
    machine's real username, and a test asserting against it would print that username in its own
    failure output.

.PARAMETER IdentityFile
    JSON declaring the identifying strings that cannot be derived from the environment -- the
    operator's legal name and personal email addresses:

        { "names": ["First Last"], "emails": ["someone@example.com"] }

    Defaults to $HOME/.claude-account-identity.json, deliberately OUTSIDE both this repo and
    ~/.claude: a file inside the repo is one `git add -f` from being published, and a file under
    ~/.claude is inside the tree this script exports. Absent means nothing extra to check, with a
    warning -- never "check nothing", since the derived username arm runs either way. Malformed
    JSON throws rather than degrading the gate silently.

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
    [string]$AccountUser,
    [string]$IdentityFile,
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
        # Collect the whole stream, THEN read $LASTEXITCODE. Piping straight into
        # `Select-Object -First 1` lets Select stop the pipeline as soon as it has its one object,
        # and a stopped pipeline can leave $LASTEXITCODE unset from this call -- so the exit-status
        # check reads whatever the previous native command left behind, or nothing at all. The
        # repo's own auto-resolution test fails in isolation for exactly this reason while passing
        # in a full run, which is the signature of a check reading a stale global.
        $lines = @(& wsl -e sh -c 'echo $HOME' 2>$null)
        $rc = $LASTEXITCODE
        $v = if ($lines.Count -gt 0) { $lines[0] } else { $null }
        if ($rc -eq 0 -and $v) { $v.Trim() } else { $null }
    } else { $null }
}

# Validate the RESOLVED -WslHome here, at the producer, rather than where the literal is consumed
# ~770 lines below. Two consumers read this one value in contradictory ways: the fold table takes
# it as a path literal with IsPath = $true, and the residual scan takes it as the thing to search
# for. A degenerate value satisfies the first and defeats the second, so by the time the scan
# could notice, every separator in the payload has already been rewritten by the fold.
#
# Measured, against the merged exporter with -WslHome '/': the export COMPLETES, writes its
# marker, ships '/home/wsluser/code-context-mcp.sh' verbatim in a copied rules file, and rewrites
# mcp-servers.json args to "C:{{WSL_HOME}}tools{{WSL_HOME}}srv.js". The mcpServers shape gate does
# not catch it either -- the '/' fold rewrites every separator, so $script:PosixHomeShape finds no
# POSIX home left to match. Both gates off, one silent success, which is the exact outcome the
# residual scan exists to prevent.
#
# Trailing whitespace is the same bug wearing different clothes. The auto-resolution branch above
# calls .Trim(); the explicit-parameter path did not, so -WslHome '/home/wsluser ' built the
# pattern '/home/wsluser\ (?!...)' and degraded the scan to a near-total no-op, completing the
# export with the literal shipped.
#
# An UNRESOLVED WslHome is a different case and stays legal: $null means this machine has no WSL
# and there is nothing to fold or scan for.
#
# Judged wherever the value came from, NOT only when the caller supplied it. A first version of
# this guard read `$PSBoundParameters.ContainsKey('WslHome') -and $WslHome`, which left the
# auto-resolution branch above unguarded while the consumer-side TrimEnd it replaced was deleted --
# so it removed a defence that path already had. Measured with a stub `wsl` and -WslHome omitted:
# a distro echoing '/home/stubwsl/' threw before that change and completed after it, marker written
# and the literal shipped; a distro echoing '/' reproduced the original defect whole, mangled
# mcp-servers.json included. `wsl -e sh -c 'echo $HOME'` returns whatever that distro's passwd
# entry says, which is not a value this script gets to assume is well-formed.
if ($WslHome) {
    $wslHomeGiven = $WslHome
    $WslHome = $WslHome.Trim().TrimEnd('/')
    if ($WslHome -notmatch '^/[^/]') {
        throw "WslHome must name an absolute POSIX directory, and '$wslHomeGiven' does not. It is used both as a fold literal and as the string the residual scan searches for; a value that trims to nothing, or that is a bare '/', folds every separator in the payload and leaves the scan with nothing to match, so the export completes while shipping the WSL home it was meant to catch. Pass -WslHome a path like '/home/<user>', or fix what ``wsl -e sh -c 'echo `$HOME'`` returns on this machine."
    }
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

# --- identifying strings -----------------------------------------------------
# security.md's mandate: identifying information must never reach a remote repository, and only a
# human can override that. account/claude/ is a generated payload committed to a PUBLIC repo, so
# this script has to carry the mandate as a gate rather than trust that a scrub happened somewhere
# upstream. It had not. A content scan of this repo for the username comes back clean, and that
# cleanliness is the residue of a one-time git-filter-repo run performed entirely outside this
# generator. Nothing here stopped the next export from writing the username straight back in: six
# payload files hold a neutral placeholder exactly where their live sources under ~/.claude hold
# the username, and no code anywhere made that substitution.
#
# Two mechanisms, deliberately different widths, and the difference is the point.
#
#   REDACTION rewrites the workstation username to a neutral placeholder, but only where it sits
#   in a profile-path position. Mechanical and narrow.
#
#   The GATE refuses the export when any identifying string survives into the payload. Strictly
#   WIDER than the redaction: it matches the username anywhere, not only inside a path, so it
#   still fires on everything redaction is not allowed to paper over. It is the only mechanism for
#   the other two classes. A legal name or a personal email reaching the payload is a defect in
#   the source for a human to fix, never something a generator should quietly rewrite -- rewriting
#   a name means substituting somebody else's, and a redactor that edits arbitrary prose is how a
#   document gets mangled.
#
# Resolved and loaded HERE, before the first copy, so a malformed identity file fails the run
# before 218 files are on disk rather than after.

# Derived, not declared. The leaf of $HOME is the spelling every occurrence in the live tree
# actually carries (C:\Users\<leaf>, /c/Users/<leaf>, C--Users-<leaf>), and $HOME is already the
# source every other fold in this file derives from. Rejected $env:USERNAME, the obvious
# alternative: that is the ACCOUNT name, which a renamed account or a roaming profile lets diverge
# from the PROFILE directory name, and it is the profile directory that appears in a path.
if (-not $AccountUser) { $AccountUser = Split-Path ($HOME.TrimEnd('\', '/')) -Leaf }
if (-not $AccountUser) {
    throw "Could not derive the workstation username from `$HOME ('$HOME'). Pass -AccountUser explicitly."
}

if (-not $IdentityFile) { $IdentityFile = Join-Path $HOME '.claude-account-identity.json' }
$declaredNames = @()
$declaredEmails = @()
if (Test-Path -LiteralPath $IdentityFile) {
    try { $identity = Get-Content -LiteralPath $IdentityFile -Raw | ConvertFrom-Json }
    catch {
        # Throw, not warn. A security gate reading its own config must not degrade to "checked
        # less than you think" because a comma went missing.
        throw "Identity file '$IdentityFile' is not valid JSON ($($_.Exception.Message)). Fix the file, or pass -IdentityFile; a gate must not silently check less than it claims to."
    }
    # @($identity.names) when the key is absent is @($null) -- a ONE-element array holding $null,
    # not an empty one, the same trap the mcpServers env loop below documents. The Where-Object is
    # what makes an absent key mean zero entries; the outer @() is what keeps a single surviving
    # entry an array instead of a bare string.
    $declaredNames = @(@($identity.names) | Where-Object { $_ })
    $declaredEmails = @(@($identity.emails) | Where-Object { $_ })
}
else {
    Write-Warning ("No identity file at '$IdentityFile': only the workstation username is " +
        "checked. Create it to also refuse the operator's legal name and personal email -- " +
        '{"names":["First Last"],"emails":["someone@example.com"]} -- ' +
        "and note entries are matched verbatim, so declare each token you want caught.")
}

# Word-boundary LOOKAROUNDS, not \b and not a bare substring. Measured on the live account layer:
# skills/owasp-llm/references/08-vector-and-embedding-weaknesses.md:117 contains "adjusting",
# which holds the operator's declared first name as a substring. A bare containment check reads
# that as a hit and aborts every export against a vendored third-party document nobody here may
# edit. Same failure the WSL gate's /root boundary already fixed, one class up. And the reason
# this comment describes the collision instead of quoting it is the rule above: a file that ships
# to the public repo must not carry the strings the gate defends, least of all in the gate's own
# source. \b is not the substitute here either: \b asserts a
# transition, so its answer depends on whether the declared entry happens to start and end with a
# word character, and an entry like "@example.com" inverts it. The lookarounds say what is meant
# regardless of the entry -- not preceded or followed by another identifier character.
#
# IgnoreCase throughout, unlike the WSL gate's deliberate -cmatch. That gate asks whether two
# POSIX paths are the same path, where case is significant. This one asks whether a string
# identifies a person, where it is not.
function New-IdentityCheck {
    param([string]$Class, [string[]]$Value)
    return @(@($Value) | Where-Object { $_ } | ForEach-Object {
            [pscustomobject]@{
                Class = $Class
                Regex = '(?<![A-Za-z0-9])' + [regex]::Escape($_) + '(?![A-Za-z0-9])'
            }
        })
}
$identityChecks = @(New-IdentityCheck -Class 'workstation username' -Value $AccountUser) +
    @(New-IdentityCheck -Class 'declared name' -Value $declaredNames) +
    @(New-IdentityCheck -Class 'declared email' -Value $declaredEmails)

# The redaction is narrower than the gate on purpose, and this lookbehind is the whole of that
# narrowing: the username only where a path separator puts it in a profile directory position.
# That covers all 12 occurrences the live account layer carries today -- 3 in
# rules/change-management.md, 1 in rules/ssh.md, and 1+3+2+2 across four tools/prose-lint style
# files -- in every spelling they use (C:\Users\x, /c/Users/x, /mnt/c/Users/x).
#
# Rejected a tree-wide blind replace of the bare username, the smaller expression: a username
# short or common enough to read as an ordinary word (root, admin, user) turns it into exactly the
# false-positive failure the WSL gate's /root boundary exists to stop, and there it mangles the
# document instead of merely aborting.
#
# Rejected extending the lookbehind to `home[\\/]` as well: no live occurrence needs it, and it
# would overlap the WSL-home gate below -- redacting /home/<user> before that gate reads it would
# swallow the unfolded-WSL-home signal and ship a silently wrong path in its place.
#
# Rejected extending it to the `C--Users-<user>` slug spelling for the same reason: the two files
# carrying that spelling are $AccountTemplatedFiles rows folded to {{HOME_SLUG}} before this runs,
# that fold already throws when it stops matching, and redacting a slug the installer does not
# expand would hand a receiver a wrong slug instead of an abort. The gate still catches it.
#
# {1,2} on the separator, because JSON doubles every backslash and both generated payload files
# are JSON. Without it the same logical path gets two different treatments decided by nothing but
# its spelling: C:/Users/<user> inside mcp-servers.json redacts (JSON does not escape a forward
# slash) while C:\\Users\\<user> in the same file does not match and takes the gate's abort
# instead. Either answer is defensible; picking one by accident of separator arithmetic is not,
# and the inconsistency is invisible until the day an unfoldable path lands in one of them. One
# mechanism, every spelling, with the Write-Host below naming any file it touches -- a redaction
# inside a generated config is worth seeing, and that line is what makes it visible.
$userRedactPattern = '(?<=Users[\\/]{1,2})' + [regex]::Escape($AccountUser) + '(?![A-Za-z0-9])'

# 'user', not '{{USERNAME}}'. Two reasons, and the first is measured: substituting this exact
# shape into the six live source files reproduces the committed account/claude/ byte for byte,
# 12 occurrences, so folding the operator's one-time scrub into the generator changes no committed
# content and keeps "a second export with nothing changed produces no content diff" true.
#
# The second is that a token would be wrong even if it were free. Every {{TOKEN}} in this file is
# a PORTABILITY fold: Install-Account.ps1's Get-AccountTokenMap expands it to the receiver's own
# answer. This is a REDACTION, and there is no receiver-side answer to expand it to -- these
# sentences are measured claims about THIS workstation (where Git Bash puts $HOME, where the ssh
# config lives), so rewriting the username to a receiver's would turn a true statement into a
# false one. That is the objection Get-AccountTokenMap already records against expanding
# {{WSL_HOME}}, one step worse: not a dead entry looking resolved, but a wrong one.
$userPlaceholder = 'user'

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

# F4, final review round: Copy-Item/New-Item/Remove-Item are ShouldProcess-aware and no-op under
# -WhatIf on their own, but the status lines below are plain Write-Host built from script counters
# ($copied, $n) that increment whether or not the underlying cmdlet actually wrote anything, so
# they read as completed work under a dry run unless told otherwise. One flag computed once,
# reused at every status line rather than re-testing $WhatIfPreference at each site.
$dryRun = if ($WhatIfPreference) { ' (dry run)' } else { '' }

$null = New-Item -ItemType Directory -Path $OutputRoot -Force

foreach ($d in $script:AccountTreeDirs) {
    $n = Copy-AccountTree -SourceRoot $ClaudeHome -DestRoot $OutputRoot `
        -Relative $d -SkipRelative $script:AccountSkipFiles -SkipDirs $script:AccountSkipDirs
    Write-Host "  ${d}: $n files$dryRun"
}

foreach ($f in $script:AccountRootFiles) {
    $src = Join-Path $ClaudeHome $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $OutputRoot $f) -Force
        Write-Host "  ${f}: copied$dryRun"
    }
    else { Write-Warning "absent, skipping: $src" }
}

# --- fold table --------------------------------------------------------------
# Each fold has one named source. {{CLAUDE_HOME}} is the -ClaudeHome value, {{NPM_GLOBAL}} is
# `npm root -g`, {{CORE_REPO}} is the main checkout, {{OBSIDIAN_VAULT}} and {{HOME_SLUG}} come
# from $HOME, {{WSL_HOME}} is `wsl -e sh -c 'echo $HOME'`.
#
# The rows are declared in the order a reader wants to meet them and RETURNED longest-literal
# first, because the callers apply them in the order they arrive and a literal that is a prefix
# of another must not go first. Today's six do not overlap -- the npm path and the vault both
# sit under the bare home rather than under .claude, the slug shares no characters with any path
# spelling, and {{WSL_HOME}} is POSIX-rooted while the other four are Windows-rooted, so no
# Windows literal can contain a `/`-rooted string and no POSIX literal can contain a drive
# letter. That held by luck of which paths were needed, not by construction: a {{HOME}} token
# (backlog item 30) is a literal prefix of both the .claude path and the vault path, so folding
# it first would yield `{{HOME}}/.claude` where `{{CLAUDE_HOME}}` belongs.
#
# Sorting here rather than restating the precondition in a comment: the precondition was already
# written down, nothing checked it, and the sort is one line. The smaller alternative -- keep the
# comment and hand-order the rows -- makes the next person to add a row rediscover the rule,
# which is how item 30 came to be filed in the first place.
#
# No tie-break key is needed. Two literals of equal length cannot contain one another unless they
# are the same string, so the relative order of equal-length rows cannot change any output.
function Get-AccountFoldTable {
    param(
        [string]$ClaudeHome,
        [string]$NpmGlobal,
        [string]$WslHome,
        [string]$CoreRepo,
        [string]$VaultPath,
        [string]$HomeSlug
    )
    $rows = @(
        [pscustomobject]@{ Token = '{{CLAUDE_HOME}}';    Literal = $ClaudeHome; IsPath = $true }
        [pscustomobject]@{ Token = '{{NPM_GLOBAL}}';     Literal = $NpmGlobal;  IsPath = $true }
        [pscustomobject]@{ Token = '{{WSL_HOME}}';       Literal = $WslHome;    IsPath = $true }
        [pscustomobject]@{ Token = '{{CORE_REPO}}';      Literal = $CoreRepo;   IsPath = $true }
        [pscustomobject]@{ Token = '{{OBSIDIAN_VAULT}}'; Literal = $VaultPath;  IsPath = $true }
        [pscustomobject]@{ Token = '{{HOME_SLUG}}';      Literal = $HomeSlug;   IsPath = $false }
    )
    return @($rows | Sort-Object -Property { if ($_.Literal) { $_.Literal.Length } else { 0 } } -Descending)
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
        Write-Host "  settings.account.json: written$dryRun"
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
        # A row that folds NONE of its tokens is a different failure from a row that folds some
        # of them, and printing both through the same Write-Host below put them in the same
        # register. Every row in the table exists because that file carries a machine path; a
        # zero count says the file no longer carries any of the literals the row names, which
        # means the table and the source text have drifted apart. That is the failure the report
        # was added to catch, so it throws rather than warns.
        #
        # Zero, not "fewer than all". A partial match (the two-token row where one token lands)
        # is a real signal too, and the per-token Write-Warning above already names exactly which
        # token stopped matching; promoting that to a throw would make a file legitimately losing
        # one of its two literals block every export until the table was edited.
        #
        # Scope note: backlog item 29 asked for this on "the two files where a fold is required
        # rather than incidental" and named neither. Nothing in the repo records which two. All
        # six rows have the same character -- each is model-read text that a placeholder cannot
        # be written into at source -- so this applies to all six. Measured against the live
        # account layer before shipping it: every row folds at least one token today (five at
        # 1 of 1, subagent-prompting at 2 of 2), so no real export changes behaviour.
        #
        # Names $AccountTemplatedFiles, not "the fold table". Review round 3: the message used to
        # say "the fold table in AccountShared.ps1", which points at a table that is not there --
        # Get-AccountFoldTable is defined above in this file, and what lives in AccountShared.ps1
        # is the $AccountTemplatedFiles row this loop is iterating. "Fix the row" was already
        # right; the table it named was not.
        if ($substituted -eq 0) {
            throw "Templated file '$rel' folded none of its $(@($rowFolds).Count) token(s) ($($wanted -join ', ')). The AccountTemplatedFiles row in AccountShared.ps1 and the file's text have drifted apart; the payload would ship whatever machine path this file carries. Fix the row or the source text."
        }
        Set-Content -LiteralPath $target -Value $text -NoNewline
        Write-Host "  ${rel}: folded $substituted of $(@($rowFolds).Count) token(s)$dryRun"
    }
}

# --- POSIX home shapes -------------------------------------------------------
# The shapes a WSL home takes, for the gate that runs when -WslHome did not resolve and there is
# therefore no literal to scan for. Enumerated rather than keyed on `/home/`, which was one of
# four spellings and named the gate after the narrowest of them (backlog item 23):
#
#   /home/<user>          the default for a distro-created user account
#   /root                 a WSL root account, which has no /home entry at all
#   /Users/<name>         distro images that mirror the macOS layout
#   /mnt/<drive>/Users/<name>   a WSL path reaching back into Windows. This is the awkward one:
#                         it carries the WINDOWS username, and it escapes both sides -- this gate
#                         did not know the prefix, and the Windows folds match on backslashes.
#
# The drive-letter lookbehind keeps a forward-slashed Windows path out of it: `C:/Users/<name>`
# is not a POSIX home and an mcpServers entry is free to carry one. `--flag=/home/<user>` still
# matches, which a whitespace-or-quote lookbehind would have missed.
#
# Two-valued over an unenumerated domain is the failure change-management.md's scope-filter
# invariant records, so the enumeration is the fix and this comment is the enumeration.
$script:PosixHomeShape =
    '(?<![A-Za-z]:)(?:/mnt/[A-Za-z]/Users/[^/"''\s]+|/home/[^/"''\s]+|/Users/[^/"''\s]+|/root(?![^/"''\s]))'

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
                    # separately. Scanning the post-fold string for the shapes that must never
                    # survive a successful fold covers all of those at once, and reuses the same
                    # scan-and-throw shape the secret gate right above already established,
                    # rather than adding a second kind of gate.
                    #
                    # Backlog item 23: the shape list used to be `/home/<user>` alone, which is
                    # one of four spellings a WSL home takes. $script:PosixHomeShape carries the
                    # enumeration and the reason for each entry.
                    if ($s -match $script:PosixHomeShape) {
                        throw "Refusing to export mcpServers entry '$name': carries an unfolded POSIX home path ('$($Matches[0])'). -WslHome did not resolve (wsl absent, the distro stopped, or an empty override) so the fold could not apply; pass a real -WslHome, or fix the account layer's WSL entry, before exporting."
                    }
                }
            }

            [pscustomobject]@{ mcpServers = $servers } | ConvertTo-Json -Depth 20 |
                Set-Content -LiteralPath (Join-Path $OutputRoot 'mcp-servers.json') -Encoding utf8
            Write-Host "  mcp-servers.json: $(@($serverNames).Count) server(s)$dryRun"
        }
    }
}

# --- residual WSL home, whole payload ----------------------------------------
# The gate inside the mcpServers loop sees mcpServers strings and nothing else. Copy-AccountTree
# copies every rules, agents, skills, hooks and tools/prose-lint file verbatim, and the two
# $AccountRootFiles statusline scripts with them; no fold pass runs over any of those, so a WSL
# home literal written into one ships as written. The six $AccountTemplatedFiles rows are folded,
# but only for the tokens their own row names, and no row names WSL_HOME today, which leaves them
# in the same position. Every one of those files is on disk by the time this runs. That was the
# second half of backlog item 23: the gate's guarantee read wider than its scope.
#
# Review round 3: this comment and 2f3b196's message both named "a settings hook command" as one
# of the paths reaching here. It is not one, and cannot be. ConvertTo-TemplatedCommand rewrites
# every hook command and statusLine.command above with the WHOLE fold table, {{WSL_HOME}}
# included, and this block only runs when $WslHome is truthy -- which is exactly the condition
# under which that fold lands. A hook command is folded before the scan starts. The path that can
# fire is a copied file, which is what the copied-file It in Export-Account.Tests.ps1 exercises.
#
# Scans for the resolved LITERAL, not for $script:PosixHomeShape. The shape cannot be used over
# the whole tree: the payload legitimately names POSIX home paths in prose, and
# skills/owasp-mcp/references/05-command-injection-execution.md names /root beside /etc/passwd
# and /proc, so a shape scan across 218 files fails on documentation rather than on drift.
# Measured on the live payload before choosing this: an exact-literal scan for the WSL home
# matches nothing there, and the same scan for {{CORE_REPO}} or {{CLAUDE_HOME}} matches nine
# prose-lint calibration comments that carry those paths on purpose -- which is why this scans
# for the one literal that must never survive and not for every fold literal.
#
# When -WslHome did not resolve there is no literal to scan for, and the shape gate on mcpServers
# is what stands. The two are complements: exact where a literal exists, shape where none does.
#
# Throws after the copy rather than before it, unlike the mcpServers gate. Rejected the
# alternative of staging the payload in a temp tree and moving it on success: the marker below is
# what a repeat export trusts, it is written only once every gate has passed, and a destination
# left without one already demands -Force. The cost of the small fix is a partially written
# -OutputRoot on a failed run; the cost of the large one is copying 218 files twice on every run.
# The copied-file It in Export-Account.Tests.ps1 pins that disclosed behaviour, because the
# mcpServers gate's Its in the same file assert the opposite ("a failed gate must leave nothing
# behind to commit") and the file should not state both without saying which is intended.

# --- identity redaction and gate, whole payload ------------------------------
# Same traversal, not a second one. Everything the identity gate must see is already the set this
# loop walks: Copy-AccountTree's verbatim copies, the folded $AccountTemplatedFiles rows, and the
# two files written from parsed JSON above. A second pass over the same 218 files would double the
# read for nothing, and the two scans would drift on which files they agree to skip -- the binary
# sniff below is a rule both need and neither should own alone.
#
# Order inside the loop is load-bearing. The WSL gate reads the body BEFORE redaction, so it sees
# exactly the bytes it saw before this block existed and its behaviour is unchanged. Redaction
# then runs, and the identity gate scans what SURVIVED it. Reversing the last two would make the
# gate refuse the very occurrences redaction exists to handle; reversing the first two is the
# /home/<user> overlap argued at $userRedactPattern above.
#
# The loop condition widened from `$WslHome -and -not $WhatIfPreference` to drop the $WslHome
# half: the identity gate has to run on every export, including the one where wsl is absent, and
# $WslHome now gates only the WSL arm inside. Under -WhatIf nothing was copied at all, so there is
# still nothing here to read.
if (-not $WhatIfPreference) {
    # Boundary, not a bare substring test. Review round 3, reproduced on the live payload:
    # $body.Contains($WslHome) reads ANY occurrence of the literal as a machine path, and /root --
    # one of the four shapes $script:PosixHomeShape above declares supported, and what a
    # `wsl --import` distro gives its default user -- is also a substring of the vendored
    # skills/owasp-mcp/references/05-command-injection-execution.md line
    # "Access to sensitive paths (/etc/passwd, /root, /proc/, ~/.ssh)." So `-WslHome /root` aborted
    # after writing 216 files and no marker, and told the operator to edit a third-party OWASP
    # document where the string is not a machine path at all. Direction 1 of item 23 declared
    # /root supported; direction 2 made it fatal. The literal scan chosen above is still the right
    # scan -- it is the BOUNDARY that was missing, not the mechanism.
    #
    # Same idiom $script:PosixHomeShape uses on its own /root arm, but NOT the same class: this
    # scan's boundary was widened to cover a closing bracket, a backtick and '>', and that arm was
    # not. So the two gates no longer agree on where a POSIX home ends, and a `(/root)` or a
    # backticked `/root` fires here and not there. Deliberate, and left that way: widening a second
    # gate is a behaviour change that needs its own fixtures, and this scan is the one that runs
    # over every copied file. Recorded rather than quietly tolerated, because an earlier version of
    # this comment claimed the two agreed and was wrong after the widening landed.
    #
    # Here, the next character must be a separator, a quote, whitespace, a closing bracket or
    # backtick, '>', or nothing at all. `/root/x` and a bare `/root` at end of line still fire;
    # `/root,` and `/rootkit` do not.
    #
    # Review round 4: the boundary as first shipped closed on `,`, `;`, `:` and friends but not on
    # `)`, `]`, a backtick, or `>` -- so `(/root)`, `[/root]`, `` `/root` `` and a markdown link
    # `[link](/root)` all read as clean. A code span or a parenthetical is exactly how a bare home
    # path gets written into a rules or skills file, so the negated class now also excludes those
    # four. Sentence-final `/root.` is still a miss and is left one: a trailing `.` is not locally
    # distinguishable from the trailing `,` the boundary exists to ignore.
    #
    # Rejected \b, the obvious smaller boundary: `t` is a word character and `,` is not, so \b
    # matches at exactly the position that has to stop matching and the OWASP line still takes the
    # export down. Rejected excluding vendored trees from the scan: that is a denylist, and it
    # would blind the gate to a vendored file that did carry the operator's own home.
    #
    # -cmatch and not -match: POSIX paths are case-sensitive and .Contains was ordinal, so the
    # case-insensitive default would widen the gate past the boundary this is here to add.
    #
    # $WslHome is already trimmed of whitespace and of a trailing '/' by the validation at :198-203,
    # which also refuses a supplied value that does not name an absolute POSIX directory. So the
    # only thing left to distinguish here is present from absent. A trailing slash would otherwise
    # make the escaped literal end in '/', the boundary would demand a second separator that a real
    # path never has ('/home/user//launcher.sh' does not exist), and the scan would degrade from
    # fail-closed to a near-total no-op on every copied file, with no error.
    #
    # Null when -WslHome did not resolve, meaning the machine has no WSL. The arm below is skipped
    # in that case, exactly as the old `$WslHome -and` loop condition skipped the whole loop.
    #
    # An earlier resolution of this merge nulled the pattern for a degenerate value too, calling
    # that fail-safe. Review measured it fail-OPEN: -WslHome '/' then completed the export, wrote
    # its marker, and shipped the WSL home verbatim. The producer-side throw replaces it, which is
    # also the right locus -- a '/' is consumed as a fold literal some 770 lines before anything
    # here could object to it.
    $wslHomePattern = if ($WslHome) { [regex]::Escape($WslHome) + '(?![^/"''\s)\]`>])' } else { $null }
    $ignoreCase = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    # One buffer for the whole scan, not one per file. IndexOf below is bounded by $read, so bytes
    # left over from a longer previous file are never looked at.
    $head = [byte[]]::new(8000)
    # $outputRootFull, not $OutputRoot: FullName below is absolute, and -OutputRoot may be
    # relative, so the Substring that builds $rel has to be taken against the resolved root.
    foreach ($f in @(Get-ChildItem -LiteralPath $outputRootFull -Recurse -File -Force)) {
        # Skip binary files instead of text-decoding them. Get-Content -Raw decodes every byte of
        # skills/wiring-diagram/examples/'s two PNGs on every export, 600 KB between them, and a
        # decoded byte run that happened to match would abort the export pointing at an image the
        # operator cannot edit. A NUL byte in the head is git's own binary test.
        #
        # Rejected an extension ALLOWLIST of text types: a new text extension would silently drop
        # OUT of the gate, which is the one failure a gate must not have. Rejected a denylist of
        # binary extensions: it needs a new entry per format shipped, and this needs none. Head
        # only, not ReadAllBytes, so the megabyte is never read at all. Measured on the live
        # 218-file payload: exactly the two PNGs carry a NUL byte, the other 216 files carry none.
        $stream = [System.IO.File]::OpenRead($f.FullName)
        try { $read = $stream.Read($head, 0, $head.Length) } finally { $stream.Dispose() }
        if ($read -gt 0 -and [System.Array]::IndexOf($head, [byte]0, 0, $read) -ge 0) { continue }

        $body = Get-Content -LiteralPath $f.FullName -Raw
        # -Raw on an empty file yields $null, and there is nothing to redact or scan in one.
        if (-not $body) { continue }
        $rel = ($f.FullName.Substring($outputRootFull.Length).TrimStart('\', '/')) -replace '\\', '/'

        if ($wslHomePattern -and $body -cmatch $wslHomePattern) {
            throw "Refusing to complete the export: '$rel' still carries the WSL home literal after folding. No fold pass covers {{WSL_HOME}} there -- Copy-AccountTree copies verbatim, and a templated file is folded only for the tokens its own AccountTemplatedFiles row names, none of which is WSL_HOME. Remove it at source, or add the file to AccountTemplatedFiles with a WSL_HOME row."
        }

        # Write back only when something actually changed. On a real export that is 6 files out of
        # 218, so the other 212 keep the exact bytes Copy-Item gave them -- which is what keeps the
        # idempotence guarantee ("a second export with nothing changed writes identical bytes")
        # true without this pass having to reason about encodings it never touches.
        $redacted = [regex]::Replace($body, $userRedactPattern, $userPlaceholder, $ignoreCase)
        if ($redacted -ne $body) {
            $n = @([regex]::Matches($body, $userRedactPattern, $ignoreCase)).Count
            Set-Content -LiteralPath $f.FullName -Value $redacted -NoNewline
            # Reported, not silent, and this line is the mechanism's only audit trail. A redaction
            # inside settings.account.json or mcp-servers.json would mean a machine path the fold
            # table has no rule for, and rewriting it there produces a config that is wrong on the
            # receiver rather than merely neutral. Naming every redacted file makes that visible in
            # the export output beside the six prose files expected there, so the count itself is a
            # regression detector. Rejected making those two files a gate instead of a redaction:
            # that is a per-file rule for a failure with no live instance, and this line surfaces
            # it for one line of code and no new table.
            Write-Host "  ${rel}: redacted $n workstation-username occurrence(s)"
            $body = $redacted
        }

        foreach ($check in $identityChecks) {
            if ([regex]::IsMatch($body, $check.Regex, $ignoreCase)) {
                # Names the file and the CLASS, never the matched value. Printing it would put the
                # string this gate exists to contain into console output, CI logs and any transcript
                # of the run -- the mandate covers every channel, not only the committed file. The
                # WSL gate above prints its match on purpose and the difference is deliberate: a
                # WSL home is a path the operator must locate and edit, an identity string is one
                # they already know and must not see copied around.
                throw "Refusing to complete the export: '$rel' carries the $($check.Class). Identifying information must never reach a remote repository (security.md), and only a human can waive that -- this script cannot. The matched value is deliberately not printed. Remove it at source under '$ClaudeHome', then re-run."
            }
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
    Write-Host "Export complete. Review with: git diff account/claude"
}
