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

<!-- guardrails:session-start-end — the SessionStart hook prints everything ABOVE this line. Keep the key just-in-time rules above it, and keep that block short: it lands in every fresh context. -->

## Example rules

These four rows are worked examples, not a starter set to keep verbatim. Replace them with the
project's own recurring misses; delete any that don't apply. A rule whose Mechanism column names
JIT re-injection must have its one-line statement placed above the
`guardrails:session-start-end` marker; the session-start hook only prints what comes before that
marker, so a JIT rule left below it never gets printed.

| Rule | Statement | Mechanism | Tier |
|---|---|---|---|
| **Worktree isolation for repo-writing dispatches** | A repo-writing agent dispatched into the shared checkout collides with whatever the dispatcher is editing. | `PreToolUse` hook on the agent-dispatch tool denies the call unless isolation is set or a written override is given. | gate |
| **Doc-size discipline** | Living docs (a status doc, a decision log) drift from a concise summary into essay-length entries, one plausible addition at a time. | A size check runs in CI or as a pre-commit step, fails on the offending entry, and names it. | automate |
| **Independent review, never self-review** | A context that wrote a change re-reads its own assumptions as facts, so the author is a poor reviewer of it. | Session-start reminder, plus the reviewer role's own definition states the precondition explicitly. | JIT + convention |
| **Challenge mandate** | Whoever holds the coordinating seat (orchestrator, planning agent, or council chair) is required to question the human and challenge low-value ideas before executing them: one clear challenge, then commit the decision and move on. Applies to weak agent findings the same way it applies to human requests. | Session-start reminder carries the prose rule; the adversarial-reviewer role is the mechanical twin for anything that needs a harder, structured pass than a reminder can give. | prose + gate (adversarial-reviewer) |

## Why only a few hooks, not many

Every hook is a candidate for becoming the thing operators mute because it fires wrong too often.
A false positive gets muted, and a muted hook protects nothing. Before adding a new gate, check
whether a cheaper tier already covers the rule, and write down what was considered and rejected.
Future maintainers need that reasoning as much as the rule itself.

## Project-specific rules

<!-- Add this project's own recurring misses below, one row per rule, same table shape as above.
     Keep the catalog to rules that have actually been missed at least once — this is not a
     wishlist of things that could theoretically go wrong. -->

| Rule | Statement | Mechanism | Tier |
|---|---|---|---|
| _none yet_ | | | |
