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

## 2026-11-11: the merge guard's enrolled list is operator-only config, and its enforcement state decides (#146)

- Choice: the merge guard reads the list of enrolled repositories and the account it reads as only from operator-only local config (the hub's own config, or an account-level file written from it), never from the public harness repository and never from a reviewed repository. The bot user id may still come from the harness pin, because it is public. The guard enforces where the list has the repository with enforcement on. Enrollment adds the manifest's enrolled field, as `true`, only when it switches enforcement on, and the field can only add denials. The guard denies when the list enforces and the field is missing or not `true`, and when the field is present and the list does not enforce. When the operator-only source is absent and the manifest carries the field with any value, `false` included, the guard denies every recognized merge form. When the source is absent and the manifest has no field, the guard does not enforce. When the source exists but cannot be read, does not parse or fails its schema, the guard denies every recognized merge form whatever the manifest says. This amends the entry above, which allowed the enrolled list to sit at the harness pin.
- Rejected: keeping the enrolled list at the harness pin, because the pinned checkout is the public repository and the list names private repositories. Denying only in sessions marked as the operator's at the account layer, because a writer could then switch the guard off by setting the manifest flag to false in any other session. Denying in every repository that has a harness manifest whenever the source is unavailable (the coordinator's own earlier direction), reversed because it bought nothing against a writer and locked public harness users and config-less operator sessions out of merging in every harness project. The guard is a tripwire for agents, not a barrier against human writers. A writer who can delete the field by direct push can equally delete the guard's hook files, which the spec already lists as not stopped. Enforcing wherever the list names the repository or the manifest carries the field, because it contradicted the comment-only rollout and invited reading a `false` field as off. Treating an unreadable or malformed source as absent, because it let every merge through in an enrolled repository whose field a writer had stripped.
- Flips if: a writer is shown to use agent sessions to strip the enrolled field.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, Approval enforcement.
- Drafted by: coordinator, from a security re-review finding. Decided by: coordinator.

## 2026-11-12: per-repository required checks for the PR reviewer, ahead of stage 1 (#318)

- Choice: the PR reviewer reads each repository's required checks and CI workflow path from its own policy. This repository's policy is built in, and any other repository's comes from an operator-only policy file outside every checkout. A repository without a valid entry gets no review and nothing posted. So another repository can reach `APPROVE` before the portable reviewer's stage 1 lands.
- Rejected: building the stage 1 plan first and fixing this inside it. Keeping every repository other than this one comment-only until stage 1.
- Accepted: other repositories can reach `APPROVE` while one process still holds the App key and hands writer-supplied text to the model (#146, I2).
- Flips if: a reviewed repository gains a writer the operator does not control, or stage 1's process split lands, which removes the accepted residual.
- Drafted by: coordinator. Decided by: operator.

## 2026-11-12: publish deny rules and skill ship through the project installer (#274)

- Choice: `install/Install-Harness.ps1` merges the deny of raw `gh pr create`, `gh issue create` and `gh pr merge` from `core/claude/templates/settings.permissions.json` into each project's `.claude/settings.json`, and installs the `publish` skill from `core/claude/skills/` into `.claude/skills/`. Both apply to every installed project, whatever its layers. The skill finds the tool through the `coreRepo` value in the project's gitignored sidecar, so no machine path is committed.
- Rejected: user-level deny rules and the skill shipped through the account layer, as the plan first proposed. Gating the rules on the code layer, since a documents project files issues too.
- Accepted: a project whose repository owner has no entry in the publish tool's local configuration can neither run raw gh publishing nor use the tool until one is added.
- Flips if: an installed project has to publish through raw gh, which would call for a per-project opt-out.
- Drafted by: coordinator (deny scope), the agent that built it (skill route and layer scope). Decided by: operator for the deny scope, 2026-11-11. The skill route and the layer scope await operator review.

## 2026-11-12: the portable PR reviewer spec is approved, stage 2 on hold (#146)

- Choice: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, revision 2, becomes the plan of record. Stage 1 gets an implementation plan next, starting with the split that keeps the App key out of the process that reads writer text.
- Held: stage 2 (the homelab container), with its credential type and host, until the operator lifts the hold.
- Rejected: keeping the October in-repository Actions design.
- Drafted by: coordinator. Decided by: operator.

## 2026-11-13: a required check binds only to this pull request's own CI run (#146)

- Choice: a check run counts only as a job of a `pull_request` workflow run that comes from this repository and matches the pull request's head SHA and head ref. It must also be listed against the default branch and come from the only pull request ever opened from that branch. A pull request whose base was ever changed binds no run. Push-event runs no longer bind. Every bound run for a required check must succeed, and a cancelled run is excused only by a later success.
- Rejected: binding on path, head SHA, event and head branch alone, because a second pull request into a writer-controlled base can pass for the real one. Binding on the run's `pull_requests` list alone was rejected because GitHub documents it as matching open pull requests, not the one that triggered the run. Comparing a run's creation time against the last base change was rejected because a run's base is fixed by the triggering event, which precedes the run record, so a run created just after a retarget can still have tested the old base.
- Cost: a branch whose first pull request was closed cannot get `APPROVE` on a new pull request, and a pull request that was retargeted cannot get `APPROVE` at all. In both cases the writer opens a new pull request from a new branch.
- Drafted by: coordinator. Decided by: coordinator, after the operator approved revision 2 of the spec. Flagged to the operator, and awaits the operator's approval as part of revision 3.

## 2026-11-13: enrollment reads a reviewed repository only in readers that hold no credential (#146)

- Choice: every enrollment step that reads writer-controlled content (the CI workflow, the target's existing `.claude/` content, its Actions secret names, and the review the App posts back) runs as a code-only reader with no model, a read-only installation token for that one repository and no write, merge, approve or 1Password credential. The reader returns a structured result: pass or fail with a reason code, counts, ids, hashes, and names and paths that pass a character allowlist and length cap. The coordinator session, which holds the operator's `gh` login, is the actor: it writes only from that result and never reads the content itself.
- Rejected: the coordinator reading the content through the contents API as data, because reading as data stops the content from running as code but does not stop it steering a model session that holds a credential. Running every enrollment step in a disposable environment with a one-repository token, because most steps need no write access at all, and that environment stays available for step 6 only.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`, Enrolling a repository.
- Drafted by: coordinator. Decided by: coordinator, after the operator approved revision 2 of the spec. Flagged to the operator, and awaits the operator's approval as part of revision 3.

## 2026-11-12: git installs on Linux through apt without a version pin (#310)

- Choice: on Linux the installer installs git with `sudo apt-get install -y git`, unpinned. This is a named exception to the exact-version rule for installs, limited to an apt spec that carries an `unpinned` reason in place of `version`. Ubuntu's archive keeps only the current patched build, so an exact pin fails once that build is superseded.
- Rejected: pinning the unpatched build old enough for the 30-day rule. Dropping the Linux install and leaving install-by-hand guidance.
- Accepted: a Linux git install resolves at run time to whatever the archive currently carries.
- Drafted by: coordinator. Decided by: operator.

## 2026-11-13: installed project rules stay gitignored (#310)

- Choice: revert #330, so `.claude/rules/` in this repo goes back to being untracked installer output. A corrected live check showed isolated worktree agents already load the project rules without tracking them.
- Rejected: keeping the tracked copies and teaching the installer to accept a tracked rule that matches core's source, which would add code for a case nothing needs.
- Accepted: top-level `claude --worktree` sessions in this repo do not get the installed rules.
- Drafted by: coordinator. Decided by: operator.
