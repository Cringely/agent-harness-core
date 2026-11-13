// Pins the layer registry and the moved-rule pointers (#310).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const coreRules = join(root, "core", "claude", "rules");

describe("layers.json", () => {
  const manifest = JSON.parse(readFileSync(join(coreRules, "layers.json"), "utf8"));
  const listed = Object.keys(manifest.rules);

  test("every rule listed in layers.json exists in core/claude/rules", () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const f of listed) expect(existsSync(join(coreRules, f))).toBe(true);
  });

  test("every .md file in core/claude/rules is listed in layers.json", () => {
    const files = readdirSync(coreRules).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(listed).toContain(f);
  });

  test("layer names are only code, documents and physical, and every list is non-empty", () => {
    expect(manifest.schemaVersion).toBe(1);
    for (const f of listed) {
      const layers: string[] = manifest.rules[f];
      expect(layers.length).toBeGreaterThan(0);
      for (const l of layers) expect(["code", "documents", "physical"]).toContain(l);
    }
  });

  // Install-Harness.ps1 validates recorded settings against these keys, and its -StatusCadence and
  // -Audience ValidateSets are pinned to them by the Pester suite.
  test("settings define exactly the values the installer accepts", () => {
    const settings = manifest.settings;
    expect(Object.keys(settings).sort()).toEqual(["audience", "lengthBudgetDefault", "statusCadence"]);
    expect(Object.keys(settings.statusCadence).sort()).toEqual(["heartbeat", "silent"]);
    expect(Object.keys(settings.audience).sort()).toEqual(["peer-engineer", "plain-all-roles"]);
    expect(Object.keys(settings.lengthBudgetDefault).sort()).toEqual(["none", "words"]);
    for (const group of Object.values(settings) as Record<string, unknown>[]) {
      for (const text of Object.values(group)) {
        expect(typeof text).toBe("string");
        expect((text as string).length).toBeGreaterThan(0);
      }
    }
    expect(settings.lengthBudgetDefault.words).toContain("{{WORDS}}");
  });
});

// A pointer to the account copy of a rule that moved into the code layer. After the cutover
// ~/.claude/rules/fix-quality.md does not exist on any machine, so a file naming it points nowhere.
export const DANGLING_RULE_POINTER = /(?:~\/\.claude|\{\{CLAUDE_HOME\}\})\/rules\/fix-quality\.md/;

function textFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const p = join(entry.parentPath, entry.name);
    const buf = readFileSync(p);
    if (buf.includes(0)) continue; // binary
    out.push(p);
  }
  return out;
}

describe("moved rules", () => {
  test("the pointer matcher matches the account path it guards", () => {
    const literal = ["`", "~", "/.claude/rules/", "fix-quality", ".md`"].join("");
    expect(DANGLING_RULE_POINTER.test(literal)).toBe(true);
    expect(DANGLING_RULE_POINTER.test(literal.replace("~/.claude", "{{CLAUDE_HOME}}"))).toBe(true);
    expect(DANGLING_RULE_POINTER.test(".claude/rules/harness/fix-quality.md")).toBe(false);
  });

  test("no account or core file points at a moved rule by its account path", () => {
    const files = [join(root, "account", "claude"), join(root, "core", "claude")].flatMap(textFilesUnder);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => DANGLING_RULE_POINTER.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
