// Checks a body against a repository's PR or issue template (#274). Every heading in the template
// is a section the body must carry, by heading text at any level, with something a reader can see
// under it.
//
// Scope: this catches a template section an honest author left unfilled or forgot. It is not a
// security boundary. Hostile markup crafted to make an empty section look filled is out of scope,
// because an author who wants past the gate can type filler text anyway.
//
// Filled is a positive rule. Once HTML comments, script and style elements, processing
// instructions, CDATA, declarations, HTML tags, HTML entities, link destinations and link
// reference definitions are removed, the section must still hold at least one Unicode letter or
// number (classes L and N). Markdown syntax characters, whitespace, format characters such as the
// zero-width space, and the Hangul filler letters never count. A closed fence counts when a line in
// it holds a letter or number, read as written, because GitHub shows that line as code. Fence lines
// themselves and every line of a fence that never closes do not count. A comment never closed
// hides the rest of the body, headings included.
//
// A heading is a line outside any fence, comment and HTML block. An HTML block approximates
// CommonMark's start conditions 1 to 7: it starts at a line beginning with an HTML tag, "<?" or
// "<!", and ends at a blank line, or for pre, textarea, script and style at the line holding the
// matching close tag, or at the "?>", ">" or "]]>" ending a processing instruction, declaration or
// CDATA. A fence closes only on a line of the same character, at least as long, with nothing after
// it.
//
// A body section ends at the next heading at its own level or above, and also at the next heading
// that names any template section other than one nested under it in the template. Body heading
// depth is the author's choice, so without that second boundary a body using a shallower heading
// would swallow the next template section's content and an empty section would read as filled.
// The nth template section with a given heading matches the nth body heading with that text, so
// one body section never fills two template sections. The template's own instruction comments are
// stripped first, so leaving them in place does not count as filling the section.
//
// Headings are a literal subset of what GitHub renders: only an ATX heading starting at column 0
// is a section. A template holding a line that CommonMark could read as any other heading, an ATX
// heading indented 1 to 3 spaces or a setext underline under a paragraph line, refuses with
// PublishRefusal, so no template section goes unrequired. In a body those forms are neither a
// section nor content.
//
// Only section indexes come back, never heading or body text.

import { PublishRefusal } from "./errors";

export interface TemplateSection {
  level: number;
  key: string;
}

interface Line {
  heading: TemplateSection | null;
  text: string;
  // A line inside a closed fence. Its text is read as written, with no markup removed.
  code: boolean;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
// Heading forms outside the subset. Four spaces or more is indented code, not a heading.
const INDENTED_ATX_RE = /^ {1,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
// CommonMark fences: a backtick info string holds no backtick, and a closing fence repeats the
// opening character at least as many times with nothing after it but spaces and tabs.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// HTML block starts, after CommonMark's start conditions. Condition 2, the comment, is read by
// outsideComments instead. Conditions 6 and 7 merge into any opening or closing tag at the start
// of a line, which ends at a blank line.
const HTML_RAW_RE = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i;
const HTML_PI_RE = /^ {0,3}<\?/;
const HTML_CDATA_RE = /^ {0,3}<!\[CDATA\[/;
const HTML_DECL_RE = /^ {0,3}<![A-Za-z]/;
const HTML_TAG_RE = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)/;

type HtmlBlock = { end: RegExp } | { blank: true };

function htmlBlockStart(raw: string): HtmlBlock | null {
  const rawTag = HTML_RAW_RE.exec(raw);
  if (rawTag) return { end: new RegExp("</" + rawTag[1] + "[\\s]*>", "i") };
  if (HTML_PI_RE.test(raw)) return { end: /\?>/ };
  if (HTML_CDATA_RE.test(raw)) return { end: /\]\]>/ };
  if (HTML_DECL_RE.test(raw)) return { end: />/ };
  if (HTML_TAG_RE.test(raw)) return { blank: true };
  return null;
}

// Letters the Unicode database classes as L that render as blank space: the Hangul choseong and
// jungseong fillers, the Hangul filler and the halfwidth Hangul filler.
const FILLER_RE = new RegExp("[" + String.fromCharCode(0x115f, 0x1160, 0x3164, 0xffa0) + "]", "g");
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;

function hasLetterOrNumber(text: string): boolean {
  return LETTER_OR_NUMBER_RE.test(text.replace(FILLER_RE, ""));
}

// Prose with its markup removed, judged only for whether a letter or number is left. Markdown
// syntax characters need no removal, being neither. An autolink such as "<https://x>" is not a tag
// here, since a colon follows its first word.
function visibleProse(text: string): string {
  // Repeat until nothing changes: removing one tag can join its neighbors into a new one.
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = stripMarkupOnce(previous);
  } while (current !== previous);
  // Angle brackets are neither letters nor numbers, so dropping any left over changes no verdict.
  return current.replace(/[<>]/g, "");
}

