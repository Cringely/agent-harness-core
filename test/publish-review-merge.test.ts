// Tests for tools/publish/review-merge.ts (#274), end to end against a scripted Runner: no gh,
// git, key command or reviewer runs. Every refusal asserts that no merge call was made, and the
// early ones that the reviewer never ran.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parsePublishConfig } from "../tools/publish/config";
import { PublishError, PublishRefusal } from "../tools/publish/errors";
import type { PipedResult } from "../tools/publish/exec";
import { remoteMatches, reviewMerge, type ReviewMergeArgs, type ReviewMergeContext } from "../tools/publish/review-merge";
import { BASE_HEAD, FakeRunner, HEAD, on, REPO, type Responder } from "./publish-fakes";

const CHECKOUT = process.platform === "win32" ? "C:/fixture/reviewer-checkout" : "/fixture/reviewer-checkout";
const WORK = process.platform === "win32" ? "C:/fixture/work" : "/fixture/work";
const TOOL_ROOT = process.platform === "win32" ? "C:/fixture/tool-checkout" : "/fixture/tool-checkout";
const CONFIG = parsePublishConfig(
  JSON.stringify({
    owners: { "fixture-owner": { gitName: "fixture-owner", gitEmail: "fixture-owner@users.noreply.example.test", ghUser: "fixture-owner" } },
    reviewers: { [REPO]: { appId: "1", keyCommand: ["fixture-key-cmd"], keyCommandEnv: { FIXTURE_FLAG: "false" }, checkout: CHECKOUT } },
  }),
);
const ARGS: ReviewMergeArgs = { repo: REPO, pr: 9, closes: [], allowAdmin: false, adminReasonFile: null, method: "merge", checksTimeoutMin: 30 };
const REASON_PATH = process.platform === "win32" ? "C:/fixture/reason.md" : "/fixture/reason.md";
const ADMIN_ARGS: ReviewMergeArgs = { ...ARGS, allowAdmin: true, adminReasonFile: REASON_PATH };
const REASON = "Administrator bypass: this change edits .github/workflows/, which the App cannot vouch for.";
const MERGE_SHA = "d".repeat(40);

const GREEN = [{ __typename: "CheckRun", name: "bun test", status: "COMPLETED", conclusion: "SUCCESS" }];
const VIEW = {
  number: 9,
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat/x",
  headRefOid: HEAD,
  isCrossRepository: false,
  mergeStateStatus: "CLEAN",
  title: "fix: wait for checks",
  body: "## Why\n\nBecause.\n",
  statusCheckRollup: GREEN,
};
const APPROVE_OUTPUT = JSON.stringify({
  status: "posted",
  event: "APPROVE",
  reviewerOk: true,
  headSha: HEAD,
  severities: [],
  refusal: null,
  posted: { id: 1, htmlUrl: `https://github.com/${REPO}/pull/9#pullrequestreview-1` },
});
const reviewerSays = (stdout: string, code = 0, producerCode = 0): PipedResult => ({
  producerCode,
  producerSpawnError: false,
  consumer: { code, stdout, stderr: "", spawnError: false, timedOut: false },
});

// Answers successive `gh pr view --json=<PR fields>` calls with the given states, repeating the last.
function views(...states: object[]): Responder {
  let i = 0;
  return (argv) =>
    argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view" && String(argv[5]).startsWith("--json=number")
      ? { stdout: JSON.stringify(states[Math.min(i++, states.length - 1)]) }
      : undefined;
}

function gitSub(argv: readonly string[]): string[] {
  const at = argv.indexOf("-C");
  return argv[0] === "git" && at !== -1 ? argv.slice(at + 2) : [];
}

