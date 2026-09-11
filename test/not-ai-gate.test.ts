// Coverage for account/claude/tools/not-ai/not_ai_core/gate.py's sentence segmentation
// (issue #122, item 1). The vendoring commit shipped the tool without upstream's tests/
// directory, so nothing guarded this at all before now.
//
// Measured defect: SENTENCE_RE splits on `[.!?]` followed by whitespace and an uppercase
// letter or quote, applied to the WHOLE document after collapsing all whitespace to single
// spaces. A markdown heading has no terminal punctuation, so it glues onto the paragraph
// under it; a `|`-delimited table row never terminates either; a list item without a
// trailing period glues onto its neighbour or the paragraph after the list. Each glue point
// merges several real sentences into one enormous one, which is how this repository's own
// docs measured at 38.6 words/sentence against a 28-32 plain-prose comparison range.
//
// Every fixture here was run against gate.py by hand first (both before and after the fix)
// to confirm the exact counts asserted below; see the fix's commit for the ablation log.
// This shells out to the exported payload (`account/claude/tools/not-ai/`), the copy CI and
// every installed machine actually run, not the account-layer source outside the repo.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "..", "account", "claude", "tools", "not-ai", "gate.py");

// ubuntu-24.04 (the bun-test CI runner) ships python3 but not necessarily a bare `python`;
// this workstation has both. Prefer python3 to match the Linux runner and the skill's own
// invocation convention, fall back to python for a Windows-only PATH.
//
// A missing interpreter used to `throw` here, failing the whole run instead of skipping it --
// inconsistent with every sibling test file that drives a real external process (lint-doc-
// prose.test.ts, memory-transition-log.test.ts, session-start-drift-check.test.ts), which all
// resolve the binary once at module scope and gate each case with `test.skipIf(!found)` (issue
// #123e). PYTHON is nullable now; every case below is skipIf-gated on it instead.
const PYTHON = Bun.which("python3") ?? Bun.which("python");

const fixturesDir = mkdtempSync(join(tmpdir(), "not-ai-gate-"));

afterAll(() => {
  rmSync(fixturesDir, { recursive: true, force: true });
});

