// Live-process tests for the git pre-commit hook
// (core/claude/hooks/pre-commit). Unlike the other hooks under test/, this
// one has no exported pure core to unit test — it is a POSIX shell script
// invoked by git, so these tests build real temp git repos and run it via
// `sh`, exercising git plumbing (`git diff --cached`, `git show`).
//
// A stub `vale` (installValeStub, below) stands in for the real binary on
// most tests: a fixed-size repo with no CI shouldn't go silently green on
// untested plumbing just because a contributor's machine lacks `vale`. The
// stub does simple substring matching, not real prose analysis, so it can
// still exercise "no finding ⇒ stay silent" alongside "finding ⇒ surface
// it" without depending on Vale's actual rule engine. Only the one test
// that asserts something about Vale's own judgment (clean-vs-flagged
// wording) runs against the real binary and is skipped without it.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOOK_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "pre-commit");
const valePath = Bun.which("vale");

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

/** A fresh repo with the hook installed at its real destination path. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "precommit-"));
  tempDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  Bun.write(join(dir, ".claude", "hooks", "pre-commit"), Bun.file(HOOK_SRC));
  return dir;
}

/** A Vale config pointing at the FLAG_TOKEN style below (real vale) — needed
 * even when a test uses the stub, since the hook checks a config file
 * exists before ever invoking vale_bin. */
const FLAG_TOKEN = "delve into";

function installValeConfig(dir: string) {
  const styleDir = join(dir, ".claude", "tools", "prose-lint", "styles", "Test");
  mkdirSync(styleDir, { recursive: true });
  writeFileSync(
    join(dir, ".claude", "tools", "prose-lint", ".vale.ini"),
    "StylesPath = styles\nMinAlertLevel = suggestion\n\n[*.md]\nBasedOnStyles = Test\n",
  );
  writeFileSync(
    join(styleDir, "Delve.yml"),
    `extends: existence\nmessage: "Avoid '%s'"\nlevel: suggestion\ntokens:\n  - ${FLAG_TOKEN}\n`,
  );
}

/** Test double for `vale`: greps the target file for FLAG_TOKEN and prints
 * one --output=line-shaped finding if present, nothing otherwise. Exercises
 * the hook's plumbing (staged-blob extraction, the `== $f ==` header,
 * always-exit-0) without depending on Vale's real rule engine. --config is
 * accepted and ignored, matching the real CLI's shape closely enough for
 * the hook's invocation to work unmodified. */
function installValeStub(): string {
  const stubDir = mkdtempSync(join(tmpdir(), "precommit-stub-"));
  tempDirs.push(stubDir);
  const stubPath = join(stubDir, "vale");
  writeFileSync(
    stubPath,
    [
      "#!/bin/sh",
      `# Test stub for vale — greps for "${FLAG_TOKEN}", prints a canned finding if found.`,
      'for arg in "$@"; do file="$arg"; done',
      `if grep -q "${FLAG_TOKEN}" "$file" 2>/dev/null; then`,
      '  echo "$file:1:1:Stub.Finding:stub finding"',
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(stubPath, 0o755);
  return stubDir;
}

function pathWithStubFirst(stubDir: string): string {
  const sep = process.platform === "win32" ? ";" : ":";
  return [stubDir, process.env.PATH ?? ""].join(sep);
}

/** PATH with vale's real directory stripped, so `command -v vale` fails even
 * on a machine that has it installed — used to exercise the missing-binary
 * path unconditionally. */
function pathWithoutVale(): string {
  const currentPath = process.env.PATH ?? "";
  if (!valePath) return currentPath;
  const valeDir = dirname(valePath).replace(/\\/g, "/");
  const sep = process.platform === "win32" ? ";" : ":";
  return currentPath
    .split(sep)
    .filter((p) => p.replace(/\\/g, "/") !== valeDir)
    .join(sep);
}

function runHook(dir: string, env: Record<string, string | undefined> = process.env) {
  // sh, not bash: the hook is written against POSIX sh and must not lean on
  // bash-only features.
  return Bun.spawnSync(["sh", join(dir, ".claude", "hooks", "pre-commit")], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("pre-commit hook — staged-markdown gate", () => {
  test("no staged markdown: silent no-op, exit 0", () => {
    const dir = initRepo();
    installValeConfig(dir);
    writeFileSync(join(dir, "app.js"), "console.log(1);\n");
    git(["add", "app.js"], dir);

    const result = runHook(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test("nothing staged at all: silent no-op, exit 0", () => {
    const dir = initRepo();
    installValeConfig(dir);

    const result = runHook(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });
});

describe("pre-commit hook — vale binary and config availability", () => {
  test("vale missing from PATH: exits 0, no output", () => {
    const dir = initRepo();
    installValeConfig(dir);
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(dir, { ...process.env, PATH: pathWithoutVale() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test("no Vale config reachable: exits 0, no output", () => {
    const dir = initRepo();
    const stubDir = installValeStub();
    // No installValeConfig() call — no project config, and HOME is pointed
    // at an empty dir so the global-kit fallback also misses.
    const fakeHome = mkdtempSync(join(tmpdir(), "precommit-home-"));
    tempDirs.push(fakeHome);
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir), HOME: fakeHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });
});

describe("pre-commit hook — lints the staged blob, not the working tree", () => {
  test("staged markdown with a known finding produces output", () => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeStub();
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("docs.md");
    expect(stderr).toContain("Stub.Finding");
  });

  test("finding survives a working-tree edit after staging", () => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeStub();
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");
    git(["add", "docs.md"], dir);
    // Rewrite the working tree to clean text WITHOUT re-staging — the index
    // still holds the flagged version, and that is what must get linted.
    writeFileSync(join(dir, "docs.md"), "This is clean prose with no flagged terms.\n");

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    const stderr = result.stderr.toString();
    expect(stderr).toContain("docs.md");
    expect(stderr).toContain("Stub.Finding");
  });

  test("staged-then-unstaged-edit with a clean staged version: no finding", () => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeStub();
    writeFileSync(join(dir, "docs.md"), "This is clean prose with no flagged terms.\n");
    git(["add", "docs.md"], dir);
    // The working tree now picks up the flagged phrase, but it was never
    // staged — the stub must see the clean staged blob, not this.
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test.skipIf(!valePath)("clean staged content, real vale: no finding, no output", () => {
    const dir = initRepo();
    installValeConfig(dir);
    writeFileSync(join(dir, "docs.md"), "This is clean prose with no flagged terms.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});

describe("pre-commit hook — staged filenames that need core.quotePath=false", () => {
  test("non-ASCII staged filename is linted, not mangled into a quoted literal", () => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeStub();
    const fname = "file_é.md";
    writeFileSync(join(dir, fname), "Let's delve into this topic.\n");
    git(["add", fname], dir);

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(fname);
    expect(stderr).toContain("Stub.Finding");
  });

  test("staged filename with a space is linted as one path, not split", () => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeStub();
    const fname = "my notes.md";
    writeFileSync(join(dir, fname), "Let's delve into this topic.\n");
    git(["add", fname], dir);

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(fname);
    expect(stderr).toContain("Stub.Finding");
  });
});
