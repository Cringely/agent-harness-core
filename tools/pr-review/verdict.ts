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
//
// #318: which checks are required, and which workflow is read at the base commit, come from the
// reviewed repository's own RepoPolicy (repo-policy.ts), never from this repository's.

import {
  LOAD_BEARING_SET,
  SEVERITY_SET,
  type CheckRun,
  type PrSnapshot,
  type RepoPolicy,
  type ReviewEvent,
  type Severity,
  type Verification,
} from "./types";

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out"]);

// Suites on a `run:` line only (#90). Counting a suite named only in a comment would report
// coverage that does not exist. Every suite in this workflow currently sits on a `run:` line, so
// this function only matters the day a suite is added without one. It still reads that one as
// uncovered rather than trusting a comment that names it.
export function ciCoveredPesterSuites(workflowText: string): Set<string> {
  const covered = new Set<string>();
  for (const line of workflowText.split(/\r?\n/)) {
    const match = /^\s*run:\s*pwsh\s+-NoProfile\s+-File\s+(\S+\.Tests\.ps1)\s*$/.exec(line);
    if (match) covered.add(match[1]!);
  }
  return covered;
}

// A shared module with no sibling suite of its own, but dot-sourced by suites that do run in CI.
// The sibling-name guess below has no suite to guess for a file like this, so it read every
// change to it as uncovered even while other suites exercised the change (#152). Declared
// explicitly rather than inferred, since nothing about the module's own name names its suites.
// install/AccountShared.ps1: confirmed at this writing dot-sourced by both listed suites
// (install/Export-Account.Tests.ps1, install/Install-Account.Tests.ps1).
// account/claude/hooks/*.ps1: the four hooks install/Account-Hooks.Tests.ps1 exercises (#207
// put that suite on a run line in CI). Same shape as AccountShared.ps1, one declared suite
// each rather than a directory-prefix rule, since the map already matches this way and a
// prefix match would be a second lookup mechanism for the same one-suite case.
const SHARED_MODULE_SUITES: ReadonlyMap<string, readonly string[]> = new Map([
  ["install/AccountShared.ps1", ["install/Export-Account.Tests.ps1", "install/Install-Account.Tests.ps1"]],
  // #310: both installers dot-source Deps.ps1 (layer dependency preflight), and both suites drive it.
  ["install/Deps.ps1", ["install/Install-Harness.Tests.ps1", "install/Install-Account.Tests.ps1"]],
  ["account/claude/hooks/Guard-SkillSize.ps1", ["install/Account-Hooks.Tests.ps1"]],
  ["account/claude/hooks/Lint-DocumentProse.ps1", ["install/Account-Hooks.Tests.ps1"]],
  ["account/claude/hooks/Scan-MemorySecrets.ps1", ["install/Account-Hooks.Tests.ps1"]],
  ["account/claude/hooks/Sync-MemoryToObsidian.ps1", ["install/Account-Hooks.Tests.ps1"]],
]);

// A changed .ps1 counts as covered when its own sibling suite runs in CI, or, for a module
// declared in SHARED_MODULE_SUITES, when at least one of its declared suites does. Conservative
// on purpose: a comment-only edit to an uncovered file also lands here, which withholds an
// approval rather than granting one CI never earned.
export function uncoveredPowerShellFiles(changedFiles: readonly string[], workflowText: string): string[] {
  const covered = ciCoveredPesterSuites(workflowText);
  return changedFiles.filter((path) => {
    if (!/\.ps1$/i.test(path)) return false;
    const normalized = path.replace(/\.ps1$/i, ".ps1");
    const declared = SHARED_MODULE_SUITES.get(normalized);
    if (declared) return !declared.some((suite) => covered.has(suite));
    // Suite names are compared exact-case (m1): a changed file whose case differs from what
    // .github/workflows/test.yml names must not read as covered because a case-insensitive
    // rewrite happened to collide with the covered spelling. Only the extension itself is matched
    // case-insensitively, since that is the part `/\.ps1$/i` above already treats that way.
    const suite = /\.Tests\.ps1$/.test(path) ? path : path.replace(/\.ps1$/i, ".Tests.ps1");
    return !covered.has(suite);
  });
}

// #318 (critique item 11): a required check counts only when its name appears as a `name:` line in
// the configured workflow at the base commit, using the same whole-line match
// test/pr-review-verdict.test.ts pins CORE_POLICY's names with. This checks for a `name:` line, not
// for a job: any line that reads exactly `name: <check>` once trimmed matches, so the workflow's
// own top-level name, or a step whose `name:` sits on a line after its dash, matches too. Without it, a green run with the right name from some other workflow satisfies a
// check whose own workflow never ran, for example one a path filter skipped. A name the workflow
// builds from an expression, or quotes, does not match, and that reads incomplete.
export function workflowDeclaresName(workflowText: string, name: string): boolean {
  return workflowText.split(/\r?\n/).some((line) => line.trim() === `name: ${name}`);
}

