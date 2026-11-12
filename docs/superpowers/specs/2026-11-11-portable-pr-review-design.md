# Portable PR reviewer: hub design (#146 refresh)

**Status:** proposed, 2026-11-11. Replaces the October design (`docs/superpowers/specs/2026-10-05-pr-review-ci-design.md` on branch `feat/146-ci-reviewer`) as the plan of record for #146. The October design stays valid as the reversal option below. No implementation plan exists yet.

**Base:** written against `ddeb82a`, the merge of #315 (#314, `checks: read`). File and line references are at that commit.

## Intent

The #120 reviewer (`tools/pr-review/`, posting as a GitHub App) gates pull requests on this repository today. A coordinator session on the operator's workstation starts it through the operator's runner (`run.ps1` in the operator's runner directory). The operator now wants the same gate on every repository the App is installed on, and the first new one is private.

The October design ran the reviewer as a GitHub Actions workflow inside the reviewed repository. Its whole secret-isolation story was an environment whose secrets only the default branch could deploy to, and its merge story was a ruleset counting the App's approval. Neither exists on a private repository under GitHub Free. On 2026-11-11 the rulesets and branch protection endpoints of the first enrolled private repository both returned 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." The operator stays on Free.

Without environments, any secret stored in a private Free repository is a repository secret. Any collaborator with write access can push a branch whose own workflow reads every repository secret. The App key and the model credential would then sit one `git push` away from the household writer the gate exists to check. So the reviewer moves out of the reviewed repositories. One runner that only the operator controls reviews every enrolled repository from outside, and no reviewed repository ever holds a reviewer secret.

## Goals

1. Any repository the App is installed on (selected repositories only) can be enrolled by adding a config entry. No runner code changes per repository. This is jobbot request 3.
2. No reviewer secret (App key, model credential, 1Password service-account token, identity terms) is stored in any reviewed repository, its Actions secrets, or its workflow files.
3. The reviewer never checks out, builds or runs code from a reviewed repository. Everything it reads arrives through the GitHub API as data.
4. The governing constraint from the 2026-09-20 ruling still holds: the process that hands pull request text to the model never holds the approving credential, and the process that holds it never runs the model.
5. A deployer can check, through the API alone, that a deployed commit is exactly what the App approved. The recipe is written down below. This is jobbot request 2.
6. Unattended operation on a homelab container, with secrets from a read-only 1Password service account. This is jobbot requests 1 and 4, met in stage 2.
7. Every per-repository list resolves fail closed. An empty required-check list, an empty standards set or a missing standards file refuses the review rather than shrinking it.

## Non-goals

- Making GitHub enforce the App's approval on private Free repositories. GitHub cannot. Enforcement is a harness guard, repository text and, where one exists, a deployer check (see Approval enforcement).
- Reviewing pull requests from forks. They are refused as today (`github.ts:171-177`). Contributors use same-repository branches, and the repository's contributing text says so.
- A webhook listener. The hub polls (coordinator call, see Topology).
- Replacing the operator's current workstation runner before stage 2. Stage 1 generalizes it.
- Changing what the reviewer judges. The 600 KB diff cap, the severity floor, the tool-less model and the rule that linked-issue text is untrusted are reviewer properties by the #146 ruling and stay as they are.

## Anti-goals

These are things a builder might reasonably do that this design forbids.

