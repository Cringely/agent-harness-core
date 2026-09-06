// Offline tests for readTranscript()'s tolerant JSONL parsing (core/claude/hooks/transcript-utils.ts).
// Moved from test/dispatch-audit.test.ts when dispatch-audit.ts was deleted (#97): this coverage
// is real, non-duplicated I/O testing (mkdtempSync/writeFileSync against real temp files) with no
// equivalent in test/review-gate.test.ts, which only exercises readTranscript indirectly through
// readAllTranscriptEntries() on well-formed fixtures per that file's own header comment.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "../core/claude/hooks/transcript-utils";

describe("readTranscript() — tolerant JSONL parsing", () => {
  const tempDirs: string[] = [];
  function tempFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "transcript-utils-"));
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
