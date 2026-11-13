// Tests for tools/publish/merge-decision.ts (#274): every way the merge decision refuses, and the
// only two ways it merges, both on the App's APPROVE.

import { describe, expect, test } from "bun:test";
import { PublishError } from "../tools/publish/errors";
import type { CheckEntry } from "../tools/publish/gh";
import { atFloorCount, checksSummary, decideMerge, parseReviewOutput, type BypassEvidence, type ReviewResult } from "../tools/publish/merge-decision";
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
// What review-merge reads for the bypass: CODEOWNERS at the base, the changed files, and the
// pull request's reviews in the order GitHub lists them, the App's own approval last.
const OWNED: BypassEvidence = {
  readable: true,
  codeowners: "# owned\n/tools/ @owner\n",
  changedFiles: ["README.md", "tools/x.ts"],
  reviews: [
    { id: 7, state: "COMMENTED", commitId: "c".repeat(40) },
    { id: 1, state: "APPROVED", commitId: HEAD },
  ],
};
const base = { review: APPROVED, reviewedHead: HEAD, currentHead: HEAD, checks: GREEN, mergeState: "CLEAN", allowAdmin: false, bypass: null };
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
    const bypass = { ...OWNED, reviews: [...OWNED.reviews, { id: 8, state: "PENDING", commitId: HEAD }] };
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true, bypass })).toEqual({ action: "merge", admin: true });
  });
});

// A COMMENT never merges, whatever its verification reasons. Base policy (CONTRIBUTING.md) allows
// the administrator bypass on the App's APPROVE plus a passing premerge, and calls any other
// bypass an operator override, which the operator performs by hand. The reasons come from
// computeVerification itself, so every kind of reason the reviewer can give is covered.
describe("decideMerge(): a COMMENT always refuses", () => {
  const NL = String.fromCharCode(10);
  const WORKFLOW = CORE_POLICY.requiredChecks.map((check) => `    name: ${check.name}`).join(NL);
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
    ["a required check the workflow does not declare", verify({ workflowText: WORKFLOW.split(NL).slice(1).join(NL) })],
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
  const bypassRefused = (bypass: BypassEvidence | null, review: ReviewResult = APPROVED) => {
    const decision = decide({ review, mergeState: "BLOCKED", allowAdmin: true, bypass });
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
    expect(bypassRefused({ ...OWNED, reviews: [...OWNED.reviews, { id: 9, state: "COMMENTED", commitId: HEAD }] })).toContain("latest review");
  });

  test("an approval of this head that is not the one the App just posted", () => {
    expect(bypassRefused({ ...OWNED, reviews: [{ id: 3, state: "APPROVED", commitId: HEAD }] })).toContain("latest review");
  });

  test("the App's review missing from the list", () => {
    expect(bypassRefused({ ...OWNED, reviews: [OWNED.reviews[0]!] })).toContain("latest review");
  });

  test("no reviews at all", () => {
    expect(bypassRefused({ ...OWNED, reviews: [] })).toContain("latest review");
  });

  test("the App's review listed in a state other than APPROVED", () => {
    expect(bypassRefused({ ...OWNED, reviews: [{ id: 1, state: "DISMISSED", commitId: HEAD }] })).toContain("latest review");
  });

  test("the App's review listed against another commit", () => {
    expect(bypassRefused({ ...OWNED, reviews: [{ id: 1, state: "APPROVED", commitId: "c".repeat(40) }] })).toContain("latest review");
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
