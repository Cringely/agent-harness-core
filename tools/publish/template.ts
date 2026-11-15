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
// one body section never fills two template sections. Comments in a body never count, so leaving
// the template's instruction comments in place does not fill a section.
//
// The template side reads a deliberately narrow line grammar rather than approximating CommonMark,
// because every CommonMark construct it approximates is a place a heading can hide. After a
// byte-order mark is stripped and CRLF and lone CR become LF, every template line is one of these:
//   - blank
//   - a column-0 ATX heading: 1 to 6 "#", one space, then text
//   - part of an HTML comment that opens at column 0 with "<!--" and whose first "-->" ends a
//     line, with nothing else on the opening or closing line, and whose body holds neither
//     "--!>" (where HTML5 also ends a comment) nor a second "<!--"
//   - YAML front matter fenced by "---" lines at the very top, with no line in it starting with
//     "#". Front matter is read as issue-template metadata, which GitHub strips before it renders
//     the issue, so its lines never count as sections. PR templates carry no front matter.
//   - a prose line starting with a letter, number, backtick, quote mark or "(", or with a list
//     marker ("-", "*", "+", or digits and "." or ")"), a space, then one of those or "["
// Outside a comment and front matter, no line may hold "<" or ">" anywhere, because GitHub
// renders raw HTML mid-line, a heading tag included. A template holding any other line, such as
// one starting with an HTML tag, a blockquote marker, leading whitespace, a pipe, a fence or a
// setext underline, refuses with PublishRefusal. The
// grammar is drawn so that a line is a heading in GitHub's rendering when and only when it is a
// heading here, so no template section goes unrequired. Body text is read as described above, so
// in a body an indented ATX heading or a setext heading is neither a section nor content.
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

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
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

// The key a heading is matched by, from the text after its opening "#" run and the space after
// it. Template and body headings both go through here, so the two sides cannot read one heading
// differently. A closing "#" run counts only when a space or tab comes before it, or when it is
// the whole text, as in CommonMark, so "C#" keeps its hash and "Source ##" drops its run.
function headingKey(content: string): string {
  return content
    .replace(/(?:^|[ \t]+)#+[ \t]*$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
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
// carry code: true. No line inside an HTML block is a heading. A heading outside the subset shows
// no text.
function splitLines(text: string): Line[] {
  const out: Line[] = [];
  // Index of the first line of the open paragraph, or -1 when none is open.
  let paragraph = -1;
  const comment = { open: false };
  let fence: { mark: string; length: number; first: number } | null = null;
  let html: HtmlBlock | null = null;
  for (const raw of normalize(text).split("\n")) {
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
        out.push({ heading: null, text: outsideComments(raw, comment), code: false });
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
    const visible = outsideComments(raw, comment);
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
      paragraph = -1;
      out.push({ heading: null, text: "", code: false });
      continue;
    }
    if (!startsInComment && paragraph !== -1 && SETEXT_UNDERLINE_RE.test(visible)) {
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

// A leading byte-order mark (Windows PowerShell 5.1's Set-Content writes one) would otherwise
// hide a heading on the first line. GitHub reads a lone CR as a line ending, as it does CRLF.
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

const TEMPLATE_HEADING_RE = /^(#{1,6}) (.*)$/;
const FRONT_MATTER_FENCE_RE = /^---[ \t]*$/;
// What may open a prose line, and what may follow a list marker and its space.
const PROSE_RE = /^[\p{L}\p{N}`"'(]/u;
// A task list item's "[ ]" is safe after a list marker: no block construct opens with "[".
const LIST_ITEM_RE = /^(?:[-*+]|[0-9]{1,9}[.)]) [\p{L}\p{N}`"'([]/u;
const LIST_MARKER_RE = /^(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)/;
const FENCE_RE = /^`{3,}/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const COMMENT_ALT_CLOSE = "--!>";

function refuseLine(lineNumber: number, what: string): never {
  throw new PublishRefusal(
    `the template's line ${lineNumber} is ${what}, outside the narrow grammar this tool reads templates with: blank lines, "#" headings at column 0, whole-line HTML comments, front matter and plain prose`,
  );
}

// The template's sections, read under the line grammar in the header. Throws PublishRefusal on
// any line outside it.
export function templateSections(template: string): TemplateSection[] {
  const lines = normalize(template).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const sections: TemplateSection[] = [];
  let i = 0;
  if (lines.length > 0 && FRONT_MATTER_FENCE_RE.test(lines[0]!)) {
    i = 1;
    while (i < lines.length && !FRONT_MATTER_FENCE_RE.test(lines[i]!)) {
      // Where front matter is not stripped, GitHub renders a "#" line in it as a heading.
      if (lines[i]!.startsWith("#")) refuseLine(i + 1, 'a front matter line starting with "#"');
      i++;
    }
    if (i === lines.length) refuseLine(1, "front matter that never closes");
    i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (/^[ \t]*$/.test(line)) continue;
    if (line.startsWith(COMMENT_OPEN)) {
      // GitHub ends the comment at the first "-->", which may overlap the opener as in "<!-->".
      let at = line.indexOf(COMMENT_CLOSE, 2);
      let j = i;
      while (at === -1) {
        if (++j === lines.length) refuseLine(n, "an HTML comment that never closes");
        at = lines[j]!.indexOf(COMMENT_CLOSE);
      }
      const closing = lines[j]!;
      if (j === i && at < COMMENT_OPEN.length) refuseLine(n, "an HTML comment closed inside its own opener");
      if (closing.slice(at + COMMENT_CLOSE.length).trim() !== "")
        refuseLine(j + 1, "an HTML comment with text after its close");
      // HTML5 also ends a comment at "--!>", and a nested opener invites the same confusion over
      // where it ends, so a body holding either could show text as rendered markup.
      const body =
        j === i
          ? line.slice(COMMENT_OPEN.length, at)
          : [line.slice(COMMENT_OPEN.length), ...lines.slice(i + 1, j), closing.slice(0, at)].join("\n");
      if (body.includes(COMMENT_ALT_CLOSE)) refuseLine(n, 'an HTML comment holding "--!>"');
      if (body.includes(COMMENT_OPEN)) refuseLine(n, "an HTML comment holding a second opener");
      i = j;
      continue;
    }
    // GitHub renders raw HTML anywhere in a line, a heading tag included, so outside a comment no
    // template line may hold an angle bracket.
    if (/[<>]/.test(line)) refuseLine(n, "a line holding an angle bracket");
    const heading = TEMPLATE_HEADING_RE.exec(line);
    if (heading) {
      const key = headingKey(heading[2]!);
      if (key === "") refuseLine(n, "an empty heading");
      sections.push({ level: heading[1]!.length, key });
      continue;
    }
    if (FENCE_RE.test(line)) refuseLine(n, "a code fence");
    if (LIST_MARKER_RE.test(line)) {
      if (!LIST_ITEM_RE.test(line)) refuseLine(n, "a list item that does not open with plain text");
      continue;
    }
    if (PROSE_RE.test(line)) continue;
    refuseLine(n, "a line that opens with neither text nor a heading");
  }
  return sections;
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
