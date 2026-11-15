// Checks a body against a repository's PR or issue template (#274). Every heading in the template
// is a section the body must carry, by heading text at any level, with text GitHub would show
// under it. Whitespace, HTML comments (a body comment never closed hides the rest of the body,
// headings included), fence lines and every line of a fence that never closes do not count. A
// closed fence holding a non-blank line counts, because GitHub shows that line as code. A body
// section ends at the next heading at its own level or above, and also at the next heading that
// names any template section other than one nested under it in the template. Body heading depth
// is the author's choice, so without that second boundary a body using a shallower heading would
// swallow the next template section's content and an empty section would read as filled. The nth
// template section with a given heading matches the nth body heading with that text, so one body
// section never fills two template sections. The template's own instruction comments are
// stripped first, so leaving them in place does not count as filling the section. Headings inside
// fenced code are not headings, and a fence closes only on a line of the same character, at least
// as long, with nothing after it.
//
// Only section indexes come back, never heading or body text.

export interface TemplateSection {
  level: number;
  key: string;
}

interface Line {
  heading: TemplateSection | null;
  text: string;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
// CommonMark fences: a backtick info string holds no backtick, and a closing fence repeats the
// opening character at least as many times with nothing after it but spaces and tabs.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

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
// hidden by a comment, and for every line of a fence that never closes. A closed fence counts as
// content when a line in it holds something other than whitespace, since GitHub shows it as code.
function splitLines(text: string, readComments = true): Line[] {
  const out: Line[] = [];
  const comment = { open: false };
  let fence: { mark: string; length: number; first: number } | null = null;
  // A leading byte-order mark (Windows PowerShell 5.1's Set-Content writes one) would otherwise
  // hide a heading on the first line.
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(raw);
      if (close && close[1]![0] === fence.mark && close[1]!.length >= fence.length) {
        fence = null;
        out.push({ heading: null, text: "" });
      } else {
        out.push({ heading: null, text: raw });
      }
      continue;
    }
    const startsInComment = comment.open;
    // An info string is not parsed for comments, so a fence opens even with "<!--" after it.
    const open = startsInComment ? null : FENCE_OPEN_RE.exec(raw);
    if (open) {
      fence = { mark: open[1]![0]!, length: open[1]!.length, first: out.length + 1 };
      out.push({ heading: null, text: "" });
      continue;
    }
    const visible = readComments ? outsideComments(raw, comment) : raw;
    const heading = startsInComment ? null : HEADING_RE.exec(visible);
    const key = heading ? headingKey(heading[2]!) : "";
    out.push({ heading: heading && key !== "" ? { level: heading[1]!.length, key } : null, text: visible });
  }
  if (fence !== null) for (let i = fence.first; i < out.length; i++) out[i]!.text = "";
  return out;
}

export function templateSections(template: string): TemplateSection[] {
  // Only closed template comments are removed. One left open hides no later template heading, so
  // every heading outside a closed comment stays a required section.
  return splitLines(stripComments(stripFrontMatter(template)), false).flatMap((line) => (line.heading ? [line.heading] : []));
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
    let content = "";
    for (let i = start + 1; i < lines.length; i++) {
      const heading = lines[i]!.heading;
      if (heading && (heading.level <= level || stopKeys.has(heading.key))) break;
      if (heading) continue;
      content += lines[i]!.text;
    }
    if (content.trim() === "") unfilled.push(index + 1);
  });
  return unfilled;
}
