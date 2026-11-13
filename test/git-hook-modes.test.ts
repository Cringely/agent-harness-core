// Pins one silent-inertness mode for the three hooks git itself invokes (#136, the index-mode
// pin ported from spacemolt-harness#99): a hook staged 100644 is skipped by git with no error.
//
// Mode is read from the git INDEX, never the working tree. A Windows working tree does not
// carry the exec bit reliably, so a filesystem stat says nothing about the committed mode.

import { describe, expect, test } from "bun:test";
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
  }
});
