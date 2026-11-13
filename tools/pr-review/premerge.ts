// The premerge subcommand (#174): merge-hygiene checks on the channels a pull request's diff does
// not carry. The App reviews the diff. This checks what reaches GitHub around it: the pull request's
// state and checks, its closing references, every commit's author and committer, every commit
// message, and the pull request's title and body. A title and body reach GitHub without passing the
// pre-commit or pre-push hook, so nothing else scans them at all.
//
// Every check fails closed. A term list that resolves empty, a matcher that throws, a canary the
// matcher cannot find, and a GitHub read that fails or
// comes back in an unexpected shape are each a failure, never a pass. No output carries a matched
// value, a term or the term file's path: a failure names its channel and a count.

import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { SHA_RE, UNSAFE_CHARS, parseRepo } from "./types";

export interface PremergeCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

export interface PremergeFacts {
  state: string;
  headSha: string;
  title: string;
  body: string;
  closingIssues: number[];
  checks: { bucket: string }[];
  commits: PremergeCommit[];
  // How many commits GitHub says the pull request has, read separately from the list itself, so a
  // truncated listing cannot pass as the whole set.
  commitCount: number;
}

export interface PremergeSource {
  read(): PremergeFacts;
}

export class PremergeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PremergeReadError";
  }
}

export interface PremergeExpect {
  closes: readonly number[];
  identity: { name: string; email: string };
  expectHead: string | null;
}

export interface ChannelResult {
  channel: string;
  ok: boolean;
  // Code-authored only. Never a term, a matched string, an identity or any text read from GitHub.
  detail: string;
}

export type Matcher = (text: string, term: string) => boolean;

// Zero-width and directional characters are stripped before matching, so a term split by one still
// matches the way it renders.
function normalizeForMatch(text: string): string {
  return text.replace(UNSAFE_CHARS, "").toLowerCase();
}

export function containsTerm(text: string, term: string): boolean {
  return normalizeForMatch(text).includes(normalizeForMatch(term));
}

