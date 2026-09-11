// Live-process tests for the SessionStart hook
// (core/claude/hooks/session-start-guardrails.sh). Issue #133's comment: this
// hook is advisory (WARN-only, read + print, never blocks) rather than a
// gate, so CONTRIBUTING.md:47's denial-test rule does not bind it — there is
// no refusal to assert. What #133 asks for instead is a test pinning the
// advisory claim itself: the hook always exits 0 and never emits anything a
// consumer would read as a deny (a Claude Code SessionStart hook's only deny
// channels are a `permissionDecision` of "deny" and exit status 2; this hook
// has neither in its source, and the cases below drive it rather than take
// that on faith).
//
// Like session-start-drift-check.test.ts, this is a POSIX shell script with
// no exported core to unit test, so every case runs the real hook through
// `sh`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { posixSh, posixShDir } from "./posix-sh";

const HOOK_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "session-start-guardrails.sh");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-"));
  tempDirs.push(dir);
  return dir;
}

function writeCatalog(dir: string, body: string) {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "guardrails.md"), body);
}

function runHook(projectDir: string) {
  const sh = posixSh();
  const basePath = process.env.PATH ?? "";
  const childEnv = {
    ...process.env,
    PATH: posixShDir() ? `${basePath}${delimiter}${posixShDir()}` : basePath,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  return Bun.spawnSync([sh, HOOK_SRC], { cwd: projectDir, env: childEnv, stdout: "pipe", stderr: "pipe" });
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

describe("session-start-guardrails hook — advisory, never blocks", () => {
  test("no .claude/guardrails.md: silent no-op, exit 0", () => {
    const dir = makeProject();
    const result = runHook(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    assertNoDenySignal(result);
  });

  test("guardrails.md present: prints up to the marker, stops before it, exits 0", () => {
    const dir = makeProject();
    writeCatalog(
      dir,
      ["BEFORE MARKER LINE", "guardrails:session-start-end", "AFTER MARKER LINE, must not print"].join("\n") + "\n",
    );

    const result = runHook(dir);
    const out = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(out).toContain("BEFORE MARKER LINE");
    expect(out).toContain(".claude/guardrails.md");
    expect(out).not.toContain("AFTER MARKER LINE");
    assertNoDenySignal(result);
  });

  test("guardrails.md with no marker line at all: prints the whole file, still exits 0", () => {
    const dir = makeProject();
    writeCatalog(dir, "RULE ONE\nRULE TWO\n");

    const result = runHook(dir);
    const out = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(out).toContain("RULE ONE");
    expect(out).toContain("RULE TWO");
    assertNoDenySignal(result);
  });
});
