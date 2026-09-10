// Checker for #98: every `<file>:<line>` / `<file>:<line>-<line>` citation written into a
// comment under core/ or install/ should still point at what it claims to. The class this
// guards is recorded in MEMORY.md ("citations go stale between commits") and in issue #98's own
// audit: four citations off by 17-112 lines and one pointing at the wrong file entirely, none of
// them caught by anything, one of them (this checker's own first live run) a repeat that
// happened again while the first note already existed.
//
// DESIGN DECISION — what "still matches" means, and why not an exact line number.
// An exact-line assertion is brittle against any edit above the target and would need updating on
// every unrelated diff that shifts line numbers, which is exactly the kind of noisy check that
// gets disabled or ignored (issue #98's own framing). The alternative that survives contact with
// the real citations in this repo: extract a literal, unambiguous marker already sitting near
// the citation — a "quoted phrase", a `backtick span`, or a `{{PLACEHOLDER}}` — and assert it is
// still a substring of the cited line(s). That costs the author nothing beyond writing the
// comment they were already going to write, because roughly a quarter of the citations audited
// for this checker already quote something next to the citation without being asked to. How near
// "near" means is the WINDOW decision, below the extraction code, not here — this repair round
// widened it, and that is a separate, later decision from the one this paragraph is about.
//
// REJECTED ALTERNATIVE: extracting a "distinctive" word from the surrounding prose automatically
// (longest word, rarest word, first capitalized word, anything short of real NLP). Tried against
// the citation at agent-write-scope.ts:132 ("Mirrors review-gate.ts:803, which narrows the same
// field the same way.") — a bag-of-words match on "Mirrors"/"narrows"/"field" against the actual
// target line (`const cwd = typeof payload.cwd === "string" && ...`) finds nothing, which would
// fail a citation that is correct right now. A heuristic that flags a correct citation as broken
// is worse than no check: it is the exact "noisy check gets ignored" failure the issue warns
// against, demonstrated against this repo's own text rather than assumed. So: only explicit,
// unambiguous markup counts as a token. A citation with no such markup within the window still
// gets a real check — file exists, cited lines are in bounds — it just cannot be verified at the
// content level, and this checker says so (`tokenChecked: false`) rather than pretending
// otherwise; the live-scan section at the bottom of the test file pins how many that is today.
//
// FAIL CLOSED on a citation this cannot resolve. A target path that matches zero tracked files
// (renamed, deleted, or never existed) is a failure, not a skip — an unresolvable citation is
// worse than a stale one, because a stale one at least names a real file. Same for an ambiguous
// target (more than one tracked file ends with the cited path): resolving to "whichever one
// happens to sort first" would silently check the wrong file, which is the empty-scope-widens
// failure this repo has been bitten by before, applied to path resolution instead of a data filter.
//
// SCOPE. Only the colon-delimited form is recognised: `file.ext:123`, `file.ext:123-456`, and the
// same-file shorthand `:123-456` this repo already uses inside a file citing itself. Prose forms
// like "that file's resolveValeConfig, line 125" or "the pre-push hook, lines 68-79" are not
// extracted — they read fine to a person and there is no reliable, low-false-positive way to turn
// arbitrary English into a file+line pair without the same NLP problem the token design above
// rejected. Out of scope by the issue itself: citations to commit SHAs (#65, different fix, a
// rewrite invalidates all of them at once and matching commit subjects is the only recovery).

const FILE_EXT = "ts|ps1|sh|md|json";
// Extensionless files this repo ships as real git hooks; cheap to include, costs nothing today
// (no citation currently targets one this way) and saves a silent gap the day one does.
const NAMED_EXTENSIONLESS = "pre-commit|pre-push|commit-msg";

