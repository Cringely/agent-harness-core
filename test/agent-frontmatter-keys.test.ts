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
// Two cases, kept separate on purpose (see issue #11):
//   - a key not in ALLOWED_KEYS -> hard failure, one test per offending file.
//   - any `effort` VALUE -> asserted nowhere, in either direction. Absent is not
//     a finding; present on a model with no effort support is not either, since
//     whether a haiku def should carry `effort` is an open question on #11 and a
//     test is the wrong place to hold an open argument. What a sonnet def should
//     carry joined that list on 2026-09-05, when the operator dropped the
//     xhigh mandate the gate used to enforce: effort is a per-role judgment now,
//     and the defs are where that judgment gets written down.
//
// It also pins the defs against core's own model-tier gate, which lives here
// because the file walk is already done. A key that parses is not the same as a
// tier core will run: a def that omits `model:` or writes `inherit` loads fine
// and dispatches at the session model, which is the failure the gate was built
// for. Stated as the gate's rule rather than as dispatch behavior on purpose:
// the gate reads the tool payload, not the def, so what a real dispatch of these
// types sends is uncaptured. The rule comes from the gate by import, never
// restated here.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VALID_TIERS } from "../core/claude/hooks/model-tier-gate";

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

/** Top-level `key: value` pairs from the frontmatter block, in file order. */
function frontmatterPairs(text: string): { key: string; value: string }[] {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (fm === undefined) return [];
  return fm
    .split(/\r?\n/)
    // No `$`. `.*` is greedy and already stops at a line terminator, and `$` without
    // the `m` flag matches end of input only, so a bare `\r` or U+2028 surviving
    // split(/\r?\n/) would fail the whole line and drop its key silently. That is the
    // one failure this file cannot afford: the key it drops is `reasoning_effort`.
    .map((line) => line.match(/^([a-zA-Z0-9_-]+)\s*:(.*)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ key: m[1], value: unquote(m[2].trim()) }));
}

/** Strip one pair of surrounding quotes, which YAML allows and the platform's parse removes, so a
 * def written `effort: "xhigh"` is read the way the dispatch payload would carry it. */
function unquote(v: string): string {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/** Top-level `key: value` lines from the frontmatter block, in file order. */
function frontmatterKeys(text: string): string[] {
  return frontmatterPairs(text).map((p) => p.key);
}

/** First value for `key`, or "" when the def does not declare it. */
function frontmatterValue(text: string, key: string): string {
  return frontmatterPairs(text).find((p) => p.key === key)?.value ?? "";
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

describe("shipped defs satisfy the gate core ships beside them", () => {
  // One case, down from two on 2026-09-05. The dropped one asserted that every
  // def declared an effort the gate accepts, via the gate's own
  // `effortViolation`. With the sonnet/xhigh mandate gone that function returned
  // null for every input, so the case passed against every possible def and
  // measured nothing — a test that cannot fail is worse than no test, because it
  // reads as coverage. The tier check below is the half that still discriminates:
  // a def with no `model:`, or one writing `inherit`, dispatches at the session
  // model, and "" is not a valid tier.
  test.each(DEF_PATHS)("%s names a tier the gate accepts", (path) => {
    expect(VALID_TIERS).toContain(frontmatterValue(readFileSync(path, "utf8"), "model"));
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
