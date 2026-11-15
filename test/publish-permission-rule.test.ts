// Pins #274's distribution: the project-scoped permission fragment install/Install-Harness.ps1
// merges into a project's .claude/settings.json must deny raw gh publishing in both shell tools,
// and the skill it installs must point every publish at tools/publish. Deleting one rule, or
// shipping the skill with a machine path in it, fails here. The merge itself is pinned in
// install/Install-Harness.Tests.ps1. What the rules do inside Claude Code is a live property this
// file cannot see. Task 12 of docs/superpowers/plans/2026-10-06-publish-tool.md probes it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// The mid-pattern rules catch a flag placed between the group and the subcommand, as in
// gh pr --repo x merge 5. Per the permission docs a trailing " *" matches the bare command only when
// it is the rule's one wildcard, so a form with nothing after the subcommand is not matched. The
// list is a tripwire, not a boundary. gh api writes, the edit and comment subcommands and shell
// wrappers still pass it.
const RULES = [
  "Bash(gh pr create *)",
  "Bash(gh issue create *)",
  "Bash(gh pr merge *)",
  "Bash(gh pr * create *)",
  "Bash(gh issue * create *)",
  "Bash(gh pr * merge *)",
  "Bash(gh alias set *)",
  "PowerShell(gh pr create *)",
  "PowerShell(gh issue create *)",
  "PowerShell(gh pr merge *)",
  "PowerShell(gh pr * create *)",
  "PowerShell(gh issue * create *)",
  "PowerShell(gh pr * merge *)",
  "PowerShell(gh alias set *)",
];

describe("publish distribution through the project installer", () => {
  test("the deny fragment holds exactly the raw gh pr create, gh issue create, gh pr merge and gh alias set rules, flag-first forms included, in both shells", () => {
    const fragment = JSON.parse(readFileSync(join(ROOT, "core", "claude", "templates", "settings.permissions.json"), "utf8")) as {
      permissions?: { deny?: unknown };
    };
    const deny = fragment.permissions?.deny;
    expect(Array.isArray(deny)).toBe(true);
    expect([...(deny as string[])].sort()).toEqual([...RULES].sort());
  });

  test("the publish skill names itself, points at the tool, and carries no machine path", () => {
    const skill = readFileSync(join(ROOT, "core", "claude", "skills", "publish", "SKILL.md"), "utf8");
    expect(skill).toStartWith("---");
    expect(skill).toContain("name: publish");
    expect(skill).toContain("tools/publish/cli.ts");
    expect(skill).toContain("coreRepo");
    expect(skill).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
