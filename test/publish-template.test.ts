// Tests for tools/publish/template.ts (#274): a body must fill every section of the repository's
// PR or issue template.

import { describe, expect, test } from "bun:test";
import { templateSections, unfilledSections } from "../tools/publish/template";

const TEMPLATE = [
  "---",
  "name: Fixture",
  "title: \"## Not a heading\"",
  "---",
  "",
  "<!-- Write something under every heading. -->",
  "",
  "## Source",
  "",
  "<!-- Give the path. -->",
  "",
  "## Why it transfers",
  "",
  "```",
  "## not a section, inside a fence",
  "```",
  "",
  "### Detail",
  "",
].join("\n");

describe("templateSections()", () => {
  test("lists headings outside front matter, comments and fences", () => {
    expect(templateSections(TEMPLATE)).toEqual([
      { level: 2, key: "source" },
      { level: 2, key: "why it transfers" },
      { level: 3, key: "detail" },
    ]);
  });

  test("a template with no headings has no sections", () => {
    expect(templateSections("<!-- describe the change -->\n- [ ] tested\n")).toEqual([]);
  });
});

describe("unfilledSections()", () => {
  test("accepts a body that fills every section, at any heading level and case", () => {
    const body = "# SOURCE\n\npath/to/file\n\n## Why it transfers\n\nIt checks a contract.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([]);
  });

  test("reports a missing section by index", () => {
    const body = "## Source\n\npath\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([2]);
  });

  test("reports a section left holding only the template's comment", () => {
    const body = "## Source\n\n<!-- Give the path. -->\n\n## Why it transfers\n\nYes.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([1]);
  });

  test("counts a subsection's content toward its parent", () => {
    const body = "## Source\n\np\n\n## Why it transfers\n\n### Detail\n\nOnly here.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([]);
  });

  test("stops a section at the next heading of the same level", () => {
    const body = "## Source\n\n## Why it transfers\n\nYes.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([1]);
  });

  // Review Focus 1 and 2: bodies written on Windows.
  test("reads a body saved with a byte-order mark and CRLF line endings", () => {
    const body = "\uFEFF## Source\r\n\r\npath\r\n\r\n## Why it transfers\r\n\r\nYes.\r\n\r\n### Detail\r\n\r\nMore.\r\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([]);
  });

  test("a heading inside the body's own fence does not fill a section", () => {
    const body = "```\n## Source\nfilled?\n```\n\n## Why it transfers\n\nYes.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([1]);
  });
});