function stripMarkupOnce(text: string): string {
  return stripComments(text)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<\?[\s\S]*?(?:\?>|$)/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "")
    .replace(/<![A-Za-z][^>]*>?/g, "")
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/][^>]*)?>/g, "")
    .replace(/&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, "")
    .replace(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, "")
    .replace(/\]\([^)\n]*\)/g, "]");
}

function stripComments(text: string): string {
  // Repeat until nothing changes: one pass over "<!<!---->--" would leave a fresh "<!--" behind.
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(/<!--[\s\S]*?-->/g, "");
  } while (current !== previous);
  return current;
}

function stripFrontMatter(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

function headingKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

// The part of one line outside comments. `state.open` carries a comment across lines. An opening
// "<!--" with no "-->" after it hides everything to the end of the text, which is what GitHub
// shows for one at the start of a line and stricter than it for one mid-line. Scanning repeats on
// the result, so removing "<!---->" from "<!<!---->--" does not leave a visible "<!--" behind.
function outsideComments(raw: string, state: { open: boolean }): string {
  let text = raw;
  for (;;) {
    let out = "";
    let rest = text;
    for (;;) {
      if (state.open) {
        const end = rest.indexOf("-->");
        if (end === -1) return out;
        rest = rest.slice(end + 3);
        state.open = false;
      }
      const start = rest.indexOf("<!--");
      if (start === -1) break;
      out += rest.slice(0, start);
      rest = rest.slice(start + 4);
      state.open = true;
    }
    out += rest;
    if (out === text || !out.includes("<!--")) return out;
    text = out;
  }
}

// Each line's heading, if any, and the text it shows. Text is empty for a fence line, for a line
// hidden by a comment, and for every line of a fence that never closes. Lines of a closed fence
// carry code: true. No line inside an HTML block is a heading. A heading outside the subset
// throws when `strict` is set (the template), and otherwise shows no text (the body).
function splitLines(text: string, readComments = true, strict = false): Line[] {
  const out: Line[] = [];
  // Index of the first line of the open paragraph, or -1 when none is open.
  let paragraph = -1;
  const outsideSubset = (lineNumber: number): never => {
    throw new PublishRefusal(
      `the template's line ${lineNumber} is a heading form this tool does not read: only a "#" heading starting at column 0 is a section`,
    );
  };
  const comment = { open: false };
  let fence: { mark: string; length: number; first: number } | null = null;
  let html: HtmlBlock | null = null;
  // A leading byte-order mark (Windows PowerShell 5.1's Set-Content writes one) would otherwise
  // hide a heading on the first line.
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(raw);
      if (close && close[1]![0] === fence.mark && close[1]!.length >= fence.length) {
        fence = null;
        out.push({ heading: null, text: "", code: false });
      } else {
        out.push({ heading: null, text: raw, code: true });
      }
      continue;
    }
    const startsInComment = comment.open;
    if (html !== null) {
      if ("blank" in html && raw.trim() === "") {
        html = null;
        paragraph = -1;
      } else {
        out.push({ heading: null, text: readComments ? outsideComments(raw, comment) : raw, code: false });
        if ("end" in html && html.end.test(raw)) html = null;
        continue;
      }
    }
    // An info string is not parsed for comments, so a fence opens even with "<!--" after it.
    const open = startsInComment ? null : FENCE_OPEN_RE.exec(raw);
    if (open) {
      paragraph = -1;
      fence = { mark: open[1]![0]!, length: open[1]!.length, first: out.length + 1 };
      out.push({ heading: null, text: "", code: false });
      continue;
    }
    const block = startsInComment || /^ {0,3}<!--/.test(raw) ? null : htmlBlockStart(raw);
    const visible = readComments ? outsideComments(raw, comment) : raw;
    if (block) {
      paragraph = -1;
      out.push({ heading: null, text: visible, code: false });
      // A block whose end marker follows its opening tag on the same line closes there. The tag is
      // cut first so that "<pre>" does not read as its own end and "<?" as a "?>".
      const afterStart = raw.replace(/^ {0,3}<[!?/]?[A-Za-z0-9[]*/, "");
      if (!("end" in block && block.end.test(afterStart))) html = block;
      continue;
    }
    if (visible.trim() === "") {
      paragraph = -1;
      out.push({ heading: null, text: visible, code: false });
      continue;
    }
    if (!startsInComment && INDENTED_ATX_RE.test(visible)) {
      if (strict) outsideSubset(out.length + 1);
      paragraph = -1;
      out.push({ heading: null, text: "", code: false });
      continue;
    }
    if (!startsInComment && paragraph !== -1 && SETEXT_UNDERLINE_RE.test(visible)) {
      if (strict) outsideSubset(out.length + 1);
      for (let i = paragraph; i < out.length; i++) out[i]!.text = "";
      paragraph = -1;
      out.push({ heading: null, text: "", code: false });
      continue;
    }
    const heading = startsInComment ? null : HEADING_RE.exec(visible);
    const key = heading ? headingKey(heading[2]!) : "";
    if (heading) paragraph = -1;
    else if (paragraph === -1 && !INDENTED_CODE_RE.test(visible)) paragraph = out.length;
    out.push({ heading: heading && key !== "" ? { level: heading[1]!.length, key } : null, text: visible, code: false });
  }
  if (fence !== null)
    for (let i = fence.first; i < out.length; i++) {
      out[i]!.text = "";
      out[i]!.code = false;
    }
  return out;
}

