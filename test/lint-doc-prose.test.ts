// Offline tests for the prose-lint-on-write PostToolUse hook
// (core/claude/hooks/lint-doc-prose.ts). All logic is in the exported pure
// shouldLint()/planLint()/resolveValeConfig(), so these run with no Vale, no
// spawn, no network: editing living-doc prose lints; generated paths and
// non-doc files do not.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLint, resolveValeConfig, shouldLint } from "../core/claude/hooks/lint-doc-prose";

describe("shouldLint() — living-doc scope", () => {
  // These MUST lint.
  test.each([
    "docs/STATE.md",
    "docs/decisions.md",
    "docs/wiki/engineering-lessons.md",
    "README.md",
    "docs/specs/2026-07-10-harness-design.md",
    // Absolute + Windows-slash paths (the payload's file_path is whatever the tool got).
    "E:\\projects\\example\\docs\\STATE.md",
    "/home/runner/example/docs/wiki/harness-parts.md",
  ])("lints living-doc prose: %s", (p) => {
    expect(shouldLint(p)).toBe(true);
  });

  // These MUST NOT lint.
  test.each([
    "docs/assets/diagram.md", // generated / asset tree
    ".claude/wave-state.md", // generated, not under docs/
    "src/registry/actions.ts", // not markdown
    "docs/STATE.txt", // not markdown
    "package.json", // not markdown, not a doc
    "notes/scratch.md", // markdown but not a living-doc location
  ])("skips out-of-scope path: %s", (p) => {
    expect(shouldLint(p)).toBe(false);
  });

  test("empty / undefined path is out of scope, never a crash", () => {
    expect(shouldLint(undefined)).toBe(false);
    expect(shouldLint("")).toBe(false);
  });
});

// The account-layer exemption, mirrored into the distributed hook so projects
// inherit it. Every path below SATISFIES the living-doc allowlist — each one is
// a README.md or sits under a docs/ directory — and is dropped by SKIP_PATHS
// anyway. A case that failed the allowlist would pass vacuously and prove
// nothing, so none is used here. One assertion per case, deliberately: the
// runner stops a case at its first failure, and these have to ablate one at a
// time.
describe("shouldLint() — internal agent traffic is exempt", () => {
  test(".claude/ under a docs/ dir does not lint", () => {
    expect(shouldLint(".claude/docs/notes.md")).toBe(false);
  });

  test(".claude/ README does not lint", () => {
    expect(shouldLint(".claude/README.md")).toBe(false);
  });

  test("absolute .claude/docs path does not lint (the measured false positive)", () => {
    expect(shouldLint("E:\\projects\\x\\.claude\\docs\\notes.md")).toBe(false);
  });

  test("memory/ README does not lint", () => {
    expect(shouldLint("memory/README.md")).toBe(false);
  });

  test("handoffs/ nested under docs/ does not lint", () => {
    expect(shouldLint("docs/handoffs/2026-08-10-session.md")).toBe(false);
  });

  test("scratchpad/ README does not lint", () => {
    expect(shouldLint("scratchpad/README.md")).toBe(false);
  });

  test(".scratch/ README does not lint", () => {
    expect(shouldLint(".scratch/README.md")).toBe(false);
  });

  test("council-transcripts/ nested under docs/ does not lint", () => {
    expect(shouldLint("docs/council-transcripts/2026-08-01-scope.md")).toBe(false);
  });

  // The subagent-driven-development workspace. Real SDD files sit flat at
  // .superpowers/sdd/<plan>/<name>.md and fail the living-doc allowlist on
  // their own, so a case built on one would pass vacuously and prove nothing
  // about the skip list. Both cases below satisfy the allowlist — one on the
  // README arm, one on the docs/ arm — and are dropped by SKIP_PATHS only.
  test(".superpowers/ README does not lint", () => {
    expect(shouldLint(".superpowers/sdd/2026-09-03-account-layer/README.md")).toBe(false);
  });

  test(".superpowers/ nested under docs/ does not lint", () => {
    expect(shouldLint(".superpowers/sdd/2026-09-03-account-layer/docs/notes.md")).toBe(false);
  });
});

