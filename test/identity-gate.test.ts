// Live-process tests for the identity-string gate (issue #64):
// core/claude/hooks/identity-patterns.sh, shared by core/claude/hooks/
// pre-commit (the cheap, "an edit or an amend still fixes it" stage) and
// core/claude/hooks/pre-push (the authoritative whole-range sweep). Like
// pre-commit.test.ts, these build real temp git repos and exercise real git
// plumbing rather than unit-testing shell functions in isolation — the gate
// IS the plumbing (git var, git log, git rev-list, git cat-file, a real git
// push against a real bare remote).
//
// Every identifying string in these fixtures is synthetic. Never a real
// name, the real workstation username, or the real hostname: hardcoding the
// string this gate exists to catch, into a file this gate's own repository
// ships, is the exact recursive trap issue #64 is about.
//
// IDENTITY RESOLUTION IN THESE TESTS EXERCISES THE PRODUCTION PATH. An
// earlier revision pointed the gate at a fixture via CLAUDE_IDENTITY_FILE /
// IDENTITY_USERNAME_OVERRIDE / IDENTITY_HOSTNAME_OVERRIDE, three env vars
// identity-patterns.sh read ahead of its real sources and labelled "test
// seams, not operator-facing knobs" — a label nothing enforced, since
// pointing CLAUDE_IDENTITY_FILE at an empty file disabled every channel in
// production too, silently, with the hook still reporting success. Those
// vars no longer exist. Every test below sets USERPROFILE (and HOME, so
// Git-Bash-on-Windows's real-profile-vs-Documents-subfolder split can't
// matter) to a fixture directory holding a real .claude-account-identity.json,
// and sets USERNAME/COMPUTERNAME directly — both already read by the real
// code, so no knob is needed to control them either.

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
const NAME = "Fictional Persona";
const EMAIL = "fictional.persona@example.test";

/** Creates a fixture "home" directory holding .claude-account-identity.json
 * with the given raw content (or no file at all, when content is null),
 * suitable for USERPROFILE/HOME. Registered for cleanup. */
function makeIdentityHome(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "identity-home-"));
  tempDirs.push(dir);
  if (content !== null) {
    writeFileSync(join(dir, ".claude-account-identity.json"), content);
  }
  return dir;
}

const BASE_IDENTITY_HOME = makeIdentityHome(JSON.stringify({ names: [NAME], emails: [EMAIL] }));
// Not pushed onto tempDirs's per-test cleanup: this one has to survive the
// whole suite, the same way the old fixtureDir did.
tempDirs.pop();

