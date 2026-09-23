// Live-process tests for the sidecar's gitignore protection (issue #137's live-probe follow-up).
// A live probe against branch head 1cecc2d found the installer writing
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
//
// ROUND 2 (findings F1-F12 against the round-1 fix at b531e01): repo detection could be tricked
// into "no repository here" by any git failure, not only a genuine non-repo (F1); a sidecar
// stale from before the ignore rule broke was left on disk instead of removed (F2); a relative
// -Target doubled onto itself when handed to `git -C` (F3); git missing from PATH threw instead
// of failing closed, aborting the install before settings.json/the manifest were written (F4);
// -Unaccept and -Prune's own sidecar writes had no test that could fail (F5); the warning text
// misdescribed what -Accept and -Force do and did not name the tracked/force-added case (F6,
// F11); the drift hook and -Audit went silent rather than saying a sidecar was refused (F9);
// two `checkIgnored(false)` assertions restated a precondition rather than testing this code
// (F10); and tests were not isolated from a developer's global git config (F12).
//
// F10 note: `checkIgnored(dir)` is false in states (c) and (e) purely because those
// fixtures' .claude/.gitignore genuinely does not cover the sidecar, a fact about git, not
// about this code, true before AND after every fix in this file. No assertion phrased
// against those two fixtures alone can discriminate pre-fix from post-fix.
// `expectSidecarInvariant` below states the real, code-dependent invariant ("if the sidecar
// exists, it is ignored") and is applied everywhere for consistency, but every current call
// site is vacuous: each one either follows an `expect(sidecarExists(dir)).toBe(false)` that
// already forces its guard branch to skip, or follows a `checkIgnored(dir)` assertion that
// already proved the same fact a few lines earlier. It stands as a regression guard for a
// future case, not as anything currently discriminating: a case reaching it with the sidecar
// still on disk and its ignore state unproven is what it exists to catch.

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { posixSh, posixShDir } from "./posix-sh";

const REPO_ROOT = join(import.meta.dir, "..");
const INSTALLER = join(REPO_ROOT, "install", "Install-Harness.ps1");
const CORE_TEMPLATE = join(REPO_ROOT, "core", "claude", "templates", "manifest-local.gitignore");
const HOOK_REL = join(".claude", "hooks", "session-start-drift-check.sh");
const GITIGNORE_REL = join(".claude", ".gitignore");
const SIDECAR_REL = join(".claude", ".harness-manifest.local.json");
const MANIFEST_REL = join(".claude", ".harness-manifest.json");

// Same rationale as session-start-drift-check.test.ts: an install runs pwsh and, for -Accept /
// -Unaccept / -Prune / -Audit cases, a second time on top of that.
const INSTALL_TIMEOUT_MS = 120_000;

const pwshPath = Bun.which("pwsh");
if (!pwshPath) {
  console.warn(
    "gitignore-sidecar-protection.test.ts: pwsh not found, every case skipped. " +
      "This host's suite total is not comparable to a host with PowerShell installed.",
  );
}

// F12: isolate every git process this file spawns (directly, and indirectly via the installer)
// from whatever the developer's own machine has configured globally or at the system level --
// a global core.excludesFile or ~/.config/git/ignore that happens to match `*.local.json`, or
// any other global setting, would otherwise make (c)/(e)/(F1)/(F2) pass or fail for a reason
// that has nothing to do with this code. GIT_CONFIG_GLOBAL repoints "the global config" at an
// empty file this test controls; GIT_CONFIG_NOSYSTEM drops the system config entirely.
const GIT_ISOLATION_DIR = mkdtempSync(join(tmpdir(), "gitignore-sidecar-isolation-"));
const EMPTY_GIT_CONFIG = join(GIT_ISOLATION_DIR, "empty-gitconfig");
writeFileSync(EMPTY_GIT_CONFIG, "");
const GIT_ISOLATION_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ISOLATION_ENV, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
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

