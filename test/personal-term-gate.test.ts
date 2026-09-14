// Live-process tests for the personal-term channel (#147): core/claude/hooks/identity-patterns.sh's
// personal_terms_* functions, as pre-commit and pre-push run them. Same approach as
// identity-gate.test.ts: real temp repos, real git, the hook spawned the way git spawns it.
//
// Every term here is synthetic. The real list lives outside every repository, and writing one of
// its values into a test is the leak the channel exists to stop.
//
// The fixture home holds no identity file, so the identity gate reports "not configured" and
// scans nothing. Every refusal asserted below therefore comes from the term channel.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { posixSh, posixShDir } from "./posix-sh";

// Real git against real temp repos; see identity-gate.test.ts for why 5s is too tight.
setDefaultTimeout(30_000);

const HOOKS = join(import.meta.dir, "..", "core", "claude", "hooks");
const TERMS = ["Zorblax Quuxworks", "frobnitzel"];
const LIST = JSON.stringify({ terms: TERMS, excludeMcpServers: ["some-server"] });

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string, env?: Record<string, string | undefined>) {
  return Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
}

/** Git for Windows launches hooks with LC_CTYPE=C.UTF-8, so the tests do too. */
function hookEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const home = tmp("pterm-home-");
  posixSh();
  const shDir = posixShDir();
  const path = process.env.PATH ?? "";
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    USERNAME: "ptermfixtureuser",
    COMPUTERNAME: "ptermfixturehost",
    LC_CTYPE: "C.UTF-8",
    PATH: shDir ? `${path}${delimiter}${shDir}` : path,
    ...extra,
  };
}

/** Writes the list (or nothing, for null) and returns its path with forward slashes, the
 * spelling an operator would put in git config. */
function listFile(content: string | null): string {
  const p = join(tmp("pterm-list-"), "terms.json");
  if (content !== null) writeFileSync(p, content);
  return p.split(String.fromCharCode(92)).join("/");
}

function output(result: { stdout: Buffer; stderr: Buffer }): string {
  return result.stdout.toString() + result.stderr.toString();
}

/** No term, in any case, anywhere in what the hook printed. */
function expectNoTerm(result: { stdout: Buffer; stderr: Buffer }) {
  const out = output(result).toLowerCase();
  for (const term of TERMS) expect(out.includes(term.toLowerCase())).toBe(false);
}

function configure(dir: string, list: string | null) {
  if (list !== null) git(["config", "--local", "harness.personalTermsFile", list], dir);
}

function initPreCommitRepo(list: string | null): string {
  const dir = tmp("pterm-precommit-");
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  copyFileSync(join(HOOKS, "pre-commit"), join(dir, ".claude", "hooks", "pre-commit"));
  copyFileSync(join(HOOKS, "identity-patterns.sh"), join(dir, ".claude", "hooks", "identity-patterns.sh"));
  configure(dir, list);
  return dir;
}

function stage(dir: string, name: string, content: string) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
  git(["add", name], dir);
}