function scenario(opts: { views?: object[]; commits?: string[]; extra?: Responder[]; merged?: string } = {}): FakeRunner {
  const commits = opts.commits ?? ["feat: x"];
  return new FakeRunner([
    ...(opts.extra ?? []),
    on(["gh", "auth", "token", "-u", "fixture-owner"], { stdout: "fake-token\n" }),
    on(["gh", "api", `repos/${REPO}`, "--jq", ".default_branch"], { stdout: "main\n" }),
    on(["gh", "api", `repos/${REPO}/branches/main`], { stdout: `${BASE_HEAD}\n` }),
    on(["gh", "api", `repos/${REPO}/pulls/9`], { stdout: `${commits.length}\n` }),
    on(["gh", "api", "--paginate"], { stdout: commits.map((m) => JSON.stringify(m)).join("\n") + "\n" }),
    on(["gh", "pr", "checks"], { code: 0 }),
    views(...(opts.views ?? [VIEW])),
    on(["gh", "pr", "merge"], {}),
    on(["gh", "pr", "view", "9", `--repo=${REPO}`, "--json=state,mergeCommit"], {
      stdout: JSON.stringify({ state: opts.merged ?? "MERGED", mergeCommit: { oid: MERGE_SHA } }),
    }),
    (argv) => (gitSub(argv)[0] === "remote" ? { stdout: `https://github.com/${REPO}.git\n` } : undefined),
    (argv) => (gitSub(argv)[0] === "fetch" ? {} : undefined),
    (argv) => (gitSub(argv)[0] === "rev-parse" ? { stdout: `${BASE_HEAD}\n` } : undefined),
    (argv) => (gitSub(argv)[0] === "checkout" ? {} : undefined),
  ]);
}

function ctx(runner: FakeRunner, overrides: Partial<ReviewMergeContext> = {}): ReviewMergeContext {
  return {
    runner,
    config: CONFIG,
    env: { PATH: "x", GH_TOKEN: "inherited" },
    workDir: WORK,
    toolRoot: TOOL_ROOT,
    bunPath: "/fixture/bun",
    exists: () => true,
    toolState: () => ({ revision: BASE_HEAD, dirty: false }),
    sleep: () => {},
    log: () => {},
    loadIdentity: () => ({
      ok: true,
      declared: true,
      accountEmail: true,
      decl: { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "fixtureuser", hostname: "fixture-host" },
    }),
    readBody: () => REASON,
    ...overrides,
  };
}

function withReviewer(runner: FakeRunner, result: PipedResult): FakeRunner {
  runner.pipedResult = result;
  return runner;
}

async function refusal(run: Promise<unknown>, runner: FakeRunner, fragment: string, reviewerRan: boolean): Promise<void> {
  let error: unknown;
  try {
    await run;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PublishRefusal);
  expect((error as Error).message).toContain(fragment);
  expect(runner.publishing()).toEqual([]);
  expect(runner.piped.length > 0).toBe(reviewerRan);
}

describe("review-merge: merges", () => {
  test("merges on APPROVE with the reviewed head pinned", async () => {
    const runner = withReviewer(scenario(), reviewerSays(APPROVE_OUTPUT));
    expect(await reviewMerge(ctx(runner), ARGS)).toBe(`merged #9 at ${MERGE_SHA.slice(0, 7)} (App approval)`);
    expect(runner.publishing()).toEqual([["gh", "pr", "merge", "9", `--repo=${REPO}`, "--merge", `--match-head-commit=${HEAD}`]]);
  });

  test("runs the reviewer from the work directory with the key piped, the head pinned and no inherited token", async () => {
    const runner = withReviewer(scenario(), reviewerSays(APPROVE_OUTPUT));
    await reviewMerge(ctx(runner), ARGS);
    const { producer, consumer } = runner.piped[0]!;
    expect(producer.argv).toEqual(["fixture-key-cmd"]);
    expect(producer.cwd).toBe(WORK);
    expect(producer.env.FIXTURE_FLAG).toBe("false");
    expect(producer.env.GH_TOKEN).toBeUndefined();
    expect(consumer.argv).toEqual([
      "/fixture/bun",
      "--cwd",
      WORK,
      join(CHECKOUT, "tools", "pr-review", "cli.ts"),
      "review",
      "--pr",
      "9",
      "--repo",
      REPO,
      "--key-stdin",
      "--post",
      "--json",
      "--expect-head",
      HEAD,
    ]);
    expect(consumer.cwd).toBe(WORK);
    expect(consumer.env.PR_REVIEW_APP_ID).toBe("1");
    expect(consumer.env.GH_TOKEN).toBeUndefined();
  });

  test("names the configured identity and token helper on every git call", async () => {
    const runner = withReviewer(scenario(), reviewerSays(APPROVE_OUTPUT));
    await reviewMerge(ctx(runner), ARGS);
    const gitCalls = runner.calls.filter((call) => call.argv[0] === "git");
    expect(gitCalls.length).toBe(5);
    for (const call of gitCalls) {
      expect(call.argv).toContain("user.name=fixture-owner");
      expect(call.argv).toContain("credential.helper=");
      expect(call.options.env?.PUBLISH_GIT_TOKEN).toBe("fake-token");
      expect(call.options.env?.GH_TOKEN).toBeUndefined();
    }
  });

  test("uses the administrator bypass for a COMMENT with --allow-admin, posting the reason first", async () => {
    const output = JSON.stringify({ ...JSON.parse(APPROVE_OUTPUT), event: "COMMENT", severities: ["naming"] });
    const runner = withReviewer(
      scenario({ views: [VIEW, VIEW, { ...VIEW, mergeStateStatus: "BLOCKED" }], extra: [on(["gh", "pr", "comment"], {})] }),
      reviewerSays(output),
    );
    expect(await reviewMerge(ctx(runner), ADMIN_ARGS)).toContain("administrator bypass");
    const published = runner.publishing();
    expect(published.map((argv) => argv[2])).toEqual(["comment", "merge"]);
    expect(published[1]).toContain("--admin");
    expect(runner.calls.find((call) => call.argv[2] === "comment")!.options.stdin).toBe(REASON);
  });

  test("posts no reason when --allow-admin was given but a plain merge sufficed", async () => {
    const runner = withReviewer(scenario({ extra: [on(["gh", "pr", "comment"], {})] }), reviewerSays(APPROVE_OUTPUT));
    expect(await reviewMerge(ctx(runner), ADMIN_ARGS)).toContain("App approval");
    expect(runner.publishing().map((argv) => argv[2])).toEqual(["merge"]);
  });

  test("waits out an UNKNOWN merge state", async () => {
    let slept = 0;
    const runner = withReviewer(scenario({ views: [VIEW, VIEW, { ...VIEW, mergeStateStatus: "UNKNOWN" }, VIEW] }), reviewerSays(APPROVE_OUTPUT));
    await reviewMerge(ctx(runner, { sleep: () => slept++ }), ARGS);
    expect(slept).toBe(1);
  });
});

