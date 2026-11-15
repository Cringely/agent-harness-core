// Tests for tools/publish/exec.ts (#274). These start real child processes, using the bun binary
// running this suite (process.execPath) as the child, so they need no gh, git or key.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolState } from "../tools/pr-review/tool-state";
import { childEnv, realRunner } from "../tools/publish/exec";

const BUN = process.execPath;

describe("childEnv()", () => {
  test("drops every GitHub token variable, whatever its case", () => {
    const env = childEnv({ GH_TOKEN: "a", gh_token: "b", GITHUB_TOKEN: "c", GH_ENTERPRISE_TOKEN: "d", GITHUB_ENTERPRISE_TOKEN: "e", KEEP: "1" });
    expect(env).toEqual({ KEEP: "1" });
  });

  test("adds the extras after the drop, so a caller's chosen token survives", () => {
    expect(childEnv({ GH_TOKEN: "inherited" }, { GH_TOKEN: "chosen" })).toEqual({ GH_TOKEN: "chosen" });
  });

  test("skips undefined values", () => {
    expect(childEnv({ A: undefined, B: "2" })).toEqual({ B: "2" });
  });

  test("drops every variable git reads to find, redirect or reconfigure a repository, whatever its case", () => {
    const redirecting = [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_NAMESPACE",
      "GIT_CEILING_DIRECTORIES",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM",
      "GIT_CONFIG",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_KEY_12",
      "GIT_CONFIG_PARAMETERS",
      "git_dir",
      "Git_Work_Tree",
      "git_config_key_3",
    ];
    const base: Record<string, string> = { PATH: "x", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh" };
    for (const name of redirecting) base[name] = "/elsewhere";
    expect(childEnv(base)).toEqual({ PATH: "x", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh" });
  });
});

// git exports GIT_DIR inside every hook. A child that inherited one naming another repository
// would read that repository's origin and HEAD instead of the directory -C names.
describe("git children under an inherited GIT_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-gitenv-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const clean = childEnv(process.env);
  function repo(name: string, origin: string): { dir: string; head: string } {
    const dir = join(root, name);
    const git = (...args: string[]) => {
      const result = realRunner.run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-C", dir, ...args], { env: clean });
      if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    realRunner.run(["git", "init", "-q", dir], { env: clean });
    git("remote", "add", "origin", origin);
    git("commit", "-q", "--allow-empty", "-m", name);
    return { dir, head: git("rev-parse", "HEAD") };
  }
  const target = repo("target", "https://github.com/fixture/target.git");
  const other = repo("other", "https://github.com/fixture/other.git");
  const inherited = { ...process.env, GIT_DIR: join(other.dir, ".git"), GIT_WORK_TREE: other.dir };

  test("the origin read answers for the -C directory", () => {
    const result = realRunner.run(["git", "-C", target.dir, "remote", "get-url", "origin"], { env: childEnv(inherited) });
    expect(result.stdout.trim()).toBe("https://github.com/fixture/target.git");
  });

  test("the checkout pin answers for the -C directory", () => {
    expect(toolState(target.dir, childEnv(inherited))).toEqual({ revision: target.head, dirty: false });
  });

  // The pin above passes only if toolState hands git the env it was given: this one shows it does,
  // since the GIT_DIR left in on purpose here wins over -C.
  test("toolState runs git with exactly the env it is given", () => {
    expect(toolState(target.dir, { ...clean, GIT_DIR: join(other.dir, ".git") }).revision).toBe(other.head);
  });
});

describe("realRunner.run()", () => {
  test("returns stdout and the exit code", () => {
    const result = realRunner.run([BUN, "-e", "process.stdout.write('out'); process.exit(3)"]);
    expect(result).toMatchObject({ code: 3, stdout: "out", spawnError: false, timedOut: false });
  });

  test("feeds stdin", () => {
    const result = realRunner.run([BUN, "-e", "process.stdout.write((await Bun.stdin.text()).toUpperCase())"], { stdin: "body text" });
    expect(result.stdout).toBe("BODY TEXT");
  });

  test("passes only the env it is given", () => {
    const result = realRunner.run([BUN, "-e", "process.stdout.write(String(process.env.GH_TOKEN ?? 'unset'))"], {
      env: childEnv({ ...process.env, GH_TOKEN: "inherited" }),
    });
    expect(result.stdout).toBe("unset");
  });

  test("reports a missing executable as spawnError instead of throwing", () => {
    expect(realRunner.run(["zz-no-such-binary-274"])).toMatchObject({ spawnError: true, code: null });
  });

  test("reports a timeout", () => {
    const result = realRunner.run([BUN, "-e", "await Bun.sleep(5000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });
});

describe("realRunner.runPiped()", () => {
  test("moves the producer's stdout into the consumer's stdin", async () => {
    const env = childEnv(process.env);
    const result = await realRunner.runPiped(
      { argv: [BUN, "-e", "process.stdout.write('twelve bytes')"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "process.stdout.write(String((await Bun.stdin.text()).length))"], cwd: process.cwd(), env, timeoutMs: 10_000 },
    );
    expect(result.producerCode).toBe(0);
    expect(result.consumer).toMatchObject({ code: 0, stdout: "12", spawnError: false });
  });

  test("reports the producer's own exit code", async () => {
    const env = childEnv(process.env);
    const result = await realRunner.runPiped(
      { argv: [BUN, "-e", "process.exit(5)"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "await Bun.stdin.text()"], cwd: process.cwd(), env, timeoutMs: 10_000 },
    );
    expect(result.producerCode).toBe(5);
  });

  // A key command that hangs (an authorization prompt nobody answers) must not hold review-merge
  // open after the reviewer has been killed at its timeout.
  test("kills a producer still running when the consumer times out", async () => {
    const env = childEnv(process.env);
    const started = Date.now();
    const result = await realRunner.runPiped(
      { argv: [BUN, "-e", "await Bun.sleep(6000)"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "await Bun.stdin.text()"], cwd: process.cwd(), env, timeoutMs: 500 },
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.consumer.timedOut).toBe(true);
    expect(result.producerCode).not.toBe(0);
  });

  test("reports a producer that cannot start", async () => {
    const env = childEnv(process.env);
    const result = await realRunner.runPiped(
      { argv: ["zz-no-such-binary-274"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "0"], cwd: process.cwd(), env, timeoutMs: 10_000 },
    );
    expect(result.producerSpawnError).toBe(true);
    expect(result.consumer.spawnError).toBe(true);
  });
});
