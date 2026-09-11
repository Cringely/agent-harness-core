// The only producer of a review event. computeEvent reads three things: whether the reviewer's
// output validated, the severities of its findings, and the verification state. It never reads
// a summary, title or detail, which is what keeps any sentence inside a pull request from
// becoming the verdict (#120). test/pr-review-verdict.test.ts pins that at runtime, since bun
// does not type-check and the signature alone enforces nothing.
//
// computeVerification stands in for "the reviewer actually executed the project's verification"
// in #120's ruling. The reviewing model has no tools and cannot run anything, and running the pull
// request's tests locally would execute its code as the operator while the App key is readable. So
// verification is what CI reported for the exact head commit, discounted wherever CI cannot vouch.

import {
  LOAD_BEARING_SET,
  SEVERITY_SET,
  WORKFLOW_PATH,
  type CheckRun,
  type PrSnapshot,
  type ReviewEvent,
  type Severity,
  type Verification,
} from "./types";

// Keyed on name and app together, matching the jobs in .github/workflows/test.yml. A run with the
// right name from any other app does not count.
export const REQUIRED_CHECKS: ReadonlyArray<{ name: string; appSlug: string }> = [
  { name: "bun test (TypeScript hook suite)", appSlug: "github-actions" },
  { name: "Pester (fixture-built installer suites)", appSlug: "github-actions" },
];

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out"]);

// Suites on a `run:` line only. test.yml names two more suites in comments precisely because CI
// does not run them (#90); counting those would report coverage that does not exist.
export function ciCoveredPesterSuites(workflowText: string): Set<string> {
  const covered = new Set<string>();
  for (const line of workflowText.split(/\r?\n/)) {
    const match = /^\s*run:\s*pwsh\s+-NoProfile\s+-File\s+(\S+\.Tests\.ps1)\s*$/.exec(line);
    if (match) covered.add(match[1]!);
  }
  return covered;
}

// A changed .ps1 counts as covered only when its own sibling suite runs in CI. Conservative on
// purpose: a comment-only edit to an uncovered file also lands here, which withholds an approval
// rather than granting one CI never earned.
export function uncoveredPowerShellFiles(changedFiles: readonly string[], workflowText: string): string[] {
  const covered = ciCoveredPesterSuites(workflowText);
  return changedFiles.filter((path) => {
    if (!/\.ps1$/i.test(path)) return false;
    // Suite names are compared exact-case (m1): a changed file whose case differs from what
    // .github/workflows/test.yml names must not read as covered because a case-insensitive
    // rewrite happened to collide with the covered spelling. Only the extension itself is matched
    // case-insensitively, since that is the part `/\.ps1$/i` above already treats that way.
    const suite = /\.Tests\.ps1$/.test(path) ? path : path.replace(/\.ps1$/i, ".Tests.ps1");
    return !covered.has(suite);
  });
}

export function computeVerification(input: {
  checkRuns: readonly CheckRun[];
  changedFiles: readonly string[];
  workflowText: string | null;
  changedFilesComplete: boolean;
}): Verification {
  const failed: string[] = [];
  const incomplete: string[] = [];

  // Every run sharing a required check's name and app counts (I5), not just the first one the API
  // happens to return: a re-run or a reopened PR can leave more than one run on the same head SHA,
  // and picking one arbitrarily lets a failing run hide behind a passing one, or the reverse.
  for (const required of REQUIRED_CHECKS) {
    const runs = input.checkRuns.filter((r) => r.name === required.name && r.appSlug === required.appSlug);
    if (runs.length === 0) {
      incomplete.push(`required check "${required.name}" has no run on the head commit`);
      continue;
    }
    let anyFailed = false;
    let anyIncomplete = false;
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion === "success") continue;
      if (run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) {
        anyFailed = true;
      } else {
        anyIncomplete = true;
      }
    }
    if (anyFailed) {
      failed.push(`required check "${required.name}" concluded a failing result on at least one of its runs`);
    } else if (anyIncomplete) {
      incomplete.push(`required check "${required.name}" has a run that is not a completed success`);
    }
  }

  // Strict on purpose (I4): a non-boolean here (undefined, a stray string) must read as incomplete
  // rather than being coerced by truthiness, the same way computeEvent's reviewerOk check is strict.
  if (input.changedFilesComplete !== true) {
    incomplete.push("the changed-file listing is incomplete, so files this review never saw could decide it");
  }

  const workflowEdits = input.changedFiles.filter((path) => path.startsWith(".github/workflows/"));
  if (workflowEdits.length > 0) {
    incomplete.push(`the pull request edits CI definitions, so its own checks cannot vouch for it: ${workflowEdits.join(", ")}`);
  }

  if (input.workflowText === null) {
    incomplete.push(`${WORKFLOW_PATH} is absent at the base commit`);
  } else {
    const uncovered = uncoveredPowerShellFiles(input.changedFiles, input.workflowText);
    if (uncovered.length > 0) incomplete.push(`CI runs no Pester suite for: ${uncovered.join(", ")}`);
  }

  if (failed.length > 0) return { state: "failed", reasons: [...failed, ...incomplete] };
  if (incomplete.length > 0) return { state: "incomplete", reasons: incomplete };
  return { state: "passed", reasons: [] };
}

// Tasks 8 and 11 both build a PrSnapshot and need its verification; this is the one place that
// draws the four computeVerification fields out of it, so the two call sites cannot drift the way
// the plan's own duplicates (named in types.ts) already had not.
export function verificationOf(snapshot: PrSnapshot): Verification {
  return computeVerification({
    checkRuns: snapshot.checkRuns,
    changedFiles: snapshot.changedFiles,
    workflowText: snapshot.workflowText,
    changedFilesComplete: snapshot.changedFilesComplete,
  });
}

export function computeEvent(input: {
  reviewerOk: boolean;
  severities: readonly Severity[];
  verification: Verification;
}): { event: ReviewEvent; basis: string } {
  // Strict on reviewerOk (I4), and a severity outside the closed set (I2) lands on the same row as
  // invalid reviewer output (D4's first row), sharing its event and basis rather than a new basis
  // string built from a value the model supplied.
  const knownSeverities = input.severities.every((severity) => SEVERITY_SET.has(severity));
  if (input.reviewerOk !== true || !knownSeverities) {
    return { event: "COMMENT", basis: "the reviewer produced no valid findings, so this change was not reviewed" };
  }
  const loadBearing = input.severities.filter((severity) => LOAD_BEARING_SET.has(severity)).length;
  if (loadBearing > 0) {
    return { event: "REQUEST_CHANGES", basis: `${loadBearing} finding(s) at or above the severity floor` };
  }
  if (input.verification.state === "failed") {
    return { event: "REQUEST_CHANGES", basis: "the project's verification failed on the head commit" };
  }
  // D4's only APPROVE row requires the literal state "passed" (I3): anything else, including a
  // future state this file does not know about, is COMMENT rather than a fall-through APPROVE.
  if (input.verification.state !== "passed") {
    return { event: "COMMENT", basis: "the project's verification could not be confirmed on the head commit" };
  }
  return {
    event: "APPROVE",
    basis: "no finding at or above the severity floor, and the project's verification passed on the head commit",
  };
}
