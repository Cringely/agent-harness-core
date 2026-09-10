// Tests for the #98 citation-drift checker (test/citation-drift.ts). Two groups:
//
// - Unit tests against synthetic fixtures, exercising extraction, resolution and token matching
//   in isolation, including the ablation case the house rules require: a token that WAS present
//   at the target and is edited away, to prove checkCitation actually goes red rather than
//   passing by construction.
// - A live scan of this repo's own core/ and install/ trees, generating one `test()` per citation
//   found so a drifted citation fails a test naming both ends, per the issue's "done" criterion.
//   This is also where the mechanism gets registered into CI: it runs under the existing
//   `bun test` job in .github/workflows/test.yml, the same way test/notice.test.ts's live
//   repo-content scan already does, with no separate workflow step needed.
//
// REPAIR ROUND (issue #98's own review): the checker's first commit resolved every citation
// structurally but content-verified only 4 of 30, and a wider replay by hand found real drift in
// citations that resolution alone could not see -- a 0-of-5 true-positive rate against known
// drift. This round widened the token-search window (see citation-drift.ts's WINDOW note) and
// fixed nine citations found genuinely stale by reading both ends against the live tree,
// including the three from issues #116 and #118 that a prior round found but could not fix
// in-scope. Content-verified citations went from 4 of 30 to 28 of 31 (the +1 in the denominator is
// install/Install-Account.ps1:62, invisible to the OLD isCommentLine inside a PowerShell
// `<# ... #>` block and only found once that was fixed too). The 3 that remain unverified are
// named and pinned by the exact-count test at the end of the live-scan section below, not folded
// into a percentage or left to a floor that could grow without anything noticing.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCitation, extractCitations, extractTokens, resolveTarget } from "./citation-drift";

