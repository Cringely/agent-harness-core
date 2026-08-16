# Guardrails: the rules this project keeps dropping, and what catches them

**Read this first, every session.** This file is a catalog of judgment rules that got written
down once and then missed anyway, plus the mechanism that catches each one. The lesson behind
the whole file: an agent is not made reliable by better instructions. Reliability comes from a
forcing function that fires at the moment a rule is relevant. Every rule dropped in a session was
already written down somewhere; louder prose would not have helped. A missed rule is a gap in the
setup, not a willpower failure.

## The hierarchy (prefer the earliest tier that fits)

1. **Automate it away** (the system just does it, nothing to remember). Best for mechanical
   rules. Example: a doc-reconciliation pass regenerates the status doc after every merge batch,
   so nobody has to remember to update it by hand.
2. **Gate the trigger** (a hook or check fires at the exact action and reminds, or in rare
   cases blocks). Best for must-do-at-a-known-moment rules. Example: a post-merge reminder to
   refresh the docs.
3. **Re-inject just in time** (surface the rule into context the moment its trigger fires, not
   buried at session start where it scrolls away). Best for judgment rules no script can perform
   for you. Example: this file's top block, re-shown at every session start.
4. **Prose / convention** (written down and enforced by review, nothing more). The weakest tier;
   use it only for rules that actually resist automation, and treat a repeated miss on a prose
   rule as a signal to move it up a tier.

Everything project-specific lives in this repo, not at the account level, so it stays versioned,
portable, and reviewable alongside the code it governs.

The plugin/skill stack this project assumes (documented below) is recorded per-machine in `.claude/.harness-manifest.json` under `stackDetected`, and a skill you expect may simply be absent here.

<!-- guardrails:session-start-end — the SessionStart hook prints everything ABOVE this line. Keep the key just-in-time rules above it, and keep that block short: it lands in every fresh context. See agent-harness-core's patterns/always-on-context-budget.md for why this and the other unconditionally-loaded surfaces (rules files, skill descriptions) are the real budget, not agent count. -->

## Example rules

The rows below are worked examples, not a starter set to keep verbatim. Replace them with the
project's own recurring misses; delete any that don't apply. A rule whose Mechanism column names
JIT re-injection must have its one-line statement placed above the
`guardrails:session-start-end` marker; the session-start hook only prints what comes before that
marker, so a JIT rule left below it never gets printed.

| Rule | Statement | Mechanism | Tier |
|---|---|---|---|
| **Worktree isolation for repo-writing dispatches** | A repo-writing agent dispatched into the shared checkout collides with whatever the dispatcher is editing. | `PreToolUse` hook on the agent-dispatch tool denies the call unless isolation is set or a written override is given. | gate |
| **Doc-size discipline** | Living docs (a status doc, a decision log) drift from a concise summary into essay-length entries, one plausible addition at a time. | A size check runs in CI or as a pre-commit step, fails on the offending entry, and names it. | automate |
| **Independent review, never self-review** | A context that wrote a change re-reads its own assumptions as facts, so the author is a poor reviewer of it. | Session-start reminder, plus the reviewer role's own definition states the precondition explicitly. | JIT + convention |
| **Every dispatch names its model tier** | An agent dispatched with no `model` inherits the session model, so the expensive tier becomes the default for work that never needed it, and a `sonnet` agent that does not also state `effort: "xhigh"` throws away the reason sonnet was picked. | `PreToolUse` hook on the agent-dispatch tool denies a dispatch naming no tier or an unrecognized one, without judging whether the tier chosen is right. It reads a workflow script's `agent()` call sites the same way, on a workflow tool name that is inferred rather than confirmed against a captured payload. Write `MODEL-OVERRIDE: <reason>` in the prompt or the script to dispatch without choosing. | gate |
| **Challenge mandate** | Whoever holds the coordinating seat (orchestrator, planning agent, or council chair) is required to question the human and challenge low-value ideas before executing them: one clear challenge, then commit the decision and move on. Applies to weak agent findings the same way it applies to human requests. | Session-start reminder carries the prose rule; the adversarial-reviewer role is the mechanical twin for anything that needs a harder, structured pass than a reminder can give. | prose + gate (adversarial-reviewer) |

## Why only a few hooks, not many

