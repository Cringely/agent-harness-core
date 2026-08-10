# Replan Guards

## Why four guards, stacked

A plan-then-execute loop calls a model only when a wake condition fires, but "only when it fires"
is not the same as "rarely enough to afford." A single failure mode, a planner that keeps timing
out, a step that keeps failing the same way, an agent circling without making real headway, can
each drive the wake condition to fire on almost every tick. One guard rarely covers every failure
shape, so this pattern stacks four guards, checked in order before a replan is allowed to happen.
The fourth is really three separate mechanisms, because "frozen," "busy but going nowhere," and
"blocked by something no available action can change" are different failure shapes that need
different detectors.

## 1. Exponential backoff on planner failure

**Prevents:** hammering a planner that is down, rate-limited, or timing out, which wastes calls and
can make an outage worse.

**Trigger:** consecutive transient failures calling the planner (network errors, timeouts, rate
limit responses). Each consecutive failure doubles the wait before the next attempt, off a small
base (illustratively, 30 seconds), capped at a ceiling (illustratively, 10 minutes) so backoff
never drifts far past the normal replan cadence.

**Reset:** any successful planner call clears the failure count and the backoff immediately.

## 2. Per-agent rolling rate ceiling

**Prevents:** a high volume of individually successful replans still burning an unreasonable amount
of spend. Backoff only fires on failure; this guard catches an agent that is replanning too often
even when every call succeeds.

**Trigger:** the count of replans in a trailing time window (say, the last hour) reaches a
configured maximum. The count is read from durable history rather than an in-memory tally, so the
ceiling survives a process restart instead of resetting to zero.

**Reset:** the window is rolling, so as old replans age out the count drops back under the ceiling
on its own; no explicit reset action is needed. A direct operator instruction is exempt from the
ceiling, since a human override should always be able to steer a capped agent.

## 3. Thrash damper on repeated identical block reasons

**Prevents:** a loop that replans every tick because the same step keeps failing the same way, or
because the runbook keeps "finishing" without ever changing the outcome that matters. Each replan looks
justified in isolation; the pattern only shows up across several in a row.

**Trigger:** several consecutive wakes (illustratively, three) carrying an identical reason and
detail, whether that's the same block message repeating or the same goal being reported "done"
over and over with nothing to show for it. Keying on a compound reason-plus-detail string lets both
failure shapes share one counter without one masking the other.

**Reset:** a wake carrying a different reason or detail breaks the streak and clears the counter.

## 4. No-progress guards: three separate mechanisms

"The agent is stuck" turns out to mean three different things, on three different timescales, and
this pattern uses three independent mechanisms rather than one, because collapsing them loses real
distinctions: which one owns an episode, what it does about it, and how fast it fires.

### 4a. State-fingerprint freeze detector

**Prevents:** a livelock where the agent keeps replanning, and each replan looks like forward
motion, while the state underneath it never actually changes.

**Trigger:** at every replan boundary, build a fingerprint out of the raw state fields that would
change if the agent were advancing (position, resource levels, and the plan cursor marking
which step is active) and compare it to the fingerprint captured at the previous boundary. An
identical fingerprint across a run of consecutive replan boundaries (illustratively, six) means the
agent is frozen: arm a planner backoff and mark the agent stuck. This check sits immediately before
the replan itself, past the three guards above, so it only ever measures boundaries that actually
reach a replan; a step that is still in progress and produces no replan can't false-trigger it.
The fingerprint deliberately excludes the planner's own free-text goal description: a livelock that
keeps replanning with a slightly reworded goal each cycle would make a text-based fingerprint
change every boundary and evade detection, while the underlying state stays honest no matter how
the goal is phrased.

**Reset:** any observed change in the fingerprint clears the run, resets the count to one, and
clears the stuck flag; recovery requires the state to actually change, not just time passing.

### 4b. Time-windowed progress-counter steward

**Prevents:** the mechanism above only catches a state that is completely frozen. It says nothing
about an agent that keeps moving, keeps consuming resources and changing position, without
accomplishing anything real over a long stretch. This is the softer, slower failure that 4a can't
see.

