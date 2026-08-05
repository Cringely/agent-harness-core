# Always-On Context Budget

## The instinct to economize points at the wrong thing

Adding a fifth review role or a sixth imported specialist feels like it costs something: another
file, more surface, one more thing for a maintainer to track, but mostly it doesn't. An agent
definition's body, the method section, the frontmatter's `tools:` and `model:` fields, everything
below the `description:` line, sits inert until something dispatches it; a session that never calls
`doc-steward` pays nothing for that body existing. Its `name:` and `description:` don't get the same
pass, they're a smaller exception covered under the skill-descriptions surface below. What actually
taxes every turn of every session is text with no dispatch gate at all: content loaded before the
first prompt is even read.

## Three surfaces that load unconditionally

**Rules files under `.claude/rules/`.** A rules file with no `paths:` frontmatter glob loads every
session in full, whether or not anything in the session touches what it governs. Add a `paths:`
glob and the file loads only when Claude reads a matching file instead, which is the mechanism, not
a convention: an unscoped rule about, say, Docker healthchecks pays its cost on a session that never
opens a Dockerfile. The trade-off is state, not cost. A path-scoped rule is lost to compaction until
a matching file gets read again; an unscoped rule gets re-injected from disk regardless. A rule with
no file behind it at all, a commit-message convention, a dispatch policy, a prose register, can't be
path-scoped, full stop. That's the mechanism's ceiling, not a missing flag someone forgot to set.

**Skill descriptions, and the agent-def roster alongside them.** Every installed skill's
description loads into a listing every session, budgeted at 1% of the context window. Past that
budget, descriptions get dropped starting with the least-invoked skills, which means a rarely-used
skill's name survives the cut and its "when to use" line doesn't. A skill nobody has invoked in a
while quietly turns into a name with no instructions attached, and nothing announces that it
happened. An agent def's `name:` and `description:` load by the same mechanism and for the same
reason: a dispatcher has to see that an agent exists before it can decide to dispatch it, so every
def's roster line loads every session regardless of whether that session ends up calling it.
Measured for this repo's five defs, the roster runs to roughly 650 characters, under 200 tokens,
which is the actual size of the exception named above. Rounded on purpose: an exact count goes
stale on the next description edit.

**Hook output.** A hook's returned string, including `additionalContext`, is capped at 10,000
characters. Past the cap, the overflow gets written to a file and replaced in-context with a preview
plus the file's path. The cap enforces itself, so a hook that grows too large doesn't leak
unbounded text, but a hook author who never checks output length can still write one that spends most
of every session's opening budget on a preview nobody reads before opening the file anyway.

One thing that doesn't help here: `@path` imports don't save anything. An imported file still loads
in full at launch; the import changes where the text is written, not whether it gets paid for.

## Where core already wires against this

`guardrails.template.md` keeps the text above its `guardrails:session-start-end` marker to what's
actually just-in-time. The SessionStart hook reprints everything above that line into every fresh
context, so anything placed there is a standing tax, not a one-time cost. See
[`forcing-functions.md`](forcing-functions.md) for the tier that reprint belongs to (tier 3,
re-injection at the moment a rule is relevant), and the guardrails catalog itself for the worked
rows.

## What this changes about where to spend review effort

Reviewing a new agent def for necessity buys little. The def is free until dispatched, and a def
nobody dispatches costs nothing beyond a line in a directory listing. Reviewing a new unscoped rule,
a newly-added always-loaded skill, or a hook's output size buys real budget back, because that text
runs on every turn regardless of relevance. Between adding a fifth agent role and adding three more
sentences to an unconditionally-loaded rules file, the agent role is the cheap one.

## Related

[`forcing-functions.md`](forcing-functions.md): the hierarchy this doc's third surface, hook output,
sits inside.
[`memory-provisioning.md`](memory-provisioning.md): a related but different cost, a subagent's
one-time dispatch budget rather than a per-turn one paid by every session.
