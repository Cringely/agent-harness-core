# Parallel Review Orchestration

## Why splitting a review across agents usually makes it worse

One reviewer over a large diff runs out of attention before it runs out of files. The obvious fix
is more reviewers, and the obvious fix fails in a predictable way: two agents handed the same diff
return the same finding worded differently, disagree on severity, contradict each other's verdicts,
and leave the person who asked for the review doing the reconciliation by hand. The review got
faster and the author's job got harder.

What makes a fan-out work is not the number of reviewers. It is that each one has a lane it cannot
leave, a scope small enough to hold, and an output shape that merges deterministically. Get those
three right and adding reviewers adds coverage. Get them wrong and adding reviewers adds noise.

## Lanes are defined by what a reviewer must not report

A lane stated positively leaks. "Review the logic" and "review the standards" both sound like
license to mention a badly named variable, so both will. Every lane needs its exclusions written
next to its focus, naming the sibling that owns the excluded ground:

- Functional lane: logic errors, edge cases, error handling, concurrency, contract violations.
  Do not report naming, formatting, or house style; the standards lane owns those.
- Standards lane: violations traceable to a loaded standard or convention document. Do not report
  behavioral bugs unless they also break a documented rule; the functional lane owns those.

Name the sibling, because a reviewer told only "don't report style" reports style anyway, reasoning
that this case is too important to leave out. A reviewer told another agent is already covering that
ground has somewhere to put the impulse.

## Size the change before dispatching anything

Sizing is a cheap step that decides everything after it, and skipping it is how a fan-out ends up
either wasteful or truncated. Count changed files and changed lines, then pick a tier:

| Tier | Files | Diff lines | Strategy |
|---|---|---|---|
| Small | under 20 | under 400 | one reviewer per lane, whole diff inline |
| Medium | 20 to 49 | 400 to 999 | one reviewer per lane, diff passed by path |
| Large | 50 to 99 | 1,000 to 2,999 | batches of at most 30 files, one lane pair per batch |
| Extra large | 100+ | 3,000+ | multiple rounds of batches, highest-risk paths first |

When file count and line count select different tiers, take the smaller one. A 200-file rename
touching two lines each is not a large review, and treating it as one buys nothing but dispatch
overhead.

Batched reviewers report findings only for the files in their batch, but they read the full diff.
Scope for reporting and scope for reading are different things, and collapsing them is how
cross-file defects survive a batched review: the caller changed in batch 1, the callee in batch 3,
and neither reviewer could see both.

Risk-order the batches for the largest tier. Paths carrying auth, credentials, tokens, payment,
migrations, routing, or schemas go in the first round, so that a review interrupted halfway
through has still covered the parts where a missed defect costs the most.

## Hand material off through files, not through context

The dispatcher already knows the diff. Pasting it into every reviewer's prompt pays for it once per
reviewer, and pays again when the findings come back inline. Write the material to a scratch
directory and pass paths:

- The dispatcher writes the diff, the requirements, and any earlier findings into a gitignored
  scratch directory, then names those paths in each brief.
- Reviewers read the paths they were given. Their reports carry the verdict, severity counts, one
  line per finding, and a path with a line number for anything the dispatcher must open itself.
- Long output a reviewer produces goes to a scratch file too, if it holds write access. Reviewers
  without write access keep their reports dense instead.

Read-only stays the default for a reviewer. A reviewer that can edit the code under review can
bury a finding in a fix, which is exactly the failure mode a separate review exists to catch. The
cost is a reviewer that can't write long output to disk, and that cost is small, since the diff
going in is far larger than the verdict coming back.

Whatever the container, each file gets read exactly once, in full, and parallel reads go out in one
batch. Re-reading a file to double-check a line already in context is the most common way an
agent burns its budget without changing its answer.

## Merge on rules, not on judgment

The merge step is arithmetic and should never be a second opinion. Fixed rules, applied in order:

1. Concatenate findings per lane, then deduplicate on file plus line plus claim. Two lanes landing
   on one line is normal, not a conflict.
2. Union the affected-file lists. Where a file appears twice, keep the higher risk rating and sum
   the issue counts.
3. Re-derive each file's issue count by counting the findings that reference it, rather than
   trusting the number a reviewer reported. Reviewers miscount.
4. Take the strictest verdict any lane returned. One critical finding anywhere forces the strict
   verdict regardless of what the lane that found it concluded.

A merge that has to weigh which reviewer was more persuasive has become a third review, with none
of the second review's independence.

## Collect findings, then try to break them

A fan-out multiplies plausible-but-wrong findings as readily as real ones, and a report of forty
findings where nine are wrong is worse than a report of nine confirmed ones: the author loses trust
in all forty. Verification is a separate pass whose explicit goal is to disprove:

- Send the verifier the finding, the reference or rule it claims to violate, and the file, and ask
  it to read the rule in full rather than work from the finding's summary.
- Have it search for contradicting evidence as deliberately as confirming evidence, and trace
  whether the precondition the finding assumes actually holds in this codebase.
- Let it return one of three verdicts, not two: confirmed, disproved, or downgraded. Most wrong
  findings are not fabrications, they are real observations with an inflated severity, and a binary
  verdict forces those into whichever answer is less accurate.
- Verify one lane's findings as soon as that lane returns. Waiting for every lane before starting
  verification wastes the time of every lane that finished early.

## Decide up front what a garbled reviewer earns

A reviewer that returns malformed or empty output gets exactly one retry, narrowed to the
highest-risk files in its scope. If the second attempt is also unusable, the orchestrator says so
in the report and presents the raw output. It does not quietly drop the lane, and it does not
present a partial review as a complete one. Silent coverage loss is the one failure this whole
structure exists to prevent, and it is the one an orchestrator is most tempted to paper over.

## Prior art

The lane exclusions, tier-based batching, and file-based findings handoff here are adapted from the
code-review command set in Microsoft's hve-core, with the announcement scaffolding dropped and the
verification pass generalized past security scanning.
