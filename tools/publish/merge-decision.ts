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
//         code-owner review, which one of them must require. That covers the rulesets and any
//         classic branch protection. bypassRuleBlocker and protectionRules below say which rules
//         they can check. Any other rule, parameter or shape refuses, since it might be unmet
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

// One check run on the head, from the check-runs endpoint, which names the app that created it.
// status and conclusion are upper-cased to match the rollup. appId is null when GitHub gave none.
export interface CheckRunEntry {
  name: string;
  status: string;
  conclusion: string;
  appId: number | null;
}

// What review-merge reads for the bypass. codeowners is the base commit's .github/CODEOWNERS, or
// null when the base has none. A read that failed or came back incomplete is readable: false.
export type BypassEvidence =
  | { readable: false; reason: string }
  | {
      readable: true;
      codeowners: string | null;
      changedFiles: string[];
      reviews: ReviewEntry[];
      rules: BranchRule[];
      // The base branch's classic protection, or null when GitHub says the branch has none.
      protection: Record<string, unknown> | null;
      checkRuns: CheckRunEntry[];
    };

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

const CONTEXT_KEYS: ReadonlySet<string> = new Set(["context", "integration_id"]);
const succeeded = (check: { status: string; conclusion: string }) => check.status === "COMPLETED" && check.conclusion === "SUCCESS";

// The required_status_checks rule is met when every named context succeeded on the head and no
// check of that name did anything else. A context that names an app (integration_id) needs a check
// run from that app, and refuses when any run of that name came without an app id. A rule that also
// needs the branch up to date with the base refuses, since the tool does not read that.
function statusRuleBlocker(parameters: Record<string, unknown>, checks: readonly CheckEntry[], runs: readonly CheckRunEntry[]): string | null {
  const shape = "a required_status_checks rule this tool cannot check";
  const contexts = parameters.required_status_checks;
  if (!Object.keys(parameters).every((key) => STATUS_KEYS.has(key)) || parameters.strict_required_status_checks_policy !== false) return shape;
  const wellFormed = (entry: unknown) =>
    isRecord(entry) &&
    typeof entry.context === "string" &&
    Object.keys(entry).every((key) => CONTEXT_KEYS.has(key)) &&
    (entry.integration_id === undefined || Number.isInteger(entry.integration_id));
  if (!isList(contexts) || !contexts.every(wellFormed)) return shape;
  for (const entry of contexts as { context: string; integration_id?: number }[]) {
    const namedRuns = runs.filter((run) => run.name === entry.context);
    const named = [...checks.filter((check) => check.name === entry.context), ...namedRuns];
    if (!named.every(succeeded)) return "checks named by a required check on the base branch did not all succeed on the head";
    if (entry.integration_id !== undefined) {
      if (namedRuns.some((run) => run.appId === null)) return "the app behind a required check on the head could not be read";
      if (!namedRuns.some((run) => run.appId === entry.integration_id)) {
        return "a required check named by the base branch's rules has not succeeded on the head from the app the rule names";
      }
    } else if (named.length === 0) {
      return "a required check named by the base branch's rules has not succeeded on the head";
    }
  }
  return null;
}

const PROTECTION_IGNORED: ReadonlySet<string> = new Set(["url", "enforce_admins", "allow_force_pushes", "allow_deletions", "block_creations", "allow_fork_syncing"]);
const PROTECTION_OFF: ReadonlySet<string> = new Set(["required_linear_history", "required_conversation_resolution", "lock_branch", "required_signatures"]);

// Classic branch protection as the ruleset rules bypassRuleBlocker checks, or a reason it cannot be
// read that way. Permissions that a merge cannot leave unmet (force pushes, deletions, branch
// creation, fork syncing, whether admins are held to it) are skipped. Linear history, conversation
// resolution, a locked branch, signed commits and push restrictions refuse when on, and any key this
// tool does not know refuses.
function protectionRules(protection: Record<string, unknown>): BranchRule[] | string {
  const shape = "classic branch protection this tool cannot check";
  const rules: BranchRule[] = [];
  for (const [key, value] of Object.entries(protection)) {
    if (PROTECTION_IGNORED.has(key) || key.endsWith("_url")) continue;
    if (PROTECTION_OFF.has(key)) {
      if (!isRecord(value) || value.enabled !== false) return shape;
    } else if (key === "restrictions") {
      if (value !== null) return shape;
    } else if (key === "required_status_checks") {
      if (!isRecord(value) || value.strict !== false) return shape;
      const list = isList(value.checks) ? value.checks : isList(value.contexts) ? value.contexts.map((context) => ({ context })) : null;
      if (list === null || !Object.keys(value).every((k) => ["url", "strict", "checks", "contexts", "contexts_url", "enforcement_level"].includes(k))) return shape;
      const entries = list.map((entry) =>
        isRecord(entry) && Number.isInteger(entry.app_id) ? { context: entry.context, integration_id: entry.app_id } : isRecord(entry) ? { context: entry.context } : entry,
      );
      rules.push({ type: "required_status_checks", parameters: { required_status_checks: entries, strict_required_status_checks_policy: false } });
    } else if (key === "required_pull_request_reviews") {
      if (!isRecord(value)) return shape;
      const parameters: Record<string, unknown> = { require_last_push_approval: false };
      for (const [k, v] of Object.entries(value)) {
        if (k === "url" || k === "dismissal_restrictions" || k === "bypass_pull_request_allowances") continue;
        else if (k === "dismiss_stale_reviews") parameters.dismiss_stale_reviews_on_push = v;
        else if (k === "require_code_owner_reviews") parameters.require_code_owner_review = v;
        else if (k === "required_approving_review_count" || k === "require_last_push_approval") parameters[k] = v;
        else return shape;
      }
      rules.push({ type: "pull_request", parameters });
    } else {
      return shape;
    }
  }
  return rules;
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
function bypassRuleBlocker(
  rules: readonly BranchRule[],
  opinions: readonly ReviewEntry[],
  checks: readonly CheckEntry[],
  runs: readonly CheckRunEntry[],
  head: string,
  method: string,
): string | null {
  let codeOwnerRequired = false;
  for (const rule of rules) {
    if (PUSH_ONLY_RULES.has(rule.type)) continue;
    const parameters = rule.parameters ?? {};
    if (rule.type === "required_status_checks") {
      const blocker = statusRuleBlocker(parameters, checks, runs);
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
  // Opinions are grouped by author, so one with no login (a deleted account) could stand in for
  // anyone's. It refuses instead.
  if (bypass.reviews.some((entry) => entry.state !== "PENDING" && entry.state !== "COMMENTED" && entry.author === "")) {
    return "a review that approves, dismisses or requests changes has no author login";
  }
  const opinions = latestOpinions(bypass.reviews);
  if (opinions.some((entry) => entry.state === "CHANGES_REQUESTED")) return "a reviewer's latest review requests changes";
  const classic =
    bypass.protection === null ? [] : isRecord(bypass.protection) ? protectionRules(bypass.protection) : "the base branch's classic protection could not be read";
  if (typeof classic === "string") return classic;
  return bypassRuleBlocker([...bypass.rules, ...classic], opinions, checks, bypass.checkRuns, head, method);
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
