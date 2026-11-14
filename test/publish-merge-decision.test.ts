// Tests for tools/publish/merge-decision.ts (#274): every way the merge decision refuses, and the
// only two ways it merges, both on the App's APPROVE.

import { describe, expect, test } from "bun:test";
import { PublishError } from "../tools/publish/errors";
import type { CheckEntry } from "../tools/publish/gh";
import { atFloorCount, checksSummary, decideMerge, parseReviewOutput, type BranchRule, type BypassEvidence, type CheckRunEntry, type ReviewEntry, type ReviewResult } from "../tools/publish/merge-decision";
import { CORE_POLICY } from "../tools/pr-review/repo-policy";
import type { CheckRun } from "../tools/pr-review/types";
import { computeVerification } from "../tools/pr-review/verdict";
import { HEAD } from "./publish-fakes";

const GREEN: CheckEntry[] = [
  { kind: "CheckRun", name: "bun test", status: "COMPLETED", conclusion: "SUCCESS" },
  { kind: "StatusContext", name: "legacy", status: "COMPLETED", conclusion: "SUCCESS" },
];
const APPROVED: ReviewResult = {
  status: "posted",
  event: "APPROVE",
  reviewerOk: true,
  headSha: HEAD,
  severities: ["naming"],
  refusal: null,
  postedUrl: "https://github.com/o/r/pull/9#pullrequestreview-1",
  postedId: 1,
  verification: { state: "passed", reasons: [] },
};
// What the reviewer reports for a pull request that edits CI definitions: every required check ran
// and succeeded, but CI cannot vouch for a change to itself.
const CI_EDIT = { state: "incomplete", reasons: ["the pull request edits CI definitions, so its own checks cannot vouch for it: .github/workflows/test.yml"] };
const COMMENTED: ReviewResult = { ...APPROVED, event: "COMMENT", verification: CI_EDIT };
// The base branch's active rules when nothing but the code-owner review can be unmet: push-only
// protections, a required check the head passed, and a review rule the App's approval meets.
const PR_RULE = {
  allowed_merge_methods: ["merge", "rebase"],
  dismiss_stale_reviews_on_push: true,
  require_code_owner_review: true,
  require_last_push_approval: false,
  required_approving_review_count: 1,
  required_review_thread_resolution: false,
  required_reviewers: [],
  require_extra_approval_for_unattributed_changes: false,
};
const STATUS_RULE = { do_not_enforce_on_create: false, required_status_checks: [{ context: "bun test", integration_id: 1 }], strict_required_status_checks_policy: false };
const RULES: BranchRule[] = [
  { type: "non_fast_forward", parameters: null },
  { type: "deletion", parameters: null },
  { type: "required_status_checks", parameters: STATUS_RULE },
  { type: "pull_request", parameters: PR_RULE },
];
// What review-merge reads for the bypass: CODEOWNERS at the base, the changed files, and the
// pull request's reviews in the order GitHub lists them, the App's own approval last.
const OWNED: BypassEvidence = {
  readable: true,
  codeowners: "# owned\n/tools/ @owner\n",
  changedFiles: ["README.md", "tools/x.ts"],
  reviews: [
    { id: 7, state: "COMMENTED", commitId: "c".repeat(40), author: "other", authorCanPush: true },
    { id: 1, state: "APPROVED", commitId: HEAD, author: "app", authorCanPush: true },
  ],
  rules: RULES,
  protection: null,
  checkRuns: [{ name: "bun test", status: "COMPLETED", conclusion: "SUCCESS", appId: 1 }],
};
const base = { review: APPROVED, reviewedHead: HEAD, currentHead: HEAD, checks: GREEN, mergeState: "CLEAN", allowAdmin: false, bypass: null, method: "merge" };
type Input = Parameters<typeof decideMerge>[0];
const decide = (overrides: Partial<Input>) => decideMerge({ ...base, ...overrides });

describe("decideMerge(): merges", () => {
  test("a plain merge on APPROVE and CLEAN", () => {
    expect(decide({})).toEqual({ action: "merge", admin: false });
  });

  test("the bypass on APPROVE and BLOCKED with --allow-admin, an owned changed file and the App's approval last", () => {
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true, bypass: OWNED })).toEqual({ action: "merge", admin: true });
  });

  test("the bypass ignores a pending review, which GitHub has not submitted", () => {
    const bypass = { ...OWNED, reviews: [...OWNED.reviews, { id: 8, state: "PENDING", commitId: HEAD, author: "app", authorCanPush: true }] };
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true, bypass })).toEqual({ action: "merge", admin: true });
  });
});

