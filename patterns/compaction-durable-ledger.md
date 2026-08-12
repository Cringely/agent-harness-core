# Compaction-Durable Dispatch Ledger

## Dispatch state is what a summarizer drops first

A long orchestration session eventually crosses a compaction boundary: the conversation so far is
summarized down to something that fits, and the session carries on from the summary. Summarization
keeps what reads as important, which is the goal, the decisions, the findings that arrived with an
argument attached. What it drops first is bookkeeping, and an in-flight subagent roster is exactly
that. Which agents were dispatched, what each one was asked for, where each was told to leave its
output, which of them have already reported: none of that is interesting to read back, so none of
it is what a summarizer protects.

The orchestrator cannot see the gap from the inside. A compacted context reads as complete, because
what it lost was never a sentence anyone would miss. So the loss shows up two turns later, as one
of two wrong moves. Either the orchestrator re-dispatches work that already finished, paying for it
twice and turning in a second answer that may contradict the first, or it goes on waiting for an
agent that already reported, or already died, and waits until something else forces the question.
Both look like ordinary orchestration while they happen.

The fix is not a better summary. Anything living only in conversation context is subject to
summarization by definition, and asking the summarizer to preserve a roster is a rule at the
weakest tier of [`forcing-functions.md`](forcing-functions.md), enforced by whatever attention is
left at the moment it matters least. Move the record out of context instead.

## The mechanism

The orchestrator keeps an append-only ledger file in the session scratchpad, the per-session
working directory a harness hands out for disposable files. It is ordinary filesystem state, and it
survives a compaction boundary byte for byte because it was never in the context window that got
compacted.

Two writes per dispatch. The first is appended at spawn time, before the agent starts, naming the
dispatch and what a finished result will look like. The window this pattern exists to cover is
exactly the gap between dispatch and completion, so a record written once the result is already
back covers nothing. The second is appended when a result actually arrives, naming which dispatch
it closes and how it ended. Between the two, "running" and "returned" are facts on disk instead of
inferences from what survived summarization.

Entries are appended and never rewritten. Rewriting one in place to change its status discards any
record that the earlier status was ever true, and a truncating write that fails halfway takes the
whole ledger with it. Two lines, one saying dispatched and a later one saying returned, are
self-describing in the order they appear, and a partially written last line costs one entry rather
than the file.

## What an entry carries

A dispatch entry needs an identifier the completion entry can name, the agent's type or name, one
line of purpose, the branch or artifact path where the output is expected, the dispatch time, and
the condition that would count as finished. Record the timestamp in UTC at the point of writing;
a ledger read back on a host in a different zone, or across a midnight, is otherwise answering a
question about ordering with a number that cannot be compared.

The expected-output field is the one that does real work later, and it is the one most likely to be
left out as obvious. Reconciliation asks whether a dispatch produced anything, and that question is
answerable without asking anybody only when the ledger already says where the answer was supposed
to appear. "Reviewer on the orders-import path, verdict to `<scratch>/orders-import-review.md`" can
be checked by looking. "Reviewer on the orders work" cannot.

A completion entry carries the dispatch identifier, how it ended, and where the result actually
landed. It returned a result, it returned nothing, or the orchestrator abandoned it. Those endings
stay distinct, because collapsing the middle one into the last is how a delivery failure gets
recorded as a decision.

## What does not belong in it

Not the brief, and not the result body. A ledger whose entries have to be read in full is a second
context window with worse ergonomics, when what it has to support is a scan down to the open
dispatches. Bulk text goes in its own scratch file and the ledger carries the path.

Not anything meant to outlive the session. The scratchpad is session-scoped, which is what makes it
the right home for in-flight state and the wrong home for everything else. Decisions, lessons, and
project state belong in the repo and in durable memory notes, exactly where they belong today. This
is a scratch ledger for one session's dispatches, and saying so in the file's own header is cheaper
than arguing the scope back down after somebody starts writing conclusions into it.

Not anything an authoritative record already answers. Where the harness itself writes a transcript
or an event log of what actually happened, that record outranks a hand-written one, and the
hand-written one is a second source that can drift from it. This repo has already made that call
once in the other direction: `core/claude/hooks/dispatch-audit.ts` deliberately declined to port a
self-attested per-turn ledger from its source project, on the grounds that the real transcript was
available to read instead. Write the ledger here only where no such record exists, or where one
exists and is not readable at the moment the answer is needed.

## The failure it prevents

