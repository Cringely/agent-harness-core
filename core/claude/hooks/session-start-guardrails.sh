#!/bin/sh
# SessionStart hook (WARN-only, read + print, never blocks).
# Re-injects the top of the guardrails rule catalog into context at every
# session start, so the key judgment rules land in view instead of scrolling
# away after the first turn. Prints everything from the top of guardrails.md
# down to the `guardrails:session-start-end` marker line, then stops.
#
# Reviewed by the operator before merge: it only reads one repo file and writes
# to stdout. No arguments, no network, no mutation.
#
# Path resolution is relative to CLAUDE_PROJECT_DIR so this hook works
# unmodified in any project it's installed into — no repo name hardcoded here.

set -eu
# No pipeline here yet, but see session-start-drift-check.sh:42-46, "Guarded rather than bare",
# for why this stays guarded.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

# Copilot CLI also runs .claude/settings.json hooks (#227). Stand down there, but never while
# CLAUDECODE is set, so a Claude Code session always runs the rest.
if [ -n "${COPILOT_CLI:-}" ] && [ -z "${CLAUDECODE:-}" ]; then
    exit 0
fi

root="${CLAUDE_PROJECT_DIR:-.}"
catalog="$root/.claude/guardrails.md"

# Missing file is a no-op, not an error — never break a session start.
[ -f "$catalog" ] || exit 0

echo "=== Guardrails (repo forcing functions — re-injected each session) ==="
# Print up to, but not including, the marker line.
awk '/guardrails:session-start-end/ { exit } { print }' "$catalog"
echo "=== Full catalog: .claude/guardrails.md ==="

exit 0
