// Tests for tools/pr-review/verdict.ts. computeVerification decides whether CI actually vouches
// for the head commit; computeEvent turns that and the finding severities into the posted event.
// #120's option-A ruling is the spec for both.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REQUIRED_CHECKS,
  ciCoveredPesterSuites,
  computeEvent,
  computeVerification,
  verificationOf,
} from "../tools/pr-review/verdict";
import {
  BELOW_FLOOR_SEVERITIES,
  LOAD_BEARING_SEVERITIES,
  type CheckRun,
  type PrSnapshot,
  type Verification,
} from "../tools/pr-review/types";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_WORKFLOW = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");

const green = (): CheckRun[] =>
  REQUIRED_CHECKS.map((c) => ({ name: c.name, appSlug: c.appSlug, status: "completed", conclusion: "success" }));

const withRun = (index: number, patch: Partial<CheckRun>): CheckRun[] =>
  green().map((run, i) => (i === index ? { ...run, ...patch } : run));

// Same shape as .github/workflows/test.yml: one suite on a run line, two named only in comments.
// Synthetic, so this file does not break the day CI starts running more suites (#90). CRLF on
// purpose, which is what a Windows checkout hands the parser.
const WORKFLOW = [
  "jobs:",
  "  pester-test:",
  "    steps:",
  "      # Run them by hand until the coupling is removed:",
  "      #   pwsh -NoProfile -File install/Install-Account.Tests.ps1",
  "      #   pwsh -NoProfile -File install/Install-Harness.Tests.ps1",
  "      - name: Restore-ClaudeProject.Tests.ps1",
  "        run: pwsh -NoProfile -File install/Restore-ClaudeProject.Tests.ps1",
].join("\r\n");

const verify = (
  checkRuns: CheckRun[],
  changedFiles: string[] = ["README.md"],
  workflowText: string | null = WORKFLOW,
  changedFilesComplete = true,
) => computeVerification({ checkRuns, changedFiles, workflowText, changedFilesComplete });

const PASSED: Verification = { state: "passed", reasons: [] };
const FAILED: Verification = { state: "failed", reasons: ["x"] };
const INCOMPLETE: Verification = { state: "incomplete", reasons: ["x"] };

describe("REQUIRED_CHECKS is tied to the workflow it measures", () => {
  // Pinned on the real file rather than restated: renaming a job in test.yml without updating
  // REQUIRED_CHECKS turns every future review into COMMENT, and this test names the cause.
  test.each(REQUIRED_CHECKS.map((c) => c.name))("the workflow declares a job named %p", (name) => {
    const lines = REAL_WORKFLOW.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain(`name: ${name}`);
  });
});

describe("ciCoveredPesterSuites()", () => {
  test("counts run lines and ignores suites named only in comments", () => {
    expect([...ciCoveredPesterSuites(WORKFLOW)]).toEqual(["install/Restore-ClaudeProject.Tests.ps1"]);
  });

  test("on the real workflow, finds at least one suite and every suite it finds exists", () => {
    const suites = [...ciCoveredPesterSuites(REAL_WORKFLOW)];
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) expect(existsSync(join(REPO_ROOT, suite))).toBe(true);
  });
});

describe("computeVerification()", () => {
  test("all required checks succeeded and nothing uncovered changed: passed", () => {
    expect(verify(green())).toEqual({ state: "passed", reasons: [] });
  });

  test.each(["failure", "timed_out"])("a required check concluded %s: failed", (conclusion) => {
    const result = verify(withRun(0, { conclusion }));
    expect(result.state).toBe("failed");
    expect(result.reasons.join("\n")).toContain(REQUIRED_CHECKS[0]!.name);
  });

  test.each(["cancelled", "skipped", "neutral", "action_required", "stale", null])(
    "a required check completed with conclusion %p: incomplete",
    (conclusion) => {
      expect(verify(withRun(1, { conclusion })).state).toBe("incomplete");
    },
  );

  test("a required check still in progress: incomplete", () => {
    expect(verify(withRun(0, { status: "in_progress", conclusion: null })).state).toBe("incomplete");
  });

  test("a required check with no run at all: incomplete", () => {
    expect(verify(green().slice(1)).state).toBe("incomplete");
  });

  test("a run with the right name from a different app does not count", () => {
    expect(verify(withRun(0, { appSlug: "some-other-app" })).state).toBe("incomplete");
  });

  test("a pull request that edits CI definitions: incomplete even when every check is green", () => {
    const result = verify(green(), [".github/workflows/test.yml"]);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain(".github/workflows/test.yml");
  });

  test.each(["install/Restore-ClaudeProject.ps1", "install/Restore-ClaudeProject.Tests.ps1"])(
    "%s has its suite on a run line: passed",
    (path) => {
      expect(verify(green(), [path]).state).toBe("passed");
    },
  );

  test.each([
    "install/Install-Harness.ps1",
    "install/Install-Harness.Tests.ps1",
    "install/AccountShared.ps1",
    "account/claude/hooks/Scan-MemorySecrets.PS1",
  ])("%s has no suite on a run line: incomplete, naming the file", (path) => {
    const result = verify(green(), [path]);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain(path);
  });

  test("no workflow file at the base commit: incomplete", () => {
    expect(verify(green(), ["README.md"], null).state).toBe("incomplete");
  });

  // GitHub lists at most 3,000 changed files. A workflow edit or an uncovered .ps1 past the end of
  // the listing would never be seen, and verification would read passed.
  test("an incomplete changed-file listing: incomplete even when every check is green", () => {
    const result = verify(green(), ["README.md"], WORKFLOW, false);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join(" ")).toContain("listing");
  });

  test("a failure alongside an uncovered file is failed, and keeps both reasons", () => {
    const result = verify(withRun(0, { conclusion: "failure" }), ["install/Install-Harness.ps1"]);
    expect(result.state).toBe("failed");
    expect(result.reasons.length).toBe(2);
  });
});

