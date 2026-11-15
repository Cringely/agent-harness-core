// Tests for tools/publish/template.ts (#274): a body must fill every section of the repository's
// PR or issue template.

import { describe, expect, test } from "bun:test";
import { PublishRefusal } from "../tools/publish/errors";
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

  // A section is filled only by a letter or number left once markup is removed. Characters are
  // built from code points so the fixtures hold exactly the bytes named.
  const ch = (...codes: number[]) => String.fromCharCode(...codes);
  const EMPTY_CONTENT: [string, string][] = [
    ["a zero-width space", ch(0x200b)],
    ["a word joiner", ch(0x2060)],
    ["a Hangul filler", ch(0x3164)],
    ["a braille blank", ch(0x2800)],
    ["a no-break space entity", "&nbsp;"],
    ["a zero-width space entity", "&#8203;"],
    ["a hex zero-width space entity", "&#x200B;"],
    ["a link reference definition", "[ref]: https://example.invalid/page"],
    ["a lone blockquote marker", ">"],
    ["a lone list marker", "-"],
    ["a thematic break", "\n---"],
    ["a bare heading marker", "###"],
    ["a heading whose text is only a comment", "### <!-- note -->"],
    ["a br tag", "<br>"],
    ["an empty link", "[](https://example.invalid/x)"],
    ["an empty details element", "<details></details>"],
    ["a style element", "<style>p { color: red }</style>"],
    ["a processing instruction", "<?xml version ?>"],
    ["a CDATA section", "<![CDATA[ hidden ]]>"],
    ["a declaration", "<!DOCTYPE html>"],
    ["a closed fence holding only a zero-width space", "```\n" + ch(0x200b) + "\n```"],
  ];
  test.each(EMPTY_CONTENT)("a section holding only %s is unfilled", (_name, content) => {
    expect(unfilledSections(AB, "## A\n" + content + "\n\n## B\nok\n")).toEqual([1]);
  });

  const REAL_CONTENT: [string, string][] = [
    ["a word", "ok"],
    ["a number", "42"],
    ["a non-Latin word", ch(0x6e2c, 0x8a66)],
    ["a closed fence with a letter", "```\nx\n```"],
    ["an autolink", "<https://example.invalid/x>"],
    ["a link with text", "[docs](https://example.invalid/x)"],
    ["text inside a details element", "<details><summary>Log</summary></details>"],
  ];
  test.each(REAL_CONTENT)("a section holding %s is filled", (_name, content) => {
    expect(unfilledSections(AB, "## A\n" + content + "\n\n## B\nok\n")).toEqual([]);
  });

  test.each(["pre", "textarea"])("a heading inside an HTML %s block is not a heading", (tag) => {
    const body = "## A\nsee below\n<" + tag + ">\n## B\nfiller\n</" + tag + ">\n\n## B\n";
    expect(unfilledSections(AB, body)).toEqual([2]);
  });

  test("a pre block runs past a blank line to its close tag", () => {
    expect(unfilledSections(AB, "## A\nsee below\n<pre>\n\n## B\nfiller\n</pre>\n\n## B\n")).toEqual([2]);
  });

  test("an HTML block of any tag runs to a blank line, and a heading after that counts", () => {
    expect(unfilledSections(AB, "## A\n<div>\n## B\nfiller\n\n## B\n")).toEqual([2]);
    expect(unfilledSections(AB, "## A\n<div>x</div>\n\n## B\nok\n")).toEqual([]);
  });
});

describe("template heading subset", () => {
  // GitHub renders each of these as a heading. The gate reads only a column-0 "#" heading as a
  // section, so a template holding any of them refuses rather than dropping that section.
  const refused: Array<[string, string]> = [
    ["an ATX heading indented one space", "## Source\n\n #  Testing\n"],
    ["an ATX heading indented three spaces", "## Source\n\n   ## Testing\n"],
    ["a setext heading underlined with =", "## Source\n\nTesting\n=======\n"],
    ["a setext heading underlined with -", "## Source\n\nTesting\n-------\n"],
    ["an indented setext underline with trailing spaces", "Testing\n   ---  \n"],
    ["a setext underline under a two-line paragraph", "Testing\nmore\n-\n"],
    ["a template written only in setext headings", "Source\n======\n\nTesting\n------\n"],
  ];
  for (const [name, template] of refused) {
    test(`refuses ${name}`, () => {
      expect(() => templateSections(template)).toThrow(PublishRefusal);
      expect(() => unfilledSections(template, "## Source\n\nx\n\n## Testing\n\ny\n")).toThrow(PublishRefusal);
    });
  }

  const accepted: Array<[string, string, number]> = [
    ["a thematic break after a blank line", "## Source\n\ntext\n\n---\n\n## Testing\n", 2],
    ["a thematic break directly under a heading", "## Source\n---\n## Testing\n", 2],
    ["heading forms inside a fence", "## Source\n\n```\n   ## Testing\nTesting\n---\n```\n", 1],
    ["heading forms inside a closed comment", "## Source\n<!--\n   ## Testing\nTesting\n---\n-->\n", 1],
    ["an ATX heading indented four spaces, which is code", "## Source\n\n    ## Testing\n", 1],
  ];
  for (const [name, template, count] of accepted) {
    test(`accepts ${name}`, () => {
      expect(templateSections(template)).toHaveLength(count);
    });
  }

  test("accepts every template this repository ships", () => {
    const dir = new URL("../.github/ISSUE_TEMPLATE/", import.meta.url);
    const fs = require("node:fs") as typeof import("node:fs");
    const files = fs.readdirSync(dir).filter((f: string) => f.toLowerCase().endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(templateSections(fs.readFileSync(new URL(file, dir), "utf8")).length).toBeGreaterThan(0);
    }
  });
});

describe("body headings outside the subset", () => {
  const TWO = "## Source\n\n## Testing\n";

  test("an indented ATX heading in the body is not the section it names", () => {
    expect(unfilledSections(TWO, "## Source\n\npath\n\n   ## Testing\n\nran it\n")).toEqual([2]);
  });

  test("a setext heading in the body is not the section it names", () => {
    expect(unfilledSections(TWO, "## Source\n\npath\n\nTesting\n-------\n\nran it\n")).toEqual([2]);
    expect(unfilledSections(TWO, "## Source\n\npath\n\nTesting\n=======\n\nran it\n")).toEqual([2]);
  });

  test("an indented ATX heading does not fill the section above it", () => {
    expect(unfilledSections(TWO, "## Source\n\n   ### Notes\n\n## Testing\n\nran it\n")).toEqual([1]);
  });

  test("a setext heading's text does not fill the section above it", () => {
    expect(unfilledSections(TWO, "## Source\nNotes\nand more\n---\n\n## Testing\n\nran it\n")).toEqual([1]);
  });

  test("a thematic break after a blank line leaves the paragraph above it as content", () => {
    expect(unfilledSections(TWO, "## Source\n\npath\n\n---\n\n## Testing\n\nran it\n")).toEqual([]);
  });
});
