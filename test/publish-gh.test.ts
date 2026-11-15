// Tests for tools/publish/gh.ts (#274), against a scripted Runner. No real gh call is made.

import { describe, expect, test } from "bun:test";
import { PublishError, PublishRefusal } from "../tools/publish/errors";
import type { RunResult } from "../tools/publish/exec";
import { Gh } from "../tools/publish/gh";
import { FakeRunner, HEAD, NOT_FOUND, on, REPO } from "./publish-fakes";

const TOKEN = on(["gh", "auth", "token", "-u", "fixture-owner"], { stdout: "fake-token\n" });
const gh = (runner: FakeRunner) => Gh.forUser(runner, "fixture-owner", { PATH: "x", GH_TOKEN: "inherited", GITHUB_TOKEN: "inherited" });

describe("Gh.forUser()", () => {
  test("reads the named account's token and never passes an inherited one to the probe", () => {
    const runner = new FakeRunner([TOKEN]);
    gh(runner);
    expect(runner.calls[0]!.argv).toEqual(["gh", "auth", "token", "-u", "fixture-owner"]);
    expect(runner.calls[0]!.options.env).toEqual({ PATH: "x" });
  });

  test("sends the chosen token, and only it, on later calls", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "api"], { stdout: "main\n" })]);
    gh(runner).defaultBranch(REPO);
    expect(runner.calls[1]!.options.env).toEqual({ PATH: "x", GH_TOKEN: "fake-token", GH_PROMPT_DISABLED: "1" });
  });

  test("refuses when gh is not on PATH", () => {
    const runner = new FakeRunner([(argv) => (argv[0] === "gh" ? { spawnError: true, code: null } : undefined)]);
    expect(() => gh(runner)).toThrow(PublishRefusal);
  });

  test("refuses when gh holds no token for the account", () => {
    const runner = new FakeRunner([on(["gh", "auth", "token"], { code: 1, stderr: "no oauth token" })]);
    expect(() => gh(runner)).toThrow(PublishRefusal);
  });

  test("refuses an empty token", () => {
    const runner = new FakeRunner([on(["gh", "auth", "token"], { stdout: "\n" })]);
    expect(() => gh(runner)).toThrow(PublishRefusal);
  });
});

describe("lookups", () => {
  test("branchHead returns null on a 404 and throws on any other failure", () => {
    const missing = new FakeRunner([TOKEN, on(["gh", "api"], NOT_FOUND)]);
    expect(gh(missing).branchHead(REPO, "nope")).toBeNull();
    const broken = new FakeRunner([TOKEN, on(["gh", "api"], { code: 1, stderr: "HTTP 502" })]);
    expect(() => gh(broken).branchHead(REPO, "x")).toThrow(PublishError);
  });

  test("branchHead refuses a branch name outside the accepted characters before calling gh", () => {
    const runner = new FakeRunner([TOKEN]);
    const client = gh(runner);
    expect(() => client.branchHead(REPO, "feat/x?ref=y")).toThrow(PublishRefusal);
    expect(() => client.branchHead(REPO, "feat/../x")).toThrow(PublishRefusal);
    expect(runner.calls).toHaveLength(1);
  });

  test("fileAt returns the raw file, null on a 404, and throws on any other failure", () => {
    const path = `repos/${REPO}/contents/.github/CODEOWNERS?ref=main`;
    const present = new FakeRunner([TOKEN, on(["gh", "api", "-H", "Accept: application/vnd.github.raw", path], { stdout: "* @owner\n" })]);
    expect(gh(present).fileAt(REPO, ".github/CODEOWNERS", "main", "reading CODEOWNERS")).toBe("* @owner\n");
    const missing = new FakeRunner([TOKEN, on(["gh", "api"], NOT_FOUND)]);
    expect(gh(missing).fileAt(REPO, ".github/CODEOWNERS", "main", "reading CODEOWNERS")).toBeNull();
    const broken = new FakeRunner([TOKEN, on(["gh", "api"], { code: 1, stderr: "HTTP 502" })]);
    expect(() => gh(broken).fileAt(REPO, ".github/CODEOWNERS", "main", "reading CODEOWNERS")).toThrow(PublishError);
  });
});