- Copying a reviewer secret into a reviewed repository "just for CI". On Free that hands it to every writer.
- Running `anthropics/claude-code-action`, or any workflow in the reviewed repository, to do the review. The action exists to give the model tools in a workspace, and the reviewer's main injection control is a model with no tools.
- Reading per-repository policy from the reviewed repository in a way that can lower a floor. A file a non-admin writer can merge must not be able to empty the required checks, drop a cannot-vouch path or raise the diff cap.
- Treating "no finding" as "approve" when an input was missing. A missing file, an unreadable check list or an API error is a refusal, never an empty block.
- Counting any APPROVED review as the App's approval. A collaborator can approve as themselves. Only the App's bot identity counts.
- Using `--bare` with the subscription token. Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN` (Anthropic authentication docs).

## Decisions this design stands on

| Decision | Source |
|---|---|
| Operator stays on GitHub Free. Private repositories there have no environments, environment secrets, rulesets or branch protection | Operator, 2026-11-11. Live 403 on the first enrolled private repository the same day |
| Guards for contributing and requiring pull requests are harness hooks or guards plus a CONTRIBUTING or AGENTS file in each repository, not GitHub settings | Operator, 2026-11-11 |
| Hub topology, as described below | Coordinator default, 2026-11-11, logged in `docs/decision-log.md`, reversible |
| Reviewer secrets live in the 1Password vault the reviewer already uses and are read by a read-only service-account token. The operator accepted that this token can read the model credential as well as the App key | Operator, 2026-11-11 (the coordinator had recommended a separate vault) |
| The reviewer never runs pull-request-authored code. The model stays tool-less and pull request text is untrusted input | Operator, 2026-11-11, and the account security rule on untrusted content |
| The job reading the diff never holds the approving credential | Operator ruling on #146, 2026-09-20 |

## Topology

```
operator-held hub (stage 1: workstation runner, coordinator-started)
                  (stage 2: homelab container, unattended poller)
  config: enrollment list, per-repo policy, harness pin      (never in a reviewed repo)
  secrets: from 1Password over stdin pipes only             (never in a reviewed repo)

  every poll interval:
    App JWT -> installations -> repositories (selected)
    intersect with enrollment list
    for each enrolled repo, for each open pull request:
      candidate if: not draft, base is the default branch, head repo is this repo,
                    every required check completed on the head, all successful,
                    and the App has no review on this head yet
    for each candidate, strictly one at a time:
      mint      read-only installation token for this one repo
      phase A   (model phase)  holds: read-only token, model credential
                snapshot via API -> head pin -> model, no tools -> identity scan
                -> model-run artifact bound to repo, pr, head, base, tool revision
      phase B   (post phase)   holds: App key or a write token for this one repo
                own snapshot -> bind artifact -> verification from own CI read
                -> event in code -> identity scan -> head and base re-check -> post
