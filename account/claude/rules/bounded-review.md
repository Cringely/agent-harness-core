# Bounded Review

## Work has to be able to end

Operator challenge, 2026-09-05: "you tend to find new work in every work stream I ask you to do.
how can we limit that so you don't derive an infinite amount of work that never gets completed?"

The session that prompted it had a backlog that shrank, roughly fourteen items closed against five
filed. The growth was not in the backlog. It was in the review loop, which has no terminating
condition: adversarial review always finds something, so "done" defined as "no reviewer has an open
finding" cannot be reached. Reviewers were correctly told to report everything including
low-confidence items, with the promise that filtering happened downstream. The filtering never
happened. Unfiltered review output got treated as a work queue, and each round of fixes earned a
round of review that produced the next queue.

Four rules, and the first is the one the other three follow from.

**Close on the invariant, not on the absence of findings.** `fix-quality.md` already requires naming
the violated invariant before writing a fix. Name it before starting the work as well, and let it
define done: the invariant is restored and a test pins it. A finding outside that invariant is
someone's next task, not this one's blocker.

**Put a severity floor on what gets acted on.** Correctness, security, and anything that fails open
get fixed in the round that found them. Comment accuracy, stale citations, naming, and coverage gaps
do not. They stay in the review comment on the pull request that surfaced them, which is already
durable and linked to the code it reviewed. The distinction is not how true the finding is. All of
them were true in the session that produced this rule, and two full rounds went to corrections of
what a comment claimed about itself.

Living-doc drift is the exception. A change that moves something a living doc describes, and
leaves that doc untouched or records it as still accurate, is a correctness finding and gets fixed
in the same round. A wording or precision defect in a doc edit made inside the change stays minor,
and a doc-only finding never earns a second review round. Drift the change did not cause stays in
the review comment.

**One review round per artifact.** A second round happens for a load-bearing finding and for nothing
else. That bar is real and it does get cleared: the round that earned its place here found a
security gate failing open, and the round after it found that the fix had introduced a regression on
the path it did not cover. Neither would have been caught by stopping earlier. The two rounds spent
on comment wording would have been.

**Discovery is not commitment, and not a filing either.** A finding written into a review comment is
recorded. It becomes a GitHub issue only when it is a correctness or security gap outside the scope
of the pull request under review, or a decision that belongs to the operator, and the operator is
told each time one is filed. Anything else gets fixed in the same pull request when it is trivial,
or stays in the comment, and an agent doing the work never opens an issue of its own.

This replaced "Finding something files it" on 2026-09-23. That line read as an instruction to turn
every reviewer's minor list into issues, which is the unfiltered-queue failure this section names.
It happened during a burn-down that closed 18 issues and filed 11, eight of them from review
output, and the operator asked: "Why are we sprawling more issues when the goal is to eliminate
them". Report a burn-down by its net change in open issues, never by closes alone.

The failure this prevents is not zeal. It is the quiet substitution of an unreachable finish line for
a reachable one, which reads as diligence right up until someone asks when it ends.