const BASE_IDENTITY_ENV: Record<string, string> = {
  USERPROFILE: BASE_IDENTITY_HOME,
  HOME: BASE_IDENTITY_HOME,
  USERNAME: "identitygate-fixture-user",
  COMPUTERNAME: "identitygate-fixture-host",
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

describe("identity gate — pre-commit (cheap stage: content, path, pending author/committer, branch name)", () => {
  test("clean content and clean identity: the commit proceeds", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).toBe(0);
  });

  test("staged CONTENT carrying an identity string is refused, naming the file and line but never the value", () => {
    const dir = initPreCommitRepo();
    writeFileSync(join(dir, "notes.txt"), `this document mentions ${NAME} by name\n`);
    git(["add", "notes.txt"], dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("notes.txt");
    expect(stderr).toContain("identifying string");
    expect(stderr).not.toContain(NAME);
  });

  // Bypass 12 (attack report 2026-09-05): pre-commit read blob bodies but
  // never looked at the paths it iterated over, so a clean-content file
  // with an identifying PATH committed without complaint.
  test("a staged file's PATH alone (clean content) is refused, and the path itself is never printed", () => {
    const dir = initPreCommitRepo();
    mkdirSync(join(dir, "docs"), { recursive: true });
    // The declared name has a space; a path segment can't, so this uses the
    // derived username instead — same channel, same identity_match call.
    writeFileSync(join(dir, "docs", "identitygate-fixture-user-handover.md"), "totally clean prose, nothing identifying inside\n");
    git(["add", "docs"], dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("path carries an identifying string");
    expect(stderr).not.toContain("identitygate-fixture-user-handover.md");
  });

  // The case that actually escaped (issue #64's why): thirty commits
  // carried a real name in author AND committer while a content-only scan
  // reported clean. `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT`
  // resolves exactly what THIS commit would use, env override included.
  test("AUTHOR identity carries the string while content is clean: refused", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ GIT_AUTHOR_NAME: NAME }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("author identity");
  });

  test("COMMITTER identity carries the string while content is clean: refused", () => {
    const dir = initPreCommitRepo();
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ GIT_COMMITTER_NAME: NAME }));
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
    const missingHome = makeIdentityHome(null);
    const result = runPreCommit(dir, envWith({ USERPROFILE: missingHome, HOME: missingHome }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no identity file at");
  });

  // Found by running the gate rather than by reading it. The count check that
  // rejects an empty pattern set fires only when the WHOLE set is empty, and
  // the username and hostname arms always contribute because they come from
  // the environment. So a file declaring no names and no emails still built a
  // pattern, still passed the canary, and allowed a commit whose content
  // carried the name that file was supposed to name. The name is the channel
  // that leaked thirty commits on 2026-09-05.
  test("gate exits non-zero when the identity file parses but declares no names and no emails", () => {
    const dir = initPreCommitRepo();
    const emptyHome = makeIdentityHome(JSON.stringify({ names: [], emails: [] }));
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ USERPROFILE: emptyHome, HOME: emptyHome }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("declares no names and no emails");
  });

  test("gate exits non-zero when the identity file is not JSON-shaped", () => {
    const dir = initPreCommitRepo();
    const badHome = makeIdentityHome("not even json");
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ USERPROFILE: badHome, HOME: badHome }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("does not look like a JSON object");
  });

  // Bypass 10 (attack report 2026-09-05): CLAUDE_IDENTITY_FILE used to be
  // read ahead of USERPROFILE/HOME, so pointing it at a decoy file disabled
  // every channel silently while the hook still reported success. The var
  // no longer exists in identity-patterns.sh at all; this pins that a stray
  // instance of it in a caller's environment (e.g. left over from an older
  // shell profile) has no effect whatsoever.
  test("CLAUDE_IDENTITY_FILE has no effect: the removed seam cannot redirect the gate to a decoy file", () => {
    const dir = initPreCommitRepo();
    const decoyHome = makeIdentityHome(JSON.stringify({ names: ["Nobody At All"], emails: ["nobody@example.invalid"] }));
    writeFileSync(join(dir, "notes.txt"), `this document mentions ${NAME} by name\n`);
    git(["add", "notes.txt"], dir);
    const result = runPreCommit(
      dir,
      envWith({ CLAUDE_IDENTITY_FILE: join(decoyHome, ".claude-account-identity.json") }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });

  // Bypass 9 (attack report 2026-09-05): a declared entry with a non-word
  // character at either edge (here, a whole author line pasted into
  // "names") builds a \b-anchored pattern arm that can never match
  // anything, while identity_load used to report healthy regardless.
  test("a declared name with a non-word character at its edge (a pasted author line) fails the load, fail-closed", () => {
    const dir = initPreCommitRepo();
    const deadArmHome = makeIdentityHome(
      JSON.stringify({ names: [`${NAME} <${EMAIL}>`], emails: [] }),
    );
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ USERPROFILE: deadArmHome, HOME: deadArmHome }));
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("not a word character");
    expect(stderr).not.toContain(NAME);
  });

  // Same finding, different edge: a trailing space is just as dead an arm,
  // and (per the attack report) is the subtler variant — it still matches
  // mid-sentence text, so a content-scan smoke test alone would not catch
  // it, only checking the declared entry's own edges does.
  test("a declared name with a trailing space fails the load, fail-closed", () => {
    const dir = initPreCommitRepo();
    const trailingSpaceHome = makeIdentityHome(JSON.stringify({ names: [`${NAME} `], emails: [] }));
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ USERPROFILE: trailingSpaceHome, HOME: trailingSpaceHome }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not a word character");
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
    expect(result.stderr.toString()).toContain("canary");
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
  git(["init", "-q", "--bare", "-b", "main", dir], dir);
  return dir;
}

function initPrePushRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "identity-prepush-"));
  tempDirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
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
    writeFileSync(join(dir, "f.txt"), `mentions ${NAME} right here\n`);
    git(["add", "f.txt"], dir);
    git(["commit", "-q", "-m", "content commit"], dir);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("content of one or more commits");
  });

  // Bypass 12's push-stage counterpart, and its own channel: rev-list's
  // object listing carries the path of every new blob/tree, checked
  // explicitly rather than relying on a diff header to expose it by
  // accident.
  test("channel 1 (path half) — an identifying PATH anywhere in the pushed range is refused, content clean", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "identitygate-fixture-user-handover.md"), "clean prose, nothing identifying inside\n");
    git(["add", "docs"], dir);
    git(["commit", "-q", "-m", "handover doc"], dir);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("path of one or more objects");
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
      { ...process.env, GIT_AUTHOR_NAME: NAME },
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
    git(["commit", "-q", "-m", `Note: mentions ${NAME} in the message body`], dir);
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
    git(["tag", "-a", "-m", `Tag note mentioning ${NAME}`, "v-test-1"], dir);
    const result = push(dir, "refs/tags/v-test-1");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("annotated tag object");
  });

  // Side effect of the channel-1 rewrite (git rev-list --objects instead of
  // git log -p), not one of the twelve numbered bypasses: `git log -p`
  // shows no diff at all for a merge commit without -m/-c, so a conflict
  // resolution that hand-types content matching neither parent used to be
  // invisible to the content channel. rev-list walks each commit's actual
  // tree rather than a diff against a parent, so that same new blob is
  // just another object newly reachable in the range. Pinned here because
  // the header comment above now claims this closed; a claim like that
  // needs a test, not just a comment.
  test("a merge commit's hand-typed conflict resolution (absent from every parent) is still caught", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    writeFileSync(join(dir, "f.txt"), "base\n");
    git(["add", "f.txt"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    push(dir, "HEAD:refs/heads/main");

    git(["checkout", "-q", "-b", "branchA"], dir);
    writeFileSync(join(dir, "f.txt"), "branchA change\n");
    git(["commit", "-q", "-am", "branchA change"], dir);

    git(["checkout", "-q", "main"], dir);
    writeFileSync(join(dir, "f.txt"), "main change\n");
    git(["commit", "-q", "-am", "main change"], dir);

    git(["checkout", "-q", "branchA"], dir);
    git(["merge", "main"], dir); // conflicts; leaves f.txt with conflict markers

    writeFileSync(join(dir, "f.txt"), `Maintainer: ${NAME} <${EMAIL}>\n`);
    git(["add", "f.txt"], dir);
    git(["commit", "-q", "--no-verify", "-m", "resolve conflict"], dir);

    const result = push(dir, "branchA:refs/heads/branchA");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("content of one or more commits");
  });

  test("gate exits non-zero when the identity file is missing", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    commitClean(dir);
    const missingHome = makeIdentityHome(null);
    const result = push(dir, "HEAD:refs/heads/main", { USERPROFILE: missingHome, HOME: missingHome });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no identity file at");
  });

  // Bypass 1 (attack report 2026-09-05): every range check reads history
  // through `git log`/`git rev-list`, both of which honour refs/replace/*
  // by default, while the object transfer to the remote does not. A
  // replace ref pointed at a clean stand-in made every channel read the
  // stand-in while the real commit shipped. GIT_NO_REPLACE_OBJECTS=1,
  // exported at the top of pre-push, is the fix under test.
  test("bypass 1 — a `git replace` pointing at a clean stand-in does not launder the real commit", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    commitClean(dir, "seed.txt");
    const seed = git(["rev-parse", "HEAD"], dir).stdout.toString().trim();
    const seedTree = git(["rev-parse", "HEAD^{tree}"], dir).stdout.toString().trim();

    writeFileSync(join(dir, "AUTHORS"), `Maintainer: ${NAME} <${EMAIL}>\n`);
    git(["add", "AUTHORS"], dir);
    gitEnv(
      ["commit", "-q", "--no-verify", "-m", `release cut by ${NAME}`],
      dir,
      { ...process.env, GIT_AUTHOR_NAME: NAME, GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: NAME, GIT_COMMITTER_EMAIL: EMAIL },
    );
    const dirty = git(["rev-parse", "HEAD"], dir).stdout.toString().trim();

    const cleanC = gitEnv(
      ["commit-tree", seedTree, "-p", seed, "-m", "routine release"],
      dir,
      { ...process.env, GIT_AUTHOR_NAME: "tester", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "tester", GIT_COMMITTER_EMAIL: "t@t.invalid" },
    ).stdout.toString().trim();
    git(["replace", dirty, cleanC], dir);

    const result = push(dir, `${dirty}:refs/heads/main`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });

  // Bypass 2 (attack report 2026-09-05): git hands the hook the remote's
  // actual current oid. If this clone never fetched it (a second clone
  // advanced the remote, or a force push claims a tip that never existed
  // here), `git log <that-oid>..<local>` used to be an invalid revision
  // range: stderr discarded, output empty, every consumer guarded by
  // `[ -n "$..." ]` reading that identically to "range is clean". Fixed by
  // verifying the remote oid with `git cat-file -e` and falling back to the
  // same conservative range a brand-new ref gets when it does not resolve.
  test("bypass 2 — a force push whose remote tip this clone never fetched is still scanned, not skipped", () => {
    const remote = initBareRemote();
    const cloneA = mkdtempSync(join(tmpdir(), "identity-forcepush-a-"));
    tempDirs.push(cloneA);
    git(["init", "-q", "-b", "main"], cloneA);
    git(["config", "user.email", "t@t"], cloneA);
    git(["config", "user.name", "t"], cloneA);
    git(["remote", "add", "origin", remote], cloneA);
    commitClean(cloneA);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneA);

    // A second, independent clone advances main. Clone A never fetches this.
    const cloneB = mkdtempSync(join(tmpdir(), "identity-forcepush-b-"));
    tempDirs.push(cloneB);
    git(["clone", "-q", remote, cloneB], cloneB);
    git(["config", "user.email", "t@t"], cloneB);
    git(["config", "user.name", "t"], cloneB);
    commitClean(cloneB, "g.txt");
    const pushB = git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);
    expect(pushB.exitCode).toBe(0);
    const remoteTip = git(["rev-parse", "HEAD"], cloneB).stdout.toString().trim();

    // Clone A's own copy genuinely lacks that object.
    const catFile = git(["cat-file", "-e", remoteTip], cloneA);
    expect(catFile.exitCode).not.toBe(0);

    // Wire the hook into clone A only now, so clone B's own push above
    // (irrelevant to what's under test) was never hook-gated.
    mkdirSync(join(cloneA, ".git", "hooks"), { recursive: true });
    copyFileSync(PRE_PUSH_SRC, join(cloneA, ".git", "hooks", "pre-push"));
    copyFileSync(LIB_SRC, join(cloneA, ".git", "hooks", "identity-patterns.sh"));
    chmodSync(join(cloneA, ".git", "hooks", "pre-push"), 0o755);

    writeFileSync(join(cloneA, "AUTHORS"), `Maintainer: ${NAME} <${EMAIL}>\n`);
    git(["add", "AUTHORS"], cloneA);
    git(["commit", "-q", "--no-verify", "-m", `add AUTHORS mentioning ${NAME}`], cloneA);

    // --force, since cloneA and the remote have diverged (that divergence,
    // unfetched by cloneA, is exactly the scenario under test).
    const forced = gitEnv(["push", "--force", "origin", "HEAD:refs/heads/main"], cloneA, envWith());
    expect(forced.exitCode).not.toBe(0);
    expect(forced.stderr.toString()).toContain("identifying string");
  });

  // Bypass 3 (attack report 2026-09-05): for a brand-new ref, the range was
  // bare `<local> --not --remotes`, which excludes anything reachable from
  // ANY remote-tracking ref in the clone — a second remote, a fork, or a
  // stale tracking ref, the ordinary reason such a ref exists at all, not
  // an attack on its own. Fixed by scoping to `--remotes=<actual remote
  // name>`, so only tracking refs for the destination remote get excluded.
  test("bypass 3 — a stray tracking ref under an unrelated remote name does not empty the new-branch scan", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    writeFileSync(join(dir, "AUTHORS"), `Maintainer: ${NAME} <${EMAIL}>\n`);
    git(["add", "AUTHORS"], dir);
    git(["commit", "-q", "--no-verify", "-m", `add AUTHORS with ${NAME} in the message too`], dir);
    const dirty = git(["rev-parse", "HEAD"], dir).stdout.toString().trim();

    const control = push(dir, "HEAD:refs/heads/attempt1");
    expect(control.exitCode).not.toBe(0);

    // A stray tracking ref under a completely different remote name than
    // "origin" — `git update-ref` is the shortest reproduction; an ordinary
    // `git fetch` of any second remote produces the same ref shape.
    git(["update-ref", "refs/remotes/upstream/old", dirty], dir);

    const attack = push(dir, "HEAD:refs/heads/attempt2");
    expect(attack.exitCode).not.toBe(0);
    expect(attack.stderr.toString()).toContain("identifying string");
  });
});

