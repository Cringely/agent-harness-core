# tools/publish

This is the route by which agents file issues, open and edit pull requests, and review and merge them (#274). Every command runs a fixed list of gates and fails closed: a missing dependency, a missing config field or an unreadable input refuses rather than skips. It is repository tooling like `tools/pr-review/`, which it reuses for the identity matcher, the severity lists and the checkout-state probe. It is not part of core, and nothing under `install/` copies it.

## Running it

```
bun --cwd <home>/.claude-publish/work <absolute path>/tools/publish/cli.ts <command> ...
```

The `--cwd` is not optional. Bun loads `bunfig.toml` and `.env` files from the working directory before any code runs, and this process holds a GitHub token and, for `review-merge`, streams the reviewer App's key. Measured on Bun 1.3.14 on 2026-10-06, a `bunfig.toml` preload and a `.env` in the launch directory both stayed unloaded under `bun --cwd <other dir>`, so `--cwd` moves the load to the work directory. `tools/pr-review/cli.ts` carries the same rule (BUN-CWD) and meets it with a shell `cd`. The flag does the same job without one, which lets a single plain command run from an isolated worktree.

The work directory must be empty and outside every git work tree. The tool refuses to run from anywhere else, and refuses when the directory holds a `bunfig.toml` or a `.env*` file.

## Setup

Local configuration lives in `~/.claude-publish/config.json`, outside every repository. Placeholders only:

```json
{
  "owners": {
    "<owner>": { "gitName": "...", "gitEmail": "...", "ghUser": "..." }
  },
  "reviewers": {
    "<owner>/<name>": {
      "appId": "<numeric App ID>",
      "keyCommand": ["pwsh", "-NoProfile", "-File", "<absolute path>/read-reviewer-key.ps1"],
      "keyCommandEnv": { "OP_BIOMETRIC_UNLOCK_ENABLED": "false" },
      "checkout": "<absolute path to a dedicated clone of agent-harness-core>",
      "termsFile": "<absolute path to the personal-term list, outside every checkout>"
    }
  }
}
```

Every field is validated and a missing one refuses. Values are never printed, because a value here is an identity, a secret reference or a machine path. Each owner entry names the git author and the gh account every command for that owner uses. The tool refuses when none is configured, and it never falls back to the active gh account or to git's own configuration.

The reviewer checkout must be a clone of agent-harness-core, the repository this tool comes from, never of the repository under review, whichever repository the entry is for. The reviewer reads the App's key and `premerge` runs with the owner's token, so a clone of the reviewed repository would hand both to whatever anyone who can write to its default branch had put there. `review-merge` never fetches or moves this checkout. It refuses unless the checkout is clean and at exactly `--tool-head`, the pin described under "Run it from a dedicated clone".

`termsFile` is the personal-term list `premerge` reads (`tools/pr-review/README.md`, "Premerge hygiene check"), usually the file the local git config `harness.personalTermsFile` names. `review-merge` runs `premerge` before every merge, so a reviewer entry without it refuses.

`review-merge` serves only agent-harness-core for now. `tools/pr-review/cli.ts` reviews any other repository only with `--policy` (#318), and a reviewer entry here has no field to name that policy file, so a reviewer configured for another repository refuses and nothing merges. That refusal comes from agent-harness-core's own `cli.ts` at the pin, never from code in the other repository.

### The key command

The key command fetches its own credential. The config file is plain text, so `keyCommandEnv` carries only non-secret settings, and the tool refuses a variable whose name contains TOKEN, SECRET, KEY or PASSWORD.

Where the key sits behind a 1Password service account, `op` reads that account's token from `OP_SERVICE_ACCOUNT_TOKEN`. The key command is then a wrapper script, kept outside every repository, that decrypts the token into its own environment and runs `op read`. The token exists only in that process and its `op` child. The Windows form, placeholders only, with the token saved once by `Read-Host -AsSecureString | Export-Clixml <token file>` (DPAPI, readable only by the same user on the same machine):

```powershell
$ErrorActionPreference = 'Stop'
$secure = Import-Clixml '<absolute path to the token file>'
$env:OP_SERVICE_ACCOUNT_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
op read '<secret reference>'
exit $LASTEXITCODE
```

## Commands

```
issue create  --repo <owner/name> --title <t> --body-file <abs path> [--template <file.md>]
issue edit    --repo <owner/name> --issue <n> [--title <t>] [--body-file <abs path> [--template <file.md>]]
pr create     --repo <owner/name> --base <branch> --head <branch> --title <t> --body-file <abs path> [--closes <n,n>] [--draft]
pr edit       --repo <owner/name> --pr <n> --base <branch> [--title <t>] [--body-file <abs path> [--closes <n,n>]]
review-merge  --repo <owner/name> --pr <n> [--closes <n,n>] [--allow-admin --admin-reason-file <abs path>] [--method merge|rebase] [--checks-timeout-min <1-180>]
```

Each line follows the `bun --cwd <home>/.claude-publish/work <absolute path>/tools/publish/cli.ts` prefix. `USAGE` in `tools/publish/cli.ts` is the source, and `help` prints it. A body comes only from a file, never from an argument or stdin.

Exit codes:

- **0** means done.
- **2** means refused, with nothing new published. The message names a class of problem and never the text that tripped it.
- **1** means a usage or runtime error.

A `review-merge` refusal that follows its `review:` line means the App's review was posted and nothing merged.

## Create and edit gates

`issue create`, `issue edit`, `pr create` and `pr edit` run these gates in this order, cheapest and most local first, and call gh to publish only after every one has passed. The order is the one in the header of `tools/publish/publish.ts`.

1. The body file reads and is not empty.
2. The config names an identity for the repository's owner.
3. The identity scan loads, with a declared name and the claude CLI's account email. Title, body and head branch carry no identifying string, session link or attribution line, and no replacement character or control character other than tab, line feed and carriage return. A body file is read as UTF-8, so a UTF-16 file (what Windows PowerShell 5.1 writes with `>` and `Out-File`) is refused rather than scanned as text no pattern matches. Save bodies as UTF-8.
4. The closing keywords equal `--closes`, and an issue declares none. A pull request's title counts with its body, because a `--merge` merge commit carries the title and a keyword in any commit message reaching the default branch closes its issue.
5. gh is present and holds the configured account's token.
6. Closing keywords appear only on a pull request into the default branch.
7. Both branches exist on the remote (`pr create`), or the pull request's base is the `--base` given (`pr edit`).
8. The repository's template, if it has one, has every section filled.

## review-merge

`review-merge` waits for CI, runs the App reviewer, and merges only on what the merge rule allows. Its steps, in the order of the header of `tools/publish/review-merge.ts`:

1. The config names an owner identity. This tool's own checkout is clean, cloned from agent-harness-core (a fork's origin refuses, since a fork's default branch is not reviewed code), and at `--tool-head`, and `--tool-head` is agent-harness-core's default branch head, because the code that holds the token and makes the merge decision must be reviewed code.
2. The config names a reviewer for the repository. With `--allow-admin`, the reason file reads and passes the same text gates as a body. The reviewer checkout holds `tools/pr-review/cli.ts`.
3. The pull request is open, not a draft, from this repository, and into the default branch. Its head is pinned here as the head to review.
4. Closing keywords in the title, the body and every commit message equal `--closes`. This runs early so a mismatch costs no model run.
5. `gh pr checks --watch` runs, bounded by `--checks-timeout-min`. Then every check must have succeeded on the pinned head, which must not have moved.
6. The reviewer checkout must be cloned from agent-harness-core, never from the repository under review, and be clean and at exactly `--tool-head`. It is never fetched or moved here.
7. The reviewer runs from the work directory, outside every checkout, with the key piped from the configured key command, `--expect-head` pinned, `--post` and `--json`.
8. The pull request is read again, waiting out an `UNKNOWN` merge state, and the closing-keyword audit repeats. With `--allow-admin`, what the bypass needs is read next: `.github/CODEOWNERS` at the default branch head (the base, never the pull request's head, which the pull request could edit), the whole changed-file list, the pull request's reviews, and the default branch's active rules. Then the merge rule rules.
9. `premerge` runs from the reviewer checkout on the pinned head, with `--closes`, the owner identity and the configured `termsFile`, and must print `PREMERGE OK` for this pull request and head. It checks what the diff does not carry: closing references GitHub links outside the text, every commit's author and committer, and personal terms in commit messages, title and body. Its channel lines are logged. CONTRIBUTING.md requires it for a bypass merge, and it runs before every merge here.
10. For an administrator-bypass merge, the reason is posted as a pull request comment first. Then `gh pr merge` runs with `--match-head-commit`, and the merge is confirmed.

The merge rule, from the header of `tools/publish/merge-decision.ts`, is a pure function of the reviewer's `--json` output and the pull request's state, which under `--allow-admin` includes CODEOWNERS at the base commit, the changed files, the reviews and the base branch's rules. No model prose is parsed. A pull request merges only on the App's `APPROVE` with passing verification, in one of two cases and no other:

- The merge state is `CLEAN`. That is a plain merge.
- The merge is `BLOCKED` and the block is shown to be the code-owner review the operator cannot give. That is the administrator bypass, and only when `--allow-admin` was passed.

`BLOCKED` alone does not show that. The bypass skips every rule in the default ruleset, and GitHub reports no list of the rules an open pull request leaves unmet. Its `reviewDecision` reads `REVIEW_REQUIRED` both for a missing code-owner review and for an approval it does not count, and its rule-suite records cover pushes, not an open pull request. So the bypass needs all of these, each read rather than inferred:

- At least one changed file owned under `.github/CODEOWNERS` at the base commit. The tool reads CODEOWNERS (`tools/publish/codeowners.ts`) with GitHub's rules for the one form this repository uses: a pattern anchored with a leading `/`, made of literal path characters, with an optional trailing `/` for a directory, the last matching line winning and a line with no owners leaving its paths unowned. A wildcard, a negation, an escape, a character range, an unanchored pattern, or an owner that is not `@user`, `@org/team` or an email refuses the bypass rather than matching nothing.
- The App's approval of the reviewed head as the latest submitted review, and no reviewer whose latest review, comments and pending reviews aside, requests changes. A review that approves, dismisses or requests changes with no author login (a deleted account) refuses, since reviews are grouped by author.
- Every active rule on the default branch, from GitHub's rules-for-a-branch endpoint and from its classic branch protection, shown met apart from the code-owner review, which a `pull_request` rule or the classic review settings must require. GitHub's "Branch not protected" 404 means no classic protection, and any other failure reading it refuses. `non_fast_forward` and `deletion` are push protections a merge cannot break. A `required_status_checks` rule is met when each check it names succeeded on the head and no check of that name did anything else. A check that names an app needs a run from that app, read from the head's check runs, and refuses when any run of that name has no readable app id. Requiring the branch to be up to date also refuses. Classic protection refuses when linear history, conversation resolution, a locked branch, signed commits or push restrictions are on. A `pull_request` rule is met when enough reviewers with push access (GraphQL's `authorCanPushToRepository`) approved the head as their latest opinion and the merge method is allowed, with last-push approval, thread resolution, named reviewers and the extra approval for unattributed changes all off. Any other rule type, parameter or shape refuses.

A missing CODEOWNERS, a changed-file list or check-run list shorter than GitHub's count (the files endpoint stops at 3000), and any read that fails refuse as well. A refused bypass is left to the operator, who merges by hand with a bypass-rationale comment.

As read on 2026-11-13, this repository's default branch carries `code_quality`, `code_scanning` and `copilot_code_review` rules, and a `pull_request` rule with last-push approval and the extra approval for unattributed changes on. The tool checks none of those, so it refuses every bypass here until the rulesets or the checks change, and the operator merges owned-path pull requests by hand.

Both also require the review to have been posted, the reviewer to have actually run, no finding at or above the severity floor, every check to have succeeded, and the head to be the one reviewed. A severity the tool does not know counts as at or above the floor.

A `COMMENT` never merges, whatever its verification reasons, the ones CI cannot vouch for by design included (an edit to CI definitions or to the secret scan configuration, a `.ps1` file whose suite CI does not run, a changed-file listing the reviewer could not read whole). `CONTRIBUTING.md` allows the administrator bypass on the App's `APPROVE` plus a passing `premerge`, and calls any other bypass an operator override. The tool refuses and says so, and the operator merges that pull request by hand with a bypass-rationale comment.

`--allow-admin` requires `--admin-reason-file`, and the reason is posted on the pull request before the bypass merge on an `APPROVE`. `CONTRIBUTING.md` has every use of the bypass say why in the pull request, and automating the bypass without that would automate a breach of the process.

### Run it from a dedicated clone

`review-merge` runs only from a clone of agent-harness-core that is clean, untracked files included, and at `--tool-head`, a full 40-character commit id that must be agent-harness-core's default branch head. The reviewer checkout meets the same bar at the same pin, because the reviewer gets the App's key and `premerge` the owner's token. There is no default pin, and a missing or malformed one is a usage error. Keep a dedicated clone for it (`~/.claude-publish/tool` in the operator's setup, which doubles as the reviewer checkout), bring it to the default branch head before each run, and pass the commit it now holds:

```
git -C <clone> fetch origin <default branch>
git -C <clone> checkout --detach origin/<default branch>
git -C <clone> rev-parse HEAD
```

### Run it in the background

`review-merge` is a long run. It waits up to `--checks-timeout-min` (30 by default) for checks, then up to 45 minutes for the reviewer, well past a tool shell's foreground limit (10 minutes in Claude Code's Bash tool). Run it in the background with stdout and stderr redirected to a log file and an exit line appended after it:

