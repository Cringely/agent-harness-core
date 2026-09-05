# ~/.claude/statusline-command.ps1
# Renders a compact context consumption bar for Claude Code status line.

$input = $Input | Out-String
if (-not $input.Trim()) {
    Write-Host "ctx: --" -NoNewline
    exit 0
}

$data = $input | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $data) {
    Write-Host "ctx: --" -NoNewline
    exit 0
}

$model = $data.model.display_name
$used = $data.context_window.used_percentage
$inputTokens = $data.context_window.current_usage.input_tokens

if ($null -eq $used) {
    Write-Host "$model  ctx: --" -NoNewline
    exit 0
}

$usedInt = [math]::Round($used)

# Build a 10-char bar using ASCII: # filled, - empty
$filled = [math]::Floor($usedInt / 10)
$empty = 10 - $filled
$bar = ('#' * $filled) + ('-' * $empty)

# Format token count as truncated K or M
if ($null -ne $inputTokens -and $inputTokens -ge 1000000) {
    $tokLabel = "{0:F1}M" -f ($inputTokens / 1000000)
} elseif ($null -ne $inputTokens -and $inputTokens -ge 1000) {
    $tokLabel = "{0:F1}K" -f ($inputTokens / 1000)
} elseif ($null -ne $inputTokens) {
    $tokLabel = "$inputTokens"
} else {
    $tokLabel = "--"
}

Write-Host "$model  ctx: [$bar] $usedInt% ($tokLabel)" -NoNewline
