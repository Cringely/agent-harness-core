// Offline tests for the scratch-scope PreToolUse gate
// (core/claude/hooks/agent-write-scope.ts). The decision logic is in the
// exported pure inScratch()/decide(), so these run with no spawn, no
// filesystem, and no agent definitions on disk.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decide,
  inScratch,
  readSessionCwd,
  readWriteScope,
} from "../core/claude/hooks/agent-write-scope";

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

// --- readWriteScope() — item 38: agent_type is payload text, not a path fragment ---------------
//
// The hook interpolates agent_type straight into `.claude/agents/<type>.md`. These run against a
// real fixture tree because the escape only shows up against real files: every planted definition
// below declares `writeScope: scratch`, so an unguarded read RESOLVES it and returns "scratch",
// while a guarded one returns null — the same answer a missing definition gives, which is the
// behaviour this fix must not regress.

const scopeRoot = mkdtempSync(join(tmpdir(), "write-scope-agent-type-"));
const scopeProjectDir = join(scopeRoot, "project");
const scopeAgentsDir = join(scopeProjectDir, ".claude", "agents");
mkdirSync(join(scopeAgentsDir, "sub"), { recursive: true });
mkdirSync(join(scopeRoot, "outside"), { recursive: true });

function writeScopeDef(absPath: string) {
  writeFileSync(absPath, ["---", "name: planted", "writeScope: scratch", "---", "", "Body."].join("\n"));
}

writeScopeDef(join(scopeAgentsDir, "valid-agent.md"));
// This hook takes agent_type without lowercasing it (unlike agent-worktree-gate, which trims and
// lowercases first), so a mixed-case type has to survive the allowlist and reach the read. Planted
// and requested under the same name, so the assertion is about the guard and not about whether
// this filesystem happens to be case-sensitive.
writeScopeDef(join(scopeAgentsDir, "Mixed-Case-Agent.md"));
// The file an empty agent_type resolves to once `<type>.md` is interpolated.
writeScopeDef(join(scopeAgentsDir, ".md"));
// Reached by a separator-bearing name, and by an absolute one: node's join() folds a leading
// separator instead of restarting from the filesystem root, so `/sub/nested` lands here too.
writeScopeDef(join(scopeAgentsDir, "sub", "nested.md"));
// Outside the agents directory entirely — only a traversal reaches this one.
writeScopeDef(join(scopeRoot, "outside", "escaped.md"));

afterAll(() => {
  rmSync(scopeRoot, { recursive: true, force: true });
});

// `cwd` is the OTHER payload field that reaches the same path construction: it becomes projectDir
// when CLAUDE_PROJECT_DIR is unset, and it is the base inScratch() resolves a relative write
// against. It is a directory by design, so the agent-name allowlist is the wrong shape for it —
// see the header note on why the two fields are treated differently. What it does need is to be a
// string: `join(42, …)` and `resolve({}, …)` throw, and the throw is caught by the hook's
// outermost handler, so a malformed cwd used to silence a deny the gate would otherwise have made.
describe("readSessionCwd() — a non-string cwd falls back instead of throwing", () => {
  test("a real cwd string is used as given", () => {
    expect(readSessionCwd({ cwd: "/home/runner/project" })).toBe("/home/runner/project");
  });

  test.each([
    ["empty string", { cwd: "" }],
    ["a number", { cwd: 42 }],
    ["an object", { cwd: {} }],
    ["null", { cwd: null }],
    ["field absent", {}],
    ["payload not an object", null],
  ])("%s falls back to process.cwd()", (_label, payload) => {
    expect(readSessionCwd(payload)).toBe(process.cwd());
  });

  // Returning a string rather than undefined is the point: both consumers take it straight into
  // path resolution. The deny below uses an absolute path with no scratch segment so the outcome
  // does not depend on where this checkout happens to live.
  test("the fallback value still drives a real decision instead of throwing", () => {
    const cwd = readSessionCwd({ cwd: 42 });
    expect(() => inScratch("report.md", cwd)).not.toThrow();
    expect(decide("scratch", "/home/runner/project/src/index.ts", cwd).action).toBe("deny");
  });
});

describe("readWriteScope() — item 38: only a filename-safe agent name resolves a definition", () => {
  test("a normal agent name still resolves its definition", () => {
    expect(readWriteScope("valid-agent", scopeProjectDir)).toBe("scratch");
  });

  test("a mixed-case agent name resolves its definition, since this hook does not lowercase", () => {
    expect(readWriteScope("Mixed-Case-Agent", scopeProjectDir)).toBe("scratch");
  });

  test.each([
    ["traversal", "../../../outside/escaped"],
    ["absolute path", "/sub/nested"],
    ["path separator", "sub/nested"],
    ["empty string", ""],
  ])("%s in agent_type reads nothing: %p", (_label, agentType) => {
    expect(readWriteScope(agentType, scopeProjectDir)).toBeNull();
  });
});
