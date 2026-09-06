# install/AccountShared.ps1
#
# Dot-sourced by Export-Account.ps1 and Install-Account.ps1. Holds the payload tables the two
# must agree on, and lifts three path functions out of Restore-ClaudeProject.ps1.
#
# The lift, rather than a copy: those functions live inside a script with two mandatory
# parameters, so dot-sourcing it would prompt. A second copy of Get-ProjectSlug would drift
# from Restore's the moment either was edited, and the slug rule is the one place where a
# silent divergence produces session folders that look healthy while --resume reports nothing.
# Restore-ClaudeProject.Tests.ps1:8-17 already lifts the same three the same way.

$restoreScript = Join-Path $PSScriptRoot 'Restore-ClaudeProject.ps1'
$restoreAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $restoreScript, [ref]$null, [ref]$null)
$restoreDefs = @($restoreAst.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
foreach ($fnName in 'Get-ProjectSlug', 'Convert-HookCommand', 'Test-ResidualWindowsPath') {
    $fn = @($restoreDefs | Where-Object { $_.Name -eq $fnName })
    # Without this, a rename in Restore leaves both scripts calling an undefined function with
    # no signal until someone runs an export.
    if ($fn.Count -eq 0) { throw "Restore-ClaudeProject.ps1 no longer defines $fnName" }
    . ([scriptblock]::Create($fn[0].Extent.Text))
}

# --- payload tables -----------------------------------------------------------
# The allowlist. Nothing else under ~/.claude is looked at, so a new runtime directory
# appearing there is excluded by default rather than swept into the repo.
$script:AccountTreeDirs = @('rules', 'agents', 'skills', 'tools/prose-lint', 'hooks')
$script:AccountRootFiles = @('statusline-command.ps1', 'statusline-command.sh')

# Payload-relative paths that never travel. model-tier-gate.ts is core-owned: the installer
# copies it from core/claude/hooks/ in the same clone, and two copies in one repo would drift.
# The HANDOFF is internal agent traffic naming a script that no longer exists under that name.
$script:AccountSkipFiles = @('hooks/model-tier-gate.ts', 'hooks/Guard-ModelTier.HANDOFF.md')

# Payload-relative directory prefixes that never travel, whole subtree, regardless of what
# files end up inside them. Operator ruling on the review's N1 finding: skills/appsec-kpi-deck
# is a spec for a corporate deliverable and must not be published, but the operator keeps using
# it locally, so it stays in ~/.claude and is excluded only at export -- the same deliberate
# live-tree-versus-payload divergence Copy-AccountTree already carries for .git internals and
# every *.bak file, just declared here instead of hardcoded into that function, since a whole
# skill is a policy decision rather than a file-shape rule. A prefix match rather than the two
# exact files it holds today: a future file added under this skill (a second reference doc, an
# asset) must not need a second entry here to stay excluded.
$script:AccountSkipDirs = @('skills/appsec-kpi-deck')

# Model-read text carrying machine paths. A hook derives its paths at run time and is fixed at
# source; these cannot be, because a placeholder written into the live file is read literally by
# the model on this box. Export folds, install expands. The table is an allowlist for the same
# reason the tree is: rules/ssh.md and rules/change-management.md name this machine on purpose
# and must not be touched.
$script:AccountTemplatedFiles = [ordered]@{
    'rules/harness-core.md'              = @('CORE_REPO')
    'hooks/harness-core-reminder.sh'     = @('CORE_REPO')
    'skills/prose-lint/SKILL.md'         = @('CLAUDE_HOME')
    'skills/handoff/SKILL.md'            = @('OBSIDIAN_VAULT')
    'skills/council/SKILL.md'            = @('HOME_SLUG')
    'skills/subagent-prompting/SKILL.md' = @('OBSIDIAN_VAULT', 'HOME_SLUG')
}

# Resolves the main checkout even when called from a worktree under .claude/worktrees/, which
# is where this repo's own write agents run. Measured on git 2.53.0: --path-format=absolute
# --git-common-dir returns E:/projects/agent-harness-core/.git from both the main checkout and
# from a worktree, so the parent is the main checkout in both cases. Folding a worktree path
# would produce a token that matches nothing on the next export.
function Get-MainCheckout {
    param([string]$StartDir)
    # Get-Command first. `& git` with no git on PATH is a terminating CommandNotFoundException
    # that 2>$null does not swallow, so without this the caller gets that message instead of
    # the actionable one below.
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is not on PATH, so the main checkout cannot be resolved from '$StartDir'. Pass -CoreRepo explicitly."
    }
    $common = & git -C $StartDir rev-parse --path-format=absolute --git-common-dir 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $common) {
        throw "Could not resolve the main checkout from '$StartDir'. Pass -CoreRepo explicitly."
    }
    return ((Split-Path $common -Parent) -replace '\\', '/')
}