describe("extractCitations", () => {
  test("finds a cross-file citation inside a // comment", () => {
    const text = ["// see other.ts:42 for why", "const x = 1;"].join("\n");
    const citations = extractCitations("src/thing.ts", text);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ targetSpec: "other.ts", startLine: 42, endLine: 42, sourceLine: 1 });
  });

  test("finds a cross-file range citation inside a # comment", () => {
    const text = "# the validation lives at helper.sh:10-20\n";
    const citations = extractCitations("script.sh", text);
    expect(citations).toEqual([
      expect.objectContaining({ targetSpec: "helper.sh", startLine: 10, endLine: 20 }),
    ]);
  });

  test("finds the same-file shorthand, which needs whitespace right before the colon", () => {
    const text = "# the guard added at :100-110 covers this\n";
    const citations = extractCitations("script.sh", text);
    expect(citations).toEqual([expect.objectContaining({ targetSpec: null, startLine: 100, endLine: 110 })]);
  });

  test("ignores a file:line-shaped string that is not in a comment", () => {
    const text = ['const path = "config.ts:42"; // not a citation, just a string literal', ""].join(
      "\n",
    );
    // The regex still matches the text inside the string, so this proves the comment-line filter
    // is what excludes it, not the absence of a match.
    const citations = extractCitations("code.ts", text);
    expect(citations).toEqual([]);
  });

  test("skips JSON entirely: no comment syntax means no citation source", () => {
    const text = '{\n  "note": "see other.ts:42"\n}\n';
    expect(extractCitations("data.json", text)).toEqual([]);
  });

  test("is line-ending agnostic: the same citation is found identically under CRLF", () => {
    const lf = "// mirrors other.ts:5, same shape\nconst x = 1;\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const lfResult = extractCitations("a.ts", lf);
    const crlfResult = extractCitations("a.ts", crlf);
    expect(crlfResult).toEqual(lfResult);
    expect(lfResult).toEqual([expect.objectContaining({ targetSpec: "other.ts", startLine: 5, sourceLine: 1 })]);
  });

  test("attributes a citation deep in a CRLF file to the correct line number", () => {
    // Regression guard for the bug this checker's own first live run against this repo hit:
    // computing byte offsets as `line.length + 1` undercounts every CRLF line by one, so a
    // citation many lines into a CRLF file gets attributed to the wrong physical line and silently
    // drops out of its comment-line check. Twenty padding lines is enough to make that drift
    // visible (twenty undercounted CRLF terminators would misplace the match by twenty lines).
    const padding = Array.from({ length: 200 }, () => "//").join("\r\n");
    const text = `${padding}\r\n// cites target.ts:9 right here\r\n`;
    const citations = extractCitations("deep.ts", text);
    expect(citations).toEqual([
      expect.objectContaining({ targetSpec: "target.ts", startLine: 9, sourceLine: 201 }),
    ]);
  });

  // FINDING 4 (review round on #98): every citation test below the live-scan section is
  // GENERATED from extractCitations' own output, so a regression that makes the extractor find
  // FEWER citations deletes tests instead of turning any of them red — the only backstop is a
  // floor on the total count, with ten citations of slack against the live population. The eight
  // tests below pin the specific extractor behaviors a review round showed silently regress
  // that way (each one verified to fail against the described mutation, restored after).

  test("finds a cross-file citation whose target is a .md file", () => {
    // Silent under the live-scan floor alone: dropping "md" from FILE_EXT stops the target regex
    // from matching a .md filename at all, which happened to delete 3 of this repo's only 4
    // token-verified citations (every one of them cites a .md target) without reddening anything.
    const citations = extractCitations("a.ts", "// see notes.md:12 for background\n");
    expect(citations).toEqual([expect.objectContaining({ targetSpec: "notes.md", startLine: 12 })]);
  });

  test("recognizes a JSDoc-style '*' continuation line as a comment", () => {
    const text = ["/**", " * see other.ts:5 for the reasoning", " */", "const x = 1;"].join("\n");
    const citations = extractCitations("a.ts", text);
    expect(citations).toEqual([
      expect.objectContaining({ targetSpec: "other.ts", startLine: 5, sourceLine: 2 }),
    ]);
  });

  test("recognizes a line starting with a C-style block-comment opener as a comment", () => {
    const text = "/* see other.ts:7 */\nconst x = 1;\n";
    const citations = extractCitations("a.ts", text);
    expect(citations).toEqual([expect.objectContaining({ targetSpec: "other.ts", startLine: 7 })]);
  });

  test("finds a citation whose target is a named extensionless hook file", () => {
    const citations = extractCitations("script.sh", "# see pre-commit:10 for the guard\n");
    expect(citations).toEqual([
      expect.objectContaining({ targetSpec: "pre-commit", startLine: 10, endLine: 10 }),
    ]);
  });

  test("finds a path-qualified named-extensionless citation, not only the bare form", () => {
    // Repair round on #98: the path-prefix group used to sit inside the FILE_EXT alternative
    // only, so a real path like "core/claude/hooks/pre-commit:42" could never match -- the regex
    // engine could only start NAMED_EXTENSIONLESS's alternative at "pre-commit" itself, and the
    // lookbehind then saw the "/" right before it and refused to start there at all. Broken and,
    // per a live scan of core/ and install/ at the time this was found, unexercised: no citation
    // in the tree used this shape yet, so nothing had ever turned this red. Fixed by hoisting the
    // path-prefix group out of the alternation so it applies to both arms.
    const citations = extractCitations("a.ts", "// see core/claude/hooks/pre-commit:42 for the guard\n");
    expect(citations).toEqual([
      expect.objectContaining({ targetSpec: "core/claude/hooks/pre-commit", startLine: 42 }),
    ]);
  });

  test("treats every non-blank line as commentable in a .md source file", () => {
    const citations = extractCitations("notes.md", "See other.ts:5 for background.\n");
    expect(citations).toEqual([expect.objectContaining({ targetSpec: "other.ts", startLine: 5 })]);
  });

  test("treats a source file's extension case-insensitively (uppercase .MD is still markdown)", () => {
    const citations = extractCitations("NOTES.MD", "See other.ts:9 for background.\n");
    expect(citations).toEqual([expect.objectContaining({ targetSpec: "other.ts", startLine: 9 })]);
  });

  test("recognizes a continuation line inside a PowerShell <# ... #> block as a comment", () => {
    // Repair round on #98: isCommentLine tested only leading characters, so a line inside a
    // PowerShell help block that opens with `<#` on an earlier line -- a `.PARAMETER` description,
    // say -- carries none of `//`, `#`, `*` or `/*` and was invisible to extractCitations, not
    // merely unverified. Live cost measured against this tree: install/Install-Account.ps1:62,
    // inside its own `<# .SYNOPSIS ... #>` header, citing Restore-ClaudeProject.ps1:88-95.
    const text = ["<#", ".SYNOPSIS", "    see other.ps1:9 for the reasoning", "#>", "param()"].join(
      "\n",
    );
    const citations = extractCitations("a.ps1", text);
    expect(citations).toEqual([
      expect.objectContaining({ targetSpec: "other.ps1", startLine: 9, sourceLine: 3 }),
    ]);
  });

  test("does not treat code after a closed PowerShell block comment as still inside one", () => {
    // If the state machine failed to close the block, this line -- plain code, no leading `#` --
    // would still read as commented and the string literal inside it would be (wrongly) extracted
    // as a citation, the same false-positive shape as the very first test in this describe block.
    const text = ['<# opens and closes here #>', '$path = "other.ps1:9"'].join("\n");
    const citations = extractCitations("a.ps1", text);
    expect(citations).toEqual([]);
  });

  test("does not mistake code between two PowerShell block comments for being inside one", () => {
    const text = ["<# one #>", "$code = 'not a comment'", "<# see other.ps1:9 #>"].join("\n");
    const citations = extractCitations("a.ps1", text);
    expect(citations).toEqual([expect.objectContaining({ targetSpec: "other.ps1", startLine: 9, sourceLine: 3 })]);
  });
});

