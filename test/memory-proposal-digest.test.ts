// Coverage for account/claude/hooks/memory-proposal-digest.ts, a standalone script (no
// package.json, no exports — importing it runs its top-level `process.exit(0)`, so it can
// only be exercised as a spawned process) with its own `--selftest` flag that runs
// collect()/render() end to end via node:assert.
//
// CodeQL js/insecure-temporary-file (alerts 5-12): selftest()'s fixture roots used to be
// built with `join(tmpdir(), \`memory-proposal-digest-selftest-${process.pid}\`)` — a
// predictable name a shared /tmp lets another user pre-create (directory or symlink)
// ahead of this process. Fixed at the source of the path, not at each of the eight
// writeFileSync call sites that consume it: both roots are now allocated with
// mkdtempSync, which creates an unpredictable-suffixed directory atomically.
//
// The race itself needs the fixture root's exact name known before the process that
// creates it runs, which depends on that process's own pid — not obtainable from outside
// a synchronous spawn without a flaky guess-the-pid race. What IS deterministic, and
// reproduces red on a revert of the fix, is the absence of the exact anti-pattern CodeQL
// flagged in the source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "account", "claude", "hooks", "memory-proposal-digest.ts");

describe("memory-proposal-digest --selftest", () => {
  test("passes end to end", () => {
    const proc = Bun.spawnSync({ cmd: [process.execPath, HOOK, "--selftest"], stdout: "pipe", stderr: "pipe" });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.stdout.toString()).toContain("PASS memory-proposal-digest");
    expect(proc.exitCode).toBe(0);
  });
});

describe("memory-proposal-digest — insecure temp file (CodeQL js/insecure-temporary-file)", () => {
  test("selftest fixture roots are allocated with mkdtempSync, not a pid-suffixed tmpdir() join", () => {
    const src = readFileSync(HOOK, "utf8");
    // The exact shape CodeQL flagged: a temp path templated from tmpdir() and process.pid
    // instead of allocated atomically.
    expect(src).not.toMatch(/join\(tmpdir\(\),\s*`[^`]*\$\{process\.pid\}[^`]*`\)/);
    expect(src).toMatch(/mkdtempSync\(join\(tmpdir\(\), "memory-proposal-digest-selftest-"\)\)/);
    expect(src).toMatch(/mkdtempSync\(join\(tmpdir\(\), "memory-proposal-digest-empty-"\)\)/);
  });
});
