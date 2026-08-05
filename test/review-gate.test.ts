// Offline tests for the review PreToolUse gate (core/claude/hooks/review-gate.ts). The pure
// policy — decide(), findUnreviewedFiles(), parseGitCommitInvocation(), scrubQuotesAndHeredocs() —
// is exercised with fabricated command strings and transcript arrays, no process spawn, no git,
// no filesystem. getStagedAbsPaths() and readAllTranscriptEntries(), the real-I/O edges, are
// exercised separately against real temp git repositories and real temp transcript directory
// trees, matching how test/agent-worktree-gate.test.ts covers its own I/O edge
// (requiresIsolation() reading real temp agent-definition files) instead of mocking fs.
//
// Any extraction under comparison (an unreviewed-files list, a staged-paths list, a merged
// transcript) is asserted non-empty before its contents are checked, per this task's brief: a
// check against an empty extraction is indistinguishable from a check that always passes.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decide,
  findUnreviewedFiles,
  getStagedAbsPaths,
  OVERRIDE_TOKEN,
  parseGitCommitInvocation,
  readAllTranscriptEntries,
  REVIEW_ALLOWLIST,
  scrubQuotesAndHeredocs,
} from "../core/claude/hooks/review-gate";
import type { TranscriptEntry } from "../core/claude/hooks/dispatch-audit";

// --- Fixture helpers for building transcript entries in the real shape --------------------------

function write(filePath: string): TranscriptEntry {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }] },
  };
}

function edit(filePath: string): TranscriptEntry {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: filePath } }] },
  };
}

function notebookEdit(notebookPath: string): TranscriptEntry {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: notebookPath } }],
    },
  };
}

function dispatch(subagentType?: string): TranscriptEntry {
  const input: Record<string, unknown> = {};
  if (subagentType !== undefined) input.subagent_type = subagentType;
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Agent", input }] },
  };
}

function userPrompt(text: string): TranscriptEntry {
  return { type: "user", message: { role: "user", content: text } };
}

/** An isMeta:true injected entry shaped like a real one (skill body / agent-message delivery):
 * type "user", string content, no tool_use blocks at all — proves it can't register as an edit or
 * dispatch event regardless of where it sits in the array. */
function metaInjection(text: string): TranscriptEntry {
  return { type: "user", isMeta: true, message: { role: "user", content: text } };
}

/** Attaches a real ISO-8601 timestamp, the field readAllTranscriptEntries() sorts the merge on. */
function withTs(entry: TranscriptEntry, ts: string): TranscriptEntry {
  return { ...entry, timestamp: ts };
}

// --- scrubQuotesAndHeredocs ----------------------------------------------------------------------

describe("scrubQuotesAndHeredocs()", () => {
  test("blanks a single-quoted span, keeps length and surrounding text", () => {
    const result = scrubQuotesAndHeredocs("echo 'git commit' done");
    expect(result).not.toContain("git commit");
    expect(result.length).toBe("echo 'git commit' done".length);
    expect(result.startsWith("echo ")).toBe(true);
    expect(result.trim().endsWith("done")).toBe(true);
  });

  test("blanks a double-quoted span", () => {
    const result = scrubQuotesAndHeredocs('echo "git commit" done');
    expect(result).not.toContain("git commit");
  });

  test("an escaped double quote inside a double-quoted span does not close it early", () => {
    // The literal command text is: echo "say \"git commit\" now" done
    const raw = 'echo "say \\"git commit\\" now" done';
    const result = scrubQuotesAndHeredocs(raw);
    expect(result).not.toContain("git commit");
    expect(result.trim().endsWith("done")).toBe(true);
  });

  test("blanks a heredoc body up to (not past) the delimiter line", () => {
    const raw = "cat <<EOF\ngit commit -m wip\nEOF\necho after";
    const result = scrubQuotesAndHeredocs(raw);
    expect(result).not.toContain("git commit");
    expect(result).toContain("echo after");
  });

  test("a quoted heredoc delimiter (<<'EOF') is still recognized and its body scrubbed", () => {
    const raw = "cat <<'EOF'\ngit commit -m wip\nEOF";
    const result = scrubQuotesAndHeredocs(raw);
    expect(result).not.toContain("git commit");
  });

  test("text on the same line as the heredoc marker, after it, is left untouched", () => {
    const raw = "cat <<EOF | tee git-commit.log\nbody line\nEOF";
    const result = scrubQuotesAndHeredocs(raw);
    expect(result).toContain("tee");
  });

  test("plain unquoted text is unaffected", () => {
    const raw = "git commit -m done";
    expect(scrubQuotesAndHeredocs(raw)).toBe(raw);
  });
});

