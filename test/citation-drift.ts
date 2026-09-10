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
// the real citations in this repo: extract a literal, unambiguous marker already sitting next to
// the citation — a "quoted phrase", a `backtick span`, or a `{{PLACEHOLDER}}` — and assert it is
// still a substring of the cited line(s). That costs the author nothing beyond writing the
// comment they were already going to write, because roughly a quarter of the citations audited
// for this checker already quote something next to the citation without being asked to.
//
// REJECTED ALTERNATIVE: extracting a "distinctive" word from the surrounding prose automatically
// (longest word, rarest word, first capitalized word, anything short of real NLP). Tried against
// the citation at agent-write-scope.ts:132 ("Mirrors review-gate.ts:803, which narrows the same
// field the same way.") — a bag-of-words match on "Mirrors"/"narrows"/"field" against the actual
// target line (`const cwd = typeof payload.cwd === "string" && ...`) finds nothing, which would
// fail a citation that is correct right now. A heuristic that flags a correct citation as broken
// is worse than no check: it is the exact "noisy check gets ignored" failure the issue warns
// against, demonstrated against this repo's own text rather than assumed. So: only explicit,
// unambiguous markup counts as a token. A citation with no such markup nearby still gets a real
// check — file exists, cited lines are in bounds — it just cannot be verified at the content
// level, and this checker says so (`tokenChecked: false`) rather than pretending otherwise. That
// trade-off is real: a review round on this checker found the reverse failure it accepts as the
// cost — five citations in core/ and install/ drifted with no adjacent token to catch them, this
// one among them (it cited :810 until the same round fixed it back to :803). Under-verifying a
// stale citation is the accepted risk, not a hidden one; see MEMORY.md and issues #116/#118 for
// the drifted citations that trade-off let through, fixed where in scope, filed where not.
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
const CROSS_FILE_RE = new RegExp(
  String.raw`(?<![\w./-])((?:[\w.-]+/)*[\w.-]+\.(?:${FILE_EXT})|${NAMED_EXTENSIONLESS}):(\d+)(?:-(\d+))?(?!\d)`,
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
// scope ("comments").
function isCommentLine(trimmed: string, ext: string): boolean {
  if (ext === "json") return false;
  if (ext === "md") return trimmed !== "";
  return (
    trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")
  );
}

export interface Citation {
  sourceFile: string;
  sourceLine: number;
  /** null means the same-file shorthand (":123-456"); resolves to sourceFile. */
  targetSpec: string | null;
  startLine: number;
  endLine: number;
  /** Text to run extractTokens against for this citation only. Usually the citation's whole
   * physical comment line — see extractCitations for why the line, not the surrounding block. When
   * another citation shares that physical line, this holds only the quote/backtick/placeholder
   * spans nearest to THIS citation's own match, so two citations on one line never see each
   * other's tokens (see extractCitations' FINDING 1 note). */
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

  // The token-search context is deliberately just the citation's own physical line, not the
  // whole surrounding comment block or even a one-line lookaround. Both wider options were tried
  // and both produced a real false failure on this repo's own text, not a hypothetical one:
  //
  // - Whole block: agent-write-scope.ts:132 cites review-gate.ts:803, in a 14-line JSDoc comment
  //   that also backtick-quotes `agent_type`, `cwd`, `inScratch()`, `join(42, …)` and
  //   `resolve({}, …)` for unrelated reasons earlier in the same comment. None of those describe
  //   the target line, so a whole-block search reports a correct citation as broken.
  // - One line either side: Export-Account.Tests.ps1:1118 cites `:205-250` and, one line later in
  //   the SAME SENTENCE, names a second, separate reference by title ('the "folds all three
  //   quoting forms" Context above') that carries no line number of its own. A one-line lookaround
  //   attaches that quoted title to the numbered citation next to it and reports the same false
  //   failure, because the two references share a sentence rather than a block.
  //
  // Same-line-only misses a token when a citation and its quote are split by a genuine line wrap
  // (one real instance today: Export-Account.Tests.ps1:1840, where the citation is followed by
  // `# reads "adjusting the augmentation process"` on the next line). That citation still passes
  // — structurally resolved, just not content-verified — which is the correct failure direction:
  // under-verifying a good citation is safe, flagging a good one as broken is the noisy-check
  // failure the issue itself warns against.
  const lineStart = (ln: number): number => (ln === 1 ? 0 : newlineIndexes[ln - 2] + 1);

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
    if (!isCommentLine(lines[ln - 1]?.trim() ?? "", ext)) continue; // not a comment: not a citation
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
    if (!isCommentLine(lines[ln - 1]?.trim() ?? "", ext)) continue;
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

  // FINDING 1 (review round on #98): two citations sharing one physical source line used to get
  // the WHOLE line as context, so extractTokens' output for one citation could include a marker
  // that was actually written for its neighbor — a citation could report tokenChecked:true using a
  // token that names something else's target entirely. Real case in this repo today with no token
  // on either citation yet (Export-Account.Tests.ps1:1602, ":739-742" and ":744-749" on one line),
  // and a reproduced false pass with tokens: `// see a.ts:1 ("first thing") and b.ts:1 ("second
  // thing")`, where a genuine drift at a.ts:1 (losing "first thing") still read ok:true because
  // "second thing" happened to be a substring of a's rewritten target.
  //
  // Fix: attribute each quote/backtick/placeholder span on the shared line to whichever citation's
  // own match it sits closest to (by character distance, never by which half of the line it falls
  // in), and build that citation's context out of only its own owned spans, verbatim and
  // undivided. A line with exactly one citation keeps the full line as context, unchanged — this
  // only activates once a line actually has more than one citation to disambiguate between.
  function ownedContext(line: string, self: RawMatch, siblings: RawMatch[]): string {
    if (siblings.length === 0) return line;
    const spans: { text: string; start: number; end: number }[] = [];
    for (const m of line.matchAll(/"[^"\n]{3,200}"/g)) spans.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    for (const m of line.matchAll(/`[^`\n]{2,200}`/g)) spans.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    for (const m of line.matchAll(/\{\{[\w.-]+\}\}/g)) spans.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    const distanceTo = (span: { start: number; end: number }, c: RawMatch): number => {
      if (span.start >= c.localEnd) return span.start - c.localEnd;
      if (span.end <= c.localStart) return c.localStart - span.end;
      return 0; // overlapping (e.g. a citation nested inside its own backtick span): treat as owned
    };
    const owned = spans.filter((span) => {
      const selfDist = distanceTo(span, self);
      return siblings.every((sib) => selfDist < distanceTo(span, sib));
    });
    return owned.map((s) => s.text).join(" ");
  }

  const citations: Citation[] = [];
  for (const rm of rawMatches) {
    const line = lines[rm.ln - 1] ?? "";
    const siblings = rawMatches.filter((o) => o !== rm && o.ln === rm.ln);
    citations.push({
      sourceFile,
      sourceLine: rm.ln,
      targetSpec: rm.targetSpec,
      startLine: rm.startLine,
      endLine: rm.endLine,
      context: ownedContext(line, rm, siblings),
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

export function checkCitation(
  citation: Citation,
  allFiles: readonly string[],
  getFileText: (repoRelativePath: string) => string | null,
): CheckResult {
  const resolution = resolveTarget(citation, allFiles);
  if (resolution.status === "not-found") {
    return {
      ok: false,
      reason: `target "${citation.targetSpec}" matches no tracked file`,
      tokenChecked: false,
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      ok: false,
      reason: `target "${citation.targetSpec}" is ambiguous: matches ${resolution.matches.join(", ")}`,
      tokenChecked: false,
    };
  }

  const text = getFileText(resolution.path);
  if (text === null) {
    return { ok: false, reason: `could not read resolved target ${resolution.path}`, tokenChecked: false };
  }
  const lines = text.split(/\r?\n/);
  if (citation.startLine < 1 || citation.startLine > citation.endLine || citation.endLine > lines.length) {
    return {
      ok: false,
      reason: `cited range ${citation.startLine}-${citation.endLine} is out of bounds for ${resolution.path} (${lines.length} lines)`,
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
      reason: `none of [${tokens.map((t) => JSON.stringify(t)).join(", ")}] found in ${resolution.path}:${citation.startLine}-${citation.endLine}`,
      tokenChecked: true,
    };
  }
  return { ok: true, tokenChecked: true };
}
