// Tests for tools/publish/cli.ts (#274): argument parsing, the working-directory guard, and the
// exit code and output for each way a command ends.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNeutralCwd, main, parseCommand, realDeps, type CliDeps } from "../tools/publish/cli";
import { parsePublishConfig } from "../tools/publish/config";
import { PublishRefusal, UsageError } from "../tools/publish/errors";
import { childEnv, realRunner } from "../tools/publish/exec";
import { FakeRunner, on, REPO } from "./publish-fakes";

const ROOT = mkdtempSync(join(tmpdir(), "publish-cli-"));
const WORK = join(ROOT, "work");
const ELSEWHERE = join(ROOT, "elsewhere");
mkdirSync(WORK);
mkdirSync(ELSEWHERE);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const NOT_A_REPO = on(["git", "-C"], { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" });
const ABS = process.platform === "win32" ? "C:/fixture/body.md" : "/fixture/body.md";
const PIN = "f".repeat(40);
const RM = ["review-merge", "--repo", REPO, "--pr", "9", "--tool-head", PIN];

describe("parseCommand()", () => {
  test("parses pr create", () => {
    expect(
      parseCommand(["pr", "create", "--repo", REPO, "--base", "main", "--head", "feat/x", "--title", "t", "--body-file", ABS, "--closes", "4,5", "--draft"]),
    ).toEqual({ kind: "pr-create", repo: REPO, base: "main", head: "feat/x", title: "t", bodyFile: ABS, closes: [4, 5], draft: true });
  });

  test("parses review-merge with its defaults", () => {
    expect(parseCommand(RM)).toEqual({
      kind: "review-merge",
      repo: REPO,
      pr: 9,
      closes: [],
      allowAdmin: false,
      adminReasonFile: null,
      method: "merge",
      checksTimeoutMin: 30,
      toolHead: PIN,
    });
  });

  // The pin names the only commit the credential-holding code may run from, so there is no default.
  test("requires --tool-head as a full lowercase commit id", () => {
    expect(() => parseCommand(["review-merge", "--repo", REPO, "--pr", "9"])).toThrow(UsageError);
    for (const bad of ["", "f".repeat(39), "F".repeat(40), "f".repeat(41), "master", `${"f".repeat(39)}g`]) {
      expect(() => parseCommand(["review-merge", "--repo", REPO, "--pr", "9", "--tool-head", bad])).toThrow(UsageError);
    }
  });

  test("takes --allow-admin only together with --admin-reason-file", () => {
    expect(() => parseCommand([...RM, "--allow-admin"])).toThrow(UsageError);
    expect(() => parseCommand([...RM, "--admin-reason-file", ABS])).toThrow(UsageError);
    expect(parseCommand([...RM, "--allow-admin", "--admin-reason-file", ABS])).toMatchObject({
      allowAdmin: true,
      adminReasonFile: ABS,
    });
  });

  test("requires an explicit repository", () => {
    expect(() => parseCommand(["issue", "create", "--title", "t", "--body-file", ABS])).toThrow(UsageError);
  });

  test("requires an explicit base on pr create and pr edit", () => {
    expect(() => parseCommand(["pr", "create", "--repo", REPO, "--head", "feat/x", "--title", "t", "--body-file", ABS])).toThrow(UsageError);
    expect(() => parseCommand(["pr", "edit", "--repo", REPO, "--pr", "9", "--title", "t"])).toThrow(UsageError);
  });

  test("takes the body only from a file", () => {
    expect(() => parseCommand(["issue", "create", "--repo", REPO, "--title", "t", "--body", "inline"])).toThrow(UsageError);
    expect(() => parseCommand(["issue", "create", "--repo", REPO, "--title", "t", "--body-file", "-"])).toThrow(UsageError);
  });

  test("rejects a multi-line title", () => {
    expect(() => parseCommand(["issue", "create", "--repo", REPO, "--title", "a\nb", "--body-file", ABS])).toThrow(UsageError);
  });

  test("rejects a branch name that reads as a flag", () => {
    expect(() => parseCommand(["pr", "create", "--repo", REPO, "--base", "main", "--head=-x", "--title", "t", "--body-file", ABS])).toThrow(UsageError);
  });

  test("rejects --closes on pr edit without a new body", () => {
    expect(() => parseCommand(["pr", "edit", "--repo", REPO, "--pr", "9", "--base", "main", "--title", "t", "--closes", "4"])).toThrow(UsageError);
  });

  test("rejects an out-of-range checks timeout and an unknown merge method", () => {
    expect(() => parseCommand([...RM, "--checks-timeout-min", "0"])).toThrow(UsageError);
    expect(() => parseCommand([...RM, "--method", "squash"])).toThrow(UsageError);
  });
});

describe("assertNeutralCwd()", () => {
  test("passes in the empty work directory outside any work tree", () => {
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([NOT_A_REPO]), {})).not.toThrow();
  });

  test("refuses any other working directory", () => {
    expect(() => assertNeutralCwd(ELSEWHERE, WORK, new FakeRunner([NOT_A_REPO]), {})).toThrow(PublishRefusal);
  });

  test("refuses a work directory that does not exist", () => {
    const missing = join(ROOT, "missing");
    expect(() => assertNeutralCwd(missing, missing, new FakeRunner([NOT_A_REPO]), {})).toThrow(PublishRefusal);
  });

  test("refuses a work directory holding a bunfig.toml", () => {
    const dir = join(ROOT, "with-bunfig");
    mkdirSync(dir);
    writeFileSync(join(dir, "bunfig.toml"), "");
    expect(() => assertNeutralCwd(dir, dir, new FakeRunner([NOT_A_REPO]), {})).toThrow(PublishRefusal);
  });

  test("refuses a work directory inside a git work tree", () => {
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([on(["git", "-C"], { stdout: "true\n" })]), {})).toThrow(PublishRefusal);
  });

  test("refuses when git is not on PATH", () => {
    const probe = () => assertNeutralCwd(WORK, WORK, new FakeRunner([on(["git"], { spawnError: true, code: null })]), {});
    expect(probe).toThrow(PublishRefusal);
    expect(probe).toThrow("git is not on PATH");
  });

  test("refuses when the git probe fails for any reason other than not being a repository", () => {
    const dubious = on(["git", "-C"], { code: 128, stderr: "fatal: detected dubious ownership in repository" });
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([dubious]), {})).toThrow(PublishRefusal);
  });

  test("runs the git probe in the C locale", () => {
    const runner = new FakeRunner([NOT_A_REPO]);
    assertNeutralCwd(WORK, WORK, runner, {});
    expect(runner.calls[0]!.options.env?.LC_ALL).toBe("C");
  });

  // GIT_DIR at a missing path, or GIT_CEILING_DIRECTORIES above the work directory, makes git
  // answer "not a git repository" without having searched the directory's parents.
  test("strips the variables that redirect or stop git's repository search from the probe", () => {
    const runner = new FakeRunner([NOT_A_REPO]);
    const redirecting = {
      PATH: "x",
      GIT_DIR: "/missing/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_CEILING_DIRECTORIES: "/",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_COMMON_DIR: "/missing",
      git_dir: "/missing/lower",
    };
    assertNeutralCwd(WORK, WORK, runner, redirecting);
    const env = runner.calls[0]!.options.env!;
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_COMMON_DIR", "git_dir"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.PATH).toBe("x");
  });

  test("refuses a not-a-repository answer that names an explicit git directory", () => {
    const pointed = on(["git", "-C"], { code: 128, stderr: "fatal: not a git repository: '/missing/.git'" });
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([pointed]), {})).toThrow(PublishRefusal);
  });

  test("refuses a probe that exits 0 without saying it is inside a work tree", () => {
    const silent = on(["git", "-C"], { code: 0, stderr: "fatal: not a git repository (or any of the parent directories): .git" });
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([silent]), {})).toThrow(PublishRefusal);
  });

  test("refuses a probe killed at a timeout or by a signal", () => {
    const killed = on(["git", "-C"], { code: null, stderr: "fatal: not a git repository (or any of the parent directories): .git" });
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([killed]), {})).toThrow(PublishRefusal);
  });
});

