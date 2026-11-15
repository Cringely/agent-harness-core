// core/claude/skills/publish/resolve-core.ts: the publish skill runs tools/publish/cli.ts from the
// coreRepo a project's sidecar names, and a project can write that sidecar. So the helper must
// refuse every coreRepo the operator never put on the per-user checkout allowlist, the same list
// session-start-drift-check.sh requires, and refuse when the list cannot be read. Each refusal
// case below keeps a cli.ts in place, so a pass means the allowlist refused it, not a missing file.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const r = resolveCore(project, {}, allowlist(d, ["", core]));
    expect(r).toEqual({ ok: true, cli: join(realpathSync.native(core), "tools", "publish", "cli.ts") });
  });

  test("refuses a coreRepo that is not on the allowlist", () => {
    const d = scratch();
    const core = makeCore(d);
    const other = makeCore(d, "other");
    const project = makeProject(d, core);
    const r = resolveCore(project, {}, allowlist(d, [other]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not on the checkout allowlist");
  });

  test("refuses when the allowlist cannot be read", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    const r = resolveCore(project, {}, join(d, "missing"));
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
    const r = resolveCore(project, {}, allowlist(d, [inner]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("inside this project");
  });

  // A self-install (Install-Harness.ps1 -Target .) records the project root as coreRepo. That
  // checkout's cli.ts is whatever the current branch holds, so the helper resolves to the pinned
  // tool clone in the profile instead, and refuses when that clone is absent or inside the project.
  function selfInstalled(d: string): { project: string; home: string } {
    const project = makeCore(d, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), JSON.stringify({ coreRepo: project }));
    const home = join(d, "home");
    mkdirSync(home, { recursive: true });
    return { project, home };
  }

  test("resolves a coreRepo equal to the project root to the pinned tool clone", () => {
    const d = scratch();
    const { project, home } = selfInstalled(d);
    const clone = makeCore(join(home, ".claude-publish"), "tool");
    const r = resolveCore(project, { USERPROFILE: home, HOME: home });
    expect(r).toEqual({ ok: true, cli: join(realpathSync.native(clone), "tools", "publish", "cli.ts") });
  });

  test("refuses a coreRepo equal to the project root when the pinned tool clone is missing", () => {
    const d = scratch();
    const { project, home } = selfInstalled(d);
    const r = resolveCore(project, { USERPROFILE: home, HOME: home });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(".claude-publish/tool");
  });

  test("refuses a coreRepo equal to the project root when the pinned tool clone holds no cli.ts", () => {
    const d = scratch();
    const { project, home } = selfInstalled(d);
    mkdirSync(join(home, ".claude-publish", "tool"), { recursive: true });
    const r = resolveCore(project, { USERPROFILE: home, HOME: home });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no tools/publish/cli.ts");
  });

  test("refuses a coreRepo equal to the project root when the pinned tool clone is inside the project", () => {
    const d = scratch();
    const { project } = selfInstalled(d);
    const home = join(project, "home");
    makeCore(join(home, ".claude-publish"), "tool");
    const r = resolveCore(project, { USERPROFILE: home, HOME: home });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("inside this project");
  });

  test("still refuses a coreRepo strictly inside the project when a pinned tool clone exists", () => {
    const d = scratch();
    const project = makeProject(d, "placeholder");
    const inner = makeCore(project, "vendored");
    writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), JSON.stringify({ coreRepo: inner }));
    const home = join(d, "home");
    makeCore(join(home, ".claude-publish"), "tool");
    const r = resolveCore(project, { USERPROFILE: home, HOME: home });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("coreRepo is inside this project");
  });

  test("refuses a relative coreRepo", () => {
    const d = scratch();
    makeCore(d);
    const project = makeProject(d, "../core");
    const r = resolveCore(project, {}, allowlist(d, ["../core"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not an absolute path");
  });

  test("refuses a listed coreRepo that holds no tools/publish/cli.ts", () => {
    const d = scratch();
    const core = join(d, "empty");
    mkdirSync(core);
    const project = makeProject(d, core);
    const r = resolveCore(project, {}, allowlist(d, [core]));
    expect(r.ok).toBe(false);
  });

  test("ignores HARNESS_CORE_ALLOWLIST: a planted list that names coreRepo does not admit it", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    const planted = allowlist(d, [core]);
    const home = join(d, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "harness-core-checkouts"), "");
    const r = resolveCore(project, { HARNESS_CORE_ALLOWLIST: planted, USERPROFILE: home, HOME: home });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not on the checkout allowlist");
  });

  test("refuses a listed alias outside the project whose real path is inside it", () => {
    const d = scratch();
    const project = makeProject(d, "placeholder");
    const inner = makeCore(project, "vendored");
    const alias = join(d, "alias");
    try {
      symlinkSync(inner, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      console.warn(`skipped: this OS cannot create a directory link here (${(e as Error).message})`);
      return;
    }
    writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), JSON.stringify({ coreRepo: alias }));
    const r = resolveCore(project, {}, allowlist(d, [alias]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("inside this project");
  });

  test("matches the allowlist by real path, so a listed link to the checkout admits it", () => {
    const d = scratch();
    const core = makeCore(d);
    const link = join(d, "core-link");
    try {
      symlinkSync(core, link, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      console.warn(`skipped: this OS cannot create a directory link here (${(e as Error).message})`);
      return;
    }
    const project = makeProject(d, link);
    const r = resolveCore(project, {}, allowlist(d, [core]));
    expect(r).toEqual({ ok: true, cli: join(realpathSync.native(core), "tools", "publish", "cli.ts") });
  });

  test("matches the allowlist by real path, so a listed link admits the checkout it points at", () => {
    const d = scratch();
    const core = makeCore(d);
    const link = join(d, "listed-link");
    try {
      symlinkSync(core, link, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      console.warn(`skipped: this OS cannot create a directory link here (${(e as Error).message})`);
      return;
    }
    const project = makeProject(d, core);
    expect(resolveCore(project, {}, allowlist(d, [link])).ok).toBe(true);
  });

  test("refuses a coreRepo inside the project when the project root is passed through a link", () => {
    const d = scratch();
    const project = makeProject(d, "placeholder");
    const inner = makeCore(project, "vendored");
    writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), JSON.stringify({ coreRepo: inner }));
    const projectLink = join(d, "project-link");
    try {
      symlinkSync(project, projectLink, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      console.warn(`skipped: this OS cannot create a directory link here (${(e as Error).message})`);
      return;
    }
    const r = resolveCore(projectLink, {}, allowlist(d, [inner]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("inside this project");
  });

  test("refuses a UNC or device-path coreRepo", () => {
    const d = scratch();
    for (const unc of ["\\\\server\\share\\core", "//server/share/core", "\\\\?\\C:\\core", "\\\\.\\C:\\core", "//?/C:/core"]) {
      const project = makeProject(d, unc);
      const r = resolveCore(project, {}, allowlist(d, [unc]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("UNC");
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("refuses a coreRepo whose real path cannot be resolved", () => {
    const d = scratch();
    const project = makeProject(d, join(d, "gone"));
    const r = resolveCore(project, {}, allowlist(d, [join(d, "gone")]));
    expect(r.ok).toBe(false);
  });

  test("refuses a relative or UNC allowlist location", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    for (const home of ["relative-home", "\\\\server\\share\\home", "//server/share/home"]) {
      const r = resolveCore(project, { USERPROFILE: home, HOME: home });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("allowlist location");
    }
  });

  test("refuses a missing sidecar, a non-string coreRepo and an unparsable sidecar", () => {
    const d = scratch();
    const core = makeCore(d);
    const list = allowlist(d, [core]);
    const bare = join(d, "bare");
    mkdirSync(bare);
    expect(resolveCore(bare, {}, list).ok).toBe(false);
    const project = makeProject(d, 7);
    expect(resolveCore(project, {}, list).ok).toBe(false);
    writeFileSync(join(project, ".claude", ".harness-manifest.local.json"), "{not json");
    expect(resolveCore(project, {}, list).ok).toBe(false);
  });
});

describe("resolve-core.ts as a command", () => {
  test("prints only the cli path and exits 0 when trusted, prints nothing on stdout and exits 1 when not", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    // The command reads only the profile allowlist, so each run gets its own profile.
    const home = join(d, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "harness-core-checkouts"), `${core}\n`);
    const okRun = Bun.spawnSync([process.execPath, HELPER, project], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    expect(okRun.exitCode).toBe(0);
    expect(okRun.stdout.toString()).toBe(`${join(realpathSync.native(core), "tools", "publish", "cli.ts")}\n`);

    const badRun = Bun.spawnSync([process.execPath, HELPER, project], {
      env: { ...process.env, USERPROFILE: join(d, "nohome"), HOME: join(d, "nohome") },
    });
    expect(badRun.exitCode).toBe(1);
    expect(badRun.stdout.toString()).toBe("");
    expect(badRun.stderr.toString()).toContain("resolve-core:");
  });

  test("ignores a planted HARNESS_CORE_ALLOWLIST and exits 1 with empty stdout", () => {
    const d = scratch();
    const core = makeCore(d);
    const project = makeProject(d, core);
    const run = Bun.spawnSync([process.execPath, HELPER, project], {
      env: { ...process.env, HARNESS_CORE_ALLOWLIST: allowlist(d, [core]), USERPROFILE: join(d, "nohome"), HOME: join(d, "nohome") },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe("");
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