```
<command> > <log> 2>&1; echo "exit=$?" >> <log>
```

Then poll the log with a bounded wait until the exit line appears. Do not wait on the background task's completion notice instead. It reports on the shell that started the run, not on the work, and a dispatched agent is not woken by it.

## Limits

- Forks are refused.
- Closing keywords inside code spans and fences count.
- A pull request with more commits than GitHub's commits endpoint returns (250) is refused, since an unread commit message could still close an issue.
- Only a `SUCCESS` conclusion counts as a passing check. `SKIPPED` and `NEUTRAL` block.
- Issue forms (`.yml`) are not supported. `--template` names a Markdown file.
- A body line opening with "Generated with", after any punctuation or emoji, is refused. A legitimate line that opens that way is refused too. Mid-sentence prose passes.

## The permission rule

`install/Install-Harness.ps1` merges a deny of raw `gh pr create`, `gh issue create`, `gh pr merge` and `gh alias set` in the Bash and PowerShell tools, plus the forms with a flag between the group and the subcommand (`gh pr --repo x merge 5`), into each installed project's `.claude/settings.json`, from `core/claude/templates/settings.permissions.json`, so an agent reaches for this tool instead. The rule is project-scoped: nothing puts it in the account's own settings, so a repository without the harness keeps raw gh. The installer adds the rules to whatever the project already denies and refuses, before it writes anything, when that fragment is unreadable or empty or the project's permissions block is not shaped to take them. It also installs the `publish` skill, which points agents at this tool, under `.claude/skills/publish/`.

