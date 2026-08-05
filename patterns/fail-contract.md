# Fail Contract: Write the Floor Before the Branches

## Fail-open and fail-closed get decided one case at a time

A gate accumulates its error handling the way most code does. The first failure mode turns up, someone
picks a direction, and a comment explains why. The second turns up, someone picks again. Each choice
is defensible on its own. What nobody writes down is the sentence both choices were supposed to derive
from, so there is no way to check a new case against anything, and no way to notice a case that
neither branch reaches.

That last part is the expensive one. A gate with two carefully reasoned tiers can still have an input
neither tier reaches, and such an input gets whatever behavior the surrounding runtime happens to
produce. It looks like a decision because it sits next to real decisions.

*Building Secure and Reliable Systems* names the ordering that prevents this. From chapter 8, "Failing
safe versus failing secure":

> "These principles of reliability and security are clearly at odds. To resolve this tension, each
> organization must first determine its minimal nonnegotiable security posture, and then find ways to
> provide the required reliability of critical features of security services."

Same chapter, more bluntly: "Security-critical operations should not fail open."

The floor comes first. Both branches are derived from it. That order is the whole pattern.

## The shape

Write one sentence naming what must remain true even when the gate is broken. Then derive both fail
paths from that sentence rather than from the failure modes as they arrive.

A gate in this repo separates cleanly into two tiers, and naming them is what exposes the gap between
them.

**Domain unknowns fail closed.** An input the gate is supposed to classify, and cannot, resolves to
the restrictive answer. An unreadable definition file, a type nobody has seen before, a field that
does not parse. The gate's job is to prove a property; failing to prove it is not evidence the
property holds.

**Failures of the gate itself fail open.** Malformed input the gate was never handed cleanly,
a missing runtime field, a bug in the gate. These exit quietly and let the normal flow proceed,
because a broken control that blocks all work gets deleted within the day, and then there is no
control at all.

**Everything else is a hole, and a hole has an owner.** Once both tiers are written, walk the failure
modes and find the ones neither sentence covers. Each one needs a name and an owner, plus either a
decision or a written admission that the gate is advisory in that case, and leaving it undocumented
is the one option ruled out.

## The case that motivated this

The worktree-isolation gate in `core/claude/hooks/agent-worktree-gate.ts` documents both tiers in its
header, and documents them well. An unreadable definition or an unknown type requires isolation,
while malformed input or an internal bug exits quietly and leaves the permission flow to decide.

One case escapes both tiers. If the runtime the hook is written in is absent from PATH, the hook
command fails in a way the platform treats as non-blocking, so every dispatch proceeds ungated. That
is not the domain tier, because no classification was attempted, and not the gate-error tier either,
because the gate never ran.

This case is documented, and that is what makes it a useful illustration instead of a bug report. The
header enumerates it in the same paragraph that states the fail-open contract, the README repeats it
under install prerequisites, a backlog item tracks the installer warning, and the commit that wrote
the current header records why a hard block was rejected: hard-failing on a missing interpreter would
invert the fail-open contract the rest of the file is built on. The decision exists and it is a good
one.

What none of those four state is the floor the two tiers derive from. Each describes the behavior
correctly, and the invariant behind the behavior stays implicit across all of them. So the cost of
skipping the floor sentence is not a missing decision here. It is that the next case to arrive gets
argued from scratch against four descriptions rather than checked against one sentence, and that
whether the four still agree with each other is something a reader has to verify by hand each time,
which is a smaller cost than an undecided fail path but one that compounds with every gate added.

## Why fail-closed, without the adversary

Part of the book's case for fail-closed rests on assuming someone is trying to break things, since an
attacker who can disable a control by making it fail is an attacker who will, and that premise does
not hold here. The failure source in a single-maintainer repo is a forgetful author and a model that
drifts, rather than a chooser of worst-case inputs.

The conclusion survives anyway, for a local reason worth stating in place of the borrowed one. An
input the gate cannot classify is exactly the input least likely to be routine. Familiar things parse.
The unparseable case is disproportionately the new role, the hand-edited definition, the file
someone is midway through writing, and those are the cases where a wrong exemption costs the most.

One caveat, speculative rather than observed: if a gate ever sits on a path traveled by an agent
reading untrusted content, prompt injection puts a real adversary back in the picture and the book's
original justification returns with it.

## Related

[`ablation-verification.md`](ablation-verification.md): proving a branch is the one producing the
observed behavior, which is how a fail path gets tested rather than assumed.
[`forcing-functions.md`](forcing-functions.md): why the gate exists as a gate instead of a sentence in
a rules file.

Quotations are from Adkins, Beyer, Blankinship, Lewandowski, Oprea, and Stubblefield, *Building Secure
and Reliable Systems* (O'Reilly, 2020), chapter 8, available under CC BY 4.0 at
<https://google.github.io/building-secure-and-reliable-systems/raw/ch08.html>.
