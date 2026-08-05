# Agent-Def Shape: Charter-Pointer vs Self-Contained

## Two shapes in the wild

Agent definitions in a `.claude/agents/` directory settle into one of two shapes:

- **Charter-pointer**: thin frontmatter (8-10 lines) whose body points at a
  `docs/charters/<role>.md` file (typically 70-190 lines) carrying the real role content. The
  charter is copied into the dispatch prompt at dispatch time, not carried in every session.
- **Self-contained**: the full specialist prompt lives in the agent-def itself, often 250-300
  lines.

The first consumer harvest asked which shape held up better so core could standardize on one.
Neither won; the right shape depends on how often the role's identity changes.

## The criterion: churn rate of the role's identity

**Charter-pointer wins for identity that evolves with team process.** Review seats, ceremony
roles, anything tied to a workflow that gets tuned over time (cadence changes, review-tier
changes). The indirection cost buys a real PR diff on every change instead of a full-file
rewrite: changes are reviewed, diffable, revertable, and the agent stays stateless between
dispatches. The consumer project that surfaced this had five such roles (adversarial-reviewer,
doc-steward, soc-monitor, task-reviewer, strategy-reviewer), all revised as its process evolved.

**Self-contained wins for stable, imported, rarely-touched technical specialists.** A generic
security auditor or Docker expert has no project-specific identity to version; the observed
examples had never been edited since import. A charter pointer here would reference a file that
never changes, which is pure overhead.

## Rule for promoted agent-defs

Don't convert a promoted agent-def to match a house shape. Each one keeps the shape that
already fits it. When authoring a new role, ask one question: will this role's identity change
as the team's process changes? Yes → charter-pointer. No → self-contained.

## What core actually holds today

Every core agent def in this repo is self-contained today, none point at a charter: `task-reviewer`,
`doc-steward`, `soc-monitor`, `adversarial-reviewer`, `research-scout`. No `charters/` directory
exists.

That's not a second contradiction of the criterion above, it means none of the five has actually
hit the trigger yet. Charter-pointer earns its indirection cost when a role gets revised often
enough that the diff is mostly identity rewrite; nothing here has been revised enough times to
show that pattern. Self-contained is the right default until a role demonstrates the churn that
justifies splitting it out, not a shape to convert to preemptively.

The generic-technical-specialist half of the original rule (`security-auditor`, `docker-expert`
stay self-contained) no longer has an example inside core to point at. Both moved to the account
layer; see [`CONTRIBUTING.md`](../CONTRIBUTING.md) on why core holds process, never domain
knowledge, regardless of how well a domain def is written. Self-contained is still the right shape
for that kind of def, it just lives outside this repo now.

## Citing a skill vs. dispatching a plugin agent

Shape governs how much of a role's own content lives in the def. A separate question governs how a
def is allowed to reach outside itself: it may cite a skill, never dispatch another plugin's agent.

A skill is knowledge injection. Citing one names it, states what it's used for, and says what to do
if it isn't installed: apply the same judgment manually rather than fail the dispatch.
`task-reviewer` cites `superpowers:verification-before-completion` for its revert-and-confirm check
and says to run the check manually if the skill is absent. `adversarial-reviewer` does the same with
`superpowers:receiving-code-review`, and again with `trailofbits/differential-review` for blast-radius
analysis. In every case the def still works alone; the skill only makes it work better.

A def must never instruct dispatching another plugin's agent or workflow.

- **Availability.** Dispatching a plugin agent re-couples a core file to account-scope state the
  installer has no authority over. The def stops working the moment that plugin is absent, instead
  of degrading the way a missing skill does.
- **Cost.** One agent name in a brief can silently become a fleet. `code-review` runs parallel
  reviewer agents plus git-history analysis under its own workflow; dispatching it from inside
  another def would hide that cost jump from whoever reads the brief expecting a single reviewer.
- **Failure mode.** Workflow nesting goes one level deep, so a def calling into another plugin's
  workflow from inside a dispatch can throw outright instead of degrading.

`task-reviewer` shows the resolution in practice: for a pull request or a large multi-commit diff it
recommends the operator run `code-review` directly, and does the single-pass review itself either
way, size regardless. An orchestration-heavy plugin gets recommended to the operator. It never gets
invoked from inside a core def.
