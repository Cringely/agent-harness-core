// Tests for tools/pr-review/docs-verdict.ts. findDocsVerdictLine reads the pull request body, a
// plain string an attacker controls, and must accept only a real verdict: one of the two forms
// CONTRIBUTING.md defines, with a tail that says something.

import { describe, expect, test } from "bun:test";
import { DOCS_VERDICT_FORMS, findDocsVerdictLine } from "../tools/pr-review/docs-verdict";

describe("findDocsVerdictLine(): the two forms with a real tail", () => {
  test("README still accurate, with a tail", () => {
    expect(findDocsVerdictLine("Docs: README still accurate: touches only test fixtures.")).toBe(
      "Docs: README still accurate: touches only test fixtures.",
    );
  });

  test("README updated, with a tail", () => {
    expect(findDocsVerdictLine("Docs: README updated: the CI section now names both jobs.")).toBe(
      "Docs: README updated: the CI section now names both jobs.",
    );
  });

  test("both expected forms are documented in DOCS_VERDICT_FORMS", () => {
    expect(DOCS_VERDICT_FORMS).toEqual([
      "Docs: README still accurate: <what was checked>",
      "Docs: README updated: <what changed>",
    ]);
  });
});

// Built from character codes rather than typed as literal escapes: U+200B (zero-width space),
// the character render.ts's UNSAFE_CHARS also strips before a string is quoted into the posted
// review.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

describe("findDocsVerdictLine(): rejects a tail that says nothing", () => {
  test.each([
    ["an empty tail", "Docs: README still accurate: "],
    ["a whitespace-only tail", "Docs: README updated:    "],
    ["the still-accurate placeholder, unfilled", "Docs: README still accurate: <what was checked>"],
    ["the updated placeholder, unfilled", "Docs: README updated: <what changed>"],
    ["a tail made only of zero-width characters", `Docs: README updated: ${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}`],
    [
      "the placeholder with a zero-width character inserted, dodging the literal Set lookup",
      `Docs: README updated: <what${ZERO_WIDTH_SPACE} changed>`,
    ],
  ])("%s", (_label, body) => {
    expect(findDocsVerdictLine(body)).toBeNull();
  });
});

describe("findDocsVerdictLine(): absence and placement", () => {
  test("no Docs line anywhere", () => {
    expect(findDocsVerdictLine("Just a description of the change, with no verdict line at all.")).toBeNull();
  });

  test("an empty body", () => {
    expect(findDocsVerdictLine("")).toBeNull();
  });

  test("a line that starts the same way but names neither form", () => {
    expect(findDocsVerdictLine("Docs: README looks fine to me.")).toBeNull();
  });

  test("a verdict line buried in the middle of a long body is still found", () => {
    const body = [
      "## Summary",
      "",
      "This changes the installer's sidecar logic.",
      "",
      "## Details",
      "",
      "A paragraph of unrelated text goes here, describing the change at some length so the",
      "verdict line sits well past the start of the body rather than on the first line.",
      "",
      "Docs: README still accurate: touches only the installer, which README.md does not describe.",
      "",
      "## Testing",
      "",
      "bun test: 40 pass, 0 fail.",
    ].join("\n");
    expect(findDocsVerdictLine(body)).toBe("Docs: README still accurate: touches only the installer, which README.md does not describe.");
  });

  test("a CRLF body is read the same as an LF one", () => {
    const body = "Intro line.\r\n\r\nDocs: README updated: renamed the CLI flag.\r\n\r\nMore text.";
    expect(findDocsVerdictLine(body)).toBe("Docs: README updated: renamed the CLI flag.");
  });

  test("the first qualifying line wins when more than one is present", () => {
    const body = "Docs: README updated: first change.\n\nDocs: README updated: second change.";
    expect(findDocsVerdictLine(body)).toBe("Docs: README updated: first change.");
  });
});
