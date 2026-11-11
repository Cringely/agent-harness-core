// Guards docs/security-controls.md (#173): the register of security controls.
//
// The invariant: every file and test the register cites exists. A rename or deletion that leaves a
// row pointing at nothing fails here, so the register goes stale visibly instead of silently.
// This checks paths only. Whether a row's invariant sentence is still true stays a human read.
//
// Rows are located by shape (a table line whose first cell is not a header or divider), never by
// line number. A table line that does not yield 4 cells is collected as malformed and fails the
// test, so a broken row cannot drop out of the check unnoticed. CRLF-tolerant: split on /\r?\n/.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

export type Row = { control: string; files: string[]; tests: string[] };

// Split on unescaped pipes only, so an escaped pipe inside a cell stays in the cell.
function splitCells(line: string): string[] {
  return line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
}

function isHeaderOrDivider(cells: string[]): boolean {
  return cells[0] === "Control" || /^:?-+:?$/.test(cells[0]);
}

export function parseRegister(text: string): { rows: Row[]; malformed: string[]; dataLines: number } {
  const rows: Row[] = [];
  const malformed: string[] = [];
  let dataLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = splitCells(line);
    if (cells.length > 0 && isHeaderOrDivider(cells)) continue;
    dataLines++;
    if (cells.length !== 4) {
      malformed.push(line);
      continue;
    }
    const paths = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ control: cells[0], files: paths(cells[2]), tests: paths(cells[3]) });
  }
  return { rows, malformed, dataLines };
}

export function missingPaths(rows: Row[], root: string = REPO_ROOT): string[] {
  return rows.flatMap((r) => [...r.files, ...r.tests]).filter((p) => !existsSync(join(root, p)));
}

const register = readFileSync(join(REPO_ROOT, "docs", "security-controls.md"), "utf8");

describe("docs/security-controls.md", () => {
  const { rows, malformed, dataLines } = parseRegister(register);

  test("every table line yields 4 cells", () => {
    expect(malformed).toEqual([]);
  });

  test("parsed row count equals the register's data lines", () => {
    expect(dataLines).toBeGreaterThan(0);
    expect(rows.length).toBe(dataLines);
  });

  test("every cited path exists", () => {
    expect(missingPaths(rows)).toEqual([]);
  });

  test("does not list review-gate.ts, which issue 37 retires", () => {
    expect(register).not.toContain("review-gate");
  });

  for (const row of rows) {
    test(`${row.control}: names an implementing file and a pinning test`, () => {
      expect(row.files.length).toBeGreaterThan(0);
      expect(row.tests.length).toBeGreaterThan(0);
    });
  }

  test("a renamed path is reported as the only missing path", () => {
    const renamed = register.replace("`tools/pr-review/identity.ts`", "`tools/pr-review/identity-renamed.ts`");
    expect(renamed).not.toBe(register);
    expect(missingPaths(parseRegister(renamed).rows)).toEqual(["tools/pr-review/identity-renamed.ts"]);
  });

  test("a malformed row is collected, not skipped", () => {
    const broken = register.replace("| Local secret scan |", "| Local secret scan");
    expect(broken).not.toBe(register);
    expect(parseRegister(broken).malformed).toHaveLength(1);
  });
});
