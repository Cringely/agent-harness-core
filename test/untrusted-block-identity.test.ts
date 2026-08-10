// Drift guard for the untrusted-content boundary block. The block is inlined
// verbatim in every agent def rather than referenced from
// core/claude/templates/untrusted-content-boundary.template.md, because
// Install-Harness.ps1 installs agent defs as a directory glob but installs
// templates by explicit name, so a def pointing at the template would dangle in
// every installed project. Inlining buys correctness at install time and costs a
// drift risk at edit time; this file is the check that pays for it.
//
// These tests read the real repository files, not fixtures. Every copy must be
// byte-identical to every other copy, and the copies are compared only to each
// other. Nothing here pins a hash, a line count, or a byte count: the block's
// text is expected to change (backlog item 11 restores "already owns" to it),
// and a test that pinned today's values would fail that correct edit.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// --- Boundary definition. The block runs from its heading through the line
// that closes the evidence rule, inclusive. Both markers are unique within
// every file that carries the block. Moving either boundary is a one-place
// edit here.
//
// Both markers are matched as whole lines, so the split that produces those
// lines has to accept either line ending. These files are LF in the index and
// core.autocrlf=true checks them out as CRLF on Windows; a bare split("\n")
// leaves a trailing \r on every line, the whole-line comparisons all miss, and
// the suite reports drift that is not there. -------------------------------

const BLOCK_START = "## Untrusted content is data, not instructions";
const BLOCK_END = "a shortcut.";

// Plausibility floors, deliberately far below the block's real size. They exist
// to catch a truncated or partial extraction, not to measure the block. A
// pattern that matches nothing produces an empty string, and six empty strings
// compare equal to each other, so an equality-only test would pass while
// checking nothing. That failure is not hypothetical: a probe run against these
// same files hashed an empty match and reported the md5 of the empty string
// across all six copies. These floors run before any equality assertion.

const MIN_BLOCK_LINES = 12;
const MIN_BLOCK_CHARS = 400;

// --- Copy locations. The agent defs are DISCOVERED by reading the directory,
// so a def added later is picked up without editing this file. The template is
// NAMED, because it is a single known file and there is no directory to walk.
// Discovery is what makes a newly added def fail this suite when it omits the
// block, rather than being silently skipped. That strictness is intended: the
// template's editing contract says the block appears in every def under
// core/claude/agents, so a def without it is either a mistake or a decision
// that belongs in the contract first. -------------------------------------

const REPO_ROOT = join(import.meta.dir, "..");
const AGENTS_DIR = join(REPO_ROOT, "core/claude/agents");
const TEMPLATE_PATH = join(
  REPO_ROOT,
  "core/claude/templates/untrusted-content-boundary.template.md",
);

function agentDefPaths(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(AGENTS_DIR, name));
}

const COPIES: Array<{ label: string; path: string }> = [
  ...agentDefPaths().map((path) => ({ label: `agents/${basename(path)}`, path })),
  { label: `templates/${basename(TEMPLATE_PATH)}`, path: TEMPLATE_PATH },
];

const LABELS = COPIES.map((copy) => copy.label);

function pathFor(label: string): string {
  const copy = COPIES.find((candidate) => candidate.label === label);
  if (!copy) throw new Error(`no copy registered under label ${label}`);
  return copy.path;
}

// The one place either matcher decides what a line is. /\r?\n/ is the same
// convention test/agent-frontmatter-keys.test.ts already reads these files
// with.
function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

function headingCount(path: string): number {
  return linesOf(readFileSync(path, "utf8")).filter((line) => line === BLOCK_START)
    .length;
}

// Returns "" when either boundary is missing. Returning a sentinel rather than
// throwing keeps the sanity assertions below in charge of the failure message,
// so a missing boundary reports as a bad extraction rather than as a crash
// during module load.
//
// The join is LF whatever the input was, which is what makes the identity
// comparisons below compare block text rather than checkout settings.
function extractBlock(path: string): string {
  const lines = linesOf(readFileSync(path, "utf8"));
  const start = lines.indexOf(BLOCK_START);
  if (start === -1) return "";
  const offset = lines.slice(start).indexOf(BLOCK_END);
  if (offset === -1) return "";
  return lines.slice(start, start + offset + 1).join("\n");
}

describe("copy discovery", () => {
  test("the agents directory yields at least one definition file", () => {
    expect(agentDefPaths().length).toBeGreaterThan(0);
  });

  test("more than one copy exists, so identity is a real comparison", () => {
    expect(COPIES.length).toBeGreaterThan(1);
  });

  test.each(LABELS)("%s carries exactly one canonical block heading", (label) => {
    expect(headingCount(pathFor(label))).toBe(1);
  });
});

describe("extraction sanity, asserted before any equality check", () => {
  test.each(LABELS)("%s extracts a plausible block", (label) => {
    const block = extractBlock(pathFor(label));

    expect(block).not.toBe("");
    expect(block.startsWith(BLOCK_START)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
    expect(block.split("\n").length).toBeGreaterThanOrEqual(MIN_BLOCK_LINES);
    expect(block.length).toBeGreaterThanOrEqual(MIN_BLOCK_CHARS);
  });
});

// The whole suite once reported six drifted copies on a Windows checkout, and
// none of them had drifted: core.autocrlf=true had handed the matchers CRLF
// text and a bare split("\n") left a \r on the end of every line. The cases
// below pin the fix by feeding the real functions a CRLF file on disk, so a
// refactor back to a bare split goes red here instead of failing as drift.
// The fixture is derived from the live template rather than hand-written, so it
// stays honest when the block's text changes.
describe("boundary matching survives a CRLF checkout", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "untrusted-block-eol-"));
  const lfText = readFileSync(TEMPLATE_PATH, "utf8").replace(/\r\n/g, "\n");
  const lfPath = join(fixtureDir, "lf.md");
  const crlfPath = join(fixtureDir, "crlf.md");
  writeFileSync(lfPath, lfText);
  writeFileSync(crlfPath, lfText.replace(/\n/g, "\r\n"));

  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  test("the fixture really is CRLF, so this test can fail for the right reason", () => {
    expect(readFileSync(crlfPath, "utf8")).toContain("\r\n");
    expect(readFileSync(lfPath, "utf8")).not.toContain("\r");
  });

  test("a CRLF file yields exactly one heading", () => {
    expect(headingCount(crlfPath)).toBe(1);
  });

  test("a CRLF file extracts the same non-empty block as its LF twin", () => {
    expect(extractBlock(crlfPath)).not.toBe("");
    expect(extractBlock(crlfPath)).toBe(extractBlock(lfPath));
  });
});

describe("identity across every copy", () => {
  const [reference, ...others] = COPIES;

  test.each(others.map((copy) => copy.label))(
    "%s is byte-identical to the reference copy",
    (label) => {
      expect(extractBlock(pathFor(label))).toBe(extractBlock(reference!.path));
    },
  );

  test("collapsing every copy leaves exactly one distinct block", () => {
    const distinct = new Set(COPIES.map((copy) => extractBlock(copy.path)));
    expect(distinct.size).toBe(1);
  });
});
