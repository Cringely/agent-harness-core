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
