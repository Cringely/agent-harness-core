# Forcing Functions

## Why a rule needs a mechanism, not just a sentence

A prose rule is a sentence that says what should happen: "review a change before merging it,"
"refresh the status doc after a merge." A capable reader, human or model, might follow it every
time. A distracted one, working a long session or a cheap model under load, will eventually drop
it, and dropping it costs nothing to notice until the gap has already caused damage. A forcing
function is machinery that makes the right thing happen (or blocks the wrong thing) without
anyone remembering to. It doesn't guide judgment; it removes the need for it. A missed rule is
best read as a gap in the setup, not a failure of willpower, and the fix is to move the rule
closer to code rather than write it more emphatically.

## The hierarchy, strongest first

1. **Automate it away.** The system just does the thing; nothing to remember. Best for mechanical,
   deterministic work. Example: a documentation-reconciliation role regenerates a project's
   status summary after every batch of merged work, so no one has to remember to update it by
   hand.
2. **Gate the trigger.** A check runs at the exact moment the rule applies and either reminds or,
   for a rule that has already burned a team twice, blocks. Example: a pre-dispatch check that
   refuses to hand a repo-writing task to an agent working in the shared checkout unless the
   dispatch also names an isolated workspace. The second time a collision happened, a reminder
   stopped being enough.
3. **Re-inject just in time.** Surface the rule into view right when it's needed, not once at the
   start of a session where it scrolls out of context within a few turns. Example: a session-start
   hook that reprints the top of a project's rule catalog into every fresh context. A second example
   runs at the same moment on a different payload. A session-start hook asks the issue tracker for
   open items automation filed under a known label and prints a short banner annotated with each
   item's age, capped at a few rows with a line naming the real count when there are more, and
   prints nothing at all when the query fails or comes back empty. Items a machine filed land
   outside whatever ordering a person actually reads, so they stay unseen on the sessions that would
   have acted on them. One thing about that second shape is worth recording whether or not anyone
   builds it: it needs a filer, not a ledger. Installed where no automation ever opens an issue, it
   queries once a session and prints nothing, permanently, so the gate it wants is keyed on whether
   some component files work items under a known label, which is narrower than whether the project
   runs recurring ceremonies. Nothing in this repo files issues, so that axis has nothing to read
   yet, and the mechanism stays described here rather than installed.
4. **Prose, backed by review.** This is the weakest tier, written down and enforced only by a
   human or a reviewing agent noticing a violation. Reserve it for judgment calls that actually
   resist automation, and treat a rule that keeps getting missed at this tier as a signal to move
   it up, not a reason to write it more firmly.

## What the isolation gate leaves to the dispatcher

The pre-dispatch check in tier two is worth a closer look, because three of its edges showed up in
practice and none of them is visible from the rule as written. They do not rest on the same
evidence. The first is a property of the dispatch call that anyone can check, and the third is a
correlation whose cause was never established; both come from a single project so far. The second
sits between them, a setting nobody has captured a value for, with one observation in each direction
from two different projects.

