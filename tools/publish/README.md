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
      "checkout": "<absolute path to a dedicated clone>"
    }
  }
}
```

Every field is validated and a missing one refuses. Values are never printed, because a value here is an identity, a secret reference or a machine path. Each owner entry names the git author and the gh account every command for that owner uses. The tool refuses when none is configured, and it never falls back to the active gh account or to git's own configuration.

The reviewer checkout's origin must be the repository. The tool fetches it, detaches it at the default branch head, and refuses when it is dirty.

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
3. The identity scan loads, with a declared name and the claude CLI's account email. Title, body and head branch carry no identifying string, session link or attribution line.
4. The closing keywords equal `--closes`, and an issue declares none. A pull request's title counts with its body, because a `--merge` merge commit carries the title and a keyword in any commit message reaching the default branch closes its issue.
5. gh is present and holds the configured account's token.
6. Closing keywords appear only on a pull request into the default branch.
7. Both branches exist on the remote (`pr create`), or the pull request's base is the `--base` given (`pr edit`).
8. The repository's template, if it has one, has every section filled.

## review-merge

`review-merge` waits for CI, runs the App reviewer, and merges only on what the merge rule allows. Its steps, in the order of the header of `tools/publish/review-merge.ts`:

1. The config names an owner identity. This tool's own checkout is clean and at its origin's default branch head, the bar the reviewer checkout meets in step 6, because the code that holds the token and makes the merge decision must be reviewed code too.
2. The config names a reviewer for the repository. With `--allow-admin`, the reason file reads and passes the same text gates as a body. The reviewer checkout holds `tools/pr-review/cli.ts`.
3. The pull request is open, not a draft, from this repository, and into the default branch. Its head is pinned here as the head to review.
4. Closing keywords in the title, the body and every commit message equal `--closes`. This runs early so a mismatch costs no model run.
5. `gh pr checks --watch` runs, bounded by `--checks-timeout-min`. Then every check must have succeeded on the pinned head, which must not have moved.
6. The reviewer checkout is fetched, detached at the default branch's current head, and must then be clean and at exactly that commit.
7. The reviewer runs from the work directory, outside every checkout, with the key piped from the configured key command, `--expect-head` pinned, `--post` and `--json`.
8. The pull request is read again, waiting out an `UNKNOWN` merge state, and the closing-keyword audit repeats. Then the merge rule rules.
9. For an administrator-bypass merge, the reason is posted as a pull request comment first. Then `gh pr merge` runs with `--match-head-commit`, and the merge is confirmed.

The merge rule, from the header of `tools/publish/merge-decision.ts`, is a pure function of the reviewer's `--json` output and the pull request's state. No prose is parsed. A pull request merges in one of two cases and no other:

- The App approved and the merge state is `CLEAN`. That is a plain merge.
- The App approved but the merge is `BLOCKED` (an owned path needs a code-owner review the operator cannot give), or the App could only `COMMENT` (it cannot vouch for CI edits). That is the administrator bypass, and only when `--allow-admin` was passed, the reviewer actually ran, no finding sits at or above the severity floor, and the event is not `REQUEST_CHANGES`.

Both also require the review to have been posted, every check to have succeeded, and the head to be the one reviewed. A severity the tool does not know counts as at or above the floor.

`--allow-admin` requires `--admin-reason-file`, and the reason is posted on the pull request before the bypass merge. `CONTRIBUTING.md` has every use of the bypass say why in the pull request, and automating the bypass without that would automate a breach of the process.

### Run it from a dedicated clone

`review-merge` runs only from a checkout that is clean, untracked files included, and at its origin's default branch head. That is the bar the reviewer checkout meets, and it applies here because this code holds the token and makes the merge decision. Keep a dedicated clone for it (`~/.claude-publish/tool` in the operator's setup, which doubles as the reviewer checkout) and bring it to the default branch head before each run:

```
git -C <clone> fetch origin <default branch>
git -C <clone> checkout --detach origin/<default branch>
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

The account layer denies raw `gh pr create`, `gh issue create` and `gh pr merge` in the Bash and PowerShell tools, so an agent reaches for this tool instead. The rule is a policy line rather than a boundary. Claude Code's permission docs (code.claude.com/docs/en/permissions) say a deny rule matches past a leading environment assignment and inside compound commands, but not the same program reached another way. `gh -R x pr create`, `gh api` and `sh -c` are not matched. The rule keeps the route honest. It does not stop a caller that is determined to go around it.
