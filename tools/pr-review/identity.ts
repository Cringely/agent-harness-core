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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "the identity file exists but could not be read as JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "the identity file is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
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

// existsSync follows symlinks, so a dangling symlink at this path used to read as absent and a
// declared identity dropped silently to the undeclared state. lstat classifies without following:
// ENOENT means truly absent; anything else it finds, a dangling link included, goes on to
// readFileSync, whose own failure refuses.
function identityFileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Absent account state, or state without an email (an API-key login, say), adds nothing, and a
// posting run then needs an email from the identity file (pipeline.ts). State that exists but is
// not JSON refuses, because the address the model sees cannot be known.
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

// Strips code points GitHub renders invisibly (soft hyphen, several other format and ignorable
// marks, tag characters, C1 controls) so a term hidden by one of them inside an otherwise-visible
// string still matches. Applied to both the haystack and each term below; a hit in either the raw
// text or its stripped form counts once.
function canon(text: string): string {
  return text.replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu, "");
}

function matches(text: string, canonText: string, term: string): boolean {
  if (term.trim() === "") return false;
  // Word-character lookarounds rather than \b, so a term that starts or ends with punctuation
  const raw = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`, "i");
  if (raw.test(text)) return true;
  const canonTerm = canon(term);
  if (canonTerm.trim() === "") return false;
  const stripped = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(canonTerm)}(?![A-Za-z0-9_])`, "i");
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
