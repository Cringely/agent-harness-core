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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const HOOK_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "pre-commit");
const IDENTITY_LIB_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "identity-patterns.sh");
const valePath = Bun.which("vale");

// Every case in this file spawns real processes: initRepo() runs `git init`
// plus two `git config` calls, and runHook() runs the hook itself through
// `sh`, which in turn shells out to grep/sed/git diff/git show. None of that
// is pure-function work, so (unlike session-start-drift-check.test.ts) there
// is no cheap subset here left on bun's 5000ms default — every test below
// gets this one.
//
// Measured 2026-09-09 on this workstation with `bun test --timeout=60000
// --reporter=junit` (so nothing truncates at the old default), two
// consecutive runs: per-case wall time ranged 4.7s-10.4s, file total
// 208s-213s for 27 cases. The two cases under 5s were the two that skip
// both installValeConfig() and installValeStub() (no config file, no stub
// binary to spawn); every case that installs the config and/or the stub
// cleared 5s outright — that's the flake #107 was filed over, not a couple
// of outliers. 30s is roughly 3x the worst case observed, enough headroom
// to absorb this machine's routine background load (#107 itself reproduced
// worse numbers while a second `bun test` was running in another worktree)
// without being sized to hide a genuine hang.
const HOOK_TIMEOUT_MS = 30_000;

// pre-commit now runs an identity-string gate (see identity-gate.test.ts)
// unconditionally, before Vale ever runs, and refuses to proceed at all if
// its pattern file can't be loaded. None of the tests in THIS file exercise
// that gate; they need it to load cleanly and find nothing so Vale's own
// behaviour is what's actually under test.
//
// The gate resolves its identity file from ${USERPROFILE:-$HOME}, the same
// variables this file's own Vale-config tests already manipulate to probe
// project-vs-global config resolution. There is no separate env-var knob
// (CLAUDE_IDENTITY_FILE) to decouple the two anymore — an earlier revision
// had one, labelled a test seam, and it turned out to double as a
// production bypass (identity-gate.test.ts's "CLAUDE_IDENTITY_FILE has no
// effect" pins the fix). So every runHook() call here forces HOME and
// USERPROFILE to a fixture directory holding a real
// .claude-account-identity.json, by default the same directory for both.
// Tests that need to probe global-vs-project Vale config resolution pass
// their own { home, userProfile } to keep exercising THAT precedence
// without losing a loadable identity file at whichever one wins.
function writeIdentityFixture(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude-account-identity.json"),
    JSON.stringify({ names: ["Fixture Person"], emails: ["fixture@example.test"] }),
  );
}
const DEFAULT_IDENTITY_HOME = mkdtempSync(join(tmpdir(), "precommit-identity-home-"));
writeIdentityFixture(DEFAULT_IDENTITY_HOME);

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
  Bun.write(join(dir, ".claude", "hooks", "identity-patterns.sh"), Bun.file(IDENTITY_LIB_SRC));
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

/**
 * A POSIX sh to run the hook with. Bare "sh" is right on Unix and on Git Bash,
 * but a PowerShell or cmd session on Windows has no sh on PATH, and the whole
 * suite then fails 10 tests for a reason that has nothing to do with the hook.
 * Git ships one, so fall back to it, located from `git --exec-path` rather than
 * a hardcoded Program Files path so it survives a non-default install.
 */
let cachedSh: string | undefined;
/**
 * Directory holding the fallback sh, or undefined when sh came from PATH. The
 * hook itself calls grep, sed and friends, and on Windows those live beside the
 * bundled sh rather than on PATH, so the child needs this appended or the hook
 * runs but its own subprocesses do not.
 */
let cachedShDir: string | undefined;

