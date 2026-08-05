# Core Backlog

Ordered work queue for `agent-harness-core`. Items are promotion candidates,
patterns to extract, or unresolved decisions surfaced during real sessions.
`soc-monitor` and `doc-steward` treat this file as the canonical backlog.

---

## 1. Promote agent-usage delegation stance into core (or a pattern doc)

**Status:** proposed. Promote on second recurrence, per `harness-core.md` findings flow.
**Surfaced:** 2026-08-04, TrueNAS HAOS zvol forensics session.

### What happened

Global `~/.claude/rules/agent-usage.md` carried two rules pulling in opposite
directions:

- **Reduce Noise** (delegate any 2+ call investigation sequence to a cheap agent).
- **SSH / Remote Work Note**, whose earlier wording said "prefer direct commands for
  remote host work," read as a blanket license to run long SSH forensic sweeps
  inline.

In a live session the second reading won by default and ~20 inline
`ssh … docker exec … | grep` / python probes ran in the main context instead of
being delegated. The operator flagged it: "I see you combing through ssh commands
yourself."

### Fix already applied (global only)

Reconciling edits to `~/.claude/rules/agent-usage.md`:

1. **Reduce Noise** extended to name remote/SSH sweeps explicitly. Log greps,
   `zfs`/`zpool` history, bundle extraction, and snapshot walks are the
   wall-of-output case. Added a self-check: if a `haiku` agent could run the exact
   command with no session-specific state, and output is bulky or it's call 2+ of a
   chain, it is not inline.
2. **SSH note** narrowed so inline remote applies only when the work depends on
   session-specific state the agent won't inherit (interactive login, env var,
   shell/cwd state). Self-contained remote investigation goes to a cheap agent.
   Explicitly records that the old "prefer direct commands" reading contradicted
   Reduce Noise and lost on the merits.

### Backlog decision

The rules files are not core-managed today (they live only in global
`~/.claude/rules/`; core references them via `guardrails.template.md` placeholders).
Decide whether this reconciliation should:

- (a) stay global-only, or
- (b) be captured in core as a delegation pattern doc under `patterns/`, or
- (c) be baked into `guardrails.template.md` so every installed project inherits the
  session-state-vs-delegate boundary.

An advisory Stop hook, `dispatch-audit.ts`, was since written to mechanize this rule; it installs
opt-in (not wired by `settings.hooks.json`; see its header for the registration snippet), which
partly answers (b)/(c) and narrows what's actually open to whether the installer should wire it in
by default, not whether a mechanism belongs in core at all.

Promote when a second project or session hits the same "inline remote sweep that
should have been delegated" failure class. First documented occurrence is this note.

---

## 2. Installer bun preflight check

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 adversarial review of `dispatch-audit.ts`.

`settings.hooks.json` invokes bare `bun` for every TypeScript hook. If `bun` is absent from PATH,
the hook command exits 127, which Claude Code treats as non-blocking, so dispatches proceed
ungated with no enforcement. This is a documented, reasoned fail-open contract (`README.md:29`,
`agent-worktree-gate.ts` header lines 44-49) and the failure is loud, a stderr hook-error notice
fires per dispatch, so a `Get-Command bun` warning in `install/Install-Harness.ps1` (about 3
lines) at install time is the proportional fix. Not a shim that hard-blocks; a preflight warning
only.

## 3. Three templates are never installed

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 adversarial review.

`core/claude/templates/agent-def-authoring.template.md`, `reviewer-lockout-protocol.template.md`,
and `untrusted-content-boundary.template.md` are copied by no installer path;
`install/Install-Harness.ps1` copies templates by explicit name only (`guardrails`,
`scratch.gitignore`, `ceremony-ledger`, `settings.hooks.json`). Open question: wire the three into
the installer, or move them out of `core/claude/templates/` since that path implies installation.
Harmless today, needs a decision.
