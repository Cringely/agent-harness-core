// Shared contract for tools/pr-review. Every type and constant more than one file uses is defined
// here and nowhere else, so the files that consume them cannot disagree about a name or a shape.
// This is repository tooling, not core: nothing under install/ copies tools/ anywhere.

// The severity floor from #120's option-A ruling, which places it where
// account/claude/rules/fix-quality.md does ("Work has to be able to end"). A finding at one of
// these severities withholds approval; one below the floor is displayed and never does.
export const LOAD_BEARING_SEVERITIES = ["correctness", "security", "fails-open"] as const;
export const BELOW_FLOOR_SEVERITIES = ["comment-accuracy", "stale-citation", "naming", "coverage-gap", "other"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

export type Severity = (typeof LOAD_BEARING_SEVERITIES)[number] | (typeof BELOW_FLOOR_SEVERITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export interface Finding {
  severity: Severity;
  confidence: Confidence;
  path: string;
  title: string;
  detail: string;
}

export interface ObservedInstruction {
  path: string;
  excerpt: string;
}

export interface ReviewerOutput {
  summary: string;
  findings: Finding[];
  observed_instructions: ObservedInstruction[];
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface Verification {
  state: "passed" | "failed" | "incomplete";
  reasons: string[];
}

export interface CheckRun {
  name: string;
  appSlug: string;
  status: string;
  conclusion: string | null;
}

export interface IssueText {
  number: number;
  title: string;
  body: string;
}

export interface FileText {
  path: string;
  content: string;
}

export interface PrSnapshot {
  repo: string;
  number: number | null;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  isOpen: boolean;
  diff: string | null;
  changedFiles: string[];
  // False when the source could not list every changed file (GitHub lists at most 3,000). A review
  // that did not see every file may reject on what it saw but never approves.
  changedFilesComplete: boolean;
  commitMessages: string[];
  headFiles: FileText[];
  omittedFiles: string[];
  linkedIssues: IssueText[];
  trustedContext: FileText[];
  workflowText: string | null;
  checkRuns: CheckRun[];
}

export interface PrSource {
  snapshot(): Promise<PrSnapshot>;
}

export interface PostedReview {
  id: number;
  htmlUrl: string;
}

export interface ReviewPoster {
  currentHeadSha(): Promise<string>;
  postReview(input: { commitId: string; event: ReviewEvent; body: string }): Promise<PostedReview>;
}

export interface PromptPair {
  systemPrompt: string;
  userPrompt: string;
}

// `reason` is code-authored and may be rendered into the public body. `diagnostic` is for the
// operator's console only and is never rendered.
export type RunnerResult =
  | { ok: true; output: unknown; model: string; tools: string[] }
  | { ok: false; reason: string; diagnostic?: string };

export interface ReviewerRunner {
  run(prompt: PromptPair): Promise<RunnerResult>;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface TokenMinter {
  mint(): Promise<InstallationToken>;
}

// Read at the pull request's BASE commit, so a PR that edits one of these files cannot change the
// standard it is reviewed against. #120 names CONTRIBUTING.md, the guardrails file and the
// relevant account rules. `.claude/guardrails.md` is gitignored in this repository, so the
// template it is installed from stands in for it.
export const TRUSTED_CONTEXT_PATHS = [
  "CONTRIBUTING.md",
  "core/claude/templates/guardrails.template.md",
  "account/claude/rules/fix-quality.md",
  "account/claude/rules/security.md",
] as const;

export const WORKFLOW_PATH = ".github/workflows/test.yml";

// Size caps. Each bounds what an attacker-sized pull request can make one review cost.
// MAX_DIFF_BYTES: larger diffs get COMMENT without a model run. Round one of #98, the largest
// acceptance case, is 41,893 bytes.
export const MAX_DIFF_BYTES = 600_000;
// Post-change file content gives the reviewer context the diff's three lines do not. 60 KB keeps
// round one's four TypeScript and shell files (9 to 21 KB each) and drops its two PowerShell files
// (72 and 85 KB) whose changes are one-line comment edits the diff already shows in full.
export const MAX_HEAD_FILE_BYTES = 60_000;
export const MAX_HEAD_FILES_TOTAL_BYTES = 250_000;
// A description can name any number of issues. #131, the most in the retro set, closes three.
export const MAX_LINKED_ISSUES = 3;
// Bounds contents-API calls per review. Files beyond it are listed as omitted.
export const MAX_HEAD_FILE_FETCHES = 50;

// Thrown for every refusal (a review that will not run, will not post, will not merge). The CLI
// entry point catches this by type and maps it to exit code 2, distinct from an uncaught defect.
export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusalError";
  }
}

// The four items below are hoisted here because the plan defined each one twice, identically, in
// files this task does not own (findings.ts/render.ts for the two Sets below; verdict.ts/render.ts
// for LOAD_BEARING_SET; render.ts/github.ts for SHA_RE; app-auth.ts/github.ts for the owner/name
// check that parseRepo replaces). Every later task imports the single copy here instead of
// redefining it, so the two sites cannot drift apart the way the plan's duplicates already had not.

// Every severity the schema accepts, load-bearing or not. Same membership as the enum
// FINDINGS_JSON_SCHEMA declares.
export const SEVERITY_SET: ReadonlySet<string> = new Set([...LOAD_BEARING_SEVERITIES, ...BELOW_FLOOR_SEVERITIES]);
export const CONFIDENCE_SET: ReadonlySet<string> = new Set(CONFIDENCES);
// Just the floor: a finding at one of these severities is the one case that withholds approval.
export const LOAD_BEARING_SET: ReadonlySet<string> = new Set(LOAD_BEARING_SEVERITIES);

// A full, lowercase, 40-character git commit SHA. Used to validate both the head commit a review
// is posted against and check-run commit references.
export const SHA_RE = /^[0-9a-f]{40}$/;

const REPO_PART_RE = /^[A-Za-z0-9._-]+$/;

// Validates a GitHub "owner/name" repository identifier and splits it. Returns null for anything
// that is not exactly two REPO_PART_RE segments, or where either segment is "." or "..": both
// characters are inside REPO_PART_RE's class, so they need a check of their own.
export function parseRepo(repo: string): { owner: string; name: string } | null {
  const parts = repo.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!REPO_PART_RE.test(owner) || !REPO_PART_RE.test(name)) return null;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { owner, name };
}
