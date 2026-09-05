# Syncs Claude Code memory files and council transcripts to Obsidian vault on every Write|Edit.
# Called by PostToolUse hook; receives JSON on stdin.
# Structure: Claude Code/<project>/Memory/ for standard projects,
#            Claude Code/<project>/Worktrees/<name>/Memory/ for worktrees,
#            Claude Code/<project>/Council/ for council transcripts.

$ErrorActionPreference = 'SilentlyContinue'

$j = [Console]::In.ReadToEnd() | ConvertFrom-Json
$f = $j.tool_input.file_path
if (-not $f) { exit 0 }

$np = $f -replace '/', '\'

# Every comparison below runs against $np, which is backslash-normalised on the line above.
# Derived roots go through the same replace and keep the trailing separator, or a Join-Path
# result stays forward-slashed on Linux and no StartsWith ever matches. Nested two-argument
# Join-Path throughout: this hook runs under "shell": "powershell", and that host may be
# Windows PowerShell 5.1, where a third positional argument is a binding error.
$claudeHome = (Join-Path $HOME '.claude') -replace '/', '\'

# The rule Get-ProjectSlug applies (Restore-ClaudeProject.ps1:151-170), inlined. -creplace,
# not -replace: .NET's IgnoreCase regex folds U+212A KELVIN SIGN onto 'k' and would leave it
# unreplaced, while Claude Code's own ordinal JS regex always replaces it.
$homeSlug = $HOME.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'

$vaultBase = if ($env:CLAUDE_OBSIDIAN_VAULT) {
    $env:CLAUDE_OBSIDIAN_VAULT
}
else {
    Join-Path (Join-Path (Join-Path $HOME 'Documents') 'Obsidian Vault') 'Claude Code'
}

# --- Council transcripts ---
$councilRoot = ((Join-Path $claudeHome 'council-transcripts') -replace '/', '\') + '\'
if ($np.StartsWith($councilRoot)) {
    $rel = $np.Substring($councilRoot.Length)
    $sep = $rel.IndexOf('\')
    if ($sep -gt 0) {
        $proj = $rel.Substring(0, $sep)
        $file = $rel.Substring($sep + 1)
        $dest = Join-Path (Join-Path $vaultBase $proj) 'Council'
        New-Item -Path $dest -ItemType Directory -Force | Out-Null
        Copy-Item $f -Destination (Join-Path $dest $file) -Force
    }
    exit 0
}

# --- Superpowers plans/specs ---
# docs/superpowers/{plans,specs}/ in any repo -> Claude Code/<repo-dir-name>/{Plans,Specs}/
# ponytail: flat files only, repo name = dir containing docs/
# Worktree checkouts are skipped: their specs/plans are repo-canonical and land in the vault
# when the main checkout syncs; syncing them here created agent-<id> folders at the vault root.
if ($np -match '\\\.claude\\worktrees\\') { exit 0 }
if ($np -match '^(.*)\\docs\\superpowers\\(plans|specs)\\([^\\]+)$') {
    $proj = Split-Path $Matches[1] -Leaf
    if ($proj -eq '.claude') { $proj = $homeSlug }
    $kind = if ($Matches[2] -eq 'plans') { 'Plans' } else { 'Specs' }
    $dest = Join-Path (Join-Path $vaultBase $proj) $kind
    New-Item -Path $dest -ItemType Directory -Force | Out-Null
    Copy-Item $f -Destination (Join-Path $dest $Matches[3]) -Force
    exit 0
}
# Global ~/.claude/{plans,specs} (used when no repo) -> home project folder
if ($np -match ('^' + [regex]::Escape($claudeHome) + '\\(plans|specs)\\([^\\]+)$')) {
    $kind = if ($Matches[1] -eq 'plans') { 'Plans' } else { 'Specs' }
    $dest = Join-Path (Join-Path $vaultBase $homeSlug) $kind
    New-Item -Path $dest -ItemType Directory -Force | Out-Null
    Copy-Item $f -Destination (Join-Path $dest $Matches[2]) -Force
    exit 0
}

# --- Memory files ---
$memRoot = ((Join-Path $claudeHome 'projects') -replace '/', '\') + '\'
if (-not $np.StartsWith($memRoot)) { exit 0 }

$rel = $np.Substring($memRoot.Length)
$parts = $rel -split '\\memory\\', 2
if ($parts.Count -ne 2) { exit 0 }

$proj = $parts[0]
$file = $parts[1]

if ($proj -match '^(.+?)--claude-worktrees-(.+)$') {
    $dest = Join-Path (Join-Path (Join-Path (Join-Path $vaultBase $Matches[1]) 'Worktrees') $Matches[2]) 'Memory'
} else {
    $dest = Join-Path (Join-Path $vaultBase $proj) 'Memory'
}

New-Item -Path $dest -ItemType Directory -Force | Out-Null
Copy-Item $f -Destination (Join-Path $dest $file) -Force
exit 0
