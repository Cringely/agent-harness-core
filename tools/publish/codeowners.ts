// CODEOWNERS matching for review-merge's administrator bypass (#274). merge-decision.ts takes the
// bypass only when a changed file is code-owned at the base commit, so this answers one question:
// does any of these paths have an owner under this file?
//
// GitHub reads CODEOWNERS with gitignore-style patterns, the last matching line wins, and a line
// whose pattern has no owners leaves its paths unowned. This parser accepts only the form this
// repository's .github/CODEOWNERS uses: a pattern anchored at the root with a leading "/", made of
// literal path characters, with an optional trailing "/" for a directory. Without the trailing "/"
// the pattern names a file or a directory of that name. Everything else refuses rather than
// matching nothing: wildcards, "!" negation, "\" escapes, "[ ]" ranges, unanchored patterns, and an
// owner that is not @user, @org/team or an email. GitHub skips a line it cannot parse, so reading
// such a line as an owner would claim ownership GitHub does not see, and skipping it here could hide
// a later line that unowns a path. Paths compare case-sensitively, as GitHub's do.

export interface CodeownersRule {
  // The anchored literal without its leading "/" or trailing "/".
  path: string;
  dirOnly: boolean;
  owners: string[];
}

export type CodeownersParse = { ok: true; rules: CodeownersRule[] } | { ok: false; line: number };

const PATTERN_RE = /^\/[A-Za-z0-9._\/-]+$/;
const OWNER_RE = /^(?:@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

export function parseCodeowners(text: string): CodeownersParse {
  const rules: CodeownersRule[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/[ \t]+/);
    const segments = pattern!.slice(1).replace(/\/$/, "").split("/");
    if (!PATTERN_RE.test(pattern!) || segments.some((s) => s === "" || s === "." || s === "..")) {
      return { ok: false, line: i + 1 };
    }
    if (!owners.every((owner) => OWNER_RE.test(owner))) return { ok: false, line: i + 1 };
    rules.push({ path: segments.join("/"), dirOnly: pattern!.endsWith("/"), owners });
  }
  return { ok: true, rules };
}

function matches(rule: CodeownersRule, file: string): boolean {
  return file.startsWith(`${rule.path}/`) || (!rule.dirOnly && file === rule.path);
}

// True when the last rule matching the path names at least one owner.
export function isOwned(rules: readonly CodeownersRule[], file: string): boolean {
  let owners: string[] | null = null;
  for (const rule of rules) if (matches(rule, file)) owners = rule.owners;
  return owners !== null && owners.length > 0;
}
