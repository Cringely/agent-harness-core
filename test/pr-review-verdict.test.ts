// Tests for tools/pr-review/verdict.ts. computeVerification decides whether CI actually vouches
// for the head commit; computeEvent turns that and the finding severities into the posted event.
// #120's option-A ruling is the spec for both.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_POLICY } from "../tools/pr-review/repo-policy";
import {
  ciCoveredPesterSuites,
  computeEvent,
  computeVerification,
  verificationOf,
  workflowDeclaresName,
} from "../tools/pr-review/verdict";
import {
  BELOW_FLOOR_SEVERITIES,
  LOAD_BEARING_SEVERITIES,
  type CheckRun,
  type PrSnapshot,
  type RepoPolicy,
  type RequiredCheck,
  type Verification,
} from "../tools/pr-review/types";

const REQUIRED_CHECKS = CORE_POLICY.requiredChecks;
const REPO_ROOT = join(import.meta.dir, "..");
// Built from the policy's own path (critique item 13), so moving CORE_POLICY to another workflow
// moves the job-name pin with it.
const REAL_WORKFLOW = readFileSync(join(REPO_ROOT, ...CORE_POLICY.ciWorkflowPath.split("/")), "utf8");

const greenFor = (checks: readonly RequiredCheck[]): CheckRun[] =>
  checks.map((c) => ({ name: c.name, appSlug: c.appSlug, status: "completed", conclusion: "success" }));
const green = (): CheckRun[] => greenFor(REQUIRED_CHECKS);

// #318: verification reads a required check only when the base-commit workflow declares it as a
// job name, so every synthetic workflow below carries the core names.
const jobNameLines = (checks: readonly RequiredCheck[]) => checks.map((c, i) => [`  job-${i}:`, `    name: ${c.name}`]).flat();

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
  ...jobNameLines(REQUIRED_CHECKS),
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
  policy: RepoPolicy = CORE_POLICY,
) => computeVerification({ checkRuns, changedFiles, workflowText, changedFilesComplete, policy });

const PASSED: Verification = { state: "passed", reasons: [] };
const FAILED: Verification = { state: "failed", reasons: ["x"] };
const INCOMPLETE: Verification = { state: "incomplete", reasons: ["x"] };