// A COMMENT never merges, whatever its verification reasons. Base policy (CONTRIBUTING.md) allows
// the administrator bypass on the App's APPROVE plus a passing premerge, and calls any other
// bypass an operator override, which the operator performs by hand. The reasons come from
// computeVerification itself, so every kind of reason the reviewer can give is covered.
describe("decideMerge(): a COMMENT always refuses", () => {
  const NL = String.fromCharCode(10);
  // A workflow with one job per required check, each reporting under the check's name, which is
  // what computeVerification needs to read the checks as declared (#349).
  const workflowOf = (checks: typeof CORE_POLICY.requiredChecks) =>
    ["jobs:", ...checks.flatMap((check, i) => [`  job-${i}:`, `    name: ${check.name}`])].join(NL);
  const WORKFLOW = workflowOf(CORE_POLICY.requiredChecks);
  const GREEN_RUNS: CheckRun[] = CORE_POLICY.requiredChecks.map((check) => ({ name: check.name, appSlug: check.appSlug, status: "completed", conclusion: "success" }));
  const verify = (overrides: Partial<Parameters<typeof computeVerification>[0]>) =>
    computeVerification({ checkRuns: GREEN_RUNS, changedFiles: ["README.md"], workflowText: WORKFLOW, changedFilesComplete: true, policy: CORE_POLICY, ...overrides });
  const comment = (verification: { state: string; reasons: string[] }, mergeState: string) =>
    decide({ review: { ...APPROVED, event: "COMMENT", severities: [], verification }, mergeState, allowAdmin: true });
  const pending = GREEN_RUNS.map((run, i) => (i === 0 ? { ...run, status: "in_progress", conclusion: null } : run));
  const cases: [string, { state: string; reasons: string[] }][] = [
    ["an edit to CI definitions", verify({ changedFiles: [".github/workflows/test.yml"] })],
    ["an edit to a CI action", verify({ changedFiles: [".github/actions/setup/action.yml"] })],
    ["an edit to the secret scan configuration", verify({ changedFiles: [".gitleaks.toml"] })],
    ["a .ps1 change whose suite CI does not run", verify({ changedFiles: ["install/Uncovered.ps1"] })],
    ["a changed-file listing too long to read whole", verify({ changedFilesComplete: false })],
    ["a required check with no run on the head", verify({ checkRuns: GREEN_RUNS.slice(0, -1) })],
    ["a required check the workflow does not declare", verify({ workflowText: workflowOf(CORE_POLICY.requiredChecks.slice(1)) })],
    ["a required check still pending", verify({ checkRuns: pending })],
    ["no workflow at the base commit", verify({ workflowText: null })],
    ["an incomplete verification that gives no reason", { state: "incomplete", reasons: [] }],
    ["a verification that passed, as from a comment-only run", { state: "passed", reasons: [] }],
    ["a verification state the tool does not know", { state: "novel", reasons: [] }],
  ];

  test("the baseline verification passes, so each case differs by one input", () => {
    expect(verify({})).toEqual({ state: "passed", reasons: [] });
  });

  for (const [name, verification] of cases) {
    for (const mergeState of ["BLOCKED", "CLEAN"]) {
      test(`refuses ${name}, merge state ${mergeState}, even with --allow-admin`, () => {
        const decision = comment(verification, mergeState);
        expect(decision.action).toBe("refuse");
        const reason = decision.action === "refuse" ? decision.reason : "";
        expect(reason).toContain("operator override");
        expect(reason).toContain("bypass-rationale comment");
      });
    }
  }

  test("names no reason text in the refusal", () => {
    const decision = comment(verify({ checkRuns: GREEN_RUNS.slice(0, -1) }), "BLOCKED");
    expect(decision.action === "refuse" ? decision.reason : "").not.toContain("Gitleaks");
  });
});

