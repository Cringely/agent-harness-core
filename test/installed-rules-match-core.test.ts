// Drift guard for the committed .claude/rules/harness/ copies (#310). This repo commits the rules
// the installer wrote, so isolated worktree agents load them. A copy that no longer matches what
// the installer would write today loads stale rules without any error, so this test fails instead.
//
// The expected file set is derived from core/claude/rules/layers.json the way Install-Harness.ps1
// decides it (Get-ComponentGate): a rule file is installed when at least one of its layers is a
// layer this repo records. Every expected file must be present, no other file may sit beside them
// except project-settings.md, and each rule file is a plain copy (Copy-Item), so it must match
// core/claude/rules/ byte for byte once line endings are normalised. project-settings.md is rendered by Get-ProjectSettingsText from the template and
// layers.json with this repo's settings (layer code, the default settings), and opens with a
// marker line holding the SHA256 of the body below it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const norm = (s: string): string => s.replace(/\r\n/g, "\n");
const read = (...p: string[]): string => norm(readFileSync(join(root, ...p), "utf8"));

// The layers this repo records. The manifest that holds them is gitignored, so they are pinned here.
const REPO_LAYERS = ["code"];
const SETTINGS_FILE = "project-settings.md";

const registry = JSON.parse(read("core", "claude", "rules", "layers.json")) as {
  rules: Record<string, string[]>;
  settings: Record<string, Record<string, string>>;
};
const expectedFiles = Object.keys(registry.rules)
  .filter((file) => registry.rules[file].some((layer) => REPO_LAYERS.includes(layer)))
  .sort();
const installedFiles = readdirSync(join(root, ".claude", "rules", "harness")).sort();

describe("committed .claude/rules/harness copies", () => {
  test("the expected set is not empty", () => {
    expect(expectedFiles.length).toBeGreaterThan(0);
  });

  test("every rule file layers.json selects for this repo is committed", () => {
    const missing = expectedFiles.filter((f) => !installedFiles.includes(f));
    expect(missing).toEqual([]);
  });

  test("no committed file is outside the expected set", () => {
    const extra = installedFiles.filter((f) => f !== SETTINGS_FILE && !expectedFiles.includes(f));
    expect(extra).toEqual([]);
  });

  for (const file of expectedFiles) {
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
      const settings = { statusCadence: "silent", audience: "peer-engineer" } as const;
      const rendered = read("core", "claude", "templates", "project-settings.template.md")
        .replace("{{STATUS_CADENCE_TEXT}}", () => registry.settings.statusCadence[settings.statusCadence])
        .replace("{{AUDIENCE_TEXT}}", () => registry.settings.audience[settings.audience])
        .replace("{{LENGTH_BUDGET_TEXT}}", () => registry.settings.lengthBudgetDefault.none)
        .replace("{{STATUS_CADENCE}}", settings.statusCadence)
        .replace("{{AUDIENCE}}", settings.audience)
        .replace("{{LAYERS}}", REPO_LAYERS.join(", "));
      expect(body).toBe(rendered);
    });
  });
});
