// Offline tests for the agent-name allowlist (core/claude/hooks/agent-name.ts), the guard both
// agent-worktree-gate.ts and agent-write-scope.ts put between a hook payload field and
// `<dir>/<name>.md`. Backlog item 38. The two hooks' own test files cover what the guard DOES to
// each gate's verdict against real fixture trees; this file covers the charset itself, which is
// the part neither hook can express and both depend on.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isValidAgentName } from "../core/claude/hooks/agent-name";

describe("isValidAgentName() — accepted", () => {
  test.each([
    "task-reviewer",
    "adversarial-reviewer",
    "general-purpose",
    "explore",
    "fork",
    "a",
    "agent_1",
    "Reader", // agent-write-scope reads agent_type without lowercasing it
    "0-leading-digit",
  ])("%p", (name) => {
    expect(isValidAgentName(name)).toBe(true);
  });
});

describe("isValidAgentName() — rejected", () => {
  test.each([
    ["empty string", ""],
    ["bare dot-dot", ".."],
    ["posix traversal", "../../etc/passwd"],
    ["windows traversal", "..\\..\\windows\\win.ini"],
    ["rooted posix path", "/etc/passwd"],
    ["drive-letter path", "C:\\Windows\\win.ini"],
    ["forward-slash separator", "sub/nested"],
    ["backslash separator", "sub\\nested"],
    ["leading dot", ".hidden"],
    ["leading hyphen", "-flag-shaped"],
    ["embedded space", "task reviewer"],
    ["trailing space", "task-reviewer "],
    ["embedded dot", "task-reviewer.md"],
    ["NUL byte", "task-reviewer\u0000.md"],
    ["newline", "task-reviewer\n"],
    ["url-encoded traversal", "%2e%2e%2fetc%2fpasswd"],
  ])("%s: %p", (_label, name) => {
    expect(isValidAgentName(name)).toBe(false);
  });

  // The field comes out of JSON.parse on hook stdin, so its type is whatever the payload said.
  test.each([[null], [undefined], [42], [true], [{}], [[]], [["task-reviewer"]]])(
    "non-string %p",
    (value) => {
      expect(isValidAgentName(value)).toBe(false);
    },
  );
});

// A guard tight enough to reject a name this repository actually ships would break the gates it
// protects, and the failure would be silent: every shipped role would classify as unknown and the
// worktree gate would deny every dispatch of it.
describe("isValidAgentName() — every agent definition this repo ships is accepted", () => {
  const repoRoot = join(import.meta.dir, "..");
  const names = ["core/claude/agents", "account/claude/agents"].flatMap((dir) =>
    readdirSync(join(repoRoot, dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length)),
  );

  test("the definition set is non-empty, so the check below is not vacuous", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  test.each(names)("%s", (name) => {
    expect(isValidAgentName(name)).toBe(true);
  });
});
