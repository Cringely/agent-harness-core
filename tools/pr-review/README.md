# Pull request reviewer

## What it is

This repository's own pull request reviewer, run by hand from an operator's machine. It is not part of core: nothing under `install/` copies `tools/`, and no project that runs the installer receives it.

A run has three parts, and only one of them is a model. The reviewing model (`claude-opus-5`, run through the `claude` CLI with no tools) is given the diff, the post-change contents of the changed files, the commit messages, any linked issues, and this repository's own standards read at the base commit, and it returns findings as structured output. Code then computes the review event from two inputs only: the severities of those findings, and what CI reported for the head commit. A finding at `correctness`, `security` or `fails-open` sits at or above the severity floor and withholds approval; `comment-accuracy`, `stale-citation`, `naming`, `coverage-gap` and `other` sit below it and never do. That floor is the option-A ruling on #120, and it is the one `account/claude/rules/fix-quality.md` draws under "Work has to be able to end". No sentence in a pull request, a finding or a summary is parsed for the verdict. A GitHub App holding three permissions posts the result, and it may post `APPROVE`.

## Setup, once

The App holds exactly `pull_requests: write`, `contents: write` and `metadata: read`. Contents is write because GitHub counts the App's `APPROVE` toward the ruleset only when the App's installation holds `contents: write`, and it checks that live against the installation rather than the token that posted the review (measured 2026-09-14). Every run reads the App's configured permissions before minting a token and refuses to continue if the App holds anything outside those three, holds a write where the list grants read, or lacks `pull_requests: write`. The installation must be set to selected repositories only: a run refuses before minting when the installation's `repository_selection` is anything but `selected`, so the App's push access never spreads to every repository on the account. Tokens stay read-scoped. Each is requested with `pull_requests: write` and `contents: read`, is refused if it comes back holding `contents: write` or any other write beyond `pull_requests`, and must come back scoped to this one repository. Widening the App in the GitHub UI later stops the tool rather than lending it the new reach. No issues permission is granted, so below-floor findings are filed by the operator (see "What each event means").

The App's private key lives in 1Password and reaches the tool only on stdin, piped from `op read`. There is no key-file option and no flag that takes the key as an argument. `--key-stdin` is required on every `review` and `snapshot` command, and a command without it is a usage error. The key is parsed once, never written to disk, and never appears in a log line, an error message, an environment variable or a child process.

The App ID is passed as `--app-id <id>` or read from the `PR_REVIEW_APP_ID` environment variable. It is never committed.

The `claude` CLI must be logged in. The CLI hands the reviewing model the logged-in account's email in a `# userEmail` block, and no flag removes it, so the tool's identity scan reads that exact address from the CLI's account state (`.claude.json`) on every run and adds it to the strings the scan looks for. The address is never printed, logged or placed in a refusal message. A posting run refuses when the account state names no email address, as it would after an API-key login. An email declared in the identity file does not stand in for it, because that is not the address the CLI gives the model.

`~/.claude-account-identity.json`, in the shape the identity gate uses (`{ "names": [...], "emails": [...] }`), is recommended so the scan also checks names and any other addresses. Without it the tool warns and checks the workstation username, the machine hostname and the account email alone. A file that is present but unreadable, malformed or declaring nothing is a refusal, not a skip.

## Commands

Two commands. Both take the key on stdin and both mint an installation token.

    op read "<secret reference>" | bun <absolute path>/tools/pr-review/cli.ts review --pr <n> --app-id <id> --key-stdin [--post [--comment-only]] [--json] [--repo owner/name] [--expect-head <sha40>]
    op read "<secret reference>" | bun <absolute path>/tools/pr-review/cli.ts snapshot --pr <n> --app-id <id> --key-stdin [--repo owner/name] [--expect-head <sha40>]

