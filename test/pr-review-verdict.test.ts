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

// Gives the required check at `index` one run per entry in `patches`, each defaulting to a
// completed success unless the patch overrides it, while every other required check stays a
// single green run. Used to test that a check with more than one run on the head commit is
// judged on all of them, not on whichever run the API happens to return first (I5).
const manyRuns = (index: number, patches: ReadonlyArray<Partial<CheckRun>>): CheckRun[] => {
  const check = REQUIRED_CHECKS[index]!;
  const others = green().filter((_, i) => i !== index);
  const duplicates = patches.map((patch) => ({ name: check.name, appSlug: check.appSlug, status: "completed", conclusion: "success", ...patch }));
  return [...others, ...duplicates];
};

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
    // Lowercase "tests": a case-insensitive rewrite would collide with the real, differently-cased
    // covered suite name and read this as covered. It is not the suite CI actually runs (m1).
    "install/Restore-ClaudeProject.tests.ps1",
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

  // Strict on purpose (I4): a non-boolean must not be read for its truthiness. "true" is a
  // non-empty string, and a truthiness read would treat it as a complete listing.
  test("a non-boolean changedFilesComplete is incomplete", () => {
    const result = verify(green(), ["README.md"], WORKFLOW, "true" as unknown as boolean);
    expect(result.state).toBe("incomplete");
  });

  describe("a required check with more than one run on the head commit (I5)", () => {
    test.each([
      ["success", "failure"],
      ["failure", "success"],
    ] as const)("conclusions [%s, %s]: failed regardless of order", (first, second) => {
      const result = verify(manyRuns(0, [{ conclusion: first }, { conclusion: second }]));
      expect(result.state).toBe("failed");
    });

    test("conclusions [success, in_progress]: incomplete", () => {
      const result = verify(manyRuns(0, [{ conclusion: "success" }, { status: "in_progress", conclusion: null }]));
      expect(result.state).toBe("incomplete");
    });
  });
});

describe("verificationOf() reads exactly the four fields from a PrSnapshot", () => {
  // body, title and headSha are decoys for workflowText: none of the three contains a `run:` line,
  // so reading any of them instead changes which files count as uncovered. diff is a decoy for
  // workflowText too, for the same reason. isOpen is a decoy for changedFilesComplete (both
  // boolean) and omittedFiles a decoy for changedFiles (both string[]); commitMessages is a decoy
  // for checkRuns, of the wrong element type entirely. bun does not type-check (global-
  // constraints.md), so nothing but this test stops verificationOf from reading any of them.
  //
  // Two changed files, one WORKFLOW covers and one it does not, so the ps1-coverage reason is
  // present in both variants and a miswired workflowText/changedFiles still changes it. The two
  // variants invert changedFilesComplete against isOpen, so a miswire that reads one for the other
  // (or ignores changedFilesComplete entirely) changes which variant's expected result comes back.
  const buildSnapshot = (changedFilesComplete: boolean, isOpen: boolean): PrSnapshot => ({
    repo: "fixture/fixture",
    number: 1,
    title: "Fixture title, no run lines here",
    body: "Fixture body, no run lines here",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    isOpen,
    diff: "Fixture diff text, no run lines here",
    changedFiles: ["install/Install-Harness.ps1", "install/Restore-ClaudeProject.ps1"],
    changedFilesComplete,
    commitMessages: ["Fixture commit message"],
    headFiles: [],
    omittedFiles: [],
    linkedIssues: [],
    trustedContext: [],
    workflowText: WORKFLOW,
    checkRuns: green(),
  });

  test("changedFilesComplete true, isOpen false", () => {
    expect(verificationOf(buildSnapshot(true, false))).toEqual({
      state: "incomplete",
      reasons: ["CI runs no Pester suite for: install/Install-Harness.ps1"],
    });
  });

  test("changedFilesComplete false, isOpen true", () => {
    expect(verificationOf(buildSnapshot(false, true))).toEqual({
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
    // I2: a severity outside SEVERITY_SET lands on the same row as invalid reviewer output.
    [true, ["CORRECTNESS"], PASSED, "COMMENT"],
    [true, ["critical"], PASSED, "COMMENT"],
    // I3: APPROVE requires the literal state "passed". Any other state, known or not, is COMMENT.
    [true, [], { state: "pending", reasons: [] } as unknown as Verification, "COMMENT"],
    [true, [], {} as unknown as Verification, "COMMENT"],
  ] as const)("reviewerOk=%p severities=%p verification=%p gives %s", (reviewerOk, severities, verification, event) => {
    expect(computeEvent({ reviewerOk, severities, verification }).event).toBe(event);
  });

  // I4: reviewerOk is read for exact equality with `true`, not for truthiness.
  test("a non-boolean reviewerOk does not approve", () => {
    expect(computeEvent({ reviewerOk: "false" as unknown as boolean, severities: [], verification: PASSED }).event).toBe("COMMENT");
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
