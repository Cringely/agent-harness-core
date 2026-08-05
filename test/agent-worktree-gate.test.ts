// Offline tests for the worktree-isolation PreToolUse gate
// (core/claude/hooks/agent-worktree-gate.ts). Classification and the full
// stdin-payload decision live in the exported pure requiresIsolation() and
// decide(), so these run against real temp agent-definition files but never
// spawn the hook process itself. Note the header at lines 53-55 also claims
// the stdin/stdout CLI wrapper (the `import.meta.main` block) is "covered
// separately by spawn tests in the same style" — no such spawn test exists
// here or anywhere else in test/; only the pure decide()/requiresIsolation()
// half of that claim is made true by this file.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decide,
  OVERRIDE_TOKEN,
  PROJECT_EXCEPTIONS,
  requiresIsolation,
} from "../core/claude/hooks/agent-worktree-gate";

// --- Fixture agent-definitions directory, built once. Every scenario below
// gets its own subagent_type name so none of them collide in the module's
// per-process classification cache (keyed on agentsDir + type). -----------

const agentsDir = mkdtempSync(join(tmpdir(), "worktree-gate-agents-"));

function writeDef(type: string, lines: string[]) {
  writeFileSync(join(agentsDir, `${type}.md`), ["---", ...lines, "---", "", "Body text."].join("\n"));
}

writeDef("reader", ["name: reader", "tools: Read, Grep, Glob"]);
writeDef("reader-mixed-case", ["name: reader-mixed-case", "tools: READ, Grep, WebFetch"]);
writeDef("writer", ["name: writer", "tools: Read, Write"]);
writeDef("no-tools", ["name: no-tools", "description: has no tools field at all"]);
writeDef("empty-tools", ["name: empty-tools", "tools:"]);
writeDef("memory-project", ["name: memory-project", "tools: Read, Grep, Glob", "memory: project"]);
writeDef("memory-user", ["name: memory-user", "tools: Read, Grep, Glob", "memory: user"]);
writeDef("memory-local", ["name: memory-local", "tools: Read, Grep, Glob", "memory: local"]);
writeDef("memory-substring", [
  "name: memory-substring",
  "description: tracks agent memory: cleanup notes",
  "tools: Read, Grep, Glob",
]);
writeFileSync(join(agentsDir, "malformed-no-close.md"), "---\nname: malformed-no-close\ntools: Read\n");
writeFileSync(join(agentsDir, "no-frontmatter.md"), "Just a body, no frontmatter delimiters at all.\n");
// A directory where a file is expected: existsSync sees it, readFileSync throws EISDIR.
mkdirSync(join(agentsDir, "unreadable-def.md"));

