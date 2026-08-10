# Ablation Verification

## A passing test after a fix proves less than it looks like it proves

A test written to cover a bug, run once after the fix is merged, only shows that the test doesn't
currently fail. It doesn't show the fix is what makes it pass. The test could pass because the bug
was never really there, because the test doesn't exercise the path it claims to, or because
something unrelated already made the case work. To know whether the fix is actually holding the
test up, take it away and watch the test fail without it: the ablation check, named for removing
one part to see what breaks.

## The check

Revert the fix, confirm the test fails, restore the fix, confirm the test passes again. Four steps,
in that order. Skipping the first two turns a claim of "verified" into "assumed" no matter how
confident the write-up sounds, and the honest move is to say so: tag a finished fix as verified
(reverted and reconfirmed) or assumed (with the reason reversion was skipped), not to let "assumed"
quietly pass as "verified" because the two read the same in a summary.

## Rank the claim by the evidence behind it

A live capture or a reproduced result in the running system outranks an offline test, which
outranks a documented spec, which outranks an assumption. State which tier backs a claim rather
than letting "works" carry the same weight regardless of which one produced it. Code that merges and
a test that passes prove a capability exists. Neither proves real-world behavior changed until
something confirms it against the system actually running.

## Three catches from one session

A test passed against a reverted guard. It turned out to exercise a code path the guard never
gated, so its pass said nothing about the guard at all, and reverting first is what surfaced that,
not reading the test.

A brief claimed a hand-edited string would crash a `.Contains()` call. `System.String` exposes
`.Contains()` and returns `false` on a miss instead of throwing. The claim read as plausible and
specific, exactly the kind that survives review unchallenged, and it was caught only because the
test still passed with the fix removed, which it shouldn't have if the crash claim were real.

A fix's collection handling collapsed at zero elements, at a call site the brief describing the fix
had not named. The brief's account of what would break named one function; reverting the fix and
re-running surfaced a second, silent failure one layer away that the description had missed
entirely.

None of the three would have surfaced from reading the diff and a passing test alone. All three
surfaced from taking the fix away and watching what actually broke.

## When ablation can't run at all

Some fixes touch a path with no cheap way to revert in isolation: a live production system, a
one-way migration, a change entangled with something already merged elsewhere. Skipping the check
is legitimate there, but the report has to name the reason rather than go quiet on it. An assumed
tag with a stated reason is honest. A verified claim with no reversion behind it is the overclaim
this whole check exists to catch.

## A check that examines nothing looks exactly like a check that passes

Ablation asks whether the fix is holding the test up. The mirror question is whether the check read
anything at all. A comparison that passes proves the comparison did not fail, which is not the same
as proving it compared something, and from the output the two are identical.

Three sightings in one session, none of which announced itself.

A probe extracted a shared block from every file carrying it and compared the hashes. The extraction
pattern was wrong and matched nothing, so each file hashed the empty string and all of them agreed
perfectly. Full agreement across every copy, and not one byte had been read. It surfaced only
because the digest was the well-known hash of empty input and someone recognized the constant, which
is a thin thing to rely on.

A drift test was specified to assert an extraction's line count against an expected number. That
pins a measurement of files the test does not own, so the first legitimate edit to the shared block
breaks a test that was correct. Comparing the copies against each other, with a floor instead of an
exact value, keeps the guarantee and removes the constant that goes stale.

A commit sequence ran a test suite, piped the output through `tail`, and chained the commit behind
`&&`. A pipeline's exit status is its last command's, and `tail` succeeds whatever it is handed, so
the gate could not fail even in principle. `false | tail -3 && echo reached` prints `reached`.
`set -o pipefail` restores the propagation.

One rule covers all three. A check asserts its input is non-empty and of plausible shape before it
compares anything, and a comparison across copies compares them to each other rather than to a
constant. The assertion belongs inside the check, not in the summary that claims the check ran.

Hashes are only where it showed up here. A grep assertion matching zero lines, a glob matching no
files, a suite collecting zero tests, and a range expression matching nothing are all the same
failure, and every one of them reports success.

## Related

[`parallel-review-orchestration.md`](parallel-review-orchestration.md) verifies findings inside a
review fan-out, a different lifecycle: that pass checks whether a reported finding is real before
it reaches the author. This pass checks whether a fix the author already merged is actually
holding up the behavior it claims to fix.

[`test-falsifiability.md`](test-falsifiability.md) asks the question underneath this one, whether the
test could have failed at all, since an ablation whose test could not fail either way returns a green
that says nothing.
