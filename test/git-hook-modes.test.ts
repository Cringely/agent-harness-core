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

// Fail-closed pin on what each hook sources. No shell parsing: every line containing the word
// "source" or a dot-command (a "." followed by whitespace, as a command word anywhere on the
// line) is collected by a deliberately over-inclusive text match, and the trimmed set must equal
// the expected list below exactly. A comment or echo that mentions "source" is a harmless false
// alarm that costs one entry here. A sourcing form the match misses cannot exist, since any
// such line still contains "source" or a dot-command word.
// "file" is the sibling next to the hooks that the line loads, checked for existence and for a
// "$hook_dir/<file>" reference in the hook. Lines that only mention the word have no file.
type Expected = { line: string; file?: string };
const EXPECTED: Record<string, Expected[]> = {
  "pre-commit": [
    { line: '. "$identity_lib"', file: "identity-patterns.sh" },
    { line: 'echo "  and only a human can waive that. Fix it at the source, then re-stage." >&2' },
    { line: 'echo "  printed. Fix it at the source, then re-stage." >&2' },
  ],
  "pre-push": [
    { line: '. "$identity_lib"', file: "identity-patterns.sh" },
    { line: 'echo "  printed. Fix it at the source (git-filter-repo, or an interactive rebase" >&2' },
  ],
  "commit-msg": [],
};

// Over-inclusive on purpose: the word "source", or a "." command word, anywhere on a line.
function sourceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => /\bsource\b/.test(l) || /(^|[\s;&|({!])\.\s/.test(l))
    .map((l) => l.trim());
}

function indexMode(path: string): string | undefined {
  const out = Bun.spawnSync(["git", "ls-files", "-s", "--", path], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(out.stdout).trim().split(/\s+/)[0] || undefined;
}

describe("git hooks shipped by core", () => {
  for (const name of GIT_HOOKS) {
    test(`${name} is tracked executable (100755)`, () => {
      expect(indexMode(`${HOOKS_DIR}/${name}`)).toBe("100755");
    });

    test(`${name} sourced-file lines match the expected list exactly`, () => {
      const text = readFileSync(join(ROOT, HOOKS_DIR, name), "utf8");
      const want = EXPECTED[name];
      const got = sourceLines(text);
      // The hint rides inside the compared value so it prints with the diff on failure.
      const hint = `${name}: lines mentioning source or a dot-command changed. Check that the file the new line loads exists next to the hooks, then update EXPECTED in this test.`;
      expect({ hint, lines: got }).toEqual({ hint, lines: want.map((e) => e.line) });
      for (const e of want) {
        if (!e.file) continue;
        expect(text).toContain(`$hook_dir/${e.file}`);
        expect(existsSync(join(ROOT, HOOKS_DIR, e.file))).toBe(true);
      }
    });
  }
});