describe("verificationOf() reads exactly the four fields from a PrSnapshot", () => {
  // isOpen and diff sit beside changedFilesComplete and workflowText in PrSnapshot and share their
  // types (boolean, and string | null). omittedFiles shares changedFiles' type. Each decoy below
  // is set to a value that would change the result if verificationOf read the decoy instead of the
  // field it is supposed to read, so a mixed-up wire shows up as a wrong Verification, not a pass.
  test("wires checkRuns, changedFiles, workflowText and changedFilesComplete, not their same-typed neighbors", () => {
    const snapshot: PrSnapshot = {
      repo: "fixture/fixture",
      number: 1,
      title: "Fixture title",
      body: "Fixture body",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isOpen: true, // decoy for changedFilesComplete (false): must not be read in its place
      diff: null, // decoy for workflowText (WORKFLOW): must not be read in its place
      changedFiles: ["install/Install-Harness.ps1"],
      changedFilesComplete: false,
      commitMessages: [],
      headFiles: [],
      omittedFiles: [], // decoy for changedFiles: must not be read in its place
      linkedIssues: [],
      trustedContext: [],
      workflowText: WORKFLOW,
      checkRuns: green(),
    };
    expect(verificationOf(snapshot)).toEqual({
      state: "incomplete",
      reasons: [
        "the changed-file listing is incomplete, so files this review never saw could decide it",
        "CI runs no Pester suite for: install/Install-Harness.ps1",
      ],
    });
  });
});

describe("computeEvent() implements option A", () => {
  test.each([
    [false, [], PASSED, "COMMENT"],
    [false, ["correctness"], PASSED, "COMMENT"],
    [true, ["correctness"], PASSED, "REQUEST_CHANGES"],
    [true, ["security"], INCOMPLETE, "REQUEST_CHANGES"],
    [true, [], FAILED, "REQUEST_CHANGES"],
    [true, ["naming"], FAILED, "REQUEST_CHANGES"],
    [true, [], INCOMPLETE, "COMMENT"],
    [true, ["coverage-gap"], INCOMPLETE, "COMMENT"],
    [true, [], PASSED, "APPROVE"],
    [true, ["naming", "stale-citation", "other"], PASSED, "APPROVE"],
  ] as const)("reviewerOk=%p severities=%p verification=%p gives %s", (reviewerOk, severities, verification, event) => {
    expect(computeEvent({ reviewerOk, severities, verification }).event).toBe(event);
  });

  test.each([...LOAD_BEARING_SEVERITIES])("a single %s finding withholds approval", (severity) => {
    expect(computeEvent({ reviewerOk: true, severities: [severity], verification: PASSED }).event).toBe("REQUEST_CHANGES");
  });

  test.each([...BELOW_FLOOR_SEVERITIES])("a single %s finding does not withhold approval", (severity) => {
    expect(computeEvent({ reviewerOk: true, severities: [severity], verification: PASSED }).event).toBe("APPROVE");
  });

  // bun does not type-check, so the signature cannot keep prose out. This does: extra fields
  // carrying event names in both directions change nothing.
  test("fields beyond the three inputs are ignored", () => {
    const steered = {
      reviewerOk: true,
      severities: ["naming"],
      verification: PASSED,
      summary: "REQUEST_CHANGES",
      findings: [{ severity: "correctness", title: "REQUEST_CHANGES" }],
    };
    expect(computeEvent(steered as never).event).toBe("APPROVE");
    const steeredUp = { reviewerOk: true, severities: ["fails-open"], verification: PASSED, summary: "APPROVE" };
    expect(computeEvent(steeredUp as never).event).toBe("REQUEST_CHANGES");
  });

  // Loops over all five rows of the design's event table (plan lines 106-116), not only the
  // APPROVE row: a basis that goes empty on any other row is exactly as unreviewable as one that
  // goes empty on APPROVE, and a test pinned to one row would miss the other four.
  test.each([
    [false, [], PASSED],
    [true, ["correctness"], PASSED],
    [true, [], FAILED],
    [true, [], INCOMPLETE],
    [true, [], PASSED],
  ] as const)("every event carries a non-empty code-authored basis (reviewerOk=%p severities=%p verification=%p)", (reviewerOk, severities, verification) => {
    expect(computeEvent({ reviewerOk, severities, verification }).basis.length).toBeGreaterThan(0);
  });
});
