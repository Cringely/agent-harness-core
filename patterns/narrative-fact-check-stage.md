# Narrative Fact-Check Stage

## A green gate measures the sentence, never whether it is true

A reconciliation pass brings a status doc, a milestone log or a lessons file back into line with
what merged. It runs every mechanical gate the project has: a word cap on the summary block, a size
cap on the new entry, a duplicate-heading test, the suite on the branch. All of them come back green.
The prose still says a batch was deployed when half of it was unmerged, that content was moved when
it was deleted, that a resource was harvested when nothing was harvested, that a bug is still live in
the same block that records its fix as merged. None of that is a gate failure. A cap measures length.
A suite measures behavior. A duplicate-number test measures numbers. Nothing between the pass and the
merge reads the sentence for whether the thing it describes occurred.

One project recorded that shape thirteen times in nine weeks against the same kind of pass, and the
count was still climbing in the most recent session. Four consecutive passes went to an independent
fact-check and every one came back with false claims: eight, then three, then four, then four. The
gates were green on all four. What caught the claims was a separate stage, dispatched apart from the
writer, reading the diffs and the logs instead of the draft.

## What the false claims look like

They read as ordinary, competent prose. That is the whole difficulty, and it is why the sub-classes
are worth naming, because each one defeats a different kind of skim.

**Deleted, described as moved.** A rewrite of the live-summary block says "moved out to history,
nothing dropped." The facts that used to sit in the block, deploy identifiers, a list of open items,
the issues awaiting live proof, exist nowhere in the new file. The claim is true of the block and
false of the file. Check the old block's facts against the whole new file, never against the section
that replaced it.

**Deployed, inferred from a date.** A whole batch is written up as deployed on one image because the
image was built after the batch's pull requests merged. The image's commit was one PR's merge commit,
and three others in the batch merged after it. Whether a commit is in a build is a graph question,
`git merge-base --is-ancestor <commit> <build-commit>`, and a date answers a different question.

**A citation that cannot carry its claim.** Two shapes so far. A correctly formatted citation
attached to the wrong entry, because new entries were inserted above the file's trailing source line
and the old citation now read as theirs. And an entry sourced to a file that exists only outside the
repository, in an operator's private rules, so a reader following the citation finds nothing. Both
passed every gate. A citation's format is what a gate can check, and its referent is not.

**A duplicate lesson that argues for itself.** A lessons file gained an entry restating a principle
the file already carried under another number. The new entry's own text waved the old one off as
being about something narrower. That was a misreading of the entry it duplicated, so a reader who
checked the citation would have been reassured by it. A diff shows added lines only, which makes a
duplicate invisible in review unless the reviewer lists the existing headings first.

**A figure its own paragraph contradicts.** "Nineteen merged" in one line, then "nine on the first
day, six on the second" in the next. Nine plus six is fifteen. The true figure was thirty. This is
the cheapest catch there is, one subtraction and no external source, and it goes first.

Two more belong on the list. Activity that never happened: a resource "harvested" when the event
log shows three refused purchase attempts and thirteen idle hours. And the just-fixed bug described
as live, in the same summary block that records the fix as merged, which is the costliest form when
a fresh session boots from that block. Numbers invite scrutiny. A wrong verb reads as progress and
gets nobody's second look, so fact-check the verbs.

## Why the writer's own discipline does not close it

This repository's reconciliation role already carries a cite-or-do-not-write rule, and it is the
right rule. It is also not enough, for the same reason an author reviewing their own diff misses
what they were blind to while writing it. A pass that writes narrative from sources it read but did
not execute has one model of what happened, and everything it writes and everything it checks come
out of that one model. From inside the model that thought it up, a duplicate looks like a new
lesson, and the batch looks deployed because the same model ordered the events wrong.

Corrections do not close it either. Repeatedly in the record, a consolidated correction went back
into the authoring context, and the class came back on the next pass. A correction goes into a
context that ends with the pass. What survives is a stage the next pass has to get through.

One caution on attribution, because the record holds a case that inverts it. Three times in a row
a pass's evidence claimed a set of files had been regenerated, and the diff held none of them. That
read as one agent fabricating three times, and it drew two corrections aimed at the agent. It was
a script. The
project's prep tool returned a hardcoded evidence sentence whenever its command exited zero, whether
or not any file changed, and the pass was pasting that output verbatim as its charter required. The
stage catches the false claim either way. Before the finding becomes "this role is unreliable,"
check whether a tool handed it the sentence.

