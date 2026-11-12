// The account SessionStart reminder nudges once per folder that has no project layer.
// Each case copies the payload script into <tmp>/home/hooks and runs it under bash, so the
// state directory (<tmp>/home/state, resolved from the script's own location) is isolated.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { posixBash } from "./posix-sh";

const SOURCE = resolve(import.meta.dir, "..", "account", "claude", "hooks", "harness-core-reminder.sh");
const NUDGE = "no agent-harness-core project layer";

let root: string;
let home: string;
let script: string;

function mkFolder(name: string, opts: { manifest?: boolean } = {}): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  if (opts.manifest) {
    mkdirSync(join(d, ".claude"), { recursive: true });
    writeFileSync(join(d, ".claude", ".harness-manifest.json"), "{}");
  }
  return d;
}

function run(folder: string) {
  const r = Bun.spawnSync([posixBash(), script], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: folder },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
}

const stateFile = () => join(home, "state", "harness-nudged.txt");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "reminder-"));
  home = join(root, "home");
  mkdirSync(join(home, "hooks"), { recursive: true });
  script = join(home, "hooks", "harness-core-reminder.sh");
  copyFileSync(SOURCE, script);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("harness-core-reminder.sh", () => {
  test("a folder with no manifest and no .git gets the nudge once", () => {
    const d = mkFolder("plain");
    const r = run(d);
    expect(r.code).toBe(0);
    expect(r.out).toContain(NUDGE);
    expect(readFileSync(stateFile(), "utf8").split(/\r?\n/)).toContain(d);
  });

  test("the same folder is silent on the second run", () => {
    const d = mkFolder("plain");
    const r = run(d);
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(0);
  });

  test("a different folder still gets it", () => {
    const r = run(mkFolder("other"));
    expect(r.code).toBe(0);
    expect(r.out).toContain(NUDGE);
  });

  test("a folder with a manifest is silent and writes no state", () => {
    const d = mkFolder("laid", { manifest: true });
    const r = run(d);
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(0);
    expect(readFileSync(stateFile(), "utf8").split(/\r?\n/)).not.toContain(d);
  });

  test("a path containing agent-harness-core is silent", () => {
    const d = mkFolder("agent-harness-core-clone");
    const r = run(d);
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(0);
    expect(readFileSync(stateFile(), "utf8").split(/\r?\n/)).not.toContain(d);
  });

  test("an unwritable state location still prints the nudge", () => {
    rmSync(join(home, "state"), { recursive: true, force: true });
    writeFileSync(join(home, "state"), "not a directory");
    const r = run(mkFolder("unwritable"));
    expect(r.code).toBe(0);
    expect(r.out).toContain(NUDGE);
    expect(existsSync(join(home, "state"))).toBe(true);
  });
});
