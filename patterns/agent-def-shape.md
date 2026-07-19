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
already fits it:

- Ceremony/process roles (`adversarial-reviewer`, `doc-steward`, `soc-monitor`,
  `task-reviewer`) stay charter-pointer.
- Generic technical specialists (`security-auditor`, `docker-expert`) stay self-contained.

When authoring a new role, ask one question: will this role's identity change as the team's
process changes? Yes → charter-pointer. No → self-contained.