describe("decideMerge(): refuses", () => {
  const refused = (overrides: Partial<Input>) => {
    const decision = decide(overrides);
    expect(decision.action).toBe("refuse");
    return decision.action === "refuse" ? decision.reason : "";
  };

  test("a review that was not posted", () => {
    expect(refused({ review: { ...APPROVED, status: "dry-run" } })).toContain("not posted");
  });

  test("a COMMENT from a reviewer that never produced findings, even with --allow-admin", () => {
    expect(refused({ review: { ...APPROVED, event: "COMMENT", reviewerOk: false, severities: [] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "no valid findings",
    );
  });

  test("a review of a different head", () => {
    expect(refused({ review: { ...APPROVED, headSha: "c".repeat(40) } })).toContain("not the one that was reviewed");
  });

  test("a head that moved after the review", () => {
    expect(refused({ currentHead: "c".repeat(40) })).toContain("not the one that was reviewed");
  });

  test("a failed check", () => {
    expect(refused({ checks: [...GREEN, { kind: "CheckRun", name: "Pester", status: "COMPLETED", conclusion: "FAILURE" }] })).toContain("1 not successful");
  });

  test("a skipped check, because only SUCCESS counts", () => {
    expect(refused({ checks: [{ kind: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" }] })).toContain("not every check");
  });

  test("a pending check", () => {
    expect(refused({ checks: [{ kind: "CheckRun", name: "x", status: "IN_PROGRESS", conclusion: "" }] })).toContain("1 pending");
  });

  test("no checks at all", () => {
    expect(refused({ checks: [] })).toContain("0 total");
  });

  test("APPROVE on a blocked merge without --allow-admin", () => {
    expect(refused({ mergeState: "BLOCKED" })).toContain("--allow-admin");
  });

  test("APPROVE on a merge state other than CLEAN or BLOCKED", () => {
    expect(refused({ mergeState: "BEHIND", allowAdmin: true })).toContain("merge state BEHIND");
  });

  test("a COMMENT without --allow-admin", () => {
    expect(refused({ review: COMMENTED, mergeState: "BLOCKED" })).toContain("operator override");
  });

  test("an APPROVE whose verification did not pass", () => {
    expect(refused({ review: { ...APPROVED, verification: CI_EDIT } })).toContain("verification");
  });

  test("a COMMENT with an at-floor finding, even with --allow-admin", () => {
    expect(refused({ review: { ...COMMENTED, severities: ["security"] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "1 finding(s) at or above the floor",
    );
  });

  test("REQUEST_CHANGES, even with --allow-admin and no findings", () => {
    expect(refused({ review: { ...APPROVED, event: "REQUEST_CHANGES", severities: [] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "event REQUEST_CHANGES",
    );
  });

  test("an APPROVE that still carries an at-floor finding, even on a CLEAN merge state", () => {
    expect(refused({ review: { ...APPROVED, severities: ["security"] } })).toContain("1 finding(s) at or above the floor");
  });

  test("a merge state that is not a plain enum value is not echoed", () => {
    const reason = refused({ mergeState: "BE HIND leaked", allowAdmin: true });
    expect(reason).toContain("merge state unrecognised");
    expect(reason).not.toContain("leaked");
  });

  test("an unknown severity, which counts as at the floor", () => {
    expect(refused({ review: { ...COMMENTED, severities: ["novel"] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "1 finding(s)",
    );
  });
});

// The bypass skips the default ruleset, which blocks for more than the code-owner review. So a
// BLOCKED state alone proves nothing: the bypass needs a changed file that is code-owned at the
// base, and the App's approval as the latest review. Anything that cannot be established refuses.
describe("decideMerge(): refuses the bypass when the block is not shown to be the code-owner review", () => {
  const bypassRefused = (bypass: BypassEvidence | null, review: ReviewResult = APPROVED, checks: CheckEntry[] = GREEN) => {
    const decision = decide({ review, mergeState: "BLOCKED", allowAdmin: true, bypass, checks });
    expect(decision.action).toBe("refuse");
    const reason = decision.action === "refuse" ? decision.reason : "";
    expect(reason).toContain("operator");
    return reason;
  };

  test("no evidence was gathered", () => {
    expect(bypassRefused(null)).toContain("could not be established");
  });

  test("the evidence could not be read", () => {
    expect(bypassRefused({ readable: false, reason: "the changed-file list could not be read whole" })).toContain("changed-file list could not be read whole");
  });

  test("the base has no CODEOWNERS", () => {
    expect(bypassRefused({ ...OWNED, codeowners: null })).toContain("no .github/CODEOWNERS");
  });

  test("a CODEOWNERS line this tool cannot read, naming the line and not its text", () => {
    const reason = bypassRefused({ ...OWNED, codeowners: "/tools/ @owner\n*.secret-pattern @owner\n" });
    expect(reason).toContain("line 2");
    expect(reason).not.toContain("secret-pattern");
  });

  test("no changed file is owned", () => {
    expect(bypassRefused({ ...OWNED, changedFiles: ["README.md", "docs/x.md"] })).toContain("no changed file is code-owned");
  });

  test("an empty changed-file list", () => {
    expect(bypassRefused({ ...OWNED, changedFiles: [] })).toContain("no changed file is code-owned");
  });

  test("a changed file a later line unowns", () => {
    expect(bypassRefused({ ...OWNED, codeowners: "/tools/ @owner\n/tools/free/\n", changedFiles: ["tools/free/x.ts"] })).toContain(
      "no changed file is code-owned",
    );
  });

  test("a review that carries no posted id", () => {
    expect(bypassRefused(OWNED, { ...APPROVED, postedId: null })).toContain("latest review");
  });

  test("another review submitted after the App's", () => {
    expect(bypassRefused({ ...OWNED, reviews: [...OWNED.reviews, { id: 9, state: "COMMENTED", commitId: HEAD, author: "other", authorCanPush: true }] })).toContain("latest review");
  });

  test("an approval of this head that is not the one the App just posted", () => {
    expect(bypassRefused({ ...OWNED, reviews: [{ id: 3, state: "APPROVED", commitId: HEAD, author: "app", authorCanPush: true }] })).toContain("latest review");
  });

  test("the App's review missing from the list", () => {
    expect(bypassRefused({ ...OWNED, reviews: [OWNED.reviews[0]!] })).toContain("latest review");
  });

  test("no reviews at all", () => {
    expect(bypassRefused({ ...OWNED, reviews: [] })).toContain("latest review");
  });

  test("the App's review listed in a state other than APPROVED", () => {
    expect(bypassRefused({ ...OWNED, reviews: [{ id: 1, state: "DISMISSED", commitId: HEAD, author: "app", authorCanPush: true }] })).toContain("latest review");
  });

  test("the App's review listed against another commit", () => {
    expect(bypassRefused({ ...OWNED, reviews: [{ id: 1, state: "APPROVED", commitId: "c".repeat(40), author: "app", authorCanPush: true }] })).toContain("latest review");
  });

  // Another reviewer's request for changes stays until that reviewer approves or it is dismissed.
  // A comment or a pending review does not clear it.
  const other = (id: number, state: string): ReviewEntry => ({ id, state, commitId: HEAD, author: "other", authorCanPush: true });
  const withFirst = (...first: ReviewEntry[]): BypassEvidence => ({ ...OWNED, reviews: [...first, ...OWNED.reviews] });

  test("another reviewer's latest opinion requests changes", () => {
    expect(bypassRefused(withFirst(other(20, "CHANGES_REQUESTED")))).toContain("requests changes");
  });

  test("a request for changes followed only by a comment or a pending review", () => {
    expect(bypassRefused(withFirst(other(20, "CHANGES_REQUESTED"), other(21, "COMMENTED")))).toContain("requests changes");
    expect(bypassRefused(withFirst(other(20, "CHANGES_REQUESTED"), other(21, "PENDING")))).toContain("requests changes");
  });

  test("the App's own earlier request for changes, superseded by its approval, does not block", () => {
    const earlier: ReviewEntry = { id: 30, state: "CHANGES_REQUESTED", commitId: "c".repeat(40), author: "app", authorCanPush: true };
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true, bypass: withFirst(earlier) })).toEqual({ action: "merge", admin: true });
  });

  test("a request for changes later approved or dismissed by the same reviewer does not block", () => {
    for (const later of ["APPROVED", "DISMISSED"]) {
      expect(decide({ mergeState: "BLOCKED", allowAdmin: true, bypass: withFirst(other(20, "CHANGES_REQUESTED"), other(21, later)) })).toEqual({
        action: "merge",
        admin: true,
      });
    }
  });

  // The bypass skips every rule in the default ruleset, so each active rule on the base branch other
  // than the code-owner review must be shown met from data the tool reads. A rule it cannot check
  // refuses.
  const withRules = (rules: BranchRule[]): BypassEvidence => ({ ...OWNED, rules });
  const withPr = (overrides: Record<string, unknown>): BypassEvidence =>
    withRules([...RULES.filter((rule) => rule.type !== "pull_request"), { type: "pull_request", parameters: { ...PR_RULE, ...overrides } }]);
  const withStatus = (overrides: Record<string, unknown>): BypassEvidence =>
    withRules([...RULES.filter((rule) => rule.type !== "required_status_checks"), { type: "required_status_checks", parameters: { ...STATUS_RULE, ...overrides } }]);

  for (const type of ["code_quality", "code_scanning", "copilot_code_review", "update", "merge_queue", "workflows"]) {
    test(`a ${type} rule this tool cannot check`, () => {
      expect(bypassRefused(withRules([...RULES, { type, parameters: {} }]))).toContain(`${type} rule`);
    });
  }

  test("this repository's own rules as of this change, which the tool cannot show met", () => {
    const live: BranchRule[] = [
      { type: "required_status_checks", parameters: { ...STATUS_RULE, required_status_checks: [{ context: "bun test" }] } },
      { type: "code_scanning", parameters: { code_scanning_tools: [{ tool: "CodeQL" }] } },
      { type: "non_fast_forward", parameters: null },
      { type: "deletion", parameters: null },
      { type: "code_quality", parameters: { severity: "errors" } },
      { type: "copilot_code_review", parameters: { review_on_push: true } },
      { type: "pull_request", parameters: { ...PR_RULE, require_last_push_approval: true, require_extra_approval_for_unattributed_changes: true } },
    ];
    expect(bypassRefused(withRules(live))).toContain("rule this tool cannot check");
  });

  test("no rule on the base branch requires a code-owner review", () => {
    expect(bypassRefused(withRules(RULES.filter((rule) => rule.type !== "pull_request")))).toContain("requires a code-owner review");
    expect(bypassRefused(withPr({ require_code_owner_review: false }))).toContain("requires a code-owner review");
    expect(bypassRefused(withRules([]))).toContain("requires a code-owner review");
  });

  test("a required check the head has not passed", () => {
    expect(bypassRefused(withStatus({ required_status_checks: [{ context: "bun test" }, { context: "Pester" }] }))).toContain("required check");
  });

  test("a required-check rule that also needs the branch up to date, or is not shaped as expected", () => {
    expect(bypassRefused(withStatus({ strict_required_status_checks_policy: true }))).toContain("required_status_checks");
    expect(bypassRefused(withStatus({ required_status_checks: "bun test" }))).toContain("required_status_checks");
    expect(bypassRefused(withStatus({ required_status_checks: [{ name: "bun test" }] }))).toContain("required_status_checks");
    expect(bypassRefused(withStatus({ novel_setting: false }))).toContain("required_status_checks");
  });

  test("fewer counted approvals than the review rule requires", () => {
    expect(bypassRefused(withPr({ required_approving_review_count: 2 }))).toContain("approvals");
  });

  test("an App approval GitHub does not count, from an author without push access", () => {
    const reviews = OWNED.reviews.map((entry) => (entry.id === 1 ? { ...entry, authorCanPush: false } : entry));
    expect(bypassRefused({ ...OWNED, reviews })).toContain("approvals");
  });

  const prCases: [string, Record<string, unknown>][] = [
    ["approval of the last push by someone else, which the tool cannot attribute", { require_last_push_approval: true }],
    ["resolved review threads", { required_review_thread_resolution: true }],
    ["named required reviewers", { required_reviewers: [{ reviewer: { id: 1 } }] }],
    ["an extra approval for unattributed changes", { require_extra_approval_for_unattributed_changes: true }],
    ["a merge method list without the one used", { allowed_merge_methods: ["squash"] }],
    ["a parameter this tool does not know", { novel_requirement: false }],
    ["a count that is not an integer", { required_approving_review_count: "1" }],
    ["a code-owner flag that is not a boolean", { require_code_owner_review: "true" }],
  ];
  for (const [name, overrides] of prCases) {
    test(`a review rule requiring ${name}`, () => {
      expect(bypassRefused(withPr(overrides))).toContain("pull_request");
    });
  }

  test("a review rule with no parameters", () => {
    expect(bypassRefused(withRules([...RULES.filter((rule) => rule.type !== "pull_request"), { type: "pull_request", parameters: null }]))).toContain(
      "requires a code-owner review",
    );
  });

  test("a rule type that is not a plain enum value is not echoed", () => {
    const reason = bypassRefused(withRules([...RULES, { type: "leaked text here", parameters: null }]));
    expect(reason).toContain("unrecognised rule");
    expect(reason).not.toContain("leaked");
  });

  // A required context that names an app needs a check run from that app. Every check of that name
  // must have succeeded, whichever app made it.
  const withRuns = (checkRuns: CheckRunEntry[], bypass: BypassEvidence = OWNED): BypassEvidence => ({ ...(bypass as object), checkRuns }) as BypassEvidence;
  const run = (appId: number | null, conclusion = "SUCCESS"): CheckRunEntry => ({ name: "bun test", status: "COMPLETED", conclusion, appId });

  test("a required check from an app other than the one the rule names", () => {
    expect(bypassRefused(withRuns([run(2)]))).toContain("from the app the rule names");
  });

  test("a required check whose app could not be read", () => {
    expect(bypassRefused(withRuns([run(null), run(1)]))).toContain("could not be read");
  });

  test("a required check that names an app, seen only in the rollup", () => {
    expect(bypassRefused(withRuns([]))).toContain("from the app the rule names");
  });

  test("checks of a required name with mixed conclusions", () => {
    expect(bypassRefused(withRuns([run(1), run(2, "FAILURE")]))).toContain("did not all succeed");
  });

  test("a required context with an app id that is not an integer, or a key this tool does not know", () => {
    expect(bypassRefused(withStatus({ required_status_checks: [{ context: "bun test", integration_id: "1" }] }))).toContain("required_status_checks");
    expect(bypassRefused(withStatus({ required_status_checks: [{ context: "bun test", app: 1 }] }))).toContain("required_status_checks");
  });

  // Reviews are grouped by author, so one with no login could hide another's request for changes.
  test("a review with an opinion and no author login", () => {
    const ghost: ReviewEntry = { id: 40, state: "APPROVED", commitId: HEAD, author: "", authorCanPush: true };
    expect(bypassRefused(withFirst(other(20, "CHANGES_REQUESTED"), ghost))).toContain("no author login");
    expect(bypassRefused(withFirst({ ...ghost, state: "DISMISSED" }))).toContain("no author login");
  });

  test("a comment with no author login does not block", () => {
    const ghost: ReviewEntry = { id: 40, state: "COMMENTED", commitId: HEAD, author: "", authorCanPush: false };
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true, bypass: withFirst(ghost) })).toEqual({ action: "merge", admin: true });
  });

  // Classic branch protection, when the base branch has it, is checked as the rules are.
  const CLASSIC = {
    url: "https://api.example.test/protection",
    required_status_checks: { url: "u", strict: false, contexts: ["bun test"], contexts_url: "u", checks: [{ context: "bun test", app_id: 1 }] },
    required_pull_request_reviews: { url: "u", dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 1, require_last_push_approval: false },
    enforce_admins: { url: "u", enabled: false },
    required_linear_history: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    block_creations: { enabled: false },
    required_conversation_resolution: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
    required_signatures: { url: "u", enabled: false },
  };
  const classic = (overrides: Record<string, unknown>, rules: BranchRule[] = []): BypassEvidence => ({ ...OWNED, rules, protection: { ...CLASSIC, ...overrides } }) as BypassEvidence;

  test("classic protection whose requirements, the code-owner review aside, are met", () => {
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true, bypass: classic({}) })).toEqual({ action: "merge", admin: true });
  });

  const classicCases: [string, Record<string, unknown>, string][] = [
    ["linear history", { required_linear_history: { enabled: true } }, "classic branch protection"],
    ["conversation resolution", { required_conversation_resolution: { enabled: true } }, "classic branch protection"],
    ["a locked branch", { lock_branch: { enabled: true } }, "classic branch protection"],
    ["signed commits", { required_signatures: { enabled: true } }, "classic branch protection"],
    ["push restrictions", { restrictions: { users: [] } }, "classic branch protection"],
    ["a key this tool does not know", { novel_protection: { enabled: false } }, "classic branch protection"],
    ["an up-to-date branch", { required_status_checks: { ...CLASSIC.required_status_checks, strict: true } }, "classic branch protection"],
    ["a check the head did not pass", { required_status_checks: { ...CLASSIC.required_status_checks, checks: [{ context: "Pester", app_id: null }] } }, "required check"],
    ["a check from another app", { required_status_checks: { ...CLASSIC.required_status_checks, checks: [{ context: "bun test", app_id: 2 }] } }, "from the app"],
    ["approval of the last push", { required_pull_request_reviews: { ...CLASSIC.required_pull_request_reviews, require_last_push_approval: true } }, "pull_request"],
    ["two approvals", { required_pull_request_reviews: { ...CLASSIC.required_pull_request_reviews, required_approving_review_count: 2 } }, "approvals"],
    ["a review setting this tool does not know", { required_pull_request_reviews: { ...CLASSIC.required_pull_request_reviews, novel: false } }, "classic branch protection"],
    ["no code-owner review, with none in the rulesets either", { required_pull_request_reviews: { ...CLASSIC.required_pull_request_reviews, require_code_owner_reviews: false } }, "requires a code-owner review"],
  ];
  for (const [name, overrides, fragment] of classicCases) {
    test(`classic protection requiring ${name}`, () => {
      expect(bypassRefused(classic(overrides))).toContain(fragment);
    });
  }

  test("classic protection that is not an object", () => {
    expect(bypassRefused({ ...OWNED, protection: "on" } as unknown as BypassEvidence)).toContain("could not be read");
  });

  test("a plain CLEAN merge needs none of it", () => {
    expect(decide({ allowAdmin: true, bypass: null })).toEqual({ action: "merge", admin: false });
  });
});

describe("helpers", () => {
  test("atFloorCount counts load-bearing and unknown severities", () => {
    expect(atFloorCount(["correctness", "naming", "fails-open", "other", "made-up"])).toBe(3);
  });

  test("checksSummary needs at least one check", () => {
    expect(checksSummary([]).ok).toBe(false);
    expect(checksSummary(GREEN).ok).toBe(true);
  });
});

describe("parseReviewOutput()", () => {
  test("reads the fields the decision uses", () => {
    const out = JSON.stringify({
      status: "posted",
      event: "APPROVE",
      reviewerOk: true,
      headSha: HEAD,
      severities: ["naming"],
      refusal: null,
      posted: { id: 1, htmlUrl: "https://example.test/r" },
      verification: { state: "passed", reasons: [] },
      body: "ignored",
    });
    expect(parseReviewOutput(out)).toEqual({ ...APPROVED, postedUrl: "https://example.test/r" });
  });

  test("reads a posted id only when it is an integer", () => {
    const fields = { status: "posted", event: "APPROVE", reviewerOk: true, headSha: HEAD, severities: [], refusal: null, verification: { state: "passed", reasons: [] } };
    expect(parseReviewOutput(JSON.stringify({ ...fields, posted: { id: "1", htmlUrl: "u" } })).postedId).toBeNull();
    expect(parseReviewOutput(JSON.stringify({ ...fields, posted: { id: 1.5, htmlUrl: "u" } })).postedId).toBeNull();
    expect(parseReviewOutput(JSON.stringify({ ...fields, posted: null })).postedId).toBeNull();
  });

  test("throws on output with no verification, or one of the wrong shape", () => {
    const fields = { status: "posted", event: "COMMENT", reviewerOk: true, headSha: HEAD, severities: [], refusal: null, posted: null };
    expect(() => parseReviewOutput(JSON.stringify(fields))).toThrow(PublishError);
    expect(() => parseReviewOutput(JSON.stringify({ ...fields, verification: { state: "incomplete" } }))).toThrow(PublishError);
    expect(() => parseReviewOutput(JSON.stringify({ ...fields, verification: { state: "incomplete", reasons: [1] } }))).toThrow(PublishError);
    expect(() => parseReviewOutput(JSON.stringify({ ...fields, verification: { state: 3, reasons: [] } }))).toThrow(PublishError);
  });

  test("throws on output that is not JSON", () => {
    expect(() => parseReviewOutput("status=posted event=APPROVE")).toThrow(PublishError);
  });

  test("throws on output missing a field", () => {
    expect(() => parseReviewOutput(JSON.stringify({ status: "posted", event: "APPROVE" }))).toThrow(PublishError);
  });
});