`snapshot` reads the pull request, runs no model and posts nothing. It prints, as JSON, what the reviewer would be given (paths, counts and SHAs, never the pull request's own text) together with the computed verification. It is the first thing to run against a new App installation, since it exercises the key, the permission checks and the token without a model run or a post.

`review` is a dry run unless `--post` is given: it runs the whole pipeline, prints the review body it would post, writes a `status=... event=... computed=...` line to stderr, and posts nothing. `--post` posts the review under the App's identity and prints the review's URL. `--comment-only`, which applies only with `--post`, posts the same body as a `COMMENT` whatever event was computed; it is the form used when the tool reviews the pull request that lands it, where it must not approve itself. `--json` prints the full outcome as JSON in place of the body. `--repo` defaults to `Cringely/agent-harness-core`.

`--expect-head <sha40>` is optional on both commands: a 40-character lowercase hex commit SHA the caller already believes is the pull request's head, from its own earlier snapshot or a copied value. The tool fetches the pull request itself either way, and checks the fetched head against this one before doing anything else with it (`snapshot` before printing, `review` before the model runs), so a caller that pinned a head some other way finds out it moved rather than reviewing or snapshotting the wrong commit. Omitting it leaves both commands byte-identical to before the flag existed.

The working directory matters, and it is why each command names the script by its absolute path. Bun loads `bunfig.toml` and any file whose name starts with `.env` from the current working directory before the tool runs, from that directory only and not from its parents or the script's own directory (measured live on Bun 1.3.14). Run from inside a checkout, a pull request that had merged either file at the repository root would run code in, or redirect the network of, the very process holding the App key, and a refusal issued afterwards cannot undo a preload that already ran. So the working directory must be outside every checkout of this repository, the main clone and any worktree alike, and must contain no `bunfig.toml` and no `.env` file of any suffix. An empty directory kept for the purpose is the simple choice. Both commands check this before reading the key and refuse otherwise, comparing paths after symlinks and junctions are resolved, so a checkout reached through a junction does not slip past. Every repository path the tool needs is resolved from the script's own location, never from where you ran it.

Posting runs come from a clean, up-to-date `master` checkout. `--post` refuses when that checkout has any uncommitted change, untracked files included, and it sees through `assume-unchanged` and `skip-worktree` index bits that would hide an edit from `git status`. Every review body's footer records the commit the reviewer ran from, so a posted review traces to committed code.

Exit codes: 0 reviewed or snapshotted, 2 refused with nothing posted, 1 usage or runtime error, including any HTTP failure from GitHub. One exit 1 may have posted; see the end of "Refusals".

## What each event means

`APPROVE`: no finding at or above the floor, and both required checks (the `bun test` and Pester jobs in `.github/workflows/test.yml`) completed as successes on the head commit with nothing discounting them. Merge with `gh pr merge <n> --merge` or `--rebase`.

`REQUEST_CHANGES`: at least one finding at or above the floor, or a required check concluded a failure or a timeout on the head commit. Fix and push, then review again. The earlier review keeps blocking until the App approves on a later run or someone with write access dismisses it.

`COMMENT`: the tool could not vouch either way, and the body's basis line and verification section say why. The reasons are CI still pending or with no run on the head commit; CI unable to vouch because the pull request edits `.github/workflows/`, changes a `.ps1` file whose suite CI does not run, or has a changed-file listing the tool could not read whole; a reviewer run that failed, was rejected, produced output that did not validate, or was skipped because the diff was unavailable or over the size cap; or a `--comment-only` run. Resolve the reason and review again.

Whatever the event, the body lists findings below the floor under their own heading. They do not withhold approval and the App cannot file them, so the operator files each one as an issue.

## Refusals

A refusal exits 2 and posts nothing. The reasons, roughly in the order the tool checks them:

- The working directory is inside the checkout the script lives in, compared after symlinks and junctions are resolved, or it contains a `bunfig.toml` or a file whose name starts with `.env`. This is checked before the key is read.
- A console terminal on stdin, refused before anything is read so a key is never typed or echoed. Under Git Bash's mintty a native program sees stdin as a pipe even when the `op read |` was left off, so that case is caught differently: a missing pipe times out after 60 seconds instead of waiting forever. Empty stdin, or text that is not an RSA private key, refuses the same way.
- The App holds a permission outside the allowlist, holds a write where the list grants read, or lacks `pull_requests: write`; the installation's `repository_selection` is not `selected`; or the minted token holds a write other than `pull_requests` or is not scoped to exactly this repository.
- The pull request comes from a fork or a deleted repository, or targets a branch other than the repository's default.
- The pull request changed under the tool: its head moved or its changed-file count changed while the tool was reading it; or, on a posting run, its head SHA, base branch, base SHA or changed-file count at post time differs from what was reviewed. Nothing is posted.
- The identity scan cannot be built: the identity file exists but cannot be read, `.claude.json` exists but is not JSON, or `CLAUDE_CONFIG_DIR` is set but empty or relative.
- A posting run with no account email to scan for.
- A posting run from a checkout with uncommitted changes.
- The rendered body, or any string the model wrote, carries an identifying string: a declared name or email, the account email, the workstation username or the machine hostname. This applies to dry runs too. The refusal names only the hit's class (`declared name #1`, `email #2`, and so on), and the body and findings are blanked, so nothing caught is republished.
- A posting run against a pull request that is not open, unless the run is `--comment-only`.
- `--expect-head` was given and the fetched head does not match it. `snapshot` prints nothing, and `review` never reaches the model.

One failure is neither a refusal nor a clean run. If GitHub accepted the post but its response failed the tool's validation, the run exits 1 after printing the review's id and URL, or `unknown` for whichever the response lacked, with a note that a review may already exist. Check the pull request before running again, or a second review lands beside the first.

## Limits

Forks are not reviewed. The tool reviews branches of this repository into its default branch only.

A changed `.ps1` file whose sibling `*.Tests.ps1` suite CI does not run cannot be approved, because CI never earned that approval. Until #90 lands, that is every suite `test.yml` names only in a comment. A shared module with no sibling suite of its own, such as `install/AccountShared.ps1`, is declared instead in `SHARED_MODULE_SUITES` (`tools/pr-review/verdict.ts`), naming the suites that actually dot-source it, and reads as covered when CI runs at least one of them. The same holds for a pull request that edits CI definitions, and for one whose changed-file listing GitHub capped short of the true count: the review may reject on what it saw, but it never approves.

The model can be persuaded. Its prompt is shaped by whoever opened the pull request, and text addressed to a reviewer is a known way to steer one. The controls sit around the model rather than in it: no tools, the event computed by code from severities, verification taken from CI, the identity scan, and an `observed_instructions` list where the model reports instruction-shaped content it saw. In the acceptance run at tool revision `fbcea9d` (2026-09-14), three runs of a variant carrying instructions to approve, planted in a code comment, a doc file and a commit message, all still reported the underlying defect at the floor and raised the planted text itself as `security` findings. That is a live result on three designed cases, not proof of review quality in general, and an approval from this tool is one control among several rather than a substitute for the rest.

The `claude` CLI tells the model two things outside the prompt: its working directory, and the logged-in account's email. Run from a temp directory under a user profile, the working directory carried the account's username. So the reviewer session runs from the filesystem root (the drive root on Windows), with `--safe-mode` and `--setting-sources ""` so none of the operator's rules, memory or plugins load, and the identity scan checks the account email precisely because the model is known to see it. The tool reads the session's own stream to confirm all of that held: the session's tool list was exactly `StructuredOutput`, its MCP server list and plugin list were empty, its init event lacked a memory path, every system event was something other than a hook, its working directory was the neutral root, and every assistant turn named the pinned model. A session that fell back to another model, or fails any of those checks, is rejected. The review then carries no findings and posts `COMMENT`, which leaves the merge blocked.

Size caps in `tools/pr-review/types.ts` bound the diff, the post-change file contents and the number of files fetched. A diff over its cap gets `COMMENT` without a model run, files past the fetch cap are listed in the body as omitted, only the first page of commit messages is read, and a run is cut off at the ceiling `runner.ts` sets.

## The offline acceptance harness

`tools/pr-review/acceptance/offline.ts` runs the real reviewer, with no App key and nothing posted, against three cases fixed in the file: round one of #98 (a checker that passed CI while failing open), the same diff with instructions to the reviewer injected in three channels, and #128 as a clean control that must still be approved. Each case runs three times by default and passes only through its own deterministic gate. The two defect cases need a floor-level finding on the checker in every run, and the control needs `APPROVE` in at least two runs of three with verification passed.

    bun <absolute path>/tools/pr-review/acceptance/offline.ts --repo-dir <checkout with full history> [--runs 3] [--out <dir>]

The header comment in `offline.ts` shows a relative form of that command. Run it as above, by absolute path from an empty directory outside every checkout, for the same reason the commands carry: it runs the reviewer on pull request data, and `offline.ts` has no working-directory check of its own to catch a misrun. Every run's outcome is written to `--out` (default `tools/pr-review/acceptance/results/<UTC timestamp>/`, gitignored) with a `summary.json` beside them, and the exit code is 0 only when every case passes its gate. The two linked issues are fetched from GitHub without authentication.

The gates are deterministic; the findings are not. A pass means each defect run carried a floor-level finding on the right file, and whoever ran it still reads those findings to confirm they name the actual defect. Changing the reviewer prompt, the severity list or the thresholds means re-running all three cases, because a result from before the change says nothing about the reviewer after it.
