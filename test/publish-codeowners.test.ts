// Tests for tools/publish/codeowners.ts (#274): the CODEOWNERS subset review-merge accepts, what it
// refuses, and how a path is found owned.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOwned, parseCodeowners, type CodeownersRule } from "../tools/publish/codeowners";

function rules(text: string): CodeownersRule[] {
  const parsed = parseCodeowners(text);
  if (!parsed.ok) throw new Error(`fixture refused at line ${parsed.line}`);
  return parsed.rules;
}

describe("parseCodeowners()", () => {
  test("parses this repository's own CODEOWNERS", () => {
    const text = readFileSync(join(import.meta.dir, "..", ".github", "CODEOWNERS"), "utf8");
    const parsed = parseCodeowners(text);
    expect(parsed.ok).toBe(true);
    const owned = parsed.ok ? parsed.rules : [];
    expect(isOwned(owned, "tools/publish/merge-decision.ts")).toBe(true);
    expect(isOwned(owned, "CONTRIBUTING.md")).toBe(true);
    expect(isOwned(owned, "README.md")).toBe(false);
    expect(isOwned(owned, "core/claude/skills/publish/SKILL.md")).toBe(false);
  });

  test("skips comments and blank lines, and reads CRLF", () => {
    expect(rules("# a comment\r\n\r\n/docs/  @someone\r\n")).toEqual([{ path: "docs", dirOnly: true, owners: ["@someone"] }]);
  });

  test("accepts @user, @org/team and email owners, and a pattern with none", () => {
    expect(rules("/a @user @org/team-x person@example.test\n/b\n")).toEqual([
      { path: "a", dirOnly: false, owners: ["@user", "@org/team-x", "person@example.test"] },
      { path: "b", dirOnly: false, owners: [] },
    ]);
  });

  const refused: [string, string][] = [
    ["an unanchored pattern", "docs/ @someone"],
    ["a bare name", "README.md @someone"],
    ["a star", "/docs/* @someone"],
    ["a global star", "* @someone"],
    ["a double star", "/**/logs @someone"],
    ["a question mark", "/doc? @someone"],
    ["negation", "!/docs/ @someone"],
    ["a character range", "/doc[s]/ @someone"],
    ["an escape", "/\\#docs @someone"],
    ["a doubled slash", "/docs//x @someone"],
    ["a dot segment", "/docs/../x @someone"],
    ["the root alone", "/ @someone"],
    ["an owner that is not @user, @org/team or an email", "/docs/ someone"],
    ["an inline comment", "/docs/ @someone # note"],
  ];
  for (const [name, line] of refused) {
    test(`refuses ${name}, naming the line`, () => {
      expect(parseCodeowners(`# header\n/ok/ @someone\n${line}\n`)).toEqual({ ok: false, line: 3 });
    });
  }
});

describe("isOwned()", () => {
  test("a directory pattern owns everything under it, at any depth, and not a file of that name", () => {
    const owned = rules("/tools/publish/ @someone\n");
    expect(isOwned(owned, "tools/publish/gh.ts")).toBe(true);
    expect(isOwned(owned, "tools/publish/deep/x.ts")).toBe(true);
    expect(isOwned(owned, "tools/publish")).toBe(false);
    expect(isOwned(owned, "tools/publisher/x.ts")).toBe(false);
    expect(isOwned(owned, "other/tools/publish/gh.ts")).toBe(false);
  });

  test("a pattern without a trailing slash owns that file, or a directory of that name", () => {
    const owned = rules("/CONTRIBUTING.md @someone\n/bin @someone\n");
    expect(isOwned(owned, "CONTRIBUTING.md")).toBe(true);
    expect(isOwned(owned, "CONTRIBUTING.md.bak")).toBe(false);
    expect(isOwned(owned, "docs/CONTRIBUTING.md")).toBe(false);
    expect(isOwned(owned, "bin/tool")).toBe(true);
  });

  test("compares case-sensitively", () => {
    expect(isOwned(rules("/Docs/ @someone\n"), "docs/a.md")).toBe(false);
  });

  test("the last matching line wins, and one with no owners unowns", () => {
    const owned = rules("/docs/ @someone\n/docs/public/\n");
    expect(isOwned(owned, "docs/private.md")).toBe(true);
    expect(isOwned(owned, "docs/public/a.md")).toBe(false);
    expect(isOwned(rules("/docs/public/\n/docs/ @someone\n"), "docs/public/a.md")).toBe(true);
  });

  test("nothing is owned under an empty file", () => {
    expect(isOwned(rules(""), "anything")).toBe(false);
  });
});
