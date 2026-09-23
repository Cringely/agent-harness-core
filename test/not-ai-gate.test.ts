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

  test.skipIf(!PYTHON)(
    "prose right after a table that happens to contain a pipe is not swallowed as more table",
    () => {
      // Issue #123b. The table-body continuation loop used to keep consuming lines as long as
      // they were non-blank and contained "|" ANYWHERE in the line, rather than matching
      // TABLE_ROW_RE the same way the header row itself is matched (a line that STARTS with
      // "|"). So a real sentence sitting directly under a table, with no blank line between
      // them, that merely mentions a shell pipe got classified as another table row and
      // dropped whole -- measured before this fix: this exact fixture read sentences=0, i.e.
      // every real sentence in the document vanished. Fixed: the continuation loop now stops
      // the moment a line does not itself start with "|", so this prose line correctly starts
      // its own block right after the table's last real row.
      const { json } = runGate(
        "pipe-after-table.md",
        [
          "| Name | Role |",
          "| --- | --- |",
          "| Alice | Engineer |",
          "Use a pipe character here | inside this real sentence about piping commands together.",
          "",
        ].join("\n"),
      );
      expect(json.counts.sentences).toBe(1);
    },
  );

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

  // A whitespace-only fixture used to live here ("does not divide by zero"). Removed per
  // issue #123d: the reviewer found it passed under every mutation tried, and an independent
  // ablation for this fix confirms it -- disabling the blank-line short-circuit in
  // _prose_blocks (the exact branch a whitespace-only document exercises) left every one of
  // its assertions (word_count, sentences, sentence_length_sd, passed, exitCode) unchanged,
  // because evaluate()'s pre-existing "Text is empty" early return, and sentences()'s own
  // `if not normalized: continue` guard, both fire before that mutation could ever surface.
  // Neither guard belongs to the segmentation fix this describe block exists to protect, so
  // the test measured a pre-existing, unrelated code path under a segmentation-fix name. The
  // "all code, zero sentences" case below already covers the real "zero sentences, no crash"
  // path that DOES go through the segmenter, so nothing here needed a replacement rather than
  // a deletion.

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

  test.skipIf(!PYTHON)(
    "a fence nested inside a longer fence of the same character does not close it early",
    () => {
      // Issue #123a. CommonMark: a fence's closing marker needs the same character AND at
      // least as many repeats as the one that opened it. The old check compared only the
      // first character, so a doc whose outer fence uses four backticks around content that
      // shows a plain-backtick fence as a literal example -- three backticks, then more
      // lines, then three backticks again -- closed the outer fence on that first inner
      // triple-backtick line. Everything after leaked out as ordinary markdown: the "code
      // line" read as prose (and its embedded sentence-looking text got counted), the
      // second inner triple-backtick line opened a brand new (bogus) fence, and the real
      // closing four-backtick line closed that bogus fence instead of the real one.
      // Measured before this fix: sentences=3 (the leaked code line split into two
      // "sentences" plus the real closing sentence, with the intro merged into one of
      // them by the broken flush sequence). Fixed: the whole four-backtick block is one
      // continuous fence, so only the two real sentences on either side of it count.
      const { json } = runGate(
        "nested-fence.md",
        [
          "Intro sentence before the fence explains one plan in enough detail to matter today.",
          "",
          "````",
          "Example of a fenced block:",
          "```",
          "some code line looks like a sentence. Really it should not count.",
          "```",
          "End of the nested example.",
          "````",
          "",
          "Closing sentence after the fence wraps up the example nicely today.",
          "",
        ].join("\n"),
      );
      expect(json.counts.sentences).toBe(2);
    },
  );

  test.skipIf(!PYTHON)(
    "a GFM table with no leading pipe on its rows is still recognised as a table",
    () => {
      // Issue #123c. GFM does not require a table row to start with "|" -- "Name | Role"
      // over "--- | ---" is a legal table with no leading pipe anywhere. Header detection
      // required TABLE_ROW_RE (a leading "|") on the header line, so this form fell through
      // to plain text entirely: header, separator and every body row glued into one long
      // pseudo-sentence with no `.!?` break anywhere in it. Measured before this fix:
      // sentences=1 (the whole table plus the closing sentence fused together, since the
      // table itself has no terminal punctuation for SENTENCE_RE to find). Fixed: the
      // separator row is what actually distinguishes a table from prose, so the header no
      // longer needs its own leading pipe, and the table is dropped like the leading-pipe
      // form is, leaving the two real sentences on either side of it.
      const { json } = runGate(
        "table-no-leading-pipe.md",
        [
          "Intro sentence before the table explains what follows in some useful detail.",
          "",
          "Name | Role",
          "--- | ---",
          "Alice | Engineer",
          "Bob | Manager",
          "",
          "Closing sentence after the table wraps up the section with some detail.",
          "",
        ].join("\n"),
      );
      expect(json.counts.sentences).toBe(2);
    },
  );
});