// --- parseGitCommitInvocation --------------------------------------------------------------------

describe("parseGitCommitInvocation() — the required forms", () => {
  test("bare `git commit`", () => {
    expect(parseGitCommitInvocation("git commit").isCommit).toBe(true);
  });

  test("`git commit` with flags after commit", () => {
    expect(parseGitCommitInvocation("git commit -m 'wip' --amend").isCommit).toBe(true);
  });

  test("`git -C <path> commit` captures the path", () => {
    const result = parseGitCommitInvocation("git -C /tmp/some-repo commit -am 'msg'");
    expect(result.isCommit).toBe(true);
    expect(result.repoPath).toBe("/tmp/some-repo");
  });

  test("flags before commit (--no-pager)", () => {
    expect(parseGitCommitInvocation("git --no-pager commit").isCommit).toBe(true);
  });

  test("git commit chained after another command", () => {
    expect(parseGitCommitInvocation("npm test && git commit -m done").isCommit).toBe(true);
  });

  test("`git -c key=value commit` (a detached -c pair, cheap fix) is recognized", () => {
    expect(parseGitCommitInvocation("git -c user.name=x commit -m done").isCommit).toBe(true);
  });
});

describe("parseGitCommitInvocation() — permissive-but-not-fooled-by-quotes-or-heredocs", () => {
  test("git commit mentioned only inside a quoted echo argument: not a commit", () => {
    expect(parseGitCommitInvocation('echo "you should run git commit later"').isCommit).toBe(false);
  });

  test("git commit mentioned only inside a single-quoted argument: not a commit", () => {
    expect(parseGitCommitInvocation("echo 'remember: git commit when done'").isCommit).toBe(false);
  });

  test("git commit mentioned only inside a heredoc body: not a commit", () => {
    const raw = "cat <<EOF\ngit commit -m wip\nEOF";
    expect(parseGitCommitInvocation(raw).isCommit).toBe(false);
  });

  test("a REAL commit whose message argument itself mentions git commit: still a commit", () => {
    const raw = 'git commit -m "note: run git commit again after this"';
    expect(parseGitCommitInvocation(raw).isCommit).toBe(true);
  });

  test("unrelated git subcommands do not match", () => {
    expect(parseGitCommitInvocation("git status").isCommit).toBe(false);
    expect(parseGitCommitInvocation("git stash pop").isCommit).toBe(false);
  });

  test("a program name merely starting with git does not match (git-commit-wrapper)", () => {
    expect(parseGitCommitInvocation("git-commit-wrapper commit").isCommit).toBe(false);
  });

  test("gitk (word-glued) does not match", () => {
    expect(parseGitCommitInvocation("gitk commit").isCommit).toBe(false);
  });

  test("a plain non-git command does not match", () => {
    expect(parseGitCommitInvocation("ls -la").isCommit).toBe(false);
  });
});

describe("parseGitCommitInvocation() — F-R3-1: --dry-run exemption reverted", () => {
  test("--dry-run on its own is still treated as a real commit (known false deny, accepted)", () => {
    expect(parseGitCommitInvocation("git commit --dry-run -m x").isCommit).toBe(true);
    expect(parseGitCommitInvocation("git commit -m x --dry-run").isCommit).toBe(true);
  });

  // The regression F-R2-8 introduced: GIT_COMMIT_RE.exec() is non-global and stops at the first
  // match, so an exemption keyed off that match's own tail saw --dry-run, decided the WHOLE
  // command was exempt, and never examined the second, real commit. Locks in the revert.
  test("a dry-run commit chained before a real commit is still detected as a commit", () => {
    expect(parseGitCommitInvocation("git commit --dry-run && git commit -m x").isCommit).toBe(true);
    expect(parseGitCommitInvocation("git commit --dry-run; git commit -m x").isCommit).toBe(true);
    expect(parseGitCommitInvocation("git commit --dry-run || git commit -m x").isCommit).toBe(true);
  });
});