Every hook is a candidate for becoming the thing operators mute because it fires wrong too often.
A false positive gets muted, and a muted hook protects nothing. Before adding a new gate, check
whether a cheaper tier already covers the rule, and write down what was considered and rejected.
Future maintainers need that reasoning as much as the rule itself.

## `core.hooksPath` and other hook managers

The installer points git's `core.hooksPath` at `.claude/hooks` so `pre-commit` (the prose-lint
gate) fires on every commit, however the file got edited: script-applied patch, agent write, or
hand-edit alike. Git reads hooks from exactly one directory per repo, so if this project later
adopts husky or the `pre-commit` framework, both of which also want `core.hooksPath`, whichever
tool sets it last wins and the other's hooks stop firing silently. That is inherent to how git
resolves hooks, not a defect in the installer's wiring: the installer only checks for existing
hooks *at install time*, so it has no way to see a hooksPath claimed by a tool adopted afterward.

If hooks stop firing after adding husky or pre-commit-framework, check `git config
core.hooksPath` first. Resolution is manual: pick which tool owns the directory, then either
have its config call the other's script directly, or symlink/copy `.claude/hooks/pre-commit`
into the winning tool's hook chain.

## Assumed plugin and skill stack

This project's process assumes a specific set of Claude Code plugins and personal skills is
active. None of that is installed by this project. Plugins live at
`~/.claude/plugins/cache/<marketplace>/<plugin>/`, account scope, and this installer has no way
to put one there or take one away. What it can do is record what it actually found on the local
machine, in `.claude/.harness-manifest.json` under `stackDetected` (`scannedAt` plus `plugins`,
`outputStyles`, and `mcpServers` lists). Treat that field as the source of truth for this machine,
and this section as the aspiration everyone is building against. A skill named here that isn't in
`stackDetected` is missing, not broken; work around its absence rather than assuming a step
happened that didn't. `mcpServers` matters as much as `plugins`: `code-context`'s absence, for
example, means search falls back to Grep/Glob per `agent-usage.md`, a real behavior change and
not a cosmetic gap.

The assumed stack:

- **superpowers** (process skills: brainstorming, planning, TDD, systematic debugging,
  subagent-driven execution).
- **caveman** and **ponytail** (output and build discipline). Caveman compresses register: drops
  articles, filler, hedging. Ponytail pushes toward the smallest working solution and a short,
  code-first answer.
- **code-review** (the review skill invoked for pull request and diff review passes).
- **claude-security** (a multi-phase security scan pipeline: inventory, threat model, sweep, and a
  three-lens adversarial panel with a code-computed tally). Opened with `/claude-security`, which
  collects scan settings before running. This overlaps `security-auditor`, an agent definition that
  lives in the account layer rather than one this harness installs (core holds process roles only,
  domain specialists moved out; see `CONTRIBUTING.md`). The agent and the plugin aren't
  interchangeable: one is a single reviewer definition, the other an orchestrated multi-agent run.
  Reach for the account-layer agent on a diff, the plugin on a codebase.
- Personal skills at `~/.claude/skills/`: **beautiful_prose** (canonical banned-vocabulary
  contract for prose deliverables), **prose-lint** (the Vale check this file's own pre-commit hook
  runs), **memory-system** (write/recall/lint rules for persistent memory notes), and
  **subagent-prompting** (brief anatomy and per-model prompting notes).

### When two of these disagree

Caveman, ponytail, and `~/.claude/rules/writing-style.md` each specify how output should read, and
they cover overlapping ground: register, length, banned words, structure. Where they collide on
output register, `writing-style.md`'s surface-routing table (file-based prose vs. code comments
and briefs vs. user-facing chat) is the existing arbiter. It names which register applies on which
surface, and `beautiful_prose` is canonical for the banned-vocabulary list that table mirrors.

For every other kind of overlap between these layers, there is no agreed precedence yet. Don't
invent one in the moment; note the conflict and ask, or use judgment and flag the call you made so
it can be settled later.

## Project-specific rules

<!-- Add this project's own recurring misses below, one row per rule, same table shape as above.
     Keep the catalog to rules that have actually been missed at least once — this is not a
     wishlist of things that could theoretically go wrong. -->

| Rule | Statement | Mechanism | Tier |
|---|---|---|---|
| _none yet_ | | | |