export function templateSections(template: string): TemplateSection[] {
  // Only closed template comments are removed. One left open hides no later template heading, so
  // every heading outside a closed comment stays a required section.
  return splitLines(stripComments(stripFrontMatter(template)), false, true).flatMap((line) => (line.heading ? [line.heading] : []));
}

// 1-based indexes of the template's sections that the body lacks or leaves empty.
export function unfilledSections(template: string, body: string): number[] {
  const lines = splitLines(body);
  const sections = templateSections(template);
  const unfilled: number[] = [];
  const seen = new Map<string, number>();
  sections.forEach((section, index) => {
    const occurrence = seen.get(section.key) ?? 0;
    seen.set(section.key, occurrence + 1);
    let start = -1;
    for (let i = 0, found = 0; i < lines.length; i++) {
      if (lines[i]!.heading?.key !== section.key) continue;
      if (found++ === occurrence) {
        start = i;
        break;
      }
    }
    if (start === -1) {
      unfilled.push(index + 1);
      return;
    }
    // Template sections nested under this one may sit inside its body section. Every other
    // template heading ends it. A key that is both nested and not nested ends it.
    const nested = new Set<number>();
    for (let j = index + 1; j < sections.length && sections[j]!.level > section.level; j++) nested.add(j);
    const stopKeys = new Set(sections.filter((_, j) => !nested.has(j)).map((s) => s.key));
    const level = lines[start]!.heading!.level;
    let prose = "";
    let code = "";
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.heading && (line.heading.level <= level || stopKeys.has(line.heading.key))) break;
      if (line.heading) continue;
      if (line.code) code += line.text + "\n";
      else prose += line.text + "\n";
    }
    if (!hasLetterOrNumber(code) && !hasLetterOrNumber(visibleProse(prose))) unfilled.push(index + 1);
  });
  return unfilled;
}
