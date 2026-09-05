#!/usr/bin/env bash
# ~/.claude/statusline-command.sh
# Renders a compact context consumption bar for Claude Code status line.

input=$(cat)

used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
input_tokens=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // empty')

if [ -z "$used" ]; then
  printf '%s  ctx: --' "$model"
  exit 0
fi

used_int=$(printf '%.0f' "$used")

# Build a 10-char bar: filled blocks vs empty
filled=$(( used_int / 10 ))
empty=$(( 10 - filled ))

bar=""
for i in $(seq 1 $filled); do bar="${bar}█"; done
for i in $(seq 1 $empty);  do bar="${bar}░"; done

# Color: green <50%, yellow 50-79%, red >=80%
if   [ "$used_int" -ge 80 ]; then color="\033[31m"   # red
elif [ "$used_int" -ge 50 ]; then color="\033[33m"   # yellow
else                               color="\033[32m"   # green
fi
reset="\033[0m"

# Format token count as truncated K or M
if [ -n "$input_tokens" ] && [ "$input_tokens" -ge 1000000 ] 2>/dev/null; then
  tok_label="$(echo "$input_tokens" | awk '{printf "%.1fM", $1/1000000}')"
elif [ -n "$input_tokens" ] && [ "$input_tokens" -ge 1000 ] 2>/dev/null; then
  tok_label="$(echo "$input_tokens" | awk '{printf "%.0fK", $1/1000}')"
elif [ -n "$input_tokens" ]; then
  tok_label="${input_tokens}"
else
  tok_label="--"
fi

printf '%s  ctx: '"$color"'%s'"$reset"' %d%% (%s)' "$model" "$bar" "$used_int" "$tok_label"
