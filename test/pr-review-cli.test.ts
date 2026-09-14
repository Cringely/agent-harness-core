// Tests for tools/pr-review/cli.ts: argument parsing, the snapshot summary, exit codes, the
// cwd-inside-repo refusal, and the print-boundary checks (identity scan, control-character
// stripping). The CLI is thin wiring; the behaviour of the modules it calls is covered by their own
// tests. Nothing here reads a real key, calls real GitHub, or runs the reviewer: the two tests that
// call main() itself only exercise its two refusal paths, both of which return before a
// GitHubClient is ever constructed.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REPO,
  UsageError,
  cwdHasAutoloadFile,
  exitCodeFor,
  isCwdInsideRepo,
  main,
  parseCliArgs,
  reportOutcome,
  stripControlChars,
  summarizeSnapshot,
} from "../tools/pr-review/cli";
import { syntheticCheckRuns } from "../tools/pr-review/local-source";
import type { ReviewOutcome } from "../tools/pr-review/pipeline";
import { REPO_ROOT } from "../tools/pr-review/tool-state";
import { RefusalError, type PrSnapshot } from "../tools/pr-review/types";

const NO_ENV = {};
const FIXTURE_IDENTITY = { names: [], emails: [], username: "fixture-user", hostname: "fixture-host" };

// A real, empty, existing directory: cwdHasAutoloadFile refuses (fail closed) on a cwd it cannot
// list, so the fictional path strings this file used before the R11-1 fix ("/neutral/scratch/dir",
// never created on disk) now read as unsafe rather than neutral. Removed in afterAll.
const NEUTRAL_DIR = mkdtempSync(join(tmpdir(), "pr-review-neutral-"));
afterAll(() => {
  rmSync(NEUTRAL_DIR, { recursive: true, force: true });
});

describe("parseCliArgs(): review", () => {
  test("parses a posting run", () => {
    expect(parseCliArgs(["review", "--pr", "132", "--app-id", "123456", "--key-stdin", "--post", "--json"], NO_ENV)).toEqual({
      command: "review",
      repo: DEFAULT_REPO,
      pr: 132,
      appId: "123456",
      post: true,
      commentOnly: false,
      json: true,
    });
  });

  test("takes the App id from the environment when the flag is absent", () => {
    expect(parseCliArgs(["review", "--pr", "7", "--key-stdin"], { PR_REVIEW_APP_ID: "654321" })).toMatchObject({ appId: "654321", post: false });
  });

  // The operator ruled on 2026-09-11 that the key reaches the tool only on stdin, so there is no key
  // file option to accept, and a run without --key-stdin is refused rather than left to wait on a
  // terminal.
  test.each([
    [["review", "--app-id", "1", "--key-stdin"]],
    [["review", "--pr", "0", "--app-id", "1", "--key-stdin"]],
    [["review", "--pr", "seven", "--app-id", "1", "--key-stdin"]],
    [["review", "--pr", "7", "--key-stdin"]],
    [["review", "--pr", "7", "--app-id", "1"]],
    [["review", "--pr", "7", "--app-id", "1", "--key-stdin", "--key-file", "/abs/app.pem"]],
    [["review", "--pr", "7", "--app-id", "1", "--key-stdin", "--comment-only"]],
    [["no-such-command"]],
  ])("rejects %p", (argv) => {
    expect(() => parseCliArgs(argv, NO_ENV)).toThrow(UsageError);
  });

  test("no arguments means help", () => {
    expect(parseCliArgs([], NO_ENV)).toEqual({ command: "help" });
  });
});

