# Test Falsifiability

## A test that could not have failed reports the same green as one that could

Ablation asks whether the fix is what holds a test up. There is an earlier question, and a green
suite is exactly where it hides: could this test have failed at all? A test can exercise real code,
assert something true, and still be structurally incapable of reporting the defect it was written
for. From the run output that test is indistinguishable from a real pass.

Four shapes account for the sightings so far. A matcher blind to the defect under guard. A fixture
set whose every case sits on the safe side of the guarded line. A measurement whose result is read as
proof of a claim it cannot separate from its opposite. And an async test that fails by hanging, which
reads as still running rather than as a failure.

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

## Provenance

All four receipts come from one project, gathered over a single day of review work with one later
follow-up, so this is a shape seen once rather than a pattern confirmed across projects.

## Related

[`ablation-verification.md`](ablation-verification.md) asks whether the fix is holding the test up.
This one asks the prior question, whether the test could have failed at all, and the two are worth
running in that order: an ablation whose test could not fail either way returns a green that means
nothing. That doc's "A check that examines nothing looks exactly like a check that passes" section is
the same family applied outside tests, where a comparison over empty input agrees perfectly, and its
remedy of asserting the input is non-empty before comparing anything is the non-test form of naming
the matcher's blind spot.
