// review-merge (#274): wait for CI, run the App reviewer from a clean checkout of this tool's own
// repository at an explicit pin, and merge only on what merge-decision.ts allows. In order:
//
//   1. config names an owner identity for the repository. This tool's own checkout is clean, cloned
//      from the repository this tool comes from (cli.ts passes CORE_POLICY.repo), at --tool-head, and
//      --tool-head is that repository's default branch head, because the code that holds the token
//      and makes the merge decision must be reviewed code. A fork's default branch head is not
//      reviewed code, so any other origin refuses
//   2. config names a reviewer for the repository, with a policy file for any repository but the
//      reviewer's built-in one (tools/pr-review refuses those without --policy). With
//      --allow-admin, the reason file reads and passes the same text gates as a body. The reviewer
//      checkout holds tools/pr-review/cli.ts
//   3. the pull request is open, not a draft, from this repository, and into the default branch.
//      Its head is pinned here as the head to review
//   4. closing keywords in the title, the body and every commit message equal --closes (early, so
//      a mismatch costs no model run). The title counts because a --merge merge commit carries it.
//      For --merge, the title and body also pass the identity scan a published body passes,
//      because the merge commit carries both onto the default branch
//   5. `gh pr checks --watch`, bounded by --checks-timeout-min. Then every check must have
//      succeeded on the pinned head, which must not have moved
//   6. the reviewer checkout must be cloned from the repository this tool comes from, never from the
//      repository under review, and be clean (tools/pr-review/tool-state.ts) and at exactly
//      --tool-head. It is never fetched or moved here. The reviewer gets the App key and premerge the
//      owner's token, so a checkout of the reviewed repository would hand both to whatever anyone who
//      can write to that repository's default branch put there
//   7. the reviewer runs from the work directory, outside every checkout, with the key piped from
//      the configured key command, --expect-head pinned, --post, --json and, for any repository
//      but the reviewer's built-in one, --policy
//   8. the pull request is read again (waiting out an UNKNOWN merge state), the closing-keyword
//      audit repeats, and decideMerge rules. With --allow-admin, what the bypass needs is read
//      first: .github/CODEOWNERS at the default branch head (the base, never the pull request's
//      head), the whole changed-file list, the pull request's reviews, the default branch's
//      active rules and classic protection, and the head's check runs with their apps. A read that fails or
//      comes back incomplete is handed to decideMerge as unreadable, which refuses the bypass
//   9. premerge (tools/pr-review/premerge.ts) runs from the reviewer checkout on the pinned head,
//      with --closes, the configured term list and the owner identity, and must print its OK line
//      for this pull request and head. It checks what the diff does not carry: closing references
//      GitHub links outside the text (an issue linked from the sidebar still closes on merge),
//      every commit's author and committer, and personal terms in commit messages, title and body.
//      CONTRIBUTING.md requires it for a bypass merge, and it runs before every merge here
//  10. for an administrator-bypass merge, the reason is posted as a pull request comment first
//      (CONTRIBUTING.md has every bypass say why)
//  11. the title and body are read once more and must equal the ones step 8 audited, or nothing is
//      merged. For --merge, the subject and body built from that audited text pass the identity scan
//      again, since this is the text that lands in git history and no push hook sees a commit
//      GitHub writes. Then gh pr merge with --match-head-commit and, for --merge, that explicit
//      subject and body, so the merge commit never carries GitHub's default message built from
//      whatever the title and body say at merge time
//  12. the merge is confirmed, and the issues GitHub links the merged pull request to close must be
//      exactly --closes. A mismatch is an error naming the merge: it has already happened, so the
//      tool reports it rather than claiming anything was undone
//
// Every git call names the configured identity and a credential helper that answers with the
// configured account's token from the child environment, never the active gh account.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripControlChars } from "../pr-review/cli";
import type { IdentityLoad } from "../pr-review/identity";
import { CORE_POLICY } from "../pr-review/repo-policy";
import { ownerIdentity, reviewerConfig, type OwnerIdentity, type PublishConfig, type ReviewerConfig } from "./config";
import { PublishError, PublishRefusal } from "./errors";
import { parseRepo } from "../pr-review/types";
import { childEnv, type RunResult, type Runner } from "./exec";
import { Gh, type ClosingRef, type PrState } from "./gh";
import { checksSummary, decideMerge, enumText, parseReviewOutput, type BypassEvidence, type ReviewResult } from "./merge-decision";
import { assertClean, loadBody } from "./publish";
import { compareClosing, findClosingRefs } from "./scan";

