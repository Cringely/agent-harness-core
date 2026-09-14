// Tests for tools/pr-review/local-source.ts and snapshot.ts against a real temporary git
// repository. The property that matters most: trusted context is read at the BASE commit, so a
// change that edits CONTRIBUTING.md is reviewed against the version it is trying to replace.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalGitSource, syntheticCheckRuns } from "../tools/pr-review/local-source";
import { linkedIssueNumbers, selectHeadFiles } from "../tools/pr-review/snapshot";
import { MAX_HEAD_FILE_BYTES } from "../tools/pr-review/types";
import { computeVerification } from "../tools/pr-review/verdict";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function write(dir: string, path: string, content: string | Buffer) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-local-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Fixture Person");
  git(dir, "config", "user.email", "fixture@example.test");
  git(dir, "config", "core.autocrlf", "false");
  write(dir, "CONTRIBUTING.md", "BASE CONTRIBUTING\n");
  write(dir, ".github/workflows/test.yml", "jobs:\n");
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "src/removed.ts", "gone\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  write(dir, "CONTRIBUTING.md", "HEAD CONTRIBUTING\n");
  write(dir, "src/a.ts", "export const a = 2;\n");
  write(dir, "big.txt", "x".repeat(MAX_HEAD_FILE_BYTES + 1));
  write(dir, "blob.bin", Buffer.from([0x00, 0x01, 0x02]));
  rmSync(join(dir, "src/removed.ts"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feat: change a", "-m", "second paragraph");
  const head = git(dir, "rev-parse", "HEAD");
  return { dir, base, head };
}

describe("LocalGitSource.snapshot()", () => {
  test("assembles the diff, files, commits and base-commit context", async () => {
    const { dir, base, head } = makeRepo();
    const issues = [{ number: 98, title: "issue", body: "issue body" }];
    const snap = await new LocalGitSource({ repoDir: dir, base: "HEAD~1", head: "HEAD", checks: "passed", issues, title: "T", body: "B" }).snapshot();

    expect(snap.baseSha).toBe(base);
    expect(snap.headSha).toBe(head);
    expect(snap.repo).toBe("local");
    expect(snap.number).toBeNull();
    expect(snap.isOpen).toBe(true);
    expect(snap.title).toBe("T");
    expect(snap.body).toBe("B");
    expect(snap.linkedIssues).toEqual(issues);
    expect(snap.diff).toContain("-export const a = 1;");
    expect(snap.diff).toContain("+export const a = 2;");
    expect(snap.changedFiles).toEqual(["CONTRIBUTING.md", "big.txt", "blob.bin", "src/a.ts", "src/removed.ts"]);
    expect(snap.commitMessages).toEqual(["feat: change a\n\nsecond paragraph"]);
    expect(snap.headFiles.map((f) => f.path)).toEqual(["CONTRIBUTING.md", "src/a.ts"]);
    expect(snap.omittedFiles).toEqual(["big.txt", "blob.bin"]);
    expect(snap.workflowText).toBe("jobs:\n");
    expect(snap.changedFilesComplete).toBe(true);
  });

  test("trusted context is the base commit's copy, even when the change edits it", async () => {
    const { dir } = makeRepo();
    const snap = await new LocalGitSource({ repoDir: dir, base: "HEAD~1", head: "HEAD", checks: "passed" }).snapshot();
    expect(snap.trustedContext).toEqual([{ path: "CONTRIBUTING.md", content: "BASE CONTRIBUTING\n" }]);
    expect(snap.headFiles.find((f) => f.path === "CONTRIBUTING.md")?.content).toBe("HEAD CONTRIBUTING\n");
  });

  test("an unknown revision rejects rather than reviewing something else", async () => {
    const { dir } = makeRepo();
    await expect(new LocalGitSource({ repoDir: dir, base: "no-such-rev", head: "HEAD", checks: "passed" }).snapshot()).rejects.toThrow();
  });
});

describe("syntheticCheckRuns()", () => {
  test.each(["passed", "failed", "incomplete"] as const)("%s produces that verification state", (state) => {
    const verification = computeVerification({
      checkRuns: syntheticCheckRuns(state),
      changedFiles: ["README.md"],
      workflowText: "jobs:\n",
      changedFilesComplete: true,
    });
    expect(verification.state).toBe(state);
  });
});

describe("linkedIssueNumbers()", () => {
  test.each([
    ["Closes #98. Closes #116. Closes #118.", [98, 116, 118]],
    ["fixes #4, Resolved: #5 and closed #4 again", [4, 5]],
    ["Refs #122, refs #123", []],
    ["closes#7", []],
    ["Closes #1 Closes #2 Closes #3 Closes #4", [1, 2, 3]],
    ["", []],
  ] as const)("%p", (body, expected) => {
    expect(linkedIssueNumbers(body)).toEqual([...expected]);
  });
});

describe("selectHeadFiles()", () => {
  test("drops a file over the per-file cap, a file with a NUL byte, and files past the total cap", () => {
    const chunk = "y".repeat(55_000);
    const result = selectHeadFiles([
      { path: "too-big", content: "z".repeat(MAX_HEAD_FILE_BYTES + 1) },
      { path: "binary", content: "a\u0000b" },
      { path: "1", content: chunk },
      { path: "2", content: chunk },
      { path: "3", content: chunk },
      { path: "4", content: chunk },
      { path: "5", content: chunk },
    ]);
    expect(result.headFiles.map((f) => f.path)).toEqual(["1", "2", "3", "4"]);
    expect(result.omittedFiles).toEqual(["too-big", "binary", "5"]);
  });
});
