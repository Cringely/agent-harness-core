// The merge decision for review-merge (#274), as a pure function of the reviewer's structured
// output and the pull request's state read back after the review. No model prose is parsed: the
// inputs are the --json fields tools/pr-review/cli.ts prints (status, event, reviewerOk, headSha,
// severities, posted, verification) and GitHub's own enums.
//
// Two ways to merge, both on the App's APPROVE of the reviewed head, and nothing else:
//   - its verification passed and the merge state is CLEAN: a plain merge.
//   - its verification passed but the merge is BLOCKED: the administrator bypass, only when
//     --allow-admin was passed and the code-owner review the operator cannot give is shown to be
//     the only requirement left unmet. BLOCKED alone does not show that: the bypass skips every rule
//     in the default ruleset, and GitHub reports no list of which ones are unmet. So the bypass
//     needs all of these, read rather than inferred:
//       - a changed file code-owned under .github/CODEOWNERS read at the base commit (the pull
//         request could edit its own copy)
//       - the App's approval of this head as the latest submitted review, and no reviewer whose
//         latest approval, dismissal or request for changes is a request for changes
//       - every active rule on the base branch shown met by data the tool reads, except the
//         code-owner review, which one of them must require. bypassRuleBlocker below says which
//         rules it can check. Any other rule, parameter or shape refuses, since it might be unmet
//     Anything that cannot be read refuses, and the merge is left to the operator.
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

// One review as GitHub lists it on the pull request, in its order (oldest first). id is the REST
// id the reviewer's --json output carries. authorCanPush is GitHub's own answer to whether the
// author has push access, which decides whether its approval counts toward a review rule.
export interface ReviewEntry {
  id: number;
  state: string;
  commitId: string;
  author: string;
  authorCanPush: boolean;
}

// One active rule on the base branch, as GitHub's rules-for-a-branch endpoint lists it.
export interface BranchRule {
  type: string;
  parameters: Record<string, unknown> | null;
}

// What review-merge reads for the bypass. codeowners is the base commit's .github/CODEOWNERS, or
// null when the base has none. A read that failed or came back incomplete is readable: false.
export type BypassEvidence =
  | { readable: false; reason: string }
  | { readable: true; codeowners: string | null; changedFiles: string[]; reviews: ReviewEntry[]; rules: BranchRule[] };

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

// Each reviewer's latest review that states an opinion: not a comment, and not a pending review,
// which GitHub has not submitted. Neither clears an earlier request for changes.
function latestOpinions(reviews: readonly ReviewEntry[]): ReviewEntry[] {
  const latest = new Map<string, ReviewEntry>();
  for (const entry of reviews) if (entry.state !== "PENDING" && entry.state !== "COMMENTED") latest.set(entry.author, entry);
  return [...latest.values()];
}

// Push protections a merge into the base branch cannot violate: it neither force-pushes nor deletes.
const PUSH_ONLY_RULES: ReadonlySet<string> = new Set(["non_fast_forward", "deletion"]);
const STATUS_KEYS: ReadonlySet<string> = new Set(["required_status_checks", "strict_required_status_checks_policy", "do_not_enforce_on_create"]);

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// The required_status_checks rule is met when every named context has a successful entry on the
// head. A rule that also needs the branch up to date with the base refuses, since the tool does not
// read that.
function statusRuleBlocker(parameters: Record<string, unknown>, checks: readonly CheckEntry[]): string | null {
  const shape = "a required_status_checks rule this tool cannot check";
  const contexts = parameters.required_status_checks;
  if (!Object.keys(parameters).every((key) => STATUS_KEYS.has(key)) || parameters.strict_required_status_checks_policy !== false) return shape;
  if (!isList(contexts) || !contexts.every((entry) => isRecord(entry) && typeof entry.context === "string")) return shape;
  for (const entry of contexts as { context: string }[]) {
    if (!checks.some((check) => check.name === entry.context && check.status === "COMPLETED" && check.conclusion === "SUCCESS")) {
      return "a required check named by the base branch's rules has not succeeded on the head";
    }
  }
  return null;
}

// The pull_request rule, apart from its code-owner review, is met when enough reviewers with push
// access approved this head as their latest opinion and every other parameter is in a state the
// tool can show met. Approval of the last push by someone other than the pusher needs the pusher,
// which no read here names. Thread resolution, named reviewers and the extra approval for
// unattributed changes are not read either, so each refuses when on. A parameter this tool does not
// know refuses whatever its value.
function reviewRuleBlocker(parameters: Record<string, unknown>, opinions: readonly ReviewEntry[], head: string, method: string): string | null {
  const shape = "a pull_request rule this tool cannot check";
  for (const [key, value] of Object.entries(parameters)) {
    switch (key) {
      case "require_code_owner_review":
      case "dismiss_stale_reviews_on_push":
        if (typeof value !== "boolean") return shape;
        break;
      case "require_last_push_approval":
      case "required_review_thread_resolution":
      case "require_extra_approval_for_unattributed_changes":
        if (value !== false) return shape;
        break;
      case "required_reviewers":
        if (!isList(value) || value.length > 0) return shape;
        break;
      case "allowed_merge_methods":
        if (!isList(value) || !value.includes(method)) return shape;
        break;
      case "required_approving_review_count": {
        if (!Number.isInteger(value) || (value as number) < 0) return shape;
        const counted = opinions.filter((entry) => entry.state === "APPROVED" && entry.commitId === head && entry.authorCanPush).length;
        if (counted < (value as number)) return "the pull request has fewer counted approvals than the base branch's review rule requires";
        break;
      }
      default:
        return shape;
    }
  }
  return null;
}

// Why an active rule other than the code-owner review might be unmet, or null when none is. The
// rule list must include a pull_request rule that requires the code-owner review, or the block
// cannot be that review.
function bypassRuleBlocker(rules: readonly BranchRule[], opinions: readonly ReviewEntry[], checks: readonly CheckEntry[], head: string, method: string): string | null {
  let codeOwnerRequired = false;
  for (const rule of rules) {
    if (PUSH_ONLY_RULES.has(rule.type)) continue;
    const parameters = rule.parameters ?? {};
    if (rule.type === "required_status_checks") {
      const blocker = statusRuleBlocker(parameters, checks);
      if (blocker !== null) return blocker;
    } else if (rule.type === "pull_request") {
      const blocker = reviewRuleBlocker(parameters, opinions, head, method);
      if (blocker !== null) return blocker;
      if (parameters.require_code_owner_review === true) codeOwnerRequired = true;
    } else {
      const type = /^[a-z_]{1,40}$/.test(rule.type) ? `a ${rule.type}` : "an unrecognised";
      return `the base branch has ${type} rule this tool cannot check, so something besides the code-owner review may be unmet`;
    }
  }
  return codeOwnerRequired ? null : "no rule on the base branch requires a code-owner review, so the block is something else";
}

// Why the bypass may not be taken, or null when the block is the code-owner review alone. Reasons
// name line numbers and rule types, never a path or CODEOWNERS text, which the pull request's
// author chose.
function bypassBlocker(bypass: BypassEvidence | null, review: ReviewResult, head: string, checks: readonly CheckEntry[], method: string): string | null {
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
  const opinions = latestOpinions(bypass.reviews);
  if (opinions.some((entry) => entry.state === "CHANGES_REQUESTED")) return "a reviewer's latest review requests changes";
  return bypassRuleBlocker(bypass.rules, opinions, checks, head, method);
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
  // The merge method review-merge will use, which the base branch's review rule must allow.
  method: string;
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
      const blocker = bypassBlocker(input.bypass, review, input.reviewedHead, input.checks, input.method);
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