export function computeVerification(input: {
  checkRuns: readonly CheckRun[];
  changedFiles: readonly string[];
  workflowText: string | null;
  changedFilesComplete: boolean;
  policy: RepoPolicy;
}): Verification {
  const failed: string[] = [];
  const incomplete: string[] = [];

  // A policy with no checks, or none at all, can never read passed. repo-policy.ts already refuses
  // an empty list, and this is the second line behind it, for a policy built by hand.
  const requiredChecks = Array.isArray(input.policy?.requiredChecks) ? input.policy.requiredChecks : [];
  if (requiredChecks.length === 0) incomplete.push("no required checks are configured for this repository");

  // Every run sharing a required check's name and app counts (I5), not just the first one the API
  // happens to return: a re-run or a reopened PR can leave more than one run on the same head SHA,
  // and picking one arbitrarily lets a failing run hide behind a passing one, or the reverse.
  for (const required of requiredChecks) {
    if (input.workflowText !== null && !workflowDeclaresName(input.workflowText, required.name)) {
      incomplete.push(`required check "${required.name}" does not appear as a name: line in the CI workflow at the base commit`);
    }
    const runs = input.checkRuns.filter((r) => r.name === required.name && r.appSlug === required.appSlug);
    if (runs.length === 0) {
      incomplete.push(`required check "${required.name}" has no run on the head commit`);
      continue;
    }
    // A completed "cancelled" run is GitHub's record of a duplicate superseded by the same
    // workflow on the same commit (concurrency cancel-in-progress, #148); it carries no signal
    // about the code. It stops counting against the check only once a completed success exists
    // among this check's own runs (name+app already narrowed `runs` above). A head with only a
    // cancelled run, and no success anywhere for that check, still reads incomplete exactly as
    // before. No ordering or timestamp is needed: a real failure among the runs already forces
    // the failed branch ahead of the incomplete branch below, so "a success exists" is enough.
    const anySucceeded = runs.some((run) => run.status === "completed" && run.conclusion === "success");
    let anyFailed = false;
    let anyIncomplete = false;
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion === "success") continue;
      if (run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) {
        anyFailed = true;
      } else if (run.status === "completed" && run.conclusion === "cancelled" && anySucceeded) {
        continue;
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

  // .github/actions/ too (#318): a local composite action is pulled from the pull request's own head
  // by `uses: ./...`. Not all of .github/, so a CODEOWNERS edit stays approvable.
  const workflowEdits = input.changedFiles.filter((path) => path.startsWith(".github/workflows/") || path.startsWith(".github/actions/"));
  if (workflowEdits.length > 0) {
    incomplete.push(`the pull request edits CI definitions, so its own checks cannot vouch for it: ${workflowEdits.join(", ")}`);
  }

  // The secret scan reads .gitleaks.toml and .gitleaksignore from the base commit, but a change to
  // either still alters what the next scan allows. The scan cannot vouch for a pull request that
  // rewrites its own rules. A .gitattributes at any depth counts too: a "-diff" or "binary" marking
  // makes every later scan print "Binary files differ" and read nothing.
  const scannerEdits = input.changedFiles.filter(
    (path) => path === ".gitleaks.toml" || path === ".gitleaksignore" || path.split("/").pop() === ".gitattributes",
  );
  if (scannerEdits.length > 0) {
    incomplete.push(`the pull request edits the secret scan configuration, so its own scan cannot vouch for it: ${scannerEdits.join(", ")}`);
  }

  if (input.workflowText === null) {
    incomplete.push(`${input.policy?.ciWorkflowPath ?? "the CI workflow"} is absent at the base commit`);
  } else if (input.policy?.pesterCoverage !== false) {
    // Skipped only on a literal false (critique item 1): running this check is the branch that
    // withholds approval, so a missing or non-boolean value must keep it, the reverse of I4's
    // strict-true reads above. Only CORE_POLICY runs it: SHARED_MODULE_SUITES and the sibling
    // .Tests.ps1 convention describe this repository, not any other.
    const uncovered = uncoveredPowerShellFiles(input.changedFiles, input.workflowText);
    if (uncovered.length > 0) incomplete.push(`CI runs no Pester suite for: ${uncovered.join(", ")}`);
  }

  if (failed.length > 0) return { state: "failed", reasons: [...failed, ...incomplete] };
  if (incomplete.length > 0) return { state: "incomplete", reasons: incomplete };
  return { state: "passed", reasons: [] };
}

// Tasks 8 and 11 both build a PrSnapshot and need its verification; this is the one place that
// draws the four computeVerification fields out of it, so the two call sites cannot drift the way
// the plan's own duplicates (named in types.ts) already had not. The policy comes from the caller,
// never from the snapshot, which a PrSource fills in.
export function verificationOf(snapshot: PrSnapshot, policy: RepoPolicy): Verification {
  return computeVerification({
    checkRuns: snapshot.checkRuns,
    changedFiles: snapshot.changedFiles,
    workflowText: snapshot.workflowText,
    changedFilesComplete: snapshot.changedFilesComplete,
    policy,
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
