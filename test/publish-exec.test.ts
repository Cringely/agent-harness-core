// Tests for tools/publish/exec.ts (#274). These start real child processes, using the bun binary
// running this suite (process.execPath) as the child, so they need no gh, git or key.

import { describe, expect, test } from "bun:test";
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
