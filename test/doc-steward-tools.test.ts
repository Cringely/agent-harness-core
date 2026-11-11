// doc-steward is a reconciliation role that edits living docs. It holds no shell, so a
// project script's output can only reach it from the dispatcher (issue #86).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const text = readFileSync(
  join(import.meta.dir, "..", "core", "claude", "agents", "doc-steward.md"),
  "utf8",
);
const frontmatter = text.split(/\r?\n---\r?\n/)[0] ?? "";
const toolsLine = frontmatter.split(/\r?\n/).find((l) => l.startsWith("tools:")) ?? "";

describe("doc-steward tool grant", () => {
  test("tools line exists and omits Bash", () => {
    expect(toolsLine).not.toBe("");
    const tools = toolsLine.slice("tools:".length).split(",").map((t) => t.trim());
    expect(tools).toContain("Edit");
    expect(tools).not.toContain("Bash");
  });

  test("script-running checklist items are dispatcher-run or recorded skipped", () => {
    expect(text).toMatch(/dispatcher/i);
    expect(text).toMatch(/skipped/i);
  });
});