// --- findUnreviewedFiles --------------------------------------------------------------------------

describe("findUnreviewedFiles() — pure, fabricated transcripts", () => {
  test("edited then reviewed by an allowlisted type afterward: not flagged", () => {
    const entries = [userPrompt("do work"), edit("/repo/a.ts"), dispatch("code-reviewer")];
    const result = findUnreviewedFiles(["/repo/a.ts"], entries);
    expect(result.unreviewed).toEqual([]);
  });

  test("edited with no dispatch afterward at all: flagged", () => {
    const entries = [userPrompt("do work"), write("/repo/a.ts")];
    const result = findUnreviewedFiles(["/repo/a.ts"], entries);
    expect(result.unreviewed.length).toBeGreaterThan(0);
    expect(result.unreviewed).toEqual(["/repo/a.ts"]);
  });

  test("dispatch happened BEFORE the edit, none after: still flagged (order matters, not just presence)", () => {
    const entries = [dispatch("code-reviewer"), edit("/repo/a.ts")];
    expect(findUnreviewedFiles(["/repo/a.ts"], entries).unreviewed).toEqual(["/repo/a.ts"]);
  });

  test("dispatch after edit but subagent_type not on the allowlist: flagged", () => {
    const entries = [edit("/repo/a.ts"), dispatch("some-random-type")];
    expect(findUnreviewedFiles(["/repo/a.ts"], entries).unreviewed).toEqual(["/repo/a.ts"]);
  });

  test("general-purpose dispatch after edit counts as review (deliberate allowlist inclusion)", () => {
    const entries = [edit("/repo/a.ts"), dispatch("general-purpose")];
    expect(findUnreviewedFiles(["/repo/a.ts"], entries).unreviewed).toEqual([]);
  });

  test("subagent_type omitted on the dispatch defaults to general-purpose and counts", () => {
    const entries = [edit("/repo/a.ts"), dispatch(undefined)];
    expect(findUnreviewedFiles(["/repo/a.ts"], entries).unreviewed).toEqual([]);
  });

  test("subagent_type is matched case-insensitively", () => {
    const entries = [edit("/repo/a.ts"), dispatch("Code-Reviewer")];
    expect(findUnreviewedFiles(["/repo/a.ts"], entries).unreviewed).toEqual([]);
  });

  test("a staged file the transcript never shows edited: lands in noEvidence, not unreviewed", () => {
    const entries = [edit("/repo/a.ts"), dispatch("code-reviewer")];
    const result = findUnreviewedFiles(["/repo/untouched.ts"], entries);
    expect(result.unreviewed).toEqual([]);
    expect(result.noEvidence).toEqual(["/repo/untouched.ts"]);
  });

  test("only the LAST edit to a file matters: a stale early review does not cover a later edit", () => {
    const entries = [edit("/repo/a.ts"), dispatch("code-reviewer"), edit("/repo/a.ts")];
    expect(findUnreviewedFiles(["/repo/a.ts"], entries).unreviewed).toEqual(["/repo/a.ts"]);
  });

  test("NotebookEdit is tracked via notebook_path", () => {
    const entries = [notebookEdit("/repo/nb.ipynb")];
    expect(findUnreviewedFiles(["/repo/nb.ipynb"], entries).unreviewed).toEqual(["/repo/nb.ipynb"]);
    const reviewed = [notebookEdit("/repo/nb.ipynb"), dispatch("code-reviewer")];
    expect(findUnreviewedFiles(["/repo/nb.ipynb"], reviewed).unreviewed).toEqual([]);
  });

  test("multiple staged files: only the unreviewed one is returned", () => {
    const entries = [edit("/repo/a.ts"), dispatch("code-reviewer"), edit("/repo/b.ts")];
    expect(findUnreviewedFiles(["/repo/a.ts", "/repo/b.ts"], entries).unreviewed).toEqual(["/repo/b.ts"]);
  });

  test("an isMeta:true injected entry sitting between the edit and the dispatch does not break ordering", () => {
    const entries = [
      edit("/repo/a.ts"),
      metaInjection("some skill body or agent-message delivery text"),
      dispatch("code-reviewer"),
    ];
    expect(findUnreviewedFiles(["/repo/a.ts"], entries).unreviewed).toEqual([]);
  });

  test("empty transcript: every staged file lands in noEvidence, not unreviewed", () => {
    const result = findUnreviewedFiles(["/repo/a.ts", "/repo/b.ts"], []);
    expect(result.unreviewed).toEqual([]);
    expect(result.noEvidence).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  test("F-R2-5: an isMeta:true entry SHAPED like an assistant Write is still excluded", () => {
    // Doesn't happen in practice today (see the header's ORDERING note — every isMeta entry
    // observed is type:"user"), but the guard at toolUseBlocksIn()'s `if (entry.isMeta === true)
    // return [];` line ablated green with no fixture covering it. This fixture exists so a future
    // refactor that deletes that line breaks a test instead of silently losing the belt-and-braces.
    const weirdEntry: TranscriptEntry = {
      type: "assistant",
      isMeta: true,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Write", input: { file_path: "/repo/a.ts" } }],
      },
    };
    const result = findUnreviewedFiles(["/repo/a.ts"], [weirdEntry]);
    expect(result.unreviewed).toEqual([]);
    expect(result.noEvidence).toEqual(["/repo/a.ts"]); // no edit registered: the guard excluded it
  });

  test("A1: an edit and a qualifying dispatch as two tool_use blocks in the SAME assistant entry: still flagged", () => {
    // This harness runs parallel tool_use blocks in one turn routinely; same index gives no
    // evidence the dispatch actually saw the edited content, so <=  (not <) is required here.
    // See the ablation in this file's own build report for the mutation this test catches.
    const sameEntry: TranscriptEntry = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/repo/a.ts" } },
          { type: "tool_use", name: "Agent", input: { subagent_type: "code-reviewer" } },
        ],
      },
    };
    expect(findUnreviewedFiles(["/repo/a.ts"], [sameEntry]).unreviewed).toEqual(["/repo/a.ts"]);
  });
});