describe("identity gate — identity-patterns.sh: per-arm canary (bypass 9's other half)", () => {
  // identity_control now proves EVERY declared arm, not only the username.
  // Even with identity_edge_ok's own load-time rejection stubbed out (as if
  // it did not exist), a dead arm — one whose first or last character
  // breaks \b — still fails the per-entry canary, because the canary for
  // that exact entry can never match either. Exercised at the pre-commit
  // level with a clean commit, since either failure (edge check OR canary)
  // must refuse before content is ever scanned.
  test("a dead arm fails identity_control even independent of the edge check catching it at load", () => {
    const dir = initPreCommitRepo();
    const deadArmHome = makeIdentityHome(
      JSON.stringify({ names: [`${NAME} <${EMAIL}>`], emails: [] }),
    );
    stageClean(dir);
    const result = runPreCommit(dir, envWith({ USERPROFILE: deadArmHome, HOME: deadArmHome }));
    // identity_edge_ok rejects this at load in the current code; this test
    // is pinned on the observable outcome (refused, fail-closed) rather
    // than on which of the two independent mechanisms fired, so it stays
    // meaningful if the load-time check is ever loosened.
    expect(result.exitCode).not.toBe(0);
  });
});

// Bypasses 4, 5 (three variants), 6, 7 and 11 (attack report 2026-09-05) are
// one defect wearing five costumes: the content channel used to ask git for
// a DIFF (`git diff --cached --numstat` per file in pre-commit, `git log -p`
// over the range in pre-push), and a diff inherits every knob that decides
// binary-or-text before it can show anything. Reading blob bytes directly
// (`git show ":$f"` / `git rev-list --objects` + `git cat-file --batch`)
// closes all five at once, and that is what this describe block pins: one
// fix, five failing-without-it regression tests.
describe("identity gate — content channel reads blob bytes, not a diff (bypasses 4, 5, 6, 7, 11)", () => {
  test("bypass 4 — a leading NUL byte does not hide identifying content from pre-commit", () => {
    const dir = initPreCommitRepo();
    // Git's own binary heuristic (first ~8000 bytes scanned for a NUL)
    // reports this file as binary; `git diff --numstat` used to print
    // "-\t-\t<path>" for it and the old per-file check skipped it outright.
    writeFileSync(join(dir, "CONTRIBUTORS.md"), `\0\nMaintainer: ${NAME} <${EMAIL}>\nEmail him about the release.\n`);
    git(["add", "CONTRIBUTORS.md"], dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });

  test("bypass 5 — a `.gitattributes` entry marking the path `-diff` does not hide its content", () => {
    const dir = initPreCommitRepo();
    writeFileSync(join(dir, ".gitattributes"), "notes.md -diff\n");
    writeFileSync(join(dir, "notes.md"), `Maintainer: ${NAME} <${EMAIL}>\n`);
    git(["add", ".gitattributes", "notes.md"], dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });

  test("bypass 5 — an UNTRACKED .git/info/attributes marking the path `-diff` does not hide its content", () => {
    const dir = initPreCommitRepo();
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "attributes"), "notes.md -diff\n");
    writeFileSync(join(dir, "notes.md"), `Maintainer: ${NAME} <${EMAIL}>\n`);
    git(["add", "notes.md"], dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });

  test("bypass 6 — a shrunk core.bigFileThreshold does not hide content", () => {
    const dir = initPreCommitRepo();
    const padding = Array.from({ length: 40 }, (_, i) => `padding line ${i} to push the file past the shrunk threshold`).join("\n");
    writeFileSync(join(dir, "AUTHORS.md"), `Maintainer: ${NAME} <${EMAIL}>\n${padding}\n`);
    git(["add", "AUTHORS.md"], dir);
    // The env-var form of `git -c core.bigFileThreshold=512`, since these
    // tests invoke the hook script directly rather than through a `git
    // commit` parent process that would set GIT_CONFIG_PARAMETERS itself.
    // Measured equivalent in the attack report: same effect, no shell
    // command line involved.
    const result = runPreCommit(
      dir,
      envWith({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bigFileThreshold",
        GIT_CONFIG_VALUE_0: "512",
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });

  test("bypass 7 — a typechange (symlink -> regular file) is not exempt from --diff-filter", () => {
    const dir = initPreCommitRepo();
    // update-index --cacheinfo, not an actual symlink: runs identically on
    // Windows, where core.symlinks is typically off. On a POSIX checkout
    // `rm link && echo ... > AUTHORS` produces the identical T status.
    const linkBlob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: dir, stdin: Buffer.from("README.md") })
      .stdout.toString()
      .trim();
    git(["update-index", "--add", "--cacheinfo", `120000,${linkBlob},AUTHORS`], dir);
    git(["commit", "-q", "-m", "seed with symlink"], dir);

    const dirtyBlob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
      cwd: dir,
      stdin: Buffer.from(`Maintainer: ${NAME} <${EMAIL}>\n`),
    })
      .stdout.toString()
      .trim();
    git(["update-index", "--cacheinfo", `100644,${dirtyBlob},AUTHORS`], dir);
    const status = git(["diff", "--cached", "--name-status"], dir).stdout.toString().trim();
    expect(status).toBe("T\tAUTHORS");
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });

  test("bypass 11 — a bracket in one staged filename does not make the binary check answer for a different file", () => {
    const dir = initPreCommitRepo();
    // A bracket in "note[1].md" makes it a glob; a pathspec-taking git diff
    // call for that literal name can match "note1.md" instead. Reading
    // every staged blob unconditionally (no numstat pre-check, no pathspec
    // argument at all) removes the ambiguity rather than resolving it.
    writeFileSync(join(dir, "note1.md"), "PNG\0\0\0binary junk\0\0");
    writeFileSync(join(dir, "note[1].md"), `Maintainer: ${NAME} <${EMAIL}>\n`);
    git(["add", "note1.md", "note[1].md"], dir);
    const result = runPreCommit(dir, envWith());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("identifying string");
  });
});