// review-merge reads the tool's own checkout and the reviewer checkout through deps.toolState. git
// exports GIT_DIR inside every hook, and one inherited from there must not answer for the checkout.
// Bun hands a child the environment this process started with, not later edits to process.env, so
// the inherited GIT_DIR is given to a fresh bun process that calls realDeps() itself.
describe("realDeps()", () => {
  test("reads a checkout's state with the inherited GIT_DIR removed", () => {
    const clean = childEnv(process.env);
    const other = join(ROOT, "other-repo");
    realRunner.run(["git", "init", "-q", other], { env: clean });
    realRunner.run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-C", other, "commit", "-q", "--allow-empty", "-m", "other"], {
      env: clean,
    });
    const toolRoot = realDeps().toolRoot;
    const expected = realRunner.run(["git", "-C", toolRoot, "rev-parse", "HEAD"], { env: clean }).stdout.trim();
    const cli = JSON.stringify(join(import.meta.dir, "..", "tools", "publish", "cli.ts"));
    const script = `const { realDeps } = await import(${cli}); const d = realDeps(); process.stdout.write(d.toolState(d.toolRoot).revision);`;
    const result = realRunner.run([process.execPath, "-e", script], { cwd: ROOT, env: { ...clean, GIT_DIR: join(other, ".git") } });
    expect(result.stdout.trim()).toBe(expected);
  });
});