describe("resolveTarget", () => {
  const files = ["core/claude/hooks/review-gate.ts", "install/Export-Account.ps1", "docs/a/b/c.md"];
  const citation = (spec: string | null) =>
    ({ sourceFile: "x", sourceLine: 1, targetSpec: spec, startLine: 1, endLine: 1, context: "", raw: "" }) as const;

  test("resolves a bare basename uniquely", () => {
    expect(resolveTarget(citation("review-gate.ts"), files)).toEqual({
      status: "ok",
      path: "core/claude/hooks/review-gate.ts",
    });
  });

  test("resolves a multi-segment relative path by trailing-segment match", () => {
    expect(resolveTarget(citation("a/b/c.md"), files)).toEqual({ status: "ok", path: "docs/a/b/c.md" });
  });

  test("fails closed on a target that matches no tracked file", () => {
    expect(resolveTarget(citation("does-not-exist.ts"), files)).toEqual({ status: "not-found" });
  });

  // Named "fails closed", not "loosens the match": a raw substring match would let this resolve to
  // review-gate.ts (which ends in "-gate.ts" as a character sequence but is not the same path
  // segment), silently checking the wrong file. Segment-exact resolution reports not-found
  // instead, which is the correct outcome for an imprecise citation.
  test("does not resolve a citation by loose substring, only by exact trailing path segment", () => {
    expect(resolveTarget(citation("gate.ts"), files)).toEqual({ status: "not-found" });
  });

  test("fails closed on an ambiguous target rather than picking one", () => {
    const dup = ["a/config.json", "b/config.json"];
    const result = resolveTarget(citation("config.json"), dup);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.matches).toEqual(dup);
  });

  test("same-file shorthand resolves to the citing file itself", () => {
    expect(resolveTarget(citation(null), files)).toEqual({ status: "ok", path: "x" });
  });
});

describe("extractTokens", () => {
  test("extracts a quoted phrase", () => {
    expect(extractTokens('the field reads "adjusting the process" here')).toEqual([
      "adjusting the process",
    ]);
  });

  test("extracts a backtick span", () => {
    expect(extractTokens("see `resolveThing` for the call site")).toEqual(["resolveThing"]);
  });

  test("extracts a {{placeholder}} with its braces intact", () => {
    expect(extractTokens("names {{PROJECT}} in prose")).toEqual(["{{PROJECT}}"]);
  });

  test("returns no tokens for ordinary prose with no markup", () => {
    expect(extractTokens("which narrows the same field the same way")).toEqual([]);
  });
});

