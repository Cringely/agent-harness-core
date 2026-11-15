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

  test("ends a section at the next template heading even when the body heading is shallower", () => {
    expect(unfilledSections("## A\n\n## B\n", "# A\n\n## B\n\ntext\n")).toEqual([1]);
    expect(unfilledSections("## Summary\n\n## Testing\n", "# Summary\n\n## Testing\n\nRan it.\n")).toEqual([1]);
  });

  test("one body section does not fill two template sections with the same heading", () => {
    expect(unfilledSections("## A\n\n## A\n", "## A\n\ntext\n")).toEqual([2]);
    expect(unfilledSections("## A\n\n## A\n", "## A\n\none\n\n## A\n\ntwo\n")).toEqual([]);
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

  // GitHub renders a section as empty when all it holds is hidden by a comment or sits in code
  // that never closes, so the gate must read those sections as empty too.
  const AB = "## A\n\n## B\n";

  test("a comment never closed hides the rest of the body, headings included", () => {
    expect(unfilledSections("## Summary\n\n## Testing\n", "## Summary\n<!-- note\n## Testing\nRan it.\n")).toEqual([1, 2]);
    expect(unfilledSections(AB, "## A\n\ntext <!-- unclosed\n\n## B\n\nmore\n")).toEqual([2]);
    expect(unfilledSections(AB, "## A\n\n   <!-- indented and unclosed\n## B\nmore\n")).toEqual([1, 2]);
  });

  test("a multi-line comment hides its lines and any heading inside it", () => {
    expect(unfilledSections(AB, "## A\n<!--\nhidden\n## B\nhidden\n-->\n")).toEqual([1, 2]);
    expect(unfilledSections(AB, "## A\n<!--\nhidden\n-->\n## B\nshown\n")).toEqual([1]);
  });

  test("several comments on one line leave nothing visible", () => {
    expect(unfilledSections(AB, "## A\n<!-- one --> <!-- two -->\t<!-- three -->\n## B\nx\n")).toEqual([1]);
    expect(unfilledSections(AB, "## A\n<!-- one --> shown <!-- two -->\n## B\nx\n")).toEqual([]);
  });

  test("removing one comment does not expose another one formed around it", () => {
    expect(unfilledSections(AB, "## A\n<!<!---->-- still hidden -->\n## B\nx\n")).toEqual([1]);
  });

  test("blank and whitespace-only lines do not fill a section", () => {
    expect(unfilledSections(AB, "## A\n\n   \n\t\n \t \n## B\nx\n")).toEqual([1]);
  });

  test("a shorter fence does not close a longer one", () => {
    const body = "## A\n\n````\n```\n## B\nfake\n```\n````\n\n## B\n\n";
    expect(unfilledSections(AB, body)).toEqual([2]);
  });

  test("a fence line with an info string does not close a fence", () => {
    const body = "## A\n\n```\n```js\n## B\nfake\n```\n\n## B\n\n";
    expect(unfilledSections(AB, body)).toEqual([2]);
  });

  test("a fence of the other character does not close a fence", () => {
    const body = "## A\n\n~~~\n```\n## B\nfake\n~~~\n\n## B\n\n";
    expect(unfilledSections(AB, body)).toEqual([2]);
  });

  test("a closed fence with real lines is content, an empty one is not", () => {
    expect(unfilledSections(AB, "## A\n```js\nconst x = 1;\n```\n## B\nx\n")).toEqual([]);
    expect(unfilledSections(AB, "## A\n```\n\n   \n```\n## B\nx\n")).toEqual([1]);
  });

  test("a fence never closed is not content, and its headings are not headings", () => {
    expect(unfilledSections(AB, "## A\nx\n## B\n```\ncode never closed\n")).toEqual([2]);
    expect(unfilledSections(AB, "## A\n```\n## B\nlooks filled\n")).toEqual([1, 2]);
  });

  test("a fence opens even when its info string holds a comment marker", () => {
    expect(unfilledSections(AB, "## A\nx\n```js <!-- note -->\n## B\nfake\n")).toEqual([2]);
  });

  test("a template comment left open still leaves later template headings required", () => {
    expect(templateSections("## A\n<!-- open\n## B\n")).toEqual([
      { level: 2, key: "a" },
      { level: 2, key: "b" },
    ]);
    expect(templateSections("## A\n<!--\n## Example\n-->\n## B\n")).toEqual([
      { level: 2, key: "a" },
      { level: 2, key: "b" },
    ]);
  });

  test("comment markers inside a closed fence are code, not comments", () => {
    expect(unfilledSections(AB, "## A\n```\n<!-- shown as code\n```\n## B\nx\n")).toEqual([]);
  });

  test("a heading line after a comment closes on it is not a heading", () => {
    expect(unfilledSections(AB, "## A\n<!--\n-->## B\nx\n")).toEqual([2]);
    expect(unfilledSections(AB, "## A\nx\n<!-- c --> ## B\n")).toEqual([2]);
  });
});
