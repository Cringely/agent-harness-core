# Change Management: Code Projects

The code-repo half of `change-management.md`. The confirmation list, backups, commit identity, decision notes, invariant promotion and script hygiene stay in the kernel file of that name.

## Decision Documentation

**In commit messages:**
- Why this change was needed (not just what changed). Put it on a line starting with `Why:` followed by at least three words. The `commit-msg` hook refuses a commit without one, on any message that has a body. Subject-only commits of any type (trailers such as `Signed-off-by:` alone are not a body), merge commits (a `MERGE_HEAD`, or a subject git writes: `Merge branch`, `Merge branches`, `Merge remote-tracking branch`, `Merge pull request`, `Merge tag`, `Merge commit`), reverts git generates (`Revert "` or `Reapply "` subjects), and `fixup!`, `squash!` and `amend!` subjects are exempt
- What was considered and rejected
- Any trade-offs made

**In code comments:**
- Why non-obvious configuration exists
- Warnings about things that look wrong but are intentional
- References to relevant docs or issues

## Session Close Protocol

Before ending any session with code or config changes:
1. **Commit last known good state** — all working changes must be in a commit before the session closes. Never leave uncommitted working changes.
2. **Push to remote** — ensure the commit is on GitHub, not just local. Run `git remote` first. When it prints nothing, the project has no remote: skip this step and say "No remote configured, push skipped" in the close. When the folder is not a git repository at all, skip steps 1 and 2 the same way and say so.
3. **Sync production** — pull on the production host if production was the work target.
