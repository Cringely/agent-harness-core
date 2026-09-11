// Refuses to post a review body that carries an identifying string. security.md requires a
// generator of public payloads to carry this as its own gate rather than trust a scrub somewhere
// upstream, and the review body is posted to a public repository.
//
// Three states, matching the git identity gate README.md describes. No identity file: the
// username and hostname are still checked. File present but unreadable, malformed, or declaring
// nothing: refuse, because something was declared and cannot be seen. File present and valid:
// check every declared name and email plus the username and hostname.
//
// One more source, whatever the file says: the claude CLI's own account state. The CLI keeps the
// logged-in account in .claude.json and gives the reviewing model that account's email in a
// "# userEmail" block, and in one verification run the model copied the block into
// observed_instructions (captured 2026-09-11, CLI 2.1.268). So that exact address joins the emails
// scanned for. It is read at run time and never logged, printed or placed in a refusal reason.
// accountEmail reports only whether that read produced an address; it never comes from the
// identity file's own declared emails, so an identity file with an email cannot satisfy the check
// review --post makes for the CLI's account email (Task 8).
//
// Hits are reported by class and index, never by the string, so a refusal message cannot publish
// what it caught.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export interface IdentityDecl {
  names: string[];
  emails: string[];
  username: string;
  hostname: string;
}

export type IdentityLoad =
  | { ok: true; decl: IdentityDecl; declared: boolean; accountEmail: boolean }
  | { ok: false; reason: string };

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const trimmed = value.map((item) => (typeof item === "string" ? item.trim() : null));
  return trimmed.every((item): item is string => item !== null && item !== "") ? trimmed : null;
}

// The identity file's shape is exactly { names, emails } (core/claude/hooks/identity-patterns.sh),
// so any other top-level key is a typo the operator would want surfaced, not a file to accept
// silently while quietly dropping the misspelled channel (I5).
function hasExtraKey(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => key !== "names" && key !== "emails");
}

// JSON.parse keeps only the last value of a repeated key, so a duplicate is invisible once
// parsed; this checks the raw text instead, before parsing throws that information away (I5).
function hasDuplicateKey(raw: string): boolean {
  const namesKeyRe = /"names"\s*:/g;
  const emailsKeyRe = /"emails"\s*:/g;
  return (raw.match(namesKeyRe) ?? []).length > 1 || (raw.match(emailsKeyRe) ?? []).length > 1;
}

// CLAUDE_CONFIG_DIR mirrors the child claude CLI's own lookup rather than adding a new seam of its
// own: the reviewer's claude child resolves .claude.json the same way, so this has to agree with
// that resolution. An explicit home (test-only; cli.ts never passes it) wins over everything else.
// A CLAUDE_CONFIG_DIR that is set but empty, or set but relative, refuses instead of guessing,
// because which file the child actually reads cannot be known from here: empty resolves against
// this process's cwd, and relative resolves against a cwd that need not match the child's.
export function accountStateDir(
  home: string | undefined,
  env: Record<string, string | undefined>,
): { ok: true; dir: string } | { ok: false; reason: string } {
  if (home !== undefined) return { ok: true, dir: home };
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir === undefined) return { ok: true, dir: homedir() };
  const trimmed = configDir.trim();
  if (trimmed === "" || !isAbsolute(trimmed)) {
    return {
      ok: false,
      reason: "CLAUDE_CONFIG_DIR is set but empty or relative, so the claude CLI's account state cannot be located",
    };
  }
  return { ok: true, dir: trimmed };
}

