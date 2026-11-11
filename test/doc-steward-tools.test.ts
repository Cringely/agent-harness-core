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
    const i4 = text.search(/^4\. \*\*/m);
    const i5 = text.search(/^5\. \*\*/m);
    const i7 = text.search(/^7\. \*\*/m);
    const iSize = text.search(/^## Size discipline/m);
    expect(i4).toBeGreaterThan(-1);
    expect(i5).toBeGreaterThan(i4);
    expect(i7).toBeGreaterThan(i5);
    expect(iSize).toBeGreaterThan(i7);
    for (const slice of [text.slice(i4, i5), text.slice(i7, iSize)]) {
      expect(slice).toMatch(/dispatcher/i);
      expect(slice).toMatch(/skipped/i);
      // Output handed in at dispatch predates the agent's edits, so the item must say it is
      // not evidence and must not tell the agent to carry it into the report.
      expect(slice).toMatch(/predates? your edits|before your edits/i);
      expect(slice).not.toMatch(/carry[^.]*verbatim/i);
      expect(slice).not.toMatch(/run it after/i);
    }
  });
});