describe("checkCitation", () => {
  const files = ["a.ts", "b.ts"];

  test("passes, token-verified, when the quoted token is present at the target line", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "b.ts",
      startLine: 2,
      endLine: 2,
      context: 'see b.ts:2, which reads "hello world"',
      raw: "b.ts:2",
    };
    const getText = (p: string) => (p === "b.ts" ? "line one\nhello world\nline three" : null);
    const result = checkCitation(citation, files, getText);
    expect(result).toEqual({ ok: true, tokenChecked: true });
  });

  // The ablation this house's rules require: take the passing case above and edit the target so
  // the fix-quality it was pinning no longer holds, and confirm the checker actually goes red
  // rather than passing by construction.
  test("ABLATED: the same citation fails once the target line no longer carries the token", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "b.ts",
      startLine: 2,
      endLine: 2,
      context: 'see b.ts:2, which reads "hello world"',
      raw: "b.ts:2",
    };
    const getText = (p: string) => (p === "b.ts" ? "line one\nsomething else entirely\nline three" : null);
    const result = checkCitation(citation, files, getText);
    expect(result.ok).toBe(false);
    expect(result.tokenChecked).toBe(true);
    expect(result.reason).toContain("hello world");
  });

  test("fails closed when the target file cannot be resolved at all", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "deleted.ts",
      startLine: 1,
      endLine: 1,
      context: "see deleted.ts:1",
      raw: "deleted.ts:1",
    };
    const result = checkCitation(citation, files, () => "irrelevant");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no tracked file");
  });

  test("fails closed when the cited range runs past the end of the resolved file", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "b.ts",
      startLine: 5,
      endLine: 5,
      context: "see b.ts:5",
      raw: "b.ts:5",
    };
    const getText = (p: string) => (p === "b.ts" ? "only\ntwo\nlines" : null);
    const result = checkCitation(citation, files, getText);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("out of bounds");
  });

  // Repair round on #98: `text.split(/\r?\n/)` counts a trailing newline's split artifact as an
  // extra line, so a target file ending in "\n" both FAILED OPEN on a citation to the line one
  // past the real end (the phantom empty element covered it) and misreported the count in this
  // checker's own "out of bounds" message. "only\ntwo\nlines\n" has two real lines; a citation to
  // line 3 must be rejected as out of bounds, not accepted because the split produced three
  // elements.
  test("fails closed on the line past the real end even when the target file has a trailing newline", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "b.ts",
      startLine: 3,
      endLine: 3,
      context: "see b.ts:3",
      raw: "b.ts:3",
    };
    const getText = (p: string) => (p === "b.ts" ? "one\ntwo\n" : null);
    const result = checkCitation(citation, files, getText);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("out of bounds");
    // The misreport half of the same bug: the message must name the real line count (2), not the
    // split artifact's inflated one (3).
    expect(result.reason).toContain("(2 lines)");
  });

  // FINDING 4 (review round on #98): the two tests below pin bounds-check branches the live-scan
  // generated tests never happen to exercise (no citation in this repo is written with an
  // inverted range or resolves to a file readFileSync can't read), so a regression here was
  // invisible to the floor on citation count -- both mutations left every generated test green.

  test("fails closed when the cited range is inverted (start after end)", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "b.ts",
      startLine: 5,
      endLine: 2,
      context: "see b.ts:5-2",
      raw: "b.ts:5-2",
    };
    const getText = (p: string) => (p === "b.ts" ? "one\ntwo\nthree\nfour\nfive" : null);
    const result = checkCitation(citation, files, getText);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("out of bounds");
  });

  test("fails closed when the resolved target file cannot be read", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "b.ts",
      startLine: 1,
      endLine: 1,
      context: "see b.ts:1",
      raw: "b.ts:1",
    };
    const result = checkCitation(citation, files, () => null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("could not read");
  });

  test("passes structurally, unverified, when the citation carries no explicit token", () => {
    const citation = {
      sourceFile: "a.ts",
      sourceLine: 1,
      targetSpec: "b.ts",
      startLine: 1,
      endLine: 1,
      context: "mirrors b.ts:1, which does the same thing",
      raw: "b.ts:1",
    };
    const getText = (p: string) => (p === "b.ts" ? "anything at all" : null);
    const result = checkCitation(citation, files, getText);
    expect(result).toEqual({ ok: true, tokenChecked: false });
  });
});