**Trigger:** define an allowlist of counters that only ever increase, and only on an actually
productive outcome (completing a unit of work, producing something, earning something). Positional
or movement counters (distance covered, steps taken, locations visited) are deliberately left off
the allowlist, because motion on its own is not progress. The progress scalar is the sum of several
monotonic dimensions: the allowlisted activity counters, plus other milestone-style signals such as
level totals or milestones-earned counts. Each dimension is fail-safe gated; a dimension whose data
is missing is suppressed for that sample rather than read as zero, so a data gap never looks like a
stall or fake progress. Watch this scalar over a sliding time window (illustratively, thirty minutes).
If the scalar hasn't moved for a full window, send the agent a single corrective instruction to
re-steer toward a concrete, reachable goal. This re-steer recurs once per window while the stall
persists. If the scalar is still flat a second window later, escalate to an alert for a human
operator. Guidance: choose dimensions that move only on real progress; a prior incident came from
summing a continuously-rising raw value instead of its discrete level, which masked a real stall.

**Reset:** any observed change in the scalar, whether a rise or an anomalous drop, re-seeds the
baseline and restarts the window from scratch. A drop means state changed, so the agent is not
frozen.

### 4c. Terminal-condition detector

**Prevents:** both mechanisms above, and guard 2 above them, assume the agent could get somewhere if
it replanned better or replanned less often. Against a condition that no currently available action
can change, guard 2 is the wrong instrument. A rolling ceiling bounds spend per window and never ends
the episode, so capping the rate does not bound the waste, it spreads the same futile spend evenly
across forever. What is missing is a stop condition, not a slower clock.

**Trigger:** a conjunction over raw state fields, read fresh on the tick, where every conjunct has to
hold and the conjunction together means "no available action changes this." The source project ANDed
four conjuncts: the cheap automatic remedy is unavailable in the current context, the monitored
resource sits under a percentage warning floor, the agent is not already in the state where the remedy
would apply, and a count of consecutive refusals has crossed a threshold. Read the first three alone
and they say "low, and no remedy at this location," which is a hazard and not a terminal state. The
fourth conjunct was carrying the whole distinction between "low but still able to act" and "prevented
from acting by the floor," and it is also the one conjunct that cannot stay: a count of refused
attempts stops advancing the moment a well-steered agent stops attempting, which is enough on its own
to keep the predicate from closing on exactly the agent it exists to catch.
[`state-based-safety-predicates.md`](state-based-safety-predicates.md) covers that hole.

So a state-only rewrite is not just a deletion. Whatever replaces the counter has to make the standing
conjunction sufficient for "no available action changes this" by itself, which usually means tying the
resource conjunct to the cost of acting rather than to a warning percentage: the resource sits below
what the cheapest action that could reach the remedy would consume. Drop the counter and keep the
warning floor and the detector fires on an agent that is merely low and still able to act, which is a
false terminal call, gating everything in the Response below on a subject that had a way out. Keep the
predicate a pure function over inputs the caller has already computed, so the threshold boundary is
testable on its own without standing up an agent.

**Response:** the detector ends the episode where a throttle only slows it. It owns that episode,
checked ahead of the rolling ceiling and the thrash damper, and it consumes the tick: inside its
window every tick returns without the normal replan instead of letting a capped rate carry on. Once
per window it fires the remedy action itself rather than only instructing the planner to fire it,
because an instruction has to survive a planner call that the same wake pressure can starve. It
raises one operator alert per window. Last, an optional escape hatch, config-gated and off by
default, for the destructive remedy that trades assets for a working state: it fires only after a
longer multiple of the window, and it latches on the attempt rather than on success, since retrying
a fee-incurring destructive action every tick is worse than the stall it means to end.

**Reset:** the predicate going false, nothing else. Recovery needs a real change in external state or
an operator instruction. Elapsed time alone never clears it. That inverts guard 2's rolling window,
and it is why this subsection exists.

