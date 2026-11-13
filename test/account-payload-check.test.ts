// Live-process tests for install/check-account-payload.sh (#75), the check this
// repository chains into its pre-commit hook through harness.preCommitChain.
//
// Each case builds a throwaway repository shaped like this one: an
// account/claude/ payload, the eol rule from .gitattributes, the real check
// script, and a stub install/Export-Account.ps1 that mirrors the fixture
// account home into -OutputRoot. The stub stands in for the real exporter,
// whose identity and personal-term gates need declaration files no test
// fixture should carry. The check only depends on the exporter's interface
// (-ClaudeHome, -OutputRoot, exit status), which the stub keeps.
//
// Every case spawns sh, several git processes and pwsh, so each gets a long
// timeout rather than bun's 5000ms default.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { posixSh, posixShDir } from "./posix-sh";

const CHECK_SRC = join(import.meta.dir, "..", "install", "check-account-payload.sh");
const TIMEOUT_MS = 120_000;
const CR = String.fromCharCode(13);

const STUB_EXPORTER = [
  "param([string]$ClaudeHome, [string]$OutputRoot)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Content -LiteralPath (Join-Path (Split-Path $ClaudeHome -Parent) 'export-ran.log') -Value 'ran'",
  "if (Test-Path -LiteralPath (Join-Path (Split-Path $ClaudeHome -Parent) 'FAIL')) {",
  "  Write-Output 'stub exporter output SENTINEL-EXPORT-LOG'",
  "  exit 3",
  "}",
  "New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null",
  "Get-ChildItem -LiteralPath $ClaudeHome -Force | Copy-Item -Destination $OutputRoot -Recurse -Force",
  "",
].join("\n");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function git(args: string[], cwd: string, env?: Record<string, string | undefined>) {
  return Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
}

type Fixture = { repo: string; home: string; source: string };

/** Payload files present both in the committed tree and in the account source. */
const PAYLOAD: Record<string, string> = {
  "rules/a.md": "alpha\n",
  "rules/b.md": "beta\n",
  ".export-account-marker": "marker\n",
};

function writeAt(root: string, rel: string, body: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

function setup(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "acct-payload-"));
  tempDirs.push(base);
  const repo = join(base, "repo");
  const home = join(base, "home");
  const source = join(home, ".claude");
  mkdirSync(repo, { recursive: true });
  mkdirSync(source, { recursive: true });
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  writeAt(repo, ".gitattributes", "account/claude/** text=auto eol=lf\n");
  writeAt(repo, "install/Export-Account.ps1", STUB_EXPORTER);
  writeAt(repo, "install/check-account-payload.sh", readFileSync(CHECK_SRC, "utf8"));
  for (const [rel, body] of Object.entries(PAYLOAD)) {
    writeAt(repo, `account/claude/${rel}`, body);
    writeAt(source, rel, body);
  }
  git(["add", "-A"], repo);
  git(["commit", "-q", "--no-verify", "-m", "fixture"], repo);
  return { repo, home, source };
}