A project can opt out of the canonical merge rule only, so its coordinator can run `gh pr merge <n> --admin --match-head-commit <sha>` on a pull request the App approved (operator ruling 2026-11-14). The opt-in is a key in the project's committed `.claude/.harness-manifest.json`, with a sentence saying what the project accepts:

```json
"allowRawPrMerge": { "risk": "<what an agent shell that can run raw gh pr merge here could do>" }
```

The next install then leaves out `Bash(gh pr merge *)` and `PowerShell(gh pr merge *)`, removes them from the project's deny list whoever added them, and prints the risk sentence. Nothing else changes: the flag-first merge rules (`gh pr * merge *`), the create rules and `gh alias set` stay denied, so `gh pr --repo x merge 5` is still refused there. Deleting the key restores both rules on the next install. Claude Code's deny rules match by prefix and one cannot carve an exception out of a broader one, so the opt-in drops the two rules whole: an opted-in agent shell can run any `gh pr merge` form that starts with the subcommand, not only the `--admin --match-head-commit` one. Without the key every install denies them. A key that is not an object with a non-empty string `risk`, or one recorded when the fragment no longer holds both rules, refuses the install before it writes. The opt-in does not change `review-merge`, whose own merge rule and `--allow-admin` checks are as above.

The deny list is a tripwire against the common direct forms, not a boundary. Claude Code's permission docs (code.claude.com/docs/en/permissions) say a Bash rule matches the command text after compound commands are split and a fixed set of wrappers is stripped, and that a deny rule "isn't a security boundary around the program". Known bypasses remain:

- `gh api` writes. The list does not deny `gh api`, because agents use it for reads.
- The edit and comment subcommands: `gh pr edit`, `gh pr comment`, `gh pr review`, `gh issue edit` and `gh issue comment`.
- Shell wrappers such as `bash -c`, `pwsh -c` and `env`, which the rules cannot see inside.

The gates that enforce the route are this tool's own refusals and the repository's merge rules, the App review and the CI ruleset. Text published by a route that skips the tool meets none of the tool's refusals.
