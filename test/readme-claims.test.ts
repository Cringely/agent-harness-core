// Guards README.md's machine-checkable inventory claims against drift (#217, part 1 of 3).
//
// The invariant: README.md describes the repo as it is. Four of its claims are cheap to check
// mechanically because each names a population this repo already enumerates elsewhere (a
// directory listing, a table, or a workflow file), so a change to that population that does not
// carry a matching README edit is a defect this test catches instead of a reviewer having to
// notice prose drifted from code.
//
// #207 and #208 are the drift this test exists to stop recurring: README.md kept saying
// test.yml ran "two jobs" and "four of the five" Pester suites on Windows only, months after
// #207 wired the fifth suite into CI and #208 added a third job running the same suites on
// Linux. Nothing caught it because nothing compared the prose to test.yml.
//
// Anchors, never line numbers. A table row is located by its own leading backticked path cell
// ("| `core/claude/agents/` |"), and the CI paragraph by its own opening sentence ("CI is one
// workflow,"). A shifted or renamed anchor is a failure naming the anchor, never a silent skip.
// See readRow and readParagraph below.
//
// CRLF-tolerant throughout: this repo's working tree is CRLF on Windows while the index holds
// LF, so every split uses /\r?\n/ rather than a bare "\n" (see MEMORY.md, "line-ending agnostic
// matcher").

import { describe, expect, test } from "bun:test";
import { extname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const REPO_ROOT = join(import.meta.dir, "..");

function readReadmeLines(): string[] {
  const text = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  return text.split(/\r?\n/);
}

// Finds the single physical line whose trimmed text starts with "| `<leadingPath>` |", a table
// row named by its own first cell. Throws naming the anchor rather than returning undefined, so a
// renamed or removed row fails loudly instead of silently checking nothing.
function readRow(lines: readonly string[], leadingPath: string): string {
  const marker = `| \`${leadingPath}\` |`;
  const row = lines.find((l) => l.trim().startsWith(marker));
  if (row === undefined) {
    throw new Error(`README.md: no table row found starting with anchor "${marker}"`);
  }
  return row;
}

// Collects a single paragraph: the line whose trimmed text starts with `leadingText`, plus every
// line after it up to the next blank line or "## " heading. The "## Testing and merging" section
// holds three paragraphs and only the middle one describes test.yml's jobs. "Two suites" (the
// first) counts bun and Pester as testing frameworks, not test.yml jobs, and is true as written,
// so a whole-section anchor would flag it as a false positive. Anchoring on this paragraph's own
// opening sentence keeps the check scoped to the one claim it exists to guard. Throws naming the
// anchor when no such paragraph is found, same as readRow.
function readParagraph(lines: readonly string[], leadingText: string): string[] {
  const start = lines.findIndex((l) => l.trim().startsWith(leadingText));
  if (start === -1) {
    throw new Error(`README.md: no paragraph found starting with anchor "${leadingText}"`);
  }
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (i > start && (trimmed === "" || trimmed.startsWith("## "))) break;
    body.push(lines[i]!);
  }
  return body;
}

// Backtick spans that name a bare identifier (an agent or hook name) rather than a path or a
// dotted API reference. A path or a `core.hooksPath`-style dotted name always contains "/" or
// ".", so excluding both leaves exactly the identifiers a row lists inline, with no need to first
// strip the row's own leading path cell (that cell fails the same filter for the same reason).
function backtickIdentifiers(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const name = m[1]!;
    if (!name.includes("/") && !name.includes(".")) names.push(name);
  }
  return names.sort();
}

