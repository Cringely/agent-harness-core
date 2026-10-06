// Tests for tools/publish/scan.ts (#274). Every identity is synthetic. The session-link fixture is
// assembled from parts so no committed file carries a whole link.

import { describe, expect, test } from "bun:test";
import type { IdentityDecl } from "../tools/pr-review/identity";
import { UsageError } from "../tools/publish/errors";
import { compareClosing, findClosingRefs, parseClosesList, scanText } from "../tools/publish/scan";

const DECL: IdentityDecl = { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "fixtureuser", hostname: "fixture-host" };
const REPO = "fixture-owner/fixture-repo";
const SESSION_LINK = "https://" + ["claude", "ai"].join(".") + "/code/session_" + "0123456789abcdef";

const scanBody = (text: string) => scanText([{ label: "body", text }], DECL);

describe("scanText()", () => {
  test("passes clean text", () => {
    expect(scanBody("## Why\n\nThe retry loop never waited.\n")).toEqual([]);
  });

  test("reports a declared name by class and never by value", () => {
    const hits = scanBody("Reported by Fixture Person.");
    expect(hits).toEqual(["body: declared name #1"]);
    expect(hits.join(" ")).not.toContain("Fixture Person");
  });

  test("reports the workstation username", () => {
    expect(scanBody("path C:/Users/fixtureuser/x")).toContain("body: workstation username");
  });

  test("reports a Claude Code session link", () => {
    expect(SESSION_LINK.includes("/code/session_0123")).toBe(true);
    expect(scanBody(`See ${SESSION_LINK}`)).toEqual(["body: session link"]);
  });

  test("reports a session link split by a zero-width character", () => {
    const hidden = SESSION_LINK.replace("/code/", "/co\u200Bde/");
    expect(scanBody(hidden)).toEqual(["body: session link"]);
  });

  test("reports a Co-Authored-By line whoever it names", () => {
    expect(scanBody("Fix.\n\nCo-Authored-By: Someone <someone@example.test>\n")).toEqual(["body: Co-Authored-By line"]);
  });

  // Review Focus 2: a body written with CRLF line endings.
  test("reports a Co-Authored-By line in a CRLF body", () => {
    expect(scanBody("Fix.\r\n\r\nCo-Authored-By: Someone <someone@example.test>\r\n")).toEqual(["body: Co-Authored-By line"]);
  });

  test("reports a Claude-Session line", () => {
    expect(scanBody("Fix.\n\nClaude-Session: abc\n")).toEqual(["body: Claude-Session line"]);
  });

  test("reports a line opening with Generated with, after an emoji", () => {
    expect(scanBody("Body\n\n\u{1F916} Generated with a tool\n")).toEqual(["body: Generated-with line"]);
  });

  test("leaves mid-sentence prose about generation alone", () => {
    expect(scanBody("The payload is generated with the exporter.")).toEqual([]);
  });

  test("labels hits by field", () => {
    expect(scanText([{ label: "title", text: "fixture-host fix" }, { label: "body", text: "clean" }], DECL)).toEqual(["title: machine hostname"]);
  });
});

describe("findClosingRefs()", () => {
  test("reads every keyword form GitHub accepts", () => {
    const text = "Closes #1\nfixed: #2\nResolves fixture-owner/fixture-repo#3\nfix https://github.com/fixture-owner/fixture-repo/issues/4\ncloses GH-5";
    expect(findClosingRefs(text, REPO).map((ref) => ref.number)).toEqual([1, 2, 3, 4, 5]);
  });

  test("normalises the repository and reads a cross-repository reference", () => {
    expect(findClosingRefs("Fixes Other-Owner/Other#9", REPO)).toEqual([{ repo: "other-owner/other", number: 9 }]);
  });

  test("ignores plain references and words that only contain a keyword", () => {
    expect(findClosingRefs("See #12. Prefixes #13. Closing #14.", REPO)).toEqual([]);
  });

  test("counts keywords inside code spans too", () => {
    expect(findClosingRefs("Write `fixes #20` to close one.", REPO)).toHaveLength(1);
  });
});

describe("parseClosesList()", () => {
  test("parses and dedupes", () => {
    expect(parseClosesList("12, 34,12")).toEqual([12, 34]);
  });

  test("treats absent and empty as nothing declared", () => {
    expect(parseClosesList(undefined)).toEqual([]);
    expect(parseClosesList("")).toEqual([]);
  });

  test("rejects anything else", () => {
    expect(() => parseClosesList("#12")).toThrow(UsageError);
    expect(() => parseClosesList("0")).toThrow(UsageError);
  });
});

describe("compareClosing()", () => {
  test("accepts an exact match", () => {
    expect(compareClosing(findClosingRefs("Closes #12", REPO), [12], REPO)).toEqual({ ok: true });
  });

  test("accepts no keywords and nothing declared", () => {
    expect(compareClosing([], [], REPO)).toEqual({ ok: true });
  });

  test("refuses an undeclared keyword", () => {
    expect(compareClosing(findClosingRefs("Closes #12", REPO), [], REPO)).toEqual({
      ok: false,
      reason: "closing keywords do not match --closes (undeclared: 1, missing: 0)",
    });
  });

  test("refuses a declared issue the text never closes", () => {
    expect(compareClosing([], [12], REPO)).toEqual({ ok: false, reason: "closing keywords do not match --closes (undeclared: 0, missing: 1)" });
  });

  test("refuses a keyword naming another repository even when the number is declared", () => {
    expect(compareClosing(findClosingRefs("Closes other/repo#12", REPO), [12], REPO)).toMatchObject({ ok: false });
  });
});