describe("review-merge: refuses before the reviewer runs", () => {
  // The checkout this tool runs from holds the token and the merge rule, so it meets the reviewer
  // checkout's bar: clean, and at its origin's default branch head.
  test("this tool's own checkout carrying uncommitted changes", async () => {
    const runner = scenario();
    await refusal(
      reviewMerge(ctx(runner, { toolState: (root) => ({ revision: BASE_HEAD, dirty: root === TOOL_ROOT }) }), ARGS),
      runner,
      "own checkout has uncommitted changes",
      false,
    );
    expect(runner.calls.some((call) => call.argv[1] === "pr")).toBe(false);
  });

  test("this tool's own checkout away from the default branch head", async () => {
    const runner = scenario();
    await refusal(
      reviewMerge(ctx(runner, { toolState: (root) => ({ revision: root === TOOL_ROOT ? "e".repeat(40) : BASE_HEAD, dirty: false }) }), ARGS),
      runner,
      "not at its default branch's current head",
      false,
    );
    expect(runner.calls.some((call) => call.argv[1] === "pr")).toBe(false);
  });

  test("no reviewer in the config", async () => {
    const runner = scenario();
    const config = parsePublishConfig(JSON.stringify({ owners: { "fixture-owner": CONFIG.owners["fixture-owner"] } }));
    await refusal(reviewMerge(ctx(runner, { config }), ARGS), runner, "no reviewer", false);
  });

  test("an admin reason carrying an identifying string", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner, { readBody: () => "Bypass approved by Fixture Person." }), ADMIN_ARGS), runner, "admin reason: declared name #1", false);
  });

  test("an admin reason carrying a closing keyword", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner, { readBody: () => "Bypass; fixes #3." }), ADMIN_ARGS), runner, "closing keyword", false);
  });

  test("--allow-admin with no reason file", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner), { ...ADMIN_ARGS, adminReasonFile: null }), runner, "needs --admin-reason-file", false);
  });

  test("a reviewer checkout without the reviewer", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner, { exists: () => false }), ARGS), runner, "holds no tools/pr-review/cli.ts", false);
  });

  test("a draft", async () => {
    const runner = scenario({ views: [{ ...VIEW, isDraft: true }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "draft", false);
  });

  test("a pull request into another base", async () => {
    const runner = scenario({ views: [{ ...VIEW, baseRefName: "release" }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "default branch", false);
  });

  // Review Focus 5: a --merge merge commit carries the title onto the default branch.
  test("an undeclared closing keyword in the title", async () => {
    const runner = scenario({ views: [{ ...VIEW, title: "Fixes #12: wait for checks" }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "undeclared: 1", false);
  });

  test("an undeclared closing keyword in a commit message", async () => {
    const runner = scenario({ commits: ["feat: x\n\ncloses #4"] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "undeclared: 1", false);
  });

  test("checks that outlast the timeout", async () => {
    const runner = scenario({ extra: [on(["gh", "pr", "checks"], { timedOut: true, code: null })] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "did not finish within 30 minutes", false);
  });

  test("a head that moved while checks ran", async () => {
    const runner = scenario({ views: [VIEW, { ...VIEW, headRefOid: "c".repeat(40) }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "head moved", false);
  });

  test("a failed check", async () => {
    const red = { ...VIEW, statusCheckRollup: [{ __typename: "CheckRun", name: "Pester", status: "COMPLETED", conclusion: "FAILURE" }] };
    const runner = scenario({ views: [VIEW, red] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "1 not successful", false);
  });

  // Review Focus 4: run straight after a push, before CI has registered any check.
  test("no checks registered yet", async () => {
    const runner = scenario({ views: [VIEW, { ...VIEW, statusCheckRollup: [] }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "0 total", false);
  });

  test("a reviewer checkout whose origin is another repository", async () => {
    const runner = scenario({
      extra: [(argv) => (gitSub(argv)[0] === "remote" && argv.includes(CHECKOUT) ? { stdout: "https://github.com/someone/else.git\n" } : undefined)],
    });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "origin is not this repository", false);
  });

  test("a reviewer checkout that lags the default branch", async () => {
    const runner = scenario({ extra: [(argv) => (gitSub(argv)[0] === "rev-parse" ? { stdout: `${"e".repeat(40)}\n` } : undefined)] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "current head", false);
  });

  test("a dirty reviewer checkout", async () => {
    const runner = scenario();
    await refusal(
      reviewMerge(ctx(runner, { toolState: (root) => ({ revision: BASE_HEAD, dirty: root === CHECKOUT }) }), ARGS),
      runner,
      "not a clean copy",
      false,
    );
  });

  test("git missing from PATH", async () => {
    const runner = scenario({ extra: [(argv) => (argv[0] === "git" ? { spawnError: true, code: null } : undefined)] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "git is not on PATH", false);
  });
});

describe("review-merge: refuses after the reviewer runs", () => {
  test("a key command that failed", async () => {
    const runner = withReviewer(scenario(), reviewerSays("", 2, 1));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "key command failed", true);
  });

  test("a reviewer refusal, passing on its class-only reason", async () => {
    const runner = withReviewer(scenario(), reviewerSays(JSON.stringify({ status: "refused", refusal: "the pull request comes from a fork" }), 2));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "the reviewer refused: the pull request comes from a fork", true);
  });

  test("a COMMENT without --allow-admin", async () => {
    const output = JSON.stringify({ ...JSON.parse(APPROVE_OUTPUT), event: "COMMENT" });
    const runner = withReviewer(scenario(), reviewerSays(output));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "Only --allow-admin", true);
  });

  test("a head that moved after the review", async () => {
    const runner = withReviewer(scenario({ views: [VIEW, VIEW, { ...VIEW, headRefOid: "c".repeat(40) }] }), reviewerSays(APPROVE_OUTPUT));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "not the one that was reviewed", true);
  });

  test("a closing keyword added to the body after the review", async () => {
    const runner = withReviewer(scenario({ views: [VIEW, VIEW, { ...VIEW, body: "Closes #8" }] }), reviewerSays(APPROVE_OUTPUT));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "undeclared: 1", true);
  });

  test("a merge gh accepted that did not land is an error, not a success", async () => {
    const runner = withReviewer(scenario({ merged: "OPEN" }), reviewerSays(APPROVE_OUTPUT));
    await expect(reviewMerge(ctx(runner), ARGS)).rejects.toBeInstanceOf(PublishError);
  });

  test("reviewer output that is not JSON is an error", async () => {
    const runner = withReviewer(scenario(), reviewerSays("status=posted event=APPROVE"));
    await expect(reviewMerge(ctx(runner), ARGS)).rejects.toBeInstanceOf(PublishError);
    expect(runner.publishing()).toEqual([]);
  });
});

describe("remoteMatches()", () => {
  test("accepts https and ssh forms, with or without .git", () => {
    expect(remoteMatches(`https://github.com/${REPO}.git`, REPO)).toBe(true);
    expect(remoteMatches(`git@github.com:${REPO}`, REPO)).toBe(true);
    expect(remoteMatches(`https://github.com/${REPO}-fork.git`, REPO)).toBe(false);
  });
});
