// review-merge (#274): wait for CI, run the App reviewer from a clean default-branch checkout,
// and merge only on what merge-decision.ts allows. In order:
//
//   1. config names an owner identity for the repository. This tool's own checkout is clean and at
//      its origin's default branch head, the bar the reviewer checkout meets in step 6, because the
//      code that holds the token and makes the merge decision must be reviewed code too
//   2. config names a reviewer for the repository. With --allow-admin, the reason file reads and
//      passes the same text gates as a body. The reviewer checkout holds tools/pr-review/cli.ts
//   3. the pull request is open, not a draft, from this repository, and into the default branch.
//      Its head is pinned here as the head to review
//   4. closing keywords in the title, the body and every commit message equal --closes (early, so
//      a mismatch costs no model run). The title counts because a --merge merge commit carries it
//   5. `gh pr checks --watch`, bounded by --checks-timeout-min. Then every check must have
//      succeeded on the pinned head, which must not have moved
//   6. the reviewer checkout is fetched and detached at the default branch's current head, and
//      must then be clean (tools/pr-review/tool-state.ts) and at exactly that commit
//   7. the reviewer runs from the work directory, outside every checkout, with the key piped from
//      the configured key command, --expect-head pinned, --post and --json
//   8. the pull request is read again (waiting out an UNKNOWN merge state), the closing-keyword
//      audit repeats, and decideMerge rules
//   9. for an administrator-bypass merge, the reason is posted as a pull request comment first
//      (CONTRIBUTING.md has every bypass say why). Then gh pr merge with --match-head-commit, and
//      the merge is confirmed
//
// Every git call names the configured identity and a credential helper that answers with the
// configured account's token from the child environment, never the active gh account.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripControlChars } from "../pr-review/cli";
import type { IdentityLoad } from "../pr-review/identity";
import { ownerIdentity, reviewerConfig, type OwnerIdentity, type PublishConfig, type ReviewerConfig } from "./config";
import { PublishError, PublishRefusal } from "./errors";
import { parseRepo } from "../pr-review/types";
import { childEnv, type RunResult, type Runner } from "./exec";
import { Gh, type PrState } from "./gh";
import { checksSummary, decideMerge, enumText, parseReviewOutput, type ReviewResult } from "./merge-decision";
import { assertClean, loadBody } from "./publish";
import { compareClosing, findClosingRefs } from "./scan";

export const REVIEWER_TIMEOUT_MS = 45 * 60_000;
const MERGE_STATE_POLLS = 12;
const MERGE_STATE_POLL_MS = 10_000;

export interface ReviewMergeArgs {
  repo: string;
  pr: number;
  closes: number[];
  allowAdmin: boolean;
  // Required with allowAdmin (cli.ts enforces it). CONTRIBUTING.md has every administrator
  // bypass say why in the pull request, so this text is posted as a comment before such a merge.
  adminReasonFile: string | null;
  method: "merge" | "rebase";
  checksTimeoutMin: number;
}

export interface ReviewMergeContext {
  runner: Runner;
  config: PublishConfig;
  env: Record<string, string | undefined>;
  workDir: string;
  // The checkout this tool runs from. cli.ts passes the repository root above tools/publish.
  toolRoot: string;
  bunPath: string;
  exists: (path: string) => boolean;
  toolState: (root: string) => { revision: string; dirty: boolean };
  sleep: (ms: number) => void;
  log: (line: string) => void;
  loadIdentity: () => IdentityLoad;
  readBody: (path: string) => string;
}

export const realExists = existsSync;

function assertReviewable(pr: PrState, defaultBranch: string): void {
  if (pr.state !== "OPEN") throw new PublishRefusal("the pull request is not open");
  if (pr.isDraft) throw new PublishRefusal("the pull request is a draft");
  if (pr.isCrossRepository) throw new PublishRefusal("the pull request comes from another repository. Forks are not reviewed");
  if (pr.baseRefName !== defaultBranch) throw new PublishRefusal("the pull request does not target the default branch");
}

function auditClosing(gh: Gh, repo: string, view: PrState, declared: number[]): void {
  const texts = [view.title, view.body, ...gh.prCommitMessages(repo, view.number)];
  const verdict = compareClosing(
    texts.flatMap((text) => findClosingRefs(text, repo)),
    declared,
    repo,
  );
  if (!verdict.ok) throw new PublishRefusal(`not merged: ${verdict.reason} across the title, body and commit messages`);
}

// owner/name of a GitHub remote URL, or null for anything else.
export function remoteRepo(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match !== null && parseRepo(match[1]!) !== null ? match[1]! : null;
}

export function remoteMatches(url: string, repo: string): boolean {
  return remoteRepo(url)?.toLowerCase() === repo.toLowerCase();
}

