// Live-process tests for the identity-string gate (issue #64):
// core/claude/hooks/identity-patterns.sh, shared by core/claude/hooks/
// pre-commit (the cheap, "an edit or an amend still fixes it" stage) and
// core/claude/hooks/pre-push (the authoritative whole-range sweep). Like
// pre-commit.test.ts, these build real temp git repos and exercise real git
// plumbing rather than unit-testing shell functions in isolation — the gate
// IS the plumbing (git var, git log, git cat-file, a real git push against
// a real bare remote).
//
// Every identifying string in these fixtures is synthetic. Never a real
// name, the real workstation username, or the real hostname: hardcoding the
// string this gate exists to catch, into a file this gate's own repository
// ships, is the exact recursive trap issue #64 is about.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const PRE_COMMIT_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "pre-commit");
const PRE_PUSH_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "pre-push");
const LIB_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "identity-patterns.sh");

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

function gitEnv(args: string[], cwd: string, env: Record<string, string | undefined>) {
  return Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
}

// A synthetic identity, shared by every test below. Disjoint from any real
// name/username/hostname and from anything a normal commit in THIS
// repository's own history would carry.
const fixtureDir = mkdtempSync(join(tmpdir(), "identity-gate-fixture-"));
const fixtureFile = join(fixtureDir, "identity.json");
writeFileSync(
  fixtureFile,
  JSON.stringify({ names: ["Fictional Persona"], emails: ["fictional.persona@example.test"] }),
);
const BASE_IDENTITY_ENV: Record<string, string> = {
  CLAUDE_IDENTITY_FILE: fixtureFile,
  IDENTITY_USERNAME_OVERRIDE: "identitygate-fixture-user",
  IDENTITY_HOSTNAME_OVERRIDE: "identitygate-fixture-host",
};

function envWith(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...process.env, ...BASE_IDENTITY_ENV, ...extra };
}

/**
 * A POSIX sh to run pre-commit with directly (mirrors pre-commit.test.ts).
 * pre-push tests below do not need this: they invoke the hook through a
 * real `git push`, which resolves and executes .git/hooks/pre-push via
 * git's own shebang handling rather than through an explicit `sh <path>`.
 */
let cachedSh: string | undefined;
let cachedShDir: string | undefined;

function posixSh(): string {
  if (cachedSh) return cachedSh;
  try {
    const probe = Bun.spawnSync(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    if (probe.success) return (cachedSh = "sh");
  } catch {
    // not on PATH; fall through to git's copy
  }
  const out = Bun.spawnSync(["git", "--exec-path"], { stdout: "pipe", stderr: "pipe" });
  const execPath = new TextDecoder().decode(out.stdout).trim();
  const root = execPath.replace(/[\\/](?:mingw\d*|usr|clang\d*)[\\/]libexec[\\/]git-core[\\/]?$/i, "");
  const candidate = join(root, "usr", "bin", "sh.exe");
  if (existsSync(candidate)) {
    cachedShDir = dirname(candidate);
    return (cachedSh = candidate);
  }
  throw new Error(`no POSIX sh found: not on PATH, and no sh.exe at ${candidate} (git --exec-path was "${execPath}")`);
}

function initPreCommitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "identity-precommit-"));
  tempDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  // Sync copy, not Bun.write: Bun.write resolves asynchronously, and the
  // pre-push counterpart below chmods its copy immediately afterward with
  // no `await` in between — a race that turned "no such file" ENOENT on
  // every single pre-push test until this was synchronous everywhere.
  copyFileSync(PRE_COMMIT_SRC, join(dir, ".claude", "hooks", "pre-commit"));
  copyFileSync(LIB_SRC, join(dir, ".claude", "hooks", "identity-patterns.sh"));
  return dir;
}

function runPreCommit(dir: string, env: Record<string, string | undefined>) {
  const sh = posixSh();
  const childEnv = cachedShDir
    ? { ...env, PATH: `${env.PATH ?? process.env.PATH ?? ""}${delimiter}${cachedShDir}` }
    : env;
  return Bun.spawnSync([sh, join(dir, ".claude", "hooks", "pre-commit")], {
    cwd: dir,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stageClean(dir: string, name = "notes.txt") {
  writeFileSync(join(dir, name), "totally unrelated clean prose about widgets\n");
  git(["add", name], dir);
}

describe("identity gate — pre-commit (cheap stage: content, pending author/committer, branch name)", () => {
  test("clean content and clean identity: the commit proceeds", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).toBe(0);
  });

  test("staged CONTENT carrying an identity string is refused, naming the file and line but never the value", () => {
    const dir = initPreCommitRepo();
    writeFileSync(join(dir, "notes.txt"), "this document mentions Fictional Persona by name\n");
    git(["add", "notes.txt"], dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("notes.txt");
    expect(stderr).toContain("identifying string");
    expect(stderr).not.toContain("Fictional Persona");
  });

  // The case that actually escaped (issue #64's why): thirty commits
  // carried a real name in author AND committer while a content-only scan
  // reported clean. `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT`
  // resolves exactly what THIS commit would use, env override included.
  test("AUTHOR identity carries the string while content is clean: refused", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ GIT_AUTHOR_NAME: "Fictional Persona" }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("author identity");
  });

  test("COMMITTER identity carries the string while content is clean: refused", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ GIT_COMMITTER_NAME: "Fictional Persona" }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("committer identity");
  });

  test("current branch name carrying the derived username is refused", () => {
    const dir = initPreCommitRepo();
    git(["checkout", "-q", "-b", "feature/identitygate-fixture-user-work"], dir);
    stageClean(dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("branch name");
  });

  test("gate exits non-zero when the identity file is missing — fail closed, never scans for nothing and reports clean", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ CLAUDE_IDENTITY_FILE: join(dir, "does-not-exist.json") }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no identity file at");
  });

  test("gate exits non-zero when the identity file is not JSON-shaped", () => {
    const dir = initPreCommitRepo();
    const badFile = join(dir, "bad-identity.json");
    writeFileSync(badFile, "not even json");
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ CLAUDE_IDENTITY_FILE: badFile }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("does not look like a JSON object");
  });

  // The positive control. A grep that always answers "no match", exactly
  // 2026-09-05's incident shape (MSYS grep -F aborted mid-scan and the
  // surrounding `|| echo NONE` printed a clean result over the crash), must
  // make the gate refuse rather than silently proceed as if the content and
  // metadata scans below it had genuinely found nothing.
  test("positive control: a broken matcher makes the gate fail rather than silently pass", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const stubDir = installBrokenGrepStub();
    const result = runPreCommit(dir, envWith({ PATH: pathWithStubFirst(stubDir) }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("did not find its own canary");
  });
});