// pre-push's rewrite of the same channel (git rev-list --objects + git
// cat-file --batch, replacing git log -p) needs its own regression coverage
// for the same family, since the mechanism differs at that stage even
// though the defect class is identical.
describe("identity gate — pre-push content channel also reads blob bytes, not a diff", () => {
  test("a leading NUL byte in the pushed range does not hide identifying content", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    writeFileSync(join(dir, "CONTRIBUTORS.md"), `\0\nMaintainer: ${NAME} <${EMAIL}>\nEmail him about the release.\n`);
    git(["add", "CONTRIBUTORS.md"], dir);
    git(["commit", "-q", "--no-verify", "-m", "add contributors"], dir);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("content of one or more commits");
  });

  test("a typechange already committed locally (--no-verify) is still caught at push", () => {
    const remote = initBareRemote();
    const dir = initPrePushRepo(remote);
    const linkBlob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: dir, stdin: Buffer.from("README.md") })
      .stdout.toString()
      .trim();
    git(["update-index", "--add", "--cacheinfo", `120000,${linkBlob},AUTHORS`], dir);
    git(["commit", "-q", "--no-verify", "-m", "seed with symlink"], dir);
    const dirtyBlob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
      cwd: dir,
      stdin: Buffer.from(`Maintainer: ${NAME} <${EMAIL}>\n`),
    })
      .stdout.toString()
      .trim();
    git(["update-index", "--cacheinfo", `100644,${dirtyBlob},AUTHORS`], dir);
    git(["commit", "-q", "--no-verify", "-m", "convert AUTHORS to a real file"], dir);
    const result = push(dir, "HEAD:refs/heads/main");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("content of one or more commits");
  });
});
