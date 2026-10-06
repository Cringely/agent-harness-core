// Checks a body against a repository's PR or issue template (#274). Every heading in the template
// is a section the body must carry, by heading text at any level, with something other than
// whitespace and HTML comments under it before the next heading at the same level or above. The
// template's own instruction comments are stripped first, so leaving them in place does not count
// as filling the section. Headings inside fenced code are not headings.
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
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function stripFrontMatter(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

function headingKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  // A leading byte-order mark (Windows PowerShell 5.1's Set-Content writes one) would otherwise
  // hide a heading on the first line.
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(raw);
    if (fenceMatch) {
      const mark = fenceMatch[1]![0]!;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      out.push({ heading: null, text: raw });
      continue;
    }
    const heading = fence === null ? HEADING_RE.exec(raw) : null;
    const key = heading ? headingKey(heading[2]!) : "";
    out.push({ heading: heading && key !== "" ? { level: heading[1]!.length, key } : null, text: raw });
  }
  return out;
}

export function templateSections(template: string): TemplateSection[] {
  return splitLines(stripComments(stripFrontMatter(template))).flatMap((line) => (line.heading ? [line.heading] : []));
}

// 1-based indexes of the template's sections that the body lacks or leaves empty.
export function unfilledSections(template: string, body: string): number[] {
  const lines = splitLines(stripComments(body));
  const unfilled: number[] = [];
  templateSections(template).forEach((section, index) => {
    const start = lines.findIndex((line) => line.heading?.key === section.key);
    if (start === -1) {
      unfilled.push(index + 1);
      return;
    }
    const level = lines[start]!.heading!.level;
    let content = "";
    for (let i = start + 1; i < lines.length; i++) {
      const heading = lines[i]!.heading;
      if (heading && heading.level <= level) break;
      if (heading) continue;
      content += lines[i]!.text;
    }
    if (content.trim() === "") unfilled.push(index + 1);
  });
  return unfilled;
}