// GitHub's closing keywords followed by an issue reference: #N, owner/repo#N, or an issues or pull
// URL. Matched anywhere, as a substring, so prose like "this closed #120" counts. A commit message's
// prose once closed an unrelated issue here while closingIssuesReferences was empty.
export const CLOSING_KEYWORD_RE =
  /(close[sd]?|fix(e[sd])?|resolve[sd]?)[ \t]*:?[ \t]*(?:(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)?#|https?:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:issues|pull)\/)[0-9]+/i;

export const CHANNELS = {
  state: "pull request state",
  checks: "checks",
  closing: "closing references",
  commitList: "commit list",
  keywords: "closing keywords in commit messages",
  identity: "commit identity",
  termsMessages: "personal terms in commit messages",
  termsPr: "personal terms in PR title and body",
} as const;

function pass(channel: string, detail = "clean"): ChannelResult {
  return { channel, ok: true, detail };
}

function fail(channel: string, detail: string): ChannelResult {
  return { channel, ok: false, detail };
}

// The canary is read from the scanned text itself, never a phrase assumed to be present: a canary
// pinned on "Closes #" failed on the first pull request that correctly closed nothing. Each listed
// term must also match itself, so a matcher that mishandles some term's characters cannot report it
// absent everywhere.
function scanTerms(channel: string, text: string, canary: string, terms: readonly string[], matcher: Matcher): ChannelResult {
  if (terms.length === 0) return fail(channel, "the term list is empty, so the scan would measure nothing");
  if (canary.trim() === "") return fail(channel, "no text to take a canary from, so the matcher cannot be proven");
  try {
    if (!matcher(text, canary)) return fail(channel, "the canary taken from the scanned text was not found; the matcher is not working");
    let hits = 0;
    for (const term of terms) {
      if (!matcher(term, term)) return fail(channel, "the matcher cannot find a listed term in the term itself");
      if (matcher(text, term)) hits++;
    }
    if (hits > 0) return fail(channel, `${hits} listed term(s) present`);
    return pass(channel, `clean across ${terms.length} term(s)`);
  } catch {
    return fail(channel, "the matcher raised an error; the scan is not evidence");
  }
}

function sameIdentity(name: string, email: string, want: PremergeExpect["identity"]): boolean {
  return name.toLowerCase() === want.name.toLowerCase() && email.toLowerCase() === want.email.toLowerCase();
}

export function evaluatePremerge(facts: PremergeFacts, expect: PremergeExpect, terms: readonly string[], matcher: Matcher = containsTerm): ChannelResult[] {
  const results: ChannelResult[] = [];

  if (facts.state !== "OPEN") results.push(fail(CHANNELS.state, "the pull request is not open"));
  else if (!SHA_RE.test(facts.headSha)) results.push(fail(CHANNELS.state, "the head is not a full commit SHA"));
  else if (expect.expectHead !== null && expect.expectHead !== facts.headSha) results.push(fail(CHANNELS.state, "the head is not the expected commit"));
  else results.push(pass(CHANNELS.state, "open"));

  const green = facts.checks.filter((c) => c.bucket === "pass").length;
  const skipped = facts.checks.filter((c) => c.bucket === "skipping").length;
  const other = facts.checks.length - green - skipped;
  const counts = `${facts.checks.length} total, ${green} pass, ${skipped} skipping, ${other} other`;
  // No checks at all lands here too: a list with nothing green is never evidence.
  if (green === 0) results.push(fail(CHANNELS.checks, `no check passed (${counts})`));
  else if (other > 0) results.push(fail(CHANNELS.checks, `not every check is green (${counts})`));
  else results.push(pass(CHANNELS.checks, counts));

  const found = [...new Set(facts.closingIssues)].sort((a, b) => a - b);
  const want = [...new Set(expect.closes)].sort((a, b) => a - b);
  const list = (ns: number[]) => (ns.length === 0 ? "none" : ns.map((n) => `#${n}`).join(","));
  if (found.join(",") !== want.join(",")) results.push(fail(CHANNELS.closing, `found ${list(found)}, expected exactly ${list(want)}`));
  else results.push(pass(CHANNELS.closing, list(found)));

  const commits = facts.commits;
  if (commits.length === 0) results.push(fail(CHANNELS.commitList, "no commits read"));
  else if (commits.length !== facts.commitCount) results.push(fail(CHANNELS.commitList, `read ${commits.length} of ${facts.commitCount} commits`));
  else if (commits[commits.length - 1]!.sha !== facts.headSha) results.push(fail(CHANNELS.commitList, "the last commit read is not the head"));
  else results.push(pass(CHANNELS.commitList, `${commits.length} commit(s)`));

  // An empty commit list already fails the commit list channel above, so these two need no case of
  // their own for it.
  const keywordHits = commits.filter((c) => CLOSING_KEYWORD_RE.test(c.message)).length;
  results.push(keywordHits > 0 ? fail(CHANNELS.keywords, `${keywordHits} commit message(s) carry a closing keyword`) : pass(CHANNELS.keywords));

  // Author and committer are checked separately: they fail independently, and a clean email beside
  // a real name in both fields is how 30 commits once slipped past.
  const identityHits = commits.filter(
    (c) => !sameIdentity(c.authorName, c.authorEmail, expect.identity) || !sameIdentity(c.committerName, c.committerEmail, expect.identity),
  ).length;
  results.push(
    identityHits > 0 ? fail(CHANNELS.identity, `${identityHits} commit(s) carry an author or committer other than the expected identity`) : pass(CHANNELS.identity),
  );

  const messages = commits.map((c) => c.message).join("\n");
  const firstLine = commits.length === 0 ? "" : (commits[0]!.message.split(/\r?\n/).find((line) => line.trim() !== "") ?? "");
  results.push(scanTerms(CHANNELS.termsMessages, messages, firstLine.trim(), terms, matcher));
  results.push(scanTerms(CHANNELS.termsPr, `${facts.title}\n${facts.body}`, facts.title.trim(), terms, matcher));

  return results;
}

export function formatPremerge(pr: number, headSha: string, results: readonly ChannelResult[]): string {
  const ok = results.every((r) => r.ok);
  const head = SHA_RE.test(headSha) ? headSha : "unknown";
  const lines = [`premerge #${pr}  head=${head}`];
  for (const r of results) lines.push(`  ${r.channel}: ${r.ok ? "ok" : "FAIL"} (${r.detail})`);
  lines.push(ok ? `PREMERGE OK  #${pr}  head=${head}` : `PREMERGE BLOCKED  #${pr}`);
  return lines.join("\n");
}

export type TermsLoad = { ok: true; terms: string[] } | { ok: false; reason: string };

const MAX_TERMS_FILE_BYTES = 64 * 1024;

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// The operator's personal-term list, in the shape the personal-term gate reads ({"terms": [...]};
// other keys are ignored). It must sit outside every git checkout, so a `git add -A` can never
// publish it. Reasons name neither the path nor any term.
export function loadTerms(path: string): TermsLoad {
  if (typeof path !== "string" || !isAbsolute(path)) return { ok: false, reason: "the term file path must be absolute" };
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    return { ok: false, reason: "the term file cannot be read" };
  }
  for (let dir = dirname(real); ; ) {
    try {
      lstatSync(join(dir, ".git"));
      return { ok: false, reason: "the term file sits inside a git checkout; keep it outside every checkout" };
    } catch (error) {
      if (!isMissing(error)) return { ok: false, reason: "a directory above the term file cannot be checked for a git checkout" };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  let parsed: unknown;
  try {
    let fd: number;
    try {
      fd = openSync(real, "r");
    } catch (error) {
      // A directory fails to open on some platforms. The fstat check below covers the rest.
      if ((error as NodeJS.ErrnoException)?.code === "EISDIR") return { ok: false, reason: "the term file is not a regular file" };
      throw error;
    }
    let raw: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { ok: false, reason: "the term file is not a regular file" };
      if (stat.size > MAX_TERMS_FILE_BYTES) return { ok: false, reason: "the term file is too large" };
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_TERMS_FILE_BYTES) return { ok: false, reason: "the term file is too large" };
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "the term file cannot be read as JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "the term file is not a JSON object" };
  const list = (parsed as Record<string, unknown>).terms;
  if (!Array.isArray(list)) return { ok: false, reason: 'the term file has no "terms" array' };
  if (list.length === 0) return { ok: false, reason: "the term list is empty; a list naming nothing checks nothing" };
  const terms: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") return { ok: false, reason: "the term list holds a non-string entry" };
    const term = entry.trim();
    if (normalizeForMatch(term) === "") return { ok: false, reason: "the term list holds a blank entry, which would match everything" };
    terms.push(term);
  }
  return { ok: true, terms };
}

export type GhRunner = (args: string[]) => { exitCode: number; stdout: string };

const realGh: GhRunner = (args) => {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString() };
};

