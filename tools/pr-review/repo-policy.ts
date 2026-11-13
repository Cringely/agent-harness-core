// Which checks and which CI workflow verify a pull request, per repository (#318). Verification
// reads only the reviewed repository's own entry. This repository's entry is built in
// (CORE_POLICY). Any other repository's comes from an operator-only policy file passed as an
// absolute path with --policy, and a repository with no valid entry gets no review at all: the CLI
// refuses before the App key is read.
//
// The file is a strict subset of #146's configuration schema, so no name here changes later:
//   { "version": 1, "repos": [ { "repo": "owner/example",
//       "ciWorkflowPath": ".github/workflows/ci.yml",
//       "requiredChecks": [ { "name": "build", "appSlug": "github-actions" } ] } ] }
// Every failure below invalidates the whole file. Refusal reasons name a key path and a rule,
// never a value from the file, the file's own path, or another repository in it: the reason
// reaches stdout under --json, and the path carries the workstation username.

import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { RefusalError, parseRepo, type RepoPolicy, type RequiredCheck } from "./types";

function deepFreezePolicy(policy: RepoPolicy): RepoPolicy {
  for (const check of policy.requiredChecks) Object.freeze(check);
  Object.freeze(policy.requiredChecks);
  return Object.freeze(policy);
}

// Keyed on name and app together, matching the jobs in .github/workflows/test.yml.
// test/pr-review-verdict.test.ts pins each name against that file.
export const CORE_POLICY: RepoPolicy = deepFreezePolicy({
  repo: "Cringely/agent-harness-core",
  ciWorkflowPath: ".github/workflows/test.yml",
  requiredChecks: [
    { name: "bun test (TypeScript hook suite)", appSlug: "github-actions" },
    { name: "Pester (fixture-built installer suites)", appSlug: "github-actions" },
    { name: "Pester (fixture-built installer suites, Linux)", appSlug: "github-actions" },
    { name: "secret scan (Gitleaks)", appSlug: "github-actions" },
  ],
  pesterCoverage: true,
});

export const MAX_POLICY_FILE_BYTES = 64 * 1024;
const MAX_WORKFLOW_PATH_CHARS = 200;
const MAX_CHECK_NAME_CHARS = 100;
// Only GitHub Actions in this version. verdict.ts discounts a pull request that
// edits .github/workflows/ or .github/actions/, and no rule discounts an edit to another CI
// system's config, so a check from another app could be satisfied by the pull request it vouches for.
const ALLOWED_APP_SLUG = "github-actions";
const APP_SLUG_RE = /^[a-z0-9-]+$/;

// C0, DEL, C1, and the invisible and directional marks types.ts's UNSAFE_CHARS lists. Built from
// code points, not escape sequences, so no tool round trip can turn one into a raw byte.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

function hasUnsafeChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

// The one workflow-path rule, used by the loader, GitHubClient's
// constructor and LocalGitSource's. A dot-dot segment survives encodeURIComponent and URL
// normalisation would resolve it to another API endpoint fetched with the installation token. A
// directory path returns a JSON listing the raw fetch would read as file text. Returns null when the
// value is acceptable, otherwise the reason.
export function workflowPathProblem(value: unknown): string | null {
  if (typeof value !== "string") return "must be a string";
  if (value.length === 0) return "must not be empty";
  if (value.length > MAX_WORKFLOW_PATH_CHARS) return `must be at most ${MAX_WORKFLOW_PATH_CHARS} characters`;
  if (hasUnsafeChar(value)) return "must not contain control or invisible characters";
  if (value.includes("\\")) return "must use forward slashes only";
  if (value.startsWith("/")) return "must be relative to the repository root";
  if (value.endsWith("/")) return "must name a file, not a directory";
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must not contain an empty, . or .. segment";
  }
  // GitHub reads workflows only directly under .github/workflows/.
  if (segments.length !== 3 || segments[0] !== ".github" || segments[1] !== "workflows") {
    return "must be a file directly under .github/workflows/";
  }
  if (!/\.ya?ml$/.test(value)) return "must end in .yml or .yaml";
  return null;
}

function checkNameProblem(value: unknown): string | null {
  if (typeof value !== "string") return "must be a string";
  if (value.length === 0) return "must not be empty";
  if (value.length > MAX_CHECK_NAME_CHARS) return `must be at most ${MAX_CHECK_NAME_CHARS} characters`;
  if (hasUnsafeChar(value)) return "must not contain control or invisible characters";
  if (value.trim() !== value) return "must not have leading or trailing whitespace";
  return null;
}

function appSlugProblem(value: unknown): string | null {
  if (typeof value !== "string") return "must be a string";
  if (!APP_SLUG_RE.test(value)) return "must be lowercase letters, digits and hyphens";
  if (value !== ALLOWED_APP_SLUG) return `must be "${ALLOWED_APP_SLUG}" in this reviewer version`;
  return null;
}