// --- decide() — the full pure policy ---------------------------------------------------------------

describe("decide() — not a commit: always allows regardless of staged/transcript state", () => {
  test("a non-git command allows even with unreviewed staged files", () => {
    const entries = [write("/repo/a.ts")];
    expect(decide("npm test", ["/repo/a.ts"], entries)).toEqual({ action: "allow" });
  });
});

describe("decide() — a commit with no staged files allows", () => {
  test("empty staged list allows without consulting the transcript", () => {
    expect(decide("git commit -m x", [], [])).toEqual({ action: "allow" });
  });
});

describe("decide() — deny path", () => {
  test("staged file with no qualifying review: denied, names the file", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide("git commit -m x", ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason.length).toBeGreaterThan(0);
      expect(verdict.reason).toContain("/repo/a.ts");
      expect(verdict.reason).toContain(OVERRIDE_TOKEN);
    }
  });

  test("deny message caps the named files at five and notes the remainder", () => {
    const files = Array.from({ length: 7 }, (_, i) => `/repo/f${i}.ts`);
    const entries = files.map((f) => write(f));
    const verdict = decide("git commit -m x", files, entries);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      for (const f of files.slice(0, 5)) expect(verdict.reason).toContain(f);
      expect(verdict.reason).toContain("+2 more");
    }
  });
});

describe("decide() — allow path once reviewed", () => {
  test("staged file reviewed after its last edit: allowed", () => {
    const entries = [write("/repo/a.ts"), dispatch("adversarial-reviewer")];
    expect(decide("git commit -m x", ["/repo/a.ts"], entries)).toEqual({ action: "allow" });
  });
});

