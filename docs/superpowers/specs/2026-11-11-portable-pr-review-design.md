# Portable PR reviewer: hub design (#146 refresh)

**Status:** proposed, 2026-11-11, revision 2. Replaces the October design (`docs/superpowers/specs/2026-10-05-pr-review-ci-design.md` on branch `feat/146-ci-reviewer`) as the plan of record for #146. The October design stays valid as the reversal option below. No implementation plan exists yet. A builder plans stage 1 now. Stage 2 is a separate plan, gated on the operator's answers to open questions 1 and 4.

This revision folds in a builder check and a security review of the first draft, and three operator rulings of 2026-11-11: the workstation service-account token's reach is accepted as is, the merge guard has no override, and the stage 2 credential and host stay open. Revision 2 closes two blockers a security re-review found in revision 1's fixes (an edited App review laundering a rewound base past the deployer, and an API-created check run joining the real check suite) and folds in its minor findings. Findings not adopted are listed at the end with a reason each.

**Base:** written against `ddeb82a`, the merge of #315 (#314, `checks: read`). File and line references are at that commit.

## Intent

The #120 reviewer (`tools/pr-review/`, posting as a GitHub App) gates pull requests on this repository today. A coordinator session on the operator's workstation starts it through the operator's runner (`run.ps1` in the operator's runner directory). The operator now wants the same gate on every repository the App is installed on, and the first new one is private.

The October design ran the reviewer as a GitHub Actions workflow inside the reviewed repository. Its whole secret-isolation story was an environment whose secrets only the default branch could deploy to, and its merge story was a ruleset counting the App's approval. Neither exists on a private repository under GitHub Free. On 2026-11-11 the rulesets and branch protection endpoints of the first enrolled private repository both returned 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." The operator stays on Free.

Without environments, any secret stored in a private Free repository is a repository secret. Any collaborator with write access can push a branch whose own workflow reads every repository secret. The App key and the model credential would then sit one `git push` away from the household writer the gate exists to check. So the reviewer moves out of the reviewed repositories. One runner that only the operator controls reviews every enrolled repository from outside, and no reviewed repository ever holds a reviewer secret.

## Goals

1. Any repository the App is installed on (selected repositories only) can be enrolled by adding a config entry. No runner code changes per repository. This is jobbot request 3.
2. No reviewer secret (App key, model credential, 1Password service-account token, identity terms) is stored in any reviewed repository, its Actions secrets, or its workflow files.
3. The reviewer never checks out, builds or runs code from a reviewed repository. Everything it reads arrives through the GitHub API as data. The same holds for every enrollment step (see Enrolling a repository).
4. The governing constraint from the 2026-09-20 ruling still holds: the process that hands pull request text to the model never holds the approving credential, and the process that holds it never runs the model. On stage 1 an accepted residual weakens this (see Accepted residual).
5. A deployer can check, through the API alone, that a deployed commit and every default-branch commit since the last verified deploy came through an App-approved pull request. The recipe is written down below. This is jobbot request 2.
6. Unattended operation on a homelab container, with secrets from a read-only 1Password service account. This is jobbot requests 1 and 4, met in stage 2.
7. Every per-repository list resolves fail closed. An empty required-check list, an empty standards set, a missing or empty standards file, or a missing or empty living doc refuses or withholds approval rather than shrinking the review.

## Non-goals

- Making GitHub enforce the App's approval on private Free repositories. GitHub cannot. Enforcement is a harness guard, repository text and, where one exists, a deployer check (see Approval enforcement).
- Reviewing pull requests from forks. They are refused as today (`github.ts:171-177`). Contributors use same-repository branches, and the repository's contributing text says so.
- A webhook listener. The hub polls (coordinator call, see Topology).
- Replacing the operator's current workstation runner before stage 2. Stage 1 generalizes it.
- Changing what the reviewer judges. The 600 KB diff cap, the severity floor, the tool-less model and the rule that linked-issue text is untrusted are reviewer properties by the #146 ruling and stay as they are.
- Splitting the reviewer vault or the workstation service-account token. The operator ruled on 2026-11-11 that both stay as they are.

## Anti-goals

These are things a builder might reasonably do that this design forbids.

- Copying a reviewer secret into a reviewed repository "just for CI". On Free that hands it to every writer.
- Running `anthropics/claude-code-action`, or any workflow in the reviewed repository, to do the review. The action exists to give the model tools in a workspace, and the reviewer's main injection control is a model with no tools.
- Reading per-repository policy from the reviewed repository in a way that can lower a floor. A file a non-admin writer can merge must not be able to empty the required checks, drop a cannot-vouch path, raise the diff cap, or tell the model to drop or downgrade a finding.
- Treating "no finding" as "approve" when an input was missing. A missing file, an unreadable check list or an API error is a refusal, never an empty block.
- Counting any APPROVED review as the App's approval. A collaborator can approve as themselves. Only the App's bot identity counts.
- Counting a check run as passed because its name and app match. Every workflow in a repository runs as the same app, so only a run bound to the configured workflow file, the pull request's head and an allowed event counts.
- Checking out an enrolled repository on the hub host or the coordinator workstation for any hub or enrollment step, including to run the installer there.
- Using `--bare` with the subscription token. Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN` (Anthropic authentication docs).

## Decisions this design stands on

| Decision | Source |
|---|---|
| Operator stays on GitHub Free. Private repositories there have no environments, environment secrets, rulesets or branch protection | Operator, 2026-11-11. Live 403 on the first enrolled private repository the same day |
| Guards for contributing and requiring pull requests are harness hooks or guards plus a CONTRIBUTING or AGENTS file in each repository, not GitHub settings | Operator, 2026-11-11 |
| Hub topology, as described below | Coordinator default, 2026-11-11, logged in `docs/decision-log.md`, reversible |
| Reviewer secrets live in the 1Password vault the reviewer already uses and are read by a read-only service-account token. The operator accepted that this token can read the model credential as well as the App key | Operator, 2026-11-11 (the coordinator had recommended a separate vault) |
| The workstation's user-scope service-account token, which reads that whole vault and is inherited by every process, is accepted as is. No split vault | Operator, 2026-11-11, logged in `docs/decision-log.md` |
| The merge guard has no override. Pull requests the App cannot vouch for are merged by the operator in the GitHub web UI. Agents never merge them | Operator, 2026-11-11, logged in `docs/decision-log.md` |
| The stage 2 model credential and host are open operator questions. Stage 2 is planned separately once they are answered | Operator, 2026-11-11 |
| The reviewer never runs pull-request-authored code. The model stays tool-less and pull request text is untrusted input | Operator, 2026-11-11, and the account security rule on untrusted content |
| The job reading the diff never holds the approving credential | Operator ruling on #146, 2026-09-20 |

## Topology

```
operator-held hub (stage 1: workstation runner, coordinator-started)
                  (stage 2: homelab container, unattended poller)
  config: enrollment list, per-repo policy, harness pin      (never in a reviewed repo)
  secrets: from 1Password over stdin pipes only             (never in a reviewed repo)
  state:  per-head attempt record and daily spend counter   (durable, hub-owned)

  key holder (long-lived, never starts claude, reads only code-typed fields):
    every poll interval:
      App JWT -> installations -> repositories (selected)
      intersect with enrollment list
      for each enrolled repo, for each open pull request:
        candidate if: not draft, base is the default branch, head repo is this repo,
                      required checks pass the single verification rule (Configuration schema),
                      no App review on this head yet, no recorded deterministic refusal
                      on this head, and the repo's daily cap not reached
    for each candidate, strictly one at a time:
      mint      read-only installation token for this one repo
      phase A   (model phase, child with an allowlisted environment)
                holds: read-only token, model credential. Never the App key or service-account token
                snapshot via API -> head pin -> diff coverage check -> model, no tools
                -> identity scan -> model-run artifact bound to repo, pr, head, base, tool revision
      phase B   (post phase)   holds: App key or a write token for this one repo
                own snapshot -> bind artifact -> verification from own CI read
                -> event in code -> identity scans -> head and base re-check -> post