describe("CORE_POLICY's required checks are tied to the workflow they measure", () => {
  // Pinned on the real file rather than restated: renaming a job in test.yml without updating
  // CORE_POLICY turns every future review into COMMENT, and this test names the cause. The second
  // assertion is the same matcher verification itself applies at the base commit (#318).
  test.each(REQUIRED_CHECKS.map((c) => c.name))("the workflow declares a job named %p", (name) => {
    const lines = REAL_WORKFLOW.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain(`name: ${name}`);
    expect(workflowDeclaresName(REAL_WORKFLOW, name)).toBe(true);
  });

  test("CORE_POLICY verifies against its real workflow as passed when every check is green", () => {
    expect(verify(green(), ["README.md"], REAL_WORKFLOW).state).toBe("passed");
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

  // #251: the secret scan gates the verdict like the two suites do. Index looked up by name so the
  // test does not depend on list order.
  const SCAN = REQUIRED_CHECKS.findIndex((c) => c.name === "secret scan (Gitleaks)");

  test("the secret scan is a required check", () => {
    expect(SCAN).toBeGreaterThan(-1);
  });

  // #152: the Linux Pester job gates the verdict too.
  const LINUX = REQUIRED_CHECKS.findIndex((c) => c.name === "Pester (fixture-built installer suites, Linux)");

  test("the Linux Pester job is a required check, and a missing run of it is incomplete", () => {
    expect(LINUX).toBeGreaterThan(-1);
    const runs = green().filter((_, i) => i !== LINUX);
    expect(verify(runs).state).toBe("incomplete");
  });

  test("a failing secret scan: failed", () => {
    const result = verify(withRun(SCAN, { conclusion: "failure" }));
    expect(result.state).toBe("failed");
    expect(result.reasons.join(" | ")).toContain("secret scan (Gitleaks)");
  });

  test("a secret scan that never ran: incomplete", () => {
    expect(verify(green().filter((_, i) => i !== SCAN)).state).toBe("incomplete");
  });

  test("a pull request that edits the scanner config: incomplete even when every check is green", () => {
    const result = verify(green(), [".gitleaks.toml"]);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join(" | ")).toContain(".gitleaks.toml");
  });

  test("a pull request that edits the scanner ignore file: incomplete even when every check is green", () => {
    const result = verify(green(), [".gitleaksignore"]);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join(" | ")).toContain(".gitleaksignore");
  });

  test.each(["install/Restore-ClaudeProject.ps1","install/Restore-ClaudeProject.Tests.ps1"])(
    "%s has its suite on a run line: passed",
    (path) => {
      expect(verify(green(), [path]).state).toBe("passed");
    },
  );

  test.each([
    "install/Install-Harness.ps1",
    "install/Install-Harness.Tests.ps1",
    // Neither of its declared suites (Export-Account.Tests.ps1, Install-Account.Tests.ps1) is on
    // a run line in the synthetic WORKFLOW fixture above, so the declared-mapping lookup finds no
    // covered entry and this stays incomplete under this fixture even after #152's fix.
    "install/AccountShared.ps1",
    // Its declared suite (Account-Hooks.Tests.ps1) is on a run line in the real workflow, not
    // the synthetic WORKFLOW fixture above, so this stays incomplete under this fixture even
    // after #209's fix. The real-workflow case is covered separately below.
    "account/claude/hooks/Scan-MemorySecrets.PS1",
    // Lowercase "tests": a case-insensitive rewrite would collide with the real, differently-cased
    // covered suite name and read this as covered. It is not the suite CI actually runs (m1).
    "install/Restore-ClaudeProject.tests.ps1",
  ])("%s has no suite on a run line: incomplete, naming the file", (path) => {
    const result = verify(green(), [path]);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain(path);
  });

  // #152: install/AccountShared.ps1 has no sibling suite, but Export-Account.Tests.ps1 and
  // Install-Account.Tests.ps1 both dot-source it and both run on a line in the real workflow, so
  // the declared mapping in SHARED_MODULE_SUITES must read the module as covered.
  test("install/AccountShared.ps1 is covered by its declared suites on the real workflow", () => {
    expect(verify(green(), ["install/AccountShared.ps1"], REAL_WORKFLOW).state).toBe("passed");
  });

  // Either declared suite is enough on its own (ANY, not ALL): a workflow naming only one of the
  // two still exercises the module through that one suite.
  test("install/AccountShared.ps1 is covered when only one of its two declared suites runs", () => {
    const onlyExport = [
      "jobs:",
      ...jobNameLines(REQUIRED_CHECKS),
      "  pester-test:",
      "    steps:",
      "      - name: Export-Account.Tests.ps1",
      "        run: pwsh -NoProfile -File install/Export-Account.Tests.ps1",
    ].join("\r\n");
    expect(verify(green(), ["install/AccountShared.ps1"], onlyExport).state).toBe("passed");
  });

  // #310: install/Deps.ps1 has no sibling suite. Both installer suites drive it and both run in
  // the real workflow. A workflow naming neither stays incomplete.
  test("install/Deps.ps1 is covered by its declared suites on the real workflow", () => {
    expect(verify(green(), ["install/Deps.ps1"], REAL_WORKFLOW).state).toBe("passed");
  });
  test("install/Deps.ps1 is incomplete when neither declared suite runs", () => {
    expect(verify(green(), ["install/Deps.ps1"]).state).toBe("incomplete");
  });

  // #209: account/claude/hooks/*.ps1 has no sibling suite, but install/Account-Hooks.Tests.ps1
  // exercises it and runs on a line in the real workflow (#207), so the declared mapping in
  // SHARED_MODULE_SUITES must read the file as covered. Case-insensitive on the extension only
  // (m1, same as the incomplete case above): "PS1" still resolves to the declared entry.
  test("account/claude/hooks/Scan-MemorySecrets.PS1 is covered by its declared suite on the real workflow", () => {
    expect(verify(green(), ["account/claude/hooks/Scan-MemorySecrets.PS1"], REAL_WORKFLOW).state).toBe("passed");
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

  // #148: a concurrency cancel-in-progress leaves a "cancelled" sibling on the same head as a
  // completed success. That run carries no signal about the code, so it must not keep the check
  // permanently incomplete once a completed success exists for the same check name + app.
  describe("a cancelled run alongside a completed success for the same check (#148)", () => {
    test.each([
      ["success", "cancelled"],
      ["cancelled", "success"],
    ] as const)("conclusions [%s, %s]: passed, order does not matter", (first, second) => {
      const result = verify(manyRuns(0, [{ conclusion: first }, { conclusion: second }]));
      expect(result.state).toBe("passed");
    });

    // No success anywhere among that check's runs: the existing "cancelled: incomplete" case
    // above (via withRun) already pins the single-run form of this; here two runs, still no
    // success, still incomplete.
    test("conclusions [cancelled, cancelled]: incomplete, no success to exempt it against", () => {
      const result = verify(manyRuns(0, [{ conclusion: "cancelled" }, { conclusion: "cancelled" }]));
      expect(result.state).toBe("incomplete");
    });

    // A real failure elsewhere in the same run set must not be hidden by the cancelled exemption.
    test("conclusions [failure, cancelled] alongside a success: failed, not passed", () => {
      const result = verify(manyRuns(0, [{ conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "success" }]));
      expect(result.state).toBe("failed");
    });
  });

  // #168: the #148 exemption above is narrow on purpose, keyed on the literal conclusion
  // "cancelled". A different non-success terminal conclusion sitting beside a completed success
  // for the same check must still read incomplete (or failed, for a FAILED_CONCLUSIONS member)
  // exactly as it did before #159 introduced the exemption. The single-run test.each at line 100
  // never reaches the exemption branch, since it only triggers once a completed success exists for
  // the same check, and none of those single-run cases have one.
  describe("a non-cancelled terminal conclusion alongside a completed success is not exempted (#168)", () => {
    test.each(["skipped", "neutral", "action_required", "stale"])(
      "conclusions [%s, success]: still incomplete, not exempted like cancelled",
      (conclusion) => {
        const result = verify(manyRuns(0, [{ conclusion }, { conclusion: "success" }]));
        expect(result.state).toBe("incomplete");
      },
    );

    // timed_out is a FAILED_CONCLUSIONS member (line 30), so beside a success it must still read
    // failed, the same way [failure, success] does above, rather than being pulled toward the
    // cancelled exemption's "passed" outcome.
    test("conclusions [timed_out, success]: still failed, not exempted like cancelled", () => {
      const result = verify(manyRuns(0, [{ conclusion: "timed_out" }, { conclusion: "success" }]));
      expect(result.state).toBe("failed");
    });
  });

  // #168 (second comment): the exemption's own `run.status === "completed"` guard is unpinned.
  // It gates the candidate run being considered for exemption, the one carrying conclusion
  // "cancelled", not the success run beside it (the success run's completeness is already a
  // separate condition inside anySucceeded above). Without the guard, a run reported with status
  // "in_progress" and conclusion "cancelled" would still match `conclusion === "cancelled" &&
  // anySucceeded` and get exempted, reading passed while that run has not actually completed.
  // GitHub does not emit status "in_progress" with a non-null conclusion today, which is why this
  // sits below the severity floor rather than at it, but the guard exists and nothing pins it.
  test("a run with status in_progress and conclusion cancelled beside a success: still incomplete, the exemption needs status completed", () => {
    const result = verify(manyRuns(0, [{ status: "in_progress", conclusion: "cancelled" }, { conclusion: "success" }]));
    expect(result.state).toBe("incomplete");
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
    expect(verificationOf(buildSnapshot(true, false), CORE_POLICY)).toEqual({
      state: "incomplete",
      reasons: ["CI runs no Pester suite for: install/Install-Harness.ps1"],
    });
  });

  test("changedFilesComplete false, isOpen true", () => {
    expect(verificationOf(buildSnapshot(false, true), CORE_POLICY)).toEqual({
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

describe("a .gitattributes edit can blank the scan's diff, so the scan cannot vouch for it", () => {
  test.each([".gitattributes", "docs/.gitattributes", "a/b/c/.gitattributes"])("%s: incomplete even when every check is green", (path) => {
    const result = verify(green(), [path]);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join(" | ")).toContain(path);
  });

  test("a file that merely ends in the name is not a scanner edit", () => {
    expect(verify(green(), ["docs/not.gitattributes.md", "x.gitattributes"]).state).toBe("passed");
  });
});

// #318: verification reads the reviewed repository's own policy, never this repository's.
describe("computeVerification() under a repository's own policy (#318)", () => {
  const FOREIGN: RepoPolicy = {
    repo: "owner/example",
    ciWorkflowPath: ".github/workflows/ci.yml",
    requiredChecks: [{ name: "ci", appSlug: "github-actions" }],
    pesterCoverage: false,
  };
  const FOREIGN_WORKFLOW = ["name: ci", "on: pull_request", "jobs:", "  ci:", "    name: ci", "    runs-on: ubuntu-latest"].join("\n");

  test("a foreign repository's own check, green: passed", () => {
    expect(verify(greenFor(FOREIGN.requiredChecks), ["src/a.ts"], FOREIGN_WORKFLOW, true, FOREIGN)).toEqual({ state: "passed", reasons: [] });
  });

  test("this repository's four green runs without the foreign check: incomplete, naming the foreign check", () => {
    const result = verify(green(), ["src/a.ts"], FOREIGN_WORKFLOW, true, FOREIGN);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain('"ci"');
  });

  test("a foreign repository with pesterCoverage false: a changed .ps1 with no suite still passes", () => {
    const result = verify(greenFor(FOREIGN.requiredChecks), ["scripts/tool.ps1"], FOREIGN_WORKFLOW, true, FOREIGN);
    expect(result).toEqual({ state: "passed", reasons: [] });
  });

  test("the same .ps1 under CORE_POLICY stays incomplete", () => {
    expect(verify(green(), ["scripts/tool.ps1"]).state).toBe("incomplete");
  });

  // Critique item 1: running the Pester check is the withholding branch, so only a literal false
  // may skip it. A hand-built policy missing the field keeps the check.
  test.each([
    ["missing", undefined],
    ["a string", "false"],
    ["null", null],
  ])("a policy whose pesterCoverage is %s still reports the uncovered .ps1", (_label, value) => {
    const policy = { ...FOREIGN, pesterCoverage: value } as unknown as RepoPolicy;
    if (value === undefined) delete (policy as unknown as Record<string, unknown>).pesterCoverage;
    const result = verify(greenFor(FOREIGN.requiredChecks), ["scripts/tool.ps1"], FOREIGN_WORKFLOW, true, policy);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain("scripts/tool.ps1");
  });

  test("no workflow at the base commit: the reason names the policy's own workflow path", () => {
    const result = verify(greenFor(FOREIGN.requiredChecks), ["src/a.ts"], null, true, FOREIGN);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain(".github/workflows/ci.yml is absent at the base commit");
  });

  test("an empty requiredChecks list is incomplete, never passed", () => {
    const empty = { ...FOREIGN, requiredChecks: [] };
    const result = verify([], ["src/a.ts"], FOREIGN_WORKFLOW, true, empty);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain("no required checks are configured");
  });

  test("a missing policy is incomplete, never passed", () => {
    const result = computeVerification({
      checkRuns: green(),
      changedFiles: ["src/a.ts"],
      workflowText: WORKFLOW,
      changedFilesComplete: true,
    } as unknown as Parameters<typeof computeVerification>[0]);
    expect(result.state).toBe("incomplete");
  });

  // Critique item 11: a green run with the right name from some other workflow, while the
  // configured workflow never declares that job, does not vouch for anything.
  test("a green required check that the base-commit workflow does not declare as a job name: incomplete", () => {
    const other = ["jobs:", "  ci:", "    name: something else"].join("\n");
    const result = verify(greenFor(FOREIGN.requiredChecks), ["src/a.ts"], other, true, FOREIGN);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain('required check "ci" is not declared');
  });

  test("a step named like the check does not count as the job name", () => {
    const stepOnly = ["jobs:", "  build:", "    steps:", "      - name: ci"].join("\n");
    expect(verify(greenFor(FOREIGN.requiredChecks), ["src/a.ts"], stepOnly, true, FOREIGN).state).toBe("incomplete");
  });

  test("under CORE_POLICY, a workflow missing one core job name: incomplete, naming it", () => {
    const missing = WORKFLOW.split("\r\n").filter((line) => line.trim() !== `name: ${REQUIRED_CHECKS[3]!.name}`).join("\r\n");
    const result = verify(green(), ["README.md"], missing);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain(REQUIRED_CHECKS[3]!.name);
  });

  test("verificationOf() passes the policy through", () => {
    const snap = {
      repo: "owner/example",
      number: 1,
      title: "",
      body: "",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isOpen: true,
      diff: "",
      changedFiles: ["scripts/tool.ps1"],
      changedFilesComplete: true,
      commitMessages: [],
      headFiles: [],
      omittedFiles: [],
      linkedIssues: [],
      trustedContext: [],
      livingDocs: [],
      workflowText: FOREIGN_WORKFLOW,
      checkRuns: greenFor(FOREIGN.requiredChecks),
    } satisfies PrSnapshot;
    expect(verificationOf(snap, FOREIGN)).toEqual({ state: "passed", reasons: [] });
    expect(verificationOf(snap, CORE_POLICY).state).toBe("incomplete");
  });
});

// Critique item 3: a local composite action under .github/actions/ is pulled from the pull
// request's own head by `uses: ./...`, so an edit there rewrites the CI that vouches for it.
describe("an edit under .github/actions/ is a CI-definition edit (#318)", () => {
  test.each([".github/actions/setup/action.yml", ".github/actions/x.sh"])("%s: incomplete even when every check is green", (path) => {
    const result = verify(green(), [path]);
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toContain(path);
  });

  test("a CODEOWNERS edit stays approvable", () => {
    expect(verify(green(), [".github/CODEOWNERS"]).state).toBe("passed");
  });
});