describe("main()", () => {
  function deps(overrides: Partial<CliDeps> = {}): CliDeps & { lines: { out: string[]; err: string[] } } {
    const lines = { out: [] as string[], err: [] as string[] };
    return {
      runner: new FakeRunner([NOT_A_REPO]),
      cwd: WORK,
      workDir: WORK,
      toolRoot: WORK,
      env: {},
      loadConfig: () => parsePublishConfig(JSON.stringify({ owners: { other: { gitName: "o", gitEmail: "o@example.test", ghUser: "other" } } })),
      loadIdentity: () => ({ ok: true, declared: true, accountEmail: true, decl: { names: [], emails: [], username: "fixtureuser", hostname: "fixture-host" } }),
      readBody: () => "body",
      exists: () => true,
      toolState: () => ({ revision: "x", dirty: false }),
      sleep: () => {},
      bunPath: "bun",
      out: (line) => lines.out.push(line),
      err: (line) => lines.err.push(line),
      lines,
      ...overrides,
    };
  }
  const CREATE = ["issue", "create", "--repo", REPO, "--title", "t", "--body-file", ABS];

  test("help exits 0", async () => {
    expect(await main(["help"], deps())).toBe(0);
  });

  test("a usage error exits 1", async () => {
    const d = deps();
    expect(await main(["issue", "create"], d)).toBe(1);
    expect(d.lines.err[0]).toStartWith("usage error:");
  });

  test("a refusal exits 2 with a refused line", async () => {
    const d = deps();
    expect(await main(CREATE, d)).toBe(2);
    expect(d.lines.err).toEqual(["refused: the publish config declares no identity for this repository's owner"]);
  });

  test("the working-directory guard refuses before the config is read", async () => {
    let read = false;
    const d = deps({
      cwd: ELSEWHERE,
      loadConfig: () => {
        read = true;
        throw new Error("unreachable");
      },
    });
    expect(await main(CREATE, d)).toBe(2);
    expect(read).toBe(false);
  });

  test("an unexpected error prints its class and never its message", async () => {
    const d = deps({
      loadConfig: () => {
        throw new SyntaxError("Unexpected token in fixture-secret-text");
      },
    });
    expect(await main(CREATE, d)).toBe(1);
    expect(d.lines.err).toEqual(["error: unexpected failure (SyntaxError)"]);
  });
});