Take an orchestrator fanning out five reviewers across five subsystems of an orders service. Three
verdicts land, then compaction hits. The summary keeps the three findings and the sentence that
reviews are in flight, and drops which two subsystems have no verdict yet, because that detail was
last mentioned in a dispatch notification twenty turns back.

From there, re-dispatching all five is the expensive mistake and the safe-looking one: it pays for
five reviews to get two, and the three repeat reviewers now read a tree that the first round's
fixes have already changed, so they file findings that contradict verdicts the orchestrator is
still holding. Declaring the review complete on three of five is the cheap mistake and the one
nobody catches, because a fan-out that covered three subsystems and a fan-out that covered five
produce the same shape of report. With a ledger, "which dispatches have no completion entry" is a
read of a file, and it is the same read whether two are outstanding or none.

The second failure is silence read as approval. A dispatch that returns nothing must not read the
same as a dispatch that found nothing, and after a compaction the default reading of silence is
"still working." The ledger does not recover the lost output and does not repair whatever swallowed
it. What it changes is that an open entry, with the session otherwise finished, is a recorded fact
rather than an inference nobody drew. That is the same gap `core/claude/hooks/review-gate.ts` has
on the commit side, described in [`forcing-functions.md`](forcing-functions.md): a gate that clears
on a review having been requested cannot tell a reviewer that filed findings from one that went
idle.

## Reconcile on resume, do not trust

The first thing the orchestrator does after a compaction boundary is read the ledger, list the
entries with no completion, and check each one against what is actually running or actually on
disk. Reconcile is the operative word. The ledger records what the orchestrator believed at write
time, and an agent can die without anyone writing its completion entry, so an open entry means
unresolved and never means still running. Resolving it takes a look outside the ledger, at the
expected artifact path, the branch, the worktree.

A missing or empty ledger is indeterminate, not empty. That rule is borrowed from `bradygaster/squad`
(MIT), by way of the comment block at the top of `core/claude/hooks/dispatch-audit.ts`, which records
that squad's own ledger treats a missing or empty file as indeterminate rather than as a free pass.
It holds for the reason [`ablation-verification.md`](ablation-verification.md) gives: read as
"nothing was outstanding," an absent file is indistinguishable from a file that was never written,
and a check that examined nothing reports exactly what a check that passed reports. An orchestrator
that finds no ledger has learned nothing about its dispatches and should say so rather than proceed
as though the roster were clear.

## Honest limits

The ledger is self-attested. Nothing verifies it against what happened, and nothing forces the
completion entry to be written, so an orchestrator that forgets one leaves an entry open forever
and an orchestrator that stops writing entirely leaves a ledger that looks fine and is a turn
stale. That places this at the prose tier of the forcing-function hierarchy on its own. Moving it
up means a hook that writes the dispatch entry from the dispatch call itself, which is a different
change with its own registration and test obligations, not a footnote to this one.

It is overkill for a session that dispatches two agents and finishes inside one context window. The
cost is a write per dispatch plus the discipline to keep it current, and below a handful of
concurrent outstanding dispatches the roster fits in a sentence that survives compaction on its own
merits. The pattern starts paying somewhere around the point where the orchestrator can no longer
name every outstanding dispatch from memory, which is also the point where nobody notices it can't.

It does not survive a new session, which is by design, and it does not survive the scratchpad being
cleaned, which is not.

## Provenance

Everything above is a design. No code of this shape, dispatch entries paired to completion entries,
has been built or exercised. The nearest prior art that does run is `bradygaster/squad`'s
`.squad/hooks/dispatch-audit.sh` (MIT), described in the comment block at the top of
`core/claude/hooks/dispatch-audit.ts`: a self-attested JSONL ledger the coordinator appends to every
turn. What it attests is per turn rather than per dispatch, so it answers whether the coordinator has
been dispatching at all, and not which dispatches are still outstanding, which is the question this
pattern is built around. Two recorded episodes from one project motivated the design, both of them
dispatch state lost at a compaction boundary and both diagnosed after the fact. What generalizes here
is the shape of the record and the reconciliation habit, not any claim about how well it holds.

## Related

[`event-sourced-state.md`](event-sourced-state.md): the same instinct, append the fact where it
cannot be lost, on a different clock. That log is durable project history, outlives the process,
and answers questions about what an agent did over its lifetime. This one is scratch, dies with the
session, and answers one question about right now. Keeping them separate is deliberate: a scratch
ledger promoted to durable storage inherits a retention policy and a schema, and avoiding both is
most of what makes this cheap enough to bother with.

[`forcing-functions.md`](forcing-functions.md): why a rule to remember the roster is the weakest
available tier, and where the silence-as-approval reading already sits in this repo's own gates.
