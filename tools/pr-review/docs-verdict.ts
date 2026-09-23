// Finds the pull request body's Docs verdict line, the format CONTRIBUTING.md defines under
// #217: "Docs: README still accurate: <what was checked>" or "Docs: README updated: <what
// changed>", each with a non-empty tail. The matcher only reads text. It never executes anything,
// is never interpolated into a shell command or into the model prompt as an instruction, and its
// result never reaches computeEvent (verdict.ts's computeEvent stays on its three inputs, #120's
// pinned property, unchanged by this file). render.ts renders whatever this returns into the
// posted review body, quoted through fenced() like every other pull-request-supplied string.

export const DOCS_VERDICT_FORMS = [
  "Docs: README still accurate: <what was checked>",
  "Docs: README updated: <what changed>",
] as const;

const DOCS_VERDICT_LINE_RE = /^Docs: README (?:still accurate|updated): (.*)$/;

// The literal placeholder text from the two forms above. A body that pastes the form unfilled
// must not read as a real verdict.
const DOCS_VERDICT_PLACEHOLDERS: ReadonlySet<string> = new Set(["<what was checked>", "<what changed>"]);

// Returns the first qualifying line exactly as written in the body (line-ending stripped), or
// null when no line matches one of the two forms with a non-empty, non-placeholder tail. Scans
// every line, so a verdict line buried mid-body is still found, and splits on any of \r\n, \r or
// \n so a CRLF body (a Windows checkout, a pasted PR description) is read the same as an LF one.
export function findDocsVerdictLine(body: string): string | null {
  for (const line of body.split(/\r\n|\r|\n/)) {
    const match = DOCS_VERDICT_LINE_RE.exec(line);
    if (match === null) continue;
    const tail = match[1]!.trim();
    if (tail === "" || DOCS_VERDICT_PLACEHOLDERS.has(tail)) continue;
    return line;
  }
  return null;
}
