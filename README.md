# Agent Harness Core

This is a process layer and pattern documentation, extracted from the SpaceMolt harness. It defines process-role agent definitions, session hooks, and design patterns for running AI coding agents on a project. This repo contains no code library, only the docs and ceremony layer that explain how and why the agent coordination works.

## Layering model

Three layers make up a working setup. This repo is the core layer: the shared agent definitions, hooks, and templates that apply to any project. `~/.claude` is the user's global layer, already carrying personal skills and rules that apply across every repo the user touches. A project's own `.claude/` directory is the installed copy of core plus whatever that project adds on its own.

The rule that keeps these from drifting into a mess: core is upstream. Projects never edit an installed file in place. If a project needs something different, it adds a project-local file alongside the installed one rather than changing it, and if the change turns out to be broadly useful, it goes back to core through the flow in CONTRIBUTING.md. Editing installed files directly is how forks rot: the next install silently overwrites the edit, or the project drifts far enough that re-installing breaks it.

## What's here

| Path | Contents |
|---|---|
| `core/claude/agents/` | Self-contained process roles `adversarial-reviewer`, `doc-steward`, `research-scout`, `soc-monitor`, `task-reviewer`. See `patterns/agent-def-shape.md` on why none point at a charter yet |
| `core/claude/hooks/` | Worktree gate, session guardrails, wave-close handoff, prose-lint-on-write |
| `core/claude/templates/` | `guardrails.template.md`, a settings fragment, and a ceremony ledger template |
| `patterns/` | The design docs behind the above, listed in [`patterns/INDEX.md`](patterns/INDEX.md) |
| `install/` | The installer that copies core into a project's `.claude/` |

## What's deliberately absent

The TypeScript code that originally sat alongside this process layer, a store, a planner seam, a dashboard, a way to score agent runs, stays in `spacemolt` for now. None of it is reusable as-is; the pattern docs here describe the design so a second project can build it in whatever language fits, rather than importing code that assumes one specific stack. If a second TypeScript project ever needs the same code, that's the point to reconsider vendoring it here.

Skills already global in `~/.claude` (prose review, prose linting, council review, session handoff, and the memory system) are assumed to already be on the machine and are not duplicated here.

## Install

Prerequisites: PowerShell 7 (`pwsh`); `bun` on PATH for the TypeScript hooks (`agent-worktree-gate.ts`,
`lint-doc-prose.ts`), without it the gates stop enforcing and Claude Code surfaces an error notice on
stderr per dispatch; Git Bash or another POSIX `sh` on Windows for the
two shell hooks (`session-start-guardrails.sh`, `wave-close-handoff.sh`). The prose-lint hook also
wants `vale` and the prose-lint styles kit on the machine; missing either degrades to an advisory
skip, never a blocked write.

```
pwsh install/Install-Harness.ps1 -Target <project-root>
```

`-IncludeCeremonies` also installs the ceremony components (the `soc-monitor` agent, the
`wave-close-handoff` hook, and the ceremony ledger), opt-in because they assume a project already
runs standup/wave ceremonies. `-Force` overwrites files the project has modified since install; the
default is to skip a modified file and warn, tracked via a SHA256 manifest of what was installed.

`-Audit` writes nothing and reports drift in both directions, using a three-way compare of core
source, the manifest hash, and the installed file: `project-modified` and `untracked (differs from
core)` files are candidates to promote upstream, `core-updated` and `not-installed` mean the project
should re-run the installer. This is the mechanical half of the findings flow in CONTRIBUTING.md;
run it periodically per project (SpaceMolt wires it into a `core_harvest` ceremony, see that
project's `docs/wiki/team-ceremonies.md`).

## Source

This repo was extracted from `E:\projects\spacemolt`. For the original design writeup, see that project's `docs/wiki/anatomy-of-the-harness.md`.
