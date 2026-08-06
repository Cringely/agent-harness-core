// Frontmatter key allowlist for core/claude/agents/*.md. An unrecognized key
// loads without complaint (`reasoning_effort` instead of `effort` silently ran
// every def at inherited session effort from 41b5d43 until b91a087, and a
// downstream project carried the same typo in five defs for 19 days). This
// test is the cheapest mechanism from issue #11: it globs the real agent
// defs, parses their frontmatter, and fails the day an unknown key merges —
// no spawn, no YAML dependency, no fixture drift.
//
// Frontmatter extraction mirrors core/claude/hooks/agent-worktree-gate.ts
// (~lines 125-137): a `^---\r?\n...\r?\n---` block, split into lines, keys
// matched at column 0 so an indented continuation or a `key:` substring
// inside a description value never false-positives.
//
// The allowlist is platform keys PLUS core's own declared extensions, kept
// narrow rather than guessed:
//   - name, description, model, effort, tools — every key actually used
//     across the five defs on master today.
//   - memory — not currently used by any def, but agent-worktree-gate.ts
//     parses it (`^memory\s*:\s*\S/i`, auto-grants Read/Write/Edit per the
//     platform's persistent-memory docs), so it is a documented platform key
//     regardless of current usage.
//   - writeScope — core's OWN extension, not a platform key. Declared on
//     research-scout.md and read by core/claude/hooks/agent-write-scope.ts to
//     scope a subagent's writes to a scratch directory. It belongs on the
//     allowlist for the opposite reason memory does: leaving it off would
//     fail a key that works exactly as designed.
//
// Three cases, kept separate on purpose (see issue #11):
//   - a key not in ALLOWED_KEYS -> hard failure, one test per offending file.
//   - effort key ABSENT -> not a finding, asserted nowhere.
//   - effort key PRESENT on a model with no effort support -> deliberately
//     NOT asserted. Whether a haiku def should carry `effort` is an open
//     question on #11, unsettled until someone captures what haiku actually
//     does with the parameter. A test is the wrong place to hold an open
//     argument, and asserting either way would fail against master.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const AGENTS_DIR = join(REPO_ROOT, "core/claude/agents");

/** Platform keys actually in use, plus `memory` (parsed by the worktree gate
 * even though no current def declares it), plus core's own `writeScope`. */
const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "model",
  "effort",
  "tools",
  "memory",
  "writeScope",
]);

function agentDefPaths(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(AGENTS_DIR, name));
}

/** Top-level `key: value` lines from the frontmatter block, in file order. */
function frontmatterKeys(text: string): string[] {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (fm === undefined) return [];
  return fm
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-zA-Z0-9_-]+)\s*:/)?.[1])
    .filter((key): key is string => key !== undefined);
}

const DEF_PATHS = agentDefPaths();

describe("agent def discovery", () => {
  test("at least one definition file is found under core/claude/agents", () => {
    expect(DEF_PATHS.length).toBeGreaterThan(0);
  });
});

describe("frontmatter keys are on the allowlist", () => {
  test.each(DEF_PATHS)("%s declares only allowed keys", (path) => {
    const keys = frontmatterKeys(readFileSync(path, "utf8"));
    expect(keys.length).toBeGreaterThan(0); // sanity: extraction actually found the block
    const unknown = keys.filter((k) => !ALLOWED_KEYS.has(k));
    expect(unknown).toEqual([]);
  });
});

describe("the allowlist catches the real defect", () => {
  // Both spellings of the historical typo, underscore and hyphen. The hyphen
  // case is why the key regex accepts digits and hyphens: a key it fails to
  // capture vanishes silently instead of failing as unknown.
  test.each(["reasoning_effort", "reasoning-effort", "effort2"])(
    "a %s typo is caught as an unknown key",
    (typo) => {
      const keys = frontmatterKeys(
        `---\nname: x\nmodel: haiku\n${typo}: low\n---\nbody\n`,
      );
      expect(keys.filter((k) => !ALLOWED_KEYS.has(k))).toEqual([typo]);
    },
  );
});
