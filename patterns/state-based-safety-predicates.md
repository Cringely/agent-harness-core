# State-Based Safety Predicates

## A predicate built from failed attempts goes silent for the well-behaved subject

A stall detector had a clean predicate. Four conditions, all of which had to hold, together meaning
"this worker cannot proceed and cannot fix that itself." The cheap self-service remedy is unavailable
where the worker is. The monitored resource sits under a warning percentage of capacity. The worker is
not already parked in the state where the remedy would apply. Those three read current state. The last
one counted how many of the worker's own requests had been refused in a row for want of that resource,
and that count did the discriminating. Without it, a worker that could not act and one that was
merely low looked the same to the predicate.

The hole is in that last conjunct, and it opens without anything going wrong. A worker that can tell it
is blocked stops issuing requests that cannot succeed and holds instead, which is what it should do,
and the counter stops advancing the moment it does. Better steering is enough to close the detector's
eyes. Nothing of that class was ever logged over the subject's whole recorded history, a zero confirmed
against live telemetry, while three neighboring detectors fired normally in the same windows: a
re-steer path, a no-progress path, and a hard-stuck path. What that silence covered was never
established. The incident report says the other three conditions held continuously through long
stretches of it, and nobody replayed the history to check.

The asymmetry runs the wrong way. The best available behavior, which is to stop making requests
that cannot succeed, hides a subject from the detector built to protect it. A subject that kept
hammering would have been seen.

Two claims above rest on different evidence, and collapsing them would overstate the case. That the
fourth conjunct cannot advance once the subject stops attempting is a direct read of the predicate
and of the producer that increments it, so the hole itself is established. Reading that producer also
surfaces a second cause sufficient on its own for the same silence: the counter used to require both a
movement-class step name and a resource keyword matched against the refusal's free text, so a
resource-refused step of any other class never counted at all. That gap was closed producer-side, at
the guard that knows why it refused. So the definitional hole stands on a read of the predicate, not on
that run, and better steering is a candidate explanation for the observed quiet rather than the
recorded one. Whether the subject really sat in the hazard during those quiet stretches remains unsettled,
because a count of zero alerts fits a hazard that never arose just as well, and no history was
replayed against a corrected predicate to separate the two. The defect is proven. Its blast radius in
that run is not, and the mechanism connecting the two stays unresolved.

## The shape

Define a safety or stall predicate as a conjunction over conditions that are true right now. History
does not appear in it. Attempt counts, refusal streaks, and retry tallies do not appear in it either,
because each of them measures what the subject has been doing rather than the situation the subject
is in, and a predicate that measures behavior can be switched off by good behavior.

A counter of refused attempts still earns a place, one step to the side. While the subject is
attempting and being refused, the counter crosses its threshold sooner than a state condition can be
confirmed stable, which makes it a useful fast path. So OR it alongside the state check rather than
ANDing it into the conjunction, where it can corroborate the state reading without ever being the
thing that gates.

Moving it is only half the job, and it is the half that is easy to stop at. An attempt counter sitting
in a conjunction is usually doing real discriminating work, separating "in the hazard and unable to act"
from "near the hazard and still able to act," and the conditions left behind have to be sufficient for
that on their own. In practice that means retiring a warning threshold for one tied to the cost of
acting: the resource sits below what the cheapest action that could reach the remedy would consume,
rather than below a percentage that reads as low. Pull the counter out and leave the warning threshold
where it was and the predicate now fires on a subject that is merely low and still has a way out, which
is the opposite failure and the more expensive one when something destructive sits behind the gate.

One question tests a predicate that already exists. If the subject stopped acting entirely, right
now, and never acted again, could this predicate still become true? If not, some conjunct is
attempt-derived and belongs on the OR side. Answering takes a read of the conjuncts and their
producers, not a replay of history.

The same question makes a better test than it makes a review note, and a test is the cheaper place to
keep it. Construct the case where the subject is in the hazard and has issued no attempts at all,
then assert the predicate holds. A detector that returns false there is decoration. Write the mirror
case in the same pass, since one case on its own only guards the direction the rewrite already made
safer: subject under the warning threshold, no remedy nearby, and still able to act, asserting the
predicate is false.

## Everything gated behind it inherits the hole

Two recovery paths sat behind that predicate. One raised an operator alert. The other was an
automatic escalation to the destructive remedy, the one that trades assets for a working state, put
behind a config switch and left off by default so an operator could opt in deliberately.

Neither path ever ran. Turning the switch on would have changed nothing, because nothing downstream
of a gate that never opens ever runs. A config switch behind a predicate that cannot close for the
subject it exists to catch is dead config that reads as a live control, and it reads that way to
everyone who looks: the operator deciding whether to enable it, the reviewer counting recovery paths,
and the next author who treats its existence as coverage of the hazard. The switch is the visible
artifact, so it is where a false sense of coverage collects.

The audit follows from that. When a predicate turns out not to close for the subject it exists
to catch, the finding never stops at the predicate. Walk everything gated behind it and re-count
what of that ever ran, because the whole subtree was decoration for as long as the root stayed
false.

## Provenance

One project is behind this so far, and its predicate was game-shaped where the account above is
worker-and-queue-shaped. What generalizes is the definitional rule, since a conjunction that mixes
standing state with attempt counts has the same hole in any domain. What does not generalize is which
conjuncts belong in the predicate, and that part has to be argued locally every time.

## Related

[`replan-guards.md`](replan-guards.md): the guard stack this predicate lives inside. Its 4c
subsection describes the detector the predicate triggers, and the guards there decide when to hold
off a replan, each keying off a replan boundary or a wake. That is a different clock from a standing
hazard, which has to be visible on a tick where nothing happened.

[`fail-contract.md`](fail-contract.md): the same hole from the other side. There it is an input that
neither fail path reaches; here it is a branch that no input reaches. Both get found by enumerating
cases against the contract rather than by watching the code behave.

[`ablation-verification.md`](ablation-verification.md): a check that examines nothing looks exactly
like a check that passes. A detector that never fires is that failure with a longer fuse, and the
same remedy applies, which is to prove the check can produce a positive result before trusting a
negative one.