function runCheck(f: Fixture, env: Record<string, string | undefined> = {}) {
  const shDir = posixShDir();
  const sh = posixSh();
  const basePath = env.PATH ?? process.env.PATH ?? "";
  const childEnv = {
    ...process.env,
    ...env,
    HOME: env.HOME ?? f.home,
    USERPROFILE: env.USERPROFILE ?? f.home,
    PATH: shDir ? `${basePath}${delimiter}${shDir}` : basePath,
  };
  return Bun.spawnSync([sh, "install/check-account-payload.sh"], {
    cwd: f.repo,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Listed, not probed with existsSync or Bun.which: on Windows pwsh is often an
// app execution alias, which neither of those sees but a shell runs.
function holds(dir: string, name: string): boolean {
  try {
    return readdirSync(dir).some((n) => n.toLowerCase() === name || n.toLowerCase() === `${name}.exe`);
  } catch {
    return false;
  }
}
const PATH_ENTRIES = (process.env.PATH ?? "").split(delimiter).filter((p) => p);
const PWSH_DIRS = PATH_ENTRIES.filter((p) => holds(p, "pwsh"));
const CAN_DROP_PWSH =
  PWSH_DIRS.length > 0 && !PWSH_DIRS.some((d) => holds(d, "git") || holds(d, "sh") || holds(d, "awk"));

const exportRan = (f: Fixture) => existsSync(join(f.home, "export-ran.log"));
const indexBlob = (f: Fixture, rel: string) => git(["rev-parse", `:0:${rel}`], f.repo).stdout.toString().trim();

describe("account payload check — scope", () => {
  test("nothing staged under account/claude: exit 0, no export run", () => {
    const f = setup();
    writeAt(f.repo, "other.txt", "unrelated\n");
    git(["add", "other.txt"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
    expect(exportRan(f)).toBe(false);
  }, TIMEOUT_MS);

  test("staged change that a fresh export reproduces: exit 0", () => {
    const f = setup();
    writeAt(f.source, "rules/a.md", "alpha two\n");
    writeAt(f.repo, "account/claude/rules/a.md", "alpha two\n");
    git(["add", "-A"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(0);
    expect(exportRan(f)).toBe(true);
  }, TIMEOUT_MS);

  test("staged deletion that the export also made: exit 0", () => {
    const f = setup();
    rmSync(join(f.source, "rules", "b.md"));
    git(["rm", "-q", "account/claude/rules/b.md"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(0);
  }, TIMEOUT_MS);
});

describe("account payload check — refusals", () => {
  test("staged hand edit: refused, path named, content not printed", () => {
    const f = setup();
    writeAt(f.repo, "account/claude/rules/a.md", "SENTINEL-HAND-EDIT\n");
    git(["add", "-A"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(1);
    const err = r.stderr.toString();
    expect(err).toContain("account/claude/rules/a.md");
    expect(err).not.toContain("account/claude/rules/b.md");
    expect(err).not.toContain("SENTINEL-HAND-EDIT");
    expect(r.stdout.toString()).not.toContain("SENTINEL-HAND-EDIT");
  }, TIMEOUT_MS);

  test("staged deletion of a path the export still writes: refused", () => {
    const f = setup();
    git(["rm", "-q", "account/claude/rules/b.md"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("account/claude/rules/b.md");
  }, TIMEOUT_MS);

  test("staged path the export does not write: refused", () => {
    const f = setup();
    writeAt(f.repo, "account/claude/rules/c.md", "only in the repo\n");
    git(["add", "-A"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("account/claude/rules/c.md");
  }, TIMEOUT_MS);

  test("export fails: refused, exporter output not repeated", () => {
    const f = setup();
    writeAt(f.home, "FAIL", "");
    writeAt(f.repo, "account/claude/rules/a.md", "alpha two\n");
    git(["add", "-A"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(1);
    const all = r.stderr.toString() + r.stdout.toString();
    expect(all).toContain("export failed");
    expect(all).not.toContain("SENTINEL-EXPORT-LOG");
  }, TIMEOUT_MS);

  test("no account source on this machine: refused, says so", () => {
    const f = setup();
    const bare = mkdtempSync(join(tmpdir(), "acct-payload-nohome-"));
    tempDirs.push(bare);
    writeAt(f.repo, "account/claude/rules/a.md", "alpha two\n");
    git(["add", "-A"], f.repo);

    const r = runCheck(f, { HOME: bare, USERPROFILE: bare });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("account source");
  }, TIMEOUT_MS);

  // git quotes a name holding a tab, a double quote or a backslash even under
  // core.quotePath=false, and the quoted form names no file in the export.
  test("staged path git has to quote: refused as uncheckable", () => {
    const f = setup();
    const sha = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
      cwd: f.repo,
      stdin: Buffer.from("tabbed\n"),
      stdout: "pipe",
    }).stdout.toString().trim();
    // core.protectNTFS=false so Windows indexes a name NTFS could not hold.
    const res = git(["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${sha},account/claude/rules/a\tb.md`], f.repo);
    expect(res.exitCode).toBe(0);

    const r = runCheck(f);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("quot");
    expect(exportRan(f)).toBe(false);
  }, TIMEOUT_MS);

  // Skipped where pwsh shares a directory with git or sh (a Linux /usr/bin),
  // since dropping that directory from PATH would break the check for an
  // unrelated reason and the case would no longer test what it names.
  test.skipIf(!CAN_DROP_PWSH)("pwsh not on PATH: refused", () => {
    const f = setup();
    writeAt(f.repo, "account/claude/rules/a.md", "alpha two\n");
    git(["add", "-A"], f.repo);
    const path = PATH_ENTRIES.filter((p) => !holds(p, "pwsh")).join(delimiter);

    const r = runCheck(f, { PATH: path });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("pwsh is not on PATH");
    expect(exportRan(f)).toBe(false);
  }, TIMEOUT_MS);
});

describe("account payload check — comparison goes through git's filters", () => {
  // Run with no global or system git config, so core.autocrlf (which Git for
  // Windows sets system-wide) cannot do the normalising. Only the staged
  // .gitattributes the check copies into its throwaway repository can.
  test("export written with CRLF against the LF staged blob: exit 0", () => {
    const f = setup();
    writeAt(f.source, "rules/a.md", `alpha${CR}\nline two${CR}\n`);
    writeAt(f.repo, "account/claude/rules/a.md", "alpha\nline two\n");
    git(["add", "-A"], f.repo);
    const emptyConfig = join(f.home, "empty.gitconfig");
    writeFileSync(emptyConfig, "");

    const r = runCheck(f, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" });
    expect(r.exitCode).toBe(0);
  }, TIMEOUT_MS);

  test("export written with CRLF, staged blob that differs in content: refused", () => {
    const f = setup();
    writeAt(f.source, "rules/a.md", `alpha${CR}\nline two${CR}\n`);
    writeAt(f.repo, "account/claude/rules/a.md", "alpha\nline 2\n");
    git(["add", "-A"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(1);
  }, TIMEOUT_MS);

  // git exports GIT_INDEX_FILE (and GIT_DIR in a worktree) to every hook. The
  // check hashes the export in a throwaway repository, and a `git add` there
  // that inherited them would write the export into the commit's own index.
  test("hook environment: the commit's index is left as staged", () => {
    const f = setup();
    writeAt(f.repo, "account/claude/rules/a.md", "SENTINEL-HAND-EDIT\n");
    git(["add", "-A"], f.repo);
    const before = indexBlob(f, "account/claude/rules/a.md");

    // GIT_INDEX_FILE alone is what git exports to a hook in a main checkout.
    const r = runCheck(f, { GIT_INDEX_FILE: join(f.repo, ".git", "index") });
    expect(r.exitCode).toBe(1);
    expect(indexBlob(f, "account/claude/rules/a.md")).toBe(before);
  }, TIMEOUT_MS);
});

describe("account payload check — staged path shapes", () => {
  // With rename detection on, a rename is one raw line carrying both names,
  // and the old name's slot would be compared instead of the new one.
  test("staged rename of a payload file the export still writes under its old name: refused", () => {
    const f = setup();
    git(["mv", "account/claude/rules/a.md", "account/claude/rules/renamed.md"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(1);
    const err = r.stderr.toString();
    expect(err).toContain("account/claude/rules/renamed.md");
    expect(err).toContain("account/claude/rules/a.md");
  }, TIMEOUT_MS);

  test("run from a subdirectory: still checks the whole staged payload", () => {
    const f = setup();
    writeAt(f.repo, "account/claude/rules/a.md", "SENTINEL-HAND-EDIT\n");
    git(["add", "-A"], f.repo);
    const shDir = posixShDir();
    const basePath = process.env.PATH ?? "";

    const r = Bun.spawnSync([posixSh(), "check-account-payload.sh"], {
      cwd: join(f.repo, "install"),
      env: {
        ...process.env,
        HOME: f.home,
        USERPROFILE: f.home,
        PATH: shDir ? `${basePath}${delimiter}${shDir}` : basePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("account/claude/rules/a.md");
  }, TIMEOUT_MS);
});

describe("account payload check — no exporter in this tree", () => {
  test("notice, exit 0, nothing run", () => {
    const f = setup();
    rmSync(join(f.repo, "install", "Export-Account.ps1"));
    writeAt(f.repo, "account/claude/rules/a.md", "anything\n");
    git(["add", "account/claude/rules/a.md"], f.repo);

    const r = runCheck(f);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain("Export-Account.ps1");
    expect(exportRan(f)).toBe(false);
  }, TIMEOUT_MS);
});
