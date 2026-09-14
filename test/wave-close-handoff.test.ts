// Live-process tests for the PostToolUse hook (matcher: Bash)
// (core/claude/hooks/wave-close-handoff.sh). Issue #133's comment: advisory
// (WARN-only, never blocks) rather than a gate, so CONTRIBUTING.md:47's
// denial-test rule does not bind it. What #133 asks for is a test pinning the
// advisory claim: the hook exits 0 no matter what, and never emits anything a
// consumer would read as a deny (a Claude Code PostToolUse hook's deny
// channels are a `permissionDecision` of "deny" and exit status 2 — neither
// exists in this hook's source, and the cases below drive it rather than
// take that on faith).
//
// Like session-start-drift-check.test.ts, this is a POSIX shell script with
// no exported core to unit test, so every case runs the real hook through
// `sh`, feeding it the payload on stdin the way Claude Code would.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { posixSh, posixShDir } from "./posix-sh";

const HOOK_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "wave-close-handoff.sh");

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

/** A real git repo with one commit, so the hook's best-effort `git log`
 * queries have something real to read rather than failing on an empty repo
 * for an unrelated reason. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "wavehandoff-"));
  tempDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  git(["commit", "-q", "--allow-empty", "-m", "initial"], dir);
  return dir;
}

// cwd (where the test process itself starts, and must exist) and
// CLAUDE_PROJECT_DIR (what the hook's own `cd` reads, and need not exist —
// that is exactly what one case below probes) are kept independent: folding
// them into one path made the spawn itself fail on a missing directory,
// before the hook's own `cd ... || exit 0` ever got a chance to run.
function runHook(cwd: string, projectDirEnv: string | undefined, payload: string) {
  const sh = posixSh();
  const basePath = process.env.PATH ?? "";
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: posixShDir() ? `${basePath}${delimiter}${posixShDir()}` : basePath,
  };
  if (projectDirEnv !== undefined) childEnv.CLAUDE_PROJECT_DIR = projectDirEnv;
  else delete childEnv.CLAUDE_PROJECT_DIR;
  return Bun.spawnSync([sh, HOOK_SRC], {
    cwd,
    env: childEnv,
    stdin: Buffer.from(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Nothing a consumer reads as a deny: no permissionDecision/decision field
 * (the JSON shape a Claude Code hook uses to block) anywhere in stdout, and
 * an exit code that is not the other deny channel, 2. */
function assertNoDenySignal(result: { exitCode: number; stdout: Buffer }) {
  expect(result.exitCode).not.toBe(2);
  const out = result.stdout.toString();
  expect(out).not.toContain("permissionDecision");
  expect(out).not.toContain('"decision"');
}

const nonMergePayload = JSON.stringify({
  tool_name: "Bash",
  tool_input: { command: "ls -la" },
});

const mergePayload = JSON.stringify({
  tool_name: "Bash",
  tool_input: { command: "gh pr merge 42 --squash" },
});

describe("wave-close-handoff hook — fires only on `gh pr merge`", () => {
  test("a Bash payload that is not a PR merge: silent no-op, exit 0", () => {
    const dir = makeProject();
    const result = runHook(dir, dir, nonMergePayload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    assertNoDenySignal(result);
  });
});

describe("wave-close-handoff hook — fires on `gh pr merge`, still never blocks", () => {
  test("a PR-merge payload: exits 0 and prints only advisory reminder text", () => {
    const dir = makeProject();
    const result = runHook(dir, dir, mergePayload);
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    // Confirms the branch actually fired (not vacuously silent like the
    // non-merge case above) while staying advisory.
    expect(out).toContain("WAVE HANDOFF");
    assertNoDenySignal(result);
  });

  test("a PR-merge payload with an unresolvable CLAUDE_PROJECT_DIR: degrades to silent exit 0, not an error", () => {
    const dir = makeProject();
    const missingProjectDir = join(dir, "does-not-exist");
    const result = runHook(dir, missingProjectDir, mergePayload);
    // cd fails on the nonexistent directory, and the hook's own
    // `cd ... || exit 0` takes the graceful-degradation path before any
    // print statement runs — this is the "gate error, not a domain
    // decision" case, and it must still never read as a deny.
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(0);
    assertNoDenySignal(result);
  });
});