describe("decide() — REVIEW_OVERRIDE escape hatch", () => {
  test("a reasoned override allows even with an unreviewed staged file, and echoes the reason", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide(
      `git commit -m "wip" ${OVERRIDE_TOKEN}skipping-for-hotfix`,
      ["/repo/a.ts"],
      entries,
    );
    expect(verdict.action).toBe("allow");
    if (verdict.action === "allow") {
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason as string).toContain("skipping-for-hotfix");
    }
  });

  test("a bare override token with no value does not bypass: falls through to the deny logic", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide(`git commit -m "wip" ${OVERRIDE_TOKEN}`, ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("deny");
  });

  test("FIX 3: the token appearing only inside the commit message's own quoted argument does not bypass", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide(
      `git commit -m "docs: describe the ${OVERRIDE_TOKEN}<reason> escape hatch"`,
      ["/repo/a.ts"],
      entries,
    );
    expect(verdict.action).toBe("deny"); // the unreviewed file is still denied, not bypassed
  });

  test("FIX 3 contrast: the same token OUTSIDE any quotes still bypasses", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide(
      `git commit -m "docs change" ${OVERRIDE_TOKEN}legit-reason`,
      ["/repo/a.ts"],
      entries,
    );
    expect(verdict.action).toBe("allow");
  });

  test("F-R2-1 MUST-fix: a single-quoted multi-word reason bypasses and the reason is captured whole", () => {
    // The exact regression: matching the reason against the SCRUBBED text (which blanks quoted
    // spans) denied this, even though the token itself is correctly outside any quotes.
    const entries = [write("/repo/a.ts")];
    const verdict = decide(`git commit -m x ${OVERRIDE_TOKEN}'prod outage'`, ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("allow");
    if (verdict.action === "allow") {
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason as string).toContain("prod outage");
    }
  });

  test("F-R2-1: a double-quoted multi-word reason bypasses and is captured whole", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide(`git commit -m x ${OVERRIDE_TOKEN}"prod outage"`, ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("allow");
    if (verdict.action === "allow") {
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason as string).toContain("prod outage");
    }
  });

  test("F-R2-1: an unterminated quote falls back to reading an unquoted token rather than failing closed", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide(`git commit -m x ${OVERRIDE_TOKEN}'unterminated`, ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("allow");
  });
});

