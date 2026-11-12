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
