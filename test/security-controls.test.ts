// Guards docs/security-controls.md (#173): the register of security controls.
//
// The invariant: every file and test the register cites exists. A rename or deletion that leaves a
// row pointing at nothing fails here, so the register goes stale visibly instead of silently.
// This checks paths only. Whether a row's invariant sentence is still true stays a human read.
//
// The table is located by its divider line, never by line number. Every line after the divider up
// to the first blank line is a data row, whatever its leading characters: GFM renders a row with no
// leading pipe, or one indented up to three spaces, as part of the table, so the parser does too.
// A data row that does not yield 4 cells, or whose two path cells are not made only of backticked
// comma-separated paths, is collected as malformed and fails the test, so a broken row cannot drop
// out of the check unnoticed. CRLF-tolerant: split on /\r?\n/.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

// Floor on the register's size. A register edit that adds or removes a control updates this too, so
// a truncated file cannot pass just because what is left is self-consistent.
export const MIN_ROWS = 13;

export type Row = { control: string; files: string[]; tests: string[] };

const DIVIDER = /^\s{0,3}\|?\s*:?-{3,}:?\s*\|/;
const PATH_LIST = /^`[^`]+`(\s*,\s*`[^`]+`)*$/;

// Split on unescaped pipes only, so an escaped pipe inside a cell stays in the cell. The leading and
// trailing pipes are optional, as in GFM.
function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

// Counts the table's data lines without going through the parser, so the row-count test compares
// two independent readings of the file. A data line is any non-blank line after the divider, up to
// the first blank line.
export function countDataLines(text: string): number {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => DIVIDER.test(l));
  if (at < 0) return 0;
  let n = 0;
  for (let i = at + 1; i < lines.length && lines[i].trim() !== ""; i++) n++;
  return n;
}

export function parseRegister(text: string): { rows: Row[]; malformed: string[] } {
  const rows: Row[] = [];
  const malformed: string[] = [];
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => DIVIDER.test(l));
  if (at < 0) return { rows, malformed: ["no table divider line found"] };
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") break;
    const cells = splitCells(line);
    if (cells.length !== 4 || !PATH_LIST.test(cells[2]) || !PATH_LIST.test(cells[3])) {
      malformed.push(line);
      continue;
    }
    const paths = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ control: cells[0], files: paths(cells[2]), tests: paths(cells[3]) });
  }
  return { rows, malformed };
}

export function missingPaths(rows: Row[], root: string = REPO_ROOT): string[] {
  return rows.flatMap((r) => [...r.files, ...r.tests]).filter((p) => !existsSync(join(root, p)));
}

const register = readFileSync(join(REPO_ROOT, "docs", "security-controls.md"), "utf8");

describe("docs/security-controls.md", () => {
  const { rows, malformed } = parseRegister(register);

  test("every data line yields 4 cells with fully backticked path cells", () => {
    expect(malformed).toEqual([]);
  });

  test("parsed row count equals an independent count of the table's data lines", () => {
    expect(countDataLines(register)).toBeGreaterThanOrEqual(MIN_ROWS);
    expect(rows.length).toBe(countDataLines(register));
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

  test("a row with no leading pipe is still parsed and its paths checked", () => {
    const bare = register.replace("| Local secret scan |", "Local secret scan |");
    expect(bare).not.toBe(register);
    const parsed = parseRegister(bare);
    expect(parsed.malformed).toEqual([]);
    expect(parsed.rows.length).toBe(rows.length);
    const renamed = bare.replace(/`test\/pre-commit\.test\.ts` \|(\r?\n\| CI secret)/, "`test/no-such-test.ts` |$1");
    expect(renamed).not.toBe(bare);
    expect(missingPaths(parseRegister(renamed).rows)).toEqual(["test/no-such-test.ts"]);
  });

  test("an indented row is still parsed", () => {
    const indented = register.replace("| Local secret scan |", "  | Local secret scan |");
    expect(parseRegister(indented).rows.length).toBe(rows.length);
  });

  test("a path written without backticks is malformed, not silently unchecked", () => {
    const bare = register.replace("`core/claude/hooks/commit-msg` |", "core/claude/hooks/commit-msg |");
    expect(bare).not.toBe(register);
    expect(parseRegister(bare).malformed).toHaveLength(1);
    const mixed = register.replace("`core/claude/hooks/pre-push`, `core/claude/hooks/identity-patterns.sh` | `test/identity-gate.test.ts` |", "`core/claude/hooks/pre-push`, core/claude/hooks/identity-patterns.sh | `test/identity-gate.test.ts` |");
    expect(mixed).not.toBe(register);
    expect(parseRegister(mixed).malformed).toHaveLength(1);
  });

  test("a register cut down to one row fails the size floor", () => {
    const lines = register.split(/\r?\n/);
    const at = lines.findIndex((l) => DIVIDER.test(l));
    const cut = lines.slice(0, at + 2).join("\n");
    expect(parseRegister(cut).rows).toHaveLength(1);
    expect(countDataLines(cut)).toBeLessThan(MIN_ROWS);
  });
});