function runInstall(
  dir: string,
  extraArgs: string[] = [],
  opts: { extraEnv?: Record<string, string>; cwd?: string } = {},
) {
  const args = [pwshPath!, "-NoProfile", "-NonInteractive", "-File", INSTALLER, "-Target", dir, ...extraArgs];
  return Bun.spawnSync(args, {
    cwd: opts.cwd,
    env: { ...process.env, ...GIT_ISOLATION_ENV, ...(opts.extraEnv ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
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

/** The real, code-dependent invariant: a sidecar that exists is ignored. See the F10 note in
 * the file header for why this is meaningful in some call sites and vacuous in others. */
function expectSidecarInvariant(dir: string) {
  if (sidecarExists(dir)) {
    expect(checkIgnored(dir)).toBe(true);
  }
}

function seedLegacyManifest(dir: string, extra: Record<string, unknown>) {
  const path = join(dir, MANIFEST_REL);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(manifest, extra);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function runHook(dir: string) {
  const sh = posixSh();
  const basePath = process.env.PATH ?? "";
  const childEnv = {
    ...process.env,
    PATH: posixShDir() ? `${basePath}${delimiter}${posixShDir()}` : basePath,
    CLAUDE_PROJECT_DIR: dir,
  };
  return Bun.spawnSync([sh, join(dir, HOOK_REL)], { cwd: dir, env: childEnv, stdout: "pipe", stderr: "pipe" });
}

// F1's ablation-relevant case only reproduces on a git build that honors this test-only escape
// hatch. Probed once at module load rather than assumed, so a git that ignores it skips the one
// case that needs it instead of silently asserting nothing (or asserting the wrong thing).
const dubiousOwnershipSupported = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "gitignore-sidecar-dubious-probe-"));
    const init = git(["init", "-q"], dir);
    if (init.exitCode !== 0) {
      rmSync(dir, { recursive: true, force: true });
      return false;
    }
    const probe = git(["rev-parse", "--git-dir"], dir, { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" });
    rmSync(dir, { recursive: true, force: true });
    return probe.exitCode !== 0;
  } catch {
    return false;
  }
})();
if (!dubiousOwnershipSupported) {
  console.warn(
    "gitignore-sidecar-protection.test.ts: GIT_TEST_ASSUME_DIFFERENT_OWNER did not trigger a " +
      "dubious-ownership failure on this git; F1's case is skipped on this host.",
  );
}

// F4's case needs the SPAWNED PWSH to genuinely be unable to find git, which needs confirming
// rather than assuming a PATH-strip worked. Filters every PATH entry whose name mentions "git"
// (not only the single directory `Bun.which` resolves) because this host's ambient PATH and the
// one Bun itself resolves an executable against can disagree (measured: Bun.which("git") named
// .../Git/mingw64/bin while Windows' own command resolution used .../Git/cmd, so stripping only
// the former left git reachable) -- and the self-check itself spawns pwsh, not git directly,
// because Bun's own child-process executable lookup was measured to ignore the `env.PATH`
// override and fall back to the calling process's real PATH, while PowerShell's own internal
// command resolution genuinely honors the environment block of the process it's running in.
// Probing through git directly would then report "hidden" success or failure that has nothing
// to do with whether the real F4 case below (which also spawns pwsh) can reproduce it.
const strippedPath = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((p) => p && !/git/i.test(p))
  .join(delimiter);
const gitTrulyHidden = (() => {
  if (!pwshPath) return false;
  try {
    const probe = Bun.spawnSync(
      [pwshPath, "-NoProfile", "-NonInteractive", "-Command", "& git --version"],
      { env: { ...process.env, PATH: strippedPath }, stdout: "ignore", stderr: "ignore" },
    );
    return probe.exitCode !== 0;
  } catch {
    return true;
  }
})();
if (!gitTrulyHidden) {
  console.warn(
    "gitignore-sidecar-protection.test.ts: could not hide git from a child process's PATH on " +
      "this host; F4's git-missing case is skipped here (confirmed working on the Windows " +
      "workstation this fix round was validated on).",
  );
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
      expectSidecarInvariant(dir);
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
      expectSidecarInvariant(dir);
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
        expectSidecarInvariant(dir);
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
      expectSidecarInvariant(dir);
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
      expectSidecarInvariant(dir);
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
      expectSidecarInvariant(dir);
    },
    INSTALL_TIMEOUT_MS,
  );
});