/** Test double for `grep`: always reports "no match", exit 1, no matter
 * what it was asked to find — the shape of 2026-09-05's crashed-scan
 * incident, generalised to any matcher failure rather than the specific
 * grep -F bug that caused it that day. */
function installBrokenGrepStub(): string {
  const stubDir = mkdtempSync(join(tmpdir(), "identity-brokengrep-"));
  tempDirs.push(stubDir);
  const stubPath = join(stubDir, "grep");
  writeFileSync(stubPath, ["#!/bin/sh", "exit 1", ""].join("\n"));
  chmodSync(stubPath, 0o755);
  return stubDir;
}

function pathWithStubFirst(stubDir: string): string {
  const sep = process.platform === "win32" ? ";" : ":";
  return [stubDir, process.env.PATH ?? ""].join(sep);
}

function initBareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), "identity-remote-"));
  tempDirs.push(dir);
  git(["init", "-q", "--bare", dir], dir);
  return dir;
}

function initPrePushRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "identity-prepush-"));
  tempDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  git(["remote", "add", "origin", remote], dir);
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  copyFileSync(PRE_PUSH_SRC, join(dir, ".git", "hooks", "pre-push"));
  copyFileSync(LIB_SRC, join(dir, ".git", "hooks", "identity-patterns.sh"));
  chmodSync(join(dir, ".git", "hooks", "pre-push"), 0o755);
  return dir;
}

function commitClean(dir: string, name = "f.txt") {
  writeFileSync(join(dir, name), "clean prose, nothing identifying\n");
  git(["add", name], dir);
  git(["commit", "-q", "-m", "clean commit"], dir);
}

function push(dir: string, refspec: string, extraEnv: Record<string, string | undefined> = {}) {
  return gitEnv(["push", "origin", refspec], dir, envWith(extraEnv));
}

describe("identity gate — pre-push (authoritative whole-range sweep)", () => {
  test("clean range: the push proceeds", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    commitClean(dir);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).toBe(0);
  });

  test("channel 1 — CONTENT anywhere in the pushed range is refused", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    writeFileSync(join(dir, "f.txt"), "mentions Fictional Persona right here\n");
    git(["add", "f.txt"], dir);
    git(["commit", "-q", "-m", "content commit"], dir);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("content of one or more commits");
  });

  // The whole-range metadata sweep this hook exists for (issue #64):
  // catches a commit that ALREADY exists locally with a bad author or
  // committer field, which pre-commit's git-var check cannot — it only
  // ever sees the identity a NEW commit is about to use.
  test("channel 2 — AUTHOR or COMMITTER metadata already committed is refused, content clean", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    writeFileSync(join(dir, "f.txt"), "clean prose, nothing identifying\n");
    git(["add", "f.txt"], dir);
    const commitResult = gitEnv(
      ["commit", "-q", "-m", "bad author field"],
      dir,
      { ...process.env, GIT_AUTHOR_NAME: "Fictional Persona" },
    );
    expect(commitResult.exitCode).toBe(0);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("author or committer identity");
  });

  test("channel 3 — commit MESSAGE bodies are refused (git-filter-repo --replace-text does not rewrite these)", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    writeFileSync(join(dir, "f.txt"), "clean prose, nothing identifying\n");
    git(["add", "f.txt"], dir);
    git(["commit", "-q", "-m", "Note: mentions Fictional Persona in the message body"], dir);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("commit message");
  });

  test("channel 4 — destination BRANCH name carrying the derived username is refused, even via HEAD:<dest>", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    commitClean(dir);
    // HEAD:refs/heads/x sends the literal "HEAD" as the local ref; only the
    // remote-side name carries the identifying string. Regression coverage
    // for the bug this exact shape caught during manual verification.
    const result = push(dir, "HEAD:refs/heads/feature/identitygate-fixture-user-work");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("destination ref name");
  });

  test("channel 4 — an annotated TAG object's tagger identity or message is refused", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    commitClean(dir);
    git(["tag", "-a", "-m", "Tag note mentioning Fictional Persona", "v-test-1"], dir);
    const result = push(dir, "refs/tags/v-test-1");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("annotated tag object");
  });

  test("gate exits non-zero when the identity file is missing", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    commitClean(dir);
    const result = push(dir, "HEAD:refs/heads/main", { CLAUDE_IDENTITY_FILE: join(dir, "nope.json") });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no identity file at");
  });
});