function posixSh(): string {
  if (cachedSh) return cachedSh;
  try {
    // Bun signals a missing binary by throwing on some platforms and by
    // returning success:false on others, so check both.
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

function runHook(
  dir: string,
  env: Record<string, string | undefined> = process.env,
  identityHome: { home?: string; userProfile?: string } = {},
) {
  // sh, not bash: the hook is written against POSIX sh and must not lean on
  // bash-only features.
  const sh = posixSh();
  // HOME/USERPROFILE are always explicit, never inherited from `env`
  // (typically `{ ...process.env, ... }`): the gate resolves its identity
  // file from ${USERPROFILE:-$HOME}, so leaving either one to the real
  // machine's value would make a test's outcome depend on whether this
  // machine happens to have a real .claude-account-identity.json. Default
  // is DEFAULT_IDENTITY_HOME for both; a test probing Vale's global-config
  // fallback (which reads the same two vars) passes its own fixture homes.
  const home = identityHome.home ?? DEFAULT_IDENTITY_HOME;
  const userProfile = identityHome.userProfile ?? home;
  const childEnv = cachedShDir
    ? { ...env, PATH: `${env.PATH ?? process.env.PATH ?? ""}${delimiter}${cachedShDir}`, HOME: home, USERPROFILE: userProfile }
    : { ...env, HOME: home, USERPROFILE: userProfile };
  return Bun.spawnSync([sh, join(dir, ".claude", "hooks", "pre-commit")], {
    cwd: dir,
    env: childEnv,
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
  }, HOOK_TIMEOUT_MS);

  test("nothing staged at all: silent no-op, exit 0", () => {
    const dir = initRepo();
    installValeConfig(dir);

    const result = runHook(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  }, HOOK_TIMEOUT_MS);
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
  }, HOOK_TIMEOUT_MS);

  test("no Vale config reachable: exits 0, names where it looked on stderr", () => {
    const dir = initRepo();
    const stubDir = installValeStub();
    // No installValeConfig() call — no project config. Both HOME and
    // USERPROFILE point at an empty (but identity-loadable) dir so the
    // global-kit fallback misses regardless of which one the hook prefers.
    const fakeHome = mkdtempSync(join(tmpdir(), "precommit-home-"));
    tempDirs.push(fakeHome);
    writeIdentityFixture(fakeHome);
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(
      dir,
      { ...process.env, PATH: pathWithStubFirst(stubDir) },
      { home: fakeHome, userProfile: fakeHome },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("no Vale config found");
  }, HOOK_TIMEOUT_MS);

  test("USERPROFILE (Windows profile) wins over a HOME that doesn't hold the kit", () => {
    const dir = initRepo();
    const stubDir = installValeStub();
    // Simulates Git Bash on Windows, where $HOME can resolve to a Documents
    // subfolder while $USERPROFILE is the real profile holding the kit.
    // The identity gate resolves ${USERPROFILE:-$HOME} too, so USERPROFILE
    // is the one that needs the fixture; fakeHome is never actually read
    // while USERPROFILE is set, for either purpose.
    const fakeUserProfile = mkdtempSync(join(tmpdir(), "precommit-userprofile-"));
    tempDirs.push(fakeUserProfile);
    const fakeHome = mkdtempSync(join(tmpdir(), "precommit-home-"));
    tempDirs.push(fakeHome);
    installValeConfig(fakeUserProfile);
    writeIdentityFixture(fakeUserProfile);
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(
      dir,
      { ...process.env, PATH: pathWithStubFirst(stubDir) },
      { home: fakeHome, userProfile: fakeUserProfile },
    );
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("docs.md");
    expect(stderr).toContain("Stub.Finding");
  }, HOOK_TIMEOUT_MS);
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
  }, HOOK_TIMEOUT_MS);

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
  }, HOOK_TIMEOUT_MS);

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
  }, HOOK_TIMEOUT_MS);

  test.skipIf(!valePath)("clean staged content, real vale: no finding, no output", () => {
    const dir = initRepo();
    installValeConfig(dir);
    writeFileSync(join(dir, "docs.md"), "This is clean prose with no flagged terms.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  }, HOOK_TIMEOUT_MS);
});

/** Write `relPath` (creating parents) and stage exactly that path. */
function stageMarkdown(dir: string, relPath: string, body: string) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  git(["add", "--", relPath], dir);
}

const FLAGGED_BODY = `Let's ${FLAG_TOKEN} this topic.\n`;