describe("sidecar gitignore protection — round 2 findings", () => {
  // F1: a git process that cannot answer FOR A REASON OTHER THAN "no repository here" (dubious
  // ownership is the reproducible example; a foreign filesystem or a uid mismatch are the same
  // shape) must not be read as "nothing to protect." Round-1 code asked `git rev-parse
  // --git-dir`'s exit code that question and got the wrong answer under this condition.
  test.skipIf(!pwshPath || !dubiousOwnershipSupported)(
    "(F1) git that refuses ownership of a real repo: sidecar refused, not written unprotected",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-keep-me\n");

      const result = runInstall(dir, [], { extraEnv: { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(sidecarExists(dir)).toBe(false);
      // No `checkIgnored(dir) === false` assertion here (round-3 fix): git check-ignore's answer
      // in this fixture is a fixed property of .claude/.gitignore's content, which nothing in
      // this run touches, so it reads the same value whether Get-SidecarPlan's ownership handling
      // is correct or broken. It cannot fail on a regression this test exists to catch, only
      // `sidecarExists`/`expectSidecarInvariant` below can. The (F1/R2-2) case right after this
      // one is where a dubious-ownership run interacts with a sidecar already on disk, and it
      // asserts byte-identical content instead, which genuinely can fail.
      expectSidecarInvariant(dir);
    },
    INSTALL_TIMEOUT_MS,
  );

  // F1, round 3 (R2-2): the same dubious-ownership failure as above, but now with a real sidecar
  // already on disk from an earlier install and its ignore coverage since dropped -- the state
  // round-2's F2 fix would otherwise delete unconditionally. Round-3 must refuse the whole run
  // instead: a git that cannot say "ignored" here cannot say "tracked" either (both calls hit the
  // same dubious-ownership fatal), and deleting on that unknown answer is the exact leak R2-1
  // exists to close. Byte-identical content is the assertion able to fail -- unlike
  // `checkIgnored`, it changes under either regression this reproduces: an unconditional delete
  // (round-2 F2's original bug) leaves no file to compare, and a misread "not a repo" (round-2
  // F1's original bug, still reachable here since in-repo detection is call-order-independent)
  // overwrites it with fresh content instead of refusing.
  test.skipIf(!pwshPath || !dubiousOwnershipSupported)(
    "(F1/R2-2) git that refuses ownership, with a real stale sidecar already on disk: whole run refused, file byte-identical",
    () => {
      const dir = freshRepo();
      const install1 = runInstall(dir);
      expect(install1.exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      expect(checkIgnored(dir)).toBe(true);

      // Drop the ignore coverage, exactly like (F2), so the next run sees "not confirmed
      // ignored" and would otherwise reach the stale-sidecar removal branch.
      writeFileSync(join(dir, GITIGNORE_REL), "# operator trimmed it\nother-line\n");
      expect(checkIgnored(dir)).toBe(false);
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));

      const result = runInstall(dir, [], { extraEnv: { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" } });
      expect(result.exitCode).not.toBe(0);
      const combined = result.stdout.toString() + result.stderr.toString();
      expect(combined).toContain("Refusing to touch the machine-specific sidecar");
      expect(combined).toContain(".harness-manifest.local.json");
      expect(sidecarExists(dir)).toBe(true);
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);
    },
    INSTALL_TIMEOUT_MS,
  );

  // F2: a sidecar written while covered, whose cover is later dropped, must not sit on disk
  // still holding an absolute host path just because this run declined to refresh it.
  test.skipIf(!pwshPath)(
    "(F2) a sidecar that WAS ignored and no longer is: removed on the next run, and the warning says so",
    () => {
      const dir = freshRepo();
      const install1 = runInstall(dir);
      expect(install1.exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      expect(checkIgnored(dir)).toBe(true);

      // The operator's own edit drops the ignore line. Install-ManagedFile leaves the file
      // alone (tracked, modified since install), and the sidecar written under the old, good
      // rule is now stale and unprotected.
      writeFileSync(join(dir, GITIGNORE_REL), "# operator trimmed it\nother-line\n");
      expect(checkIgnored(dir)).toBe(false);

      const install2 = runInstall(dir);
      expect(install2.exitCode).toBe(0);
      expect(install2.stdout.toString()).toContain("An existing sidecar was removed");
      expect(sidecarExists(dir)).toBe(false);
      expectSidecarInvariant(dir);
    },
    INSTALL_TIMEOUT_MS,
  );

  // F3: a relative -Target must not have its check-ignore pathspec resolved twice against
  // itself. Regression introduced by round 1 (1cecc2d, before any of this file's fix, could not
  // have this bug: it never called `git -C $Target check-ignore` at all).
  test.skipIf(!pwshPath)(
    "(F3) relative -Target resolves check-ignore against the target, not doubled onto it",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "gitignore-sidecar-relparent-"));
      tempDirs.push(parent);
      const relName = "proj";
      const full = join(parent, relName);
      mkdirSync(full, { recursive: true });
      const init = git(["init", "-q"], full);
      expect(init.exitCode).toBe(0);

      const result = runInstall(relName, [], { cwd: parent });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).not.toContain("Skipping the machine-specific sidecar");

      expect(git(["check-ignore", "-q", SIDECAR_REL], full).exitCode).toBe(0);
      const sidecar = JSON.parse(readFileSync(join(full, SIDECAR_REL), "utf8"));
      expect(sidecar.coreRepo).toBeTruthy();
      expectSidecarInvariant(full);
    },
    INSTALL_TIMEOUT_MS,
  );

  // F4: git missing from PATH must fail the sidecar closed without throwing out of
  // Get-SidecarPlan. settings.json and the committed manifest are written by the caller
  // afterward and must not be lost just because git could not be asked.
  test.skipIf(!pwshPath || !gitTrulyHidden)(
    "(F4) git missing from PATH: sidecar refused cleanly, settings.json and the manifest are still written",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-keep-me\n");

      const result = runInstall(dir, [], { extraEnv: { PATH: strippedPath! } });
      // Exit code is deliberately not asserted: a separate, pre-existing, unguarded git call
      // later in the script (core.hooksPath wiring, outside this fix's scope) also fails when
      // git is missing and takes the overall exit code nonzero -- but only after settings.json
      // and the manifest below are already on disk, which is what this case exists to pin.
      expect(result.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(sidecarExists(dir)).toBe(false);
      expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
      expect(existsSync(join(dir, MANIFEST_REL))).toBe(true);
    },
    INSTALL_TIMEOUT_MS,
  );

  // F5: -Unaccept and -Prune each persist the sidecar through the same legacy carry-forward
  // path -Accept uses, and neither had a test that could fail if their own Invoke-SidecarPlan
  // call were reverted to an unconditional write. Seeded with real legacy coreRepo/stackDetected
  // content (the pre-#137 embedded shape) so the write each command attempts is non-trivial.
  test.skipIf(!pwshPath)(
    "(F5) -Unaccept in a state-c repo: sidecar stays refused even carrying legacy machine fields",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-only\n");

      expect(runInstall(dir).exitCode).toBe(0);
      expect(runInstall(dir, ["-Accept", ".gitignore"]).exitCode).toBe(0);

      seedLegacyManifest(dir, {
        coreRepo: "C:\\Users\\operator\\legacy\\core",
        stackDetected: { scannedAt: "2020-01-01T00:00:00Z", plugins: ["legacy-plugin"], outputStyles: [], mcpServers: [] },
      });

      const unaccept = runInstall(dir, ["-Unaccept", ".gitignore"]);
      expect(unaccept.exitCode).toBe(0);
      expect(unaccept.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(sidecarExists(dir)).toBe(false);
      expectSidecarInvariant(dir);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(F5) -Prune in a state-c repo: sidecar stays refused even carrying legacy machine fields",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-only\n");

      expect(runInstall(dir).exitCode).toBe(0);

      seedLegacyManifest(dir, {
        coreRepo: "C:\\Users\\operator\\legacy\\core",
        stackDetected: { scannedAt: "2020-01-01T00:00:00Z", plugins: ["legacy-plugin"], outputStyles: [], mcpServers: [] },
      });
      const manifestPath = join(dir, MANIFEST_REL);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.files["zzz-fake-orphan.md"] = "0".repeat(64);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const prune = runInstall(dir, ["-Prune", "zzz-fake-orphan.md"]);
      expect(prune.exitCode).toBe(0);
      expect(prune.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(sidecarExists(dir)).toBe(false);
      expectSidecarInvariant(dir);
    },
    INSTALL_TIMEOUT_MS,
  );

  // F6 / F11: the refusal warning must describe real remedies. -Accept pins the fork exactly as
  // it stands (it does not fetch core's version, and does not add the missing line), -Force
  // overwrites every differing managed file rather than only .gitignore, and a sidecar already
  // tracked in the index (force-added before this check existed) needs `git rm --cached`, which
  // fixing .claude/.gitignore alone would not touch.
  test.skipIf(!pwshPath)(
    "(F6/F11) refusal warning describes -Accept/-Force accurately and names the tracked case",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-only\n");

      const result = runInstall(dir);
      const out = result.stdout.toString();
      expect(out).toContain("Skipping the machine-specific sidecar");
      expect(out).toContain("-Accept '.gitignore' pins the CURRENT fork as-is");
      expect(out).toContain("-Force overwrites EVERY differing managed file with core's version, not only this one");
      expect(out).toContain("git rm --cached .claude/.harness-manifest.local.json");
    },
    INSTALL_TIMEOUT_MS,
  );

  // F9: a consumer degrading silently when the sidecar is missing is indistinguishable from
  // "nothing to report," which is wrong once "the installer refused it" became a possible
  // reason. Both consumers now print one line instead, and both keep their advisory contract
  // (exit 0; nothing a caller could read as a deny).
  test.skipIf(!pwshPath)(
    "(F9) drift hook: manifest present, sidecar refused -> one advisory line, still exit 0",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-keep-me\n");
      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(false);
      expect(existsSync(join(dir, MANIFEST_REL))).toBe(true);

      const hook = runHook(dir);
      const expected = "harness: sidecar unavailable, machine-specific checks skipped (see -Audit)\n";
      expect(hook.stdout.toString()).toBe(expected);
      expect(hook.stdout.length).toBe(Buffer.byteLength(expected));
      expect(hook.stderr.length).toBe(0);
      expect(hook.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(F9) -Audit (non-quiet): stack drift reported as not recorded rather than a false 'newly detected' wall",
    () => {
      const dir = freshRepo();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), "sentinel-keep-me\n");
      expect(runInstall(dir).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(false);

      const audit = runInstall(dir, ["-Audit"]);
      expect(audit.exitCode).toBe(0);
      const out = audit.stdout.toString();
      expect(out).toContain("Stack drift: not recorded");
      expect(out).not.toContain("newly detected");
    },
    INSTALL_TIMEOUT_MS,
  );

  // round-6 F1: -Accept, -Unaccept and -Prune persisted the in-memory sidecar even when it held
  // neither coreRepo nor stackDetected, writing `{}`. That file passes the hook's missing-sidecar
  // check, so the F9 advisory above went silent. Case A pins the advisory; case B pins that
  // legacy fields carried forward from the manifest are still written.
  const FIXTURE_COMMIT = ["-c", "core.hooksPath=NUL", "-c", "user.name=Test", "-c", "user.email=test@example.com"];
  const F9_ADVISORY = "harness: sidecar unavailable, machine-specific checks skipped (see -Audit)" + String.fromCharCode(10);

  /** Plain install, .claude/.gitignore committed and confirmed ignoring, sidecar deleted. */
  function installedCommittedNoSidecar(): string {
    const dir = freshRepo();
    expect(runInstall(dir).exitCode).toBe(0);
    expect(git(["add", "--", GITIGNORE_REL], dir).exitCode).toBe(0);
    expect(git([...FIXTURE_COMMIT, "commit", "-q", "-m", "fixture"], dir).exitCode).toBe(0);
    expect(checkIgnored(dir)).toBe(true);
    rmSync(join(dir, SIDECAR_REL));
    return dir;
  }

  function addFakeOrphan(dir: string) {
    const manifestPath = join(dir, MANIFEST_REL);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files["zzz-fake-orphan.md"] = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  function expectNoSidecarAndAdvisory(dir: string) {
    expect(sidecarExists(dir)).toBe(false);
    const hook = runHook(dir);
    expect(hook.stdout.toString()).toBe(F9_ADVISORY);
    expect(hook.exitCode).toBe(0);
  }

  test.skipIf(!pwshPath)(
    "(R6-F1 A) -Accept, -Unaccept, -Prune with no sidecar and no legacy fields: no empty sidecar, advisory still printed",
    () => {
      const dir = installedCommittedNoSidecar();
      expectNoSidecarAndAdvisory(dir);

      writeFileSync(join(dir, ".claude", "agents", "zz-overlay.md"), "project fork");
      expect(runInstall(dir, ["-Accept", "agents/zz-overlay.md"]).exitCode).toBe(0);
      expectNoSidecarAndAdvisory(dir);

      expect(runInstall(dir, ["-Unaccept", "agents/zz-overlay.md"]).exitCode).toBe(0);
      expectNoSidecarAndAdvisory(dir);

      addFakeOrphan(dir);
      expect(runInstall(dir, ["-Prune", "zzz-fake-orphan.md"]).exitCode).toBe(0);
      expectNoSidecarAndAdvisory(dir);
    },
    INSTALL_TIMEOUT_MS * 2,
  );

  test.skipIf(!pwshPath)(
    "(R6-F1 B) -Accept, -Unaccept, -Prune with legacy fields in the manifest: sidecar written and carries them",
    () => {
      const dir = installedCommittedNoSidecar();
      const legacyCore = join(tmpdir(), "legacy-core");
      const legacy = {
        coreRepo: legacyCore,
        stackDetected: { scannedAt: "2020-01-01T00:00:00Z", plugins: ["legacy-plugin"], outputStyles: [], mcpServers: [] },
      };
      // Reads the sidecar each command wrote, then deletes it so the next command starts without one.
      const takeSidecar = () => {
        const sidecar = JSON.parse(readFileSync(join(dir, SIDECAR_REL), "utf8"));
        rmSync(join(dir, SIDECAR_REL));
        return sidecar;
      };

      writeFileSync(join(dir, ".claude", "agents", "zz-overlay.md"), "project fork");
      seedLegacyManifest(dir, legacy);
      expect(runInstall(dir, ["-Accept", "agents/zz-overlay.md"]).exitCode).toBe(0);
      let sidecar = takeSidecar();
      expect(sidecar.coreRepo).toBe(legacyCore);
      expect(JSON.stringify(sidecar.stackDetected)).toContain("legacy-plugin");

      seedLegacyManifest(dir, legacy);
      expect(runInstall(dir, ["-Unaccept", "agents/zz-overlay.md"]).exitCode).toBe(0);
      sidecar = takeSidecar();
      expect(sidecar.coreRepo).toBe(legacyCore);
      expect(JSON.stringify(sidecar.stackDetected)).toContain("legacy-plugin");

      seedLegacyManifest(dir, legacy);
      addFakeOrphan(dir);
      expect(runInstall(dir, ["-Prune", "zzz-fake-orphan.md"]).exitCode).toBe(0);
      sidecar = takeSidecar();
      expect(sidecar.coreRepo).toBe(legacyCore);
      expect(JSON.stringify(sidecar.stackDetected)).toContain("legacy-plugin");
    },
    INSTALL_TIMEOUT_MS * 2,
  );
});

