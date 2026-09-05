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
// Deliberately narrow: it catches "218 files" and "2 files", the form the
// document actually used, and not every conceivable phrasing of a count. A
// guard that tried to recognise "eighty-five markdown documents" would be
// guessing at English, and the rule it enforces is a review-time judgment that
// this check only backstops at its most common shape.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("NOTICE — no hard-coded measurement of the generated payload", () => {
  test("states no file count", () => {
    const notice = readFileSync(join(import.meta.dir, "..", "NOTICE"), "utf8");
    const counts = [...notice.matchAll(/\b\d[\d,]*\s+files?\b/gi)].map((m) => m[0]);
    expect(counts).toEqual([]);
  });
});
