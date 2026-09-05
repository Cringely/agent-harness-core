# Test Falsifiability

## A test that could not have failed reports the same green as one that could

Ablation asks whether the fix is what holds a test up. There is an earlier question, and a green
suite is exactly where it hides: could this test have failed at all? A test can exercise real code,
assert something true, and still be structurally incapable of reporting the defect it was written
for. From the run output that test is indistinguishable from a real pass.

Five shapes account for the sightings so far. A matcher blind to the defect under guard. A fixture
set whose every case sits on the safe side of the guarded line. A measurement whose result is read as
proof of a claim it cannot separate from its opposite. And an async test that fails by hanging, which
reads as still running rather than as a failure. The fifth, found by the mutation run described
below, is a table of cases drawn from the constant under test, so a change to the constant rewrites
the test along with it.

## Name the matcher's blind spot

A matcher picked for convenience can be structurally unable to see the defect it is standing over.
Deleting a skip-guard from a backfill walk over order events produced `["order_a", undefined]` where
the fixture expected `["order_a"]`. That difference is a real defect and the test caught it, but only
because of which matcher was in the assertion: `toStrictEqual` fails on the leaked `undefined`, and
`toEqual` passes it, because `toEqual` treats a missing array slot and an explicit `undefined` as the
same thing. `toContain` would have been worse again. Membership is all it checks, so a wrong count
and a wrong order both sail through it.

Neither matcher is wrong in general. Both are wrong where the defect under guard is a length or an
ordering defect, and the thing to write down before trusting the test is not what correct code
produces but what broken code could still satisfy.

Those names are Bun and Jest vocabulary. The shape carries to any assertion library, where the same
question reads as: which differences is this comparison defined to ignore, and is the bug one of
them?

## A green ablation is a coverage hole, not a pass

Six fixtures covering six variations of one shape are one kind of coverage, not six. Every fixture
for that same backfill walk placed a status snapshot immediately before the triggering event, because
that was the easy fixture to write and each one was written from the last. The defect that mattered
was an event recorded with no adjacent snapshot, which gets attributed to the wrong owner. Not one of
the six could have failed on it. They all agreed, they all passed, and none of them had ever been
near the case.

It surfaced when a reviewer drove the real execution path through a realistic multi-step run instead
of assembling a fixture by hand, and the missing case went into the suite built the same way.

So when a guard is ablated and every test stays green, the reading is that the suite has a hole, not
that the guard is optional. The response is to write the case that reaches the guarded line, through
the real path rather than a shortcut, and only then to ablate again.
[`ablation-verification.md`](ablation-verification.md) owns the check itself and its four steps. This
is what to do when the second step refuses to fail.

## "Costs nothing measurable" and "guards nothing" are different claims

One change carried two guards, both measured the same way, against a production table of roughly
fifteen thousand rows, a rounded figure. A payload-validity check changed zero rows in the result
set. A branch condition was reached by zero rows. Identical numbers, opposite meanings.

The first guards against a malformed row that this data has not produced yet, and ablation settles
that it does something: delete it and the loader crashes on a malformed row. The second is
unreachable from live data at all. It states a contract on an exported function's input shape, for
callers that do not exist yet, and an earlier review round had labeled it a correctness fix.

Zero measured impact and zero protection are separated by ablation, not by counting rows, and the
count alone cannot tell them apart. Where the honest label is the weaker one, take the weaker one. A
contract that reads as a fix inflates what the change is worth and leaves the next reader believing a
bug was found and closed.

## An async guard's test can be unfalsifiable by hanging, not by passing

For a guard whose whole job is bounding how long something may wait, the first question is whether
its test can report a failure at all. One ablation answered no. With the timeout deleted, a request
against a socket that accepted the connection and never answered had nothing left to settle it, and
the run hung instead of going red. A hang is not a failure any run reports; it reads as still
running, right up until someone kills it, so the ablation meant to show the guard was doing real
work showed nothing.

The test in the suite today uses a real socket instead of an injected one, and wraps a watchdog timer
around itself. The watchdog is the part worth copying, because a test written to prove that code
cannot hang is otherwise free to hang the whole run.

Why that test avoids an injected waiter is a claim about the runtime rather than an observation.
Under Bun, a timeout signal is reported not to fire while the only pending work is a promise awaiting
that same signal, which would leave an injected-fetch version hanging whether the code were correct
or not. That version was never written and no experiment isolated the mechanism, so the explanation
stays unconfirmed. The watchdog holds either way, since it turns a hang into a failure whatever
produced the hang.

## A rule-chosen ablation reaches the lines a reviewer did not suspect

Every receipt above came from a reviewer working by hand: read a test, doubt it, choose the line to
break. The choice is the bound on the method. A reviewer ablates where a reviewer suspects, so what
comes back is a test of the reviewer's hypothesis about where the holes are, and a hole nobody
hypothesised stays where it is. Mutation testing is the same check with the choice taken away. A
tool alters production lines by rule, deleting a statement, flipping a condition, changing a
constant, runs the whole suite once per alteration, and reports which alterations the suite let
through. It is not a different check but the same one, run over lines that owe nothing to anyone's
suspicion, and that is the whole of what it adds.

The record so far is one hand pass, over the installer suites, followed by one rule pass over the
installers and the hooks together. A branch review had ablated production lines in those suites by
hand, a dozen of them in one sweep, and re-read its own fixes, and across four backlog items it
recorded eight gaps no test would notice: guards with nothing behind them, a default that no case
ever exercised because every case supplied the value, an assertion that an empty output satisfies,
and assertions that a neighbour already entails. The four items were confirmed still open at the
same commit, and the rule pass, ninety-nine alterations chosen by rule, found three more, all in
the hook suites, which nobody had ablated by hand.

