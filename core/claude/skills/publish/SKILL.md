---
name: publish
description: Use before filing a GitHub issue, opening or editing a pull request, or merging one. Every publish goes through tools/publish in agent-harness-core, which refuses identifying strings, session links, attribution lines and undeclared closing keywords. Carries the pull request and issue body shapes and the rule for when an issue gets filed.
---

# Publish

Every issue, pull request and merge goes through `tools/publish/cli.ts` in agent-harness-core. The installer from agent-harness-core merges permission rules into this project's `.claude/settings.json` that deny raw `gh pr create`, `gh issue create`, `gh pr merge` and `gh alias set`, including the forms with a flag such as `--repo` between the group and the subcommand. A project whose `.claude/.harness-manifest.json` records `allowRawPrMerge` leaves out the canonical `gh pr merge` rule only, so the coordinator can run `gh pr merge <n> --admin --match-head-commit <sha>` on a pull request the App approved. It is for a head whose latest App review is APPROVE, never for a COMMENT or REQUEST_CHANGES, and only where the operator recorded the opt-in. Those rules are a tripwire against the common direct forms, not a boundary. Known routes still get past them: `gh api` writes, the edit and comment subcommands (`gh pr edit`, `gh pr comment`, `gh pr review`, `gh issue edit`, `gh issue comment`), and shell wrappers such as `bash -c`, `pwsh -c` and `env`. Taking any of those routes breaks the policy even when the shell lets the command through. What actually enforces the route is the publish tool's own refusals and the repository's merge rules, the App review and the CI ruleset.

## Running it

The tool holds a GitHub token and, for review-merge, streams the reviewer App's key. It runs only from its own work directory, named with `bun --cwd`, which must hold no `bunfig.toml` or `.env` file, and refuses anywhere else.

The tool lives in the agent-harness-core checkout this project was installed from, the `coreRepo` value in `.claude/.harness-manifest.local.json`. A project can write that file, so never run code from the path it names directly. Resolve it first with the helper beside this skill, with `<project>` the absolute path of this project's root:

Bash:

    bun --cwd "${USERPROFILE:-$HOME}/.claude-publish/work" "<project>/.claude/skills/publish/resolve-core.ts" "<project>"

PowerShell:

    bun --cwd "$HOME/.claude-publish/work" "<project>/.claude/skills/publish/resolve-core.ts" "<project>"

It prints the absolute path of `tools/publish/cli.ts` only when the real path of `coreRepo` (links and junctions followed) is outside this project and listed in the per-user checkout allowlist, `~/.claude/harness-core-checkouts`, which the installer appends to. No environment variable moves that list for this helper, and a relative, UNC or device-path `coreRepo` is refused. Otherwise it prints nothing on stdout, a reason on stderr, and exits 1. On any exit but 0, or empty output, stop and ask the operator. Never fall back to the raw `coreRepo` value or to a path you guess. `<cli>` below is the path it printed:

Bash:

    bun --cwd "${USERPROFILE:-$HOME}/.claude-publish/work" "<cli>" <command> ...

PowerShell:

    bun --cwd "$HOME/.claude-publish/work" "<cli>" <command> ...

Commands:

    issue create  --repo <owner/name> --title <t> --body-file <abs path>
    issue edit    --repo <owner/name> --issue <n> [--title <t>] [--body-file <abs path>]
    pr create     --repo <owner/name> --base <branch> --head <branch> --title <t> --body-file <abs path> [--closes <n,n>] [--draft]
    pr edit       --repo <owner/name> --pr <n> --base <branch> [--title <t>] [--body-file <abs path> [--closes <n,n>]]
    review-merge  --repo <owner/name> --pr <n> --tool-head <commit> [--closes <n,n>] [--allow-admin --admin-reason-file <abs path>] [--method merge|rebase] [--checks-timeout-min <1-180>]

Write every body to a file in your scratchpad first and pass its absolute path. There is no inline body option. Push the head branch before `pr create`, because the tool never pushes.

review-merge serves agent-harness-core, and any other repository whose reviewer entry in the operator's publish config names a `policyFile`. Without one it refuses before anything runs, so ask the operator how to merge there.

review-merge runs from the dedicated clone at `~/.claude-publish/tool` instead, which also serves as its reviewer checkout. It refuses unless that clone is clean and at `--tool-head`, and `--tool-head` is agent-harness-core's default branch head, because that code holds the token and the App key and makes the merge decision. It can also run for over an hour: up to `--checks-timeout-min` (30 by default) for checks, then up to 45 minutes for the reviewer, past a tool shell's 10-minute foreground limit. So bring the clone up to date, start the run in the background with its output in a log file in your scratchpad, and poll that log with a bounded wait until its `exit=` line appears. In Bash, each line its own command, with `<n>` the pull request number:

    git -C "${USERPROFILE:-$HOME}/.claude-publish/tool" fetch --quiet origin master
    git -C "${USERPROFILE:-$HOME}/.claude-publish/tool" checkout --quiet --detach origin/master
    git -C "${USERPROFILE:-$HOME}/.claude-publish/tool" rev-parse HEAD
    bun --cwd "${USERPROFILE:-$HOME}/.claude-publish/work" "${USERPROFILE:-$HOME}/.claude-publish/tool/tools/publish/cli.ts" review-merge --repo <owner/name> --pr <n> --tool-head <commit> ... > <scratchpad>/review-merge-<n>.log 2>&1; echo "exit=$?" >> <scratchpad>/review-merge-<n>.log