Start with what the corrective action actually does, and with what it leaves open. A dispatch that
asks for an isolated workspace forks the dispatching session's current working directory. That
settles which clone the agent gets, and not which commit inside it. It does not accept a target
repository as an argument, and nothing in it names one. A project that keeps its issue tracker and its
code in two separate clones has a way to get this wrong that never announces itself: open the session
in the tracker clone, and every isolated agent receives a worktree of the tracker. By construction,
every time, not intermittently. The wrong worktree looks entirely valid from inside it. There is a
main branch, commits are accepted, the tree comes back clean when the agent finishes, and no
continuous integration will ever read a line of it. Nothing here argues against the gate. Its
wording is what fails. A check that names a corrective action ("dispatch into an isolated
workspace") without naming the mechanism behind it leaves the dispatcher one unstated
assumption away from a silent wrong-repo result, and the cost of catching it falls on whichever
dispatched agent notices the files are missing. A gate's message is prose too, and it earns the same
treatment as any other rule: say what the machinery does, not only what to type.

The commit is the second edge, and it is open in a way the clone is not. The worktree tooling
documents a setting for the base it branches from, `worktree.baseRef`, with two values and a stated
default: one takes the remote's default branch, the other takes the local HEAD the caller is sitting
on. Whether that setting reaches a workspace an agent dispatch creates, rather than only one a
session opens for itself, is unconfirmed. This repo's templates set neither value, and neither of
the incidents below was checked at the time for the value it came up under, so the base a project
gets today is documented and never captured. Two incidents, in two different projects, broke in
opposite directions. In one, the dispatcher sat on a feature branch and the agent came up on the
default branch, holding code where the file and line anchors in its brief did not exist. In the
other, the worktree came up on the branch the dispatcher happened to be working on rather than on
the clean default branch its brief assumed. Both cannot be true of one fixed behavior, so an unset
two-valued setting is the likeliest reading of the pair, and a reading is all it is until someone
captures a value. A single capture settles both questions: dispatch an isolated agent from a
non-default branch and have it report the sha its worktree came up on, once with the setting absent
and once with each value written in.

The rule worth taking from this holds whichever value turns out to be the default, which is the
reason to write it down now rather than wait for that capture. The dispatch states the sha the work
is meant to start from, the agent compares that against the worktree's HEAD before it reads or
writes a file, and a mismatch aborts the task instead of being worked around. Pinning the setting
fixes one direction and quietly breaks whoever assumed the other; the assertion is correct under
both, and it stays correct if the default ever moves. Prose alone will not carry the assertion. A
step-0 instruction to reset and check, written at the top of a brief in one of those incidents, was
skipped by the agent that received it, which then rewrote the wrong document at length. The tiers
above say where that leaves it: the gate can require the dispatch to carry the sha, because a check
running before the tool call cannot inspect a worktree that does not exist yet, and only the agent
inside the worktree can confirm the sha it came up on.

The third edge is that correlation, and it stays one. Dispatches that gave the agent a name and
omitted isolation went idle and returned nothing, four times out of four, across three agent types
including a read-only planner that had nothing to collide with. The identical briefs, re-dispatched
with isolation, completed six for six across two further agent types. A competing explanation is
already written down in this repo: the Output Contract note in
`core/claude/templates/agent-def-authoring.template.md` records that a detached or teammate
dispatch's final message never reaches the dispatcher unless the definition names an explicit
delivery path. Every dispatch that went silent carried a name, which is the kind of dispatch that
note is about, so lost delivery is a candidate in its own right and isolation may be a bystander.
The six recoveries do not settle it, because they changed two things at once: isolation was added,
and the agent types were not the ones that had gone silent. So nothing in the ten observations
separates a workspace bug from a delivery bug. The correlation goes on the record as a correlation,
and no rule follows from it yet.

What earns a place in a doc about forcing functions does not depend on which candidate is right:
either way the dispatch produced nothing, and nothing downstream could tell that from a clean
result. That is where the existing gate's coverage stops. The check in
`core/claude/hooks/agent-worktree-gate.ts` decides whether a dispatch needs isolation by first
asking whether the agent type can write at all, and it returns an allow for a read-only type before
the isolation question is ever examined. So it covers the dispatches whose silence would have been
obvious anyway, since an agent that was supposed to change files leaves no changed files behind, and
it leaves uncovered the ones where silence costs most. A reviewer's or a planner's whole output is
its final message; nothing else records that the work happened.

The rule the four silences do support is independent of the cause: a dispatch that returned nothing
must not read the same as a dispatch that found nothing. This repo's opt-in commit gate,
`core/claude/hooks/review-gate.ts`, is where they read the same. It clears a staged file once a
dispatch to a reviewer type appears after that file's last edit and never reads what came back, so a
reviewer that went idle clears the commit exactly as one that filed findings does. That puts the
silence-as-approval reading into code instead of leaving it to a dispatcher in a hurry. A gate that
answers "was this reviewed" needs evidence the review returned, not evidence it was requested.

## Every important prose rule gets a mechanical twin

A rule worth stating is worth checking somewhere code actually runs: a schema, a test, or a hook.
Prose alone guides a first attempt; the check catches the attempt that goes wrong. A concrete
shape: a planner's briefing tells the model, in prose, that a request's category must be one of
five fixed values. A model once produced a sixth, plausible-sounding value that wasn't on the
list, and the system silently dropped the request. So the same rule also lives as a hard
constraint on the code path that accepts the request, an enum of exactly those five values that
is checked before the request can go anywhere. The prose helps the model choose right the first time;
the schema guarantees a wrong choice can't get through even when the prose fails.

This project's own guardrails catalog works the same idea into a standing example: a challenge
rule requiring whoever holds the coordinating seat to push back on weak ideas before acting on
them stays at the prose tier by default, backed by a session-start reminder, with a dedicated
adversarial-review role as its mechanical twin for anything that needs a harder pass than a
reminder can give. See the worked row in `core/claude/templates/guardrails.template.md`.

A second shape, this one from an action that cannot be taken back. An operator can leave a standing
instruction that the planner reads on every wake, and one action in the registry is one-shot: it
closes a job out for good and charges a cancellation fee to do it. Retirement of that standing order
was keyed to a done flag the planner itself was asked to set, and the flag was read only on the
wakes where the standing-instruction block happened to be rendered into the prompt. A planner that
never set it left the order in force. Every replan read the order again, ran the irreversible action
again, and paid the fee again, forfeiting whatever the job had accumulated. Nothing else expired the
order. The instruction store dropped entries only on hitting a maximum count, so what removal
existed was a side effect of volume rather than a retirement rule. Put plainly: the safety of a
repeatable destructive order rested on the model choosing to report itself finished.

The mechanical twin is to retire the instruction deterministically, in the same transaction that
records the action's execution, keyed off a flag on the registry entry (this action is one-shot,
this action cannot be undone) rather than off anything the planner emits. The write that says the
action ran is the write that revokes the order, so no wake exists in between where the record is
already stored and the instruction is still live. A model volunteering that it is finished is the
kind of cooperation a forcing function exists to remove the need for, and an action that repeats
freely and cannot be undone is where leaving that cooperation in place costs the most. This example
comes from one project. The loop is a recorded episode; the retirement above is a design, not a
mechanism this doc can point at in running code.

