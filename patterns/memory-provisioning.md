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

**Name the scope explicitly.** Notes routinely live under a different project directory than the one
the agent is working in. An agent that searches the wrong scope reports that no record exists, which
is indistinguishable in the output from a record that was never written. Naming both scopes costs six
words and closes the most common miss.

**State that notes carry a date and that live evidence outranks them.** Pointing an agent at memory
makes it trust memory. Without this clause an agent will prefer a stale note to the filesystem in
front of it, and the cost of that scales with the age of the corpus.

**Reserve revisit authority to the operator.** Decision notes that carry a revisit condition hand the
agent an override path on every decision. Agents take it: they observe something suggestive, declare
the trigger satisfied, and proceed as though the decision were reopened. The brief must say that
reporting an observation and handing the decision back is the whole job.

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

What has never been run is the composite. The text committed into the agent definitions is the measured
pointer plus the scope clause, the staleness clause, and the revisit paragraph, and no run has compared
that assembly against the pointer alone. Two of the three additions rest on a mechanism argument rather
than a measurement, so the honest reading is that the pointer produced the measured gain and the clauses
around it are untested additions. A three-arm run comparing no section, pointer only, and the full committed text
would settle it.

## When not to use it

A corpus small enough to inline entirely, or one with no durable decisions in it, does not need a
pointer; put the content in the brief. A corpus large enough that an index no longer fits in context
needs retrieval, and this pattern stops being sufficient at that point.

## Related

[`forcing-functions.md`](forcing-functions.md): this is a tier-3 just-in-time re-injection, where the
rule surfaces at the moment it is relevant rather than at session start where it scrolls away.
