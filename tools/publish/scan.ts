// The text gates every publish runs before anything leaves the machine (#274).
//
// scanText refuses identifying strings (the PR reviewer's matcher, tools/pr-review/identity.ts,
// reused rather than copied), a Claude Code session link, an attribution line, and text that did
// not decode as UTF-8. Hits come back as "<field>: <class>" labels and never as the matched text,
// so a refusal cannot republish what it caught. identity.ts strips invisible characters itself
// before it matches. The session link and attribution checks run over the text as written and over
// a copy with invisible characters removed, so a zero-width character inside the URL or the
// trailer does not slip past.
//
// A body file is read as UTF-8. A UTF-16 file (what Windows PowerShell 5.1 writes with > and
// Out-File) then decodes with a NUL after every ASCII letter and a replacement character for each
// byte that was not UTF-8, which no pattern here matches, so a hidden attribution line or closing
// keyword would pass every gate while gh still sent the bytes. Such text is refused outright
// rather than guessed at: any replacement character, and any C0 or C1 control character other
// than tab, line feed and carriage return.
//
// findClosingRefs reads GitHub's closing keywords (close, closes, closed, fix, fixes, fixed,
// resolve, resolves, resolved) followed by an issue reference, with any whitespace (newlines and
// no-break spaces included) between the two, over the text as written and over the copy with
// invisible characters removed. It deliberately counts keywords inside code spans and fences too.
// Every choice errs toward matching: that can refuse a body GitHub would not act on, never the
// reverse.

import { findIdentityHits, type IdentityDecl } from "../pr-review/identity";
import { UsageError } from "./errors";

export interface TextField {
  label: string;
  text: string;
}

const SESSION_LINK_RE = /claude\.ai\/code\/session_/i;

const ATTRIBUTION: ReadonlyArray<readonly [string, RegExp]> = [
  ["Co-Authored-By line", /^[ \t>]*co-authored-by[ \t]*:/im],
  ["Claude-Session line", /^[ \t>]*claude-session[ \t]*:/im],
  // A line opening with "Generated with", after any run of non-letters (an emoji, a bullet, a
  // quote marker). Mid-sentence prose ("the file is generated with bun") does not match.
  ["Generated-with line", /^[^\p{L}\p{N}\n]*generated with\b/imu],
];

function stripInvisible(text: string): string {
  return text.normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, "");
}

const TEXT_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);
const REPLACEMENT_CHARACTER = 0xfffd;

function hasUndecodableText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === REPLACEMENT_CHARACTER) return true;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (control && !TEXT_CONTROLS.has(code)) return true;
  }
  return false;
}

export function scanText(fields: readonly TextField[], identity: IdentityDecl): string[] {
  const hits = new Set<string>();
  for (const { label, text } of fields) {
    if (hasUndecodableText(text)) hits.add(`${label}: control or undecodable character`);
    const visible = stripInvisible(text);
    for (const hit of findIdentityHits(text, identity)) hits.add(`${label}: ${hit}`);
    if (SESSION_LINK_RE.test(text) || SESSION_LINK_RE.test(visible)) hits.add(`${label}: session link`);
    for (const [cls, re] of ATTRIBUTION) {
      if (re.test(text) || re.test(visible)) hits.add(`${label}: ${cls}`);
    }
  }
  return [...hits];
}

export interface ClosingRef {
  repo: string;
  number: number;
}

const CLOSING_RE =
  /(?<![A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![A-Za-z0-9_])\s*:?\s*(?:#(\d+)|gh-(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+))/gi;

export function findClosingRefs(text: string, repo: string): ClosingRef[] {
  const refs = new Map<string, ClosingRef>();
  // Both the text as written and a copy with invisible characters removed, results merged, so a
  // zero-width gap inside the keyword or between it and the reference cannot hide a match.
  for (const source of [text, stripInvisible(text)]) {
    for (const match of source.matchAll(CLOSING_RE)) {
      const [, hash, gh, crossRepo, crossNumber, urlRepo, urlNumber] = match;
      const target = (crossRepo ?? urlRepo ?? repo).toLowerCase();
      const number = Number(hash ?? gh ?? crossNumber ?? urlNumber);
      refs.set(`${target}#${number}`, { repo: target, number });
    }
  }
  return [...refs.values()];
}

// "--closes 12,34". An absent or empty value declares nothing, so no closing keyword is allowed.
export function parseClosesList(value: string | undefined): number[] {
  if (value === undefined || value.trim() === "") return [];
  const numbers = value.split(",").map((part) => part.trim());
  if (!numbers.every((part) => /^[1-9][0-9]{0,9}$/.test(part))) {
    throw new UsageError("--closes takes a comma-separated list of issue numbers, such as 12,34");
  }
  return [...new Set(numbers.map(Number))];
}

export function compareClosing(
  found: readonly ClosingRef[],
  declared: readonly number[],
  repo: string,
): { ok: true } | { ok: false; reason: string } {
  const own = repo.toLowerCase();
  if (found.some((ref) => ref.repo !== own)) {
    return { ok: false, reason: "a closing keyword names another repository" };
  }
  const foundSet = new Set(found.map((ref) => ref.number));
  const declaredSet = new Set(declared);
  const undeclared = [...foundSet].filter((n) => !declaredSet.has(n)).length;
  const missing = [...declaredSet].filter((n) => !foundSet.has(n)).length;
  if (undeclared === 0 && missing === 0) return { ok: true };
  return { ok: false, reason: `closing keywords do not match --closes (undeclared: ${undeclared}, missing: ${missing})` };
}
