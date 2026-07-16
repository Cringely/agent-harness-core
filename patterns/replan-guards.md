# Replan Guards

## Why four guards, stacked

A plan-then-execute loop calls a model only when a wake condition fires, but "only when it fires"
is not the same as "rarely enough to afford." A single failure mode, a planner that keeps timing
out, a step that keeps failing the same way, an agent circling without making real headway, can
each drive the wake condition to fire on almost every tick. One guard rarely covers every failure
shape, so this pattern stacks four guards, checked in order before a replan is allowed to happen.
The fourth is really two separate mechanisms, because "frozen" and "busy but going nowhere" are
different failure shapes that need different detectors.

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

## 4. No-progress guards: two separate mechanisms

"The agent is stuck" turns out to mean two different things, on two different timescales, and this
pattern uses two independent mechanisms rather than one, because collapsing them loses real
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

**How 4a and 4b relate:** the steward never arms the planner backoff and never marks the agent
stuck on its own, it only re-steers and alerts, and it deliberately stands down for the whole
duration of a 4a freeze episode so the two never act on the same tick. 4a catches a short, hard
freeze in raw state; 4b catches a longer, softer failure to accomplish anything even while state
keeps changing.

**Hazard, stated once:** both mechanisms transfer between projects; the specific list of counters
that count as progress does not. Every project has to name its own set, and getting that list wrong
(leaving out a legitimate productive counter, or letting a passive counter that increments on its
own sneak in) breaks the steward's aim without breaking its code.

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