describe("not-ai gate — issue #122, normalized counts", () => {
  test.skipIf(!PYTHON)(
    "max_same_opening reports a proportion of sentences, not a raw count",
    () => {
      // Issue #122 defect 2: max_same_opening was the bare repeated-opening count, which
      // cannot be compared across documents with different sentence totals -- and it was
      // compared that way. Fixture: 5 sentences, 3 of them opening on "This". Measured
      // before this fix: max_same_opening read 3 (the raw count). Fixed: it reads 0.6
      // (3 / 5, the fraction of sentences sharing the most-repeated opening).
      const { json } = runGate(
        "same-opening.md",
        [
          "This report covers three items in some detail today.",
          "This report also covers a fourth item briefly today.",
          "This summary wraps the whole section up quickly today.",
          "That approach differs from the plan outlined earlier today.",
          "Another approach was tried before this one today.",
        ].join(" ") + "\n",
      );
      expect(json.counts.sentences).toBe(5);
      expect(json.counts.opening_types).toBe(3);
      expect(json.counts.max_same_opening).toBe(0.6);
    },
  );

  test.skipIf(!PYTHON)(
    "a possessive 's is not counted as a contraction, but a pronoun's 's is",
    () => {
      // Issue #122 defect 3: CONTRACTION_RE matched ANY "<word>'s", so a possessive noun
      // ("the company's policy") inflated the contraction count the same as a genuine
      // contraction. Fixture carries four real contractions (it's, here's, that's, there's --
      // all in the closed pronoun/function-word set) and three possessives (company's,
      // Alice's, team's). Measured before this fix: contractions read 7 (every 's counted).
      // Fixed: contractions reads 4 -- the three possessives no longer count.
      const { json } = runGate(
        "contraction-vs-possessive.md",
        "It's the company's policy that here's how it works: that's fine, " +
          "and there's no problem with Alice's plan or the team's report.\n",
      );
      expect(json.counts.contractions).toBe(4);
    },
  );

  test.skipIf(!PYTHON)(
    "where's, how's, when's and why's count as contractions",
    () => {
      // Issue #158: CONTRACTION_PRONOUN_S's closed set was
      // it|he|she|that|there|here|what|who|let -- missing the four interrogatives, so each
      // fell through to "not in the set" and was silently treated as a possessive instead of
      // a contraction. Fixture is the exact one from the issue. Measured before this fix:
      // contractions read 0 (all four missed). Fixed: contractions reads 4.
      const { json } = runGate(
        "interrogative-contractions.md",
        "Where's the report? How's it going? When's the call, and why's it late?\n",
      );
      expect(json.counts.contractions).toBe(4);
    },
  );

  test.skipIf(!PYTHON)(
    "a curly apostrophe (U+2019) counts the same as a straight one, across every suffix form",
    () => {
      // Issue #158's third bullet: neither the pre-#134 nor the post-#134 pattern matched a
      // curly apostrophe at all, in any suffix (n't, 're/ve/ll/d/m, or the pronoun/function-
      // word 's set) -- a document written with typographic apostrophes throughout scored
      // zero contractions regardless of how many it actually contained.
      //
      // Built via String.fromCharCode rather than a literal character or a \u escape typed
      // into this source: a typed escape sequence arrives at the file already decoded, so
      // the safe way to place a specific code point in test data is to construct it at
      // runtime, the same rule the gate.py fix follows for the same character.
      const curlyApostrophe = String.fromCharCode(0x2019);
      const text =
        `It${curlyApostrophe}s the company${curlyApostrophe}s policy that isn${curlyApostrophe}t up ` +
        `for debate, we${curlyApostrophe}re aware of it, and where${curlyApostrophe}s the harm in that.\n`;
      // Real contractions: It's, isn't, we're, where's (4). Possessive: company's (excluded).
      const { json } = runGate("curly-apostrophe.md", text);
      expect(json.counts.contractions).toBe(4);
    },
  );
});

describe("not-ai gate — issue #166, apostrophe-aware word tokenization", () => {
  test.skipIf(!PYTHON)(
    "a curly apostrophe (U+2019) word tokenizes the same as its straight-apostrophe form",
    () => {
      // Issue #166: WORD_RE required a straight apostrophe only, so a curly apostrophe split
      // one word into two tokens -- "It's" read as "It" and "s" -- which inflated word_count
      // and every rate derived from it (contractions_per_1000 among them). #158 taught
      // CONTRACTION_RE to accept U+2019 but WORD_RE was a separate concern, left unfixed at
      // the time; this closes that gap.
      //
      // Built via String.fromCharCode rather than a literal character or a \u escape typed
      // into this source: a typed escape sequence arrives at the file already decoded, so
      // the safe way to place a specific code point in test data is to construct it at
      // runtime, the same rule the gate.py fix follows for the same character.
      const curlyApostrophe = String.fromCharCode(0x2019);
      const straight =
        "It's the company's policy that here's how it works: that's fine, " +
        "and there's no problem with Alice's plan or the team's report.\n";
      const curly = straight.split("'").join(curlyApostrophe);

      // Measured before the fix: straight word_count 22 / contractions_per_1000 181.8,
      // curly word_count 29 / contractions_per_1000 137.9. Fixed: both read identically.
      const { json: straightJson } = runGate("apostrophe-straight.md", straight);
      const { json: curlyJson } = runGate("apostrophe-curly.md", curly);
      expect(straightJson.word_count).toBe(22);
      expect(straightJson.counts.contractions_per_1000).toBe(181.8);
      expect(curlyJson.word_count).toBe(straightJson.word_count);
      expect(curlyJson.counts.contractions_per_1000).toBe(straightJson.counts.contractions_per_1000);
    },
  );
});
