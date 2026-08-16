// Offline tests for the prose-lint-on-write PostToolUse hook
// (core/claude/hooks/lint-doc-prose.ts). All logic is in the exported pure
// shouldLint()/planLint()/resolveValeConfig(), so these run with no Vale, no
// spawn, no network: editing living-doc prose lints; generated paths and
// non-doc files do not.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
