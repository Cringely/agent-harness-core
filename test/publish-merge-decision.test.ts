// Tests for tools/publish/merge-decision.ts (#274): every way the merge decision refuses, and the
// only two ways it merges.

import { describe, expect, test } from "bun:test";
import { PublishError } from "../tools/publish/errors";
import type { CheckEntry } from "../tools/publish/gh";
import { atFloorCount, checksSummary, decideMerge, parseReviewOutput, type ReviewResult } from "../tools/publish/merge-decision";
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
  verification: { state: "passed", reasons: [] },
};
// What the reviewer reports for a pull request that edits CI definitions: every required check ran
// and succeeded, but CI cannot vouch for a change to itself.
const CI_EDIT = { state: "incomplete", reasons: ["the pull request edits CI definitions, so its own checks cannot vouch for it: .github/workflows/test.yml"] };
const COMMENTED: ReviewResult = { ...APPROVED, event: "COMMENT", verification: CI_EDIT };
const base = { review: APPROVED, reviewedHead: HEAD, currentHead: HEAD, checks: GREEN, mergeState: "CLEAN", allowAdmin: false };
type Input = Parameters<typeof decideMerge>[0];
const decide = (overrides: Partial<Input>) => decideMerge({ ...base, ...overrides });

describe("decideMerge(): merges", () => {
  test("a plain merge on APPROVE and CLEAN", () => {
    expect(decide({})).toEqual({ action: "merge", admin: false });
  });

  test("the bypass on APPROVE and BLOCKED with --allow-admin", () => {
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true })).toEqual({ action: "merge", admin: true });
  });

  test("the bypass on a COMMENT with no at-floor finding and --allow-admin", () => {
    expect(decide({ review: COMMENTED, mergeState: "BLOCKED", allowAdmin: true })).toEqual({ action: "merge", admin: true });
  });
});

// A COMMENT is admitted to the bypass only when every reason the reviewer gave is one CI cannot
// vouch for by design. Those reasons come from computeVerification itself here, so a change to its
// wording that would stop them matching shows up as a failure rather than as a silent refusal.
describe("decideMerge(): the COMMENT bypass reads the reviewer's verification", () => {
  const NL = String.fromCharCode(10);
  const WORKFLOW = CORE_POLICY.requiredChecks.map((check) => `    name: ${check.name}`).join(NL);
  const GREEN_RUNS: CheckRun[] = CORE_POLICY.requiredChecks.map((check) => ({ name: check.name, appSlug: check.appSlug, status: "completed", conclusion: "success" }));
  const verify = (overrides: Partial<Parameters<typeof computeVerification>[0]>) =>
    computeVerification({ checkRuns: GREEN_RUNS, changedFiles: ["README.md"], workflowText: WORKFLOW, changedFilesComplete: true, policy: CORE_POLICY, ...overrides });
  const bypass = (verification: { state: string; reasons: string[] }) =>
    decide({ review: { ...APPROVED, event: "COMMENT", verification }, mergeState: "BLOCKED", allowAdmin: true });

  test("the baseline verification passes, so each case below differs by one input", () => {
    expect(verify({})).toEqual({ state: "passed", reasons: [] });
  });

  test("admits an edit to CI definitions", () => {
    expect(bypass(verify({ changedFiles: [".github/workflows/test.yml"] }))).toEqual({ action: "merge", admin: true });
    expect(bypass(verify({ changedFiles: [".github/actions/setup/action.yml"] }))).toEqual({ action: "merge", admin: true });
  });

  test("admits an edit to the secret scan configuration", () => {
    expect(bypass(verify({ changedFiles: [".gitleaks.toml"] }))).toEqual({ action: "merge", admin: true });
  });

  test("admits a .ps1 change whose suite CI does not run", () => {
    expect(bypass(verify({ changedFiles: ["install/Uncovered.ps1"] }))).toEqual({ action: "merge", admin: true });
  });

  test("admits a changed-file listing too long to read whole", () => {
    expect(bypass(verify({ changedFilesComplete: false }))).toEqual({ action: "merge", admin: true });
  });

  test("refuses a required check with no run on the head", () => {
    const decision = bypass(verify({ checkRuns: GREEN_RUNS.slice(0, -1) }));
    expect(decision).toMatchObject({ action: "refuse" });
    expect(decision.action === "refuse" ? decision.reason : "").toContain("does not cover");
  });

  test("refuses a required check whose name the workflow does not declare", () => {
    expect(bypass(verify({ workflowText: WORKFLOW.split(NL).slice(1).join(NL) }))).toMatchObject({ action: "refuse" });
  });

  test("refuses a required check still pending", () => {
    const runs = GREEN_RUNS.map((run, i) => (i === 0 ? { ...run, status: "in_progress", conclusion: null } : run));
    expect(bypass(verify({ checkRuns: runs }))).toMatchObject({ action: "refuse" });
  });

  test("refuses a covered reason beside one it does not cover", () => {
    expect(bypass(verify({ changedFiles: [".github/workflows/test.yml"], checkRuns: GREEN_RUNS.slice(1) }))).toMatchObject({ action: "refuse" });
  });

  test("refuses no workflow at the base commit", () => {
    expect(bypass(verify({ workflowText: null }))).toMatchObject({ action: "refuse" });
  });

  test("refuses an incomplete verification that gives no reason", () => {
    expect(bypass({ state: "incomplete", reasons: [] })).toMatchObject({ action: "refuse" });
  });

  test("refuses a state other than incomplete, even when every reason is covered", () => {
    expect(bypass({ ...CI_EDIT, state: "failed" })).toMatchObject({ action: "refuse" });
    expect(bypass({ ...CI_EDIT, state: "novel" })).toMatchObject({ action: "refuse" });
  });

  test("refuses a COMMENT whose verification passed, as from a comment-only run", () => {
    expect(bypass({ state: "passed", reasons: [] })).toMatchObject({ action: "refuse" });
  });

  test("refuses a reason that only contains a covered phrase", () => {
    expect(bypass({ state: "incomplete", reasons: [`x ${CI_EDIT.reasons[0]}`] })).toMatchObject({ action: "refuse" });
  });

  test("names no reason text in the refusal", () => {
    const decision = bypass(verify({ checkRuns: GREEN_RUNS.slice(0, -1) }));
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
    expect(refused({ review: COMMENTED, mergeState: "BLOCKED" })).toContain("Only --allow-admin");
  });

  test("a COMMENT on a merge state other than CLEAN or BLOCKED, even with --allow-admin", () => {
    expect(refused({ review: COMMENTED, mergeState: "BEHIND", allowAdmin: true })).toContain("merge state BEHIND");
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