afterAll(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

describe("requiresIsolation() — tools: frontmatter, pre-existing paths", () => {
  test("read-only tools allowlist: exempted", () => {
    expect(requiresIsolation("reader", agentsDir)).toBe(false);
  });

  test("tokens are matched case-insensitively", () => {
    expect(requiresIsolation("reader-mixed-case", agentsDir)).toBe(false);
  });

  test("any write-capable tool in the list: requires isolation", () => {
    expect(requiresIsolation("writer", agentsDir)).toBe(true);
  });

  test("no tools: field at all: all tools, requires isolation", () => {
    expect(requiresIsolation("no-tools", agentsDir)).toBe(true);
  });

  test("empty tools: value: all tools, requires isolation", () => {
    expect(requiresIsolation("empty-tools", agentsDir)).toBe(true);
  });
});

describe("requiresIsolation() — memory: field forces isolation", () => {
  test.each(["memory-project", "memory-user", "memory-local"])(
    "%s: memory: overrides an otherwise read-only tools list",
    (type) => {
      expect(requiresIsolation(type, agentsDir)).toBe(true);
    },
  );

  test("no memory: key present: unaffected, falls through to the tools check", () => {
    expect(requiresIsolation("reader", agentsDir)).toBe(false);
    expect(requiresIsolation("writer", agentsDir)).toBe(true);
  });

  test("a `memory:` substring inside a description value does not trigger isolation (anchored at line start)", () => {
    expect(requiresIsolation("memory-substring", agentsDir)).toBe(false);
  });
});

describe("requiresIsolation() — fails toward isolation for a def it cannot prove read-only (not hook-level fail-open)", () => {
  test("malformed frontmatter (no closing ---): cannot parse, requires isolation", () => {
    expect(requiresIsolation("malformed-no-close", agentsDir)).toBe(true);
  });

  test("no frontmatter delimiters at all: requires isolation", () => {
    expect(requiresIsolation("no-frontmatter", agentsDir)).toBe(true);
  });

  test("def file exists but can't be read (EISDIR): requires isolation, does not throw", () => {
    expect(() => requiresIsolation("unreadable-def", agentsDir)).not.toThrow();
    expect(requiresIsolation("unreadable-def", agentsDir)).toBe(true);
  });

  test("no definition file, unknown type: requires isolation", () => {
    expect(requiresIsolation("some-unknown-role", agentsDir)).toBe(true);
  });

  test("no definition file, general-purpose: requires isolation (all tools)", () => {
    expect(requiresIsolation("general-purpose", agentsDir)).toBe(true);
  });

  test("no definition file, fork: requires isolation (all tools)", () => {
    expect(requiresIsolation("fork", agentsDir)).toBe(true);
  });
});

describe("requiresIsolation() — built-in read-only types", () => {
  test("explore: exempted", () => {
    expect(requiresIsolation("explore", agentsDir)).toBe(false);
  });

  test("plan: exempted", () => {
    expect(requiresIsolation("plan", agentsDir)).toBe(false);
  });
});

describe("requiresIsolation() — PROJECT_EXCEPTIONS", () => {
  afterEach(() => {
    PROJECT_EXCEPTIONS.length = 0;
  });

  test("a type listed in PROJECT_EXCEPTIONS bypasses classification entirely, even for a write-capable def", () => {
    PROJECT_EXCEPTIONS.push("writer");
    expect(requiresIsolation("writer", agentsDir)).toBe(false);
  });

  test("without the exception the same def still requires isolation", () => {
    expect(requiresIsolation("writer", agentsDir)).toBe(true);
  });
});

describe("decide() — payload-level fail-open (unrecognizable input allows)", () => {
  test("non-object payload", () => {
    expect(decide(null, agentsDir)).toEqual({ action: "allow" });
    expect(decide("nope", agentsDir)).toEqual({ action: "allow" });
  });

  test("tool_name other than Agent/Task is ignored", () => {
    expect(
      decide({ tool_name: "Bash", tool_input: { subagent_type: "writer" } }, agentsDir),
    ).toEqual({ action: "allow" });
  });

  test("tool_input not an object", () => {
    expect(decide({ tool_name: "Agent", tool_input: "nope" }, agentsDir)).toEqual({ action: "allow" });
  });

  test("subagent_type is a non-string value", () => {
    expect(
      decide({ tool_name: "Agent", tool_input: { subagent_type: 5 } }, agentsDir),
    ).toEqual({ action: "allow" });
  });
});

describe("decide() — subagent_type defaulting", () => {
  test("omitted subagent_type defaults to general-purpose, which requires isolation", () => {
    const verdict = decide({ tool_name: "Agent", tool_input: {} }, agentsDir);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain("general-purpose");
  });

  test("blank subagent_type also defaults to general-purpose", () => {
    const verdict = decide({ tool_name: "Task", tool_input: { subagent_type: "   " } }, agentsDir);
    expect(verdict.action).toBe("deny");
  });
});

describe("decide() — read-only type: always allowed", () => {
  test("no isolation needed for a read-only type", () => {
    expect(
      decide({ tool_name: "Agent", tool_input: { subagent_type: "reader" } }, agentsDir),
    ).toEqual({ action: "allow" });
  });
});

describe("decide() — write-capable type: isolation or override required", () => {
  test("no isolation, no override: denied", () => {
    const verdict = decide({ tool_name: "Agent", tool_input: { subagent_type: "writer" } }, agentsDir);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("writer");
      expect(verdict.reason).toContain(OVERRIDE_TOKEN);
    }
  });

  test.each(["worktree", "remote"])("isolation: %s allows", (isolation) => {
    expect(
      decide({ tool_name: "Agent", tool_input: { subagent_type: "writer", isolation } }, agentsDir),
    ).toEqual({ action: "allow" });
  });

  test("an isolation value that isn't worktree/remote does not pass", () => {
    const verdict = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "writer", isolation: "none" } },
      agentsDir,
    );
    expect(verdict.action).toBe("deny");
  });

  test("a reasoned override in the prompt allows", () => {
    expect(
      decide(
        {
          tool_name: "Agent",
          tool_input: { subagent_type: "writer", prompt: `${OVERRIDE_TOKEN} needed for X` },
        },
        agentsDir,
      ),
    ).toEqual({ action: "allow" });
  });

  test("a bare override token with no reason text does not pass", () => {
    const verdict = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "writer", prompt: OVERRIDE_TOKEN } },
      agentsDir,
    );
    expect(verdict.action).toBe("deny");
  });
});

describe("decide() — memory: field end to end", () => {
  test("a memory: def with read-only tools still requires isolation via decide()", () => {
    const verdict = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "memory-project" } },
      agentsDir,
    );
    expect(verdict.action).toBe("deny");
  });

  test("isolation: worktree still clears a memory: def", () => {
    expect(
      decide(
        { tool_name: "Agent", tool_input: { subagent_type: "memory-project", isolation: "worktree" } },
        agentsDir,
      ),
    ).toEqual({ action: "allow" });
  });
});

describe("decide() — subagent_type is normalized before classification", () => {
  test("mixed-case and padded type resolves the same def file", () => {
    expect(
      decide({ tool_name: "Agent", tool_input: { subagent_type: "  Reader  " } }, agentsDir),
    ).toEqual({ action: "allow" });
  });
});
