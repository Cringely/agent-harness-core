// Pins two silent-inertness modes for the three hooks git itself invokes (#136, the
// index-mode pin ported from spacemolt-harness#99): a hook staged 100644 is skipped by git
// with no error, and a hook whose sourced sibling has gone missing either refuses or no-ops.
//
// Mode is read from the git INDEX, never the working tree. A Windows working tree does not
// carry the exec bit reliably, so a filesystem stat says nothing about the committed mode.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOOKS_DIR = "core/claude/hooks";
// Same set as $gitHookNames in install/Install-Harness.ps1.
const GIT_HOOKS = ["pre-commit", "pre-push", "commit-msg"];

// Every hook_dir reference each hook is expected to carry. "required" siblings must exist in
// core. "optional" ones are guarded at runtime (pre-commit falls back to a global Vale config
// when the project one is absent), so only their presence in the hook is pinned, not the file.
// A reference outside both lists fails: add it here on purpose, with its guard.
const EXPECTED: Record<string, { required: string[]; optional: string[] }> = {
  "pre-commit": { required: ["identity-patterns.sh"], optional: ["../tools/prose-lint/.vale.ini"] },
  "pre-push": { required: ["identity-patterns.sh"], optional: [] },
  "commit-msg": { required: [], optional: [] },
};

// Splits a hook's hook_dir uses into the ones this parser reads in full (a "$hook_dir/<path>"
// ending at a quote, whitespace or end of text) and a raw count of every "$hook_dir" or
// "${hook_dir" use. Brace form, a bare "$hook_dir", or a path ending in a character outside the
// path class makes parsed.length smaller than total, which the tests turn into a failure.
function hookDirRefs(text: string): { parsed: string[]; total: number } {
  const total = (text.match(/\$\{?hook_dir\b/g) ?? []).length;
  const parsed = [...text.matchAll(/\$hook_dir\/([A-Za-z0-9._\/-]+)(?=["'\s]|$)/g)].map((m) => m[1]);
  return { parsed, total };
}

// Finds every statement that runs `.` or `source` (at the start of a line or after ; & | ( { then
// do else) and resolves its argument to a path under the hooks directory. An argument is resolved
// only when it is a literal "$hook_dir/<path>" or a single variable assigned exactly that way in
// the same hook. Any other form (dirname or $0 construction, a literal, an unassigned variable)
// is returned in unresolved, which the tests turn into a failure.
function sourceTargets(text: string): { resolved: string[]; unresolved: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const stmt = /(?:^|[;&|({]|\b(?:then|do|else))\s*(?:\.|source)\s+([^\s;&|)]+)/g;
  const hookDirPath = /^\$hook_dir\/([A-Za-z0-9._\/-]+)$/;
  for (const line of lines) {
    for (const m of line.matchAll(stmt)) {
      const arg = m[1].replace(/^["']|["']$/g, "");
      let target = arg;
      const v = arg.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
      if (v) {
        const assigns = [...text.matchAll(new RegExp(`^\\s*${v[1]}=(.*)$`, "gm"))];
        target = assigns.length === 1 ? assigns[0][1].trim().replace(/^["']|["']$/g, "") : "";
      }
      const p = target.match(hookDirPath);
      if (p) resolved.push(p[1]);
      else unresolved.push(m[0].trim());
    }
  }
  return { resolved, unresolved };
}

function indexMode(path: string): string | undefined {
  const out = Bun.spawnSync(["git", "ls-files", "-s", "--", path], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(out.stdout).trim().split(/\s+/)[0] || undefined;
}

describe("hookDirRefs parser", () => {
  test("reads a plain sibling path in full", () => {
    expect(hookDirRefs('lib="$hook_dir/identity-patterns.sh"\n')).toEqual({ parsed: ["identity-patterns.sh"], total: 1 });
    expect(hookDirRefs('c="$hook_dir/../tools/x/.vale.ini"\n').parsed).toEqual(["../tools/x/.vale.ini"]);
  });

  test("cannot read brace form or a bare use, so the counts disagree", () => {
    for (const text of ['. "${hook_dir}/x.sh"\n', 'cd "$hook_dir"\n', '. "$hook_dir/lib/x.sh$suffix"\n']) {
      const { parsed, total } = hookDirRefs(text);
      expect(parsed.length).toBeLessThan(total);
    }
  });
});

describe("sourceTargets parser", () => {
  test("resolves a variable assigned from hook_dir and a direct hook_dir path", () => {
    const text =
      'hook_dir=x\nlib="$hook_dir/a.sh"\n. "$lib"\nif true; then source "$hook_dir/b.sh"; fi\n# . "$hook_dir/c.sh"\necho "see source (x)"\n';
    expect(sourceTargets(text)).toEqual({ resolved: ["a.sh", "b.sh"], unresolved: [] });
  });

  test("reports any other path form as unresolved", () => {
    for (const text of [
      '. "$(dirname -- "$0")/missing.sh"\n',
      '. "${0%/*}/missing.sh"\n',
      ". ./missing.sh\n",
      'x && . "$unassigned"\n',
      'lib="$(dirname "$0")/m.sh"\n. "$lib"\n',
    ]) {
      expect(sourceTargets(text).unresolved.length).toBe(1);
    }
  });
});

describe("git hooks shipped by core", () => {
  for (const name of GIT_HOOKS) {
    test(`${name} is tracked executable (100755)`, () => {
      expect(indexMode(`${HOOKS_DIR}/${name}`)).toBe("100755");
    });

    test(`${name} sibling files it sources exist`, () => {
      const text = readFileSync(join(ROOT, HOOKS_DIR, name), "utf8");
      const { parsed, total } = hookDirRefs(text);
      const want = EXPECTED[name];

      // Every hook_dir use must parse in full, or the checks below would skip it silently.
      expect(parsed.length).toBe(total);
      // The reference set is exactly the expected one, so a rewritten or dropped source is reported.
      expect([...new Set(parsed)].sort()).toEqual([...want.required, ...want.optional].sort());
      for (const ref of want.required) {
        expect(existsSync(join(ROOT, HOOKS_DIR, ref))).toBe(true);
      }

      // Every `.` or `source` statement, whatever form its path takes, must resolve to a file
      // that exists, and the set must be exactly the sibling files the hook is expected to source.
      const src = sourceTargets(text);
      expect(src.unresolved).toEqual([]);
      expect([...new Set(src.resolved)].sort()).toEqual([...want.required].sort());
      for (const ref of src.resolved) {
        expect(existsSync(join(ROOT, HOOKS_DIR, ref))).toBe(true);
      }
    });
  }
});
