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

## Which frontmatter keys grant writes

`tools:` looks like the full account of what a def can touch, and it isn't. Setting `memory:` at any
scope also turns on Read, Write, and Edit, and that grant overrides a `tools:` allowlist that leaves
them out. See the persistent-memory section of `code.claude.com/docs/en/sub-agents.md`. So a def
reading `tools: Read, Grep, Glob` with a `memory:` key below it is write-capable, while every line
of it says otherwise to a human skimming for the tools list.

One qualification on that grant, from the same page: it applies to sessions that have auto memory
turned on globally. A def carrying `memory:` in a session without that setting does not pick up the
extra tools. This matters for how the claim is written down, not for how a def is authored, because
an author cannot know which sessions will run their def.

The authoring rule that follows is short. A def that has to stay read-only cannot carry `memory:` at
all. No combination of `tools:` takes the grant back, so leaving the key off is what keeps the
guarantee.

The worktree gate in `core/claude/hooks/agent-worktree-gate.ts` now treats a `memory:` key as
write-capable without checking the global setting, which it has no way to read while parsing a file.
That over-isolates a `memory: user` def, whose writes land outside the checkout anyway. Over-isolating
is the direction that costs a wasted worktree instead of a collision, and the exceptions list in the
hook is the escape hatch if a real def ever needs it.

Generalize past this one key, because the next one will be different. A check that concludes
"read-only" has to read every input that can grant writes, and a check that reads only some of them
is not a proof of anything. Chapter 6 of *Building Secure and Reliable Systems* makes the same point
about trusted computing bases: "You can't just draw a dashed line around a component of your system
and call it a TCB. You have to think about the component's interface, and the ways in which it might
implicitly trust the rest of the system." The gate's own header already argues for an allowlist over
a deny-list for this reason. Enumerating write-granting frontmatter keys is that argument applied one
field across.

Quotation from Adkins, Beyer, Blankinship, Lewandowski, Oprea, and Stubblefield, *Building Secure and
Reliable Systems* (O'Reilly, 2020), chapter 6, available under CC BY 4.0 at
<https://google.github.io/building-secure-and-reliable-systems/raw/ch06.html>.