describe("two citations sharing one physical line (FINDING 1, review round on #98)", () => {
  // Reproduces the review's own repro exactly: two citations on one comment line, each with its
  // own quoted token. Before the fix, extractCitations gave both citations the WHOLE line as
  // context, so checkCitation's `tokens.some(t => cited.includes(t))` could pass one citation
  // using a token that was actually written next to its neighbor. Here a.ts has genuinely
  // drifted -- its target line no longer says "first thing" -- but it happens to contain "second
  // thing" (b's token, not a's), which is exactly the contamination that used to produce a false
  // pass on a real drift.
  test("a genuine drift at one citation is not masked by its neighbor's token", () => {
    const text = '// see a.ts:1 ("first thing") and b.ts:1 ("second thing")\n';
    const citations = extractCitations("both.ts", text);
    expect(citations).toHaveLength(2);
    const [citeA, citeB] = citations;
    expect(citeA.targetSpec).toBe("a.ts");
    expect(citeB.targetSpec).toBe("b.ts");

    const files = ["both.ts", "a.ts", "b.ts"];
    const getText = (p: string) => {
      if (p === "a.ts") return "totally different content, but mentions second thing anyway";
      if (p === "b.ts") return "reads second thing here";
      return null;
    };

    const resultA = checkCitation(citeA, files, getText);
    expect(resultA.ok).toBe(false); // real drift: a's own token, "first thing", is gone
    expect(resultA.tokenChecked).toBe(true);
    expect(resultA.reason).toContain("first thing");

    const resultB = checkCitation(citeB, files, getText);
    expect(resultB).toEqual({ ok: true, tokenChecked: true }); // b's own token is genuinely there
  });
});

// --- Live scan of this repo's own core/ and install/ trees --------------------------------

const REPO_ROOT = join(import.meta.dir, "..");

function gitLsFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  }
  const files = result.stdout.toString().split(/\r?\n/).filter((f) => f !== "");
  // Fail closed on a scope that resolves empty: an empty listing here would make every
  // resolution below vacuously "not found" without ever proving git ran at all, which is the
  // exact "empty scope silently reported as clean" failure this repo has been bitten by before.
  if (files.length === 0) {
    throw new Error("git ls-files returned no files -- refusing to treat that as an empty repo");
  }
  return files;
}

const allFiles = gitLsFiles();
// core/ and install/ only, matching issue #98's own scope and its audit -- deliberate, not an
// accident of the filter's shape. test/ (this checker's own home, including this file and
// citation-drift.ts) is excluded on purpose: those comments document the checker's reasoning
// about ITSELF while it is under active edit, so a citation there routinely names a line number
// that is true only in the commit that wrote it (see, e.g., the WHOLE-BLOCK/one-line-either-side
// examples in citation-drift.ts's WINDOW note, which cite real line numbers in real files that
// this repair round itself moved). Running the live scan against the tool's own commentary about
// its own history would make every repair round on this file fight its own test suite over
// numbers that describe the past, not a live invariant. Scoping to core/ and install/ means this
// checker enforces the invariant on the repo it protects without also trying to enforce it on
// the sentence explaining why the invariant exists.
const sourceFiles = allFiles.filter((f) => f.startsWith("core/") || f.startsWith("install/"));

const fileTextCache = new Map<string, string | null>();
function getFileText(repoRelativePath: string): string | null {
  const cached = fileTextCache.get(repoRelativePath);
  if (cached !== undefined) return cached;
  let text: string | null;
  try {
    text = readFileSync(join(REPO_ROOT, repoRelativePath), "utf8");
  } catch {
    text = null;
  }
  fileTextCache.set(repoRelativePath, text);
  return text;
}

