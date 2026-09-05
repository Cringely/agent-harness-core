#Requires -Version 5.1
<#
    Lint-DocumentProse.ps1  —  PostToolUse (Write|Edit) advisory prose gate.

    Runs the personal Vale kit against a document after it is written/edited and
    surfaces AI-tell findings back into the session as additionalContext. Advisory,
    never blocking (matches the prose-lint skill's "not a gate" contract).

    Scope: Markdown only. Skips generated / non-deliverable churn so everyday note
    and dependency writes stay silent. Emits nothing when the file passes.

    Wired in ~/.claude/settings.json PostToolUse -> Write|Edit.
#>

$ErrorActionPreference = 'Stop'

# PostToolUse feeds the tool call as JSON on stdin.
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $payload = $raw | ConvertFrom-Json
    $file = $payload.tool_input.file_path
} catch { exit 0 }   # malformed payload: stay quiet, never break the write

if ([string]::IsNullOrWhiteSpace($file)) { exit 0 }

# Normalize separators so path filters match regardless of slash style.
$norm = $file -replace '\\', '/'

# Markdown deliverables only.
if ($norm -notmatch '\.(md|markdown)$') { exit 0 }

# Skip generated / non-deliverable paths (case-insensitive). Agent-consumed
# surfaces belong here alongside generated ones: memory notes and handoffs are
# briefs to a later session, not prose deliverables, so the full-prose contract
# is the wrong authority for them. The handoff template mandates the em dashes
# Vale flags, so linting them reported the format as a defect.
#
# Scratch and report files are that same surface. agent-usage.md makes a scratch
# file the only return channel from a subagent back to its dispatcher, so every
# subagent report lands under a session scratchpad: over two thousand markdown
# files on this machine, not one of them written for a human reader. The count
# moves with every session, so it is not recorded as a digit here.
#
# Council transcripts and the Obsidian mirror are the same traffic. Both were
# silent only by accident until now, council transcripts because they happen to
# sit under /.claude/, the mirror because its sync hook copies with Copy-Item and
# no PostToolUse matcher sees a file copy. Naming them keeps the exemption true if
# either one ever moves. The vault token is the SYNC TARGET, not the vault:
# Sync-MemoryToObsidian.ps1 writes only under 'Obsidian Vault\Claude Code', and
# the 20 hand-authored notes elsewhere in that vault are the operator's own prose,
# which has to keep linting.
#
# One token is deliberately absent. '/scratch/' without the dot would match any
# directory literally named "scratch", and a repo may keep real drafts in one;
# '/.scratch/' is unambiguously tool-created.
$skip = @(
    '/memory/', '/handoffs/', '/scratchpad/', '/.scratch/',
    '/council-transcripts/', '/obsidian vault/claude code/',
    '/node_modules/', '/.git/', '/.obsidian/', '/.claude/'
)

# A worktree is a checkout of a real repo. Rebase at its root so the skip list applies to
# the repo-relative tail, not to the .claude/ that merely hosts it.
$norm = $norm -replace '(?i)^.*/\.claude/worktrees/[^/]+/', '/'

foreach ($p in $skip) { if ($norm.ToLower().Contains($p)) { exit 0 } }

if (-not (Test-Path -LiteralPath $file)) { exit 0 }

# Nested two-argument Join-Path, one segment per call. Backslashes inside a single child
# argument are separators on Windows and ordinary filename characters on Linux, so the old
# one-argument form never resolved there and this advisory hook went silently inert. The
# multi-segment form Join-Path gained in PowerShell 6 is not usable here: this file declares
# #Requires -Version 5.1 at line 1, and Windows PowerShell 5.1 rejects a third positional
# argument outright.
function Get-ValeConfigPath {
    return (Join-Path (Join-Path (Join-Path (Join-Path $HOME '.claude') 'tools') 'prose-lint') '.vale.ini')
}

$config = Get-ValeConfigPath
if (-not (Test-Path -LiteralPath $config)) { exit 0 }

$vale = Get-Command vale -ErrorAction SilentlyContinue
if (-not $vale) { exit 0 }   # engine absent: advisory tool, no hard failure

# Vale exits non-zero when it finds something; that is not a hook error.
$findings = & $vale.Source --config $config --output=line $file 2>$null
$global:LASTEXITCODE = 0

if ([string]::IsNullOrWhiteSpace(($findings -join ''))) { exit 0 }   # clean: silent

$text = ($findings -join "`n").Trim()
$context = @"
Prose-lint (advisory) flagged AI-tells in the document just written: $file

$text

These are Vale findings, NOT a gate. Quoted text, code identifiers, and API names
trigger false positives, so call those out rather than "fixing" them. If real
tells remain, offer a beautiful_prose Edit-mode rewrite of the flagged passages.
"@

$out = @{
    hookSpecificOutput = @{
        hookEventName    = 'PostToolUse'
        additionalContext = $context
    }
} | ConvertTo-Json -Depth 4 -Compress

Write-Output $out
exit 0
