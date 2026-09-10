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
//   repo-content scan already does, with no separate workflow step needed. See the verification
//   note in this file's companion PR/commit for the real run this was checked against: 30
//   citations found in the live tree at the time this landed, 0 failing after two real drifted
//   citations this checker caught were fixed (core/claude/hooks/identity-patterns.sh's citation
//   was wrapped across a line break mid-path, and install/Install-Harness.Tests.ps1 cited
//   CONTRIBUTING.md:45 for text that had moved to :49).

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

  test("treats every non-blank line as commentable in a .md source file", () => {
    const citations = extractCitations("notes.md", "See other.ts:5 for background.\n");
    expect(citations).toEqual([expect.objectContaining({ targetSpec: "other.ts", startLine: 5 })]);
  });

  test("treats a source file's extension case-insensitively (uppercase .MD is still markdown)", () => {
    const citations = extractCitations("NOTES.MD", "See other.ts:9 for background.\n");
    expect(citations).toEqual([expect.objectContaining({ targetSpec: "other.ts", startLine: 9 })]);
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

  // Guards against the extractor regressing to matching nothing, which would make every case
  // below vacuously pass -- a test that cannot fail is worse than no test. 20 is a floor below
  // the 30 measured in the tree this checker was written against, giving room for legitimate
  // citations to be added or removed without this floor itself needing a matching edit.
  test("the extractor finds a real population of citations to check", () => {
    expect(allCitations.length).toBeGreaterThanOrEqual(20);
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
});
