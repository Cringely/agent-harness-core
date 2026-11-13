// The merge decision for review-merge (#274), as a pure function of the reviewer's structured
// output and the pull request's state read back after the review. No model prose is parsed: the
// inputs are the --json fields tools/pr-review/cli.ts prints (status, event, reviewerOk, headSha,
// severities, posted, verification) and GitHub's own enums.
//
// Two ways to merge, both on the App's APPROVE of the reviewed head, and nothing else:
//   - its verification passed and the merge state is CLEAN: a plain merge.
//   - its verification passed but the merge is BLOCKED (an owned path needs a code-owner review the
//     operator cannot give): the administrator bypass, and only when --allow-admin was passed.
// Both also require the review to have been posted, the reviewer to have run, no finding at or
// above the severity floor, every check to have succeeded, and the head to be the one reviewed. A
// severity this file does not know counts as at or above the floor.
//
// A COMMENT never merges, whatever its verification reasons, including the ones CI cannot vouch
// for by design. CONTRIBUTING.md allows the administrator bypass on the App's APPROVE plus a
// passing premerge, and calls any other bypass an operator override. An override is the
// operator's to perform by hand, with a bypass-rationale comment, so this tool refuses and says so.

import { BELOW_FLOOR_SEVERITIES } from "../pr-review/types";
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
  verification: { state: string; reasons: string[] };
}

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

export function decideMerge(input: {
  review: ReviewResult;
  reviewedHead: string;
  currentHead: string;
  checks: readonly CheckEntry[];
  mergeState: string;
  allowAdmin: boolean;
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
      return input.allowAdmin
        ? { action: "merge", admin: true }
        : refuse("the App approved but the merge is blocked, as on an owned path. Rerun with --allow-admin to use the administrator bypass");
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