```

Nothing is installed in a reviewed repository for the review itself. The App installation and a config entry are the whole enrollment on the reviewer side. The repository side gets contributing text and the harness merge guard (see Approval enforcement), which are about merging, not reviewing.

### Process split inside the hub

The October two-job split carries over as separate processes, because the hub reads attacker-controlled text just as the workflow did. These invariants are what the builder must keep. How the processes are arranged is left to the builder.

- I1. The process that passes pull request text to `claude` holds no App private key, no installation token with any write permission, and no 1Password service-account token, including by environment inheritance. Its token is minted read-only for one repository (`contents`, `pull_requests`, `checks`, `issues` and `actions`, all `read`). A test asserts the phase A token carries no write permission.
- I2. The process that holds the App key, or any installation token with a write permission such as `pull_requests: write`, never starts `claude`. Phase B is bound by this as much as the key holder is. The key holder is the long-lived process that holds the App key, mints the App JWT for enumeration and minting, and drives each candidate. Every child it spawns, phase A included, gets an allowlisted environment, never a copy of its own (`runner.ts:413` passes the full `process.env` to the `claude` child today, and that changes). In stage 2 the key holder is also the only holder of the service-account token, so it can read the model credential, and it relays that credential to phase A over a stdin pipe without keeping it.
- I3. Secrets move only over stdin pipes, from `op read` or from the minting step, as the current runner already does for the App key. A secret does not appear in argv, in a long-lived process's environment, in a file or in a log. There are two exceptions. The model credential is read by the CLI from `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`), so it is set in the `claude` child's environment only. The service-account token is read by `op` from `OP_SERVICE_ACCOUNT_TOKEN`, so it is set in the environment of a short-lived `op` child only, started by the token's holder, and never in any other process's environment.
- I4. The artifact crossing from phase A to phase B is the October `model-run.json` contract unchanged: version, repo, pull request, head, base, tool revision and the model result, no other keys, bound by equality before anything else is used. The tool revision is the pinned harness commit, not anything from the reviewed repository.
- I5. Bun runs from an empty working directory outside every checkout, so no `bunfig.toml` or `.env` is preloaded (`cli.ts:12-21`, `:320-324`). The reviewed repository is never on disk.
- I6. The service-account token. Stage 2: held only by the key holder, as a secret file only the key holder's user can read. Phase A and the `claude` child never inherit it and cannot read the file or any `op` session. Stage 1: the token is a user-scope variable every process inherits, which the operator accepted (see Accepted residual). The runner still strips it, with the other token variables it already clears, from phase A's and the `claude` child's environments.
- I7. Output the hub hands a coordinator session carries only code-produced fields: repository, pull request number, head, status, event, finding counts by severity and the posted review id. Model-written strings (finding titles, review body text) never reach coordinator-facing output. The posted review on GitHub is where a person reads them.

### Stages

**Stage 1, workstation.** Generalize the operator's runner and the tool so a run takes its repository and policy from the hub config instead of hard-coded values (`run.ps1:49` names this repository, `cli.ts:39` defaults to it, `verdict.ts:25-30` names this repository's checks). A coordinator session still starts each run. This meets requests 2, 3 and 5 but not request 1: a pull request opened at night waits for the next coordinator session (coordinator call: no workstation scheduler, because it would run unattended on the operator's interactive account. Flips if the container slips and an enrolled repository starts depending on overnight reviews, in which case a scheduled task on the workstation is the bridge).

Stage 1 has a precondition. Today one process (`cli.ts:326-369`, started by `fanout.ts`) holds the App key and spawns `claude`, which breaks I2 once a household writer's pull requests are reviewed. And `checkPermissions` requires `pull_requests: write` on every token (`app-auth.ts:128`), so a read-only phase A token cannot be minted yet. The phase A and phase B split, with a phase A allowlist that requires `pull_requests: read`, ships before any new repository is enrolled. This repository moves onto it in the same change.

Stage 1 runs in two modes, both through the same candidate checks: a single pass over every enrolled repository that exits, and a single named pull request, which is how the coordinator runs the reviewer before a merge today. The loop mode is stage 2 only.

**Stage 2, homelab container.** The same code as a poller in a container on a homelab host, with the service-account token as a container secret file readable only by the key holder (I6) and every other secret read through it at run time. Outbound only: the GitHub API, the model API and 1Password. No inbound port. A container healthcheck and an alert in the homelab monitoring stack fire when the hub stops or no poll has completed for several intervals, and when an enrolled repository is refused at enumeration. Those logs and alerts carry no pull request text and no identity terms. Stage 2 is a separate plan, gated on open questions 1 and 4.

Only one hub may be active at a time. The migration from stage 1 to stage 2 disables workstation runs before the container's first poll, and phase B re-checks for an existing App review on the head immediately before posting, so an overlap produces a refusal rather than a second review.

**Poll, not webhook (coordinator call).** A webhook needs an inbound endpoint through the homelab reverse proxy, which is a new exposed path carrying signed but attacker-triggered requests. A five-minute poll costs latency only. Flips if review latency becomes the bottleneck on an enrolled repository.

### This repository

The App is installed here, so the hub reviews this repository too. The October in-repository workflow remains a valid design for this public repository, where environments and rulesets do work, but it is not built under this spec. Each repository is served by exactly one path, and the hub config is that list. This repository is public, so phase B runs the public-repository scans before posting (see Coordinator calls).

### Reversal option: GitHub Pro plus a reusable workflow

Upgrade the operator's account to Pro. Private repositories then get environments with deployment branch policies and rulesets. The reviewer becomes a reusable workflow in this repository, called at a pinned SHA by a thin `workflow_run` caller the installer ships into each repository. The callee checks out its own source with `job.workflow_repository` and `job.workflow_sha` and never checks out the caller. The October two-job split runs inside it with environment secrets gated to the default branch, and a ruleset per repository requires the App's approval, which the installation's `contents: write` makes count.

What it costs: the Pro subscription, a copy of every reviewer secret in every enrolled repository (Anthropic's GitHub Actions page recommends a Console API key rather than a subscription token for a secret shared across repositories), and a pin-bump pull request per repository for every reviewer change.

What would flip to it: the operator wants GitHub itself to refuse a merge without the App's approval, including merges by human writers. Or an enrolled repository gains a writer outside the household. Or the hub's single host becomes the availability problem. The hub can stay running as a fallback during a switch.

## Trust boundaries and threat model

**Untrusted input.** Everything in a pull request (diff, file contents at head, title, description, commit messages, branch name), linked issue text and comments, and every file read from a reviewed repository at its base commit. A base-commit file is only as trusted as whoever can merge to that repository, which in a household repository includes a non-admin writer and that writer's agents. Such files reach the model as data and can add to policy, never subtract from it. Check runs are untrusted too until bound to the configured workflow (see Configuration schema).

**Credentials.**
- The App private key mints installation tokens that can post an APPROVE as the App, and with the installation's `contents: write` it can push to every repository the App is installed on.
- The 1Password service-account token reads the whole reviewer vault: the App key, the model credential and about nine unrelated credentials (accepted by the operator, see Accepted residual). Reading the App key makes it equivalent to the App key.
- The model credential spends the operator's subscription (setup token) or API budget (API key).
- Installation tokens last one hour and are minted per repository.
- The identity terms are not credentials but must never be published.

**Accepted residual: the workstation service-account token (operator, 2026-11-11).** On the stage 1 workstation the 1Password service-account token is a user-scope environment variable. It reads the whole reviewer vault, which holds the App key, the model credential and about nine credentials that have nothing to do with the reviewer. Every process the operator's account starts inherits it, including agent sessions that read pull request and web text. The operator accepted this as is. On stage 1 this means I1 and I2 hold for what each process is handed but not for what it can reach. Phase A is not given the token (I6), yet any process under the operator's account, including one an injected agent session starts, can read the App key through `op` with the inherited token. The isolation between phase A and the key is a property of the code the hub runs, not a boundary the operating system enforces. Stage 2 must differ: the token is held only by the key-holding process, and phase A and the `claude` child never inherit it or reach its file.

**Trusted code and config.** The harness at the pinned commit, clean (the dirty-checkout refusal stays, `tool-state.ts:20-42`), the pinned `claude` CLI, the pinned Bun, and the hub config. The hub host is trusted: whoever controls it controls the gate. So does whoever controls phase A's code, the `claude` CLI pin or the Bun pin, because each can produce the artifact phase B turns into an APPROVE.

**Closed by absence.**
- No reviewer secret exists in any reviewed repository, so no branch workflow there can read one.
- No reviewed repository is checked out by the hub or by any enrollment step, so no repository code, hook, config or autoload file runs on an operator-credentialed host on their account.
- The model has no tools (`runner.ts:158`, checked per run), so injected text cannot read the environment, files or tokens.
- Phase A has no write credential (I1), so a compromised model phase cannot push or reach the key through anything it is handed. It is still approval authority: an artifact with `ok: true` and zero findings is exactly what phase B turns into APPROVE on any pull request with green bound checks and no cannot-vouch path. The split protects the key and push access, not the approval.

**What a malicious pull request can still do.**
1. Persuade the model. A finding talked out of existence plus green CI yields APPROVE. This is the deepest residual, unchanged from today. The controls are around the model: cannot-vouch paths, the diff cap, code-computed events.
2. Spend the operator's model budget. Every new head on a same-repository pull request with green CI costs one `claude-opus-5-5` run at `xhigh`. Bounded by one model run per head (a deterministic refusal is recorded and not rerun), the draft skip, the failed-CI skip and a per-repository daily cap (open question 3).
3. Race the post. A push or retarget during review makes phase B refuse, and the next poll picks up the new head.
4. Steer the model into writing text aimed at the coordinator. I7 keeps model-written strings out of coordinator-facing output.

**What a malicious change to a reviewed repository's default branch can do.** On Free nothing stops a writer pushing straight to the default branch or merging an unapproved pull request in the web UI. Such a change can edit the contributing text, the living docs and the project standards files, all of which feed the next review. Project standards are lower-trust data that can only add findings (see Configuration schema), and a living doc that goes missing or empty withholds APPROVE. It cannot reach a secret, change the required checks the hub demands, add or remove a cannot-vouch path (those live only in hub config and code), or change the reviewer code. It can delete or edit the harness merge guard's repository-side config, so the guard binds agents and is not a boundary (see What this does not stop).

It can also try to launder itself. A later pull request branched from the unreviewed commit shows only its own change, earns an honest APPROVE, and its merge carries the unreviewed commit with it. The deployer's chain of custody refuses that deploy, because the unreviewed commit sits on the first-parent path with no approved pull request behind it. A second variant rewinds the default branch instead. The writer pushes an unreviewed commit, gets a harmless pull request on top of it approved, force-pushes the branch back to before the unreviewed commit, edits the App's review body so its provenance base names the rewound tip, and merges. The deployer refuses that too: an edited review is never trusted, the provenance base is cross-checked against the pull request's API record, and any force push to the default branch since V refuses. A repository with no deployer check has no defence against either variant beyond procedure.

**What a leaked App key can do.** Post an APPROVE as the App on any installed repository, and push to any of them while the App holds `contents: write`. Selected-repository installation bounds the reach. In stage 2 the key exists in the vault and in the key holder's memory for as long as the hub runs. In stage 1 any process under the operator's account can also read it through the inherited service-account token (Accepted residual). Open question 2 asks whether private repositories get a second App without `contents: write`.

**Compromise of the hub host.** Everything above, plus every credential in the reviewer vault, because the service-account token reads all of it. The workstation is the operator's own account. The stage 2 host gets the same care as other homelab production services.

**Operator development checkouts.** This spec forbids checking out an enrolled repository for any hub or enrollment step. A checkout the operator makes for their own development work in an enrolled repository runs that repository's committed hooks and settings under the operator's account, which on stage 1 holds the service-account token. That is outside this spec, and it is recorded here so it is not mistaken for something the hub closes.

## Enrolling a repository

The coordinator runs these in order and stops at the first failure. Steps the operator must do by hand are marked. No step checks out the repository on the hub host or the coordinator workstation. Everything is read and written through the GitHub API as data.

1. **Operator, web UI:** add the repository to the App's installation (selected repositories), and accept the `actions: read` and `issues: read` permissions on it. Installation changes stay in the web UI, which keeps every stored token at its current scope.
2. Check the installation from the App's side: `GET /repos/{owner}/{repo}/installation` with the App JWT must show `repository_selection: selected` and permissions inside `APP_PERMISSION_ALLOWLIST` (`app-auth.ts:37-42`). The tool's `mint()` already refuses otherwise (`app-auth.ts:147-182`), so a dry `snapshot` of any open pull request is the check.
3. Check the repository's Actions settings: `GET /repos/{owner}/{repo}/actions/permissions/workflow` must read `default_workflow_permissions: read` and `can_approve_pull_request_reviews: false`. This stops the repository's default `GITHUB_TOKEN` approving. It does not stop a writer's workflow from requesting `checks: write` in its own `permissions` key. Required checks are bound to their workflow for that reason (see Configuration schema).
4. Check that no reviewer secret is present: `GET /repos/{owner}/{repo}/actions/secrets` must list none of the reviewer's secret names. Their presence means someone followed the old design, and the enrollment refuses until they are deleted and rotated.
5. Read the repository's CI workflow at the default branch through the contents API and write its config entry (schema below): the CI workflow path, the required check names and the app that runs them, extra cannot-vouch paths, living docs, the project standards files. Start in `comment-only` mode.
6. Generate the repository-side files from the harness at the pin, never from the target: the CONTRIBUTING or AGENTS merge text (see Approval enforcement), the harness merge guard, and the manifest's enrolled flag, set off. The installer runs in an emit-only mode that writes to a staging directory in the hub's own space and reads any existing `.claude/` content of the target through the contents API as data, never executing it. The coordinator writes the files to a new branch with `PUT /repos/{owner}/{repo}/contents/{path}` and opens a pull request through the API. A disposable VM or container holding only a one-repository token is an acceptable alternative. An operator-credentialed checkout is not.
7. **Operator, web UI:** merge that pull request. It touches cannot-vouch paths, so the App never approves it.
8. Run one comment-only review on an open pull request and read the posted review back: on the pinned head, by the App's bot, body clean under the identity scans.
9. **Operator,** only where the repository deploys from its default branch: attest the seed commit for the deployer's chain of custody (see Deployer check).
10. After three clean comment-only reviews, switch the entry to `post`, turn enforcement on for the repository in the operator-only enrolled list, and set the manifest's enrolled flag on through a second contents-API pull request that the operator merges. Until that pull request merges the two disagree and the guard denies, which fails closed. The guard enforces only from this step, so agents are not locked out of merging during the comment-only rollout. Heads already reviewed in comment-only mode are not re-reviewed, so the first APPROVE needs a fresh push.

Secrets are never handled in this flow, because none go to the repository. At hub start, each secret moves from 1Password straight into the consuming process: `op read` writes to the reader's stdin, as `run.ps1` does today for the App key, and nothing echoes, stores or logs the value. Vault references live in the hub config by placeholder name and in the operator's runner directory, never in this repository.

For the reversal option only, provisioning a repository secret takes the same shape, with the value never on a command line:

```
op read "op://<vault>/<item>/<field>" | gh secret set <NAME> --repo <owner>/<repo> --env <environment>
```

## Approval enforcement

On Free the App's APPROVE is advisory to GitHub. Nothing on GitHub refuses a merge without it. Three things enforce it instead, and none of them is a server-side boundary against a human writer.

**What the App posts.** One review per head, pinned to that head (`github.ts:305-318` checks the returned `commit_id` and state). The event is computed in code: APPROVE needs three things: verification passed on the configured required checks, bound to their workflow, the change stays clear of every cannot-vouch path, and the model returned zero findings at the floor. The body's provenance line gains the base SHA beside the head, model and tool revision it carries today (`render.ts:177`), so a reader can see exactly what was compared. The provenance line is rendered by code as the body's last line, in a fixed form, and the renderer refuses a body whose model-written text contains a line of that form, so the deployer can parse it without trusting model text.

**Repository text.** Each enrolled repository's CONTRIBUTING or AGENTS file states the merge rule: changes land by pull request from a branch in the same repository, never by direct push to the default branch. A pull request merges only when the App's latest review is an APPROVE of its current head and the head is up to date with the default branch. Merges use squash or a merge commit, never rebase, because the deployer's chain of custody reads one commit per pull request. Anything the App cannot vouch for is merged by the operator in the GitHub web UI. Agents read this file. The reviewer reads it as lower-trust project data.

**Harness merge guard (new hook).** A PreToolUse hook on the Bash and PowerShell tools, shipped by the installer to code projects. It never takes the App's bot user id, the enrolled list or its read account from a file in the reviewed repository. A repository file is writer-controlled, and on Free a writer can push straight to the default branch, so a bot user id read from one would let a writer point the gate at an account they control. The bot user id is public, so it may come from the harness pin (the harness checkout at the pinned SHA) or from the hub's own config. The list of enrolled repositories with their enforcement state, and the GitHub account the guard reads as, come only from operator-only local config: the hub's own config, or an account-level file written from it, outside every repository and never committed anywhere public. The enrolled list names private repositories, so committing it to the public harness repository would publish them. The read account is named because the operator's workstation has more than one `gh` account and an unqualified read would deny every merge. The repository's committed `.claude/.harness-manifest.json` may still carry an enrolled flag. When that flag and the operator-only list disagree in either direction, the guard denies.

The guard fails closed when the operator-only source is unavailable. In any repository whose `.claude/.harness-manifest.json` exists at all, it then denies every recognized merge form, whatever the flag says, so a writer cannot switch the guard off by editing or deleting the flag. A session without that source, which includes a writer's own harness sessions and any harness user outside the operator's machines, cannot merge through a harness session in any harness-installed repository. Merges there happen in the web UI.

It recognizes these forms and treats each as follows:
- `gh pr merge`: allowed only with `--match-head-commit <sha>` and `--squash` or `--merge`. Denied with `--auto`, `--rebase` or `--admin`.
- `gh api` to a pull request's REST merge endpoint: allowed only with the `sha` body field set, which plays the part of `--match-head-commit`, and a `merge_method` of `squash` or `merge`.
- `gh api graphql` carrying `mergePullRequest` or `enablePullRequestAutoMerge`: always denied.
- `git push` whose destination is the default branch: always denied. The pre-push hook refuses the same push as a second layer, since `--no-verify` skips it.

An allowed form passes only when all of these hold, read live from the API at the moment of the call:
- the SHA the command names is the pull request's current head
- the latest review by the App's bot user (matched by user id, not by login) has state `APPROVED` and `commit_id` equal to that head
- the head is up to date with the default branch (`GET /repos/{owner}/{repo}/compare/{base}...{head}` reports `behind_by` 0)

Any API error, unparseable command, missing operator-only source or field, missing pin-side bot user id, or disagreement between the manifest flag and the operator-only list denies. This repository plus the first enrolled private repository are the two projects the graduation bar asks of a hook (decision note `graduation-bar-second-project`).

**No override (operator, 2026-11-11).** The guard has no override, no operator token and no per-PR authorization. A pull request the App cannot vouch for, including every cannot-vouch change and every CI-editing change, is merged by the operator in the GitHub web UI. Agents never merge them. The coordinator's admin-bypass merge path, used in this repository for owned-path and CI-editing pull requests, ends in each enrolled repository when the guard's enforcement is switched on there, this repository included.

**Deployer check.** Where a repository deploys from its default branch, the deployer is the one check outside the writer's reach. It reads with a read-only credential of its own, takes the App's bot user id from the harness pin or its own config, never from the repository, and never holds the App key. It keeps one piece of durable state outside the repository: the last verified commit V. The operator attests V once at enrollment (step 9), and only the operator re-seeds it.

The recipe, for a commit C about to deploy:

1. Walk first parents from C back towards V on the default branch. V must be reached. Reaching the root or the walk limit without meeting V refuses.
2. For each commit X on that walk, excluding V:
   - `GET /repos/{owner}/{repo}/commits/{X}/pulls` must return exactly one pull request N, merged into the default branch, whose `merge_commit_sha` equals X. A direct push has no such pull request, and a rebase merge's intermediate commits fail this, so both refuse.
   - `GET /repos/{owner}/{repo}/git/commits/{X}` and `.../git/commits/{H}`, where H is N's final head (`head.sha`), must have equal `tree.sha` values. This proves X's content is exactly the reviewed head, whatever the merge method.
   - `GET /repos/{owner}/{repo}/pulls/{N}/reviews`, all pages. Keep reviews whose `user.type` is `Bot` and whose `user.id` is the App's bot user id. The latest of them by `submitted_at` must have state `APPROVED` and `commit_id` equal to H.
   - That review must never have been edited. GraphQL `PullRequestReview.lastEditedAt` must be null and `PullRequestReview.userContentEdits.totalCount` must be 0. Anyone with write access can edit a review body, the App's included, so an edited body is refused whatever it now says.
   - The base SHA in that review's provenance line must equal X's first parent (`parents[0].sha` from `GET /repos/{owner}/{repo}/git/commits/{X}`). It is never trusted from the review text alone. The deployer cross-checks it against the pull request's own API record: `GET /repos/{owner}/{repo}/pulls/{N}` must show `merged` true, `merge_commit_sha` equal to X, `base.ref` equal to the default branch, `head.sha` equal to H, and `base.sha` equal to the provenance base, with GraphQL `PullRequest.mergeCommit.oid`, `headRefOid` and `baseRefOid` agreeing. Whether `base.sha` on a merged pull request is the base tip at merge time is unconfirmed until a live capture. If it is not, the builder pins the field that is, and the deployer refuses rather than skipping the leg. So the review compared H against exactly the commit X was merged onto, and that commit is itself checked by the next step of the walk or is V.
   - `GET /repos/{owner}/{repo}/activity?ref=refs/heads/<default>&activity_type=force_push` must show no force push to the default branch since V. A rewind is how a reviewed base disappears from the branch, so any force push refuses until the operator re-seeds V.
3. Every X passes: deploy C and record C as the new V.
4. Any API error, missing field, unparseable provenance line or ambiguity refuses. The builder ships a test for each refusal: an edited review (`lastEditedAt` set), an edit history with `lastEditedAt` cleared but `userContentEdits` non-zero, a provenance base that differs from X's first parent, a provenance base that differs from the pull request's recorded base, a `merge_commit_sha` or `head.sha` mismatch, and a force push to the default branch since V.

A pull request touching a cannot-vouch path never gets an APPROVE, so the walk refuses once it is merged. The operator reviews such a change, deploys it under the deploying project's own rule, and re-seeds V by attestation. An unreviewed commit pushed or web-merged to the default branch breaks the chain the same way, and so does any later pull request built on it.

**What this does not stop.** A human writer can merge in the web UI, run `gh` outside a harness session, delete the guard's hook files from the repository, or push straight to the default branch. Client-side hooks bind only sessions where the harness is installed, and they match command text, so an agent that hides a merge inside a script can get past them too. On Free, for a repository without a deployer check, the App's approval is enforced by procedure against humans and by a tripwire against honest agents. The operator chose this on 2026-11-11 (guards through hooks and repository text). The reversal option is what changes it.

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
  "publicScanRef": "op://<vault>/<item>/<field>",
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
| `requiredChecks` | Non-empty list of `{name, appSlug}`. Replaces `REQUIRED_CHECKS` (`verdict.ts:25-30`). A check run counts only when it is a job of a bound workflow run. A workflow run is bound when its `path` equals `ciWorkflowPath`, its `head_sha` equals the pull request head, its `event` is `pull_request` or `push`, and its `head_branch` equals the pull request's head ref. Its jobs are enumerated from `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs?filter=all`, and the check run's `id` must equal the id at the end of a job's `check_run_url`. Membership in the bound run's check suite is not enough, because GitHub places a check run created through the API into an existing suite by repository and SHA, so a forged run can join the real suite. Runs are read with `filter=all`, not the `filter=latest` used at `github.ts:144`, so a later forged run cannot shadow the real one | Empty list: the entry is invalid. The loop at `verdict.ts:97-128` adds no reason when the list is empty, so an empty list must never reach it. Any same-named run that is not a job of a bound run: verification fails, no APPROVE |
| `ciWorkflowPath` | Replaces `WORKFLOW_PATH` (`types.ts:141`). A pull request that edits it touches `.github/`, which is on the floor | Absent at the base commit: incomplete, no APPROVE, as today |
| `powershellSuiteCoverage` | Turns this repository's Pester-coverage rule (`verdict.ts:152-157`) on. Off elsewhere | |
| `cannotVouchAdd` | Path prefixes added to the fixed floor in code. Lives only in hub config. Can only add | Never lowers the floor. The floor is not configurable |
| `livingDocs` | Replaces `LIVING_DOC_PATHS` (`types.ts:139`). Read at the base commit. Joins the prompt as lower-trust delimited data with neutralized delimiters and the run's nonce, as project standards do (see below). Every listed path joins the fixed floor | A configured living doc missing or empty at base: incomplete reason, no APPROVE. A missing doc used to be skipped (`github.ts:257-261`) on the reasoning that it never shapes the event, but undocumented drift is a correctness finding (`reviewer-prompt.md:110-114`), so a missing doc silently removes a check that can block APPROVE |
| `projectStandards` | Non-empty. Read at the base commit. Joins the prompt as a separate, delimited, lower-trust block (see below). Every listed path joins the fixed floor | Empty list: invalid entry. A listed file missing, empty or whitespace only at base: refusal, no review |
| `docsVerdictLine` | Turns the docs verdict line (`docs-verdict.ts`) on | |
| `maxDiffBytes` | May lower the code constant (`types.ts:146`), never raise it | A value above the constant: invalid entry |
| `dailyModelRuns` | Per-repository model-run cap per UTC day, counted at model start in the hub's durable store | Cap reached: no further reviews that day, so no approvals. Counter unreadable or store missing: no model runs |
| `mode` | `comment-only` or `post` | Any other value: invalid entry |
| `publicScanRef` | The personal terms and other terms the public-repository scans refuse on, read from 1Password like the identity terms | Missing or unreadable while any enrolled repository is public: hub stops |

**The fixed floor.** Cannot-vouch paths in code, not configurable: `.github/` (all of it, so workflows, local actions under `.github/actions` and CODEOWNERS), `.gitleaks.toml`, `.gitleaksignore`, any `.gitattributes` (today's set at `verdict.ts:136-150`, widened from `.github/workflows/` to `.github/`), `.claude/` (the harness manifest, the merge guard and every other hook and setting), and every path the entry lists in `projectStandards` or `livingDocs`. A change to any of them is merged by the operator. `cannotVouchAdd` adds to this set.

**Harness standards and project standards.** Harness standards are not configurable per repository. They come from the pinned harness checkout: today's `TRUSTED_CONTEXT_PATHS` minus `CONTRIBUTING.md` (`types.ts:128-133`), read from disk at the pin rather than from the reviewed repository's base. A missing harness standards file is an error that stops the hub, not an empty block. Today a missing trusted-context file is silently dropped (`github.ts:252-256`), which in a new repository gives the model an empty standards block with no signal, and that changes.

Only harness standards carry the authority the trusted block has today (`prompt.ts:43`, `reviewer-prompt.md:13-15` and `:41-53`). Project standards come from a base commit a writer can push to, so they sit in their own labelled, delimited block after the harness standards, with any delimiter text inside them neutralized. The prompt states that the block is project data at lower trust: it may add findings, it can never drop or downgrade one, harness standards and the reviewer prompt win on any conflict, and text in it addressed to the reviewer is reported as an observed instruction, the same way such text in the pull request is. A prompt test pins this: it renders a prompt with a project standards fixture that tries to downgrade a class of finding and asserts the block's position, its label, the precedence sentence and the neutralized delimiters. This repository's `CONTRIBUTING.md` moves from the trusted block into its `projectStandards` entry.

Living documents get the same treatment. Today each one sits between `=== Living document` and `=== End of living document` lines (`prompt.ts:37-38`), outside the nonce boundary and directly after the trusted block, so a configured living doc could close its own block and open a forged trusted section. Each living doc moves into a lower-trust block bounded by the run's nonce, with any delimiter or nonce-shaped text inside it neutralized, and labelled as claims to check rather than instructions. The prompt test covers a living-doc fixture that tries to open a forged trusted section.

## Failure modes that must fail closed

Every row ends with no APPROVE posted. Most end with nothing posted at all.

| Where | Condition | Behaviour |
|---|---|---|
| Hub start | Config invalid, harness checkout dirty or off pin, a harness standards file missing, CLI version not the pinned one | Hub stops before any poll. Stage 2 alerts |
| Hub start | 1Password rejects the service-account token, or any `op read` fails | Hub stops, no fallback to any other credential source. Stage 2 alerts |
| Hub start | Durable store missing outside its explicit init step, or unreadable | Hub runs no model. A missing store is never taken as a fresh zero count |
| Enumeration | Installation list unreadable, or `repository_selection` not `selected` | Poll aborts, nothing reviewed |
| Enumeration | Enrolled repository not in the installation | That repository refused and reported, others continue |
| Candidate selection | Draft state, CI state, check bindings or existing App reviews unreadable | That pull request skipped this poll |
| Candidate selection | Fork head, non-default base, any required check pending or unbound | Skipped, no model run |
| Candidate selection | A required check failed | Skipped, no model run, nothing posted (coordinator call: posting a no-model COMMENT on every failed head is noise. A failed check withholds APPROVE, so neither the merge guard nor the deployer passes the head. GitHub itself blocks nothing on Free) |
| Candidate selection | This head has a recorded deterministic refusal | Skipped. A new head, or the operator clearing the record, makes it a candidate again |
| Phase A | Snapshot API error, including a 403 on a linked issue | Refusal. A 404 on a linked issue may still skip that issue, but a 403 must not be read as "no such issue" (`github.ts:238`) |
| Phase A | Project standards file listed but missing, empty or whitespace only at base | Refusal before the model |
| Phase A | A changed path, or a renamed file's previous path, from the complete changed-file listing has no header in the compare diff | Verification incomplete, no APPROVE. The compare API documents a 300-file limit on its file list, and what the diff media type returns past that is unconfirmed until a live capture |
| Phase A | Diff over the cap, model run rejected, model output carries an identity term | Artifact records `ok: false`, phase B posts COMMENT |
| Phase B | Artifact missing, invalid or bound to another repo, pull request, head, base or tool revision | Refusal, nothing posted |
| Phase B | Fresh snapshot's head or base differs from the artifact, or an App review on this head already exists | Refusal, nothing posted |
| Phase B | Identity hit in the body, a public-scan hit on a public repository, model text containing a provenance-form line, pull request no longer open, head moved before post | Refusal, nothing posted. Deterministic refusals are recorded against the head so the model is not rerun on it |
| Phase B | Configured living doc missing or empty at base | Incomplete reason, no APPROVE |
| Spend | `dailyModelRuns` reached, or the counter unreadable | No further model runs in that repository that day |
| Merge guard | Any API error, command not parseable, pin-side bot user id missing, operator-only enrolled list unavailable in a repository with a manifest, manifest flag disagreeing with that list, a denied form | Deny |
| Deployer | Review on H ever edited (`lastEditedAt` non-null or `userContentEdits` non-zero), provenance base disagreeing with X's first parent or the pull request's recorded base, a force push to the default branch since V | Refuse to deploy |
| Deployer | Walk does not reach V, any commit on it fails, any step ambiguous or erroring | Refuse to deploy |

## Left to the builder

- How phase A, phase B, the key holder and the minting step are arranged as processes or containers, within I1 to I7.
- The phase A and phase B split as the stage 1 precondition, including splitting `checkPermissions` (`app-auth.ts:128`) so a phase A allowlist requires `pull_requests: read`, and a test that the phase A token carries no write permission.
- The allowlisted child environment for phase A and the `claude` child, replacing `env: process.env` at `runner.ts:413`, and stripping the service-account token on stage 1 (I6).
- Generalizing `run.ps1` (repository and vault references from config, not literals) and removing `DEFAULT_REPO` from the hub path (`cli.ts:39`).
- Stage 1's single-pass mode and single-pull-request mode through the same candidate checks. The loop mode only in stage 2.
- Plumbing per-repository config through `verdict.ts`, `types.ts` and `github.ts`, and loading harness standards from the pinned checkout.
- Binding required check runs to the jobs of a bound workflow run, through the run's jobs endpoint and matching check run ids, reading with `filter=all`. Tests with a same-named run from a side-branch workflow and an API-created check run placed in the bound run's own suite, both of which must fail verification. A live capture of where an API-created check run from a side-branch workflow lands, read from its `check_suite.id`, so the fixture matches GitHub rather than an assumption.
- Reconciling the #148 cancelled-run rule (`verdict.ts:103-117`) with the job binding. A cancelled run is excused only when a success exists among check runs that are jobs of a bound workflow run for the same required check on the same head. A success that is not such a job never supersedes a cancelled run, and a test pins the cancel-then-forge sequence. The candidate test and verification use this one rule.
- The diff coverage check in code, a live capture of the compare diff past 300 files, and a test pinning the behaviour.
- The project standards and living-doc blocks, their neutralized delimiters, the nonce bound on living docs, the precedence text in `reviewer-prompt.md`, and the prompt test. Rewording `reviewer-prompt.md:13-20` so it stops naming this repository's files and names the configured ones.
- The widened fixed floor (`.github/`, `.claude/`, configured `projectStandards` paths) in `verdict.ts`.
- Missing or empty living docs as an incomplete reason, and a refusal on empty project standards files.
- Adding `issues: read` and `actions: read` to `APP_PERMISSION_ALLOWLIST`, `TOKEN_PERMISSION_ALLOWLIST` and `TOKEN_PERMISSIONS` (`app-auth.ts:37-51`), and correcting the comment at `app-auth.ts:12-15` that relies on the public-repository allowance. #314 added `checks: read` only. The linked-issue fetch at `github.ts:237-245` hits the same wall on a private repository. Pin the 404-versus-403 handling with a test, and add a test that a mint requesting `issues: read` fails when the installation lacks it. The operator must also add both permissions to the App and accept them on each installation.
- The base SHA in the review body's provenance line (`render.ts:177`), rendered as the fixed-form last line, and the renderer's refusal of model text containing that form.
- The hub identity loader. The October `loadCiIdentity` shape (`{names, emails}` plus the account email) read from 1Password instead of Actions secrets, add-only, carrying the names-key rule from #91.
- The public-repository scans in phase B before posting: the personal-terms scan and the checks the operator's runner already does as a post-hoc readback, sourced from `publicScanRef`. The post-hoc readback stays as a second check.
- The durable hub store: the per-head attempt record, no rerun after a deterministic phase B refusal, the daily counter counted at model start, an explicit init step, and a persistent volume in stage 2 so a container restart keeps both.
- Coordinator-facing output limited to code-produced fields (I7).
- Re-pinning the `claude` CLI. The October plan pinned 2.1.291, and the operator's CLI was 2.1.318 on 2026-11-05. The container installs the platform package by exact version with a checksum. Stage 1 asserts `claude --version` before any run. Every re-pin checks that the runner still passes no `--bare` and that the chosen credential still authenticates, because Anthropic has said `--bare` will become the default for `-p`.
- An emit-only installer mode for enrollment step 6, which writes the repository-side files to a staging directory from the harness at the pin and reads the target's existing `.claude/` content through the contents API as data, plus the contents-API branch and pull request steps.
- The merge guard hook with the forms and denials listed under Approval enforcement, the bot user id from the harness pin or hub config, the enrolled list with enforcement state and the read account from operator-only local config (never the harness repository, never the reviewed repository), the manifest's enrolled flag and the fail-closed check that it matches the operator-only list, denial in any repository with a manifest when the operator-only source is missing, tests for a manifest naming a different bot user id (no effect), a flag switched off or deleted with the source missing (deny), and a source missing in a repository with a manifest (deny), the pre-push default-branch refusal, and tests that deny on every API failure and on every denied form.
- The deployer's chain-of-custody recipe as a reusable check with its durable V record and the operator attestation step.
- Container packaging per the operator's container rules (hardened defaults, the service-account token as a secret file readable only by the key holder, never in a compose environment block), and the stage 2 healthcheck and monitoring alerts with no pull request text or identity terms in them. I6's rule that only the key holder's user can read the token file means phase A runs under a different user, which a single non-root container with all capabilities dropped cannot start, so stage 2 needs two containers or a separate helper. This and the next item belong to the separate stage 2 plan.
- The single-hub lock and the stage 1 to stage 2 cutover steps.

## Coordinator calls recorded here

Each is reversible and the coordinator took it as a default. The operator may overturn any of them.

- Hub topology, logged in `docs/decision-log.md`.
- Poll at five minutes rather than a webhook.
- Stage 1 stays coordinator-started, with no workstation scheduler.
- Skip the model, and post nothing, when a required check failed. Skip drafts, read from the API.
- Public-repository scans before posting. This repository is public, so the earlier call (no personal-terms scan of review bodies) no longer fits it. For any public enrolled repository, phase B runs the personal-terms scan and the runner's post-hoc readback checks before posting and refuses on a hit. Private repositories keep the declared-identity scan only (`identity.ts:226-239`). Flips for a private repository if it goes public or its review text is mirrored somewhere public.
- Merge only when the head is up to date with the default branch, which the deployer's tree check requires anyway.
- Squash or merge-commit merges only in enrolled repositories, so the deployer reads one first-parent commit per pull request. Logged in `docs/decision-log.md`. Flips if an enrolled repository needs rebase merges, in which case the deployer must group a pull request's rebased commits and check only the last against the head.
- The guard and the deployer take the App's bot user id from the harness pin or the hub's own config, never from a file in the reviewed repository. The enrolled list and read account come only from operator-only local config. The guard denies when the manifest's enrolled flag disagrees with that list, and denies outright in any repository with a manifest when that config is unavailable. A writer can push a repository file straight to the default branch on Free, so a repository-sourced id would let them repoint the gate. Logged in `docs/decision-log.md`. Flips if: never on Free. A protected default branch would make the manifest a reviewed file, but it would still be the wrong source of truth for the gate's identity.

## Open questions for the operator

A builder plans stage 1 now. Questions 1 and 4 gate stage 2, which is a separate plan written once they are answered. Questions 2 and 3 ship their defaults and block nothing.

1. Which model credential does the unattended hub use?
   - Where this came from: today the runner uses the operator's logged-in CLI session on the workstation. A container has no logged-in session, so it needs either a subscription token from `claude setup-token` or a Console API key. Anthropic documents the setup token for CI and scripts, and says subscription use assumes "ordinary, individual usage".
   - Recommend: A, the setup token stored once in the vault. Why: one copy, one subscriber, the subscriber's own repositories, which is the closest fit to individual use. The API-key advice on Anthropic's Actions page is about a secret copied across repositories, which the hub avoids.
   - A means: no new bill. The token lasts a year and is revoked from the account. A rotation reminder is needed.
   - B means: an API key in a workspace with a spend limit, billed per review (one `claude-opus-5-5` run at `xhigh`). Rotation never touches the subscription.
   - Flips if: Anthropic says this use falls outside individual subscription use, or subscription limits start blocking the operator's own sessions.
   - Blocks: the stage 2 plan. Stage 1 keeps the logged-in CLI.

2. Do private repositories get a second App without `contents: write`?
   - Where this came from: App permissions are set on the App, not per installation. The existing App holds `contents: write` because this public repository's ruleset counts its approval only when the installation can push (live 2026-09-14). On Free private repositories no ruleset exists, so that permission buys nothing there and only lets a leaked key push to them.
   - Recommend: A, a second App with `pull_requests: write`, `contents: read`, `checks: read`, `actions: read`, `issues: read` and `metadata: read` for private repositories. Why: it removes push from every private installation at the cost of one more key in the same vault.
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
   - Where this came from: jobbot request 4 asks for a container on the homelab, naming the storage server or a VM as candidates. The hub holds the App key in memory and its service-account token reads the whole reviewer vault, unrelated credentials included (Accepted residual), so a compromise of its host reaches all of them.
   - Recommend: A, a dedicated VM rather than the storage server. Why: a host compromise there exposes the vault's contents but not the storage server's data as well.
   - A means: one more VM to patch. Undo by moving the container.
   - B means: the container runs beside existing services on the storage server, sharing its blast radius on top of the vault's.
   - Flips if: the storage server already isolates containers to the operator's satisfaction.
   - Blocks: the stage 2 plan.

## Review findings not adopted

- Splitting the reviewer vault, moving unrelated credentials to their own vault and service account, or dropping the user-scope variable (security review, two findings). Declined by operator ruling, 2026-11-11. Recorded as the accepted residual instead.
- A merge-guard override through an operator-only token or a per-PR authorization (builder check). Declined by operator ruling, 2026-11-11: no override, the operator merges in the web UI.
- Listing the model credential among the things whose compromise equals compromise of the gate (security review). Declined: a stolen model credential spends budget but cannot produce an artifact phase B accepts, since the artifact comes from phase A's own process. Phase A, the CLI pin and the Bun pin are listed.
- Saying the coordinator never merges in an enrolled private repository on the strength of hub output (security review). Not adopted as worded, because the merge guard's live read of the App's review is the merge condition and hub output is never consulted. I7 covers the injection channel the finding names.
- Taking the reviewed base from a record only the hub writes, such as the hub store keyed by review id (security re-review, offered as the more durable option). Not adopted for now: the deployer would need a read channel into the hub's store, and the edit refusal, the API cross-check and the force-push check close the path the re-review found. Flips if an edit can be made that GraphQL does not report.
- Marking an operator session at the account layer so that only operator sessions deny on a missing source (security re-review). Superseded by a coordinator ruling that is stricter: any session denies in any repository with a manifest when the operator-only source is unavailable.