Two of the three are shapes this doc already names, recurring in a second project. A test proving a
list was de-duplicated asserted that the output contained `"a, b"`, with a comment above it stating
the claim; without the de-duplication the output reads `"a, a, b"`, which contains that substring.
That is the matcher's blind spot, membership hiding a wrong count. A test named for one
configuration source winning over the filesystem fallbacks never created a fallback for it to win
over, and moving the winning candidate to last in the search order kept it green. That is the
fixture set on the safe side of the guarded line, and the same shape as the unexercised default
among the installer findings, so it recurred twice in this tree alone. The third is the new one. A table-driven
test built its cases by filtering the very constant under test, so deleting a value from the
constant deleted the case that would have caught the deletion, and the suite stayed fully green. The
remedy is to write the table out by hand, so the test owns its expected values instead of borrowing
them from its subject.

What the rule pass added was lines nobody had chosen, and the addition has a bound worth keeping in
view. Thirty of the thirty-five surviving alterations changed real behaviour while the suite stayed
green: behaviour with no test over it. A reviewer finds absences too, since a guard with nothing
behind it is exactly that, but finds them where the reviewer looked. A sample of ninety-nine
alterations measures absence on exactly ninety-nine lines. Among what they turned up: of the seven TypeScript hooks, one had no test file, and of the six that did, one
was ever run as a process by its tests. The other five were tested by importing their functions, so
a hook with dozens of tests, and a test file longer than the hook itself, would not have noticed if
the refusal it exists to emit stopped being emitted.

The split, eight findings in the installer suites from the reviewer and three in the hook suites
from the run, has more than one explanation. The two suites are in different languages and written
in different styles, only one of them had been reviewed by hand before, and the two passes chose
their lines differently. Any of the three would produce the split on its own, and eleven cases
across two suites cannot separate them. The claim that survives is the narrow one: the run found
tests the reviewer had never touched, because the review had never gone near that suite at all.
Whether the same review, done by hand over the hook suites, would have found the same three was not
measured.

Not every survivor is a gap in the suite. Five of the thirty-five were equivalent mutants,
alterations that change the text and not the behaviour, and no tool tells those apart from real
gaps; a person reads each survivor and decides. That reading is where the run's one finding about
production code turned up. A test written to prove that a non-ASCII filename comes back as itself
rather than as an escaped form stayed green with a configuration override removed from the command,
and a live check showed why: the command's own output flag already suppressed the escaping, so the
override had never done anything. The test was right about the behaviour and wrong about what
produced it, and the line it was written to defend was dead.

The cost is what keeps this from being the default. Each mutation is a full run of the suite, and
each survivor is a hand judgment, so the run trades one unbounded reading job for a bounded one:
here, ninety-nine suite runs and thirty-five survivors to read. It is worth paying when a suite's
green is about to be cited as evidence for something, a merge gate, a claim that a hook is tested, a
test count offered as coverage, and worth paying again when the suite's shape changes, not on every
commit, because what it finds is structural and stays found. It is not worth paying on a suite whose
green nothing depends on, and it says nothing new about a file with no tests, where every mutation
survives and a glance at the test directory already said so. Reading stays, and mutation is what to
run once a reader has passed the suite and something expensive rests on that.

The run's headline figure needs its frame kept on. Sixty-four of the ninety-four non-equivalent
mutations were killed, 68%, and that is a measurement of this run against these ninety-nine
mutations at that commit. It is not a property of the suite. Ninety-nine alterations across a tree
of several thousand lines is a sample, not a sweep; a different rule for choosing lines, or the same
rule on a later tree, gives a different figure, and the figure does not compare across suites or
across runs that chose their lines differently.

One number from a run answers a question that is otherwise expensive to ask: is a high test count
real, or is it one behaviour tested many ways? Count how many tests each mutation killed. A suite
that tests one behaviour many ways has a top-heavy distribution, because one alteration to that
behaviour takes all of them out at once. A flat distribution means the tests are pulling apart,
each holding up its own piece. Across these ninety-nine, thirty-five mutations killed exactly one
test and only four killed more than five, which is evidence that the count is earned. It is evidence
about the tree as a whole and not about any one file, since the distribution isolates a file only
when it is drawn per file, and this one was not. It counts kills only, so it says nothing about
survivors either: a flat kill distribution and thirty untested behaviours came out of the same run.

## Provenance

The four receipts behind the matcher, fixture, measurement and hanging sections come from one
project, gathered over a single day of review work with one later follow-up. The rule-chosen
section comes from a second source, this repository itself. The hand-chosen ablations are backlog
items 24, 26, 27 and 32 in `docs/backlog.md`, which between them record eight gaps: one in item 24,
four in item 26, two in item 27, and one in item 32, whose other finding is a defect in production
code rather than an untested correct line and is not counted. The run was measured 2026-09-05 at
commit `23d9c69`: 99 mutations, 64 killed, 35 surviving, 5 of the survivors judged equivalent by
hand. So the matcher and fixture shapes have now been seen in two projects, which is the bar
`CONTRIBUTING.md` sets for core, while the fifth shape and the claim about hand-chosen and
rule-chosen ablation rest on that one run.

## Related

[`ablation-verification.md`](ablation-verification.md) asks whether the fix is holding the test up.
This one asks the prior question, whether the test could have failed at all, and the two are worth
running in that order: an ablation whose test could not fail either way returns a green that means
nothing. That doc's "A check that examines nothing looks exactly like a check that passes" section is
the same family applied outside tests, where a comparison over empty input agrees perfectly, and its
remedy of asserting the input is non-empty before comparing anything is the non-test form of naming
the matcher's blind spot. Its four steps are what a mutation tool runs once per altered line, which
is the sense in which the rule-chosen section above calls mutation the same check.