**Precedence:** stands down entirely while 4a owns a freeze episode, stays suppressed by an active
guard-1 backoff, and sits ahead of guards 2 and 3. It has to sit ahead of them because its re-steer
is instruction-class and bypasses both, which leaves the once-per-window timestamp latch as the only
bound on its burn.

**Built, and not built:** everything above is described from code and unit tests, and no part of it
from a live episode. The source project built and tested the predicate's truth table one conjunct at a
time, along with the ownership order, the tick consumption, and the once-per-window latch. All of that
then went out behind a predicate that never closed, so no terminal episode ever reached any of it in
production. The destructive escape is a further layer down: off by default, on top of a gate that
never opened. What was never built at all is the response that motivated writing this up, dropping
the loop to a heartbeat-only cadence for the duration of the episode. Consuming the tick inside the
window reaches the same spend reduction without a second cadence mode to reason about, so the
heartbeat idea is recorded as considered and set aside, not as prior art. One project is behind all
of 4c so far.

**How the three relate:** ownership runs 4a, then 4c, then 4b. A hard freeze in raw state is the most
specific reading of "stuck" and claims the episode first. A terminal condition comes next, because it
is a specific diagnosis with a specific remedy, and letting 4b own it would mean re-steering a
blocked agent forever with advice it has no way to act on. 4b takes what is left, the long soft
failure to accomplish anything while state keeps changing. The steward never arms the planner backoff
and never marks the agent stuck on its own, it only re-steers and alerts, and it deliberately stands
down for the whole duration of a 4a freeze episode so those two never act on the same tick.

**Hazard, stated once:** all three mechanisms transfer between projects. Neither the list of counters
that count as productive nor the terminal predicate's conjuncts transfer with them, and both go wrong
the same silent way, breaking a detector's aim without breaking its code. Every project has to name
its own counters, and getting that list wrong (leaving out a legitimate productive counter, or
letting a passive counter that increments on its own sneak in) is enough to blind the steward. The
terminal conjuncts are exposed in both directions: too loose and the detector suppresses replans that
would have helped, too strict and a real terminal state runs forever with nothing flagging it. Prefer
under-firing, since a false terminal call takes away the agent's only route out. That preference has
a bill attached. Tuned tight enough, a predicate that never closes looks exactly like a quiet one,
which is how the source project's hole survived unnoticed.

## Recovery taxonomy

Borrowed from bradygaster/squad (MIT). The four guards above decide when to hold off on a replan;
this taxonomy is about what a replan should actually attempt once one is allowed, and it splits on
one question: is the plan wrong, or is the execution of a sound plan just not landing?

**Right plan, wrong execution.** The approach is fine; this attempt at it failed for some
correctable reason, a step needs a retry, or the failure needs a closer look before trying again.
Handle this with graduated tiers: retry the step as-is, then diagnose what went wrong
before retrying, escalating through the cheap options before reaching for a full replan.

**Wrong plan.** The approach itself won't work, no amount of retrying the same steps will fix that,
so the correct response is to replan from a restated version of the problem rather than rerun the same
runbook with small tweaks. This tier triggers on one kind of signal: feedback that says the approach
is wrong, an operator saying so directly, or a clear structural sign that the goal as stated can't
be reached this way. An ordinary error from a single step is not that signal on its own; it belongs
in the "wrong execution" tier until something indicates the plan itself is the problem.

**Escalate to human.** The final tier, reached when neither retrying the execution nor reframing the
plan resolves things. Surfacing the situation to an operator, rather than looping indefinitely
through the first two tiers, is itself part of the design: a guard with no stopping point is not a
guard.

## Related

[`state-based-safety-predicates.md`](state-based-safety-predicates.md): how to define the terminal
predicate in 4c so it can fire at all. The guards above decide when to hold off a replan, and every
one of them keys off a replan boundary or a wake. A standing hazard predicate runs on a different
clock, since it has to become true for an agent that has stopped acting entirely, which is precisely
the tick where no boundary arrives.