describe("decide() — FIX 4: announced blind spots, not silent passes", () => {
  test("no transcript evidence at all (empty entries) with staged files: allows, names the blind spot and the files", () => {
    const verdict = decide("git commit -m x", ["/repo/a.ts"], []);
    expect(verdict.action).toBe("allow");
    if (verdict.action === "allow") {
      expect(verdict.reason).toBeDefined();
      expect((verdict.reason as string).length).toBeGreaterThan(0);
      expect(verdict.reason).toContain("/repo/a.ts");
    }
  });

  test("a staged file with no edit evidence anywhere in a non-empty transcript: allows, names the file", () => {
    const entries = [edit("/repo/other.ts")]; // real evidence exists, just not for a.ts
    const verdict = decide("git commit -m x", ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("allow");
    if (verdict.action === "allow") {
      expect(verdict.reason).toBeDefined();
      expect((verdict.reason as string).length).toBeGreaterThan(0);
      expect(verdict.reason).toContain("/repo/a.ts");
    }
  });

  test("mixed staged set: an unreviewed file denies even alongside a no-evidence file", () => {
    const entries = [write("/repo/a.ts")]; // a.ts edited with no review; b.ts never mentioned at all
    const verdict = decide("git commit -m x", ["/repo/a.ts", "/repo/b.ts"], entries);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain("/repo/a.ts");
  });

  test("F-R2-3: a nonzero unreadableSubagentCount is folded into the no-evidence message", () => {
    const entries = [edit("/repo/other.ts")]; // real evidence exists, just not for a.ts
    const verdict = decide("git commit -m x", ["/repo/a.ts"], entries, 2);
    expect(verdict.action).toBe("allow");
    if (verdict.action === "allow") {
      expect(verdict.reason).toBeDefined();
      expect(verdict.reason as string).toContain("2");
      expect(verdict.reason as string).toMatch(/unreadable|empty/);
    }
  });

  test("unreadableSubagentCount omitted (default 0): no such note appears", () => {
    const entries = [edit("/repo/other.ts")];
    const verdict = decide("git commit -m x", ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("allow");
    if (verdict.action === "allow") expect(verdict.reason as string).not.toMatch(/unreadable/);
  });
});

describe("decide() — F-R3-1: --dry-run exemption reverted, no bypass via a chained dry-run", () => {
  test("a bare --dry-run commit still denies if unreviewed (known false deny, accepted)", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide("git commit --dry-run -m x", ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("deny");
  });

  // The exact shape of the regression F-R2-8 introduced: a dry-run commit chained ahead of a real
  // one used to allow unreviewed, because the (non-global) match on the dry-run invocation alone
  // decided the whole line was exempt and the real commit after it was never examined.
  test("a dry-run commit chained before a real, unreviewed commit still denies", () => {
    const entries = [write("/repo/a.ts")];
    const verdict = decide("git commit --dry-run && git commit -m x", ["/repo/a.ts"], entries);
    expect(verdict.action).toBe("deny");
  });
});

// --- REVIEW_ALLOWLIST sanity ------------------------------------------------------------------------

describe("REVIEW_ALLOWLIST", () => {
  test("contains the roles named in the brief", () => {
    for (const type of [
      "task-reviewer",
      "adversarial-reviewer",
      "code-reviewer",
      "feature-dev:code-reviewer",
      "caveman:cavecrew-reviewer",
      "appsec-sme",
      "governance-sme",
      "general-purpose",
    ]) {
      expect(REVIEW_ALLOWLIST.has(type)).toBe(true);
    }
  });
});

// --- getStagedAbsPaths() — the one git-only I/O edge, against real temp git repos -------------------

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "existing.txt"), "seed\n");
  execFileSync("git", ["add", "existing.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("getStagedAbsPaths() — real git, real temp repo", () => {
  test("no staged changes: empty array", () => {
    const dir = initRepo();
    try {
      expect(getStagedAbsPaths(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a newly staged file resolves to its absolute path under the repo root", () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "new-file.txt"), "content\n");
      execFileSync("git", ["add", "new-file.txt"], { cwd: dir });
      const result = getStagedAbsPaths(dir);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toEqual([join(dir, "new-file.txt")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run from a subdirectory: paths still resolve against the real repo top level", () => {
    const dir = initRepo();
    try {
      const subdir = join(dir, "sub");
      mkdirSync(subdir);
      writeFileSync(join(subdir, "nested.txt"), "content\n");
      execFileSync("git", ["add", "sub/nested.txt"], { cwd: dir });
      const result = getStagedAbsPaths(subdir);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toEqual([join(dir, "sub", "nested.txt")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cheap fix: a non-ASCII filename round-trips as the real name, not a C-quoted octal escape", () => {
    const dir = initRepo();
    try {
      const filename = "café.ts";
      writeFileSync(join(dir, filename), "content\n");
      execFileSync("git", ["add", filename], { cwd: dir });
      const result = getStagedAbsPaths(dir);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toEqual([join(dir, filename)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- readAllTranscriptEntries() — FIX 1, real temp parent+subagents directory trees -----------------

describe("readAllTranscriptEntries() — merges parent and subagent transcripts, ordered by timestamp", () => {
  test("no subagents/ directory at all: returns just the parent entries, silently, count 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.jsonl");
      const parentEntries = [
        withTs(userPrompt("hi"), "2026-08-05T00:00:00.000Z"),
        withTs(write("/repo/a.ts"), "2026-08-05T00:00:01.000Z"),
      ];
      writeFileSync(parentPath, parentEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBe(2);
      expect(result.unreadableSubagentCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F-R2-6, verified not assumed: a transcriptPath not ending in .jsonl degrades to parent-only, no throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      // basename(path, ".jsonl") only strips the suffix when present, so a non-.jsonl path leaves
      // it on, the derived subagentsDir then names something that can't exist, and existsSync
      // correctly returns false — parent-only, exactly like the no-subagents-dir case above.
      const parentPath = join(dir, "session.transcript"); // deliberately wrong extension
      writeFileSync(parentPath, JSON.stringify(withTs(userPrompt("hi"), "2026-08-05T00:00:00.000Z")) + "\n");
      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBe(1);
      expect(result.unreadableSubagentCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F-R3-3: the test above doesn't discriminate — "degrades to parent-only" holds for ANY
  // non-existent subagentsDir, however its name is computed, so a build that strips the
  // extension unconditionally (giving "session" instead of "session.transcript" as the stem)
  // would pass it too. This one plants a subagents/ dir at the WRONG-build location and asserts
  // its content is NOT merged, which only the correct basename(path, ".jsonl") computation gets
  // right — a build stripping ".transcript" would read this directory and merge the extra entry.
  test("F-R3-3: a subagents/ dir at the wrong-build path (extension stripped) is not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.transcript");
      writeFileSync(parentPath, JSON.stringify(withTs(userPrompt("hi"), "2026-08-05T00:00:00.000Z")) + "\n");
      // A build that computed the stem as "session" (extension stripped unconditionally) would
      // look here. The correct build looks at "session.transcript/subagents" instead, which
      // doesn't exist, so this directory's content must not show up in the result.
      const wrongBuildSubagentsDir = join(dir, "session", "subagents");
      mkdirSync(wrongBuildSubagentsDir, { recursive: true });
      writeFileSync(
        join(wrongBuildSubagentsDir, "agent.jsonl"),
        JSON.stringify(withTs(write("/repo/a.ts"), "2026-08-05T00:00:01.000Z")) + "\n",
      );
      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F-R3-3: the case-insensitivity claim was previously only exercised inside the interleaving
  // test below, under an uppercase filename chosen to "also" prove the point — so a mutation that
  // broke only case-sensitivity would fail a test named for timestamp ordering, sending a
  // maintainer to the wrong place. Standalone, so the failure and the name line up.
  test("F-R3-3: the .jsonl filter is case-insensitive on its own, not just incidentally in the interleaving test", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.jsonl");
      const subagentsDir = join(dir, "session", "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(parentPath, JSON.stringify(withTs(userPrompt("hi"), "2026-08-05T00:00:00.000Z")) + "\n");
      writeFileSync(
        join(subagentsDir, "agent-a1.JSONL"),
        JSON.stringify(withTs(write("/repo/a.ts"), "2026-08-05T00:00:01.000Z")) + "\n",
      );
      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a subagent's Write, invisible in the parent alone, is present after merge and correctly interleaved by timestamp (not file-append order)", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.jsonl");
      const subagentsDir = join(dir, "session", "subagents");
      mkdirSync(subagentsDir, { recursive: true });

      // Parent: dispatch a writer (t=01), then LATER dispatch a reviewer (t=04).
      const parentEntries = [
        withTs(userPrompt("dispatch a writer, then review it"), "2026-08-05T00:00:00.000Z"),
        withTs(dispatch("general-purpose"), "2026-08-05T00:00:01.000Z"),
        withTs(dispatch("code-reviewer"), "2026-08-05T00:00:04.000Z"),
      ];
      writeFileSync(parentPath, parentEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");

      // Subagent's own Write happens at t=02.5 — chronologically BETWEEN the two parent
      // dispatches, but its file is appended to the directory AFTER the parent file exists.
      // If the merge just concatenated (parent entries, then subagent entries) instead of
      // sorting by timestamp, this write would land at the END of the array, after the review
      // dispatch, and read as reviewed-before-edited — wrong. The .meta.json sidecar next to it
      // must not be parsed as a transcript line. Uppercase extension on this one, to prove the
      // filter is case-insensitive (F-R2-6 nit).
      const targetPath = join(dir, "target.ts");
      writeFileSync(
        join(subagentsDir, "agent-a1.JSONL"),
        JSON.stringify(withTs(write(targetPath), "2026-08-05T00:00:02.500Z")) + "\n",
      );
      writeFileSync(join(subagentsDir, "agent-a1.meta.json"), JSON.stringify({ note: "sidecar, must be skipped" }));

      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBe(4);
      expect(result.unreadableSubagentCount).toBe(0);

      // Structural check: the merge is sorted by timestamp, not just concatenated.
      const timestamps = result.entries.map((e) => e.timestamp as string);
      expect(timestamps).toEqual([...timestamps].sort());

      // Behavioral check: the subagent's write is correctly ordered before the later review
      // dispatch, so findUnreviewedFiles() finds it reviewed.
      const findings = findUnreviewedFiles([targetPath], result.entries);
      expect(findings.unreviewed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F-R2-4a: an entry with no timestamp sorts LAST, not first (fails conservative)", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.jsonl");
      // No withTs() on the edit: it has NO timestamp field at all. If it sorted first (the old,
      // rejected behavior), it would read as edited-before-everything and therefore "reviewed" by
      // the timestamped dispatch that follows it in array terms. Sorting it last instead means
      // nothing can appear "after" it, so it correctly reads as unreviewed.
      const untimestampedEdit = write("/repo/a.ts"); // no timestamp
      const timestampedDispatch = withTs(dispatch("code-reviewer"), "2026-08-05T00:00:01.000Z");
      writeFileSync(
        parentPath,
        [JSON.stringify(untimestampedEdit), JSON.stringify(timestampedDispatch)].join("\n") + "\n",
      );
      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBe(2);
      expect(findUnreviewedFiles(["/repo/a.ts"], result.entries).unreviewed).toEqual(["/repo/a.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable subagent file (EISDIR) does not blank out evidence from a sibling subagent file, and is counted", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.jsonl");
      writeFileSync(parentPath, JSON.stringify(withTs(userPrompt("hi"), "2026-08-05T00:00:00.000Z")) + "\n");
      const subagentsDir = join(dir, "session", "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      // A directory named *.jsonl: readFileSync throws EISDIR inside readTranscript().
      mkdirSync(join(subagentsDir, "agent-broken.jsonl"));
      writeFileSync(
        join(subagentsDir, "agent-good.jsonl"),
        JSON.stringify(withTs(write("/repo/a.ts"), "2026-08-05T00:00:01.000Z")) + "\n",
      );
      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.unreadableSubagentCount).toBe(1);
      expect(findUnreviewedFiles(["/repo/a.ts"], result.entries).unreviewed).toEqual(["/repo/a.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F-R2-3: a subagent file that reads fine but parses to zero entries (corrupt content) is counted too", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.jsonl");
      writeFileSync(parentPath, JSON.stringify(withTs(userPrompt("hi"), "2026-08-05T00:00:00.000Z")) + "\n");
      const subagentsDir = join(dir, "session", "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      // Readable as a file, but every line fails JSON.parse — readTranscript() tolerates this and
      // returns [] without throwing, so it would otherwise vanish with zero signal.
      writeFileSync(join(subagentsDir, "agent-corrupt.jsonl"), "not json at all\n{{{also not json\n");
      const result = readAllTranscriptEntries(parentPath);
      expect(result.unreadableSubagentCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F-R2-2: an unreadable subagents/ DIRECTORY (not a file inside it) degrades to parent-only, does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-tree-"));
    try {
      const parentPath = join(dir, "session.jsonl");
      writeFileSync(parentPath, JSON.stringify(withTs(userPrompt("hi"), "2026-08-05T00:00:00.000Z")) + "\n");
      // subagentsDir path exists (existsSync sees it) but is a FILE, not a directory: readdirSync
      // throws ENOTDIR. Before F-R2-2 this propagated out of readAllTranscriptEntries entirely.
      mkdirSync(join(dir, "session"));
      writeFileSync(join(dir, "session", "subagents"), "not a directory");
      expect(() => readAllTranscriptEntries(parentPath)).not.toThrow();
      const result = readAllTranscriptEntries(parentPath);
      expect(result.entries.length).toBe(1);
      // F-R3-2: an unlistable directory is counted too, not just an unreadable file inside one —
      // otherwise the noEvidence message says "nothing happened here" for "couldn't check".
      expect(result.unreadableSubagentCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- End-to-end: real git repo + real temp transcript tree + pure decide() -------------------------

function writeTranscript(entries: TranscriptEntry[]): string {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-transcript-"));
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

describe("end to end — real staged file, real transcript file, pure decide()", () => {
  test("an edited-but-unreviewed staged file denies the whole pipeline", () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "changed.txt"), "v2\n");
      execFileSync("git", ["add", "changed.txt"], { cwd: dir });
      const stagedAbsPaths = getStagedAbsPaths(dir);
      expect(stagedAbsPaths.length).toBeGreaterThan(0);

      const transcriptPath = writeTranscript([write(join(dir, "changed.txt"))]);
      const { entries } = readAllTranscriptEntries(transcriptPath);
      expect(entries.length).toBeGreaterThan(0);

      const verdict = decide("git commit -m update", stagedAbsPaths, entries);
      expect(verdict.action).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same staged file, reviewed after its edit in the transcript, allows", () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "changed.txt"), "v2\n");
      execFileSync("git", ["add", "changed.txt"], { cwd: dir });
      const stagedAbsPaths = getStagedAbsPaths(dir);
      expect(stagedAbsPaths.length).toBeGreaterThan(0);

      const transcriptPath = writeTranscript([write(join(dir, "changed.txt")), dispatch("code-reviewer")]);
      const { entries } = readAllTranscriptEntries(transcriptPath);
      expect(entries.length).toBeGreaterThan(0);

      const verdict = decide("git commit -m update", stagedAbsPaths, entries);
      expect(verdict).toEqual({ action: "allow" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
