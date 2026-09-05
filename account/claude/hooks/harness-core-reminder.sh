#!/usr/bin/env bash
# SessionStart (global): in a git project without the agent-harness-core installed
# layer, print a one-line reminder that the core exists and how to install it.
# Silent everywhere else, and inside the core repo itself.
# Plain stdout lands as session-start context, same mechanism as the caveman hook.

d="${CLAUDE_PROJECT_DIR:-$PWD}"

case "$d" in
    *agent-harness-core*) exit 0 ;;
esac

# .git is a dir in a normal checkout, a file in a worktree.
[ -e "$d/.git" ] || exit 0
[ -f "$d/.claude/.harness-manifest.json" ] && exit 0

cat <<'EOF'
This project has no agent-harness-core layer (.claude/.harness-manifest.json missing). The core repo at {{CORE_REPO}} is the baseline process layer for dev projects: reviewer agents (task-reviewer, adversarial-reviewer, doc-steward), the worktree gate, and guardrails. Install when this project will run subagent or review work: pwsh {{CORE_REPO}}/install/Install-Harness.ps1 -Target <project-root> (add -IncludeCeremonies for ceremony projects; -Audit reports drift without writing). If the session starts real dev work here, offer the installer once; don't run it unasked.
EOF
exit 0