describe("prView()", () => {
  test("reads check runs and status contexts", () => {
    const view = {
      number: 7,
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "feat/x",
      headRefOid: HEAD,
      isCrossRepository: false,
      mergeStateStatus: "CLEAN",
      body: "b",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
      ],
    };
    const runner = new FakeRunner([TOKEN, on(["gh", "pr", "view"], { stdout: JSON.stringify(view) })]);
    expect(gh(runner).prView(REPO, 7).checks).toEqual([
      { kind: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { kind: "StatusContext", name: "ci/legacy", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
  });

  test("throws on data without a usable head", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "pr", "view"], { stdout: JSON.stringify({ state: "OPEN", baseRefName: "main", headRefOid: "short" }) })]);
    expect(() => gh(runner).prView(REPO, 7)).toThrow(PublishError);
  });
});

describe("prCommitMessages()", () => {
  test("returns every message when the count reconciles", () => {
    const runner = new FakeRunner([
      TOKEN,
      on(["gh", "api", `repos/${REPO}/pulls/7`], { stdout: "2\n" }),
      on(["gh", "api", "--paginate"], { stdout: `${JSON.stringify("one\n\nCloses #1")}\n${JSON.stringify("two")}\n` }),
    ]);
    expect(gh(runner).prCommitMessages(REPO, 7)).toEqual(["one\n\nCloses #1", "two"]);
  });

  test("refuses a list shorter than the pull request's commit count", () => {
    const runner = new FakeRunner([
      TOKEN,
      on(["gh", "api", `repos/${REPO}/pulls/7`], { stdout: "300\n" }),
      on(["gh", "api", "--paginate"], { stdout: `${JSON.stringify("one")}\n` }),
    ]);
    expect(() => gh(runner).prCommitMessages(REPO, 7)).toThrow(PublishRefusal);
  });
});

describe("prChangedFiles()", () => {
  const files = (count: string, listing: string) =>
    new FakeRunner([TOKEN, on(["gh", "api", `repos/${REPO}/pulls/7`, "--jq", ".changed_files"], { stdout: count }), on(["gh", "api", "--paginate"], { stdout: listing })]);

  test("returns every path when the count reconciles", () => {
    const runner = files("2\n", `${JSON.stringify("a.md")}\n${JSON.stringify("tools/x.ts")}\n`);
    expect(gh(runner).prChangedFiles(REPO, 7)).toEqual(["a.md", "tools/x.ts"]);
    expect(runner.calls[2]!.argv).toEqual(["gh", "api", "--paginate", `repos/${REPO}/pulls/7/files?per_page=100`, "--jq", ".[].filename | @json"]);
  });

  test("refuses a list shorter than the pull request's changed-file count, as past GitHub's 3000-file cap", () => {
    expect(() => gh(files("3001\n", `${JSON.stringify("a.md")}\n`)).prChangedFiles(REPO, 7)).toThrow(PublishRefusal);
  });

  test("refuses a count that is not a number, and an entry that is not a path", () => {
    expect(() => gh(files("null\n", `${JSON.stringify("a.md")}\n`)).prChangedFiles(REPO, 7)).toThrow(PublishRefusal);
    expect(() => gh(files("1\n", "7\n")).prChangedFiles(REPO, 7)).toThrow(PublishRefusal);
  });
});

