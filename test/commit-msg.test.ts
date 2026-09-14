// Live-process tests for the git commit-msg hook (core/claude/hooks/commit-msg).
// Issue #133: the hook refuses a commit whose message carries an AI-attribution
// line, and nothing under test/ drove it — the only prior mention was a string
// match in test/citation-drift.ts.
//
// Like pre-commit.test.ts and identity-gate.test.ts, this hook is a POSIX shell
// script with no exported core to unit test, and it is a git hook, not a Claude
// Code hook — the "reads as a deny" channel here is a non-zero exit from a real
// `git commit`, not a permissionDecision. So every case here drives the hook
// through a REAL `git commit` in a real temp repo (mirroring
// identity-gate.test.ts's initPrePushRepo, which installs the hook straight at
// its real git-resolved path and lets a real `git push` invoke it) rather than
// `sh <hook> <msg-file>` directly: Git for Windows runs hooks with
// LC_CTYPE=C.UTF-8, and a direct `sh` invocation in a test has missed locale
// bugs a real git invocation would have caught.
//
// CONTRIBUTING.md:47's denial-test rule binds this hook (it refuses via a
// non-zero exit, a channel git reads as a block): a case that passes only
// proves the gate lets work through, so every describe block below pairs a
// refusing case with an accepting one.
//
// Every attribution string in these fixtures is exactly the shape the hook is
// written to catch, and none of it appears in this file's own commit message
// (change-management.md: no AI attribution in a real commit here) — the
// commit that adds this file describes these cases in prose instead of
// quoting them.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "commit-msg");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

/** A fresh repo, hook not yet installed — installHook() below places it at
 * its real git-resolved path so a real `git commit` invokes it exactly as
 * production would, shebang and all, rather than through an explicit
 * `sh <hook>` (the same approach identity-gate.test.ts uses for pre-push). */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "commitmsg-"));
  tempDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

/** Stage one trivial file so a commit attempt has something to commit — the
 * hook's own refusal is what's under test, not "nothing staged". */
function stageSomething(dir: string, name = "f.txt") {
  writeFileSync(join(dir, name), "content\n");
  git(["add", name], dir);
}

/** Attempts a commit with the given message, passed as a real argv entry
 * (never through a shell string) so embedded newlines and colons reach git
 * exactly as written. */
function commitWith(dir: string, message: string) {
  return git(["commit", "-m", message], dir);
}

function headExists(dir: string): boolean {
  return git(["rev-parse", "--verify", "HEAD"], dir).exitCode === 0;
}

/** Installs the hook at its real git-resolved path and makes it executable
 * (needed on the ubuntu runner; a harmless no-op on Windows). */
function installHook(dir: string) {
  writeFileSync(join(dir, ".git", "hooks", "commit-msg"), readFileSync(HOOK_SRC));
  chmodSync(join(dir, ".git", "hooks", "commit-msg"), 0o755);
}

describe("commit-msg hook — refuses each AI-attribution channel it documents", () => {
  // Each fixture trips exactly one of the hook's four checks, isolated from
  // the other three, so a regression in one check's regex cannot hide behind
  // another check catching the same fixture for a different reason.
  const cases: Array<[string, string]> = [
    [
      "Co-Authored-By trailer naming Claude",
      "fix: correct the retry backoff\n\nCo-authored-by: Claude Helper <helper@example.test>\n",
    ],
    [
      "Claude-Session trailer",
      "fix: correct the retry backoff\n\nClaude-Session: opaque-token-not-a-url\n",
    ],
    [
      "'Generated with Claude Code' attribution line",
      "fix: correct the retry backoff\n\nGenerated with Claude Code\n",
    ],
    [
      "an anthropic.com address",
      "fix: correct the retry backoff\n\nContact noreply@anthropic.com for details.\n",
    ],
  ];

  test.each(cases)("%s: git commit is refused, no commit is created", (_label, message) => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(dir, message);

    expect(result.exitCode).not.toBe(0);
    expect(headExists(dir)).toBe(false);
  });
});

describe("commit-msg hook — accepts a clean message", () => {
  test("a normal commit message with no attribution line: git commit succeeds", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(
      dir,
      "fix: correct the retry backoff\n\nNo attribution here, just a normal commit describing the change.\n",
    );

    expect(result.exitCode).toBe(0);
    expect(headExists(dir)).toBe(true);
  });
});

describe("commit-msg hook — the two-space prose escape hatch", () => {
  test("a trigger phrase indented by two spaces is prose, not a trailer, and is accepted", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    // The hook's own header documents this: indenting a line by two or more
    // spaces is how to write one of these strings in prose (a commit that
    // documents the rule, for instance) without tripping the gate.
    const message =
      "docs: describe the commit-msg escape hatch\n\n" +
      "The hook refuses any line starting with this trailer:\n" +
      "  Co-authored-by: Claude <noreply@anthropic.com>\n" +
      "Indenting by two spaces is how to write it in prose instead.\n";

    const result = commitWith(dir, message);

    expect(result.exitCode).toBe(0);
    expect(headExists(dir)).toBe(true);
  });
});
