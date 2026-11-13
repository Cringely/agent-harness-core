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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Process-level coverage of the accepted-note digest: the hook is spawned against a fixture
// tree with the real clock, so the dates are chosen far enough out that "past" and "ahead"
// cannot flip while the suite runs.
describe("memory-proposal-digest — accepted notes past valid_until", () => {
  function digestFor(notes: Record<string, string>): { stdout: string; status: number } {
    const root = mkdtempSync(join(tmpdir(), "mpd-accepted-"));
    try {
      const memDir = join(root, "P--fixture", "memory");
      mkdirSync(memDir, { recursive: true });
      for (const [slug, fm] of Object.entries(notes)) {
        writeFileSync(join(memDir, `${slug}.md`), `---\nname: ${slug}\ndescription: ${slug} desc\nmetadata:\n  type: decision\n${fm}\n---\nbody\n`);
      }
      const proc = Bun.spawnSync({ cmd: [process.execPath, HOOK, "--root", root], stdout: "pipe", stderr: "pipe" });
      return { stdout: proc.stdout.toString(), status: proc.exitCode ?? -1 };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("an accepted note whose valid_until has passed is listed", () => {
    const r = digestFor({ "old-ruling": "  status: accepted\n  valid_until: 2020-01-01" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 accepted memory decision note is past valid_until.");
    expect(r.stdout).toContain("[LAPSED 2020-01-01] P--fixture/old-ruling");
    expect(r.stdout).not.toContain("still at status: proposed");
  });

  test("an accepted note still inside valid_until is not listed, and nothing is printed", () => {
    const r = digestFor({ "live-ruling": "  status: accepted\n  valid_until: 2999-12-31" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("an accepted note with no usable date is not listed", () => {
    const r = digestFor({ undated: "  status: accepted", garbled: "  status: accepted\n  valid_until: someday" });
    expect(r.stdout).toBe("");
  });

  test("a lapsed accepted note and a proposal render as two sections", () => {
    const r = digestFor({
      "old-ruling": "  status: accepted\n  valid_until: 2020-01-01",
      pending: "  status: proposed\n  valid_until: 2999-12-31",
    });
    expect(r.stdout).toContain("1 memory decision note is still at status: proposed.");
    expect(r.stdout).toContain("1 accepted memory decision note is past valid_until.");
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
