# Agent Harness Core — Engagement Reminders

Core repo: `{{CORE_REPO}}` (public remote: github.com/Cringely/agent-harness-core). Full context in memory note `agent-harness-core`.

## New or unequipped project

When a session starts real work in a dev project whose `.claude/` lacks the core process layer (no `.harness-manifest.json`), remind the user once per project:

```powershell
pwsh {{CORE_REPO}}/install/Install-Harness.ps1 -Target <project-root>
```

Add `-IncludeCeremonies` only for projects running standup/wave ceremonies. Prereqs: pwsh 7, bun on PATH (worktree gate no-ops silently without it), Git Bash for shell hooks. After install, suggest filling guardrails.md's project section and `{{PROJECT}}` placeholders. Don't run the installer unasked; offer it.

## After install, use what's there

- Dispatch `task-reviewer` / `adversarial-reviewer` for that project's reviews instead of ad-hoc general-purpose reviewers.
- `doc-steward` after merges that touch living docs. It stays on its cheap tier for reconciliation (citations, dates, status lines, stale references); when the repair is rewritten sentences rather than a corrected fact, that half goes to a Fable agent per `agent-usage.md`.
- The worktree gate will deny unisolated write-agent dispatches; that's intended, use isolation instead of fighting it.

## Account layer, on this machine and on any other

`~/.claude/` is authored here and distributed through the core repo. One direction: a
divergence on another machine is a bug, not a fork.

After changing anything under `~/.claude/rules/`, `agents/`, `skills/`, `hooks/` or
`tools/prose-lint/`, or after a settings change worth keeping, export it:

```powershell
pwsh -NoProfile -File {{CORE_REPO}}/install/Export-Account.ps1
```

Then review `git diff account/claude` in the core repo and commit. A second export with
nothing changed produces no content diff, so anything the diff shows is a real change.

Use `git diff` here and not `git status`. The export writes LF, a Windows checkout writes CRLF,
and a no-change re-export therefore flips the working-tree line endings without touching the
index. Measured 2026-09-05 on a clean tree: `git status --short` listed 203 modified paths where
`git diff --exit-code` returned 0. To put the endings back afterwards, run
`git checkout -- account/claude`; the content is identical, so nothing is lost.

On a second machine, after `git pull` in the core repo:

```powershell
pwsh -NoProfile -File {{CORE_REPO}}/install/Install-Account.ps1
```

Do not hand-edit `account/claude/` in the repo. It is generated, and the next export overwrites
it. Fix the source under `~/.claude/` and export again.

## Findings flow (both channels)

1. Capture findings as memory notes during work (cheap, always).
2. Second occurrence of a failure class or useful pattern across projects: promote it — commit to the core repo (pattern doc, agent def, hook, or template edit), push, shrink notes to pointers. Never blind-edit installed copies in a project; change core, re-run installer.

## Architecture reuse

Building an agent system in any language: start from `patterns/INDEX.md` in the core repo. Stage-2 TS code extraction is deferred; propose it when a second TypeScript project needs the store/planner/dashboard code.
