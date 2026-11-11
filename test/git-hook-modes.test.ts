// Pins two silent-inertness modes for the three hooks git itself invokes (#136, the
// index-mode pin ported from spacemolt-harness#99): a hook staged 100644 is skipped by git
// with no error, and a hook whose sourced sibling has gone missing either refuses or no-ops.
//
// Mode is read from the git INDEX, never the working tree. A Windows checkout reports 755 on a
// file committed 644, so a filesystem stat would pass here and fail on the Linux clone.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOOKS_DIR = "core/claude/hooks";
// Same set as $gitHookNames in install/Install-Harness.ps1.
const GIT_HOOKS = ["pre-commit", "pre-push", "commit-msg"];

function indexMode(path: string): string | undefined {
  const out = Bun.spawnSync(["git", "ls-files", "-s", "--", path], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(out.stdout).trim().split(/\s+/)[0] || undefined;
}

describe("git hooks shipped by core", () => {
  for (const name of GIT_HOOKS) {
    test(`${name} is tracked executable (100755)`, () => {
      expect(indexMode(`${HOOKS_DIR}/${name}`)).toBe("100755");
    });

    test(`${name} sibling files it sources exist`, () => {
      const text = readFileSync(join(ROOT, HOOKS_DIR, name), "utf8");
      const refs = [...text.matchAll(/\$hook_dir\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
      for (const ref of refs) {
        expect(existsSync(join(ROOT, HOOKS_DIR, ref))).toBe(true);
      }
    });
  }

  test("pre-commit does reference identity-patterns.sh (the sibling check is not vacuous)", () => {
    const text = readFileSync(join(ROOT, HOOKS_DIR, "pre-commit"), "utf8");
    expect(text).toContain("$hook_dir/identity-patterns.sh");
  });
});
