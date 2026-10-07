// The merge decision for review-merge (#274), as a pure function of the reviewer's structured
// output and the pull request's state read back after the review. No prose is parsed: the inputs
// are the --json fields tools/pr-review/cli.ts prints (status, event, reviewerOk, headSha,
// severities, posted) and GitHub's own enums.
//
// Two ways to merge, and nothing else:
//   - the App approved, the merge state is CLEAN: a plain merge.
//   - the App approved but the merge is BLOCKED (an owned path needs a code-owner review the
//     operator cannot give), or the App could only COMMENT (it cannot vouch for CI edits): the
//     administrator bypass, and only when --allow-admin was passed, the reviewer actually ran,
//     no finding sits at or above the severity floor, and the event is not REQUEST_CHANGES.
// Both also require the review to have been posted, every check to have succeeded, and the head
// to be the one reviewed. A severity this file does not know counts as at or above the floor.

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
  const { status, event, reviewerOk, headSha, severities, refusal, posted } = raw;
  if (
    typeof event !== "string" ||
    typeof reviewerOk !== "boolean" ||
    typeof headSha !== "string" ||
    !Array.isArray(severities) ||
    !severities.every((severity) => typeof severity === "string")
  ) {
    throw new PublishError("the reviewer's --json output lacks event, reviewerOk, headSha or severities");
  }
  return {
    status,
    event,
    reviewerOk,
    headSha,
    severities: severities as string[],
    refusal: typeof refusal === "string" ? refusal : null,
    postedUrl: isRecord(posted) && typeof posted.htmlUrl === "string" ? posted.htmlUrl : null,
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
    if (input.mergeState === "CLEAN") return { action: "merge", admin: false };
    if (input.mergeState === "BLOCKED") {
      return input.allowAdmin
        ? { action: "merge", admin: true }
        : refuse("the App approved but the merge is blocked, as on an owned path. Rerun with --allow-admin to use the administrator bypass");
    }
    return refuse(`the pull request is not mergeable (merge state ${state})`);
  }
  if (review.event === "COMMENT" && atFloor === 0) {
    if (!input.allowAdmin) return refuse("the review is a COMMENT with no finding at or above the floor. Only --allow-admin may merge it");
    if (input.mergeState === "BLOCKED" || input.mergeState === "CLEAN") return { action: "merge", admin: true };
    return refuse(`the pull request is not mergeable (merge state ${state})`);
  }
  return refuse(`the review did not approve (event ${enumText(review.event)}, ${atFloor} finding(s) at or above the floor)`);
}
