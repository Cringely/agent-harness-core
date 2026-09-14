// Tests for tools/pr-review/tool-state.ts, which the acceptance harness and the CLI both use to
// stamp a review with the reviewer revision that produced it, and which a posting run reads to refuse
// from a checkout with uncommitted changes.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, toolState } from "../tools/pr-review/tool-state";

function git(dir: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

describe("tool-state", () => {
  test("REPO_ROOT is this repository's root", () => {
    expect(existsSync(join(REPO_ROOT, "CONTRIBUTING.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "tools", "pr-review", "tool-state.ts"))).toBe(true);
  });

  test("toolState() reports a full SHA and a boolean dirty flag", () => {
    const state = toolState();
    expect(state.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof state.dirty).toBe("boolean");
  });

  // Coordinator ruling, 2026-09-11: a posting run refuses from a checkout with any uncommitted change,
  // so the flag covers the whole working tree, not only tools/pr-review.
  test("a change outside tools/pr-review makes the checkout dirty", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-tool-state-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.name", "Fixture Person");
      git(dir, "config", "user.email", "fixture@example.test");
      mkdirSync(join(dir, "tools", "pr-review"), { recursive: true });
      writeFileSync(join(dir, "tools", "pr-review", "cli.ts"), "export {};");
      writeFileSync(join(dir, "README.md"), "fixture");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fixture");
      expect(toolState(dir)).toEqual({ revision: git(dir, "rev-parse", "HEAD"), dirty: false });
      writeFileSync(join(dir, "README.md"), "edited");
      expect(toolState(dir).dirty).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A8.5: status.showUntrackedFiles=no would otherwise hide an untracked file from plain
  // `git status --porcelain`; --untracked-files=all overrides it.
  test("an untracked file is dirty even under status.showUntrackedFiles=no", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-tool-state-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.name", "Fixture Person");
      git(dir, "config", "user.email", "fixture@example.test");
      writeFileSync(join(dir, "README.md"), "fixture");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fixture");
      git(dir, "config", "status.showUntrackedFiles", "no");
      expect(toolState(dir).dirty).toBe(false);
      writeFileSync(join(dir, "new.txt"), "fixture");
      expect(toolState(dir).dirty).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A8.5: git treats an assume-unchanged tracked file as unchanged by definition, so a working-tree
  // edit underneath one never shows up in `git status --porcelain` at all; ls-files -v's lowercase
  // tag is the only place the divergence is visible.
  test("an edit to an assume-unchanged tracked file is still dirty", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-tool-state-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.name", "Fixture Person");
      git(dir, "config", "user.email", "fixture@example.test");
      writeFileSync(join(dir, "README.md"), "fixture");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fixture");
      // Marking the flag alone, with no actual divergence yet, is not asserted here: status
      // --porcelain cannot see behind an assume-unchanged entry either way, so the check below
      // treats the flag's mere presence as untrustworthy rather than trying to detect a real edit.
      git(dir, "update-index", "--assume-unchanged", "README.md");
      writeFileSync(join(dir, "README.md"), "edited");
      expect(toolState(dir).dirty).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // T8-5: skip-worktree is the other index bit `git status --porcelain` is silent about, tagged
  // uppercase `S` in `git ls-files -v` rather than lowercase, so it needs its own case: the regex's
  // lowercase branch alone does not cover it.
  test("an edit to a skip-worktree tracked file is still dirty", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-tool-state-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.name", "Fixture Person");
      git(dir, "config", "user.email", "fixture@example.test");
      writeFileSync(join(dir, "README.md"), "fixture");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "fixture");
      git(dir, "update-index", "--skip-worktree", "README.md");
      writeFileSync(join(dir, "README.md"), "edited");
      expect(toolState(dir).dirty).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
