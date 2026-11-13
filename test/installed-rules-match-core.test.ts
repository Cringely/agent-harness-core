// Drift guard for the committed .claude/rules/harness/ copies (#310). This repo commits the rules
// the installer wrote, so isolated worktree agents load them. A copy that no longer matches what
// the installer would write today loads stale rules without any error, so this test fails instead.
//
// fix-quality.md and change-management-code.md are plain copies (Install-Harness.ps1 uses
// Copy-Item), so they must match core/claude/rules/ byte for byte once line endings are
// normalised. project-settings.md is rendered by Get-ProjectSettingsText from the template and
// layers.json with this repo's settings (layer code, the default settings), and opens with a
// marker line holding the SHA256 of the body below it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const norm = (s: string): string => s.replace(/\r\n/g, "\n");
const read = (...p: string[]): string => norm(readFileSync(join(root, ...p), "utf8"));

describe("committed .claude/rules/harness copies", () => {
  for (const file of ["fix-quality.md", "change-management-code.md"]) {
    test(`${file} matches its source in core/claude/rules`, () => {
      expect(read(".claude", "rules", "harness", file)).toBe(read("core", "claude", "rules", file));
    });
  }

  describe("project-settings.md", () => {
    const installed = read(".claude", "rules", "harness", "project-settings.md");
    const firstBreak = installed.indexOf("\n");
    const marker = installed.slice(0, firstBreak);
    const body = installed.slice(firstBreak + 1);

    test("marker hash matches its body", () => {
      const m = /^<!-- harness-generated sha256:([0-9a-f]{64}) -->$/.exec(marker);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
    });

    test("body matches the template rendered with this repo's layers and default settings", () => {
      const registry = JSON.parse(read("core", "claude", "rules", "layers.json"));
      const settings = { statusCadence: "silent", audience: "peer-engineer" } as const;
      const rendered = read("core", "claude", "templates", "project-settings.template.md")
        .replace("{{STATUS_CADENCE_TEXT}}", () => registry.settings.statusCadence[settings.statusCadence])
        .replace("{{AUDIENCE_TEXT}}", () => registry.settings.audience[settings.audience])
        .replace("{{LENGTH_BUDGET_TEXT}}", () => registry.settings.lengthBudgetDefault.none)
        .replace("{{STATUS_CADENCE}}", settings.statusCadence)
        .replace("{{AUDIENCE}}", settings.audience)
        .replace("{{LAYERS}}", "code");
      expect(body).toBe(rendered);
    });
  });
});
