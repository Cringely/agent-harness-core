// Live-process tests for the sidecar's gitignore protection (issue #137's live-probe follow-up).
// A live probe against branch head 5c20650 found the installer writing
// .claude/.harness-manifest.local.json (coreRepo, an absolute host path, plus a per-machine
// plugin/MCP inventory) into a target whose .claude/.gitignore predates this feature and does
// not cover it: Install-ManagedFile's "differs from core and is not tracked" branch leaves such
// a file untouched rather than editing an operator's fork, and the sidecar write downstream of
// it did not check whether that left the sidecar actually protected. `git add -A` would have
// committed it -- the exact leak issue #137 exists to close.
//
// Every case here drives the real installer through pwsh and checks with `git check-ignore`,
// the mechanism `git add` itself consults, rather than re-parsing .claude/.gitignore -- state
// (f) below is the reason: an ignore rule declared elsewhere (.git/info/exclude, a root
// .gitignore) must count too, and check-ignore already sees it without this file needing to
// special-case where the rule came from.

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const INSTALLER = join(REPO_ROOT, "install", "Install-Harness.ps1");
const CORE_TEMPLATE = join(REPO_ROOT, "core", "claude", "templates", "manifest-local.gitignore");
const GITIGNORE_REL = join(".claude", ".gitignore");
const SIDECAR_REL = join(".claude", ".harness-manifest.local.json");

// Same rationale as session-start-drift-check.test.ts: an install runs pwsh and, for -Accept,
// a second time on top of that.
const INSTALL_TIMEOUT_MS = 120_000;

const pwshPath = Bun.which("pwsh");
if (!pwshPath) {
  console.warn(
    "gitignore-sidecar-protection.test.ts: pwsh not found, every case skipped. " +
      "This host's suite total is not comparable to a host with PowerShell installed.",
  );
}

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

