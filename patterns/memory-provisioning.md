# Memory Provisioning

## Problem

A dispatched subagent starts with the code, the task, and nothing else. Every durable fact the
project learned the hard way sits in a memory corpus the agent never opens, because nothing in its
brief says the corpus exists. The config that looks wrong but is intentional, the transport that was
evaluated and rejected, the flag that costs 198k tokens to load: all of it is invisible from inside
the dispatch.

The failure this produces is not obvious in the output. The agent reasons soundly from general
knowledge and returns a confident, well-argued answer that walks straight into a wall the project
already hit. Nothing in the response looks wrong, so the failure survives review.

## The pattern

Put a pointer to the memory index in the dispatched agent's brief. Not a retrieval engine, not an
embedding index, not a second memory system. One paragraph naming where the index lives and telling
the agent to read it before answering anything that turns on a past decision.

Three details are believed to carry most of the value. Their evidence is not equal, and the difference
matters more than the detail does. Only the third was measured as a clause, in a run built to test it.
The first two come from single observations inside a run that was measuring something else, which makes
them plausible mechanisms rather than measured ones:

**Name the scope explicitly.** Unmeasured, and one attempt to measure it came back null. Notes routinely
live under a different project directory than the one the agent is working in. An agent that searches
the wrong scope reports that no record exists, which is indistinguishable in the output from a record
that was never written. A four-arm run put the deciding note in a third project's directory on two tasks:
no agent in any arm retrieved it, and the arm carrying this clause searched a narrower set of scopes than
the arm without it. That is not a refutation, because the clause names the user scope and the current
project scope while the test hid the note in neither. It does mean the clause has never been shown to
work, and a mechanism that sounds obviously right is exactly the kind that measures at zero.

**State that notes carry a date and that live evidence outranks them.** Unmeasured. Pointing an agent at
memory makes it trust memory, and without this clause an agent may prefer a stale note to the filesystem
in front of it. The run built to test it produced no usable task: one of its two stale-note tasks turned
out to have a current note body and a stale index line, and the other's key omitted the clause an answer
had to test. And the arm without the clause detected the staleness unaided on both tasks anyway, which
argues against it carrying weight.

**Reserve revisit authority to the operator.** Measured twice, and the only clause here that is. Decision
notes that carry a revisit condition hand the agent an override path on every decision. Agents take it:
they observe something suggestive, declare the trigger satisfied, and proceed as though the decision were
reopened. The brief must say that reporting an observation and handing the decision back is the whole job.
In the second run the arm carrying this clause returned the decision on both tasks that had a live gate,
in wording that near-quotes the clause, while both arms without it closed the gate on their own authority.

## What it costs

One paragraph per agent definition. The pattern is entirely prose, so it introduces no runtime
component and nothing that has to stay in sync.

## Evidence

Three A/B runs against a 239-note markdown corpus, each with blind scorers on separate lenses.

Adding the pointer took known failures from 3 of 8 to 1 of 8, and recall of the deciding fact from 5
of 8 to 8 of 8. Effective n was 6, because the control arm found memory unprompted on two tasks, which
biases the measured gap downward and makes 3-to-1 a floor rather than an estimate.

Adding the revisit-authority paragraph took agents self-authorizing a decision's revisit trigger from
2 of 4 to 0 of 4, at zero measured cost across three tasks built to catch it inducing paralysis. The
worst control-arm case prescribed a replacement value for a proposed decision and issued three edits
to the note recording it.

A third run tested a paragraph stating that accepted decisions are binding, and measured nothing. A
probe found that rule already loaded in every subagent's context and already being followed. The
distinction is worth keeping. A brief line that closes a gap the agent actually has changes
behaviour; a brief line restating a rule the agent already follows is decoration.

A fourth run compared three arms directly: no section, pointer only, and the full committed text. Across 8
tasks the arms consulted a note 0 of 8, 4 of 8 and 8 of 8, walked into the documented failure 4 of 8, 3 of 8
and 0 of 8, and over-deferred in 0 of 24 answers. So the committed text does move behaviour past the pointer
alone, and it does not buy that with paralysis.

Two things stop this from being a clean win. The outcome measure that matters, whether the advice was
right, is unusable: a scorer flagged a defect in all 8 answer keys on that axis. And the three clauses were
not varied independently, so any gap between the pointer and the full text belongs to the bundle unless an
answer points at one clause, which only the revisit wording did.

Keep the text as written. The case for cutting the two unmeasured clauses rests on one usable task and two
defective keys, and cutting on that is the same error as the claim this section was written to correct.
Re-test them on purpose-built tasks instead: cross-scope tasks that hide the note in a scope the clause
actually names, and stale-note tasks whose note body is stale, not merely its index line.

## When not to use it

A corpus small enough to inline entirely, or one with no durable decisions in it, does not need a
pointer; put the content in the brief. A corpus large enough that an index no longer fits in context
needs retrieval, and this pattern stops being sufficient at that point.

## Related

[`forcing-functions.md`](forcing-functions.md): this is a tier-3 just-in-time re-injection, where the
rule surfaces at the moment it is relevant rather than at session start where it scrolls away.