/** Writes `content` to a fixture file and runs the gate against it with --genre technical --json. */
function runGate(name: string, content: string) {
  const path = join(fixturesDir, name);
  writeFileSync(path, content);
  const proc = Bun.spawnSync({
    cmd: [PYTHON as string, GATE, path, "--genre", "technical", "--json"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = proc.stderr.toString();
  // exitCode 1 is a normal "gate failed" result (e.g. an error-severity finding); only a
  // Python traceback on stderr means the segmenter itself broke.
  expect(stderr).toBe("");
  return { exitCode: proc.exitCode, json: JSON.parse(proc.stdout.toString()) };
}

describe("not-ai gate — markdown-aware sentence segmentation", () => {
  test.skipIf(!PYTHON)("fenced code contributes no sentences", () => {
    // Old behaviour: no `.!?` + capital/quote break exists anywhere (the fence markers and
    // the periods inside the shell string never satisfy the lookahead), so the whole file
    // glues into one 34-word "sentence", flagged long_over_30. Fixed: the fence is dropped
    // entirely, leaving exactly the two real sentences either side of it.
    const { json } = runGate(
      "fenced-code.md",
      [
        "Intro sentence explains one plan that runs long enough to matter here today.",
        "",
        "```bash",
        'echo "not a sentence. this looks like one too!"',
        "```",
        "",
        "Closing sentence about the plan wraps this example up nicely today.",
        "",
      ].join("\n"),
    );
    expect(json.counts.sentences).toBe(2);
    expect(json.counts.long_over_30).toBe(0);
  });

  test.skipIf(!PYTHON)("headings are excluded entirely, not counted as their own sentence", () => {
    // Decision: a heading is a label, not a sentence -- it carries no subject-verb rhythm
    // for sentence_length_sd/opening_types/etc. to measure, and keeping it as a one-line
    // "sentence" would still misrepresent those stats, just in the opposite direction (many
    // short sentences instead of one long one). So it contributes neither a word nor a
    // sentence, and the two real paragraphs on either side of each heading stay separate.
    const { json } = runGate(
      "headings.md",
      [
        "## A Heading That Describes The Section",
        "",
        "First sentence of the section explains the plan in some useful detail today.",
        "",
        "## Another Heading Right After",
        "",
        "Second sentence continues the explanation with a bit more detail than before.",
        "",
      ].join("\n"),
    );
    expect(json.counts.sentences).toBe(2);
    expect(json.counts.long_over_30).toBe(0);
  });

  test.skipIf(!PYTHON)("list items segment separately from each other and from surrounding prose", () => {
    // Old behaviour: none of the three bullets end in a period-space-capital sequence
    // before the next bullet, so all three glue into one 32-word "sentence". Fixed: each
    // bullet is its own unit, so the short third item (4 words) counts toward
    // short_under_8 instead of being absorbed into a long fused blob.
    //
    // Deliberately no terminal punctuation on any bullet (issue #122 review finding 1):
    // with periods at the end of each item, this test could not fail. Deleting the
    // flush() that starts a new block per list item still left three "sentences", because
    // SENTENCE_RE finds a period-space-capital break at each bullet boundary anyway once
    // the three are joined into one glued block -- the assertion was catching punctuation,
    // not the block boundary its name claims to measure. With no periods, a glued block has
    // no break at all and collapses to one "sentence", so the assertion now depends on
    // _prose_blocks actually starting a new unit per bullet.
    const { json } = runGate(
      "list-items.md",
      [
        "- First item explains one option for handling the situation in some real detail today given context",
        "- Second item explains another option worth considering for handling this same case",
        "- Third item is short",
        "",
      ].join("\n"),
    );
    expect(json.counts.sentences).toBe(3);
    expect(json.counts.short_under_8).toBe(1);
  });

  test.skipIf(!PYTHON)("a continuation line joins the open list item; a de-indented line starts a new one", () => {
    // The wrapped second line is indented to the item's own content column (2 spaces, past
    // "- "), so it is part of the same bullet: one sentence, not two. The unindented line
    // after it is not a continuation, so it starts its own unit.
    // The bullet deliberately carries no terminal punctuation on either physical line, so
    // this also proves the split is structural, not an accidental period-plus-capital match:
    // if the de-indent check were disabled, the whole fixture would glue into one block with
    // no `.!?` anywhere inside it, collapsing to a single sentence instead of two.
    const { json } = runGate(
      "list-continuation.md",
      [
        "- This bullet wraps onto",
        "  a second physical line that belongs to the same list item as this one",
        "A paragraph starts here at zero indent and is not part of the bullet above it.",
        "",
      ].join("\n"),
    );
    expect(json.counts.sentences).toBe(2);
  });

  test.skipIf(!PYTHON)("a table contributes no prose sentences", () => {
    // Old behaviour: the header row, separator row, and two body rows never terminate in
    // `.!?`, so they glue onto the closing sentence, producing one 30-word "sentence" (not
    // >30, so long_over_30 stayed 0 even though the count was wrong). Fixed: the table is
    // dropped as a block once its separator row is recognised, leaving the two real
    // sentences on either side of it.
    const { json } = runGate(
      "table.md",
      [
        "Intro sentence before the table explains what follows in some useful detail.",
        "",
        "| Name | Role |",
        "| --- | --- |",
        "| Alice | Engineer |",
        "| Bob | Manager |",
        "",
        "Closing sentence after the table wraps up the section with some detail.",
        "",
      ].join("\n"),
    );
    expect(json.counts.sentences).toBe(2);
  });

  test.skipIf(!PYTHON)("ordinary prose with abbreviations and decimals does not over-split", () => {
    // Not a markdown-structure case: this guards that per-block splitting still runs the
    // original punctuation regex correctly on a plain paragraph. "3.14" has no space around
    // its period so SENTENCE_RE never sees a candidate break there, and "e.g." is followed
    // by a lowercase word so the capital-letter lookahead never fires either.
    const { json } = runGate(
      "abbrev-decimal.md",
      "The release covers version 3.14 of the tool, e.g. the CLI and the gate script, and it ships on schedule.\n",
    );
    expect(json.counts.sentences).toBe(1);
  });

  test.skipIf(!PYTHON)("whitespace-only input does not divide by zero", () => {
    const { json, exitCode } = runGate("whitespace-only.md", "   \n\n\t\n   ");
    expect(json.word_count).toBe(0);
    expect(json.counts.sentences).toBe(0);
    expect(json.counts.sentence_length_sd).toBe(0.0);
    expect(json.passed).toBe(false); // the pre-existing empty-text finding, unrelated to this fix
    expect(exitCode).toBe(1);
  });

  test.skipIf(!PYTHON)("a document that is all code has zero sentences without crashing", () => {
    // Distinct from the whitespace case: this text is non-blank (evaluate()'s early
    // "Text is empty" guard does not fire), but every line lives inside a fence, so
    // sentences() legitimately returns []. Before this fix no document could ever produce
    // zero sentences -- an unpunctuated blob still counted as exactly one -- so this exact
    // path did not exist to guard until _prose_blocks could exclude everything.
    const { json, exitCode } = runGate(
      "all-code.md",
      ["```bash", 'echo "entirely code, no prose anywhere in this file at all."', "```", ""].join("\n"),
    );
    expect(json.counts.sentences).toBe(0);
    expect(json.counts.sentence_length_sd).toBe(0.0);
    expect(json.word_count).toBeGreaterThan(0); // word_count is unchanged by this fix; see report
    expect(exitCode).toBe(0); // no error-severity finding: non-empty text, no protected terms
  });

  test.skipIf(!PYTHON)("an unterminated fence does not silently discard the prose below it", () => {
    // Review finding 2: a fence with no closing marker used to stay "in_fence" for the
    // rest of _prose_blocks' scan, so every line after it -- including real prose two
    // paragraphs deep -- was dropped with no trace. Measured before this fix: this exact
    // fixture read sentences=1 (only the intro line before the fence), passed=true, exit 0.
    // A tool that silently measures nothing is worse than one that errors, because the
    // caller cannot tell an empty result from a clean one, so a document like this must not
    // pass silently. Fixed: the fence's unclosed remainder is recovered as prose (it was
    // never rendered as code by anything either, having no closing marker), so all three
    // sentences are counted, and an explicit "unterminated-fence" error is still raised
    // because the markdown itself stays malformed until the fence is closed.
    const { json, exitCode } = runGate(
      "unterminated-fence.md",
      [
        "Intro sentence before the stray fence explains what follows in some useful detail.",
        "",
        "```",
        "",
        "First paragraph below the unterminated fence makes one real point in enough detail to matter here today.",
        "",
        "Second paragraph below the unterminated fence makes a second real point in enough detail to matter here today.",
        "",
      ].join("\n"),
    );
    expect(json.counts.sentences).toBe(3);
    expect(json.findings).toContainEqual(
      expect.objectContaining({ rule: "unterminated-fence", severity: "error" }),
    );
    expect(json.passed).toBe(false);
    expect(exitCode).toBe(1);
  });
});