describe("prReviews()", () => {
  const reviews = (listing: string) => new FakeRunner([TOKEN, on(["gh", "api", "graphql", "--paginate"], { stdout: listing })]);
  const APPROVAL = { id: 1, state: "APPROVED", canPush: true, author: "reviewer-app", commit: HEAD };

  test("returns each review in GitHub's order, with its author and push access, reading a missing commit or author as none", () => {
    const listing = [{ id: 2, state: "COMMENTED", canPush: false, author: null, commit: null }, APPROVAL].map((r) => JSON.stringify(r)).join("\n");
    const runner = reviews(`${listing}\n`);
    expect(gh(runner).prReviews(REPO, 7)).toEqual([
      { id: 2, state: "COMMENTED", commitId: "", author: "", authorCanPush: false },
      { id: 1, state: "APPROVED", commitId: HEAD, author: "reviewer-app", authorCanPush: true },
    ]);
    const argv = runner.calls[1]!.argv;
    expect(argv.slice(0, 10)).toEqual(["gh", "api", "graphql", "--paginate", "-f", "owner=fixture-owner", "-f", "name=fixture-repo", "-F", "number=7"]);
    expect(argv[11]).toContain("authorCanPushToRepository");
    expect(argv[11]).toContain("endCursor");
  });

  // gh's -F turns true, false, null and integers into JSON types and reads an @-prefixed value from
  // a file, so owner and name go as raw strings and only the number is typed.
  test("passes owner and name as raw strings, even when they read as a number or a boolean", () => {
    const runner = reviews(`${JSON.stringify(APPROVAL)}
`);
    gh(runner).prReviews("2048/true", 7);
    const argv = runner.calls[1]!.argv;
    expect(argv.slice(4, 10)).toEqual(["-f", "owner=2048", "-f", "name=true", "-F", "number=7"]);
    expect(argv.filter((arg, i) => argv[i - 1] === "-F")).toEqual(["number=7"]);
  });

  test("throws on a review without an integer id, a state, a push flag, or JSON", () => {
    for (const bad of [{ ...APPROVAL, id: "1" }, { ...APPROVAL, state: undefined }, { ...APPROVAL, canPush: "true" }, { ...APPROVAL, commit: 7 }]) {
      expect(() => gh(reviews(`${JSON.stringify(bad)}\n`)).prReviews(REPO, 7)).toThrow(PublishError);
    }
    expect(() => gh(reviews("not json\n")).prReviews(REPO, 7)).toThrow(PublishError);
    expect(() => gh(reviews("[1]\n")).prReviews(REPO, 7)).toThrow(PublishError);
  });
});

describe("branchProtection()", () => {
  const protection = (result: Partial<RunResult>) => new FakeRunner([TOKEN, on(["gh", "api", `repos/${REPO}/branches/main/protection`], result)]);

  test("reads no protection only from GitHub's 'Branch not protected' answer", () => {
    expect(gh(protection({ code: 1, stderr: "gh: Branch not protected (HTTP 404)" })).branchProtection(REPO, "main")).toBeNull();
    expect(() => gh(protection({ code: 1, stderr: "gh: Not Found (HTTP 404)" })).branchProtection(REPO, "main")).toThrow(PublishError);
    expect(() => gh(protection({ code: 1, stderr: "gh: Server Error (HTTP 500)" })).branchProtection(REPO, "main")).toThrow(PublishError);
  });

  test("returns the protection object, and throws on one that is not", () => {
    expect(gh(protection({ stdout: `${JSON.stringify({ lock_branch: { enabled: false } })}\n` })).branchProtection(REPO, "main")).toEqual({ lock_branch: { enabled: false } });
    expect(() => gh(protection({ stdout: "[]\n" })).branchProtection(REPO, "main")).toThrow(PublishError);
  });

  test("refuses a branch name it does not accept", () => {
    expect(() => gh(protection({})).branchProtection(REPO, "a..b")).toThrow(PublishRefusal);
  });
});

describe("checkRuns()", () => {
  const runsOf = (listing: object[]) => new FakeRunner([TOKEN, on(["gh", "api", "--paginate"], { stdout: listing.map((r) => JSON.stringify(r)).join("\n") + "\n" })]);

  test("returns each run with its app id, upper-casing status and conclusion", () => {
    const runner = runsOf([
      { total: 2, name: "bun test", status: "completed", conclusion: "success", app: 15368 },
      { total: 2, name: "lint", status: "in_progress", conclusion: null, app: null },
    ]);
    expect(gh(runner).checkRuns(REPO, HEAD)).toEqual([
      { name: "bun test", status: "COMPLETED", conclusion: "SUCCESS", appId: 15368 },
      { name: "lint", status: "IN_PROGRESS", conclusion: "", appId: null },
    ]);
    expect(runner.calls[1]!.argv.slice(0, 4)).toEqual(["gh", "api", "--paginate", `repos/${REPO}/commits/${HEAD}/check-runs?per_page=100`]);
  });

  test("refuses a list shorter than its total, and throws on a run without a name or on a short sha", () => {
    expect(() => gh(runsOf([{ total: 3, name: "a", status: "completed", conclusion: "success", app: 1 }])).checkRuns(REPO, HEAD)).toThrow(PublishRefusal);
    expect(() => gh(runsOf([{ total: 1, status: "completed", conclusion: "success", app: 1 }])).checkRuns(REPO, HEAD)).toThrow(PublishError);
    expect(() => gh(runsOf([])).checkRuns(REPO, "abc")).toThrow(PublishError);
  });
});