// Lookbehind keeps a match from starting mid-path (so "sub/file.ts:12" is one match, not two);
// the trailing (?!\d) keeps a longer number like "123" from being read as "12" followed by "3".
//
// The path-prefix group `(?:[\w.-]+/)*` sits OUTSIDE the extensioned/named-extensionless
// alternation, not inside just the first arm. Review round on #98's repair found it originally
// nested inside the first arm only, so a real path-qualified citation to a named-extensionless
// hook -- "core/claude/hooks/pre-commit:42" -- could never match: the regex engine could only
// start the NAMED_EXTENSIONLESS alternative at "pre-commit" itself, and the lookbehind then saw
// the "/" right before it and refused to start a match there at all. Hoisting the prefix out so
// it applies to both alternatives fixes that without changing anything about the extensioned
// arm's own grammar (a bare filename was always `(?:[\w.-]+/)*[\w.-]+\.ext` before, and still is).
const CROSS_FILE_RE = new RegExp(
  String.raw`(?<![\w./-])((?:[\w.-]+/)*(?:[\w.-]+\.(?:${FILE_EXT})|${NAMED_EXTENSIONLESS})):(\d+)(?:-(\d+))?(?!\d)`,
  "g",
);
// Same-file shorthand only fires right after whitespace, which is what every real instance in
// this repo looks like ("the validation at :215-221"). That boundary is also what keeps this from
// matching the tail of an ordinary sentence: nothing here reads " :" as an ordinary two-character
// sequence except a citation.
const SAME_FILE_RE = /(?<=\s):(\d+)(?:-(\d+))?(?!\d)/g;

function getExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

// Is this line (already trimmed) part of a comment, for the given file's extension? A markdown
// file has no code to separate comments from, so every non-blank line counts; a JSON file has no
// comment syntax at all, so nothing in it is ever a citation source, matching the issue's own
// scope ("comments"). `inPsBlockComment` covers a PowerShell `<# ... #>` help block: a
// continuation line inside one (e.g. a `.PARAMETER` description) carries none of the leading
// markers below, so testing leading characters alone made every such line invisible to this
// checker. Review round on #98's repair found the live cost: install/Install-Account.ps1's
// `<# .SYNOPSIS ... #>` header cites Restore-ClaudeProject.ps1:88-95 and was never even
// structurally checked before this fix, because the line was never recognised as a comment
// in the first place — not "unverified", genuinely invisible to extractCitations.
function isCommentLine(trimmed: string, ext: string, inPsBlockComment: boolean): boolean {
  if (ext === "json") return false;
  if (ext === "md") return trimmed !== "";
  if (inPsBlockComment) return true;
  return (
    trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")
  );
}

// Tracks `<# ... #>` state across a whole .ps1 file and reports, per line, whether any part of
// that line sat inside an open block comment. Non-nesting: PowerShell block comments do not
// nest in practice in this repo, and a state machine that tried to would need to distinguish a
// block-close token from a literal "#>" inside a string, which nothing here writes.
function computePsBlockCommentLines(lines: readonly string[]): boolean[] {
  const flags = new Array(lines.length).fill(false);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) flags[i] = true; // already open when this line starts
    let pos = 0;
    while (pos < line.length) {
      if (!inBlock) {
        const start = line.indexOf("<#", pos);
        if (start === -1) break;
        inBlock = true;
        flags[i] = true;
        pos = start + 2;
      } else {
        const end = line.indexOf("#>", pos);
        if (end === -1) break; // still open past the end of this line
        inBlock = false;
        pos = end + 2;
      }
    }
  }
  return flags;
}

export interface Citation {
  sourceFile: string;
  sourceLine: number;
  /** null means the same-file shorthand (":123-456"); resolves to sourceFile. */
  targetSpec: string | null;
  startLine: number;
  endLine: number;
  /** Text to run extractTokens against for this citation only. Usually the citing line plus one
   * comment line immediately before and after it — see extractCitations' WINDOW note for why that
   * width, not the whole surrounding block. When another citation's own match falls inside that
   * same window, this holds only the quote/backtick/placeholder spans nearest to THIS citation's
   * own match, so two nearby citations never see each other's tokens (see the FINDING 1 note). */
  context: string;
  raw: string;
}