describe("README core/claude/agents/ row", () => {
  function actualAgentNames(): string[] {
    return readdirSync(join(REPO_ROOT, "core/claude/agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  }

  test("lists exactly the basenames of core/claude/agents/*.md", () => {
    const row = readRow(readReadmeLines(), "core/claude/agents/");
    expect(backtickIdentifiers(row)).toEqual(actualAgentNames());
  });

  // Canary: proves the extraction+compare above can actually fail, against a synthetic row
  // shaped like the real one but naming a def that does not exist on disk. Without this, a
  // matcher that always returns an empty list on both sides would pass the test above
  // vacuously.
  test("canary: a fake agent name in the row is caught against the real directory", () => {
    const fakeRow = "| `core/claude/agents/` | Self-contained process roles `nonexistent-role`, `doc-steward` |";
    expect(backtickIdentifiers(fakeRow)).not.toEqual(actualAgentNames());
  });
});

describe("README core/claude/hooks/ row", () => {
  // "Extensionless" per node's own path.extname, which is what makes ".gitkeep" a trap: a
  // leading dot with no second dot has extname "" too, so dotfiles must be excluded explicitly
  // rather than relying on extname alone to mean "a real git hook with no extension".
  function actualGitHookNames(): string[] {
    return readdirSync(join(REPO_ROOT, "core/claude/hooks"))
      .filter((f) => !f.startsWith(".") && extname(f) === "")
      .sort();
  }

  test("lists exactly the extensionless, non-dotfile names in core/claude/hooks/", () => {
    const row = readRow(readReadmeLines(), "core/claude/hooks/");
    expect(backtickIdentifiers(row)).toEqual(actualGitHookNames());
  });

  // Regression guard for the .gitkeep trap named above: an unfiltered "no extension" check
  // would fold .gitkeep into this population and fail on day one, since README does not list
  // it. Pinning the current directory listing here keeps that day-one failure from coming back
  // silently if the dotfile filter is ever dropped.
  test(".gitkeep is excluded because it is a dotfile, not because it has an extension", () => {
    const files = readdirSync(join(REPO_ROOT, "core/claude/hooks"));
    expect(files).toContain(".gitkeep");
    expect(extname(".gitkeep")).toBe("");
    expect(actualGitHookNames()).not.toContain(".gitkeep");
  });

  // Canary, same shape as the agents one above: a fake hook name must be caught.
  test("canary: a fake hook name in the row is caught against the real directory", () => {
    const fakeRow =
      "| `core/claude/hooks/` | The three git hooks in the same directory, `pre-commit`, `pre-push` and `made-up-hook`, are wired a second way |";
    expect(backtickIdentifiers(fakeRow)).not.toEqual(actualGitHookNames());
  });
});

describe("README <-> patterns/INDEX.md <-> patterns/*.md", () => {
  function indexLinkedFiles(): string[] {
    const text = readFileSync(join(REPO_ROOT, "patterns/INDEX.md"), "utf8");
    const files: string[] = [];
    for (const m of text.matchAll(/\[`([^`]+\.md)`\]\(([^)]+)\)/g)) {
      // The link text and href are expected to agree, asserted below rather than assumed here.
      // A doc that renames one without the other then fails with a clear reason instead of
      // silently checking whichever side happens to be right.
      files.push(m[1]!);
      if (m[1] !== m[2]) {
        throw new Error(`patterns/INDEX.md: link text "${m[1]}" and href "${m[2]}" disagree`);
      }
    }
    return files.sort();
  }

  function actualPatternFiles(): string[] {
    return readdirSync(join(REPO_ROOT, "patterns"))
      .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
      .sort();
  }

  test("every INDEX.md row link resolves to a real file under patterns/", () => {
    const linked = indexLinkedFiles();
    const actual = new Set(actualPatternFiles());
    for (const name of linked) expect(actual.has(name)).toBe(true);
  });

  test("INDEX.md rows and patterns/*.md (INDEX.md excluded) are a bijection", () => {
    expect(indexLinkedFiles()).toEqual(actualPatternFiles());
  });

  // Canary: an INDEX.md row naming a file that is not on disk must be caught, proving the
  // bijection check is not vacuously true because both sides happen to be empty or equal by
  // construction.
  test("canary: a fake INDEX.md row is caught against the real directory", () => {
    const fakeIndex = [
      "| Doc | Problem it solves |",
      "|---|---|",
      "| [`nonexistent-pattern.md`](nonexistent-pattern.md) | Made up for this test. |",
    ].join("\n");
    const files: string[] = [];
    for (const m of fakeIndex.matchAll(/\[`([^`]+\.md)`\]\(([^)]+)\)/g)) files.push(m[1]!);
    expect(files.sort()).not.toEqual(actualPatternFiles());
  });
});

// A number word (one..ten) or bare digit, immediately followed by "jobs"/"suites", or by
// "of (the) <number> ... suites/jobs": the two shapes #207/#208 left behind ("two jobs", "four
// of the five Pester suites"). Matching \s+ only (no intervening words) keeps this from firing
// on unrelated prose like "requires one approving review", which never continues into "jobs" or
// "suites".
const NUMBER = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)`;
const COUNT_PHRASE_RE = new RegExp(
  String.raw`\b${NUMBER}\s+(?:jobs?|suites?)\b|\b${NUMBER}\s+of\s+(?:the\s+)?${NUMBER}\s+(?:\w+\s+)?(?:jobs?|suites?)\b`,
  "gi",
);

function countPhrases(text: string): string[] {
  return [...text.matchAll(COUNT_PHRASE_RE)].map((m) => m[0]);
}

describe("README CI claims carry no hand-written job/suite count", () => {
  test("the .github/workflows/ row names no count of test.yml's jobs", () => {
    const row = readRow(readReadmeLines(), ".github/workflows/");
    expect(countPhrases(row)).toEqual([]);
  });

  test("the 'CI is one workflow' paragraph names no count of test.yml's jobs or suites", () => {
    const paragraph = readParagraph(readReadmeLines(), "CI is one workflow,").join("\n");
    expect(countPhrases(paragraph)).toEqual([]);
  });

  // Canary required by #217: proves COUNT_PHRASE_RE still flags the exact phrasings README used
  // to carry, so the two tests above cannot be passing because the matcher stopped matching
  // anything.
  test("canary: the matcher still flags the old, now-false phrasings", () => {
    expect(countPhrases("Its two jobs are what the pull request reviewer reads")).toEqual(["two jobs"]);
    expect(
      countPhrases("with two jobs: `bun test` on Linux, and four of the five Pester suites on Windows"),
    ).toEqual(["two jobs", "four of the five Pester suites"]);
  });
});