describe("sidecar gitignore protection — round 3 findings (R2-1, R2-2)", () => {
  // R2-1: a sidecar already staged (force-added before this gate existed, or staged by hand)
  // must never be deleted here -- the working-tree copy going away leaves the index entry, and
  // whatever it holds, to reach the next plain `git commit` untouched. Round-2's F2 fix deleted
  // unconditionally once "not confirmed ignored," which is exactly wrong for a file git itself
  // still considers tracked.
  test.skipIf(!pwshPath)(
    "(R2-1) sidecar staged (force-added) before .gitignore lost coverage: left in place, warned, byte-identical",
    () => {
      const dir = freshRepo();
      expect(runInstall(dir).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      expect(checkIgnored(dir)).toBe(true);

      const add = git(["add", "-f", "--", SIDECAR_REL], dir);
      expect(add.exitCode).toBe(0);
      const stagedBefore = git(["diff", "--cached", "--name-only"], dir).stdout.toString();
      expect(stagedBefore).toContain(SIDECAR_REL.replace(/\\/g, "/"));

      writeFileSync(join(dir, GITIGNORE_REL), "# operator trimmed it\nother-line\n");
      expect(checkIgnored(dir)).toBe(false);
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain("Not removing the machine-specific sidecar");
      expect(out).toContain("git rm --cached .claude/.harness-manifest.local.json");
      expect(out).not.toContain("was removed");
      expect(sidecarExists(dir)).toBe(true);
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);
      // The index entry this fix exists to protect must survive the run too.
      const stagedAfter = git(["diff", "--cached", "--name-only"], dir).stdout.toString();
      expect(stagedAfter).toContain(SIDECAR_REL.replace(/\\/g, "/"));
    },
    INSTALL_TIMEOUT_MS,
  );

  // R2-1, committed case: `git ls-files --error-unmatch` answers "tracked" the same way for a
  // committed file as for a staged one, and the fix must not special-case either.
  test.skipIf(!pwshPath)(
    "(R2-1) sidecar committed before .gitignore lost coverage: left in place, warned, byte-identical",
    () => {
      const dir = freshRepo();
      expect(runInstall(dir).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);

      expect(git(["add", "-f", "--", SIDECAR_REL], dir).exitCode).toBe(0);
      // F12 isolates global/system config out entirely, so this repo has no committer identity
      // configured; supply one inline rather than mutating the isolated global config.
      const commit = git(
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "force-add the sidecar"],
        dir,
      );
      expect(commit.exitCode).toBe(0);

      writeFileSync(join(dir, GITIGNORE_REL), "# operator trimmed it\nother-line\n");
      expect(checkIgnored(dir)).toBe(false);
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain("Not removing the machine-specific sidecar");
      expect(out).toContain("git rm --cached .claude/.harness-manifest.local.json");
      expect(out).not.toContain("was removed");
      expect(sidecarExists(dir)).toBe(true);
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);
    },
    INSTALL_TIMEOUT_MS,
  );

  // R2-2 (owner ruling, 2026-09-14): git missing from PATH is "cannot tell" at its plainest,
  // reproduced here with a real stale sidecar on disk -- unlike (F4) above, which never reaches
  // the tracked-check at all because nothing exists yet to delete on a first install. Every git
  // call the tracked-check makes throws, so this must refuse the whole run rather than guess:
  // non-zero exit, the sidecar (and everything else this run would have written) untouched.
  test.skipIf(!pwshPath || !gitTrulyHidden)(
    "(R2-2) git missing from PATH, with a real stale sidecar already on disk: whole run refused, file byte-identical",
    () => {
      const dir = freshRepo();
      expect(runInstall(dir).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      expect(checkIgnored(dir)).toBe(true);

      writeFileSync(join(dir, GITIGNORE_REL), "# operator trimmed it\nother-line\n");
      expect(checkIgnored(dir)).toBe(false);
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));
      const manifestBefore = readFileSync(join(dir, MANIFEST_REL));
      const settingsBefore = readFileSync(join(dir, ".claude", "settings.json"));

      const result = runInstall(dir, [], { extraEnv: { PATH: strippedPath! } });
      expect(result.exitCode).not.toBe(0);
      const combined = result.stdout.toString() + result.stderr.toString();
      expect(combined).toContain("Refusing to touch the machine-specific sidecar");
      expect(combined).toContain(".harness-manifest.local.json");
      expect(sidecarExists(dir)).toBe(true);
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);
      // The refusal is thrown before this run's caller reaches its own next write, so neither
      // of these should have moved either.
      expect(readFileSync(join(dir, MANIFEST_REL))).toEqual(manifestBefore);
      expect(readFileSync(join(dir, ".claude", "settings.json"))).toEqual(settingsBefore);
    },
    INSTALL_TIMEOUT_MS,
  );
});

