# Replan Guards

## Why four guards, stacked

A plan-then-execute loop calls a model only when a wake condition fires, but "only when it fires"
is not the same as "rarely enough to afford." A single failure mode, a planner that keeps timing
out, a step that keeps failing the same way, an agent circling without making real headway, can
each drive the wake condition to fire on almost every tick. One guard rarely covers every failure
shape, so this pattern stacks four, each catching a different one, checked in order before a
replan is allowed to happen.

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

## 4. Monotonic-scalar no-progress detector

**Prevents:** an agent that is technically active, replanning, executing steps, avoiding the other
three guards, while never actually advancing toward any goal.

**Trigger:** define a small set of counters that only ever increase, and only on an actually
productive outcome (completing a unit of work, producing something, earning something). Sum them
into one scalar. If that scalar hasn't moved across several consecutive replan boundaries
(illustratively, six), the agent is stuck: arm a backoff and flag it. Positional or movement
counters (distance covered, steps taken, locations visited) are deliberately left out of the sum,
because motion on its own is not progress, and including it would let an agent wandering in place
read as advancing.

**Reset:** any observed rise in the scalar clears the stuck flag.

**Hazard, stated once:** the four mechanisms above transfer between projects; the specific list of
counters that count as progress does not. Every project has to name its own set, and
getting that list wrong (leaving out a legitimate productive counter, or letting a passive counter
that increments on its own sneak in) breaks the detector's aim without breaking its code.

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