export function loadIdentity(
  options: { home?: string; username?: string; host?: string; env?: Record<string, string | undefined> } = {},
): IdentityLoad {
  const path = join(options.home ?? homedir(), ".claude-account-identity.json");
  const username = options.username ?? userInfo().username;
  const host = options.host ?? hostname();

  const dir = accountStateDir(options.home, options.env ?? process.env);
  if (!dir.ok) return dir;
  const account = readAccountEmail(dir.dir);
  if (!account.ok) return account;
  const accountEmail = account.email !== null;
  const accountEmails = account.email === null ? [] : [account.email];

  if (!identityFileExists(path)) {
    return { ok: true, declared: false, accountEmail, decl: { names: [], emails: accountEmails, username, hostname: host } };
  }
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(path, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "the identity file exists but could not be read as JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "the identity file is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (hasExtraKey(record)) {
    return { ok: false, reason: "the identity file has a key other than names and emails" };
  }
  if (hasDuplicateKey(raw)) {
    return { ok: false, reason: "the identity file repeats the names or emails key" };
  }
  const names = stringList(record.names);
  const emails = stringList(record.emails);
  if (names === null || emails === null) {
    return { ok: false, reason: "the identity file's names and emails must be arrays of non-empty strings" };
  }
  if (names.length === 0 && emails.length === 0) {
    return { ok: false, reason: "the identity file declares no names and no emails" };
  }
  return {
    ok: true,
    declared: true,
    accountEmail,
    decl: { names, emails: [...emails, ...accountEmails], username, hostname: host },
  };
}

// lstat classifies without following a symlink: ENOENT means truly absent. Any other error
// (EACCES on a parent directory, EPERM, EIO from a cloud-placeholder or network-backed profile,
// EBUSY, ENOTDIR) means something is there that could not be inspected, and that is not the same
// as absent (C1): it goes on to readFileSync, whose own failure refuses.
function identityFileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

// Absent account state, or state without an email (an API-key login, say), adds nothing and
// leaves accountEmail false, and review --post refuses on that (Task 8, F3). An email in the
// identity file does not substitute. State that exists but is not JSON refuses, because the
// address the model sees cannot be known.
function readAccountEmail(dir: string): { ok: true; email: string | null } | { ok: false; reason: string } {
  const path = join(dir, ".claude.json");
  if (!existsSync(path)) return { ok: true, email: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "the claude CLI's account state (.claude.json) exists but could not be read as JSON" };
  }
  const email = (parsed as { oauthAccount?: { emailAddress?: unknown } | null } | null)?.oauthAccount?.emailAddress;
  return { ok: true, email: typeof email === "string" && email.trim() !== "" ? email.trim() : null };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strips code points and whitespace variation that GitHub's markdown renderer treats as
// equivalent or invisible, so a term hidden or reshaped that way inside an otherwise-visible
// fenced field still matches (A4.3, widened by I2 and I3). NFKC folds compatibility forms (the
// Kelvin sign, full-width letters, the fi ligature) and composes combining marks, so a
// declaration typed in one normalization form matches text typed in the other. Every run of
// space-like or line-breaking whitespace collapses to one ASCII space before the
// invisible-character strip runs, because a fenced field always opens with a newline (render.ts)
// and stripping that newline outright, instead of turning it into a space first, would glue a
// term to whatever sits on the far side of the line break. Order matters: whitespace maps to a
// space first, invisible marks strip second (a BOM is Cf rather than Zs, so it is removed rather
// than turned into a space), then runs of the resulting spaces collapse to one.
function canon(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029]+/gu, " ")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu, "")
    .replace(/ +/g, " ");
}

function matches(text: string, canonText: string, term: string): boolean {
  const trimmedTerm = term.trim();
  if (trimmedTerm === "") return false;
  // Word-character lookarounds rather than \b, so a term that starts or ends with punctuation
  // still anchors on its letters. The class excludes underscore too (I4): "fixtureuser_old" and
  // "_fixture@example.test_" need to anchor on the letters despite the underscore beside them,
  // which a plain word-boundary treats as a letter. Both patterns carry "u" (I3) so unicode
  // property escapes and full case folding apply, alongside "i" for plain case-insensitivity.
  const raw = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(trimmedTerm)}(?![A-Za-z0-9])`, "iu");
  if (raw.test(text)) return true;
  const canonTerm = canon(trimmedTerm).trim();
  if (canonTerm === "") return false;
  const stripped = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(canonTerm)}(?![A-Za-z0-9])`, "iu");
  return stripped.test(canonText);
}

export function findIdentityHits(text: string, decl: IdentityDecl): string[] {
  const canonText = canon(text);
  const hits: string[] = [];
  const check = (label: string, ...terms: string[]) => {
    if (terms.some((term) => matches(text, canonText, term))) hits.push(label);
  };
  decl.names.forEach((name, i) => check(`declared name #${i + 1}`, name));
  decl.emails.forEach((email, i) => check(`email #${i + 1}`, email));
  check("workstation username", decl.username);
  // os.hostname() can return an FQDN on some platforms; a body carrying only the short label
  // still has to hit (A4.6), so the first label is checked alongside the full name.
  const hostTerms = decl.hostname.includes(".") ? [decl.hostname, decl.hostname.split(".")[0]!] : [decl.hostname];
  check("machine hostname", ...hostTerms);
  return hits;
}