describe("parseCliArgs(): snapshot", () => {
  test("parses, and always reports as JSON", () => {
    expect(parseCliArgs(["snapshot", "--pr", "132", "--app-id", "1", "--key-stdin"], NO_ENV)).toEqual({
      command: "snapshot",
      repo: DEFAULT_REPO,
      pr: 132,
      appId: "1",
      post: false,
      commentOnly: false,
      json: true,
    });
  });

  test.each([
    [["snapshot", "--pr", "132", "--app-id", "1", "--key-stdin", "--post"]],
    [["snapshot", "--pr", "132", "--app-id", "1", "--key-stdin", "--comment-only"]],
  ])("rejects a posting flag %p", (argv) => {
    expect(() => parseCliArgs(argv, NO_ENV)).toThrow(UsageError);
  });
});

describe("summarizeSnapshot()", () => {
  test("reports what the reviewer would be given and the verification, without the pull request's own text", () => {
    const snapshot: PrSnapshot = {
      repo: "owner/name",
      number: 132,
      title: "TITLE-TEXT",
      body: "BODY-TEXT",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      isOpen: true,
      diff: "DIFF-TEXT",
      changedFiles: ["patterns/INDEX.md"],
      changedFilesComplete: true,
      commitMessages: ["COMMIT-TEXT"],
      headFiles: [{ path: "patterns/INDEX.md", content: "CONTENT-TEXT" }],
      omittedFiles: [],
      linkedIssues: [{ number: 127, title: "ISSUE-TITLE", body: "ISSUE-BODY" }],
      trustedContext: [{ path: "CONTRIBUTING.md", content: "TRUSTED-TEXT" }],
      workflowText: "jobs:\n",
      checkRuns: syntheticCheckRuns("passed"),
    };
    const summary = summarizeSnapshot(snapshot);
    expect(summary.verification).toEqual({ state: "passed", reasons: [] });
    expect(summary.linkedIssues).toEqual([127]);
    expect(summary.changedFilesComplete).toBe(true);
    const text = JSON.stringify(summary);
    for (const mark of ["TITLE-TEXT", "BODY-TEXT", "DIFF-TEXT", "COMMIT-TEXT", "CONTENT-TEXT", "ISSUE-BODY", "TRUSTED-TEXT"]) {
      expect(text).not.toContain(mark);
    }
  });
});

describe("exitCodeFor()", () => {
  // A11.1: cli.ts previously mapped every rejection reaching import.meta.main to exit 1, which made
  // a deliberate refusal (a fork, a non-default branch, a cwd inside the repository) indistinguishable
  // from the tool crashing.
  test("a RefusalError exits 2, anything else exits 1", () => {
    expect(exitCodeFor(new RefusalError("x"))).toBe(2);
    expect(exitCodeFor(new Error("x"))).toBe(1);
    expect(exitCodeFor("not even an Error")).toBe(1);
  });
});

describe("stripControlChars()", () => {
  test("removes C0 controls and DEL but keeps tab, newline and carriage return", () => {
    // ESC-METHOD: every control character below is built from its code at run time rather than
    // typed as a \u escape, so this source file carries no raw control bytes.
    const nul = String.fromCharCode(0);
    const esc = String.fromCharCode(27);
    const del = String.fromCharCode(127);
    expect(stripControlChars("safe text")).toBe("safe text");
    expect(stripControlChars(`a${nul}b${esc}c${del}d`)).toBe("abcd");
    expect(stripControlChars("line1\tline2\nline3\r\n")).toBe("line1\tline2\nline3\r\n");
  });

  // R11-7: the first round's sanitizer covered only C0 and DEL. C1 (U+0080-U+009F, including
  // U+009B, an alternate CSI introducer some terminals still honour) and the bidi override/isolate
  // characters (U+202A-U+202E, U+2066-U+2069) reached printed output unchanged.
  test("removes the C1 control range and bidi override and isolate characters", () => {
    const csi = String.fromCharCode(0x9b);
    const nel = String.fromCharCode(0x85);
    const rlo = String.fromCharCode(0x202e);
    const lri = String.fromCharCode(0x2066);
    const input = `left${csi}mid${nel}dle${rlo}right${lri}end`;
    expect(stripControlChars(input)).toBe("leftmiddlerightend");
  });
});

