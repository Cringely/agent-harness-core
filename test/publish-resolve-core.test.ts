// core/claude/skills/publish/resolve-core.ts: the publish skill runs tools/publish/cli.ts from the
// coreRepo a project's sidecar names, and a project can write that sidecar. So the helper must
// refuse every coreRepo the operator never put on the per-user checkout allowlist, the same list
// session-start-drift-check.sh requires, and refuse when the list cannot be read. Each refusal
// case below keeps a cli.ts in place, so a pass means the allowlist refused it, not a missing file.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCore } from "../core/claude/skills/publish/resolve-core";

const HELPER = join(import.meta.dir, "..", "core", "claude", "skills", "publish", "resolve-core.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "resolve-core-"));
  dirs.push(d);
  return d;
}

function makeCore(parent: string, name = "core"): string {
  const core = join(parent, name);
  mkdirSync(join(core, "tools", "publish"), { recursive: true });
  writeFileSync(join(core, "tools", "publish", "cli.ts"), "// fake\n");
  return core;
}

function makeProject(parent: string, coreRepo: unknown): string {
  const project = join(parent, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), JSON.stringify({ coreRepo }));
  return project;
}

function allowlist(parent: string, lines: string[]): string {
  const file = join(parent, "harness-core-checkouts");
  writeFileSync(file, lines.map((l) => `${l}\r\n`).join(""));
  return file;
}

describe("resolveCore", () => {
  test("returns the cli path of a coreRepo on the allowlist", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    const r = resolveCore(project, { HARNESS_CORE_ALLOWLIST: allowlist(d, ["", core]) });
    expect(r).toEqual({ ok: true, cli: join(resolve(core), "tools", "publish", "cli.ts") });
  });

  test("refuses a coreRepo that is not on the allowlist", () => {
    const d = scratch();
    const core = makeCore(d);
    const other = makeCore(d, "other");
    const project = makeProject(d, core);
    const r = resolveCore(project, { HARNESS_CORE_ALLOWLIST: allowlist(d, [other]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not on the checkout allowlist");
  });

  test("refuses when the allowlist cannot be read", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    const r = resolveCore(project, { HARNESS_CORE_ALLOWLIST: join(d, "missing") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cannot be read");
  });

  test("refuses when no allowlist location can be named", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    const r = resolveCore(project, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no checkout allowlist location");
  });

  test("refuses a coreRepo inside the project, even when listed", () => {
    const d = scratch();
    const project = makeProject(d, "placeholder");
    const inner = makeCore(project, "vendored");
    writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), JSON.stringify({ coreRepo: inner }));
    const r = resolveCore(project, { HARNESS_CORE_ALLOWLIST: allowlist(d, [inner]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("inside this project");
  });

  test("refuses a relative coreRepo", () => {
    const d = scratch();
    makeCore(d);
    const project = makeProject(d, "../core");
    const r = resolveCore(project, { HARNESS_CORE_ALLOWLIST: allowlist(d, ["../core"]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not an absolute path");
  });

  test("refuses a listed coreRepo that holds no tools/publish/cli.ts", () => {
    const d = scratch();
    const core = join(d, "empty");
    mkdirSync(core);
    const project = makeProject(d, core);
    const r = resolveCore(project, { HARNESS_CORE_ALLOWLIST: allowlist(d, [core]) });
    expect(r.ok).toBe(false);
  });

  test("refuses a missing sidecar, a non-string coreRepo and an unparsable sidecar", () => {
    const d = scratch();
    const core = makeCore(d);
    const list = allowlist(d, [core]);
    const bare = join(d, "bare");
    mkdirSync(bare);
    expect(resolveCore(bare, { HARNESS_CORE_ALLOWLIST: list }).ok).toBe(false);
    const project = makeProject(d, 7);
    expect(resolveCore(project, { HARNESS_CORE_ALLOWLIST: list }).ok).toBe(false);
    writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), "{not json");
    expect(resolveCore(project, { HARNESS_CORE_ALLOWLIST: list }).ok).toBe(false);
  });
});

describe("resolve-core.ts as a command", () => {
  test("prints only the cli path and exits 0 when trusted, prints nothing on stdout and exits 1 when not", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    const okRun = Bun.spawnSync([process.execPath, HELPER, project], {
      env: { ...process.env, HARNESS_CORE_ALLOWLIST: allowlist(d, [core]) },
    });
    expect(okRun.exitCode).toBe(0);
    expect(okRun.stdout.toString()).toBe(`${join(resolve(core), "tools", "publish", "cli.ts")}\n`);

    const badRun = Bun.spawnSync([process.execPath, HELPER, project], {
      env: { ...process.env, HARNESS_CORE_ALLOWLIST: join(d, "missing") },
    });
    expect(badRun.exitCode).toBe(1);
    expect(badRun.stdout.toString()).toBe("");
    expect(badRun.stderr.toString()).toContain("resolve-core:");
  });

  test("exits 1 without a project argument", () => {
    const run = Bun.spawnSync([process.execPath, HELPER]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe("");
  });
});

describe("the publish skill", () => {
  test("resolves the cli through resolve-core.ts and never runs it from the raw coreRepo", () => {
    const skill = Bun.file(join(import.meta.dir, "..", "core", "claude", "skills", "publish", "SKILL.md"));
    return skill.text().then((text) => {
      expect(text).toContain(".claude/skills/publish/resolve-core.ts");
      expect(text).not.toContain("<core>/tools/publish/cli.ts");
    });
  });
});