// Round 4. A: an exported GIT_DIR naming another repository made `ls-files --error-unmatch` answer
// from the foreign index (exit 1, read as "untracked"), so a staged or committed sidecar was
// deleted and reported "removed". B: -Accept, -Unaccept and -Prune wrote the manifest before the
// sidecar step could refuse. C: a plain install refused only after its copy loop had written.
describe("sidecar gitignore protection — round 4 findings (A, B, C, R2-2 scope)", () => {
  const DUBIOUS = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
  const COMMIT_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

  /** Every file and directory under .claude, with a SHA-256 per file. */
  function snapshotClaudeTree(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (abs: string, rel: string) => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childAbs = join(abs, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out[`${childRel}/`] = "dir";
          walk(childAbs, childRel);
        } else {
          out[childRel] = createHash("sha256").update(readFileSync(childAbs)).digest("hex");
        }
      }
    };
    walk(join(dir, ".claude"), "");
    return out;
  }

  function indexStage(dir: string): string {
    return git(["ls-files", "--stage"], dir).stdout.toString();
  }

  /** Installed normally, then its ignore coverage dropped, so a sidecar on disk is not ignored. */
  function installedWithCoverageDropped(): string {
    const dir = freshRepo();
    expect(runInstall(dir).exitCode).toBe(0);
    expect(sidecarExists(dir)).toBe(true);
    return dir;
  }

  function dropCoverage(dir: string) {
    writeFileSync(join(dir, GITIGNORE_REL), "# operator trimmed it\nother-line\n");
    expect(checkIgnored(dir)).toBe(false);
  }

  function otherRepoWithCommit(): string {
    const other = freshRepo();
    writeFileSync(join(other, "y.txt"), "y\n");
    expect(git(["add", "y.txt"], other).exitCode).toBe(0);
    expect(git([...COMMIT_ID, "commit", "-q", "-m", "other"], other).exitCode).toBe(0);
    return other;
  }

  function expectRefusal(result: ReturnType<typeof runInstall>) {
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout.toString() + result.stderr.toString();
    expect(combined).toContain("Refusing to touch the machine-specific sidecar");
    expect(combined).toContain("stopped before writing anything");
    return combined;
  }

  for (const variant of ["staged", "committed"] as const) {
    test.skipIf(!pwshPath)(
      `(A) exported GIT_DIR naming another repository, sidecar ${variant}: refused, sidecar and both indexes unchanged, nothing reported removed`,
      () => {
        const dir = installedWithCoverageDropped();
        expect(git(["add", "-f", "--", SIDECAR_REL], dir).exitCode).toBe(0);
        if (variant === "committed") {
          expect(git([...COMMIT_ID, "commit", "-q", "-m", "force-add the sidecar"], dir).exitCode).toBe(0);
        }
        dropCoverage(dir);
        const other = otherRepoWithCommit();

        const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));
        const indexBefore = indexStage(dir);
        const otherIndexBefore = indexStage(other);
        expect(indexBefore).toContain(".claude/.harness-manifest.local.json");

        const result = runInstall(dir, [], { extraEnv: { GIT_DIR: join(other, ".git") } });
        const combined = expectRefusal(result);
        expect(combined).not.toContain("removed");
        expect(sidecarExists(dir)).toBe(true);
        expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);
        expect(indexStage(dir)).toBe(indexBefore);
        expect(indexStage(other)).toBe(otherIndexBefore);
      },
      INSTALL_TIMEOUT_MS,
    );
  }

  // B: each standalone command under a refusal leaves the manifest byte-identical (legacy machine
  // fields included, which a premature manifest write used to strip), and a retry with a git that
  // answers then makes the change the refused run was asked for.
  test.skipIf(!pwshPath || !dubiousOwnershipSupported)(
    "(B) -Accept under a refusal: manifest and sidecar byte-identical; retry with a working git pins the file",
    () => {
      const dir = installedWithCoverageDropped();
      writeFileSync(join(dir, ".claude", "agents", "zz-overlay.md"), "project fork\n");
      seedLegacyManifest(dir, {
        stackDetected: { scannedAt: "2020-01-01T00:00:00Z", plugins: ["legacy-plugin"], outputStyles: [], mcpServers: [] },
      });
      dropCoverage(dir);
      const manifestBefore = readFileSync(join(dir, MANIFEST_REL));
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));

      expectRefusal(runInstall(dir, ["-Accept", "agents/zz-overlay.md"], { extraEnv: DUBIOUS }));
      expect(readFileSync(join(dir, MANIFEST_REL))).toEqual(manifestBefore);
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);

      const retry = runInstall(dir, ["-Accept", "agents/zz-overlay.md"]);
      expect(retry.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, MANIFEST_REL), "utf8")).accepted["agents/zz-overlay.md"]).toBeTruthy();
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath || !dubiousOwnershipSupported)(
    "(B) -Unaccept under a refusal: manifest and sidecar byte-identical; retry with a working git drops the pin",
    () => {
      const dir = installedWithCoverageDropped();
      writeFileSync(join(dir, ".claude", "agents", "zz-overlay.md"), "project fork\n");
      expect(runInstall(dir, ["-Accept", "agents/zz-overlay.md"]).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      dropCoverage(dir);
      const manifestBefore = readFileSync(join(dir, MANIFEST_REL));
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));

      expectRefusal(runInstall(dir, ["-Unaccept", "agents/zz-overlay.md"], { extraEnv: DUBIOUS }));
      expect(readFileSync(join(dir, MANIFEST_REL))).toEqual(manifestBefore);
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);

      const retry = runInstall(dir, ["-Unaccept", "agents/zz-overlay.md"]);
      expect(retry.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, MANIFEST_REL), "utf8")).accepted["agents/zz-overlay.md"]).toBeUndefined();
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath || !dubiousOwnershipSupported)(
    "(B) -Prune under a refusal: manifest and sidecar byte-identical; retry with a working git drops the record",
    () => {
      const dir = installedWithCoverageDropped();
      const manifestPath = join(dir, MANIFEST_REL);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.files["zzz-fake-orphan.md"] = "0".repeat(64);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      dropCoverage(dir);
      const manifestBefore = readFileSync(manifestPath);
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));

      expectRefusal(runInstall(dir, ["-Prune", "zzz-fake-orphan.md"], { extraEnv: DUBIOUS }));
      expect(readFileSync(manifestPath)).toEqual(manifestBefore);
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);

      const retry = runInstall(dir, ["-Prune", "zzz-fake-orphan.md"]);
      expect(retry.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).files["zzz-fake-orphan.md"]).toBeUndefined();
    },
    INSTALL_TIMEOUT_MS,
  );

  // C: a layer the copy loop would repair (agents directory and guardrails.md gone), refused. Every
  // file hash and every directory under .claude must match before and after.
  test.skipIf(!pwshPath || !dubiousOwnershipSupported)(
    "(C) plain install under a refusal: the whole .claude tree is unchanged",
    () => {
      const dir = installedWithCoverageDropped();
      rmSync(join(dir, ".claude", "agents"), { recursive: true, force: true });
      rmSync(join(dir, ".claude", "guardrails.md"), { force: true });
      dropCoverage(dir);
      const before = snapshotClaudeTree(dir);

      expectRefusal(runInstall(dir, [], { extraEnv: DUBIOUS }));
      expect(snapshotClaudeTree(dir)).toEqual(before);
    },
    INSTALL_TIMEOUT_MS,
  );

  // R2-2 scope ruling (owner, 2026-09-14): the refusal applies only to a sidecar on disk.
  test.skipIf(!pwshPath || !dubiousOwnershipSupported)(
    "(R2-2 scope) no sidecar on disk, git cannot answer: tracked state reported unknown, install continues, exit 0",
    () => {
      const dir = freshRepo();
      const result = runInstall(dir, [], { extraEnv: DUBIOUS });
      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain("its tracked state is unknown");
      expect(out).not.toContain("Refusing to touch");
      expect(sidecarExists(dir)).toBe(false);
      expect(existsSync(join(dir, MANIFEST_REL))).toBe(true);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(R2-2 scope) no sidecar on disk, index still tracks one: warned with git rm --cached, install continues, exit 0",
    () => {
      const dir = freshRepo();
      expect(runInstall(dir).exitCode).toBe(0);
      expect(git(["add", "-f", "--", SIDECAR_REL], dir).exitCode).toBe(0);
      expect(git([...COMMIT_ID, "commit", "-q", "-m", "force-add the sidecar"], dir).exitCode).toBe(0);
      rmSync(join(dir, SIDECAR_REL));

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain("git's index still tracks it");
      expect(out).toContain("git rm --cached .claude/.harness-manifest.local.json");
      expect(sidecarExists(dir)).toBe(false);
      expect(git(["ls-files", "--error-unmatch", "--", SIDECAR_REL], dir).exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );
});

// Round 5. With no `.git` at or above the target, the plan counted the sidecar as ignored without
// asking anything, so it was written unprotected in three reproduced cases: a forked
// .claude/.gitignore in a plain directory, -Accept with no .claude/.gitignore at all, and a
// repository named only by GIT_DIR/GIT_WORK_TREE. Each case below failed with the round-5
// Install-Harness.ps1 change reverted.
describe("sidecar gitignore protection — round 5 (targets with no .git on disk)", () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);

  /** A plain directory that git does not see as a repository. */
  function nonRepoDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gitignore-sidecar-norepo-"));
    tempDirs.push(dir);
    expect(git(["rev-parse", "--git-dir"], dir).exitCode).not.toBe(0);
    return dir;
  }

  /** A bare repository elsewhere, plus the environment that points git at it from `target`. */
  function foreignGitEnv(target: string): Record<string, string> {
    const holder = mkdtempSync(join(tmpdir(), "gitignore-sidecar-gitdir-"));
    tempDirs.push(holder);
    const gitDir = join(holder, "sep.git");
    expect(git(["init", "-q", "--bare", gitDir], holder).exitCode).toBe(0);
    return { GIT_DIR: gitDir, GIT_WORK_TREE: target };
  }

  test.skipIf(!pwshPath)(
    "(R5-happy) no repository, core's .claude/.gitignore: sidecar written, and ignored once a repository appears",
    () => {
      const dir = nonRepoDir();
      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).not.toContain("Skipping the machine-specific sidecar");
      expect(JSON.parse(readFileSync(join(dir, SIDECAR_REL), "utf8")).coreRepo).toBeTruthy();

      expect(git(["init", "-q"], dir).exitCode).toBe(0);
      expect(checkIgnored(dir)).toBe(true);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(R5-crlf) no repository, forked .claude/.gitignore with the line in CRLF: sidecar written",
    () => {
      const dir = nonRepoDir();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), `# fork${CR}${LF}.harness-manifest.local.json${CR}${LF}`);

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      expect(git(["init", "-q"], dir).exitCode).toBe(0);
      expect(checkIgnored(dir)).toBe(true);
    },
    INSTALL_TIMEOUT_MS,
  );

  // round-6: the round-5 exact-line read of .claude/.gitignore said ignored where git does not.
  // These two are cases it got wrong; git now answers in place.
  test.skipIf(!pwshPath)(
    "(R5-negation) no repository, .claude/.gitignore ignores the line then negates it: sidecar not written, warned",
    () => {
      const dir = nonRepoDir();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), `.harness-manifest.local.json${LF}!.harness-manifest.local.json${LF}`);

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(sidecarExists(dir)).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(R5-utf16) no repository, .claude/.gitignore holding the line as UTF-16LE with a BOM: sidecar not written, warned",
    () => {
      const dir = nonRepoDir();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const bom = Buffer.from([0xff, 0xfe]);
      writeFileSync(join(dir, GITIGNORE_REL), Buffer.concat([bom, Buffer.from(`.harness-manifest.local.json${LF}`, "utf16le")]));

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(sidecarExists(dir)).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(R5-1) no repository, forked .claude/.gitignore lacking the line: sidecar not written, warned",
    () => {
      const dir = nonRepoDir();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), `sentinel-keep-me${LF}`);

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(readGitignore(dir)).toBe(`sentinel-keep-me${LF}`);
      expect(sidecarExists(dir)).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(R5-2) no repository, -Accept with no .claude/.gitignore carrying a legacy coreRepo: sidecar not written, warned",
    () => {
      const dir = nonRepoDir();
      expect(runInstall(dir).exitCode).toBe(0);
      rmSync(join(dir, GITIGNORE_REL), { force: true });
      rmSync(join(dir, SIDECAR_REL), { force: true });
      writeFileSync(join(dir, ".claude", "agents", "zz-overlay.md"), `project fork${LF}`);
      seedLegacyManifest(dir, { coreRepo: join(tmpdir(), "legacy-core") });

      const accept = runInstall(dir, ["-Accept", "agents/zz-overlay.md"]);
      expect(accept.exitCode).toBe(0);
      expect(accept.stdout.toString()).toContain("Skipping the machine-specific sidecar");
      expect(sidecarExists(dir)).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, MANIFEST_REL), "utf8")).accepted["agents/zz-overlay.md"]).toBeTruthy();
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(R5-3) GIT_DIR/GIT_WORK_TREE naming a repository with no .git near the target: sidecar not written, tracked state unknown",
    () => {
      const dir = nonRepoDir();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, GITIGNORE_REL), `sentinel-keep-me${LF}`);

      const result = runInstall(dir, [], { extraEnv: foreignGitEnv(dir) });
      expect(result.stdout.toString()).toContain("its tracked state is unknown");
      expect(sidecarExists(dir)).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "(R5-3 on disk) GIT_DIR/GIT_WORK_TREE with a sidecar already on disk: whole run refused, file byte-identical",
    () => {
      const dir = nonRepoDir();
      expect(runInstall(dir).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      writeFileSync(join(dir, GITIGNORE_REL), `# operator trimmed it${LF}other-line${LF}`);
      const sidecarBefore = readFileSync(join(dir, SIDECAR_REL));

      const result = runInstall(dir, [], { extraEnv: foreignGitEnv(dir) });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString() + result.stderr.toString()).toContain("Refusing to touch the machine-specific sidecar");
      expect(readFileSync(join(dir, SIDECAR_REL))).toEqual(sidecarBefore);
    },
    INSTALL_TIMEOUT_MS,
  );
});