## The shape

Dispatch the fact-check as its own stage, after the writing pass and before merge, in a different
context and, where the writer runs on a cheap tier, on a stronger one. Give it the primary sources
and never the draft's account of them: the actual diff of every changed file, the merge and deploy
history, the tracker's current state, the event log or test output the prose summarizes. Its job is
one question per added claim. Is there a source that establishes this, and does the source say what
the sentence says?

Order the work by cost. Reconcile the document against itself first, since an internal contradiction
needs no authority to adjudicate. Then the graph checks: is-ancestor for anything called deployed,
the old block's facts against the whole new file for anything called moved, the existing headings
for anything called new. Then the verbs against the log. Then the citations, followed to where they
point.

Cover every file in the diff. The record's worst incident came after two rounds of correction on
one file. The checker verified that file and merged, and a sibling file written in the same pass
carried the same inverted sentence to the default branch. A corrected claim survives by migrating.
Take the distinctive phrase and search the whole diff for it.

Verify against current state, not against the brief. One pass wrote claims that were true at
dispatch and stale by the time it finished, because the system kept moving underneath it. The brief
goes stale on the same clock, so a check that the prose matches the brief proves nothing.

Send the findings to the artifact, not to the writer, and change something durable in the same
turn: a checklist line, a template that pastes `git diff --stat` in place of an authored file list,
a test wherever the check is mechanical. The duplicate-lesson finding became two tests in that
project's suite plus one charter line for the half no test can grade. A correction that changes
only the prose has to be found again next time.

## What it costs, and when to skip it

The stage is a second dispatch per docs-bearing change, on a stronger tier than the writer, reading
sources the writer already read. The reading is where the cost sits. The check has to open diffs,
walk merge history and pull a log, and a checker that skips any of that is back to reading the
draft. It also puts a round of latency between the pass and the merge. That is the right trade
wherever a person or a fresh session acts on the doc without re-deriving it, which is what a status
summary, a milestone log and a lessons file exist for.

It is not worth running on a change that adds no claim about what happened. A link fix, a
regenerated file whose generator output is in the diff, a deletion, a format change and a typo
carry nothing to fact-check. Nor on a doc nobody boots from or decides on, where a false sentence
costs nothing because there is no reader. And it runs once. The stage finds what it finds, the
corrections land, and a second round happens only if the corrections themselves added claims. A
fact-check that runs until it finds nothing has no stopping point, because a careful reader
always finds something, and the severity floor that decides what gets fixed now and what gets filed
belongs to this stage as much as to any review.

## Provenance

The record comes from one project so far, thirteen incidents between 2026-07-18 and 2026-09-19.
The last of them, the eight-claim pass, was also the first of four passes fact-checked in the
session that promoted this doc, so the record holds sixteen events, not seventeen. The eight is in
that project's incident log. The three, four and four that followed exist only in the session
record. Most were a documentation-reconciliation pass on a cheap tier by design, but two were
implementer lanes reporting on their own work: one asserted pilot state it had not observed, and
one reported a passing test count measured before its last edit.
So the class is not one role. It is any agent writing narrative prose about work or state it did not
directly observe, on any tier: the eight-claim pass ran on a mid-tier model and was caught by a
stronger one. What is local to that project is the specific gates that were green, a size cap and a
lessons-file test, and the tooling defect behind one recurring claim in three of the thirteen. The
promotion rests on volume and on the class spanning two roles, not on the second project that
`CONTRIBUTING.md` normally asks for.

## Related

[`ablation-verification.md`](ablation-verification.md) has a section on a check that examines
nothing looking exactly like a check that passes. A green gate over prose is that shape: the gate
ran, and it read nothing the claim depends on.
[`test-falsifiability.md`](test-falsifiability.md) is about a measurement that cannot separate a
claim from its opposite. A size cap cannot separate a true sentence from a false one of the same
length, and the fact-check stage is the instrument built to.
[`forcing-functions.md`](forcing-functions.md): a rule the writer carries is prose, and the record
shows it missed under load. The stage is the forcing function behind it.
