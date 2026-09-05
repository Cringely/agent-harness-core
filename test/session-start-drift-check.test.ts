// Live-process tests for the SessionStart drift-check hook
// (core/claude/hooks/session-start-drift-check.sh). Like pre-commit.test.ts, this
// hook is a POSIX shell script with no exported core to unit test, so every case
// builds a real project, runs a real install, and runs the hook through `sh`.
//
// ADVISORY, NOT A GATE. CONTRIBUTING.md:43 asks anything under core/claude/hooks/ for a
// case asserting a DENY. This hook has no denial to assert: it runs on SessionStart,
// where no tool call is pending, and its only output is one line of text on stdout —
// there is no permissionDecision, no non-zero exit, nothing that can refuse anything.
// The standing assertion that replaces it is output shape, which is the whole contract:
// a project in sync produces ZERO BYTES, and a project with drift produces exactly one
// line. Both are measured in bytes rather than in lines, because a hook that printed a
// bare newline into every session start would count as zero lines by most splits and is
// exactly the regression worth catching.
//
// The security cases below are the closest thing to a denial here: coreRepo is read out
// of a project-local JSON file, so a payload in it must produce no execution and no
// output, and the marker-file assertions prove the no-execution half rather than
// inferring it from silence.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const INSTALLER = join(REPO_ROOT, "install", "Install-Harness.ps1");
const HOOK_SRC = join(REPO_ROOT, "core", "claude", "hooks", "session-start-drift-check.sh");
const HOOK_REL = join(".claude", "hooks", "session-start-drift-check.sh");
const MANIFEST_REL = join(".claude", ".harness-manifest.json");

// An install runs pwsh twice over the whole layer (install, then audit), which is well
// past bun's 5s default on a cold PowerShell start.
const INSTALL_TIMEOUT_MS = 120_000;

const pwshPath = Bun.which("pwsh");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A POSIX sh to run the hook with, and the directory it came from. Duplicated from
 * pre-commit.test.ts rather than shared: extracting it would edit a passing test file
 * for this change's convenience, and the copy is a locator, not logic.
 * Always an absolute path, never a bare "sh": some cases spawn it with a child PATH
 * that carries none of the ambient PATH, and a bare name would resolve only against
 * whatever PATH the child happens to get. On Unix and on Git Bash it resolves off the
 * ambient PATH; a PowerShell or cmd session on Windows has none there, so fall back to
 * the one git ships, located from `git --exec-path`.
 */
let cachedSh: string | undefined;
/** Set only when sh came from git's own directory. The hook calls sed, tr and awk, which
 * on Windows live beside that sh rather than on PATH, so the child needs this appended. */
let cachedShDir: string | undefined;

