# PR reviewer in GitHub Actions: design (#146, first slice)

**Status:** proposed, 2026-10-05. Implementation plan: `docs/superpowers/plans/2026-10-05-pr-review-ci.md`.

**Scope:** this repository only. The #120 reviewer (`tools/pr-review/`, "the Approver") runs in GitHub Actions on every same-repository pull request into `master`, without depending on the operator's workstation being on. Per-project installability, the 2026-09-22 scope of #146, is phase 2 (below) and nothing here builds for it.

## Goal

After a pull request's `test` workflow finishes, the App posts a review on the pull request, computed by the same code that computes it today: a tool-less model returns findings, code computes the event from finding severities and CI results, the identity scan clears the body, and the post is pinned to the reviewed head. The step that reads the pull request never holds the App key, and the step that holds the App key never runs the model.

## Decisions and their sources

| Decision | Source |
|---|---|
| Run the reviewer as a GitHub Action | Operator ruling on #146, 2026-09-20 |
| "A pull request diff is attacker-controlled input, and the reviewer holds a credential that can mint an approval on this repository. Those two facts must not meet in the same job." `pull_request_target` must be justified if used at all | Same ruling |
| Model: `claude-opus-5-5` through the `claude` CLI, authenticated in CI by `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on the operator's subscription | Operator decision, 2026-10-05 |
| App key is environment secret `PR_REVIEW_APP_KEY` in environment `pr-review`, App ID is environment variable `PR_REVIEW_APP_ID` there. Environment `pr-review-model` holds `CLAUDE_CODE_OAUTH_TOKEN`. Both environments allow deployments from `master` only | Operator decision, 2026-10-05. Read live the same day: both environments carry one custom branch policy, name `master`, type `branch`. `pr-review` holds `PR_REVIEW_APP_KEY` and variable `PR_REVIEW_APP_ID`. `pr-review-model` holds nothing yet. The repository has no repository-level secrets |
| This settles #146's open custody question. The key itself now has a second custodian (GitHub), which the 2026-09-22 design comment named as strictly more exposure than today | Operator decision, 2026-10-05, read against the #146 design comment |
| Plan D1 ("It is not a GitHub Actions workflow") is superseded | Operator decision, 2026-10-05, by the 2026-09-20 ruling |
| First slice is this repository only | Operator decision, 2026-10-05 |
| The 600 KB diff cap (#157), the severity floor, and the rule that linked-issue text is untrusted (#154) are reviewer properties and do not change | #146 ruling, "What this does not change" |
| A later decision model may only escalate depth and never approves | #146 note, 2026-10-04 (#263). Nothing here adds one |

## The design direction, checked

The coordinator's direction was checked against the code at `b8f3a94` and GitHub's documentation source (`github/docs`, `content/actions/reference/workflows-and-actions/`, read 2026-10-05). Each point below says whether it held.

1. **A `pull_request` workflow runs the pull request's own workflow file, so no secret may be reachable from a `pull_request` job.** Confirmed for the trigger: `GITHUB_REF` is `refs/pull/<n>/merge` and `GITHUB_SHA` is the merge commit, so the pull request's copy of every workflow file runs (events doc, `pull_request` table). Corrected on the consequence. Same-repository branches receive repository secrets, but this repository has none, and environment secrets are gated separately: "The deployment branch or tag rule is matched against the `GITHUB_REF` of the workflow run ... Adding another branch rule for `refs/pull/*/merge` would also allow workflows triggered by `pull_request` events to deploy to the environment" (deployments-and-environments doc). Both environments allow `master` only, so a `pull_request` job that names either environment is refused before its steps run. That branch policy, not the choice of trigger, is what stops a pull request that edits a workflow file from reaching the key. Tier: documented. Plan Task 1 measures it live.
2. **The whole review runs under `workflow_run`, which executes the default branch's workflow file, and every job checks out the default branch.** Confirmed: "This event will only trigger a workflow run if the workflow file exists on the default branch", `GITHUB_SHA` is the "Last commit on default branch", `GITHUB_REF` the "Default branch", and the run can "access secrets and write tokens, even if the previous workflow was not" (events doc, `workflow_run`). `actions/checkout` with no `ref` checks out `GITHUB_SHA`, so both jobs run the same `master` commit of the tool, and a pull request that edits `tools/pr-review/` is reviewed by the merged copy rather than its own. That replaces plan D7's "posting runs come from an up-to-date `master` checkout", which was a procedure, with a property of the trigger.
3. **Job `review` holds only the model token, fetches the snapshot from the public API, runs the model with no tools, and uploads findings plus the head SHA.** Confirmed with two corrections. The snapshot is fetched with the job's own `GITHUB_TOKEN`, read-scoped, not anonymously: `GitHubClient.snapshot()` makes one call per changed file up to `MAX_HEAD_FILE_FETCHES` (50) on top of a dozen fixed calls, and anonymous API access is limited per IP address on a shared runner pool. And the upload is not trusted as-is. Actions artifacts on a public repository are downloadable by anyone who can read it, so the model's output is public the moment it is uploaded. The model has been seen copying the CLI's `# userEmail` block into its output (plan Facts, 2026-09-11), so the review job runs the identity scan over every string in the artifact before upload and withholds the output on a hit. That needs the identity secrets in `pr-review-model` too.
4. **Job `post` holds the App key, validates the artifact, re-checks the head, computes the event in code, scans, posts, and never runs the model.** Confirmed and tightened: rather than taking the snapshot from the artifact, the post job fetches its own with the App token, computes verification from its own read of CI, and takes only the model's result from the artifact. The artifact is bound to the post job's view by four equalities checked before anything else is used: repository, pull request number, head SHA (also equal to `workflow_run.head_sha`), base SHA, plus the tool revision both jobs ran. This shrinks what the #146 residual "job 2 can manufacture an APPROVE" can do to what the model alone can already do: return no finding at the floor.
5. **`workflow_run` fires for fork pull requests too, with secrets. The fork refusal must happen before the model runs.** Confirmed. Two layers, both before the model. The `review` job's `if:` requires `github.event.workflow_run.head_repository.full_name == github.repository`, so for a fork the job is skipped and the runner never receives the environment's secrets. Inside the tool, `GitHubClient.snapshot()` throws `RefusalError` when `head.repo.full_name` differs from the repository (`github.ts:171-173`), and `runModelJob` takes the snapshot before calling the runner.
6. **CI results on the head commit come from `workflow_run` after CI completes. Concurrency per pull request cancels superseded runs. Each push re-runs CI and then a fresh review.** Confirmed. `test.yml` already cancels its own superseded runs (`cancel-in-progress: true`), and a cancelled `test` run is skipped here. The review workflow keys its concurrency group on the pull request number. The `workflow_run.pull_requests` array is a webhook field whose behaviour for forks is not stated in the docs read, so nothing depends on it beyond the pull request number for same-repository runs. The head SHA comes from `workflow_run.head_sha`.
7. **The App key reaches the CLI on stdin from a step-scoped environment variable, a recorded deviation from the README.** Confirmed, with the bound made mechanical: `printf '%s' "$PR_REVIEW_APP_KEY" | env -u PR_REVIEW_APP_KEY bun .../ci.ts post ... --key-stdin`. `printf` is a bash builtin, so the key is never in any process's argv. `env -u` removes it from the Bun process's environment, so no child that process starts inherits it. The variable exists in one step's environment only, never in `$GITHUB_ENV`. The workflow test pins all three properties.

## Known blockers, resolved

1. **Posting needs an account email, and the scan reads the workstation's identity file, username and hostname.** In CI there is no identity file, the runner's username is `runner` (GitHub's default workspace is `/home/runner/work`), and the setup-token login may expose no email. A new loader, `loadCiIdentity(env)`, used only by the CI entry point, reads two environment secrets: `PR_REVIEW_IDENTITY` (JSON, exactly the identity file's `{ "names": [...], "emails": [...] }`, both lists non-empty) and `PR_REVIEW_ACCOUNT_EMAIL` (the address of the account that issued the setup token). Either absent, empty or malformed is a refusal. The claude CLI's own account state is still read and any address there is added. The runner's username and hostname are not scanned: they identify no one, and `runner` would match `runner.ts` in most review bodies (`findIdentityHits` anchors on letters and digits, so `runner.ts` contains the word). The operator's workstation username and hostname go into the declared names instead. This is a seam reachable only by choosing the CI entry point, which refuses unless `GITHUB_ACTIONS` is `true`. The secrets can only add scan terms and never remove one, so it does not breach plan D8's rule that no seam reachable from production input may disable the scan. Tests pin both halves: the CI declaration does not hit `runner.ts`, and a workstation declaration with username `runner` does.
2. **Whether headless claude injects the user email under a setup-token login.** Unknown. Plan Task 1 measures it live and prints booleans only. The design does not depend on the answer, because `PR_REVIEW_ACCOUNT_EMAIL` is required either way, but the measurement decides what value it must hold.
3. **Bun autoloads `bunfig.toml` and `.env` from the working directory.** Both jobs run Bun from `$RUNNER_TEMP/pr-review-cwd`, an empty directory outside the checkout, with the script named by absolute path. The CI entry point runs the same cwd check `cli.ts` runs, before reading stdin.
4. **The dirty-checkout refusal and the tool revision line.** Kept. The checkout is clean at `GITHUB_SHA`, Bun runs outside it, and artifacts are written and read under `$RUNNER_TEMP`. Both jobs refuse a dirty checkout. The post job also refuses when the artifact's tool revision differs from its own.
5. **CLI version and built-in plugins.** The review job downloads the platform package `@anthropic-ai/claude-code-linux-x64` at an exact version from the npm registry, checks the tarball against a SHA-512 written in the workflow, and puts its `claude` binary on `PATH`. No `npm install`, no postinstall script. The wrapper package's postinstall only copies that same binary over a placeholder (`install.cjs`, read at 2.1.291), so taking the binary from the platform package directly skips a script without changing what runs. Pinned at 2.1.291, the operator's CLI on 2026-10-05, SHA-512 `8b4609c5...9769b91c` (from the registry's `dist.integrity`, converted to hex). The package was first published 2026-04-13. A step asserts `claude --version` before use. `DISABLE_AUTOUPDATER=1` is set. `runner.ts`'s adaptive built-in plugin handling (#250) runs unchanged.
6. **Action pinning, permissions and credentials.** Top-level `permissions: {}`. `review` gets `contents`, `pull-requests`, `issues` and `checks` read (checkout and the snapshot's API reads). `post` gets `contents: read` (checkout). Every `uses:` is pinned to a 40-character SHA with its tag in a comment: `actions/checkout` v7.0.1, `oven-sh/setup-bun` v2.2.0 (both as `test.yml`), `actions/upload-artifact` v7.0.1, `actions/download-artifact` v8.0.1, resolved from each repository's latest release on 2026-10-05. Every checkout sets `persist-credentials: false` and names no `ref`. No `run:` script contains a `${{ }}` expression. Every value reaches a script through `env:`.
7. **Cannot-vouch for `.github/workflows/` edits.** Unchanged (`verdict.ts`, `startsWith(".github/workflows/")`). The pull request that adds this workflow gets `COMMENT` at most and is merged by the operator. So does the later one-line change that lifts the rollout's comment-only flag.

## Topology

```
pull request push
  -> test.yml (pull_request, no secrets, pull request's own copy)
       completes (success or failure)
  -> pr-review.yml (workflow_run, master's copy, master checkout)
       review   environment pr-review-model   holds: CLAUDE_CODE_OAUTH_TOKEN, identity secrets, read-scoped GITHUB_TOKEN
                if: event pull_request, same repository, conclusion success|failure
                snapshot (read token) -> expect-head -> model, no tools -> identity scan of the result
                -> artifact pr-review-model-run (retention 1 day)
       post     environment pr-review         holds: PR_REVIEW_APP_KEY, PR_REVIEW_APP_ID, identity secrets
                needs: review
                artifact -> validate -> bind (repo, pr, head, base, tool revision)
                -> own snapshot (App token) -> runReview with the artifact as the runner
                -> verification from its own CI read -> event in code -> identity scan -> head re-check -> post
```

Each environment's secrets reach only the job that names it, and the two jobs run on separate runners, so the artifact is the only thing that crosses between them.

## Data flow: the model-run artifact

One JSON file, `model-run.json`, written by `ci.ts review` and read by `ci.ts post`.

| Field | Type | Rule |
|---|---|---|
| `version` | `1` | Exactly 1 |
| `repo` | string | `owner/name`, passes `parseRepo` |
| `pr` | integer | Positive |
| `headSha`, `baseSha`, `toolRevision` | string | 40 lowercase hex |
| `result` | object | Either `{ ok: true, output, model, tools }` with `model` equal to `REVIEWER_MODEL` and `tools` equal to `EXPECTED_TOOLS`, or `{ ok: false, reason }` with a non-empty reason of at most 500 characters |

No other key is accepted at either level. `output` is validated later by the existing `validateReviewerOutput`, inside `runReview`, exactly as a live model run is. The runner's `diagnostic` (claude stderr) never enters the artifact. When the snapshot's diff is missing or over the cap, the review job runs no model and records `{ ok: false }`. The post job's `runReview` then takes the same no-model branch from its own snapshot and never consults the artifact's result.

The post job replays the result through an `ArtifactRunner`, a `ReviewerRunner` that returns the recorded result, and wraps its `GitHubClient` in a `pinnedSource` that refuses unless the fresh snapshot's head and base equal the artifact's. Everything downstream of that is today's `runReview`, unchanged: validation, `computeEvent`, the comment-only lowering, rendering, the identity scan, the open-state check, the head and base re-check, the pinned post.

A prompt digest was considered as a fifth binding and rejected. `buildPrompt` draws a random nonce per call, so the two jobs' prompts never match byte for byte, and the parts that could drift between jobs without a head or base change (title, description, linked-issue comments) do not change the code being approved. A digest would turn a description edit made during the review into a refused post for no gain.

## Threat model

### Trust boundaries

- **Attacker-controlled input:** everything in the pull request (diff, file contents at head, title, description, commit messages, branch name) and the text of linked issues. Read by `review` (as prompt data) and `post` (as data for code: changed-file paths, the body's Docs line, head and base SHAs).
- **Credentials:** `PR_REVIEW_APP_KEY` can mint an approving token. `CLAUDE_CODE_OAUTH_TOKEN` spends the operator's subscription. The identity secrets are not credentials but must not be published.
- **Trusted code:** `master` at `GITHUB_SHA`, the pinned actions, Bun 1.3.14 from `setup-bun`, and the pinned `claude` binary.

### Closed by absence

- No job in `pr-review.yml` executes pull request code. Both check out `master` at `GITHUB_SHA` and run only the tool.
- No `pull_request` or `pull_request_target` trigger. A `pull_request` job anywhere that names either environment is refused by the branch policy.
- The model has no tools (`--tools ""`, checked per run by `parseStreamJson`), so prompt injection cannot read the environment, files or tokens.
- The App key never enters the review job. The model token never enters the post job, and the post job installs no `claude`.

### What a malicious pull request can still do

1. **Persuade the model.** A finding talked out of existence, plus green CI, yields `APPROVE`. Unchanged from the local tool (README, "Limits") and the deepest residual. The controls stay around the model, not in it.
2. **Spend the operator's subscription.** Every push to a same-repository pull request whose CI concludes success or failure costs one `claude-opus-5-5` run at effort `xhigh`. Same-repository branches can only be created by an administrator (ruleset "Contain non-default branches", creation rule, admin bypass), which bounds who can do this today.
3. **Waste a run.** A pull request that adds a workflow named `test` triggers this workflow on that workflow's completion. The review then reports `COMMENT`, because the pull request edits `.github/workflows/`.
4. **Race the post.** A push or retarget during the review makes the post job refuse (head re-check, base pin), and the push's own CI starts a fresh review.

### What a malicious change to `master` can do

Anything merged to `master` that names `pr-review` or `pr-review-model` reaches that environment's secrets. The control is merge review of `.github/workflows/` and `tools/pr-review/`. The App cannot approve the first (cannot-vouch), and #235 removes the App's approval from owned paths, but `CODEOWNERS` is not yet on `master` (open question 3).

### Exposure added by this design

- The App key and the model token are at rest in GitHub. The setup token is a bearer credential for the operator's subscription, valid until revoked or expired. Rotation is manual.
- The identity strings are at rest in GitHub as secrets. Actions masks secret values in logs, which is defense in depth only. Nothing relies on it.
- Artifacts and logs of a public repository are public. The review job scans the artifact before upload and prints its diagnostic only when the scan is clean. The post job prints the already-scanned body.

## Error handling

| Where | Condition | Behaviour | Fail mode |
|---|---|---|---|
| `review` `if:` | Not a `pull_request` run, a fork, no pull request number, conclusion other than success or failure | Job skipped, `post` skipped, nothing posted | Closed |
| `review` | Not in Actions, cwd unsafe, identity secrets absent or malformed, dirty checkout, token missing or malformed | Refusal, exit 2, job fails, nothing posted | Closed |
| `review` | Fork or non-default base (tool check), head moved since CI | Refusal before the model, exit 2 | Closed |
| `review` | CLI install checksum or version mismatch | Step fails before Bun runs | Closed |
| `review` | Model run rejected by the runner, or output carries an identifying string | Artifact records `ok: false`, job succeeds, `post` posts `COMMENT` | Closed (no approval) |
| `review` | GitHub API error | Exit 1, job fails, nothing posted | Closed |
| `post` | Artifact missing, unreadable, not JSON, fails validation, or bound to another repo, pull request, head or tool revision | Refusal, exit 2, nothing posted | Closed |
| `post` | Fresh snapshot's head or base differs from the artifact | Refusal, exit 2, nothing posted | Closed |
| `post` | Everything in today's `runReview` (identity hit, not open, head moved) | Today's refusals | Closed |
| `post` | GitHub accepted the post but its response failed validation | Exit 1 with the review id and URL, as today | Reported |
| Concurrency | A newer review for the same pull request starts | The older run is cancelled. A post already sent stays, pinned to its own head | Stale review on an old head, dismissed or superseded |

No branch posts `APPROVE` unless the replayed output validates with no finding at the floor and the post job's own read of CI is `passed`.

## Rollout

The workflow lands posting with `--comment-only`. After three consecutive pull requests where the live checks in plan Task 8 pass, a one-line change removes the flag (plan Task 9). Both changes edit `.github/workflows/`, so both are merged by the operator with the administrator bypass. The local `cli.ts review --post` path stays as the fallback and is unchanged.

## Testing

- Unit tests run under `bun test` in CI, offline and without `claude` or any secret. They cover the CI identity loader, the artifact validator and binding, `ArtifactRunner` and `pinnedSource` composed with the real `runReview`, the model-job phase with a fake runner, the CI entry point with fake sources and a generated RSA key, and the workflow file parsed with `Bun.YAML` and checked against the invariants in this spec.
- Live (plan Task 1, before any code): the setup token under an isolated home, and a negative check that a `pull_request` job naming `pr-review` is refused.
- Live (plan Task 8, after merge): three pull requests reviewed end to end in comment-only mode, with the posted body and both jobs' logs scanned for identifying strings.

## Phase 2: per-project installability (not built)

The 2026-09-22 scope: "install the harness into a project, turn the reviewer on for that project, and get gated reviews there without depending on any one machine being awake." What it needs, none of it started here:

- **Per-project configuration** for what is a constant today: `TRUSTED_CONTEXT_PATHS`, `LIVING_DOC_PATHS`, `WORKFLOW_PATH`, `REQUIRED_CHECKS` and its app slug, `SHARED_MODULE_SUITES`, the diff cap, and the `test` workflow name this workflow listens for. A committed file rather than the per-machine sidecar, since CI must read it.
- **Tool distribution from a trusted source.** In a consuming project the tool must not come from that project's own pull request. Likely a reusable workflow in this repository that checks out `agent-harness-core` at a pinned SHA, called from a small per-project caller workflow that the installer ships as a template.
- **App topology:** one App installed on a selected set of repositories, or one App per project, with the verified end state #146 already requires (installation `contents: write`, `repository_selection: selected`).
- **Per-project environments and secrets** with the same master-only branch policy, and a setup check that verifies the policy before the first run.
- **Graduation bar:** a hook-class artifact needs a second project's evidence (decision note `graduation-bar-second-project`).

## Open questions

1. `REQUIRED_CHECKS` names two checks. The "CI required" ruleset (24333659) requires three, including `Pester (fixture-built installer suites, Linux)`. Pre-existing and outside this change, but the CI reviewer will approve on two.
2. Cost: should the review also skip drafts, or skip CI failures, to save subscription runs? This design reviews successes and failures and does not read draft state, because the `workflow_run` payload does not carry it.
3. `CODEOWNERS` for `.github/workflows/**` and `tools/pr-review/**` (#235, #242) is what makes a merged change to either path need the operator. Until that file is merged, merge review is procedure.
4. Each job naming an environment records a deployment. If the environments page becomes noise, the alternative is a job-level setting that skips the deployment record, not verified here.
5. `permissions: {}` plus `contents: read` is expected to be enough for `actions/download-artifact` within the same run. If the first live run fails with a 403 on download, `actions: read` on the post job is the one addition.
6. The setup token's expiry and rotation reminder: where it is recorded.
