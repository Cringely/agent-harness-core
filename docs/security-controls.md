# Security control register

This is the list of security controls this repo ships or relies on. A reviewer handed a
security-bearing diff checks it against this list instead of against whatever the dispatching
brief happened to say. Each row gives the invariant the control holds, the files that implement
it, and the tests that pin it.

Keep it current. A new control gets a row in the same change that adds it. A control that is
renamed, moved or retired gets its row edited or removed in that change. The test in
`test/security-controls.test.ts` fails when a cited file or test no longer exists, so a stale
path shows up as a red build. It cannot tell whether the invariant sentence is still true, so a
change to a control's behaviour needs a human to reread its row.

Paths are repo-relative. Only backticked paths in the last two columns are checked.

| Control | Invariant | Implementing files | Pinning tests |
|---|---|---|---|
| Identity gate, commit | A commit is refused when its staged content, pending author or committer, or branch name carries a declared name, email, username or hostname. A declared but unreadable identity file refuses too. | `core/claude/hooks/pre-commit`, `core/claude/hooks/identity-patterns.sh` | `test/identity-gate.test.ts`, `test/pre-commit.test.ts` |
| Identity gate, push | A push is refused when any commit, commit message, tag object or blob in the pushed range carries a declared identity string. | `core/claude/hooks/pre-push`, `core/claude/hooks/identity-patterns.sh` | `test/identity-gate.test.ts` |
| Personal-term gate | A commit or push is refused when it carries a string from the operator's personal terms list, and an empty or malformed list refuses rather than checking nothing. | `core/claude/hooks/identity-patterns.sh`, `core/claude/hooks/pre-commit`, `core/claude/hooks/pre-push` | `test/personal-term-gate.test.ts` |
| Local secret scan | A commit is refused when staged content holds a provider-shaped token or private key. The scan fails closed when `grep` cannot run or a canary is not found, and never prints the match. | `core/claude/hooks/pre-commit` | `test/pre-commit.test.ts` |
| CI secret scan | A pull request's commit range is either scanned by Gitleaks or the job fails. A range that cannot be resolved never passes as clean. | `.github/workflows/test.yml`, `.gitleaks.toml` | `test/secret-scan-ci.test.ts` |
| No AI attribution | A commit message carrying a co-author trailer or other AI attribution is refused, whoever or whatever made the commit. | `core/claude/hooks/commit-msg` | `test/commit-msg.test.ts` |
| Worktree isolation | A dispatch of an agent that cannot be proven read-only is denied unless it is isolated or carries a written override with a reason. | `core/claude/hooks/agent-worktree-gate.ts`, `core/claude/hooks/agent-name.ts` | `test/agent-worktree-gate.test.ts`, `test/agent-name.test.ts` |
| Scratch write scope | An agent declaring a scratch write scope can write only inside its scratch directory. Every other file write is denied before the permission system runs. | `core/claude/hooks/agent-write-scope.ts`, `core/claude/hooks/agent-name.ts` | `test/agent-write-scope.test.ts`, `test/agent-name.test.ts` |
| Untrusted content boundary | Every agent definition carries the same untrusted-content block, so none quietly drops it. | `core/claude/templates/untrusted-content-boundary.template.md` | `test/untrusted-block-identity.test.ts` |
| Account export scrub | The account export refuses to finish when any payload file or path carries the workstation username, a declared name or email, or a personal term. | `install/Export-Account.ps1`, `install/AccountShared.ps1` | `install/Export-Account.Tests.ps1`, `install/Account-Hooks.Tests.ps1` |
| Installer sidecar protection | The per-machine sidecar file the installer writes is never left unignored in a target repo, even when the target's ignore file predates the sidecar. | `install/Install-Harness.ps1` | `test/gitignore-sidecar-protection.test.ts` |
| Review body identity check | The pull request reviewer refuses to post a review body that carries an identifying string, including the email of the logged-in claude account. | `tools/pr-review/identity.ts` | `test/pr-review-identity.test.ts` |
| Reviewer App permissions | The reviewer stops if its GitHub App holds permissions beyond the allowlist or mints a token wider than one repository. The private key never leaves the process. | `tools/pr-review/app-auth.ts` | `test/pr-review-app-auth.test.ts` |