export const REVIEWER_TIMEOUT_MS = 45 * 60_000;
export const PREMERGE_TIMEOUT_MS = 10 * 60_000;
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
  // The commit of this tool's own repository that every credential-holding step runs from: this
  // tool's checkout and the reviewer checkout must both be clean and at it. cli.ts requires it as
  // 40 lowercase hex.
  toolHead: string;
}

export interface ReviewMergeContext {
  runner: Runner;
  config: PublishConfig;
  env: Record<string, string | undefined>;
  workDir: string;
  // The checkout this tool runs from. cli.ts passes the repository root above tools/publish.
  toolRoot: string;
  // The repository that checkout must be cloned from, as owner/name. cli.ts passes CORE_POLICY.repo.
  toolRepo: string;
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

// The merge commit message for a --merge merge: the tool's own subject, and the title and body as
// auditClosing read them, never as they stand when GitHub writes the commit.
export function mergeMessage(pr: number, audited: PrState): { subject: string; body: string } {
  const body = audited.body.trim() === "" ? audited.title : `${audited.title}\n\n${audited.body}`;
  return { subject: `Merge pull request #${pr}`, body };
}

// The merge commit message lands in the default branch's history, where only a history rewrite
// removes it, so it is scanned like any published text. A rebase merge writes no message of its own.
function assertMergeMessageClean(ctx: ReviewMergeContext, args: ReviewMergeArgs, view: PrState): void {
  if (args.method !== "merge") return;
  const message = mergeMessage(args.pr, view);
  assertClean(ctx, [
    { label: "merge subject", text: message.subject },
    { label: "merge body", text: message.body },
  ]);
}

// tools/pr-review reviews its built-in repository without --policy and refuses every other one
// without it. It compares the name exactly, so this does too.
export function reviewerPolicyArgs(repo: string, reviewer: Pick<ReviewerConfig, "policyFile">): string[] {
  if (repo === CORE_POLICY.repo) return [];
  if (reviewer.policyFile === null) {
    throw new PublishRefusal("the publish config's reviewer entry for this repository names no policyFile, which the reviewer needs for any repository but its built-in one");
  }
  return ["--policy", reviewer.policyFile];
}

// True when GitHub's closing links for the merged pull request are exactly --closes, all in repo.
function closingMatches(refs: ClosingRef[], declared: number[], repo: string): boolean {
  if (refs.some((ref) => ref.repo.toLowerCase() !== repo.toLowerCase())) return false;
  const linked = [...new Set(refs.map((ref) => ref.number))].sort((a, b) => a - b);
  const wanted = [...new Set(declared)].sort((a, b) => a - b);
  return linked.length === wanted.length && linked.every((n, i) => n === wanted[i]);
}

// owner/name of a GitHub remote URL, or null for anything else. The host is anchored to the start
// of the URL, so notgithub.com and a github.com path segment on another host do not match. The
// token helper below is scoped to https://github.com for the same reason.
export function remoteRepo(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
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
      `credential.https://github.com.helper=${helper}`,
      "-C",
      dir,
      ...args,
    ],
    { env: childEnv(ctx.env, { PUBLISH_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" }) },
  );
  if (result.spawnError) throw new PublishRefusal("git is not on PATH");
  return result;
}

// The reviewer reads the App key on stdin and premerge runs with the owner's token, so both must be
// this tool's own reviewed code at the pin, held to the same bar as this tool's checkout. The origin
// is compared with ctx.toolRepo, never with the repository under review: a clone of that repository
// would run code anyone who can write to its default branch controls. Nothing here fetches or
// moves the checkout, so it runs exactly the commit the operator pinned or refuses.
function assertReviewerPinned(ctx: ReviewMergeContext, gh: Gh, owner: OwnerIdentity, reviewer: ReviewerConfig, toolHead: string): void {
  const dir = reviewer.checkout;
  const origin = git(ctx, owner, gh.token, dir, ["remote", "get-url", "origin"]);
  if (origin.code !== 0 || !remoteMatches(origin.stdout, ctx.toolRepo)) {
    throw new PublishRefusal("the reviewer checkout's origin is not the repository this tool comes from");
  }
  let state: { revision: string; dirty: boolean };
  try {
    state = ctx.toolState(dir);
  } catch {
    throw new PublishRefusal("the reviewer checkout is not a readable git checkout");
  }
  if (state.dirty || state.revision !== toolHead) throw new PublishRefusal("the reviewer checkout is not a clean copy of --tool-head");
}

// The tool's own checkout is often an operator's working clone, on another branch or carrying
// edits. An edited or stale merge-decision.ts there would decide merges, so that checkout must be
// clean, cloned from ctx.toolRepo, and at the pin, and the pin must be that repository's default
// branch head, before anything else runs. A fork's default branch passes none of the review this
// tool's own code goes through.
function assertToolCurrent(ctx: ReviewMergeContext, gh: Gh, owner: OwnerIdentity, toolHead: string): void {
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
  if (origin.code !== 0 || !remoteMatches(origin.stdout, ctx.toolRepo)) {
    throw new PublishRefusal("this tool's own checkout's origin is not the repository this tool comes from. Run review-merge from a clone of it");
  }
  if (state.revision !== toolHead) {
    throw new PublishRefusal("this tool's own checkout is not at --tool-head");
  }
  if (toolHead !== gh.branchHead(ctx.toolRepo, gh.defaultBranch(ctx.toolRepo))) {
    throw new PublishRefusal("--tool-head is not at its default branch's current head. Update the checkouts and the pin and run again");
  }
}

async function runReviewer(ctx: ReviewMergeContext, reviewer: ReviewerConfig, cli: string, repo: string, pr: number, head: string): Promise<ReviewResult> {
  const policy = reviewerPolicyArgs(repo, reviewer);
  const run = await ctx.runner.runPiped(
    { argv: reviewer.keyCommand, cwd: ctx.workDir, env: childEnv(ctx.env, reviewer.keyCommandEnv) },
    {
      argv: [ctx.bunPath, "--cwd", ctx.workDir, cli, "review", "--pr", String(pr), "--repo", repo, "--key-stdin", "--post", "--json", "--expect-head", head, ...policy],
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

// Runs premerge from the reviewer checkout, which assertReviewerPinned found clean at --tool-head,
// so the hygiene check is reviewed code too. Its output names channels and counts
// only (premerge.ts), so it is safe to log. Anything but exit 0 with the OK line for exactly this
// pull request and head refuses.
function runPremerge(ctx: ReviewMergeContext, gh: Gh, owner: OwnerIdentity, reviewer: ReviewerConfig, cli: string, args: ReviewMergeArgs, head: string): void {
  const closes = args.closes.length === 0 ? "none" : [...args.closes].sort((a, b) => a - b).join(",");
  const result = ctx.runner.run(
    [
      ctx.bunPath,
      "--cwd",
      ctx.workDir,
      cli,
      "premerge",
      "--pr",
      String(args.pr),
      "--repo",
      args.repo,
      "--closes",
      closes,
      "--terms",
      reviewer.termsFile,
      "--identity",
      `${owner.gitName} <${owner.gitEmail}>`,
      "--expect-head",
      head,
    ],
    { cwd: ctx.workDir, env: childEnv(ctx.env, { GH_TOKEN: gh.token, GH_PROMPT_DISABLED: "1" }), timeoutMs: PREMERGE_TIMEOUT_MS },
  );
  if (result.spawnError) throw new PublishRefusal("bun could not start premerge. Nothing was merged");
  if (result.timedOut) throw new PublishRefusal("premerge did not finish in time. Nothing was merged");
  const lines = result.stdout.split("\n").map((line) => line.trim());
  for (const line of lines) if (line !== "") ctx.log(stripControlChars(line));
  if (result.code !== 0 || !lines.includes(`PREMERGE OK  #${args.pr}  head=${head}`)) {
    throw new PublishRefusal("premerge did not pass on the reviewed head (its channel lines are above). Nothing was merged");
  }
}

// What decideMerge needs to tell a code-owner block from any other. A failed or incomplete read
// becomes readable: false rather than a throw, so a plain CLEAN merge is not refused over it.
function readBypassEvidence(gh: Gh, repo: string, pr: number, defaultBranch: string, head: string): BypassEvidence {
  try {
    const base = gh.branchHead(repo, defaultBranch);
    if (base === null) return { readable: false, reason: "the default branch could not be read" };
    return {
      readable: true,
      codeowners: gh.fileAt(repo, ".github/CODEOWNERS", base, "reading CODEOWNERS at the base commit"),
      changedFiles: gh.prChangedFiles(repo, pr),
      reviews: gh.prReviews(repo, pr),
      rules: gh.branchRules(repo, defaultBranch),
      protection: gh.branchProtection(repo, defaultBranch),
      checkRuns: gh.checkRuns(repo, head),
    };
  } catch (error) {
    if (error instanceof PublishRefusal || error instanceof PublishError) return { readable: false, reason: error.message };
    throw error;
  }
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
  assertToolCurrent(ctx, gh, owner, args.toolHead);
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
  reviewerPolicyArgs(args.repo, reviewer);
  const cli = join(reviewer.checkout, "tools", "pr-review", "cli.ts");
  if (!ctx.exists(cli)) throw new PublishRefusal("the reviewer checkout holds no tools/pr-review/cli.ts");

  const defaultBranch = gh.defaultBranch(args.repo);
  const first = gh.prView(args.repo, args.pr);
  assertReviewable(first, defaultBranch);
  const head = first.headRefOid;
  auditClosing(gh, args.repo, first, args.closes);
  assertMergeMessageClean(ctx, args, first);

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

  assertReviewerPinned(ctx, gh, owner, reviewer, args.toolHead);
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
    bypass: args.allowAdmin ? readBypassEvidence(gh, args.repo, args.pr, defaultBranch, head) : null,
    method: args.method,
  });
  if (decision.action === "refuse") throw new PublishRefusal(`not merged: ${decision.reason}`);

  runPremerge(ctx, gh, owner, reviewer, cli, args, head);
  if (decision.admin) {
    if (adminReason === null) throw new PublishRefusal("an administrator-bypass merge needs a reason");
    gh.commentPr(args.repo, args.pr, adminReason);
  }
  // GitHub links closing issues from the body as it stands at merge, so an edit after the audit
  // would close what --closes never named. Re-read as late as possible and refuse on any change.
  const latest = gh.prView(args.repo, args.pr);
  if (latest.title !== final.title || latest.body !== final.body) {
    throw new PublishRefusal("the title or body changed after the closing-keyword audit. Nothing was merged");
  }
  assertMergeMessageClean(ctx, args, final);
  gh.mergePr(args.repo, args.pr, head, args.method, decision.admin, mergeMessage(args.pr, final));
  const merged = gh.mergedState(args.repo, args.pr);
  if (merged.state !== "MERGED" || merged.mergeSha === null) {
    throw new PublishError("gh reported no error, but the pull request is not merged. Check it for auto-merge before running again");
  }
  const at = merged.mergeSha.slice(0, 7);
  if (merged.closing === null) {
    throw new PublishError(`merged #${args.pr} at ${at}, but the issues it closes could not be read. Check them against --closes by hand`);
  }
  if (!closingMatches(merged.closing, args.closes, args.repo)) {
    const linked = merged.closing.map((ref) => `${ref.repo}#${ref.number}`).join(", ") || "none";
    const wanted = args.closes.length === 0 ? "none" : [...args.closes].sort((a, b) => a - b).map((n) => `#${n}`).join(", ");
    throw new PublishError(`merged #${args.pr} at ${at}, but GitHub links it to close ${linked} where --closes named ${wanted}. Reopen what should not have closed`);
  }
  return `merged #${args.pr} at ${at} (${decision.admin ? "administrator bypass" : "App approval"})`;
}