// The account-layer exemption, mirrored here so a project inherits the same
// answer from both hooks. Every file staged below CONTAINS the flag token, so
// empty stderr can only mean the path was excluded — a clean file would prove
// nothing. Keyed on the repo-relative path, the only path this hook has: the
// blob it actually lints sits at "$scratch_dir/$f" under a mktemp root, so no
// absolute-prefix exclusion could ever match here.
describe("pre-commit hook — internal agent traffic is exempt", () => {
  test.each([
    ".claude/notes.md",
    ".claude/docs/notes.md",
    "memory/note.md",
    "handoffs/2026-08-10-session.md",
    "docs/handoffs/2026-08-10-session.md",
    "scratchpad/plan.md",
    ".scratch/probe.md",
    // The subagent-driven-development workspace. Usually gitignored, so this
    // hook rarely sees it — force-add one and it must still be exempt, and the
    // three prose-lint mechanisms carry one exemption set by contract.
    ".superpowers/sdd/2026-09-03-account-layer/task-1-report.md",
    "council-transcripts/2026-08-01-scope.md",
  ])("staged %s is not linted", (relPath) => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeStub();
    stageMarkdown(dir, relPath, FLAGGED_BODY);

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    expect(result.stderr.toString()).toBe("");
  }, HOOK_TIMEOUT_MS);
});

// The other half. A deliverable whose name merely contains an exempt word, and
// a path outside docs/ entirely, both still lint — the second because this hook
// has no allowlist and must not grow one by accident.
describe("pre-commit hook — the exemption is segment-anchored, not substring", () => {
  // docs/superpowers/ is the dot's whole job: a repository commits plans and
  // specs there, and a dotless `superpowers/` arm would silence them along with
  // the .superpowers/ workspace above.
  test.each([
    "docs/guide.md",
    "docs/memory-system.md",
    "docs/claude-setup.md",
    "notes/scratch.md",
    "docs/superpowers/plans/2026-09-03-account-layer-portability.md",
  ])(
    "staged %s is still linted",
    (relPath) => {
      const dir = initRepo();
      installValeConfig(dir);
      const stubDir = installValeStub();
      stageMarkdown(dir, relPath, FLAGGED_BODY);

      const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
      expect(result.stderr.toString()).toContain(relPath);
    },
    HOOK_TIMEOUT_MS,
  );
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
  }, HOOK_TIMEOUT_MS);

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
  }, HOOK_TIMEOUT_MS);
});

// The identity gate deliberately never prints a matched value. Vale runs
// after it and echoes finding text (a quoted excerpt plus the rule's own
// message) straight to stderr, which is fine for ordinary findings but
// would undo the gate's own restraint if a finding's text ever carried an
// identifying string — measured against a live content-channel bypass in
// the attack report this fix responds to (now closed on every known
// vector; see identity-gate.test.ts's "content channel reads blob bytes"
// describe block). This is the belt for that suspenders: whatever produces
// the finding text, if it carries an identifying string, it gets withheld
// rather than printed.
describe("pre-commit hook — Vale findings never leak an identifying string", () => {
  /** Test double for `vale`: always reports a finding whose message quotes
   * the fixture identity name, regardless of what it was asked to lint —
   * standing in for a Vale finding that echoes matched text back, the one
   * way this leak could still happen once the content channel itself is
   * fixed. */
  function installValeIdentityLeakStub(): string {
    const stubDir = mkdtempSync(join(tmpdir(), "precommit-valeleak-"));
    tempDirs.push(stubDir);
    const stubPath = join(stubDir, "vale");
    writeFileSync(
      stubPath,
      [
        "#!/bin/sh",
        'for arg in "$@"; do file="$arg"; done',
        'echo "$file:1:1:Stub.Finding:excerpt mentions Fixture Person right here"',
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);
    return stubDir;
  }

  test("a finding whose text carries the declared identity name is withheld, not printed", () => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeIdentityLeakStub();
    writeFileSync(join(dir, "docs.md"), "This is clean prose with no flagged terms in the file itself.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("docs.md");
    expect(stderr).toContain("withheld");
    expect(stderr).not.toContain("Fixture Person");
  }, HOOK_TIMEOUT_MS);

  test("a finding whose text does not carry an identity string still prints normally", () => {
    const dir = initRepo();
    installValeConfig(dir);
    const stubDir = installValeStub();
    writeFileSync(join(dir, "docs.md"), "Let's delve into this topic.\n");
    git(["add", "docs.md"], dir);

    const result = runHook(dir, { ...process.env, PATH: pathWithStubFirst(stubDir) });
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("Stub.Finding");
    expect(stderr).not.toContain("withheld");
  }, HOOK_TIMEOUT_MS);
});