// Round 7 (issue #153): two below-floor findings from the #140 App review, re-verified against
// this file's own head and fixed here.
describe("sidecar gitignore protection — round 7 findings (issue #153)", () => {
  // Every other field the installer loads (the manifest, settings.json) is meaningful,
  // committed data, so a parse failure surfacing there is a real signal. The sidecar holds
  // only coreRepo and stackDetected, both machine-local and regenerated by every plain
  // install (see the `$sidecar['coreRepo'] = $repoRoot` refresh near the bottom of the
  // script), so a malformed copy must not block settings.json, the manifest, or a fresh
  // sidecar write the way an unhandled ConvertFrom-Json exception otherwise would.
  test.skipIf(!pwshPath)(
    "(R7-1) malformed sidecar JSON does not block the install: treated as absent, run completes",
    () => {
      const dir = freshRepo();
      expect(runInstall(dir).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);

      writeFileSync(join(dir, SIDECAR_REL), "{ this is not valid json");

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
      expect(existsSync(join(dir, MANIFEST_REL))).toBe(true);
      const sidecar = JSON.parse(readFileSync(join(dir, SIDECAR_REL), "utf8"));
      expect(sidecar.coreRepo).toBeTruthy();
    },
    INSTALL_TIMEOUT_MS,
  );

  // (F2) above already proves the file gets deleted and the operator is warned. What it does
  // not check is the summary table's own Action column, which named every non-write outcome
  // 'skipped-unprotected', including this one -- so a run that just deleted a stale, unignored
  // copy read as though nothing had happened to it.
  test.skipIf(!pwshPath)(
    "(R7-2) a sidecar removed for lost ignore coverage is reported 'removed' in the summary table, not 'skipped-unprotected'",
    () => {
      const dir = freshRepo();
      expect(runInstall(dir).exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(true);
      writeFileSync(join(dir, GITIGNORE_REL), "# operator trimmed it\nother-line\n");

      const result = runInstall(dir);
      expect(result.exitCode).toBe(0);
      expect(sidecarExists(dir)).toBe(false);
      expect(result.stdout.toString()).toMatch(/\.harness-manifest\.local\.json\s+removed\b/);
      expect(result.stdout.toString()).not.toMatch(/\.harness-manifest\.local\.json\s+skipped-unprotected\b/);
    },
    INSTALL_TIMEOUT_MS,
  );
});
