// Offline tests for the advisory Stop hook (core/claude/hooks/dispatch-audit.ts). Detection is in
// the exported pure auditLastTurn(), which takes already-parsed transcript entries, so these run
// with no spawn and no real transcript file. readTranscript()'s JSONL parsing (blank/malformed
// line tolerance) is covered separately against real temp files, the way pre-commit.test.ts covers
// its own file-reading edge cases apart from any pure-logic tests.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLastTurn, readTranscript, type TranscriptEntry } from "../core/claude/hooks/dispatch-audit";

// --- Fixture builders, matching the real transcript shapes confirmed live in this repo's own
// ~/.claude/projects/<project>/*.jsonl ----------------------------------------------------------

function userPrompt(text: string): TranscriptEntry {
  return { type: "user", message: { role: "user", content: text } };
}

function toolResult(toolUseId: string, content: string): TranscriptEntry {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
    toolUseResult: { content },
  };
}

function assistantToolUse(name: string, id = "toolu_1"): TranscriptEntry {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } };
}

function assistantText(text: string): TranscriptEntry {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("auditLastTurn() — write without dispatch", () => {
  test("Write with no Agent/Task dispatch in the same turn: notes", () => {
    const entries = [userPrompt("fix the typo"), assistantToolUse("Write")];
    const decision = auditLastTurn(entries);
    expect(decision.action).toBe("note");
    if (decision.action === "note") {
      expect(decision.reason).toContain("Write");
      expect(decision.reason).toContain("agent-usage.md");
    }
  });

  test("Edit and NotebookEdit both count as writes, deduped in the reason", () => {
    const entries = [userPrompt("do the work"), assistantToolUse("Edit"), assistantToolUse("Edit"), assistantToolUse("NotebookEdit")];
    const decision = auditLastTurn(entries);
    expect(decision.action).toBe("note");
    if (decision.action === "note") {
      // deduped: the two Edit calls collapse to one "Edit" entry, not "Edit, Edit"
      expect(decision.reason).toContain("Edit, NotebookEdit");
    }
  });

  test("Write preceded by an Agent dispatch in the same turn: silent", () => {
    const entries = [userPrompt("implement the feature"), assistantToolUse("Agent"), assistantToolUse("Write")];
    expect(auditLastTurn(entries)).toEqual({ action: "silent" });
  });

  test("Agent dispatch alone, no direct write: silent", () => {
    const entries = [userPrompt("review this"), assistantToolUse("Agent")];
    expect(auditLastTurn(entries)).toEqual({ action: "silent" });
  });

  test("no write, no dispatch, just reads: silent", () => {
    const entries = [userPrompt("what does this do"), assistantToolUse("Read"), assistantText("here is the answer")];
    expect(auditLastTurn(entries)).toEqual({ action: "silent" });
  });

  test("empty transcript: silent, does not throw", () => {
    expect(auditLastTurn([])).toEqual({ action: "silent" });
  });
});

describe("auditLastTurn() — turn boundary detection", () => {
  test("only the LAST turn is audited: an earlier undispatched write does not leak forward", () => {
    const entries = [
      userPrompt("first task"),
      assistantToolUse("Write"), // undispatched write in turn 1 — must not affect turn 2's verdict
      toolResult("toolu_1", "ok"),
      userPrompt("second task"),
      assistantToolUse("Agent"),
    ];
    expect(auditLastTurn(entries)).toEqual({ action: "silent" });
  });

  test("a tool_result echoed with role \"user\" is not mistaken for a new turn boundary", () => {
    const entries = [
      userPrompt("one task, several tool round-trips"),
      assistantToolUse("Read"),
      toolResult("toolu_1", "file contents"),
      assistantToolUse("Write"), // still inside the SAME turn as the prompt above
    ];
    const decision = auditLastTurn(entries);
    expect(decision.action).toBe("note"); // proves the tool_result above didn't reset turnStart
  });

  test("second real turn with an undispatched write is caught even after a clean first turn", () => {
    const entries = [
      userPrompt("first task"),
      assistantToolUse("Agent"),
      toolResult("toolu_1", "ok"),
      userPrompt("second task"),
      assistantToolUse("Write"),
    ];
    expect(auditLastTurn(entries)).toEqual({
      action: "note",
      reason: expect.stringContaining("Write"),
    });
  });
});

describe("readTranscript() — tolerant JSONL parsing", () => {
  const tempDirs: string[] = [];
  function tempFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-audit-"));
    tempDirs.push(dir);
    const path = join(dir, "transcript.jsonl");
    writeFileSync(path, content);
    return path;
  }

  test("parses well-formed lines in order", () => {
    const path = tempFile('{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant","message":{"content":[]}}\n');
    const entries = readTranscript(path);
    expect(entries.length).toBe(2);
    expect(entries[0].type).toBe("user");
    expect(entries[1].type).toBe("assistant");
  });

  test("skips blank lines", () => {
    const path = tempFile('{"type":"user","message":{"role":"user","content":"hi"}}\n\n\n{"type":"assistant","message":{"content":[]}}\n');
    expect(readTranscript(path).length).toBe(2);
  });

  test("tolerates one malformed/partial trailing line instead of discarding the whole file", () => {
    const path = tempFile('{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant","message":{"conte');
    const entries = readTranscript(path);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("user");
  });

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });
});
