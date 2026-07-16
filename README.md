# Agent Harness Core

This repo holds the process layer for running AI coding agents on a project: charter-backed agent roles, session hooks, and the pattern docs that explain why they're built this way. It was extracted from a working harness rather than designed up front, so everything here has already been through at least one real project.

## Layering model

Three layers make up a working setup. This repo is the core layer: the shared agent definitions, hooks, and templates that apply to any project. `~/.claude` is the user's global layer, already carrying personal skills and rules that apply across every repo the user touches. A project's own `.claude/` directory is the installed copy of core plus whatever that project adds on its own.

The rule that keeps these from drifting into a mess: core is upstream. Projects never edit an installed file in place. If a project needs something different, it adds a project-local file alongside the installed one rather than changing it, and if the change turns out to be broadly useful, it goes back to core through the flow in CONTRIBUTING.md. Editing installed files directly is how forks rot: the next install silently overwrites the edit, or the project drifts far enough that re-installing breaks it.

## What's here

| Path | Contents |
|---|---|
| `core/claude/agents/` | Four charter-backed agent roles |
| `core/claude/hooks/` | Worktree gate, session guardrails, wave-close handoff |
| `core/claude/templates/` | `guardrails.md`, a settings fragment, and a ceremony ledger template |
| `patterns/` | Seven docs explaining the design behind the above |
| `install/` | The installer that copies core into a project's `.claude/` |

## What's deliberately absent

The TypeScript code that originally sat alongside this process layer, a store, a planner seam, a dashboard, a way to score agent runs, stays in `spacemolt` for now. None of it is reusable as-is; the pattern docs here describe the design so a second project can build it in whatever language fits, rather than importing code that assumes one specific stack. If a second TypeScript project ever needs the same code, that's the point to reconsider vendoring it here.

Skills already global in `~/.claude` (prose review, prose linting, council review, session handoff, and the memory system) are assumed to already be on the machine and are not duplicated here.

## Install

```
pwsh install/Install-Harness.ps1 -Target <project-root>
```

## Source

This repo was extracted from `E:\projects\spacemolt`. For the original design writeup, see that project's `docs/anatomy-of-the-harness.md`.
