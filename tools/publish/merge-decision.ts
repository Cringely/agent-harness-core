// The merge decision for review-merge (#274), as a pure function of the reviewer's structured
// output and the pull request's state read back after the review. No model prose is parsed: the
// inputs are the --json fields tools/pr-review/cli.ts prints (status, event, reviewerOk, headSha,
// severities, posted, verification) and GitHub's own enums.
//
// Two ways to merge, both on the App's APPROVE of the reviewed head, and nothing else:
//   - its verification passed and the merge state is CLEAN: a plain merge.
//   - its verification passed but the merge is BLOCKED: the administrator bypass, only when
//     --allow-admin was passed and the block is shown to be the code-owner review the operator
//     cannot give. BLOCKED alone does not show that, because the default ruleset also blocks on
//     other rules, and on an approval GitHub does not count. So the bypass also needs a changed file
//     that is code-owned under .github/CODEOWNERS read at the base commit (the pull request could
//     edit its own copy), and the App's approval of this head as the latest review on the pull
//     request. Every required check succeeding on the head is already part of a passed
//     verification. Anything that cannot be read, or a CODEOWNERS line codeowners.ts does not
//     accept, refuses and leaves the merge to the operator.
// Both also require the review to have been posted, the reviewer to have run, no finding at or
// above the severity floor, every check to have succeeded, and the head to be the one reviewed. A
// severity this file does not know counts as at or above the floor.
//
// A COMMENT never merges, whatever its verification reasons, including the ones CI cannot vouch
// for by design. CONTRIBUTING.md allows the administrator bypass on the App's APPROVE plus a
// passing premerge, and calls any other bypass an operator override. An override is the
// operator's to perform by hand, with a bypass-rationale comment, so this tool refuses and says so.

import { BELOW_FLOOR_SEVERITIES } from "../pr-review/types";
import { isOwned, parseCodeowners } from "./codeowners";
import { PublishError } from "./errors";
import type { CheckEntry } from "./gh";

export interface ReviewResult {
  status: string;
  event: string;
  reviewerOk: boolean;
  headSha: string;
  severities: string[];
  refusal: string | null;
  postedUrl: string | null;
  postedId: number | null;
  verification: { state: string; reasons: string[] };
}

// One review as GitHub lists it on the pull request, in its order (oldest first).
export interface ReviewEntry {
  id: number;
  state: string;
  commitId: string;
}

// What review-merge reads for the bypass. codeowners is the base commit's .github/CODEOWNERS, or
// null when the base has none. A read that failed or came back incomplete is readable: false.
export type BypassEvidence =
  | { readable: false; reason: string }
  | { readable: true; codeowners: string | null; changedFiles: string[]; reviews: ReviewEntry[] };

export type MergeDecision = { action: "merge"; admin: boolean } | { action: "refuse"; reason: string };

const BELOW_FLOOR: ReadonlySet<string> = new Set(BELOW_FLOOR_SEVERITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// GitHub enum values and the reviewer's status words are safe to print. Anything else is not.
export function enumText(value: string): string {
  return /^[A-Za-z_-]{1,40}$/.test(value) ? value : "unrecognised";
}

export function parseReviewOutput(stdout: string): ReviewResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new PublishError("the reviewer's --json output is not JSON. A review may already have been posted, so check the pull request");
  }
  if (!isRecord(raw) || typeof raw.status !== "string") throw new PublishError("the reviewer's --json output has no status");
  const { status, event, reviewerOk, headSha, severities, refusal, posted, verification } = raw;
  if (
    typeof event !== "string" ||
    typeof reviewerOk !== "boolean" ||
    typeof headSha !== "string" ||
    !Array.isArray(severities) ||
    !severities.every((severity) => typeof severity === "string")
  ) {
    throw new PublishError("the reviewer's --json output lacks event, reviewerOk, headSha or severities");
  }
  if (
    !isRecord(verification) ||
    typeof verification.state !== "string" ||
    !Array.isArray(verification.reasons) ||
    !verification.reasons.every((reason) => typeof reason === "string")
  ) {
    throw new PublishError("the reviewer's --json output lacks a verification state and reasons");
  }
  return {
    status,
    event,
    reviewerOk,
    headSha,
    severities: severities as string[],
    refusal: typeof refusal === "string" ? refusal : null,
    postedUrl: isRecord(posted) && typeof posted.htmlUrl === "string" ? posted.htmlUrl : null,
    postedId: isRecord(posted) && Number.isInteger(posted.id) ? (posted.id as number) : null,
    verification: { state: verification.state, reasons: [...(verification.reasons as string[])] },
  };
}