export function extractCitations(sourceFile: string, text: string): Citation[] {
  const ext = getExt(sourceFile);
  const lines = text.split(/\r?\n/);

  // Match indexes from `text.matchAll` are byte-ish offsets into the RAW text, which on this repo
  // is CRLF as often as LF (measured: install/*.Tests.ps1 and even a .ts file under core/ are
  // CRLF). Deriving offsets from `lines.length + 1` assumes a one-character terminator and drifts
  // by one for every CRLF line before the match, which silently misattributes a citation to the
  // wrong block (or to none, dropping it) the further down a CRLF file the citation sits — this
  // is exactly the "index holds LF, working tree holds CRLF" matcher hazard called out for this
  // repo. Counting raw '\n' occurrences instead is immune to the '\r' either way, since a CRLF
  // pair still contributes exactly one '\n'.
  const newlineIndexes: number[] = [];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlineIndexes.push(i);
  function lineNumberForIndex(idx: number): number {
    let lo = 0;
    let hi = newlineIndexes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlineIndexes[mid] < idx) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }

  const lineStart = (ln: number): number => (ln === 1 ? 0 : newlineIndexes[ln - 2] + 1);
  const psBlockFlags = ext === "ps1" ? computePsBlockCommentLines(lines) : null;
  const isCommentAt = (ln: number): boolean =>
    isCommentLine(lines[ln - 1]?.trim() ?? "", ext, psBlockFlags ? (psBlockFlags[ln - 1] ?? false) : false);

  interface RawMatch {
    ln: number;
    localStart: number;
    localEnd: number;
    targetSpec: string | null;
    startLine: number;
    endLine: number;
    raw: string;
  }
  const rawMatches: RawMatch[] = [];
  for (const m of text.matchAll(CROSS_FILE_RE)) {
    const ln = lineNumberForIndex(m.index);
    if (!isCommentAt(ln)) continue; // not a comment: not a citation
    const start = m.index - lineStart(ln);
    rawMatches.push({
      ln,
      localStart: start,
      localEnd: start + m[0].length,
      targetSpec: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : Number(m[2]),
      raw: m[0],
    });
  }
  for (const m of text.matchAll(SAME_FILE_RE)) {
    const ln = lineNumberForIndex(m.index);
    if (!isCommentAt(ln)) continue;
    const start = m.index - lineStart(ln);
    rawMatches.push({
      ln,
      localStart: start,
      localEnd: start + m[0].length,
      targetSpec: null,
      startLine: Number(m[1]),
      endLine: m[2] ? Number(m[2]) : Number(m[1]),
      raw: m[0],
    });
  }

  // WINDOW, widened per issue #98's repair round. The original same-line-only design measured
  // 0 of 5 known real drifts caught: a citation whose only quoted/backtick token sits one physical
  // line away from the reference itself (a wrapped sentence, a `.PARAMETER`-style continuation,
  // a comment written just above or below the file:line it explains) was structurally resolved and
  // never content-checked, which is exactly the fail-open #98 exists to close. The load-bearing
  // example for keeping the window at one line -- agent-write-scope.ts:132's citation of
  // review-gate.ts -- had itself already drifted (to :810) by the time that argument was made; see
  // commit 20edd31's message for the full account. With the data now correct, this checker widens
  // the window to the citing line plus one comment line immediately before and one immediately
  // after (never a line that isn't itself a comment, so a window never crosses into code).
  //
  // Ownership is decided the same way FINDING 1 (below) already decides it for two citations
  // sharing one physical line, generalised from "same line" to "within the window": each
  // quote/backtick/placeholder span is attributed to whichever citation's own match sits closest to
  // it, and a span on a citation's own line always beats a span merely adjacent to it. A citation
  // with no other citation contesting its window keeps the window's full text as context, same as
  // the single-line design kept the full line.
  //
  // Accepted cost, replayed against every citation in the tree at the time of this repair: a
  // citation whose window contains someone ELSE's quoted phrase (not a rival citation's own token,
  // just unrelated nearby prose -- a title reference, a variable name) can have that phrase swept in
  // as one of its candidate tokens. This does not by itself fail the citation: checkCitation only
  // fails when NONE of a citation's tokens match its target, so a bystander token that doesn't match
  // rides along harmlessly as long as the citation's real token is also within reach. It only
  // produces a false failure for a citation whose window carries no real token AT ALL -- which the
  // repair round found for a small, now-fixed set of correct citations (moved or added a token
  // directly onto the citing line so it always wins on distance) rather than by narrowing the window
  // back down and reintroducing the 0-of-5 detection gap.
  function windowContext(rm: RawMatch, allMatches: readonly RawMatch[]): string {
    const windowLines = [rm.ln - 1, rm.ln, rm.ln + 1].filter(
      (ln) => ln >= 1 && ln <= lines.length && isCommentAt(ln),
    );
    const rivals = allMatches.filter((o) => o !== rm && windowLines.includes(o.ln));
    if (rivals.length === 0) return windowLines.map((ln) => lines[ln - 1] ?? "").join("\n");

    interface Span {
      text: string;
      ln: number;
      start: number;
      end: number;
    }
    const spans: Span[] = [];
    for (const ln of windowLines) {
      const lineText = lines[ln - 1] ?? "";
      for (const m of lineText.matchAll(/"[^"\n]{3,200}"/g)) spans.push({ text: m[0], ln, start: m.index, end: m.index + m[0].length });
      for (const m of lineText.matchAll(/`[^`\n]{2,200}`/g)) spans.push({ text: m[0], ln, start: m.index, end: m.index + m[0].length });
      for (const m of lineText.matchAll(/\{\{[\w.-]+\}\}/g)) spans.push({ text: m[0], ln, start: m.index, end: m.index + m[0].length });
    }
    // A span on a DIFFERENT line than the candidate citation is always farther than a span on the
    // citation's own line, so cross-line distance is offset well past any possible intra-line
    // distance; the exact magnitude only has to preserve that ordering, since the window radius is
    // one line either side and two citations can compete for a shared span from opposite sides.
    const distanceTo = (span: Span, c: RawMatch): number => {
      if (span.ln !== c.ln) return 1_000_000 + Math.abs(span.ln - c.ln);
      if (span.start >= c.localEnd) return span.start - c.localEnd;
      if (span.end <= c.localStart) return c.localStart - span.end;
      return 0; // overlapping (e.g. a citation nested inside its own backtick span): treat as owned
    };
    const owned = spans.filter((span) => {
      const selfDist = distanceTo(span, rm);
      return rivals.every((rival) => selfDist < distanceTo(span, rival));
    });
    return owned.map((s) => s.text).join(" ");
  }

  const citations: Citation[] = [];
  for (const rm of rawMatches) {
    citations.push({
      sourceFile,
      sourceLine: rm.ln,
      targetSpec: rm.targetSpec,
      startLine: rm.startLine,
      endLine: rm.endLine,
      context: windowContext(rm, rawMatches),
      raw: rm.raw,
    });
  }
  return citations;
}

export type Resolution =
  | { status: "ok"; path: string }
  | { status: "not-found" }
  | { status: "ambiguous"; matches: string[] };

// Exact trailing-path-segment match only, never a raw substring match. A raw substring match
// would let "weaknesses.md" silently resolve to "08-vector-and-embedding-weaknesses.md" by
// coincidence of shared letters, which is fine right up until two unrelated files share a
// trailing substring and the wrong one gets checked. Segment-exact resolution fails closed on
// that same abbreviation instead (reported as not-found), which is the correct outcome: it is
// the citation that is imprecise, not the checker.
export function resolveTarget(citation: Citation, allFiles: readonly string[]): Resolution {
  if (citation.targetSpec === null) return { status: "ok", path: citation.sourceFile };
  const segs = citation.targetSpec.split("/");
  const matches = allFiles.filter((f) => {
    const fSegs = f.split("/");
    if (fSegs.length < segs.length) return false;
    return fSegs.slice(fSegs.length - segs.length).join("/") === citation.targetSpec;
  });
  if (matches.length === 0) return { status: "not-found" };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "ok", path: matches[0] };
}

// Only explicit markup counts: a "quoted phrase", a `backtick span`, or a {{placeholder}}. See
// the file header for why a looser, automatic pick of "the distinctive word" was tried and
// rejected.
export function extractTokens(context: string): string[] {
  const tokens = new Set<string>();
  for (const m of context.matchAll(/"([^"\n]{3,200})"/g)) tokens.add(m[1]);
  for (const m of context.matchAll(/`([^`\n]{2,200})`/g)) tokens.add(m[1]);
  for (const m of context.matchAll(/\{\{[\w.-]+\}\}/g)) tokens.add(m[0]);
  return [...tokens];
}

export interface CheckResult {
  ok: boolean;
  reason?: string;
  /** false when there was no explicit token nearby to check content with — structural-only pass. */
  tokenChecked: boolean;
}

// `text.split(/\r?\n/)` counts one line too many whenever the file ends with a trailing
// newline: "a\nb\n".split(/\r?\n/) is ["a", "b", ""], and that trailing "" is a split artifact,
// not a real line. Left uncorrected this both fails OPEN (a citation to the line one past the
// real end resolves as "in bounds" because the phantom empty element covers it) and misreports
// the count in the checker's own "out of bounds" message (one line too high). Dropping a single
// trailing "" element is enough: a file with no trailing newline never produces one, and an
// empty file ("".split(...) === [""]) correctly reduces to zero lines.
function splitLines(text: string): string[] {
  const raw = text.split(/\r?\n/);
  return raw.length > 0 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
}

export function checkCitation(
  citation: Citation,
  allFiles: readonly string[],
  getFileText: (repoRelativePath: string) => string | null,
): CheckResult {
  const resolution = resolveTarget(citation, allFiles);
  if (resolution.status === "not-found") {
    return {
      ok: false,
      reason: `citation \`${citation.raw}\`: target "${citation.targetSpec}" matches no tracked file`,
      tokenChecked: false,
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      ok: false,
      reason: `citation \`${citation.raw}\`: target "${citation.targetSpec}" is ambiguous: matches ${resolution.matches.join(", ")}`,
      tokenChecked: false,
    };
  }

  const text = getFileText(resolution.path);
  if (text === null) {
    return {
      ok: false,
      reason: `citation \`${citation.raw}\`: could not read resolved target ${resolution.path}`,
      tokenChecked: false,
    };
  }
  const lines = splitLines(text);
  if (citation.startLine < 1 || citation.startLine > citation.endLine || citation.endLine > lines.length) {
    return {
      ok: false,
      reason: `citation \`${citation.raw}\`: cited range ${citation.startLine}-${citation.endLine} is out of bounds for ${resolution.path} (${lines.length} lines)`,
      tokenChecked: false,
    };
  }

  const cited = lines.slice(citation.startLine - 1, citation.endLine).join("\n");
  const tokens = extractTokens(citation.context);
  if (tokens.length === 0) {
    // No explicit marker to check against. Structural resolution already passed above, which is
    // the honest ceiling here — see the file header on why this checker does not guess a token
    // out of ordinary prose.
    return { ok: true, tokenChecked: false };
  }
  const matched = tokens.some((t) => cited.includes(t));
  if (!matched) {
    return {
      ok: false,
      reason: `citation \`${citation.raw}\`: none of [${tokens.map((t) => JSON.stringify(t)).join(", ")}] found in ${resolution.path}:${citation.startLine}-${citation.endLine}`,
      tokenChecked: true,
    };
  }
  return { ok: true, tokenChecked: true };
}