```

Nothing is installed in a reviewed repository for the review itself. The App installation and a config entry are the whole enrollment on the reviewer side. The repository side gets contributing text and the harness merge guard (see Approval enforcement), which are about merging, not reviewing.

### Process split inside the hub

The October two-job split carries over as two processes, because the hub reads attacker-controlled text just as the workflow did. These invariants are what the builder must keep. How the processes are arranged is left to the builder.

- I1. The process that passes pull request text to `claude` holds no App private key and no installation token with any write permission. Its token is minted read-only for one repository (`contents`, `pull_requests`, `checks` and `issues`, all `read`).
- I2. The process that holds the App key, or a token with `pull_requests: write`, never starts `claude` and never receives the model credential.
- I3. Secrets move only over stdin pipes, from `op read` or from the minting step, as the current runner already does for the App key. A secret does not appear in argv, in a long-lived process's environment, in a file or in a log. The one exception is the model credential, which the CLI reads from `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`), so it is set in the `claude` child's environment only.
- I4. The artifact crossing from phase A to phase B is the October `model-run.json` contract unchanged: version, repo, pull request, head, base, tool revision and the model result, no other keys, bound by equality before anything else is used. The tool revision is the pinned harness commit, not anything from the reviewed repository.
- I5. Bun runs from an empty working directory outside every checkout, so no `bunfig.toml` or `.env` is preloaded (`cli.ts:12-21`, `:320-324`). The reviewed repository is never on disk.

### Stages

**Stage 1, workstation.** Generalize the operator's runner and the tool so a run takes its repository and policy from the hub config instead of hard-coded values (`run.ps1:49` names this repository, `cli.ts:39` defaults to it, `verdict.ts:25-30` names this repository's checks). A coordinator session still starts each run. This meets requests 2, 3 and 5 but not request 1: a pull request opened at night waits for the next coordinator session (coordinator call: no workstation scheduler, because it would run unattended on the operator's interactive account. Flips if the container slips and an enrolled repository starts depending on overnight reviews, in which case a scheduled task on the workstation is the bridge).

**Stage 2, homelab container.** The same code as a poller in a container on a homelab host, with the service-account token as a container secret file and every other secret read through it at run time. Outbound only: the GitHub API, the model API and 1Password. No inbound port.

Only one hub may be active at a time. The migration from stage 1 to stage 2 disables workstation runs before the container's first poll, and phase B re-checks for an existing App review on the head immediately before posting, so an overlap produces a refusal rather than a second review.

**Poll, not webhook (coordinator call).** A webhook needs an inbound endpoint through the homelab reverse proxy, which is a new exposed path carrying signed but attacker-triggered requests. A five-minute poll costs latency only. Flips if review latency becomes the bottleneck on an enrolled repository.

### This repository

The App is installed here, so the hub reviews this repository too. The October in-repository workflow remains a valid design for this public repository, where environments and rulesets do work, but it is not built under this spec. Each repository is served by exactly one path, and the hub config is that list.

### Reversal option: GitHub Pro plus a reusable workflow

Upgrade the operator's account to Pro. Private repositories then get environments with deployment branch policies and rulesets. The reviewer becomes a reusable workflow in this repository, called at a pinned SHA by a thin `workflow_run` caller the installer ships into each repository. The callee checks out its own source with `job.workflow_repository` and `job.workflow_sha` and never checks out the caller. The October two-job split runs inside it with environment secrets gated to the default branch, and a ruleset per repository requires the App's approval, which the installation's `contents: write` makes count.

What it costs: the Pro subscription, a copy of every reviewer secret in every enrolled repository (Anthropic's GitHub Actions page recommends a Console API key rather than a subscription token for a secret shared across repositories), and a pin-bump pull request per repository for every reviewer change.

What would flip to it: the operator wants GitHub itself to refuse a merge without the App's approval, including merges by human writers. Or an enrolled repository gains a writer outside the household. Or the hub's single host becomes the availability problem. The hub can stay running as a fallback during a switch.

## Trust boundaries and threat model

**Untrusted input.** Everything in a pull request (diff, file contents at head, title, description, commit messages, branch name), linked issue text and comments, and every file read from a reviewed repository at its base commit. A base-commit file is only as trusted as whoever can merge to that repository, which in a household repository includes a non-admin writer and that writer's agents. Such files reach the model as data and can add to policy, never subtract from it.

**Credentials.**
- The App private key mints installation tokens that can post an APPROVE as the App, and with the installation's `contents: write` it can push to every repository the App is installed on.
- The 1Password service-account token reads the App key and the model credential (accepted by the operator).
- The model credential spends the operator's subscription (setup token) or API budget (API key).
- Installation tokens last one hour and are minted per repository.
- The identity terms are not credentials but must never be published.

**Trusted code and config.** The harness at the pinned commit, clean (the dirty-checkout refusal stays, `tool-state.ts:20-42`), the pinned `claude` CLI, the pinned Bun, and the hub config. The hub host is trusted: whoever controls it controls the gate.

**Closed by absence.**
- No reviewer secret exists in any reviewed repository, so no branch workflow there can read one.
- No reviewed repository is checked out, so no repository code, hook, config or autoload file runs in the hub.
- The model has no tools (`runner.ts:158`, checked per run), so injected text cannot read the environment, files or tokens.
- Phase A has no write credential (I1), so a fully compromised model phase can at most write a bad artifact, which phase B binds and replays through the same code-computed event as any model result.

**What a malicious pull request can still do.**
1. Persuade the model. A finding talked out of existence plus green CI yields APPROVE. This is the deepest residual, unchanged from today. The controls are around the model: cannot-vouch paths, the diff cap, code-computed events.
2. Spend the operator's model budget. Every new head on a same-repository pull request with green CI costs one `claude-opus-5-5` run at `xhigh`. Bounded by one review per head, the draft skip, the failed-CI skip and a per-repository daily cap (open question 3).
3. Race the post. A push or retarget during review makes phase B refuse, and the next poll picks up the new head.

**What a malicious change to a reviewed repository's default branch can do.** It can change the repository's contributing text, its living docs and its added cannot-vouch paths, all of which feed the next review. It cannot reach a secret, change the required checks the hub demands, remove a floor path or change the reviewer code. It can delete or edit the harness merge guard's repository-side config, so the guard binds agents and is not a boundary (see What this does not stop).

**What a leaked App key can do.** Post an APPROVE as the App on any installed repository, and push to any of them while the App holds `contents: write`. Selected-repository installation bounds the reach. The key exists only in the vault and, briefly, in phase B's memory. Open question 2 asks whether private repositories get a second App without `contents: write`.

**Compromise of the hub host.** Everything above. The workstation is the operator's own account. The stage 2 host gets the same care as other homelab production services.

## Enrolling a repository

The coordinator runs these in order and stops at the first failure. Steps the operator must do by hand are marked.

1. **Operator, web UI:** add the repository to the App's installation (selected repositories). Installation changes stay in the web UI, which keeps every stored token at its current scope.
2. Check the installation from the App's side: `GET /repos/{owner}/{repo}/installation` with the App JWT must show `repository_selection: selected` and permissions inside `APP_PERMISSION_ALLOWLIST` (`app-auth.ts:37-42`). The tool's `mint()` already refuses otherwise (`app-auth.ts:147-182`), so a dry `snapshot` of any open pull request is the check.
3. Check the repository's Actions settings: `GET /repos/{owner}/{repo}/actions/permissions/workflow` must read `default_workflow_permissions: read` and `can_approve_pull_request_reviews: false`, so the repository's own `GITHUB_TOKEN` cannot approve.
4. Check that no reviewer secret is present: `GET /repos/{owner}/{repo}/actions/secrets` must list none of the reviewer's secret names. Their presence means someone followed the old design, and the enrollment refuses until they are deleted and rotated.
5. Read the repository's CI workflow at the default branch and write its config entry (schema below): the CI workflow path, the required check names and the app that runs them, extra cannot-vouch paths, living docs, the project standards file. Start in `comment-only` mode.
6. Open a pull request in the repository adding or updating its CONTRIBUTING or AGENTS text (see Approval enforcement) and installing the harness merge guard through `install/Install-Harness.ps1`. The operator merges it.
7. Run one comment-only review on an open pull request and read the posted review back: on the pinned head, by the App's bot, body clean under the identity scan.
8. After three clean comment-only reviews, switch the entry to `post`.

Secrets are never handled in this flow, because none go to the repository. At hub start, each secret moves from 1Password straight into the consuming process: `op read` writes to the reader's stdin, as `run.ps1` does today for the App key, and nothing echoes, stores or logs the value. Vault references live in the hub config by placeholder name and in the operator's runner directory, never in this repository.

For the reversal option only, provisioning a repository secret takes the same shape, with the value never on a command line:

```
op read "op://<vault>/<item>/<field>" | gh secret set <NAME> --repo <owner>/<repo> --env <environment>
```

## Approval enforcement

On Free the App's APPROVE is advisory to GitHub. Nothing on GitHub refuses a merge without it. Three things enforce it instead, and none of them is a server-side boundary against a human writer.

**What the App posts.** One review per head, pinned to that head (`github.ts:305-318` checks the returned `commit_id` and state). The event is computed in code: APPROVE needs three things: verification passed on the configured required checks, the change stays clear of every cannot-vouch path, and the model returned zero findings at the floor. The body's provenance line gains the base SHA beside the head, model and tool revision it carries today (`render.ts:177`), so a reader can see exactly what was compared.

**Repository text.** Each enrolled repository's CONTRIBUTING or AGENTS file states the merge rule: changes land by pull request from a branch in the same repository, never by direct push to the default branch. A pull request merges only when the App's latest review is an APPROVE of its current head and the head is up to date with the default branch. Changes to cannot-vouch paths are merged by the operator. Agents read this file. The reviewer reads it as the project's standards.

**Harness merge guard (new hook).** A PreToolUse hook on the Bash and PowerShell tools, shipped by the installer to code projects. It recognizes `gh pr merge` and `gh api` calls to a pull request's merge endpoint in a repository whose committed `.claude/.harness-manifest.json` marks it enrolled, and it denies unless all of these hold, read live from the API at the moment of the call:
- the command carries `--match-head-commit <sha>`, and that SHA is the pull request's current head
- the latest review by the App's bot user (matched by user id, not by login) has state `APPROVED` and `commit_id` equal to that head
- the head is up to date with the default branch (`GET /repos/{owner}/{repo}/compare/{base}...{head}` reports `behind_by` 0)

Any API error, unparseable command or missing manifest field denies. The pre-push hook gains a refusal of pushes to the default branch of an enrolled repository. This repository plus the first enrolled private repository are the two projects the graduation bar asks of a hook (decision note `graduation-bar-second-project`).

**Deployer check.** Where a repository deploys from its default branch, the deployer is the one check outside the writer's reach. The recipe, for a commit C about to deploy:

1. `GET /repos/{owner}/{repo}/commits/{C}/pulls`. Exactly one result must be merged into the default branch. Call it pull request N with final head H (`head.sha`). Zero or several results refuse.
2. `GET /repos/{owner}/{repo}/git/commits/{C}` and `.../git/commits/{H}`. Their `tree.sha` values must be equal. This proves the deployed content is exactly the reviewed head, whatever the merge method, and it fails when the default branch moved after approval without the head being updated and re-reviewed.
3. `GET /repos/{owner}/{repo}/pulls/{N}/reviews`, all pages. Keep reviews whose `user.type` is `Bot` and whose `user.id` is the App's bot user id. The latest of them by `submitted_at` must have state `APPROVED` and `commit_id` equal to H.
4. Any API error, missing field or ambiguity refuses.

The deployer reads with its own read-only credential and never holds the App key. A pull request touching a cannot-vouch path never gets an APPROVE, so the deployer refuses it, and how the operator deploys such a change is the deploying project's own rule, not this spec's.

**What this does not stop.** A human writer can merge in the web UI, run `gh` outside a harness session, edit the manifest that marks the repository enrolled, or push straight to the default branch. Client-side hooks bind only sessions where the harness is installed, and they match command text, so an agent that hides a merge inside a script can get past them too. On Free, for a repository without a deployer check, the App's approval is enforced by procedure against humans and by a tripwire against honest agents. The operator chose this on 2026-11-11 (guards through hooks and repository text). The reversal option is what changes it.

## Configuration schema

One operator-held JSON file in the operator's runner directory, later mounted read-only into the container. It never lives in a reviewed repository and carries no secret values. Unknown keys refuse at every level, and an invalid file stops the hub before any poll rather than enrolling the valid part.

```json
{
  "version": 1,
  "harness": { "repo": "<owner>/agent-harness-core", "pin": "<40-hex sha>" },
  "pollSeconds": 300,
  "apps": {
    "<app name>": {
      "appIdRef": "op://<vault>/<item>/<field>",
      "keyRef": "op://<vault>/<item>/<field>",
      "botUserId": 0
    }
  },
  "modelCredentialRef": "op://<vault>/<item>/<field>",
  "identityRef": "op://<vault>/<item>/<field>",
  "repos": [
    {
      "repo": "<owner>/<repo>",
      "app": "<app name>",
      "mode": "comment-only",
      "ciWorkflowPath": ".github/workflows/<file>.yml",
      "requiredChecks": [{ "name": "<check name>", "appSlug": "github-actions" }],
      "powershellSuiteCoverage": false,
      "cannotVouchAdd": ["deploy/", "compose.yaml", "Dockerfile"],
      "livingDocs": ["README.md"],
      "projectStandards": ["CONTRIBUTING.md"],
      "docsVerdictLine": false,
      "maxDiffBytes": 600000,
      "dailyModelRuns": 20
    }
  ]
}
```

Field rules:

| Field | Rule | Fails closed when |
|---|---|---|
| `harness.pin` | The tool checkout must be clean at exactly this SHA. It is the tool revision on every artifact and review | Checkout dirty or at another commit |
| `repos[].repo` | Unique. Must be in the App installation's repository list | Listed but not installed: that repository is refused and reported. Installed but not listed: ignored, never reviewed |
| `requiredChecks` | Non-empty list of `{name, appSlug}`. Replaces `REQUIRED_CHECKS` (`verdict.ts:25-30`) | Empty list: the entry is invalid. The loop at `verdict.ts:97-128` adds no reason when the list is empty, so an empty list must never reach it |
| `ciWorkflowPath` | Replaces `WORKFLOW_PATH` (`types.ts:141`) | Absent at the base commit: incomplete, no APPROVE, as today |
| `powershellSuiteCoverage` | Turns this repository's Pester-coverage rule (`verdict.ts:152-157`) on. Off elsewhere | |
| `cannotVouchAdd` | Path prefixes added to the fixed floor in code (`.github/workflows/`, `.gitleaks.toml`, `.gitleaksignore`, any `.gitattributes`, `verdict.ts:136-150`). Can only add | Never lowers the floor. The floor is not configurable |
| `livingDocs` | Replaces `LIVING_DOC_PATHS` (`types.ts:139`). Read at the base commit | A missing living doc is still skipped, as today (`github.ts:257-261`), because it shapes a docs note and never the event |
| `projectStandards` | Non-empty. Read at the base commit. Joins the harness standards in the prompt | Empty list: invalid entry. A listed file missing at base: refusal, no review |
| `docsVerdictLine` | Turns the docs verdict line (`docs-verdict.ts`) on | |
| `maxDiffBytes` | May lower the code constant (`types.ts:146`), never raise it | A value above the constant: invalid entry |
| `dailyModelRuns` | Per-repository model-run cap per UTC day | Cap reached: no further reviews that day, so no approvals |
| `mode` | `comment-only` or `post` | Any other value: invalid entry |

Harness standards are not configurable per repository. They come from the pinned harness checkout: today's `TRUSTED_CONTEXT_PATHS` minus `CONTRIBUTING.md` (`types.ts:128-133`), read from disk at the pin rather than from the reviewed repository's base. A missing harness standards file is an error that stops the hub, not an empty block. Today a missing trusted-context file is silently dropped (`github.ts:252-256`), which in a new repository gives the model an empty standards block with no signal, and that changes.

## Failure modes that must fail closed

Every row ends with no APPROVE posted. Most end with nothing posted at all.

| Where | Condition | Behaviour |
|---|---|---|
| Hub start | Config invalid, harness checkout dirty or off pin, a harness standards file missing, CLI version not the pinned one | Hub stops before any poll |
| Hub start | 1Password rejects the service-account token, or any `op read` fails | Hub stops, no fallback to any other credential source |
| Enumeration | Installation list unreadable, or `repository_selection` not `selected` | Poll aborts, nothing reviewed |
| Enumeration | Enrolled repository not in the installation | That repository refused and reported, others continue |
| Candidate selection | Draft state, CI state or existing App reviews unreadable | That pull request skipped this poll |
| Candidate selection | Fork head, non-default base, any required check pending | Skipped, no model run |
| Candidate selection | A required check failed | Skipped, no model run, nothing posted (coordinator call: posting a no-model COMMENT on every failed head is noise, and the failed check already blocks every merge path) |
| Phase A | Snapshot API error, including a 403 on a linked issue | Refusal. A 404 on a linked issue may still skip that issue, but a 403 must not be read as "no such issue" (`github.ts:238`) |
| Phase A | Project standards file listed but missing at base | Refusal before the model |
| Phase A | Diff over the cap, model run rejected, model output carries an identity term | Artifact records `ok: false`, phase B posts COMMENT |
| Phase B | Artifact missing, invalid or bound to another repo, pull request, head, base or tool revision | Refusal, nothing posted |
| Phase B | Fresh snapshot's head or base differs from the artifact, or an App review on this head already exists | Refusal, nothing posted |
| Phase B | Identity hit in the body, pull request no longer open, head moved before post | Refusal, nothing posted, as today |
| Spend | `dailyModelRuns` reached | No further reviews in that repository that day |
| Merge guard | Any API error, command not parseable, manifest field missing | Deny |
| Deployer | Any step of the recipe ambiguous or erroring | Refuse to deploy |

## Left to the builder

- How phase A, phase B and the minting step are arranged as processes or containers, within I1 to I5.
- Generalizing `run.ps1` (repository and vault references from config, not literals) and removing `DEFAULT_REPO` from the hub path (`cli.ts:39`).
- Plumbing per-repository config through `verdict.ts`, `types.ts` and `github.ts`, and loading harness standards from the pinned checkout.
- Rewording `reviewer-prompt.md:13-20` so it stops naming this repository's files and names the configured ones.
- Adding `issues: read` to `APP_PERMISSION_ALLOWLIST`, `TOKEN_PERMISSION_ALLOWLIST` and `TOKEN_PERMISSIONS` (`app-auth.ts:37-51`), and correcting the comment at `app-auth.ts:12-15` that relies on the public-repository allowance. #314 added `checks: read` only. The linked-issue fetch at `github.ts:237-245` hits the same wall on a private repository. Pin the 404-versus-403 handling with a test. The operator must also add the permission to the App and accept it on each installation.
- The base SHA in the review body's provenance line (`render.ts:177`).
- The hub identity loader. The October `loadCiIdentity` shape (`{names, emails}` plus the account email) read from 1Password instead of Actions secrets, add-only, carrying the names-key rule from #91.
- Re-pinning the `claude` CLI. The October plan pinned 2.1.291, and the operator's CLI was 2.1.318 on 2026-11-05. The container installs the platform package by exact version with a checksum. Stage 1 asserts `claude --version` before any run. Every re-pin checks that the runner still passes no `--bare` and that the chosen credential still authenticates, because Anthropic has said `--bare` will become the default for `-p`.
- Container packaging per the operator's container rules (hardened defaults, the service-account token as a secret file, never in a compose environment block).
- The merge guard hook, the pre-push default-branch refusal, the manifest field marking a repository enrolled, and tests that deny on every API failure.
- The single-hub lock and the stage 1 to stage 2 cutover steps.

## Coordinator calls recorded here

Each is reversible and the coordinator took it as a default. The operator may overturn any of them.

- Hub topology, logged in `docs/decision-log.md`.
- Poll at five minutes rather than a webhook.
- Stage 1 stays coordinator-started, with no workstation scheduler.
- Skip the model, and post nothing, when a required check failed. Skip drafts, read from the API.
- No personal-terms scan of review bodies on private repositories. The declared-identity scan stays (`identity.ts:226-239`). Flips if an enrolled repository is public or its review text is mirrored somewhere public.
- Merge only when the head is up to date with the default branch, which the deployer's tree check requires anyway.

## Open questions for the operator

1. Which model credential does the unattended hub use?
   - Where this came from: today the runner uses the operator's logged-in CLI session on the workstation. A container has no logged-in session, so it needs either a subscription token from `claude setup-token` or a Console API key. Anthropic documents the setup token for CI and scripts, and says subscription use assumes "ordinary, individual usage".
   - Recommend: A, the setup token stored once in the vault. Why: one copy, one subscriber, the subscriber's own repositories, which is the closest fit to individual use. The API-key advice on Anthropic's Actions page is about a secret copied across repositories, which the hub avoids.
   - A means: no new bill. The token lasts a year and is revoked from the account. A rotation reminder is needed.
   - B means: an API key in a workspace with a spend limit, billed per review (one `claude-opus-5-5` run at `xhigh`). Rotation never touches the subscription.
   - Flips if: Anthropic says this use falls outside individual subscription use, or subscription limits start blocking the operator's own sessions.
   - Blocks: stage 2 only. Stage 1 keeps the logged-in CLI.

2. Do private repositories get a second App without `contents: write`?
   - Where this came from: App permissions are set on the App, not per installation. The existing App holds `contents: write` because this public repository's ruleset counts its approval only when the installation can push (live 2026-09-14). On Free private repositories no ruleset exists, so that permission buys nothing there and only lets a leaked key push to them.
   - Recommend: A, a second App with `pull_requests: write`, `contents: read`, `checks: read`, `issues: read` and `metadata: read` for private repositories. Why: it removes push from every private installation at the cost of one more key in the same vault.
   - A means: the operator creates the App and stores its key. The config's `apps` map already allows two. Undo by uninstalling it.
   - B means: one App everywhere. A leaked key can push to every installed repository, bounded by the selected-repository list.
   - Flips if: a private repository moves to Pro and needs the App's approval to count toward a ruleset.
   - Blocks: nothing. Enrollment proceeds on the existing App and moves when the second exists.

3. What daily model-run cap per repository?
   - Where this came from: any writer in an enrolled repository spends the operator's model budget by pushing new heads. The hub reviews each green head once.
   - Recommend: A, 20 runs per repository per UTC day. Why: well above one household's pull request rate, low enough that a runaway agent stops within a day.
   - A means: on a busy day reviews stop and merges wait until midnight UTC.
   - B means: no cap. Spend is bounded only by the rate of new green heads.
   - Flips if: the operator sees caps hit on legitimate work.
   - Blocks: nothing, the default ships.

4. Which homelab host runs stage 2?
   - Where this came from: jobbot request 4 asks for a container on the homelab, naming the storage server or a VM as candidates. The hub holds the App key and the model credential in memory, so its host carries the same weight as other production services.
   - Recommend: A, a dedicated VM rather than the storage server. Why: a host compromise there exposes the reviewer only, not the storage server's data.
   - A means: one more VM to patch. Undo by moving the container.
   - B means: the container runs beside existing services on the storage server, sharing its blast radius.
   - Flips if: the storage server already isolates containers to the operator's satisfaction.
   - Blocks: stage 2 build target only.
