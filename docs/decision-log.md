# Decision log

One entry per consequential choice, written when the choice is made. Roles only, never people.

## 2026-11-11: hub topology for the portable PR reviewer (#146)

- Choice: the App reviewer runs as one hub that only the operator controls (the workstation runner now, a homelab container later), reviewing every enrolled repository from outside through the GitHub API, with no reviewer secret stored in any reviewed repository.
- Rejected: a reusable workflow in this repository called from each reviewed repository on GitHub Free, because private Free repositories have no environments, so the secrets would be repository secrets that any writer's branch workflow can read. A composite action or a copied workflow per repository, for the same reason and because each puts security-bearing YAML in every repository. GitHub Pro plus a reusable workflow, kept as the named reversal option, because the operator chose to stay on Free.
- Flips if: the operator wants GitHub itself to refuse merges without the App's approval, an enrolled repository gains a writer outside the household, or the single hub host becomes the availability problem.
- Spec: `docs/superpowers/specs/2026-11-11-portable-pr-review-design.md`.
- Drafted by: coordinator. Decided by: coordinator, as a logged reversible default the operator may overturn.