Pass the full commit id the third line printed as `--tool-head`. Start the fourth line with the shell tool's background option, and never wait on that option's completion notice: it reports on the shell, and a dispatched agent is not woken by it. Read the log's last lines once the `exit=` line is there.

## Exit codes

- 0: done. The last line on stdout is the URL or the merge result.
- 2: refused, and nothing new was published. The message names the class of problem, such as `body: Co-Authored-By line` or `closing keywords do not match --closes (undeclared: 1, missing: 0)`, and never the text that tripped it. Fix the body or the arguments and run again. Never disguise a name or a link to get it past a gate, since a disguised one still publishes it.
- 1: a usage error, or a dependency failed partway. The message says which step may already have happened.
- 4: review-merge stopped, by a refusal or an error, after it had already written to GitHub. The message opens with `already written to GitHub:` and lists what it wrote (the App review, the bypass reason comment, the merge), then the cause. Look at the pull request before running again. When the merge is on the list, it happened: report it to the operator, and when the cause says GitHub links it to close issues other than `--closes`, reopen any issue it should not have closed.

Once the reviewer has run and has not refused, every review-merge stop exits 4, because the App's review may already be posted. That includes a reviewer that failed or ran out of time and reviewer output the tool cannot read.

## Closing keywords

`--closes` lists exactly the issues the merge closes, and the body carries `Closes #<n>` for each one. Every keyword in the body, and for review-merge in every commit message, has to be declared, and every declared issue has to be closed by one. GitHub acts on keywords only on a pull request into the default branch, so the tool refuses them on any other base. A keyword in prose counts too, inside backticks included. Write "issue 12" rather than "fixes #12" to mention an issue without closing it.

## Pull request body

The shape follows the scannable-structure row of writing-style.md: an opening sentence or two, then bold labels, each over a real bulleted list.

    <One or two sentences: what the change is and which part matters most.>

    **<Area, in the order a reader walks the diff>**
    - <One or two sentences per claim, linked to the diff where that helps.>

    **Testing**
    - <The command that ran and what it reported.>

    **Known gaps**
    - <What is still unproven or uncovered, or "None known.">

    Closes #<n>
    Docs: README still accurate: <what was checked>

The `Closes` line appears only with a matching `--closes`. In agent-harness-core the Docs line is required, in one of the two forms CONTRIBUTING.md defines. When the repository has a pull request template, follow it instead.

When a later push changes what the body claims, update the body with `pr edit` before running review-merge.

## Issue body

    <One sentence: what is wanted and who asked for it.>

    **Why**
    - <The failure or the need, with its evidence.>

    **Scope**
    1. <Each deliverable.>

    **Constraints**
    - <What has to hold.>

    **Done when**
    - <The checkable condition that closes it.>

When one of the repository's issue templates applies, follow it instead.

## When an issue gets filed

From "Discovery is not commitment, and not a filing either" in fix-quality.md:

- An issue is filed for an operator instruction that names work, for a correctness or security gap outside the scope of the pull request under review, or for a decision that belongs to the operator. The operator is told each time one is filed.
- A finding below the review's severity floor stays in the review comment and does not become an issue.
- An agent working on a task never opens an issue of its own. The coordinator files one after deciding the finding qualifies.
- A burn-down is reported by its net change in open issues, never by closes alone.

## Merging

`review-merge` waits for CI, runs the App reviewer from a clean agent-harness-core checkout at `--tool-head`, and merges only when the App approved, every check succeeded and the head is the one that was reviewed. Before any merge it also runs `premerge` on the reviewed head, which refuses on a sidebar-linked issue `--closes` does not name, a commit whose author or committer is not the configured identity, or a personal term in the commit messages, title or body. `--allow-admin` permits the administrator bypass in one case only: the App approved a change on an owned path. The tool checks that case itself: a changed file must be owned under `.github/CODEOWNERS` at the base commit, the App's approval must be the latest review, no reviewer may still request changes, and every other active rule on the base branch must be shown met. Otherwise it refuses, and the merge is the operator's. It needs `--admin-reason-file`, and the tool posts that reason on the pull request before it merges. Pass it only when the operator ordered the bypass for that pull request. Do not edit the title or body while review-merge runs: it refuses the merge if either changed since its closing-keyword audit, and writes the merge commit message from the audited text. For `--merge` it refuses when that text carries an identifying string, a session link or an attribution line, since it is written into git history. When the App's review is a comment, whatever its reasons, review-merge refuses. Merging that pull request is an operator override: report it to the operator, who merges by hand with a bypass-rationale comment. Never try to merge it another way.