export type PolicyLoad = { ok: true; entries: readonly RepoPolicy[] } | { ok: false; reason: string };

class PolicyInvalid extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Exactly these keys, no more and no fewer. An unknown key includes #146's deferred ones
// (livingDocs, powershellSuiteCoverage and the rest): this version cannot honour them, and
// silently dropping one would review a repository against less than its operator configured. The
// refusal names where the key sits, never the key: an operator-authored key can be a private name.
function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], at: string, where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new PolicyInvalid(`${where}: an unsupported key (not supported by this reviewer version)`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new PolicyInvalid(`${at}.${key}: is required`);
  }
}

// JSON.parse keeps the last of two duplicate keys without a word. Every string literal followed by
// a colon is a key in valid JSON, so the raw text holding more keys than the parsed tree means a
// duplicate collapsed somewhere.
function rawKeyCount(raw: string): number {
  let count = 0;
  for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const rest = raw.slice(match.index! + match[0].length);
    if (/^\s*:/.test(rest)) count++;
  }
  return count;
}

function parsedKeyCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + parsedKeyCount(item), 0);
  if (isPlainObject(value)) return Object.keys(value).reduce((sum, key) => sum + 1 + parsedKeyCount(value[key]), 0);
  return 0;
}

function sameAsCore(entry: RepoPolicy): boolean {
  return (
    entry.repo === CORE_POLICY.repo &&
    entry.ciWorkflowPath === CORE_POLICY.ciWorkflowPath &&
    entry.requiredChecks.length === CORE_POLICY.requiredChecks.length &&
    entry.requiredChecks.every(
      (check, i) => check.name === CORE_POLICY.requiredChecks[i]!.name && check.appSlug === CORE_POLICY.requiredChecks[i]!.appSlug,
    )
  );
}

function parseEntry(value: unknown, at: string, index: number): RepoPolicy {
  if (!isPlainObject(value)) throw new PolicyInvalid(`${at}: must be an object`);
  requireExactKeys(value, ["repo", "ciWorkflowPath", "requiredChecks"], at, `entry ${index}`);
  if (typeof value.repo !== "string" || parseRepo(value.repo) === null) throw new PolicyInvalid(`${at}.repo: must be owner/name`);
  const pathProblem = workflowPathProblem(value.ciWorkflowPath);
  if (pathProblem !== null) throw new PolicyInvalid(`${at}.ciWorkflowPath: ${pathProblem}`);
  if (!Array.isArray(value.requiredChecks) || value.requiredChecks.length === 0) {
    throw new PolicyInvalid(`${at}.requiredChecks: must be a non-empty array`);
  }
  const checks: RequiredCheck[] = [];
  const seen = new Set<string>();
  value.requiredChecks.forEach((item: unknown, i: number) => {
    const checkAt = `${at}.requiredChecks[${i}]`;
    if (!isPlainObject(item)) throw new PolicyInvalid(`${checkAt}: must be an object`);
    requireExactKeys(item, ["name", "appSlug"], checkAt, `entry ${index}, check ${i}`);
    const nameProblem = checkNameProblem(item.name);
    if (nameProblem !== null) throw new PolicyInvalid(`${checkAt}.name: ${nameProblem}`);
    const slugProblem = appSlugProblem(item.appSlug);
    if (slugProblem !== null) throw new PolicyInvalid(`${checkAt}.appSlug: ${slugProblem}`);
    const pair = JSON.stringify([item.name, item.appSlug]);
    if (seen.has(pair)) throw new PolicyInvalid(`${checkAt}: duplicates an earlier name and appSlug pair`);
    seen.add(pair);
    checks.push({ name: item.name as string, appSlug: item.appSlug as string });
  });
  // Written explicitly, never left undefined: verdict.ts skips Pester coverage
  // only on a literal false, so a file entry has to say so.
  return deepFreezePolicy({ repo: value.repo, ciWorkflowPath: value.ciWorkflowPath as string, requiredChecks: checks, pesterCoverage: false });
}

// Pure validation of the file's text. Every error maps to an invalid file, not only PolicyInvalid:
// deep nesting can overflow the stack in JSON.parse or in the key count with a RangeError, and the
// CLI must still print its structured refusal rather than crash.
export function parsePolicyFile(raw: string): PolicyLoad {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PolicyInvalid("the file is not valid JSON");
    }
    if (rawKeyCount(raw) !== parsedKeyCount(parsed)) throw new PolicyInvalid("the file repeats a key inside one object");
    if (!isPlainObject(parsed)) throw new PolicyInvalid("the top level must be an object");
    requireExactKeys(parsed, ["version", "repos"], "(top level)", "the top level");
    if (parsed.version !== 1) throw new PolicyInvalid("version: must be 1");
    if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) throw new PolicyInvalid("repos: must be a non-empty array");

    const entries: RepoPolicy[] = [];
    const seen = new Set<string>();
    parsed.repos.forEach((item: unknown, i: number) => {
      const at = `repos[${i}]`;
      const entry = parseEntry(item, at, i);
      const folded = entry.repo.toLowerCase();
      if (seen.has(folded)) throw new PolicyInvalid(`${at}.repo: duplicates an earlier entry, case-insensitively`);
      seen.add(folded);
      // A file may list this repository only as an exact copy of CORE_POLICY, repo spelling
      // included, so a stale or case-shifted entry cannot weaken its checks.
      if (folded === CORE_POLICY.repo.toLowerCase() && !sameAsCore(entry)) {
        throw new PolicyInvalid(`${at}: an entry for the built-in repository must match its built-in policy exactly`);
      }
      entries.push(entry);
    });
    return { ok: true, entries: Object.freeze(entries) };
  } catch (error) {
    if (error instanceof PolicyInvalid) return { ok: false, reason: error.message };
    return { ok: false, reason: "the file could not be checked, for example because it nests too deeply" };
  }
}

