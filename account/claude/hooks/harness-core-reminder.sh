#!/usr/bin/env bash
# SessionStart (global): in a folder with no agent-harness-core project layer, print a
# one-time nudge naming the installer. Silent in the core repo itself, in a folder that
# already has .claude/.harness-manifest.json, and for a folder already nudged.
# Plain stdout lands as session-start context, same mechanism as the caveman hook.
# State lives beside this script (../state), never under $HOME, which Git Bash can point
# at the wrong folder. Every path exits 0 and nothing here may abort the session start.

d="${CLAUDE_PROJECT_DIR:-$PWD}"

case "$d" in
    *agent-harness-core*) exit 0 ;;
esac

[ -f "$d/.claude/.harness-manifest.json" ] && exit 0

state="$(dirname "$0")/../state/harness-nudged.txt"
if [ -f "$state" ] && LC_ALL=C grep -Fxq -- "$d" "$state" 2>/dev/null; then
    exit 0
fi
# Best effort: an unwritable state location must not suppress the nudge.
{ mkdir -p "$(dirname "$state")" && printf '%s\n' "$d" >> "$state"; } 2>/dev/null

cat <<'NUDGE'
This folder has no agent-harness-core project layer (.claude/.harness-manifest.json is missing), so only the kernel rules from your account apply here. To add a project layer, run: pwsh {{CORE_REPO}}/install/Install-Harness.ps1 -Target <folder> -Layers <code,documents,physical>. Offer this once if the session starts real work here, and do not run it unasked. This reminder does not repeat for this folder.
NUDGE
exit 0
