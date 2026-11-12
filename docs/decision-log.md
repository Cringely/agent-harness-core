# Decision log

One entry per consequential choice, written when the choice is made. Roles only, never people.

## 2026-11-12: per-repository required checks for the PR reviewer, ahead of stage 1 (#318)

- Choice: the PR reviewer reads each repository's required checks and CI workflow path from its own policy. This repository's policy is built in, and any other repository's comes from an operator-only policy file outside every checkout. A repository without a valid entry gets no review and nothing posted. So another repository can reach `APPROVE` before the portable reviewer's stage 1 lands.
- Rejected: building the stage 1 plan first and fixing this inside it. Keeping every repository other than this one comment-only until stage 1.
- Accepted: other repositories can reach `APPROVE` while one process still holds the App key and hands writer-supplied text to the model (#146, I2).
- Flips if: a reviewed repository gains a writer the operator does not control, or stage 1's process split lands, which removes the accepted residual.
- Drafted by: coordinator. Decided by: operator.