function posixSh(): string {
  if (cachedSh) return cachedSh;
  try {
    const probe = Bun.spawnSync(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    const resolved = probe.success && Bun.which("sh");
    if (resolved) return (cachedSh = resolved);
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

/** A project with the full layer installed. A plain install by default, which is the
 * configuration the operator is told to use: the audit classifies the two ceremony-gated
 * files as 'not-installed (ceremony-gated)' and leaves them out of the attention count, so
 * a default install is genuinely silent rather than silent only under -IncludeCeremonies. */
function installedProject(includeCeremonies = false): string {
  const dir = mkdtempSync(join(tmpdir(), "driftcheck-"));
  tempDirs.push(dir);
  const args = [pwshPath!, "-NoProfile", "-NonInteractive", "-File", INSTALLER, "-Target", dir];
  if (includeCeremonies) args.push("-IncludeCeremonies");
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`installer failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  }
  return dir;
}

/** A project holding the hook and nothing else, for the cases that must never reach an
 * installer at all. */
function bareProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "driftcheck-bare-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(dir, HOOK_REL), readFileSync(HOOK_SRC));
  return dir;
}

/** Rewrite the installed manifest's coreRepo to an arbitrary string, JSON-escaped. */
function setCoreRepo(dir: string, value: string) {
  const path = join(dir, MANIFEST_REL);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.coreRepo = value;
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function runHook(dir: string) {
  const sh = posixSh();
  const basePath = process.env.PATH ?? "";
  const childEnv = {
    ...process.env,
    PATH: cachedShDir ? `${basePath}${delimiter}${cachedShDir}` : basePath,
    CLAUDE_PROJECT_DIR: dir,
  };
  return Bun.spawnSync([sh, join(dir, HOOK_REL)], {
    cwd: dir,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("session-start drift-check hook — output shape", () => {
  test.skipIf(!pwshPath)(
    "a default install produces zero bytes of output",
    () => {
      const dir = installedProject();
      const result = runHook(dir);
      // Bytes, not lines: a stray newline or a stray space is the regression that would
      // otherwise pass a line-count check and still open every session with noise.
      // This is also the case that pins the ceremony-gated classification. Counted as
      // drift, the two gated files put "harness drift: 2 not-installed" in front of every
      // session start of every project that did not opt into ceremonies, forever, with no
      // command that clears it.
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.length).toBe(0);
      expect(result.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "an install with -IncludeCeremonies is silent too",
    () => {
      // The other side of the same fix: the gated files are silent because they are
      // installed and in sync here, not because the status is suppressed everywhere.
      const dir = installedProject(true);
      const result = runHook(dir);
      expect(result.stdout.length).toBe(0);
      expect(result.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "a ceremony file installed and then deleted is still reported",
    () => {
      // The exclusion must not swallow a real loss. Installed under -IncludeCeremonies the
      // file is tracked in the manifest, so deleting it is 'missing', which a re-run with
      // that switch genuinely repairs — a different class from never having installed it.
      const dir = installedProject(true);
      rmSync(join(dir, ".claude", "agents", "soc-monitor.md"));

      const result = runHook(dir);
      const expected = "harness drift: 1 missing\n";
      expect(result.stdout.toString()).toBe(expected);
      expect(result.stdout.length).toBe(Buffer.byteLength(expected));
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "one project-modified file produces exactly one line",
    () => {
      const dir = installedProject();
      const agent = join(dir, ".claude", "agents", "task-reviewer.md");
      writeFileSync(agent, `${readFileSync(agent, "utf8")}\nPROJECT EDIT\n`);

      const result = runHook(dir);
      const expected = "harness drift: 1 project-modified (promote?)\n";
      // Byte length first and on its own, so a runner that stops the case at the first
      // failed assertion still reports the measurement this test exists for.
      expect(result.stdout.length).toBe(Buffer.byteLength(expected));
      expect(result.stdout.toString()).toBe(expected);
      expect(result.stderr.length).toBe(0);
      expect(result.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "the summary counts every attention status and omits the ones at zero",
    () => {
      const dir = installedProject();
      // Two project-modified, so the count is read from the data rather than being 1
      // everywhere and indistinguishable from a hard-coded segment.
      for (const name of ["task-reviewer.md", "adversarial-reviewer.md"]) {
        const path = join(dir, ".claude", "agents", name);
        writeFileSync(path, `${readFileSync(path, "utf8")}\nPROJECT EDIT\n`);
      }
      // 'missing' is unranked: the spec fixes wording for three statuses only, and the
      // others have to reach the line under their own audit name.
      rmSync(join(dir, ".claude", "agents", "doc-steward.md"));

      const result = runHook(dir);
      const expected = "harness drift: 2 project-modified (promote?), 1 missing\n";
      expect(result.stdout.length).toBe(Buffer.byteLength(expected));
      expect(result.stdout.toString()).toBe(expected);
      // Zero-count segments are omitted, not printed as "0 core-updated".
      expect(result.stdout.toString()).not.toContain("core-updated");
      expect(result.stdout.toString()).not.toContain("conflict");
      // And the gated files are not riding along inside the count.
      expect(result.stdout.toString()).not.toContain("ceremony-gated");
      expect(result.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "an accepted overlay stays out of the line until the fork moves again",
    () => {
      const dir = installedProject();
      const overlay = join(dir, ".claude", "project-overlay.md");
      writeFileSync(overlay, "local convention notes\n");
      const pin = Bun.spawnSync(
        [pwshPath!, "-NoProfile", "-NonInteractive", "-File", INSTALLER, "-Target", dir, "-Accept", "project-overlay.md"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(pin.exitCode).toBe(0);

      // Pinned and unchanged: silent, exactly as if the file were in sync.
      expect(runHook(dir).stdout.length).toBe(0);

      writeFileSync(overlay, "local convention notes\nLATER EDIT\n");
      const result = runHook(dir);
      const expected = "harness drift: 1 overlay-changed (re-review, re-pin with -Accept)\n";
      expect(result.stdout.length).toBe(Buffer.byteLength(expected));
      expect(result.stdout.toString()).toBe(expected);
    },
    INSTALL_TIMEOUT_MS,
  );
});

describe("session-start drift-check hook — every degradation exits silent and zero", () => {
  test("no manifest: silent", () => {
    const dir = bareProject();
    const result = runHook(dir);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  test("manifest with no coreRepo key: silent", () => {
    const dir = bareProject();
    writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ files: {} }, null, 2));
    const result = runHook(dir);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  test("coreRepo that does not resolve (NAS unmounted): silent", () => {
    const dir = bareProject();
    writeFileSync(
      join(dir, MANIFEST_REL),
      JSON.stringify({ coreRepo: join(dir, "no-such-core"), files: {} }, null, 2),
    );
    const result = runHook(dir);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  test("coreRepo that resolves to a directory holding no installer: silent, and nothing there runs", () => {
    const dir = bareProject();
    // Outside the project on purpose, so this case still exercises the installer-name check
    // rather than being caught earlier by the containment check below.
    const fakeCore = mkdtempSync(join(tmpdir(), "driftcheck-notcore-"));
    tempDirs.push(fakeCore);
    mkdirSync(join(fakeCore, "install"), { recursive: true });
    const marker = join(dir, "RAN-THE-WRONG-SCRIPT");
    writeFileSync(join(fakeCore, "install", "Install-Harness.sh"), `#!/bin/sh\ntouch "${marker}"\n`);
    writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ coreRepo: fakeCore, files: {} }, null, 2));

    const result = runHook(dir);
    expect(existsSync(marker)).toBe(false);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  test("malformed manifest JSON: silent", () => {
    const dir = bareProject();
    // coreRepo intact and pointing at the real core, so the audit is genuinely reached
    // and throws on the truncated JSON. Cutting coreRepo too would exercise the earlier
    // guard instead and prove nothing about this path.
    writeFileSync(join(dir, MANIFEST_REL), `{"coreRepo": ${JSON.stringify(REPO_ROOT)}, "files": {`);
    const result = runHook(dir);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.exitCode).toBe(0);
  }, INSTALL_TIMEOUT_MS);

  test("a PATH carrying none of sed, tr or awk: silent, not a 'command not found'", () => {
    // Measured before the preflight went in: run from a shell whose PATH does not carry the
    // three tools, `set -e` aborted the hook at the first sed with exit 127 and
    // "sed: command not found" on stderr. A SessionStart hook writing an error into every
    // session start is the one failure mode this file exists to rule out.
    // coreRepo names the real core, so nothing earlier can account for the silence.
    const dir = bareProject();
    writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ coreRepo: REPO_ROOT, files: {} }, null, 2));
    const emptyPathDir = mkdtempSync(join(tmpdir(), "driftcheck-nopath-"));
    tempDirs.push(emptyPathDir);

    const result = Bun.spawnSync([posixSh(), join(dir, HOOK_REL)], {
      cwd: dir,
      env: { ...process.env, PATH: emptyPathDir, CLAUDE_PROJECT_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    // stderr first: it is the regression this case exists for, and a runner that stops at the
    // first failure would otherwise report the exit code instead of the message.
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  test("manifest that is not JSON at all: silent", () => {
    const dir = bareProject();
    writeFileSync(join(dir, MANIFEST_REL), "not json, not even close\n");
    const result = runHook(dir);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });
});

describe("session-start drift-check hook — coreRepo is untrusted input", () => {
  /** A directory under `parent` shaped like a core checkout, whose installer writes a
   * marker when run. Real filename, so only the containment check can stop it. */
  function plantFakeCore(parent: string, marker: string): string {
    const fakeCore = join(parent, "evil");
    mkdirSync(join(fakeCore, "install"), { recursive: true });
    writeFileSync(
      join(fakeCore, "install", "Install-Harness.ps1"),
      `New-Item -ItemType File -Path '${marker}' -Force | Out-Null\n`,
    );
    return fakeCore;
  }

  // Each payload is a shell metacharacter sequence that executes if the value ever reaches
  // a shell string or an eval. The marker assertion is the real check: silence alone would
  // also be produced by a hook that ran the payload and printed nothing.
  // The marker is written relative to the hook's cwd, which runHook sets to the project.
  // An absolute path would need quoting inside the payload, and the quotes then arrive as
  // the literal characters the JSON escaped — touch fails on the name, no marker appears,
  // and the assertion stops being the one that catches the injection. Measured: the
  // absolute form left this case failing on stderr instead of on the marker.
  const payloads: Array<[string, string]> = [
    ["command substitution", "$(touch PWNED)"],
    ["backtick substitution", "`touch PWNED`"],
    ["statement separator", "/tmp; touch PWNED"],
    ["logical operator", "/tmp && touch PWNED"],
  ];

  for (const [name, payload] of payloads) {
    test(`coreRepo carrying a ${name} payload runs nothing and prints nothing`, () => {
      const dir = bareProject();
      writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ coreRepo: payload, files: {} }, null, 2));

      const result = runHook(dir);
      expect(existsSync(join(dir, "PWNED"))).toBe(false);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.length).toBe(0);
      expect(result.exitCode).toBe(0);
    });
  }

  test.skipIf(!pwshPath)(
    "a coreRepo naming a fake core INSIDE the project executes nothing",
    () => {
      // The attack the injection cases above do not reach. coreRepo never touches a shell
      // string, which is true and worth having, but it does not need to: a directory inside
      // the repo holding install/Install-Harness.ps1 satisfies a name-shape check, so one
      // edited JSON string value plus one added file gets arbitrary PowerShell at every
      // session start on every machine that opens the project.
      const dir = bareProject();
      const marker = join(dir, "PWNED-BY-IN-PROJECT-CORE");
      const fakeCore = plantFakeCore(dir, marker);
      writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ coreRepo: fakeCore, files: {} }, null, 2));

      const result = runHook(dir);
      // Marker first: it is the assertion this case exists for, and a runner that stops at
      // the first failure would otherwise report the silence instead of the execution.
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.length).toBe(0);
      expect(result.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );

  test.skipIf(!pwshPath)(
    "a case-variant path to the same in-project fake core executes nothing either",
    () => {
      // pwd reports the case it was handed, not the case on disk, so on a case-insensitive
      // filesystem an exact prefix compare misses this while cd still finds the directory.
      const dir = bareProject();
      const marker = join(dir, "PWNED-BY-CASE-VARIANT");
      const fakeCore = plantFakeCore(dir, marker);
      // Flip the case of the drive/leading segment as well as the planted directory, which
      // is what defeats a compare that only folds one side.
      const variant = fakeCore.toUpperCase();
      writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ coreRepo: variant, files: {} }, null, 2));

      const result = runHook(dir);
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout.length).toBe(0);
      expect(result.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );

  test("a coreRepo naming the real core still works when it arrives Windows-escaped", () => {
    const dir = bareProject();
    // The installer writes native separators, so a Windows manifest holds "E:\\projects\\core".
    // JSON.stringify produces the same doubling, which is what the hook's unescape undoes;
    // this asserts the unescape does not mangle a path that was correct to begin with.
    writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ coreRepo: REPO_ROOT, files: {} }, null, 2));
    const result = runHook(dir);
    // No install ever ran here, so every managed file reads as untracked or not-installed:
    // the point is that the audit was reached at all, which silence would not distinguish
    // from a resolution failure.
    expect(result.stdout.toString()).toMatch(/^harness drift: \d+ /);
    expect(result.exitCode).toBe(0);
  }, INSTALL_TIMEOUT_MS);

  test.skipIf(!pwshPath)(
    "a project installed from a real core outside it is still audited",
    () => {
      // The containment check must refuse only what is inside the project. A normal install
      // resolves coreRepo to the core checkout, which is elsewhere, so the ordinary path has
      // to survive it — otherwise the fix would close the hole by disabling the hook.
      const dir = installedProject();
      setCoreRepo(dir, REPO_ROOT);
      const agent = join(dir, ".claude", "agents", "task-reviewer.md");
      writeFileSync(agent, `${readFileSync(agent, "utf8")}\nPROJECT EDIT\n`);

      const result = runHook(dir);
      expect(result.stdout.toString()).toBe("harness drift: 1 project-modified (promote?)\n");
      expect(result.exitCode).toBe(0);
    },
    INSTALL_TIMEOUT_MS,
  );
});
