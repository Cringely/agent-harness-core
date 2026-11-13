---
name: publish
description: Use before filing a GitHub issue, opening or editing a pull request, or merging one. Every publish goes through tools/publish in agent-harness-core, which refuses identifying strings, session links, attribution lines, undeclared closing keywords and unfilled templates. Carries the pull request and issue body shapes and the rule for when an issue gets filed.
---

# Publish

Every issue, pull request and merge goes through `tools/publish/cli.ts` in agent-harness-core. The installer from agent-harness-core merges permission rules into this project's `.claude/settings.json` that deny raw `gh pr create`, `gh issue create`, `gh pr merge` and `gh alias set`, including the forms with a flag such as `--repo` between the group and the subcommand. Those rules are a tripwire against the common direct forms, not a boundary. Known routes still get past them: `gh api` writes, the edit and comment subcommands (`gh pr edit`, `gh pr comment`, `gh pr review`, `gh issue edit`, `gh issue comment`), and shell wrappers such as `bash -c`, `pwsh -c` and `env`. Taking any of those routes breaks the policy even when the shell lets the command through. What actually enforces the route is the publish tool's own refusals and the repository's merge rules, the App review and the CI ruleset.

## Running it

The tool holds a GitHub token and, for review-merge, streams the reviewer App's key. It runs only from its own empty work directory, named with `bun --cwd`, and refuses anywhere else.

`<core>` below is the agent-harness-core checkout this project was installed from: the `coreRepo` value in `.claude/.harness-manifest.local.json`. When that file or value is missing, stop and ask the operator rather than guessing a path.

Bash:

    bun --cwd "${USERPROFILE:-$HOME}/.claude-publish/work" <core>/tools/publish/cli.ts <command> ...

PowerShell:

    bun --cwd "$HOME/.claude-publish/work" <core>/tools/publish/cli.ts <command> ...

Commands:

    issue create  --repo <owner/name> --title <t> --body-file <abs path> [--template <file.md>]
    issue edit    --repo <owner/name> --issue <n> [--title <t>] [--body-file <abs path> [--template <file.md>]]
    pr create     --repo <owner/name> --base <branch> --head <branch> --title <t> --body-file <abs path> [--closes <n,n>] [--draft]
    pr edit       --repo <owner/name> --pr <n> --base <branch> [--title <t>] [--body-file <abs path> [--closes <n,n>]]
    review-merge  --repo <owner/name> --pr <n> [--closes <n,n>] [--allow-admin --admin-reason-file <abs path>] [--method merge|rebase] [--checks-timeout-min <1-180>]

Write every body to a file in your scratchpad first and pass its absolute path. There is no inline body option. Push the head branch before `pr create`, because the tool never pushes.

review-merge serves only agent-harness-core for now. In any other repository the reviewer refuses and nothing merges, so ask the operator how to merge there.

review-merge runs from the dedicated clone at `~/.claude-publish/tool` instead, and refuses unless that clone is clean and at its origin's default branch head, because that code holds the token and makes the merge decision. It can also run for over an hour: up to `--checks-timeout-min` (30 by default) for checks, then up to 45 minutes for the reviewer, past a tool shell's 10-minute foreground limit. So bring the clone up to date, start the run in the background with its output in a log file in your scratchpad, and poll that log with a bounded wait until its `exit=` line appears. In Bash, each line its own command, with `<n>` the pull request number:

    git -C "${USERPROFILE:-$HOME}/.claude-publish/tool" fetch --quiet origin master
    git -C "${USERPROFILE:-$HOME}/.claude-publish/tool" checkout --quiet --detach origin/master
    bun --cwd "${USERPROFILE:-$HOME}/.claude-publish/work" "${USERPROFILE:-$HOME}/.claude-publish/tool/tools/publish/cli.ts" review-merge --repo <owner/name> --pr <n> ... > <scratchpad>/review-merge-<n>.log 2>&1; echo "exit=$?" >> <scratchpad>/review-merge-<n>.log

Start the third line with the shell tool's background option, and never wait on that option's completion notice: it reports on the shell, and a dispatched agent is not woken by it. Read the log's last lines once the `exit=` line is there.

## Exit codes

- 0: done. The last line on stdout is the URL or the merge result.
- 2: refused, and nothing new was published. The message names the class of problem, such as `body: Co-Authored-By line` or `closing keywords do not match --closes (undeclared: 1, missing: 0)`, and never the text that tripped it. Fix the body or the arguments and run again. Never disguise a name or a link to get it past a gate, since a disguised one still publishes it.
- 1: a usage error, or a dependency failed partway. When the message says a review may already have been posted, look at the pull request before running again.

A review-merge refusal printed after its `review:` line means the App's review was posted and nothing was merged.

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

The `Closes` line appears only with a matching `--closes`. In agent-harness-core the Docs line is required, in one of the two forms CONTRIBUTING.md defines. When the repository has a pull request template, fill every one of its sections instead, since the tool refuses a body that leaves one empty.

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

When one of the repository's issue templates applies, pass `--template <file.md>` and fill every section of it instead.

## When an issue gets filed

From "Discovery is not commitment, and not a filing either" in fix-quality.md:

- An issue is filed for an operator instruction that names work, for a correctness or security gap outside the scope of the pull request under review, or for a decision that belongs to the operator. The operator is told each time one is filed.
- A finding below the review's severity floor stays in the review comment and does not become an issue.
- An agent working on a task never opens an issue of its own. The coordinator files one after deciding the finding qualifies.
- A burn-down is reported by its net change in open issues, never by closes alone.

## Merging

`review-merge` waits for CI, runs the App reviewer from a clean default-branch checkout, and merges only when the App approved, every check succeeded and the head is the one that was reviewed. Before any merge it also runs `premerge` on the reviewed head, which refuses on a sidebar-linked issue `--closes` does not name, a commit whose author or committer is not the configured identity, or a personal term in the commit messages, title or body. `--allow-admin` permits the administrator bypass in two cases: the App approved a change on an owned path, or the App could only comment, reported no finding at or above the severity floor, and gave only reasons CI cannot vouch for by design, such as an edit to CI definitions. A comment for a required check that never ran or is still pending refuses. It needs `--admin-reason-file`, and the tool posts that reason on the pull request before it merges. Pass it only when the operator ordered the bypass for that pull request.
