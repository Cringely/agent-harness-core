# Decision log

One entry per consequential choice, written when the choice is made. Roles only, never people.

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