describe("branchRules()", () => {
  const rules = (listing: string) => new FakeRunner([TOKEN, on(["gh", "api", "--paginate"], { stdout: listing })]);

  test("returns each active rule with its parameters", () => {
    const listing = [{ type: "deletion" }, { type: "code_quality", parameters: { severity: "errors" } }].map((r) => JSON.stringify(r)).join("\n");
    const runner = rules(`${listing}\n`);
    expect(gh(runner).branchRules(REPO, "main")).toEqual([
      { type: "deletion", parameters: null },
      { type: "code_quality", parameters: { severity: "errors" } },
    ]);
    expect(runner.calls[1]!.argv).toEqual(["gh", "api", "--paginate", `repos/${REPO}/rules/branches/main?per_page=100`, "--jq", ".[] | {type, parameters} | @json"]);
  });

  test("throws on a rule without a type or with parameters that are not an object", () => {
    expect(() => gh(rules(`${JSON.stringify({ parameters: {} })}\n`)).branchRules(REPO, "main")).toThrow(PublishError);
    expect(() => gh(rules(`${JSON.stringify({ type: "x", parameters: [1] })}\n`)).branchRules(REPO, "main")).toThrow(PublishError);
    expect(() => gh(rules(`${JSON.stringify({ type: "x", parameters: "on" })}\n`)).branchRules(REPO, "main")).toThrow(PublishError);
  });

  test("refuses a branch name it does not accept", () => {
    expect(() => gh(rules("")).branchRules(REPO, "a..b")).toThrow(PublishRefusal);
  });
});

describe("publishing calls", () => {
  test("createPr passes values as --flag=value and the body on stdin", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "pr", "create"], { stdout: `https://github.com/${REPO}/pull/9\n` })]);
    expect(gh(runner).createPr(REPO, "main", "feat/x", "-dash title", "body text", true)).toBe(`https://github.com/${REPO}/pull/9`);
    const call = runner.calls[1]!;
    expect(call.argv).toEqual([
      "gh",
      "pr",
      "create",
      `--repo=${REPO}`,
      "--base=main",
      "--head=feat/x",
      "--title=-dash title",
      "--body-file=-",
      "--draft",
    ]);
    expect(call.options.stdin).toBe("body text");
  });

  test("createIssue throws when gh prints no issue URL", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "issue", "create"], { stdout: "something else\n" })]);
    expect(() => gh(runner).createIssue(REPO, "t", "b")).toThrow(PublishError);
  });

  test("mergePr pins the head, sets a --merge commit's message, and adds --admin only when asked", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "pr", "merge"], {})]);
    const client = gh(runner);
    const message = { subject: "Merge pull request #7", body: "title" };
    client.mergePr(REPO, 7, HEAD, "merge", false, message);
    client.mergePr(REPO, 7, HEAD, "rebase", true, message);
    expect(runner.calls[1]!.argv).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      `--repo=${REPO}`,
      "--merge",
      `--match-head-commit=${HEAD}`,
      "--subject=Merge pull request #7",
      "--body-file=-",
    ]);
    expect(runner.calls[1]!.options.stdin).toBe("title");
    expect(runner.calls[2]!.argv).toEqual(["gh", "pr", "merge", "7", `--repo=${REPO}`, "--rebase", `--match-head-commit=${HEAD}`, "--admin"]);
    expect(runner.calls[2]!.options.stdin).toBeUndefined();
  });

  test("mergedState reads the closing references, and an unreadable list as null", () => {
    const answer = (closing: unknown) =>
      new FakeRunner([
        TOKEN,
        on(["gh", "pr", "view", "7"], { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: HEAD }, closingIssuesReferences: closing }) }),
      ]);
    const ref = { number: 3, repository: { name: "fixture-repo", owner: { login: "fixture-owner" } } };
    expect(gh(answer([ref])).mergedState(REPO, 7)).toEqual({ state: "MERGED", mergeSha: HEAD, closing: [{ repo: REPO, number: 3 }] });
    expect(gh(answer(undefined)).mergedState(REPO, 7).closing).toBeNull();
    expect(gh(answer([{ number: "3" }])).mergedState(REPO, 7).closing).toBeNull();
  });

  test("watchChecks reports a timeout", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "pr", "checks"], { timedOut: true, code: null })]);
    expect(gh(runner).watchChecks(REPO, 7, 1000)).toBe("timed-out");
    expect(runner.calls[1]!.options.timeoutMs).toBe(1000);
  });
});
