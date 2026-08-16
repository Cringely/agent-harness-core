// Offline tests for the scratch-scope PreToolUse gate
// (core/claude/hooks/agent-write-scope.ts). The decision logic is in the
// exported pure inScratch()/decide(), so these run with no spawn, no
// filesystem, and no agent definitions on disk.

import { describe, expect, test } from "bun:test";
import { decide, inScratch } from "../core/claude/hooks/agent-write-scope";

const CWD = "/home/runner/project";

describe("inScratch() — path classification", () => {
  test.each([
    "/tmp/claude/proj/sess/scratchpad/report.md",
    "C:\\Users\\me\\AppData\\Local\\Temp\\claude\\proj\\sess\\scratchpad\\findings.md",
    "/home/runner/project/.scratch/notes.md",
    "scratchpad/relative.md",
    "/tmp/SCRATCHPAD/case-insensitive.md",
  ])("in scope: %s", (p) => {
    expect(inScratch(p, CWD)).toBe(true);
  });

  test.each([
    "/home/runner/project/src/index.ts",
    "C:\\Users\\me\\.claude\\rules\\agent-usage.md",
    "docs/STATE.md",
    "/etc/hosts",
    // Traversal out of a scratch dir resolves away from it, so it must not pass.
    "/tmp/scratchpad/../../etc/passwd",
    // A file merely NAMED scratchpad is not a scratch directory.
    "/home/runner/project/scratchpad.md",
  ])("out of scope: %s", (p) => {
    expect(inScratch(p, CWD)).toBe(false);
  });

  // The installer creates a scratch drop box at `.claude/scratch/` (see
  // install/Install-Harness.ps1). A gate that does not recognise that name denies
  // the one scratch directory the harness ships.
  test("the installer-created .claude/scratch/ is in scope", () => {
    expect(inScratch("/home/runner/project/.claude/scratch/report.md", CWD)).toBe(true);
    expect(inScratch("C:\\repo\\.claude\\scratch\\report.md", CWD)).toBe(true);
  });

  // Widening the segment set to accept `scratch` must not drag the rest of
  // `.claude` in with it.
  test("a sibling directory under .claude stays out of scope", () => {
    expect(inScratch("/home/runner/project/.claude/agents/task-reviewer.md", CWD)).toBe(false);
  });

  test("relative paths resolve against cwd, not the filesystem root", () => {
    expect(inScratch("../.scratch/x.md", "/home/runner/project/sub")).toBe(true);
    expect(inScratch("../src/x.ts", "/home/runner/project/sub")).toBe(false);
  });
});

describe("decide() — only scratch-scoped agents are gated", () => {
  test("scoped agent writing outside scratch is denied", () => {
    const verdict = decide("scratch", "/home/runner/project/src/index.ts", CWD);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("writeScope: scratch");
    }
  });

  test("scoped agent writing inside scratch is allowed", () => {
    expect(decide("scratch", "/tmp/claude/s/scratchpad/r.md", CWD)).toEqual({
      action: "allow",
    });
  });

  test("scoped agent writing to the installer-created scratch dir is allowed", () => {
    expect(decide("scratch", "/home/runner/project/.claude/scratch/report.md", CWD)).toEqual({
      action: "allow",
    });
  });

  // The deny counterpart to the case above: accepting `.claude/scratch/` must not
  // open the rest of `.claude`.
  test("scoped agent writing elsewhere under .claude is denied", () => {
    const verdict = decide("scratch", "/home/runner/project/.claude/agents/x.md", CWD);
    expect(verdict.action).toBe("deny");
  });

  // Absence of a declaration means the hook has no opinion. This is what keeps
  // installing the gate from changing behaviour for existing agents.
  test.each([null, "repo", ""])("unscoped agent is untouched: %p", (scope) => {
    expect(decide(scope, "/home/runner/project/src/index.ts", CWD)).toEqual({
      action: "allow",
    });
  });

  test("main session (no agent_type, so no scope) is untouched", () => {
    expect(decide(null, "/anywhere/at/all.md", CWD)).toEqual({ action: "allow" });
  });

  test("missing file_path allows rather than crashing — fail open", () => {
    expect(decide("scratch", undefined, CWD)).toEqual({ action: "allow" });
  });
});
