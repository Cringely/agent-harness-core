# Plan Then Execute

## The shape

Split the work into two halves that run at very different rates. Reading the current situation and
writing a short, ordered runbook of steps, a JSON list naming an action and its parameters for
each step, is a job for the model, and it happens rarely. Running that runbook one step at a time,
on a fast fixed tick, is a job for deterministic code, and no model call is involved. Most ticks
the executor just carries out the next step and moves the cursor forward. The model gets called
again only when the
runbook runs out, a step can't be carried out as written, or something happens that the runbook
never anticipated.

This is a cost strategy as much as a design one. A model call is slow and priced per token; a
deterministic step is neither. Pushing the model to the edges of the loop and filling the middle
with plain code means the expensive part is reached rarely and the cheap part runs constantly.

## Crash-resume through a persisted cursor

The executor's position in the runbook, which step it's on and how many times a repeating step has
fired, is written to storage after every step, not held only in memory. On restart, the executor
reads the same cursor back and resumes exactly where it left off instead of replanning from
scratch. One design constraint rides along with this: a plan is keyed one-per-agent (writing a new
plan replaces the old one outright), so this pattern as described assumes a single active runbook
per agent. Running several plans concurrently for one agent would need a different key, not a
straightforward extension of this one.

## The wake-condition dispatch table

Between ticks, a routine check decides whether the executor should just run the next step or
whether it's time to call the model again. That check is a small ordered table: the first
condition that matches wins, and no match means "keep executing." A representative order, cheapest
and most authoritative reasons first:

| Order | Condition | Meaning |
|---|---|---|
| 1 | Operator instruction | A human gave a direct order; it always wins. |
| 2 | Step blocked | The current step failed in a way retrying won't fix. |
| 3 | No active plan | Nothing is running yet. |
| 4 | Plan done | The runbook finished. |
| 5 | External signal | An event worth interrupting for arrived (a notification, an alert). |
| 6 | Resource floor | A monitored quantity crossed a low threshold. |
| 7 | Heartbeat | The plan is older than the maximum age allowed; replan on a timer even if nothing else fired. |

The heartbeat entry matters on its own: without a maximum age, a runbook that never triggers any
other condition could execute forever without ever being reconsidered, even as the situation around
it drifts.

## Zero-token reflexes

Not every response to a changing situation needs a fresh plan. A small set of conditions are
narrow and safe enough to handle with a hard-coded rule that fires before the wake table is even
consulted: if the situation matches (idle and low on a resource, say), take the fixed remedial
action directly, at zero token cost and without touching the runbook. Reflexes exist for the cases where the
right response is fixed and obvious enough that asking a model to decide would just be spending
tokens to reinvent a rule that never changes.

## The step-result seam

Every step execution returns one of a small set of outcomes, and this return value is the seam
between "the deterministic step ran" and "the loop decides what happens next." A representative
set: the step succeeded and the cursor advances; the step's effect is still resolving and the
executor holds the cursor and retries next tick, no replan; the whole runbook is finished; or the
step is blocked and the executor should stop and let the wake table decide. Nothing about
interpreting this outcome needs a model. The deterministic code that produced the outcome is also
the code that decides what to do about it.

## Cost profile

Ticks are free: reading current state and stepping the executor cost no tokens no matter how often
they run. The one thing that costs anything is a call to the planner, and everything above exists
to make those calls rare and to make each one produce a runbook worth what it cost to write.

## Compaction recovery checkpoint

Borrowed from bradygaster/squad (MIT). A long-running orchestrator that hands work off between
context windows or process restarts can lose track of exactly where it was mid-batch, especially
when the loss isn't a clean crash but a context compaction that drops working memory. The pattern
is a small checkpoint written after each batch of completed work: the last step that finished and
what should happen next, kept separate from the real persisted state described above. On detecting
that context was lost, the orchestrator reads the checkpoint first to get its bearings, then
reconciles against the actual persisted cursor before acting. The checkpoint is a breadcrumb, never
authoritative: if it disagrees with the real state, the real state wins, and the checkpoint is
there only to save the orchestrator from starting a search for its own position from nothing.