// A worktree is the one thing under .claude/ that is NOT internal traffic: the
// harness puts agent worktrees at <project>/.claude/worktrees/<name>/ and each
// holds a full repo checkout, so what is written there is a deliverable on its
// way to master. Without the negative lookahead the two positives below went the
// wrong way: of the 387 markdown files under this repo's own worktrees, the 39
// the allowlist admits were all silenced (measured 2026-08-14).
// The two negatives use a README.md rather than an arbitrary .md so they stay
// non-vacuous: .claude/worktrees/wf_1/memory/note.md fails the living-doc
// allowlist on its own and would prove nothing about the skip list.
describe("shouldLint() — a worktree checkout is not internal traffic", () => {
  test("a worktree docs/ file lints", () => {
    expect(shouldLint(".claude/worktrees/wf_1/docs/STATE.md")).toBe(true);
  });

  test("a worktree README lints", () => {
    expect(shouldLint("E:\\projects\\x\\.claude\\worktrees\\wf_1\\README.md")).toBe(true);
  });

  test("a nested .claude/ INSIDE a worktree still does not lint", () => {
    expect(shouldLint(".claude/worktrees/wf_1/.claude/docs/notes.md")).toBe(false);
  });

  test("memory/ INSIDE a worktree still does not lint", () => {
    expect(shouldLint(".claude/worktrees/wf_1/memory/README.md")).toBe(false);
  });
});

// The other half of every exemption: a deliverable whose NAME contains an
// exempt word but whose PATH has no such segment must still lint. These fail
// the moment a skip regex is written as a substring match instead of a
// separator-anchored one.
describe("shouldLint() — the exemption is segment-anchored, not substring", () => {
  test("docs/memory-system.md still lints", () => {
    expect(shouldLint("docs/memory-system.md")).toBe(true);
  });

  test("docs/claude-setup.md still lints", () => {
    expect(shouldLint("docs/claude-setup.md")).toBe(true);
  });

  test("docs/handoff-protocol.md still lints", () => {
    expect(shouldLint("docs/handoff-protocol.md")).toBe(true);
  });

  test("docs/scratchpad-hygiene.md still lints", () => {
    expect(shouldLint("docs/scratchpad-hygiene.md")).toBe(true);
  });

  test("a package README below the root still lints", () => {
    expect(shouldLint("packages/foo/README.md")).toBe(true);
  });

  // The dot in .superpowers is what separates the two. This repository commits
  // docs/superpowers/{plans,specs}/ — plans and specs a person reads — while
  // the SDD workspace it must not be confused with is .superpowers/ at the
  // repo root. A dotless token silences the first along with the second.
  test("docs/superpowers/ plans still lint", () => {
    expect(shouldLint("docs/superpowers/plans/2026-09-03-account-layer-portability.md")).toBe(true);
  });
});

describe("planLint() — graceful degradation", () => {
  const docsFile = "docs/STATE.md";

  test("out-of-scope skips before touching config or vale", () => {
    expect(planLint("notes/scratch.md", "/some/.vale.ini", "/usr/bin/vale")).toEqual({
      action: "skip",
      reason: "out-of-scope",
    });
  });

  test("missing config degrades to advisory skip, never blocks", () => {
    expect(planLint(docsFile, null, "/usr/bin/vale")).toEqual({
      action: "skip",
      reason: "no-config",
    });
  });

  test("missing vale binary degrades to advisory skip, never blocks", () => {
    expect(planLint(docsFile, "/some/.vale.ini", null)).toEqual({
      action: "skip",
      reason: "no-vale",
    });
  });

  test("in scope with config and vale present ⇒ run", () => {
    expect(planLint(docsFile, "/some/.vale.ini", "/usr/bin/vale")).toEqual({
      action: "run",
      config: "/some/.vale.ini",
    });
  });
});

