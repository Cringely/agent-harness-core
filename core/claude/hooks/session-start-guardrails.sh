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
# pipefail where the shell has it, so a failing command in a pipeline cannot be masked by a
# succeeding tail. Guarded rather than bare, and for the reason session-start-drift-check.sh
# states at length: `set -o pipefail` predates POSIX Issue 8, older /bin/sh implementations
# reject the option, and `set` is a special builtin whose error aborts a non-interactive
# shell. Bare, this hook would die on this line on such a host and take the session start
# with it. The subshell absorbs that abort.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

root="${CLAUDE_PROJECT_DIR:-.}"
catalog="$root/.claude/guardrails.md"

# Missing file is a no-op, not an error — never break a session start.
[ -f "$catalog" ] || exit 0

echo "=== Guardrails (repo forcing functions — re-injected each session) ==="
# Print up to, but not including, the marker line.
awk '/guardrails:session-start-end/ { exit } { print }' "$catalog"
echo "=== Full catalog: .claude/guardrails.md ==="

exit 0