## Promoting a rule from note to mechanism

Most rules start life as a note about one incident: something went wrong, someone wrote down why.
The first occurrence stays a note; writing a mechanism for something that happened exactly once
is usually wasted effort. A second occurrence of the same class of failure is the actual signal:
the note alone didn't hold, and it's time to move the rule up a tier, into a schema, a test, a
hook, or a documented convention a reviewer checks for. Once the rule is promoted, the original
note shrinks to a pointer ("see the gate that now enforces this") rather than staying a full
explanation nobody rereads.

This lifecycle isn't specific to coding agents. A homelab operator's own change-management rules
describe the identical shape for infrastructure work: "when the same class of failure appears more
than once across sessions, promote it from an incident note... to a permanent rule." Same pattern,
different domain. The trigger is always the second occurrence, never the first.

## Ceremony ledgers: making a scheduled check idempotent

A recurring check (a standup summary, a periodic strategy review) needs to know whether it's due
without depending on any one session to remember it already ran. A small ledger file answers this:
one entry per ceremony, its cycle length in hours, and the timestamp it last ran. At the start of a
session, compare now against last-run-plus-cycle; if the ceremony is overdue, run it and write the
new timestamp back. Running the check twice in a row when nothing is due does nothing extra, and a
session that happens to start right when a ceremony comes due always catches it; no session has to
carry the memory that a prior one already fired it. A ceremony that tolerates running a bit early
or late (a loose cadence) can be flagged as approximate, separate from one that needs to fire close
to on time; folding both into one strict rule either nags on the loose ones or lets the strict ones
drift.

## Three patterns borrowed from bradygaster/squad (MIT)

**Reviewer lockout.** An agent whose work is rejected in review does not get to retry the same
task. The seat coordinating the work reassigns it to a different agent, or escalates to a human,
rather than sending the rejection back to the author, because an author who just had a change
rejected is primed to defend the choices that led there, and a second attempt from the same agent
leans toward rationalizing rather than reconsidering. A task rejected twice is usually a sign the task
itself is off, not that the wrong agent got it. This project's own review role already applies the
rule directly: on a reject with a defect, it sends the fix to a different implementer and escalates
rather than asking the original author for a third try.

**Coordinator restraint.** The seat coordinating work across several agents carries its own
explicit limits: skip context an agent already has, keep analysis to what was actually asked for,
spawn follow-up work only when authorized, and hold commentary to a sentence or two. A coordinator
that narrates everything it's doing burns the exact budget of context and attention that the rest
of the setup exists to protect. This complements, rather than
conflicts with, a rule that requires pushback on weak ideas: restraint caps how much gets said by
default; a pushback rule governs what must get said when something is actually wrong. Quiet unless
there's a real reason not to be.

**Auto-triggered retrospective.** A build failure, a failed test run, or a rejected review
automatically produces a short, fixed-format note (what failed, the likely cause, what class of
problem it belongs to) routed into wherever the project keeps decisions and incidents. This is
what feeds the promotion lifecycle above: by the time a second occurrence of the same failure shows
up, the first one is already on record in a consistent shape, instead of living only in whoever
happened to notice it the first time.
