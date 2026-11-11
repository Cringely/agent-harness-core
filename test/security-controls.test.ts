// Guards docs/security-controls.md (#173): the register of security controls.
//
// The invariant: every file and test the register cites exists. A rename or deletion that leaves a
// row pointing at nothing fails here, so the register goes stale visibly instead of silently.
// This checks paths only. Whether a row's invariant sentence is still true stays a human read.
//
// Rows are located by shape (a table line whose first cell is not a header or divider), never by
// line number. CRLF-tolerant: split on /\r?\n/.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

export type Row = { control: string; files: string[]; tests: string[] };

export function parseRegister(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 4) continue;
    if (cells[0] === "Control" || /^-+$/.test(cells[0])) continue;
    const paths = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ control: cells[0], files: paths(cells[2]), tests: paths(cells[3]) });
  }
  return rows;
}

const register = readFileSync(join(REPO_ROOT, "docs", "security-controls.md"), "utf8");

describe("docs/security-controls.md", () => {
  const rows = parseRegister(register);

  test("lists controls", () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  test("does not list review-gate.ts, which issue 37 retires", () => {
    expect(register).not.toContain("review-gate");
  });

  for (const row of rows) {
    test(`${row.control}: names an implementing file and a pinning test`, () => {
      expect(row.files.length).toBeGreaterThan(0);
      expect(row.tests.length).toBeGreaterThan(0);
    });

    for (const p of [...row.files, ...row.tests]) {
      test(`${row.control}: ${p} exists`, () => {
        expect(existsSync(join(REPO_ROOT, p))).toBe(true);
      });
    }
  }

  test("a missing path is detected", () => {
    const bad = parseRegister("| X | inv | `core/nope-does-not-exist.ts` | `test/also-missing.test.ts` |");
    expect(bad).toHaveLength(1);
    expect(bad.flatMap((r) => [...r.files, ...r.tests]).some((p) => !existsSync(join(REPO_ROOT, p)))).toBe(true);
  });
});