function readJson(gh: GhRunner, args: string[], what: string, okCodes: readonly number[] = [0]): unknown {
  const { exitCode, stdout } = gh(args);
  if (!okCodes.includes(exitCode)) throw new PremergeReadError(`could not read ${what} (gh exited ${exitCode})`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PremergeReadError(`could not read ${what} (gh printed something other than JSON)`);
  }
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new PremergeReadError(`could not read ${what} (unexpected shape)`);
  return value;
}

function obj(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PremergeReadError(`could not read ${what} (unexpected shape)`);
  return value as Record<string, unknown>;
}

function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new PremergeReadError(`could not read ${what} (unexpected shape)`);
  return value;
}

// Reads through the gh CLI, with whatever token GH_TOKEN or gh's active account supplies. Every call
// names the repository, so the working directory does not matter.
export function ghPremergeSource(repo: string, pr: number, gh: GhRunner = realGh): PremergeSource {
  if (parseRepo(repo) === null) throw new PremergeReadError("the repository must be given as owner/name");
  const n = String(pr);
  return {
    read(): PremergeFacts {
      const view = obj(
        readJson(gh, ["pr", "view", n, "-R", repo, "--json", "state,headRefOid,title,body,closingIssuesReferences"], "the pull request"),
        "the pull request",
      );
      const closingIssues = arr(view.closingIssuesReferences, "the closing references").map((ref) => {
        const num = obj(ref, "the closing references").number;
        if (typeof num !== "number" || !Number.isSafeInteger(num)) throw new PremergeReadError("could not read the closing references (unexpected shape)");
        return num;
      });

      // gh pr checks exits 1 when a check failed and 8 when one is pending, and still prints the
      // list. Any other status, or output that is not a JSON array, is a failed read.
      const checks = arr(readJson(gh, ["pr", "checks", n, "-R", repo, "--json", "name,bucket"], "the checks", [0, 1, 8]), "the checks").map((c) => ({
        bucket: str(obj(c, "the checks").bucket, "the checks"),
      }));

      const pages = arr(readJson(gh, ["api", `repos/${repo}/pulls/${n}/commits?per_page=100`, "--paginate", "--slurp"], "the commits"), "the commits");
      const commits = pages.flatMap((page) =>
        arr(page, "the commits").map((entry) => {
          const e = obj(entry, "the commits");
          const c = obj(e.commit, "the commits");
          const author = obj(c.author, "the commit authors");
          const committer = obj(c.committer, "the commit committers");
          return {
            sha: str(e.sha, "the commits"),
            authorName: str(author.name, "the commit authors"),
            authorEmail: str(author.email, "the commit authors"),
            committerName: str(committer.name, "the commit committers"),
            committerEmail: str(committer.email, "the commit committers"),
            message: str(c.message, "the commit messages"),
          };
        }),
      );

      const pull = obj(readJson(gh, ["api", `repos/${repo}/pulls/${n}`], "the pull request's commit count"), "the pull request's commit count");
      const commitCount = pull.commits;
      if (typeof commitCount !== "number" || !Number.isSafeInteger(commitCount)) throw new PremergeReadError("could not read the pull request's commit count (unexpected shape)");
      const headSha = str(view.headRefOid, "the head");
      if (str(obj(pull.head, "the head").sha, "the head") !== headSha) throw new PremergeReadError("the pull request's head moved while it was being read");

      return {
        state: str(view.state, "the pull request state"),
        headSha,
        title: str(view.title, "the pull request title"),
        body: str(view.body, "the pull request body"),
        closingIssues,
        checks,
        commits,
        commitCount,
      };
    },
  };
}