describe("isCwdInsideRepo()", () => {
  // BUN-CWD: exact match, a real subdirectory, and the boundary case a bare prefix check would get
  // wrong (the same class of bug parseRepo's exact-segment check guards against in types.ts). These
  // four use synthetic, non-existent paths on purpose: realpathSync.native falls back to resolve()
  // when a path cannot be resolved, so the string-comparison behaviour is still exercised directly.
  test("the repository root itself counts as inside", () => {
    expect(isCwdInsideRepo("/repo", "/repo")).toBe(true);
  });

  test("a subdirectory of the repository counts as inside", () => {
    expect(isCwdInsideRepo(join("/repo", "tools", "pr-review"), "/repo")).toBe(true);
  });

  test("a sibling directory that merely shares the repository's name as a prefix is not inside", () => {
    expect(isCwdInsideRepo("/repo-other", "/repo")).toBe(false);
  });

  test("an unrelated directory is not inside", () => {
    expect(isCwdInsideRepo("/somewhere/else", "/repo")).toBe(false);
  });

  // R11-1: a cwd reached through a symlink (POSIX) or an NTFS junction (win32) pointing at the
  // repository root previously compared unequal to the root's own path string, even though it names
  // the same physical directory Bun would read bunfig.toml/.env from. realpathSync.native resolves
  // both sides before comparing, closing that gap.
  test("a symlink or junction pointing at the repository root resolves to the same directory", () => {
    const base = mkdtempSync(join(tmpdir(), "pr-review-realpath-"));
    const target = join(base, "target");
    mkdirSync(target);
    mkdirSync(join(target, "sub"));
    const link = join(base, "link");
    try {
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      rmSync(base, { recursive: true, force: true });
      throw new Error(`could not create a test symlink/junction (environment lacks the privilege?): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      expect(isCwdInsideRepo(link, target)).toBe(true);
      expect(isCwdInsideRepo(join(link, "sub"), target)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("cwdHasAutoloadFile()", () => {
  // R11-1: Bun reads bunfig.toml and .env* only from the literal cwd (confirmed live), so a cwd
  // holding either is unsafe regardless of how it relates to REPO_ROOT -- a worktree's parent
  // clone, a subst drive, or any other alias the containment check does not name.
  function withTempDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-autoload-"));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an empty directory has no autoload file", () => {
    withTempDir((dir) => expect(cwdHasAutoloadFile(dir)).toBe(false));
  });

  test("a directory holding bunfig.toml is unsafe", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "bunfig.toml"), "");
      expect(cwdHasAutoloadFile(dir)).toBe(true);
    });
  });

  test.each([".env", ".env.local", ".env.production"])("a directory holding %s is unsafe", (name) => {
    withTempDir((dir) => {
      writeFileSync(join(dir, name), "");
      expect(cwdHasAutoloadFile(dir)).toBe(true);
    });
  });

  test("a directory that cannot be listed is treated as unsafe, not as clean", () => {
    // Fail closed: a cwd already removed, or one this process cannot read, gives no evidence that
    // Bun would load nothing from it.
    const dir = join(tmpdir(), "pr-review-autoload-does-not-exist-" + Date.now());
    expect(cwdHasAutoloadFile(dir)).toBe(true);
  });
});

describe("reportOutcome()", () => {
  const outcome = (status: ReviewOutcome["status"]) =>
    ({
      status,
      refusal: status === "refused" ? "refused for a reason" : null,
      event: "COMMENT",
      computedEvent: "COMMENT",
      basis: "b",
      verification: { state: "passed", reasons: [] },
      severities: [],
      findings: [],
      observedInstructionCount: 0,
      reviewerOk: true,
      reviewerFailure: null,
      reviewerDiagnostic: null,
      headSha: "2".repeat(40),
      body: "body",
      posted: null,
    }) as ReviewOutcome;

  test.each([
    ["posted", 0],
    ["dry-run", 0],
    ["refused", 2],
  ] as const)("status %s exits %d", (status, code) => {
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(reportOutcome(outcome(status), true, FIXTURE_IDENTITY)).toBe(code);
    } finally {
      console.log = log;
      console.error = error;
    }
  });

  // A11.5: an allowlist rather than a denylist. Before this ruling, anything but the literal
  // "refused" exited 0, so a future or malformed status would read as success.
  test("a status this file does not recognise exits 1, not 0", () => {
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const weird = { ...outcome("posted"), status: "weird" } as unknown as ReviewOutcome;
      expect(reportOutcome(weird, true, FIXTURE_IDENTITY)).toBe(1);
    } finally {
      console.log = log;
      console.error = error;
    }
  });

  // A11.7: the diagnostic is the claude child's raw stderr and can carry a path or an account
  // email; pipeline.ts already scans and blanks it (T8-1), but this is a second, independent check
  // at the point of printing, exercised here on a ReviewOutcome built by hand, which bypasses
  // pipeline.ts entirely.
  test("blanks a reviewer diagnostic that carries an identifying string before printing it", () => {
    const printed: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    console.error = (...args: unknown[]) => printed.push(args.join(" "));
    try {
      const withDiagnostic = { ...outcome("dry-run"), reviewerDiagnostic: "Error at /home/fixture-user/project/file.ts" };
      reportOutcome(withDiagnostic, true, FIXTURE_IDENTITY);
      const text = printed.join("\n");
      expect(text).not.toContain("fixture-user");
      expect(text).toContain("diagnostic withheld");
    } finally {
      console.log = log;
      console.error = error;
    }
  });

  test("a reviewer diagnostic with no identifying string prints unchanged, aside from control characters", () => {
    // ESC-METHOD: the bell character is built from character code 7, never written as an escape sequence.
    const bell = String.fromCharCode(7);
    const printed: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    console.error = (...args: unknown[]) => printed.push(args.join(" "));
    try {
      const withDiagnostic = { ...outcome("dry-run"), reviewerDiagnostic: `an ordinary stderr line${bell} with a control char` };
      reportOutcome(withDiagnostic, false, FIXTURE_IDENTITY);
      const text = printed.join("\n");
      expect(text).toContain("an ordinary stderr line with a control char");
      expect(text).not.toContain(bell);
    } finally {
      console.log = log;
      console.error = error;
    }
  });

  test("strips control characters from a printed refusal", () => {
    // ESC-METHOD: the NUL character is built from character code 0, never written as an escape sequence.
    const nul = String.fromCharCode(0);
    const printed: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    console.error = (...args: unknown[]) => printed.push(args.join(" "));
    try {
      const refused = { ...outcome("refused"), refusal: `GitHub said: repositories${nul} is present but not an array` };
      reportOutcome(refused, false, FIXTURE_IDENTITY);
      const text = printed.join("\n");
      expect(text).not.toContain(nul);
      expect(text).toContain("repositories");
    } finally {
      console.log = log;
      console.error = error;
    }
  });
});

// BUN-CWD and the Task 10 stdin-timeout process.exit carry-forward, both exercised through main()
// itself with the process-level seam (cwd, exit, stdin) faked out. Neither test lets execution reach
// a GitHubClient: the cwd test's stdin.read throws if it is ever called, and the exit test's fake key
// read resolves to an empty string, which readPrivateKey refuses on its own before any network call.
class TestExit extends Error {
  constructor(public readonly code: number) {
    super(`test process would have exited with code ${code}`);
  }
}
const fakeExit = (code: number): never => {
  throw new TestExit(code);
};
const ARGV = ["review", "--pr", "7", "--app-id", "1", "--key-stdin"];

describe("main(): BUN-CWD", () => {
  test("refuses, before reading the key, when the cwd is the repository root", async () => {
    const stdin = {
      isTTY: false,
      read: async () => {
        throw new Error("must not read stdin: the cwd refusal must happen first");
      },
    };
    const attempt = main(ARGV, { cwd: () => REPO_ROOT, exit: fakeExit, stdin });
    await expect(attempt).rejects.toBeInstanceOf(RefusalError);
  });

  test("refuses when the cwd is a subdirectory of the repository", async () => {
    const stdin = {
      isTTY: false,
      read: async () => {
        throw new Error("must not read stdin: the cwd refusal must happen first");
      },
    };
    const attempt = main(ARGV, { cwd: () => join(REPO_ROOT, "tools", "pr-review"), exit: fakeExit, stdin });
    await expect(attempt).rejects.toBeInstanceOf(RefusalError);
  });

  test("proceeds past the cwd check from a neutral directory", async () => {
    // "Proceeds" means it reaches the key read, which then refuses on its own (empty stdin) and
    // exits via the fake, distinguishably from the RefusalError the cwd check itself throws.
    const stdin = { isTTY: false, read: async () => "" };
    const attempt = main(ARGV, { cwd: () => NEUTRAL_DIR, exit: fakeExit, stdin });
    await expect(attempt).rejects.toBeInstanceOf(TestExit);
  });
});

describe("main(): stdin-refusal process.exit carry-forward", () => {
  test("exits immediately on a stdin refusal rather than only returning a code", async () => {
    const stdin = { isTTY: false, read: async () => "" };
    const error = await main(ARGV, { cwd: () => NEUTRAL_DIR, exit: fakeExit, stdin }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TestExit);
    expect((error as TestExit).code).toBe(2);
  });

  test("a console terminal on stdin is also refused through the same immediate exit", async () => {
    const stdin = { isTTY: true, read: async () => "should not be read" };
    const error = await main(ARGV, { cwd: () => NEUTRAL_DIR, exit: fakeExit, stdin }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TestExit);
    expect((error as TestExit).code).toBe(2);
  });
});

// R11-5: every test above injects a fake io, which proves the refusal LOGIC but nothing about
// whether production's real entry point (REAL_IO, bound to process.cwd/process.exit/Bun.stdin) or
// the exitCodeFor wiring in import.meta.main's catch handler is actually connected. These five spawn
// the real cli.ts as a subprocess, no io injection, and read its real exit code. stdin is always
// "ignore" (never a TTY, immediately EOF), so a run that gets past the cwd check refuses fast on an
// empty key instead of hanging on the 60 s stdin timeout.
const CLI_PATH = join(REPO_ROOT, "tools", "pr-review", "cli.ts");

function runCli(cwd: string): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, CLI_PATH, "review", "--pr", "1", "--app-id", "1", "--key-stdin"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

describe("cli.ts subprocess: BUN-CWD wiring (R11-5)", () => {
  test("a cwd inside the repository checkout exits 2", () => {
    const result = runCli(REPO_ROOT);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("working directory");
  });

  test("a neutral cwd holding bunfig.toml exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-subprocess-bunfig-"));
    try {
      writeFileSync(join(dir, "bunfig.toml"), "");
      const result = runCli(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("working directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a neutral cwd holding .env.local exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-subprocess-env-"));
    try {
      writeFileSync(join(dir, ".env.local"), "");
      const result = runCli(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("working directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cwd reached through a symlink or junction into the checkout exits 2", () => {
    const base = mkdtempSync(join(tmpdir(), "pr-review-subprocess-link-"));
    const link = join(base, "link");
    let linked = true;
    try {
      symlinkSync(REPO_ROOT, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false;
    }
    try {
      if (!linked) {
        throw new Error("could not create a test symlink/junction into the checkout (environment lacks the privilege?)");
      }
      const result = runCli(link);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("working directory");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a genuinely neutral cwd proceeds past the cwd check and refuses on the real empty stdin", () => {
    // Proves REAL_IO's stdin binding and the io.exit(2) carry-forward end to end, not only via the
    // fake in the describe blocks above.
    const dir = mkdtempSync(join(tmpdir(), "pr-review-subprocess-neutral-"));
    try {
      const result = runCli(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("stdin carried no key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
