# Syncs Claude Code memory files and council transcripts to Obsidian vault on every Write|Edit.
# Called by PostToolUse hook; receives JSON on stdin.
# Structure: Claude Code/<project>/Memory/ for standard projects,
#            Claude Code/<project>/Worktrees/<name>/Memory/ for worktrees,
#            Claude Code/<project>/Council/ for council transcripts,
#            Claude Code/<project>/{Plans,Specs}/ for superpowers plans and specs.
# <project> is the leaf of the project's checkout path, so one project checked out at
# different paths on different machines syncs into one folder. A project whose path this
# machine cannot resolve keeps its Claude Code slug.

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

# Vault folder names for this machine's projects, keyed by Claude Code slug. A slug cannot be
# turned back into a path on its own, because a '-' in it may have been a separator or part of
# a directory name, so the paths come from the projects map in $HOME/.claude.json. A worktree
# path stands for the repo it sits in. The home project keeps its slug, so no folder is named
# after the account's username. A project checked out at a .claude folder keeps its own slug
# too: mapping it onto the home slug would put two projects' MEMORY.md in one folder. A leaf
# that is not a plain folder name ('..', a drive root) is dropped and that project keeps its
# slug, so no write ever leaves the vault. Two checkouts that share a leaf share a folder,
# which is accepted.
function Get-VaultFolderMap {
    $map = @{}
    $cfg = Get-Content -Raw -LiteralPath (Join-Path $HOME '.claude.json') | ConvertFrom-Json
    foreach ($key in @($cfg.projects.PSObject.Properties.Name | Where-Object { $_ })) {
        $path = $key.TrimEnd('\', '/') -replace '/', '\'
        if ($path -match '^(.+)\\\.claude\\worktrees\\[^\\]+$') { $path = $Matches[1] }
        $slug = $path -creplace '[^A-Za-z0-9]', '-'
        $leaf = ($path -split '\\')[-1]
        if ($slug -eq $homeSlug -or $leaf -eq '.claude') { continue }
        if ($leaf -notmatch '^[^\\/:]+$' -or $leaf -match '^\.+$' -or $leaf -eq $slug) { continue }
        $map[$slug] = $leaf
    }
    return $map
}

# Moves the Memory, Council and Worktrees files of one vault folder into another. Those are
# the subfolders this hook writes, and a file some other writer put in the folder stays where
# its reader expects it. Where both hold a file, the newer copy stays. A file whose path in the
# target is a directory is left alone. The source folder is deleted only once no file is left
# in it, so a move that fails leaves its file in place for the next run to retry. Running it
# again after a full merge is a no-op, because the source folder is gone.
function Merge-VaultFolder([string]$From, [string]$To) {
    $root = (Get-Item -LiteralPath $From -Force).FullName.TrimEnd('\', '/')
    foreach ($src in @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)) {
        $rel = $src.FullName.Substring($root.Length + 1)
        if ($rel -notmatch '^(Memory|Council|Worktrees)[\\/]') { continue }
        $dst = Join-Path $To $rel
        if (Test-Path -LiteralPath $dst -PathType Container) { continue }
        $have = Get-Item -LiteralPath $dst -Force
        if ($have -and $have.LastWriteTimeUtc -ge $src.LastWriteTimeUtc) {
            Remove-Item -LiteralPath $src.FullName -Force
            continue
        }
        New-Item -Path (Split-Path $dst -Parent) -ItemType Directory -Force | Out-Null
        Move-Item -LiteralPath $src.FullName -Destination $dst -Force
    }
    if (@(Get-ChildItem -LiteralPath $root -Recurse -File -Force).Count -eq 0) {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}

# --- Council transcripts ---
$councilRoot = ((Join-Path $claudeHome 'council-transcripts') -replace '/', '\') + '\'
if ($np.StartsWith($councilRoot)) {
    $rel = $np.Substring($councilRoot.Length)
    $sep = $rel.IndexOf('\')
    if ($sep -gt 0) {
        $proj = $rel.Substring(0, $sep)
        $file = $rel.Substring($sep + 1)
        # Keyed like memory, so a council write never re-creates a merged slug folder.
        $folderOf = Get-VaultFolderMap
        if ($folderOf.ContainsKey($proj)) { $proj = $folderOf[$proj] }
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

# One-time merge of folders named by slug before the vault was keyed on the leaf. Each machine
# can resolve only its own slugs, so a folder synced in from another machine waits for that
# machine's hook to merge it.
$folderOf = Get-VaultFolderMap
foreach ($slug in @($folderOf.Keys)) {
    $old = Join-Path $vaultBase $slug
    if (Test-Path -LiteralPath $old -PathType Container) {
        Merge-VaultFolder $old (Join-Path $vaultBase $folderOf[$slug])
    }
}

if ($proj -match '^(.+?)--claude-worktrees-(.+)$') {
    $base = $Matches[1]
    $wt = $Matches[2]
    if ($folderOf.ContainsKey($base)) { $base = $folderOf[$base] }
    $dest = Join-Path (Join-Path (Join-Path (Join-Path $vaultBase $base) 'Worktrees') $wt) 'Memory'
} else {
    if ($folderOf.ContainsKey($proj)) { $proj = $folderOf[$proj] }
    $dest = Join-Path (Join-Path $vaultBase $proj) 'Memory'
}

New-Item -Path $dest -ItemType Directory -Force | Out-Null
Copy-Item $f -Destination (Join-Path $dest $file) -Force
exit 0