function runPreCommit(dir: string, env: Record<string, string | undefined> = hookEnv()) {
  return Bun.spawnSync([posixSh(), join(dir, ".claude", "hooks", "pre-commit")], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A `grep` that aborts with exit 134, the Git Bash grep -iF failure, on every -F invocation
 * ("all"), or only on -F invocations whose input is not the load-time canary ("scan"). Any other
 * grep call passes through to the real binary, so the identity gate's own -E calls still run. */
function abortingGrep(mode: "all" | "scan"): string {
  const env = hookEnv();
  const real = Bun.spawnSync([posixSh(), "-c", "command -v grep"], { env, stdout: "pipe" }).stdout.toString().trim();
  const dir = tmp("pterm-grepstub-");
  const lines = [
    "#!/bin/sh",
    "fixed=0",
    `for a in "$@"; do`,
    "  case $a in",
    "    --*) ;;",
    "    -*F*) fixed=1 ;;",
    "  esac",
    "done",
    `if [ "$fixed" -eq 0 ]; then exec "$REAL_GREP" "$@"; fi`,
  ];
  if (mode === "scan") {
    lines.push(
      "input=$(cat)",
      "case $input in",
      `  *personal-term-canary-*) { printf '%s' "$input"; echo; } | "$REAL_GREP" "$@"; exit $? ;;`,
      "esac",
    );
  }
  lines.push("exit 134", "");
  writeFileSync(join(dir, "grep"), lines.join("\n"));
  chmodSync(join(dir, "grep"), 0o755);
  return hookEnvWithStub(dir, real);
}

let stubEnv: Record<string, string | undefined> = {};
function hookEnvWithStub(stubDir: string, realGrep: string): string {
  const base = hookEnv({ REAL_GREP: realGrep });
  stubEnv = { ...base, PATH: `${stubDir}${delimiter}${base.PATH}` };
  return stubDir;
}

describe("personal-term channel: pre-commit", () => {
  test("config unset: the channel is skipped silently, even over staged content carrying a term", () => {
    const dir = initPreCommitRepo(null);
    stage(dir, "notes.txt", `planning notes for ${TERMS[0]}\n`);
    const result = runPreCommit(dir);
    expect(result.exitCode).toBe(0);
    expect(output(result)).not.toContain("personal-term");
    expectNoTerm(result);
  });

  test("config set, list file missing: refuses", () => {
    const dir = initPreCommitRepo(listFile(null));
    stage(dir, "notes.txt", "clean prose about widgets\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("missing or unreadable");
    expectNoTerm(result);
  });

  test("config set, list file empty: refuses", () => {
    const dir = initPreCommitRepo(listFile(""));
    stage(dir, "notes.txt", "clean prose about widgets\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("is empty");
  });

  test("config set, list declares no terms: refuses", () => {
    const dir = initPreCommitRepo(listFile(JSON.stringify({ terms: [], excludeMcpServers: [] })));
    stage(dir, "notes.txt", "clean prose about widgets\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("declares no terms");
  });

  test("config set, list unparseable: refuses without echoing the file", () => {
    const dir = initPreCommitRepo(listFile(`{"terms": ["${TERMS[1]}"`));
    stage(dir, "notes.txt", "clean prose about widgets\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not the JSON shape");
    expectNoTerm(result);
  });

  test("config set, clean staged content: the commit proceeds", () => {
    const dir = initPreCommitRepo(listFile(LIST));
    stage(dir, "notes.txt", "clean prose about widgets\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).toBe(0);
    expectNoTerm(result);
  });

  test("a term in staged content, in mixed case, refuses naming the file and never the term", () => {
    const dir = initPreCommitRepo(listFile(LIST));
    stage(dir, "notes.txt", "rollout notes for the zorblax QUUXWORKS importer\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("'notes.txt' carries a term");
    expectNoTerm(result);
  });

  test.each([
    ["alone on its own line", "intro line\nfrobnitzel\nclosing line\n"],
    ["as the whole file, no trailing newline, upper case", "FROBNITZEL"],
  ])("a term %s matches", (_label, content) => {
    const dir = initPreCommitRepo(listFile(LIST));
    stage(dir, "notes.txt", content);
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("carries a term");
    expectNoTerm(result);
  });

  test("a term in a staged path refuses without printing the path", () => {
    const dir = initPreCommitRepo(listFile(LIST));
    stage(dir, "docs/frobnitzel-handover.txt", "clean prose about widgets\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("staged file's path carries a term");
    expectNoTerm(result);
  });

  test("a term in the branch name refuses", () => {
    const dir = initPreCommitRepo(listFile(LIST));
    git(["checkout", "-q", "-b", "feature/frobnitzel-work"], dir);
    stage(dir, "notes.txt", "clean prose about widgets\n");
    const result = runPreCommit(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("branch name carries a term");
    expectNoTerm(result);
  });

  test("a grep that aborts on every -F call fails the load-time canary: refuses", () => {
    const dir = initPreCommitRepo(listFile(LIST));
    stage(dir, "notes.txt", "clean prose about widgets\n");
    abortingGrep("all");
    const result = runPreCommit(dir, stubEnv);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("canary");
    expectNoTerm(result);
  });

  test("a grep that passes the canary and then aborts on the scan: refuses rather than reading clean", () => {
    const dir = initPreCommitRepo(listFile(LIST));
    stage(dir, "notes.txt", "clean prose about widgets\n");
    abortingGrep("scan");
    const result = runPreCommit(dir, stubEnv);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("did not run cleanly");
    expectNoTerm(result);
  });
});

function initBareRemote(): string {
  const dir = tmp("pterm-remote-");
  git(["init", "-q", "--bare", "-b", "main", dir], dir);
  return dir;
}

function initPrePushRepo(list: string | null): string {
  const remote = initBareRemote();
  const dir = tmp("pterm-prepush-");
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  git(["remote", "add", "origin", remote], dir);
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  copyFileSync(join(HOOKS, "pre-push"), join(dir, ".git", "hooks", "pre-push"));
  copyFileSync(join(HOOKS, "identity-patterns.sh"), join(dir, ".git", "hooks", "identity-patterns.sh"));
  chmodSync(join(dir, ".git", "hooks", "pre-push"), 0o755);
  configure(dir, list);
  return dir;
}

function commit(dir: string, file: string, content: string, message: string) {
  writeFileSync(join(dir, file), content);
  git(["add", file], dir);
  git(["commit", "-q", "-m", message], dir);
}

function push(dir: string) {
  return git(["push", "origin", "HEAD:refs/heads/main"], dir, hookEnv());
}

describe("personal-term channel: pre-push", () => {
  test("config unset: a term in a pushed commit message goes through", () => {
    const dir = initPrePushRepo(null);
    commit(dir, "f.txt", "clean prose\n", `wire up the ${TERMS[0]} importer`);
    const result = push(dir);
    expect(result.exitCode).toBe(0);
    expectNoTerm(result);
  });

  test("config set, list file missing: refuses", () => {
    const dir = initPrePushRepo(listFile(null));
    commit(dir, "f.txt", "clean prose\n", "clean commit");
    const result = push(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("missing or unreadable");
  });

  test("config set, clean range: the push proceeds", () => {
    const dir = initPrePushRepo(listFile(LIST));
    commit(dir, "f.txt", "clean prose\n", "clean commit");
    const result = push(dir);
    expect(result.exitCode).toBe(0);
    expectNoTerm(result);
  });

  test("a term in a pushed commit message refuses, never printing it", () => {
    const dir = initPrePushRepo(listFile(LIST));
    commit(dir, "f.txt", "clean prose\n", "wire up the ZORBLAX quuxworks importer");
    const result = push(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("commit message of one or more commits");
    expectNoTerm(result);
  });

  test("a term in pushed content refuses, never printing it", () => {
    const dir = initPrePushRepo(listFile(LIST));
    commit(dir, "f.txt", "notes\nfrobnitzel\n", "clean commit");
    const result = push(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("content of one or more commits");
    expectNoTerm(result);
  });
});
