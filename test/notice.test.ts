// Guards NOTICE against reacquiring a file count of account/claude/.
//
// CONTRIBUTING.md's "nobody hard-codes a measurement of a file they don't own"
// clause has no mechanical enforcement anywhere in this repository, and NOTICE
// is the one document that broke it at scale: eleven counts of a directory
// `install/Export-Account.ps1` regenerates, every one correct when written and
// every one falsified by the next export that installs or drops a skill. That
// is worse than ordinary doc drift, because the number is load-bearing in a
// licence attribution.
//
// It also came back once. The first draft rounded the figures and labelled them
// rounded, which the rule permits; a later correction replaced them with exact
// counts. A prose reminder inside NOTICE would have lost that argument the same
// way, so the reminder is here, where it fails a run.
//
// The first version of this guard read only digits followed by "files", which
// is the form the eleven counts happened to use, and it therefore matched none
// of the three that survived them: "All seven trees", "The six OWASP trees",
// "all seven trees". CONTRIBUTING.md's clause covers "any number read off a
// file", not only file counts, and one of those three scoped a LICENCE claim by
// a count of a generated directory — an eighth OWASP skill arriving through
// Export-Account.ps1 would have falsified it silently. So the guard now reads a
// spelled-out number as readily as a digit, and reads trees, directories and
// skills as readily as files.
//
// Still deliberately bounded, in two ways. The number words stop at twelve,
// because a notice counting past that is counting something it has no business
// enumerating either way. And a count is only a finding when a payload noun
// follows it within a word, which is what keeps "OGL-UK-3.0 AND CC-BY-4.0" and
// "v1.21.2" out. Nothing here tries to recognise "eighty-five markdown
// documents": the rule is a review-time judgment this check backstops at its
// common shapes, not a parser for English.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The digit arm excludes a digit preceded by another digit, a dot or a hyphen,
// so a version tail or a licence identifier's trailing digit can't start a
// match: "OGL-UK-3.0 files" and "CC-BY-4.0 skills" stop at the run-in digit
// instead of reading it as a fresh count of "0 files" / "0 skills".
const COUNT = String.raw`(?<![\d.\-])\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve`;
// What this notice could be counting: the trees and files of a generated tree.
const PAYLOAD = String.raw`files?|trees?|director(?:y|ies)|skills?|documents?`;
// One optional word between the two, so "six OWASP trees" is caught alongside
// "seven trees". Two would start matching ordinary prose that happens to open
// with a number word.
const COUNTED = new RegExp(String.raw`\b(?:${COUNT})\s+(?:\w+\s+)?(?:${PAYLOAD})\b`, "gi");

describe("NOTICE — no hard-coded measurement of the generated payload", () => {
  test("counts nothing in the payload, in digits or in words", () => {
    const notice = readFileSync(join(import.meta.dir, "..", "NOTICE"), "utf8");
    const counts = [...notice.matchAll(COUNTED)].map((m) => m[0]);
    expect(counts).toEqual([]);
  });

  // Without this the case above passes on a guard that matches nothing at all,
  // which is exactly how the digits-only version read clean over three counts
  // it could not see.
  test("the guard recognises both spellings it was widened for", () => {
    const found = (s: string) => [...s.matchAll(COUNTED)].map((m) => m[0]);
    expect(found("All seven trees come from microsoft/hve-core.")).toEqual(["seven trees"]);
    expect(found("The six OWASP trees carry license: CC-BY-SA-4.0.")).toEqual(["six OWASP trees"]);
    expect(found("218 files under account/claude/.")).toEqual(["218 files"]);
    // The two version strings the notice legitimately carries stay clean.
    expect(found("`license: OGL-UK-3.0 AND CC-BY-4.0`")).toEqual([]);
    expect(found("vale-ai-tells at v1.21.2, pinned by release URL")).toEqual([]);
  });

  // A licence identifier or version number immediately followed by a payload
  // noun used to read as a count of that noun: the digit arm stopped at the
  // version tail's own trailing digit rather than at the identifier's start.
  test("a version tail followed by a payload noun is not a count", () => {
    const found = (s: string) => [...s.matchAll(COUNTED)].map((m) => m[0]);
    expect(found("the OGL-UK-3.0 files carry no marker")).toEqual([]);
    expect(found("CC-BY-4.0 skills ship with attribution")).toEqual([]);
    expect(found("SPDX 2.3 document format")).toEqual([]);
  });
});