export function atFloorCount(severities: readonly string[]): number {
  return severities.filter((severity) => !BELOW_FLOOR.has(severity)).length;
}

export function checksSummary(checks: readonly CheckEntry[]): { ok: boolean; total: number; failing: number; pending: number } {
  const pending = checks.filter((check) => check.status !== "COMPLETED").length;
  const failing = checks.filter((check) => check.status === "COMPLETED" && check.conclusion !== "SUCCESS").length;
  return { ok: checks.length > 0 && pending === 0 && failing === 0, total: checks.length, failing, pending };
}

const OPERATOR = "The operator merges it by hand, with a bypass-rationale comment";

// Why the bypass may not be taken, or null when the block is the code-owner review. Reasons name
// line numbers and counts, never a path or CODEOWNERS text, which the pull request's author chose.
function bypassBlocker(bypass: BypassEvidence | null, review: ReviewResult, head: string): string | null {
  if (!bypass) return "the code-owner block could not be established";
  if (!bypass.readable) return `the code-owner block could not be established: ${bypass.reason}`;
  if (bypass.codeowners === null) return "the base commit has no .github/CODEOWNERS, so the block is not a code-owner review";
  const parsed = parseCodeowners(bypass.codeowners);
  if (!parsed.ok) return `.github/CODEOWNERS at the base commit has a line this tool does not accept (line ${parsed.line})`;
  if (!bypass.changedFiles.some((file) => isOwned(parsed.rules, file))) {
    return "no changed file is code-owned at the base commit, so the block is something other than the code-owner review";
  }
  const submitted = bypass.reviews.filter((entry) => entry.state !== "PENDING");
  const latest = submitted[submitted.length - 1];
  if (latest === undefined || latest.id !== review.postedId || latest.state !== "APPROVED" || latest.commitId !== head) {
    return "the App's approval of this head is not the latest review on the pull request";
  }
  return null;
}

export function decideMerge(input: {
  review: ReviewResult;
  reviewedHead: string;
  currentHead: string;
  checks: readonly CheckEntry[];
  mergeState: string;
  allowAdmin: boolean;
  // Read only when --allow-admin was passed. Null otherwise.
  bypass: BypassEvidence | null;
}): MergeDecision {
  const { review } = input;
  const refuse = (reason: string): MergeDecision => ({ action: "refuse", reason });
  if (review.status !== "posted") return refuse(`the review was not posted (status ${enumText(review.status)})`);
  if (review.reviewerOk !== true) return refuse("the reviewer produced no valid findings, so nothing vouches for this change");
  if (review.headSha !== input.reviewedHead || input.currentHead !== input.reviewedHead) {
    return refuse("the head commit is not the one that was reviewed");
  }
  const checks = checksSummary(input.checks);
  if (!checks.ok) {
    return refuse(`not every check succeeded (${checks.total} total, ${checks.failing} not successful, ${checks.pending} pending)`);
  }
  const atFloor = atFloorCount(review.severities);
  const state = enumText(input.mergeState);
  if (review.event === "APPROVE" && atFloor === 0) {
    if (review.verification.state !== "passed") return refuse("the App approved, but its verification did not pass");
    if (input.mergeState === "CLEAN") return { action: "merge", admin: false };
    if (input.mergeState === "BLOCKED") {
      if (!input.allowAdmin) {
        return refuse("the App approved but the merge is blocked, as on an owned path. Rerun with --allow-admin to use the administrator bypass");
      }
      const blocker = bypassBlocker(input.bypass, review, input.reviewedHead);
      return blocker === null ? { action: "merge", admin: true } : refuse(`${blocker}. ${OPERATOR}`);
    }
    return refuse(`the pull request is not mergeable (merge state ${state})`);
  }
  if (review.event === "COMMENT") {
    return refuse(
      `the review is a COMMENT (${atFloor} finding(s) at or above the floor), and this tool merges only on the App's APPROVE. Merging it is an operator override: the operator merges by hand and records a bypass-rationale comment on the pull request`,
    );
  }
  return refuse(`the review did not approve (event ${enumText(review.event)}, ${atFloor} finding(s) at or above the floor)`);
}