/** A fresh git repository with nothing installed yet. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-sidecar-"));
  tempDirs.push(dir);
  const init = git(["init", "-q"], dir);
  if (init.exitCode !== 0) {
    throw new Error(`git init failed: ${init.stderr.toString()}`);
  }
  return dir;
}

function runInstall(dir: string, extraArgs: string[] = []) {
  const args = [pwshPath!, "-NoProfile", "-NonInteractive", "-File", INSTALLER, "-Target", dir, ...extraArgs];
  return Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
}

function checkIgnored(dir: string): boolean {
  return git(["check-ignore", "-q", SIDECAR_REL], dir).exitCode === 0;
}

function sidecarExists(dir: string): boolean {
  return existsSync(join(dir, SIDECAR_REL));
}

function readGitignore(dir: string): string {
  return readFileSync(join(dir, GITIGNORE_REL), "utf8");
}

describe("sidecar gitignore protection", () => {
  // (a) No pre-existing .claude/.gitignore: the installer plants core's template fresh, so the
  // sidecar is covered and written normally.
  test.skipIf(!pwshPath)(
    "(a) no pre-existing .claude/.gitignore: sidecar written, and git actually ignores it",
    () => {
      const dir = freshRepo();
      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);

      expect(checkIgnored(dir)).toBe(true);
      const status = git(["status", "--porcelain", SIDECAR_REL], dir);
      expect(status.stdout.toString().trim()).toBe("");

      const sidecar = JSON.parse(readFileSync(join(dir, SIDECAR_REL), "utf8"));
      expect(sidecar.coreRepo).toBeTruthy();
      expect(sidecar.stackDetected).toBeTruthy();
    },
    INSTALL_TIMEOUT_MS,
  );

  // (b) .claude/.gitignore identical to core's template: adopted into tracking, left byte-for-byte
  // alone, and the sidecar is covered.
  test.skipIf(!pwshPath)(
    "(b) .claude/.gitignore identical to core's: adopted unchanged, sidecar written and ignored",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      copyFileSync(CORE_TEMPLATE, join(dir, GITIGNORE_REL));
      const before = readFileSync(join(dir, GITIGNORE_REL));

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);

      expect(readFileSync(join(dir, GITIGNORE_REL)).equals(before)).toBe(true);
      expect(checkIgnored(dir)).toBe(true);
      const sidecar = JSON.parse(readFileSync(join(dir, SIDECAR_REL), "utf8"));
      expect(sidecar.coreRepo).toBeTruthy();
    },
    INSTALL_TIMEOUT_MS,
  );

  // (c) The live-probe case: a differing, untracked .claude/.gitignore lacking the ignore line.
  // Install-ManagedFile already leaves the file untouched (that half was never the defect); the
  // fix is that the sidecar must now be refused rather than silently written unprotected, and
  // that refusal must hold across repeated runs, not just the first.
  test.skipIf(!pwshPath)(
    "(c) differing untracked .claude/.gitignore lacking the line: sidecar refused, not silently written, idempotent",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-keep-me\n");

      for (let i = 0; i < 2; i++) {
        const result = runInstall(dir);
        expect(result.exitCode).toBe(0);
        // Write-Warning lands on the child's stdout when pwsh is spawned as a raw process (no
        // interactive host to route it to stderr) -- measured directly against this pwsh, not
        // assumed.
        expect(result.stdout.toString()).toContain("Skipping the machine-specific sidecar");
        // The line this run's operator already had survives verbatim -- Install-ManagedFile's
        // half of the invariant, re-asserted here so a future change cannot regress it while
        // fixing something else in this same run.
        expect(readGitignore(dir)).toBe("sentinel-keep-me\n");
        expect(sidecarExists(dir)).toBe(false);
        expect(checkIgnored(dir)).toBe(false);
      }
    },
    INSTALL_TIMEOUT_MS,
  );

  // (d) A differing .claude/.gitignore that already happens to contain the ignore line (a fork
  // that added its own header or extra entries around it). Install-ManagedFile still leaves it
  // alone on the hash mismatch, but check-ignore passes on the actual content, so the sidecar
  // must be written -- refusing here would be the same defect in the opposite direction.
  test.skipIf(!pwshPath)(
    "(d) differing .claude/.gitignore that already contains the line: sidecar written despite the hash mismatch",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const custom = "# fork: project-specific notes\n.harness-manifest.local.json\n";
      writeFileSync(join(dir, GITIGNORE_REL), custom);

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);

      expect(readGitignore(dir)).toBe(custom);
      expect(checkIgnored(dir)).toBe(true);
      const sidecar = JSON.parse(readFileSync(join(dir, SIDECAR_REL), "utf8"));
      expect(sidecar.coreRepo).toBeTruthy();
    },
    INSTALL_TIMEOUT_MS,
  );

  // (e) The fork gets explicitly pinned with -Accept while still lacking the line. Pinning is an
  // operator decision about the file's provenance, not a claim that its content is safe to build
  // on -- the sidecar must stay refused after the pin exactly as it was before.
  test.skipIf(!pwshPath)(
    "(e) -Accept'ed .gitignore fork still lacking the line: sidecar stays refused after the pin",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-only\n");

      const first = runInstall(dir);
      expect(first.exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(false);

      const accept = runInstall(dir, ["-Accept", ".gitignore"]);
      expect(accept.exitCode).toBe(0);
      // -Accept's own sidecar persistence (a legacy carry-forward path, distinct from the plain
      // install's) must not launder an unprotected sidecar into existence either.
      expect(sidecarExists(dir)).toBe(false);

      const second = runInstall(dir);
      expect(second.exitCode).toBe(0);
      expect(second.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(readGitignore(dir)).toBe("sentinel-only\n");
      expect(sidecarExists(dir)).toBe(false);
      expect(checkIgnored(dir)).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  // (f) The ignore rule is declared elsewhere (.git/info/exclude here) rather than in
  // .claude/.gitignore, which itself still lacks the line. check-ignore is the source of truth
  // precisely so this case needs no special-casing: it is the same code path as (a)-(e).
  test.skipIf(!pwshPath)(
    "(f) ignore achieved elsewhere (.git/info/exclude): sidecar written even though .claude/.gitignore itself lacks the line",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-keep-me\n");
      // git init already created .git/info/exclude (empty or template comments); appendFileSync
      // creates it if that ever isn't true, rather than an existsSync-then-read-then-write
      // sequence, which is the check-then-act race CodeQL flags on this path
      // (js/file-system-race, the same reasoning as session-start-drift-check.test.ts:92-95).
      const excludePath = join(dir, ".git", "info", "exclude");
      appendFileSync(excludePath, "\n.claude/.harness-manifest.local.json\n");

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);

      expect(readGitignore(dir)).toBe("sentinel-keep-me\n");
      expect(checkIgnored(dir)).toBe(true);
      const sidecar = JSON.parse(readFileSync(join(dir, SIDECAR_REL), "utf8"));
      expect(sidecar.coreRepo).toBeTruthy();
    },
    INSTALL_TIMEOUT_MS,
  );
});
