// #78: an entrypoint spawn test for the memory-note transition counter
// (core/claude/hooks/memory-transition-log.ts). No pure-function test file existed for this hook
// before this one; adding offline coverage for detectTransitions()/inMemoryDir() is a separate,
// larger task than #78 asks for, so this file carries only the spawn test.
//
// This hook has no stdout contract at all (see its own header) — it either counts or it doesn't,
// and its "fails open silently" is "counts nothing silently". Line coverage on detectTransitions()
// cannot see whether the entrypoint ever calls it: an ablated `if (import.meta.main)` block (the
// whole thing deleted) produces exit 0 and no stderr, identical to a healthy no-op run on an
// out-of-scope path. The one thing that is NOT identical is whether a real JSONL line actually
// lands on disk for a transition that should be counted, which is what the test below checks.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "core", "claude", "hooks", "memory-transition-log.ts");

/** Runs the hook as a real process with `stdinText` on stdin, and `env` overriding the runner's
 * own — used to redirect STATE_PATH (`~/.claude/state/memory-transitions.jsonl`) away from the
 * real home directory, the same HOME/USERPROFILE-override convention test/identity-gate.test.ts
 * uses to isolate its own real-file-I/O tests. Never goes through a shell. */
function runHook(stdinText: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, HOOK],
    stdin: new TextEncoder().encode(stdinText),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const fakeHome = mkdtempSync(join(tmpdir(), "memory-transition-log-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "memory-transition-log-project-"));
mkdirSync(join(projectDir, "memory"), { recursive: true });
const statePath = join(fakeHome, ".claude", "state", "memory-transitions.jsonl");
const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("spawned process — a real transition lands on disk", () => {
  test("a status: proposed -> accepted Edit under memory/: exit 0, one JSONL line written", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "memory/note.md",
          old_string: "  status: proposed",
          new_string: "  status: accepted",
        },
        cwd: projectDir,
        session_id: "spawn-test-session",
      }),
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    // No stdout contract to check, per the header above — the only observable effect is the disk
    // write, so that is what an ablated entrypoint (which performs no I/O at all) fails to produce.
    const written = readFileSync(statePath, "utf8").trim();
    expect(written.length).toBeGreaterThan(0);
    const line = JSON.parse(written.split("\n")[0]);
    expect(line.transition).toBe("status-changed");
    expect(line.old).toBe("proposed");
    expect(line.new).toBe("accepted");
    expect(line.tool).toBe("Edit");
    expect(line.sessionId).toBe("spawn-test-session");
    expect(line.notePath.replace(/\\/g, "/")).toContain("memory/note.md");
  });
});

describe("spawned process — the fail-open path stays open and says why", () => {
  test("malformed JSON exits 0, no stdout, and leaves a diagnostic instead of vanishing", () => {
    const result = runHook("{not json", env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("memory-transition-log: hook error, skipping:");
  });

  test("a Write/Edit outside memory/ counts nothing: exit 0, no stdout, no stderr, no new line", () => {
    // This hook has no stdout contract at all (file header above), so exit/stdout/stderr alone
    // cannot tell a correct no-op from one that wrongly counted: appendFileSync touches neither.
    // The one channel that discriminates is the state file itself. The test above this one has
    // already run and appended a line, so the baseline is captured fresh here rather than
    // asserted absent — this is "same content as immediately before this test's own run", not
    // "empty file". The payload below is a real status: proposed -> accepted transition, same
    // shape the positive test counts; only the out-of-memory/ path should stop it, so a broken
    // or removed inMemoryDir() gate is exactly what turns `before` and `after` unequal.
    const before = readFileSync(statePath, "utf8");
    const result = runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "src/index.ts", old_string: "  status: proposed", new_string: "  status: accepted" },
        cwd: projectDir,
      }),
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
