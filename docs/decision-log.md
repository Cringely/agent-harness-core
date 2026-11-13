# Decision log

One entry per consequential choice, written when the choice is made. Roles only, never people.

## 2026-11-11: hub topology for the portable PR reviewer (#146)

- Choice: the App reviewer runs as one hub that only the operator controls (the workstation runner now, a homelab container later), reviewing every enrolled repository from outside through the GitHub API, with no reviewer secret stored in any reviewed repository.
- Rejected: a reusable workflow in this repository called from each reviewed repository on GitHub Free, because private Free repositories have no environments, so the secrets would be repository secrets that any writer's branch workflow can read. A composite action or a copied workflow per repository, for the same reason and because each puts security-bearing YAML in every repository. GitHub Pro plus a reusable workflow, kept as the named reversal option, because the operator chose to stay on Free.
- Flips if: the operator wants GitHub itself to refuse merges without the App's approval, an enrolled repository gains a writer outside the household, or the single hub host becomes the availability problem.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`.
- Drafted by: coordinator. Decided by: coordinator, as a logged reversible default the operator may overturn.

## 2026-11-11: the workstation service-account token stays as is (#146)

- Choice: the user-scope 1Password service-account token on the stage 1 workstation, which reads the whole reviewer vault (the App key, the model credential and about nine unrelated credentials) and is inherited by every process, is accepted as is. The spec records it as an accepted residual: on stage 1 the isolation between the model phase and the App key is a property of the hub's code, not of the operating system. Stage 2 must hold the token only in the key-holding process, and the model phase and the `claude` child never inherit it.
- Rejected: moving unrelated credentials to their own vault and service account, and dropping the user-scope variable, both proposed by the security review of the hub design.
- Flips if: a reviewed repository gains a writer outside the household, or an agent session on the workstation is found to have read a reviewer credential it was not handed.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, Accepted residual.
- Drafted by: coordinator, from a security-review finding. Decided by: operator.

## 2026-11-11: the merge guard has no override (#146)

- Choice: the harness merge guard has no override of any kind. A pull request the App cannot vouch for is merged by the operator in the GitHub web UI, and agents never merge it. The coordinator's admin-bypass merge path ends in each enrolled repository, this one included, when the guard's enforcement is switched on there.
- Rejected: an operator-authorized override through an operator-only token or a per-PR authorization, raised by the builder check of the hub design.
- Flips if: the volume of cannot-vouch pull requests makes web-UI merging by the operator the bottleneck.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, Approval enforcement.
- Drafted by: coordinator, from a builder-check finding. Decided by: operator.

## 2026-11-11: squash or merge-commit merges only in enrolled repositories (#146)

- Choice: enrolled repositories merge pull requests by squash or by merge commit, never by rebase, and the merge guard denies `--rebase`. The deployer's chain of custody then reads exactly one first-parent commit per pull request and can check each against the approved head.
- Rejected: allowing rebase merges and teaching the deployer to group a pull request's rebased commits and check only the last against the head, because it adds grouping logic to the one check outside a writer's reach.
- Flips if: an enrolled repository needs rebase merges.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, Approval enforcement and Coordinator calls.
- Drafted by: coordinator. Decided by: coordinator, as a logged reversible default the operator may overturn.

## 2026-11-11: the App bot's user id comes from the harness pin, never the reviewed repository (#146)

- Choice: the merge guard and the deployer take the App bot's user id from the harness checkout at the pinned SHA or from the hub's own config, never from any file in the reviewed repository. The repository manifest may carry an enrolled flag, and the guard denies when that flag and the pin-side enrolled list disagree.
- Rejected: reading the bot user id and the read account from the committed repository manifest, protected by the cannot-vouch floor. A repository file is writer-controlled, and on Free a writer can push straight to the default branch, so a manifest-sourced id would let a writer point the gate at an account they control.
- Flips if: nothing on Free. A writer's own harness sessions have no pin-side source and deny every merge in an enrolled repository, so writers merge in the web UI.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, Approval enforcement.
- Drafted by: coordinator, reversing a call made in revision 1 after a security-review finding. Decided by: coordinator.

## 2026-11-11: the merge guard's enrolled list is operator-only config, and a missing source denies (#146)

- Choice: the merge guard reads the list of enrolled repositories and the account it reads as only from operator-only local config (the hub's own config, or an account-level file written from it), never from the public harness repository and never from a reviewed repository. The bot user id may still come from the harness pin, because it is public. The guard enforces where the operator-only config lists the repository, or where the repository manifest carries the enrolled field with any value, `false` included. When the operator-only source is unavailable and the manifest carries the field, the guard denies every recognized merge form. When the source is unavailable and the manifest has no enrolled field, the guard does not enforce. This amends the entry above, which allowed the enrolled list to sit at the harness pin.
- Rejected: keeping the enrolled list at the harness pin, because the pinned checkout is the public repository and the list names private repositories. Denying only in sessions marked as the operator's at the account layer, because a writer could then switch the guard off by setting the manifest flag to false in any other session. Denying in every repository that has a harness manifest whenever the source is unavailable (the coordinator's own earlier direction), reversed because it bought nothing against a writer and locked public harness users and config-less operator sessions out of merging in every harness project. The guard is a tripwire for agents, not a barrier against human writers. A writer who can delete the field by direct push can equally delete the guard's hook files, which the spec already lists as not stopped.
- Flips if: a writer is shown to use agent sessions to strip the enrolled field.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, Approval enforcement.
- Drafted by: coordinator, from a security re-review finding. Decided by: coordinator.

## 2026-11-12: per-repository required checks for the PR reviewer, ahead of stage 1 (#318)

- Choice: the PR reviewer reads each repository's required checks and CI workflow path from its own policy. This repository's policy is built in, and any other repository's comes from an operator-only policy file outside every checkout. A repository without a valid entry gets no review and nothing posted. So another repository can reach `APPROVE` before the portable reviewer's stage 1 lands.
- Rejected: building the stage 1 plan first and fixing this inside it. Keeping every repository other than this one comment-only until stage 1.
- Accepted: other repositories can reach `APPROVE` while one process still holds the App key and hands writer-supplied text to the model (#146, I2).
- Flips if: a reviewed repository gains a writer the operator does not control, or stage 1's process split lands, which removes the accepted residual.
- Drafted by: coordinator. Decided by: operator.

## 2026-11-12: the portable PR reviewer spec is approved, stage 2 on hold (#146)

- Choice: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, revision 2, becomes the plan of record. Stage 1 gets an implementation plan next, starting with the split that keeps the App key out of the process that reads writer text.
- Held: stage 2 (the homelab container), with its credential type and host, until the operator lifts the hold.
- Rejected: keeping the October in-repository Actions design.
- Drafted by: coordinator. Decided by: operator.
