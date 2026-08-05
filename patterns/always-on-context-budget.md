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
Measured for this repo's defs, the roster runs to under a thousand characters, a few hundred tokens
at most, which is the actual size of the exception named above. Deliberately imprecise, and not
merely rounded: an exact figure measures files this doc does not own and goes stale on the next
description edit, while the argument here needs only the order of magnitude.

**Hook output.** A hook's returned string, including `additionalContext`, is capped at 10,000
characters. Past the cap, the overflow gets written to a file and replaced in-context with a preview
plus the file's path. The cap enforces itself, so a hook that grows too large doesn't leak
unbounded text, but a hook author who never checks output length can still write one that spends most
of every session's opening budget on a preview nobody reads before opening the file anyway.

The swap is also silent, which is the worse half. What arrives in context has the shape of the
guardrails block without being it, and the reading model has no signal that anything was dropped.
That makes truncation indistinguishable from a short guardrails file, so a hook near the cap should
measure its own output and, past a threshold it sets below the platform's, print an explicit line
naming what it cut. The general form applies to any degraded path in this repo: a path that
degrades says so in its output, and silence is never a valid degraded result. A blank section
emitted because a query failed reads exactly like a blank section emitted because there was nothing
to report, and the second one is fine while the first is a broken tool nobody will notice for weeks.
Chapter 8 of *Building Secure and Reliable Systems* puts the requirement plainly: "As you implement
graceful degradation, it's important to determine and record levels of system degradation,
regardless of what set off the problem."

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

Reviewing a new agent def for necessity buys little. Its body is free until dispatched, and what a
def nobody dispatches still costs is its roster line, the `name:` and `description:` pair that loads
every session under the second surface above. Reviewing a new unscoped rule,
a newly-added always-loaded skill, or a hook's output size buys real budget back, because that text
runs on every turn regardless of relevance. Between adding a fifth agent role and adding three more
sentences to an unconditionally-loaded rules file, the agent role is the cheap one.

## The cost argument isn't the strongest one

Everything above is an argument from price: standing text is expensive, dispatched text is cheap,
so put the rule where it costs least. That reasoning has a weakness, which is that it loses the
moment someone points at a bigger context window. If the budget stops being scarce, the argument
stops binding.

A second reason survives that. *Building Secure and Reliable Systems*, chapter 6, on centralized
responsibility: "A reviewer needs to look in only one place in order to understand and validate that
a security/reliability requirement is implemented correctly." The claim is about verifiability
rather than cost. A rule copied into four agent definitions cannot be checked, because checking it
means reading four files and noticing that the fourth has drifted into a paraphrase that no longer
says the same thing. Nobody notices. Paraphrase drift is invisible precisely because every copy
still reads as correct on its own.

So the same instruction points two ways at once. Put a requirement in one place because standing
context is scarce, and put it in one place because one place is the only arrangement where a
whole-system claim about that requirement can be confirmed at all. When the two reasons disagree,
which happens when centralizing costs more standing budget than duplicating would, verifiability
wins. A cheap rule nobody can audit is not a saving.

## Related

[`forcing-functions.md`](forcing-functions.md): the hierarchy this doc's third surface, hook output,
sits inside.
[`memory-provisioning.md`](memory-provisioning.md): a related but different cost, a subagent's
one-time dispatch budget rather than a per-turn one paid by every session.
[`fail-contract.md`](fail-contract.md): the same announce-your-degradation rule applied to a gate's
error paths instead of a hook's output size.

Quotations are from Adkins, Beyer, Blankinship, Lewandowski, Oprea, and Stubblefield, *Building
Secure and Reliable Systems* (O'Reilly, 2020), chapters 6 and 8, available under CC BY 4.0 at
<https://google.github.io/building-secure-and-reliable-systems/raw/toc.html>.