# Canonicalises one path for a containment comparison: resolves reparse points (NTFS junctions,
# directory symlinks), expands 8.3 short components, and strips a \\?\ extended-length prefix.
# Returns an absolute path with no trailing separator. Callers compare the values this returns and
# keep their own parameters spelled the way the operator typed them.
#
# Backlog item 19 puts it here rather than in either script: Install-Account.ps1's
# -PayloadRoot/-ClaudeHome pair and Export-Account.ps1's -OutputRoot/-ClaudeHome pair have the
# identical gap, and a copy in one script leaves the other comparing raw strings.
#
# Reproduced on this tree before the fix, not inferred: Install-Account.ps1's -ClaudeHome spelled
# as an NTFS junction whose target sat under -PayloadRoot walked straight past the old string
# guard, and the copy then wrote its own destination back into its own source -- 22, 33, 44, 55
# files over four consecutive runs, one more rules\nested\ level each time, deepest path
# rules\nested\rules\nested\rules\nested\rules\nested\skills\prose-lint. An 8.3 short component
# and a \\?\ extended-length prefix get past a string comparison the same way, without compounding.
#
# Resolved by asking the filesystem what each path component really is, rather than by adding more
# string cases. Walking one component at a time from the root is what makes an INTERMEDIATE reparse
# point visible: measured, ResolveLinkTarget on a path below a junction returns null, because only
# the junction itself is a link. Get-Item's FullName expands an 8.3 component on the way past
# (measured: ...\PROBE-~1\REALTA~1 comes back fully spelled), so that case needs no separate
# handling.
#
# Three simpler alternatives were rejected. [System.IO.Path]::GetFullPath and Convert-Path are the
# first two: both leave a junction spelled as the junction, measured, so neither closes the case
# that compounds. The third is refusing any reparse point found AT either root rather than
# resolving it, which would refuse the run outright on a machine whose ~/.claude is itself a
# junction -- a layout these tools have no reason to reject, and one the operator would hit as a
# hard failure rather than as a warning.
#
# A reparse point INSIDE one of the trees is the case backlog item 19 actually floats ("whether a
# junction inside the tree being copied is worth refusing outright rather than resolving"), and it
# is likewise not refused. Measured on the fixed installer during the review that asked for this
# note: the guard does not fire, the copy proceeds, and it dies on "Cannot overwrite the item ...
# with itself", with the payload staying at 11 files across three consecutive runs -- so no
# compounding and no data loss. Refusing it outright would therefore buy the installer no safety it
# does not already have, while rejecting in-tree link layouts that complete or fail harmlessly
# today. Recorded here rather than left open because the same shape on Export-Account.ps1 lands in
# Copy-AccountTree's delete-then-recopy path, where the failure mode is deletion rather than a
# refused overwrite; whoever takes that side should decide it against that behaviour rather than
# inherit this answer.
#
# Components that do not exist yet are appended verbatim: Install-Account.ps1's -ClaudeHome
# routinely does not exist before the first install, and nothing can be reparsed through a
# directory that is not there.
function Resolve-ContainmentPath {
    # -OnWindows is a parameter, not a read of the caller's $onWindowsHost. No file under install/
    # sets Set-StrictMode, so reading an unassigned variable yields $null with no error, and
    # Export-Account.ps1 resolves its paths before it assigns that flag: a function reading
    # ambiently would skip the \\?\ strip there silently, leaving that one spelling past the guard
    # while every test still passed. The default is computed here for the same reason it is not
    # left to [bool]'s implicit $false, which is the same silent skip by another route.
    # [Parameter(Mandatory)] was the other candidate and was rejected because a missing mandatory
    # parameter prompts on stdin rather than failing fast in a non-interactive run.
    param(
        [string]$Path,
        [bool]$OnWindows = (($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows)
    )
    $p = $Path
    # Stripped rather than resolved: every API measured (GetUnresolvedProviderPathFromPSPath,
    # Get-Item.FullName, Convert-Path, GetFullPath) carries a \\?\ prefix through verbatim, so
    # leaving one on turns every later comparison into a mismatch. Windows-only, since a
    # backslash is an ordinary filename character on Linux.
    if ($OnWindows) {
        if ($p.StartsWith('\\?\UNC\')) { $p = '\\' + $p.Substring(8) }
        elseif ($p.StartsWith('\\?\')) { $p = $p.Substring(4) }
    }
    $p = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p)

    $root = [System.IO.Path]::GetPathRoot($p)
    if (-not $root) { return $p.TrimEnd('\', '/') }
    $seps = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $cur = $root
    foreach ($part in $p.Substring($root.Length).Split($seps, [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $next = Join-Path $cur $part
        $item = Get-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
        if (-not $item) { $cur = $next; continue }
        $cur = $item.FullName
        # $true, not $false: a junction can point at another junction, and the final target is
        # the only spelling that compares. Measured safe on a DANGLING junction (target already
        # deleted): it returns the recorded target rather than throwing, so no try/catch here.
        $link = $item.ResolveLinkTarget($true)
        if ($link) { $cur = $link.FullName }
    }
    return $cur.TrimEnd('\', '/')
}
