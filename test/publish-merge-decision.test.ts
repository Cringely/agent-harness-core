// Tests for tools/publish/merge-decision.ts (#274): every way the merge decision refuses, and the
// only two ways it merges.

import { describe, expect, test } from "bun:test";
import { PublishError } from "../tools/publish/errors";
import type { CheckEntry } from "../tools/publish/gh";
import { atFloorCount, checksSummary, decideMerge, parseReviewOutput, type ReviewResult } from "../tools/publish/merge-decision";
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
};
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
    expect(decide({ review: { ...APPROVED, event: "COMMENT" }, mergeState: "BLOCKED", allowAdmin: true })).toEqual({ action: "merge", admin: true });
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
    expect(refused({ review: { ...APPROVED, event: "COMMENT" }, mergeState: "BLOCKED" })).toContain("Only --allow-admin");
  });

  test("a COMMENT on a merge state other than CLEAN or BLOCKED, even with --allow-admin", () => {
    expect(refused({ review: { ...APPROVED, event: "COMMENT" }, mergeState: "BEHIND", allowAdmin: true })).toContain("merge state BEHIND");
  });

  test("a COMMENT with an at-floor finding, even with --allow-admin", () => {
    expect(refused({ review: { ...APPROVED, event: "COMMENT", severities: ["security"] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
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
    expect(refused({ review: { ...APPROVED, event: "COMMENT", severities: ["novel"] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
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
      body: "ignored",
    });
    expect(parseReviewOutput(out)).toEqual({ ...APPROVED, postedUrl: "https://example.test/r" });
  });

  test("throws on output that is not JSON", () => {
    expect(() => parseReviewOutput("status=posted event=APPROVE")).toThrow(PublishError);
  });

  test("throws on output missing a field", () => {
    expect(() => parseReviewOutput(JSON.stringify({ status: "posted", event: "APPROVE" }))).toThrow(PublishError);
  });
});