function git(ctx: ReviewMergeContext, owner: OwnerIdentity, token: string, dir: string, args: string[]): RunResult {
  // ghUser is held to GH_USER_RE by config.ts, so it cannot carry shell syntax into the helper.
  const helper = `!f() { echo username=${owner.ghUser}; echo "password=$PUBLISH_GIT_TOKEN"; }; f`;
  const result = ctx.runner.run(
    [
      "git",
      "-c",
      `user.name=${owner.gitName}`,
      "-c",
      `user.email=${owner.gitEmail}`,
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helper}`,
      "-C",
      dir,
      ...args,
    ],
    { env: childEnv(ctx.env, { PUBLISH_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" }) },
  );
  if (result.spawnError) throw new PublishRefusal("git is not on PATH");
  return result;
}

function prepareReviewerCheckout(ctx: ReviewMergeContext, gh: Gh, owner: OwnerIdentity, reviewer: ReviewerConfig, repo: string, defaultBranch: string): void {
  const dir = reviewer.checkout;
  const origin = git(ctx, owner, gh.token, dir, ["remote", "get-url", "origin"]);
  if (origin.code !== 0 || !remoteMatches(origin.stdout, repo)) {
    throw new PublishRefusal("the reviewer checkout's origin is not this repository");
  }
  if (git(ctx, owner, gh.token, dir, ["fetch", "--quiet", "origin", defaultBranch]).code !== 0) {
    throw new PublishError("git fetch failed in the reviewer checkout");
  }
  const tracked = git(ctx, owner, gh.token, dir, ["rev-parse", `refs/remotes/origin/${defaultBranch}`]);
  const sha = tracked.stdout.trim();
  if (tracked.code !== 0 || sha !== gh.branchHead(repo, defaultBranch)) {
    throw new PublishRefusal("the reviewer checkout could not be brought to the default branch's current head");
  }
  if (git(ctx, owner, gh.token, dir, ["checkout", "--quiet", "--detach", sha]).code !== 0) {
    throw new PublishRefusal("the reviewer checkout could not be switched to the default branch head. It may carry local changes");
  }
  let state: { revision: string; dirty: boolean };
  try {
    state = ctx.toolState(dir);
  } catch {
    throw new PublishRefusal("the reviewer checkout is not a readable git checkout");
  }
  if (state.dirty || state.revision !== sha) throw new PublishRefusal("the reviewer checkout is not a clean copy of the default branch head");
}

// The tool's own checkout is often an operator's working clone, on another branch or carrying
// edits. An edited or stale merge-decision.ts there would decide merges, so that checkout must be
// clean and at its origin's default branch head before anything else runs.
function assertToolCurrent(ctx: ReviewMergeContext, gh: Gh, owner: OwnerIdentity): void {
  let state: { revision: string; dirty: boolean };
  try {
    state = ctx.toolState(ctx.toolRoot);
  } catch {
    throw new PublishRefusal("this tool is not running from a readable git checkout");
  }
  if (state.dirty) {
    throw new PublishRefusal("this tool's own checkout has uncommitted changes. Run review-merge from a clean checkout of the default branch");
  }
  const origin = git(ctx, owner, gh.token, ctx.toolRoot, ["remote", "get-url", "origin"]);
  const toolRepo = origin.code === 0 ? remoteRepo(origin.stdout) : null;
  if (toolRepo === null) throw new PublishRefusal("this tool's own checkout has no GitHub origin");
  if (state.revision !== gh.branchHead(toolRepo, gh.defaultBranch(toolRepo))) {
    throw new PublishRefusal("this tool's own checkout is not at its default branch's current head. Update it and run again");
  }
}

async function runReviewer(ctx: ReviewMergeContext, reviewer: ReviewerConfig, cli: string, repo: string, pr: number, head: string): Promise<ReviewResult> {
  const run = await ctx.runner.runPiped(
    { argv: reviewer.keyCommand, cwd: ctx.workDir, env: childEnv(ctx.env, reviewer.keyCommandEnv) },
    {
      argv: [ctx.bunPath, "--cwd", ctx.workDir, cli, "review", "--pr", String(pr), "--repo", repo, "--key-stdin", "--post", "--json", "--expect-head", head],
      cwd: ctx.workDir,
      env: childEnv(ctx.env, { PR_REVIEW_APP_ID: reviewer.appId }),
      timeoutMs: REVIEWER_TIMEOUT_MS,
    },
  );
  if (run.producerSpawnError) throw new PublishRefusal("the configured key command could not be started");
  if (run.consumer.spawnError) throw new PublishRefusal("bun could not start the reviewer");
  if (run.consumer.timedOut) {
    throw new PublishError("the reviewer did not finish in time. Check the pull request for a posted review before running again");
  }
  if (run.producerCode !== 0) throw new PublishRefusal("the configured key command failed. Nothing was merged");
  if (run.consumer.code === 2) {
    let detail = "";
    try {
      const parsed = JSON.parse(run.consumer.stdout) as { refusal?: unknown };
      if (typeof parsed.refusal === "string") detail = `: ${stripControlChars(parsed.refusal)}`;
    } catch {
      // A refusal raised before the reviewer reads its key prints no JSON. The exit code says enough.
    }
    throw new PublishRefusal(`the reviewer refused${detail}. Nothing was merged`);
  }
  if (run.consumer.code !== 0) {
    throw new PublishError("the reviewer exited with an error. A review may already have been posted, so check the pull request before running again");
  }
  return parseReviewOutput(run.consumer.stdout);
}

function settledView(ctx: ReviewMergeContext, gh: Gh, repo: string, pr: number): PrState {
  let view = gh.prView(repo, pr);
  for (let i = 0; i < MERGE_STATE_POLLS && view.mergeStateStatus === "UNKNOWN"; i++) {
    ctx.sleep(MERGE_STATE_POLL_MS);
    view = gh.prView(repo, pr);
  }
  return view;
}

export async function reviewMerge(ctx: ReviewMergeContext, args: ReviewMergeArgs): Promise<string> {
  const owner = ownerIdentity(ctx.config, args.repo);
  const gh = Gh.forUser(ctx.runner, owner.ghUser, ctx.env);
  assertToolCurrent(ctx, gh, owner);
  // Read and scanned before the pull request is touched, so a reason that would be refused costs
  // no model run.
  let adminReason: string | null = null;
  if (args.allowAdmin) {
    if (args.adminReasonFile === null) throw new PublishRefusal("--allow-admin needs --admin-reason-file");
    adminReason = loadBody(ctx, args.adminReasonFile, "--admin-reason-file");
    assertClean(ctx, [{ label: "admin reason", text: adminReason }]);
    if (findClosingRefs(adminReason, args.repo).length > 0) throw new PublishRefusal("the admin reason carries a closing keyword");
  }
  const reviewer = reviewerConfig(ctx.config, args.repo);
  const cli = join(reviewer.checkout, "tools", "pr-review", "cli.ts");
  if (!ctx.exists(cli)) throw new PublishRefusal("the reviewer checkout holds no tools/pr-review/cli.ts");

  const defaultBranch = gh.defaultBranch(args.repo);
  const first = gh.prView(args.repo, args.pr);
  assertReviewable(first, defaultBranch);
  const head = first.headRefOid;
  auditClosing(gh, args.repo, first, args.closes);

  if (gh.watchChecks(args.repo, args.pr, args.checksTimeoutMin * 60_000) === "timed-out") {
    throw new PublishRefusal(`checks did not finish within ${args.checksTimeoutMin} minutes. Nothing was reviewed or merged`);
  }
  const afterChecks = gh.prView(args.repo, args.pr);
  if (afterChecks.headRefOid !== head) throw new PublishRefusal("the head moved while checks ran. Nothing was reviewed or merged");
  const checks = checksSummary(afterChecks.checks);
  if (!checks.ok) {
    throw new PublishRefusal(
      `not every check succeeded (${checks.total} total, ${checks.failing} not successful, ${checks.pending} pending). Nothing was reviewed or merged`,
    );
  }

  prepareReviewerCheckout(ctx, gh, owner, reviewer, args.repo, defaultBranch);
  const review = await runReviewer(ctx, reviewer, cli, args.repo, args.pr, head);
  ctx.log(`review: status=${enumText(review.status)} event=${enumText(review.event)} findings=${review.severities.length}`);

  const final = settledView(ctx, gh, args.repo, args.pr);
  assertReviewable(final, defaultBranch);
  auditClosing(gh, args.repo, final, args.closes);
  const decision = decideMerge({
    review,
    reviewedHead: head,
    currentHead: final.headRefOid,
    checks: final.checks,
    mergeState: final.mergeStateStatus,
    allowAdmin: args.allowAdmin,
  });
  if (decision.action === "refuse") throw new PublishRefusal(`not merged: ${decision.reason}`);

  if (decision.admin) {
    if (adminReason === null) throw new PublishRefusal("an administrator-bypass merge needs a reason");
    gh.commentPr(args.repo, args.pr, adminReason);
  }
  gh.mergePr(args.repo, args.pr, head, args.method, decision.admin);
  const merged = gh.mergedState(args.repo, args.pr);
  if (merged.state !== "MERGED" || merged.mergeSha === null) {
    throw new PublishError("gh reported no error, but the pull request is not merged. Check it for auto-merge before running again");
  }
  return `merged #${args.pr} at ${merged.mergeSha.slice(0, 7)} (${decision.admin ? "administrator bypass" : "App approval"})`;
}