export interface PolicyFsOps {
  lstatSync: (path: string) => { isSymbolicLink(): boolean; isFile(): boolean; size: number };
  realpathSync: (path: string) => string;
}

const REAL_FS: PolicyFsOps = { lstatSync, realpathSync: (path) => realpathSync.native(path) };

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// Path checks, then parsePolicyFile. The file holds private repository names, so it must live
// outside every checkout: one `git add -A` in a checkout of this public repository would publish
// it. Every ancestor of its real path is checked for a .git entry, file or directory, which also
// covers a worktree's parent clone that the reviewer's own REPO_ROOT does not contain.
// Anything that cannot be checked refuses.
export function loadPolicyFile(path: string, fs: Partial<PolicyFsOps> = {}): PolicyLoad {
  const ops: PolicyFsOps = { ...REAL_FS, ...fs };
  if (typeof path !== "string" || !isAbsolute(path)) return { ok: false, reason: "the policy file path must be absolute" };

  let stat: ReturnType<PolicyFsOps["lstatSync"]>;
  try {
    stat = ops.lstatSync(path);
  } catch {
    return { ok: false, reason: "the policy file cannot be read" };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: "the policy file is a symbolic link" };
  if (!stat.isFile()) return { ok: false, reason: "the policy file is not a regular file" };
  if (stat.size > MAX_POLICY_FILE_BYTES) return { ok: false, reason: `the policy file is larger than ${MAX_POLICY_FILE_BYTES} bytes` };

  let real: string;
  try {
    real = ops.realpathSync(path);
  } catch {
    return { ok: false, reason: "the policy file's real path cannot be resolved" };
  }
  let dir = dirname(real);
  for (;;) {
    try {
      ops.lstatSync(join(dir, ".git"));
      return { ok: false, reason: "the policy file sits inside a git checkout; keep it outside every checkout" };
    } catch (error) {
      if (!isMissing(error)) return { ok: false, reason: "a directory above the policy file cannot be checked for a git checkout" };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  let raw: string;
  try {
    const fd = openSync(real, "r");
    try {
      const fdStat = fstatSync(fd);
      if (!fdStat.isFile()) return { ok: false, reason: "the policy file is not a regular file" };
      if (fdStat.size > MAX_POLICY_FILE_BYTES) return { ok: false, reason: `the policy file is larger than ${MAX_POLICY_FILE_BYTES} bytes` };
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "the policy file cannot be read" };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_POLICY_FILE_BYTES) {
    return { ok: false, reason: `the policy file is larger than ${MAX_POLICY_FILE_BYTES} bytes` };
  }
  return parsePolicyFile(raw);
}

// The policy for one review, or a RefusalError. With no file only this repository resolves. An
// invalid file refuses the run whatever repository is asked for. This repository always resolves to
// the frozen CORE_POLICY object itself, never to a file's copy of it: the file
// cannot carry pesterCoverage, so its copy would review this repository without Pester coverage.
// Lookup is exact, case included, the same as github.ts's head-repository check.
export function resolvePolicy(
  repo: string,
  policyPath: string | null,
  load: (path: string) => PolicyLoad = (path) => loadPolicyFile(path),
): RepoPolicy {
  if (policyPath === null) {
    if (repo === CORE_POLICY.repo) return CORE_POLICY;
    throw new RefusalError(
      "refusing to review: without --policy only the built-in repository is configured, so another repository needs --policy <absolute path> naming an entry for it; nothing was read or posted",
    );
  }
  const loaded = load(policyPath);
  if (!loaded.ok) throw new RefusalError(`refusing to review: the policy file is invalid (${loaded.reason}); nothing was read or posted`);
  if (repo === CORE_POLICY.repo) return CORE_POLICY;
  const entry = loaded.entries.find((candidate) => candidate.repo === repo);
  if (entry === undefined) {
    throw new RefusalError(
      "refusing to review: the policy file has no entry for this repository (lookup is exact, case included); nothing was read or posted",
    );
  }
  return entry;
}