const allCitations = sourceFiles.flatMap((f) => {
  const text = getFileText(f);
  return text === null ? [] : extractCitations(f, text);
});

describe("citation drift — live scan of core/ and install/", () => {
  test("git ls-files enumerated a real tracked tree, not an empty one", () => {
    expect(allFiles.length).toBeGreaterThan(100);
  });

  test("both scoped directories are represented in the source set", () => {
    expect(sourceFiles.some((f) => f.startsWith("core/"))).toBe(true);
    expect(sourceFiles.some((f) => f.startsWith("install/"))).toBe(true);
  });

  // A floor of 20 against a measured 30 let ten citations vanish from the extractor's output
  // with nothing here noticing -- ten generated `test()` cases simply stop existing, which reads
  // as a smaller, faster suite rather than a regression. Repair round on #98 replaced the floor
  // with the exact count: 31 in this tree today (30 the checker's first commit measured, +1 from
  // fixing isCommentLine's PowerShell `<# ... #>` blind spot, which surfaced a citation that was
  // previously invisible to extractCitations rather than merely unverified --
  // install/Install-Account.ps1:62, citing Restore-ClaudeProject.ps1:88-95). A real edit to the
  // population -- a citation added, removed, or a comment restructured so a match splits or
  // merges -- updates this number in the same commit; that is the point, not a maintenance cost.
  test("the extractor finds exactly the live population of citations to check", () => {
    expect(allCitations.length).toBe(31);
  });

  for (const citation of allCitations) {
    const target =
      citation.targetSpec === null
        ? "(same file)"
        : `${citation.targetSpec}:${citation.startLine}${citation.endLine !== citation.startLine ? "-" + citation.endLine : ""}`;
    test(`${citation.sourceFile}:${citation.sourceLine} -> ${target}`, () => {
      const result = checkCitation(citation, allFiles, getFileText);
      expect(result.ok, result.reason).toBe(true);
    });
  }

  // FAIL OPEN, NAMED. `tokenChecked: false` on an `ok: true` result is this checker's honest
  // ceiling on a citation with no explicit token within reach: file exists, range in bounds,
  // CONTENT unverified. That gap is the whole reason #98 exists (0-of-5 true positives measured
  // against a same-line-only design that could not see it), so leaving it silent here would
  // recreate the exact failure this repair round closed, one level up. This asserts the count
  // rather than merely logging it, so CI itself is the thing that notices: 28 of 31 citations in
  // the tree are content-verified after this round (up from 4 of 30 before it), and the 3 left
  // are named below rather than folded into a percentage.
  //
  // Left unresolved rather than guessed at: install/Export-Account.Tests.ps1:1603 carries two
  // same-file citations (":739-742" and ":744-749") whose own paragraph describes content neither
  // range holds (executable test setup, not the comments the paragraph says assert an ablation is
  // caught), which reads as real drift, but nothing in the file names where the correct target
  // moved to and guessing one would risk shipping a second wrong citation in its place. And
  // install/Export-Account.Tests.ps1:1176 cites mcp-servers.json:14 for a historical incident
  // ("task-14-addendum's scrub"), where the line today correctly holds the post-fix placeholder --
  // plausibly a citation to where the leak WAS, not a claim about what is there now, but not
  // provable from the text alone. Fixing the producer, not guessing at the consumer, per this
  // repo's own fix-quality rule: a citation this checker cannot confidently repoint is a citation
  // it reports on, not one it silently "fixes" into some other kind of wrong.
  test("exactly 3 citations remain content-unverified, and this is the full list", () => {
    const unverified = allCitations
      .map((c) => ({ c, r: checkCitation(c, allFiles, getFileText) }))
      .filter(({ r }) => r.ok && !r.tokenChecked)
      .map(({ c }) => `${c.sourceFile}:${c.sourceLine}`);
    expect(unverified).toEqual([
      "install/Export-Account.Tests.ps1:1176",
      "install/Export-Account.Tests.ps1:1603",
      "install/Export-Account.Tests.ps1:1603",
    ]);
  });
});