describe("resolveValeConfig() — resolution order", () => {
  test("returns null when no candidate exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "prose-noconfig-"));
    try {
      expect(resolveValeConfig({}, empty, empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("explicit PROSE_LINT_VALE_CONFIG wins over the filesystem fallbacks", () => {
    const dir = mkdtempSync(join(tmpdir(), "prose-envconfig-"));
    const cfg = join(dir, "custom.vale.ini");
    writeFileSync(cfg, "StylesPath = styles\n");
    try {
      expect(resolveValeConfig({ PROSE_LINT_VALE_CONFIG: cfg }, dir, dir)).toBe(cfg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a set-but-nonexistent env override falls through, not returned blindly", () => {
    const empty = mkdtempSync(join(tmpdir(), "prose-badenv-"));
    try {
      expect(
        resolveValeConfig({ PROSE_LINT_VALE_CONFIG: join(empty, "nope.ini") }, empty, empty),
      ).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// writing-style.md row 5 names three mechanisms for one exemption — this hook
// on write, core/claude/hooks/pre-commit on commit, and the account layer's
// Lint-DocumentProse.ps1 — and states that a change to one is a change to the
// others. Nothing checked that: the segment set is prose in a rules file and
// three unrelated literal lists in code. Backlog items 17 and 22 are the same
// missing segment reported twice, weeks apart, which is what an unenforced
// contract looks like.
//
// It sits in this file rather than a fourth test file so the whole prose-lint
// exemption is asserted in one place.
//
// Rejected as the simpler alternative: asserting each segment NAME appears
// somewhere in each file. All three files name every segment in their own
// comments, so that version stays green against a mechanism whose matcher was
// deleted and only the comment survived. These assertions run against parsed
// matcher forms, which no comment can satisfy.
const AGENT_TRAFFIC_SEGMENTS = [
  "memory",
  "handoffs",
  "scratchpad",
  ".scratch",
  ".superpowers",
  "council-transcripts",
  ".claude",
];

const REPO_ROOT = join(import.meta.dir, "..");

/** Text between `open` and the first `close` after it. Throws rather than
 * returning "" when either is absent, so a renamed list fails loudly instead of
 * silently emptying every assertion below. */
function region(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  if (start < 0) throw new Error(`region opener not found: ${JSON.stringify(open)}`);
  const end = text.indexOf(close, start + open.length);
  if (end < 0) throw new Error(`region closer not found: ${JSON.stringify(close)}`);
  return text.slice(start + open.length, end);
}

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), "utf8");
}

/** The regex SOURCES in lint-doc-prose.ts's SKIP_PATHS, e.g. "(^|\\/)memory\\/".
 * Comment-only lines fail the trailing "/i," and drop out. */
function tsSkipSources(): string[] {
  const body = region(
    readRepoFile("core", "claude", "hooks", "lint-doc-prose.ts"),
    "const SKIP_PATHS = [",
    "\n];",
  );
  return body
    .split(/\r?\n/)
    .map((line) => /^\/(.+)\/i,(?:\s*\/\/.*)?$/.exec(line.trim())?.[1])
    .filter((src): src is string => typeof src === "string");
}

/** Every glob in pre-commit's is_internal_traffic() case arms, split on "|". */
function preCommitArms(): string[] {
  const body = region(
    readRepoFile("core", "claude", "hooks", "pre-commit"),
    "is_internal_traffic() {",
    "\n}",
  );
  const arms: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*(\S.*?)\)\s*return 0\s*;;\s*$/.exec(line);
    if (match) arms.push(...match[1].split("|").map((a) => a.trim()));
  }
  return arms;
}

/** The quoted tokens in the account hook's $skip array, e.g. "/memory/". */
function accountSkipTokens(): string[] {
  const body = region(
    readRepoFile("account", "claude", "hooks", "Lint-DocumentProse.ps1"),
    "$skip = @(",
    "\n)",
  );
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

// Each mechanism carries entries beyond the shared seven, and writing-style.md
// row 5 says why: docs/assets/ is generated and belongs only to the hook that
// fires on every write, and the account hook's four are this machine's vault
// mirror plus housekeeping trees a project has no equivalent of. Deliberate, so
// they are declared here rather than filtered out — an extra that disappears
// from its mechanism reddens too.
const TS_EXTRAS = ["docs/assets"];
const PRE_COMMIT_EXTRAS: string[] = [];
const ACCOUNT_EXTRAS = ["obsidian vault/claude code", "node_modules", ".git", ".obsidian"];

// The only lookahead any SKIP_PATHS entry is allowed to carry. A worktree
// checkout under .claude/ is a real repo, not agent traffic (see "a worktree
// checkout is not internal traffic" above); every other segment is agent
// traffic all the way down and narrowing it needs the same scrutiny, not a
// silent regex edit that this suite's segment-name comparison cannot see.
const TS_EXPECTED_LOOKAHEAD_TAILS = ["(?!worktrees\\/)"];

/** A SKIP_PATHS regex source reduced to the segment it matches:
 * "(^|\\/)\\.claude\\/(?!worktrees\\/)" ⇒ ".claude". The worktree lookahead is
 * dropped on purpose — it is behaviour, and the four worktree cases above pin
 * it directly. Throws on an entry that is not separator-anchored rather than
 * inventing a segment name for it. What this drops is not unchecked: any
 * "(?..." tail is asserted separately below by tsLookaheadTail(), so a
 * lookahead added to a DIFFERENT entry (one with no dedicated behavioural
 * test of its own) still shows up as a set-membership change instead of
 * disappearing into this truncation. */
function tsSegment(src: string): string {
  const anchor = "(^|\\/)";
  if (!src.startsWith(anchor)) {
    throw new Error(`SKIP_PATHS entry is not separator-anchored: /${src}/`);
  }
  return src
    .slice(anchor.length)
    .split("(?")[0]
    .replace(/\\([./])/g, "$1")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Whatever tsSegment() truncated off a SKIP_PATHS entry — the "(?..." tail,
 * or null when the entry carries none. A narrowing lookahead on any entry,
 * not only .claude, has to appear somewhere or it is invisible to every test
 * in this file; this is where it appears. */
function tsLookaheadTail(src: string): string | null {
  const idx = src.indexOf("(?");
  return idx < 0 ? null : src.slice(idx);
}

/** pre-commit's arms reduced to segments, kept as two sets because the root
 * arm (".claude/*") and the nested arm ("*​/.claude/*") are separate globs and
 * a segment carried by only one of them is half a matcher. */
function preCommitSegments(): { root: string[]; nested: string[] } {
  const root: string[] = [];
  const nested: string[] = [];
  for (const arm of preCommitArms()) {
    const asNested = /^\*\/(.+)\/\*$/.exec(arm);
    if (asNested) {
      nested.push(asNested[1].toLowerCase());
      continue;
    }
    const asRoot = /^([^*]+)\/\*$/.exec(arm);
    if (asRoot) {
      root.push(asRoot[1].toLowerCase());
      continue;
    }
    throw new Error(`pre-commit arm is neither a root nor a nested segment glob: ${arm}`);
  }
  return { root, nested };
}

/** A $skip token reduced to its segment: "/memory/" ⇒ "memory". Throws on a
 * token that is not separator-wrapped, which would be a substring match. */
function accountSegment(token: string): string {
  if (!token.startsWith("/") || !token.endsWith("/") || token.length < 3) {
    throw new Error(`$skip entry is not separator-wrapped: ${JSON.stringify(token)}`);
  }
  return token.slice(1, -1).toLowerCase();
}

const sorted = (xs: string[]): string[] => [...xs].sort();

/** The whole set one mechanism is allowed to carry: the shared seven plus its
 * own declared extras, and nothing else. */
const expectedSegments = (extras: string[]): string[] =>
  sorted([...AGENT_TRAFFIC_SEGMENTS, ...extras]);

// A parser that silently returned [] would make every case below pass
// vacuously, so none of them is written to tolerate one: region() throws when
// its anchor is gone, .some() over an empty array is false, and toContain on an
// empty array fails. A separate "the lists parsed to something" case was
// written and cut — no ablation reddens it without reddening these too, which
// makes it padding rather than a guard.
describe("prose-lint exemption — the three mechanisms carry one segment set", () => {
  test.each(AGENT_TRAFFIC_SEGMENTS)("lint-doc-prose.ts matches %s/ as a segment", (segment) => {
    const wanted = `(^|\\/)${segment.replace(/\./g, "\\.")}\\/`;
    expect(tsSkipSources().some((src) => src.startsWith(wanted))).toBe(true);
  });

  test.each(AGENT_TRAFFIC_SEGMENTS)("pre-commit matches %s/ at root and nested", (segment) => {
    const arms = preCommitArms();
    expect(arms).toContain(`${segment}/*`);
    expect(arms).toContain(`*/${segment}/*`);
  });

  test.each(AGENT_TRAFFIC_SEGMENTS)("Lint-DocumentProse.ps1 skips /%s/", (segment) => {
    expect(accountSkipTokens()).toContain(`/${segment}/`);
  });
});

// The 21 cases above are a one-directional subset check: they prove each of the
// seven segments is present in all three mechanisms and say nothing about what
// else is. Inserting /(^|\/)\.newtraffic\//i, into SKIP_PATHS alone, touching
// neither pre-commit nor the account hook, left the suite green — which is the
// same shape as items 17 and 22, a segment in some mechanisms and absent from
// another. So the subset check cannot fail on the drift it exists to stop.
//
// The four cases below compare each mechanism's WHOLE parsed list (plus, for
// the TS hook, its lookahead tails) against one expected set, so an addition
// to one mechanism reddens as loudly as a removal from it. That is what makes
// "a change to one is a change to the others" enforceable in both directions.
//
// Rejected as the simpler alternative: filtering each list down to the seven
// before comparing. That is the subset check, and it is what failed. Also
// rejected: one flat union set shared by all three, which would demand
// docs/assets/ in pre-commit and the vault token in a project hook — the
// opposite of what writing-style.md says about each.
//
// Non-vacuity comes from comparing against the hard-coded segment list rather
// than against another mechanism: a normaliser that collapsed every entry to ""
// yields a one-element set, never the seven named above, so a broken parser or
// normaliser fails here instead of making all three agree on nothing.
//
// tsSegment() throws away everything after "(?", which means a narrowing
// lookahead is invisible to the comparison above regardless of which of the
// seven entries carries it. .claude/'s worktree lookahead happens to be pinned
// anyway, by the four behavioural shouldLint() cases earlier in this file —
// but that is specific to .claude, not a property of the segment-set check.
// Measured: changing memory/'s SKIP_PATHS entry from /(^|\/)memory\// to
// /(^|\/)memory\/(?!important\/)/ — a real behaviour change, memory/important/
// would start linting — left every case above green. The lookahead-tail test
// below is what catches it, on any entry, by asserting the truncated part
// against a declared set the same way TS_EXTRAS declares docs/assets.
describe("prose-lint exemption — no mechanism carries an undeclared segment", () => {
  test("lint-doc-prose.ts carries the seven and docs/assets, nothing else", () => {
    expect(sorted(tsSkipSources().map(tsSegment))).toEqual(expectedSegments(TS_EXTRAS));
  });

  test("lint-doc-prose.ts carries exactly the declared lookahead, nothing else", () => {
    const tails = tsSkipSources()
      .map(tsLookaheadTail)
      .filter((t): t is string => t !== null);
    expect(sorted(tails)).toEqual(sorted(TS_EXPECTED_LOOKAHEAD_TAILS));
  });

  test("pre-commit carries the seven at root and nested, nothing else", () => {
    const { root, nested } = preCommitSegments();
    expect(sorted(root)).toEqual(expectedSegments(PRE_COMMIT_EXTRAS));
    expect(sorted(nested)).toEqual(expectedSegments(PRE_COMMIT_EXTRAS));
  });

  test("Lint-DocumentProse.ps1 carries the seven and its four extras, nothing else", () => {
    expect(sorted(accountSkipTokens().map(accountSegment))).toEqual(
      expectedSegments(ACCOUNT_EXTRAS),
    );
  });
});
