// Tests for tools/publish/gh.ts (#274), against a scripted Runner. No real gh call is made.

import { describe, expect, test } from "bun:test";
import { PublishError, PublishRefusal } from "../tools/publish/errors";
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

  test("prTemplate finds the file case-insensitively in .github first", () => {
    const runner = new FakeRunner([
      TOKEN,
      on(["gh", "api", `repos/${REPO}/contents/.github?ref=main`], { stdout: "CODEOWNERS\nPULL_REQUEST_TEMPLATE.md\n" }),
      on(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/.github/PULL_REQUEST_TEMPLATE.md?ref=main`], {
        stdout: "## Summary\n",
      }),
    ]);
    expect(gh(runner).prTemplate(REPO, "main")).toBe("## Summary\n");
  });

  test("prTemplate returns null when no location holds one", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "api"], NOT_FOUND)]);
    expect(gh(runner).prTemplate(REPO, "main")).toBeNull();
  });

  test("prTemplate throws when a listing fails for a reason other than absence", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "api"], { code: 1, stderr: "HTTP 500" })]);
    expect(() => gh(runner).prTemplate(REPO, "main")).toThrow(PublishError);
  });

  test("issueTemplate refuses an issue form without reading it, and a missing file", () => {
    const form = new FakeRunner([TOKEN, on(["gh", "api"], { stdout: "name: Bug" })]);
    expect(() => gh(form).issueTemplate(REPO, "main", "bug.yml")).toThrow(PublishRefusal);
    expect(form.calls).toHaveLength(1);
    const missing = new FakeRunner([TOKEN, on(["gh", "api"], NOT_FOUND)]);
    expect(() => gh(missing).issueTemplate(REPO, "main", "absent.md")).toThrow(PublishRefusal);
  });

  test("blankIssuesDisabled reads config.yml", () => {
    const runner = new FakeRunner([
      TOKEN,
      on(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/.github/ISSUE_TEMPLATE/config.yml?ref=main`], {
        stdout: "blank_issues_enabled: false\n",
      }),
    ]);
    expect(gh(runner).blankIssuesDisabled(REPO, "main")).toBe(true);
  });

  // Fail closed: only a YAML true leaves blank issues enabled, whatever the spelling or quoting.
  test("blankIssuesDisabled reads any false spelling as disabled and any true spelling as enabled", () => {
    const answer = (text: string): boolean =>
      gh(
        new FakeRunner([
          TOKEN,
          on(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/.github/ISSUE_TEMPLATE/config.yml?ref=main`], { stdout: text }),
        ]),
      ).blankIssuesDisabled(REPO, "main");
    for (const value of ["False", "FALSE", "no", "off", '"false"', "'false'", "false # on purpose", "nope"]) {
      expect(answer(`blank_issues_enabled: ${value}\n`)).toBe(true);
    }
    for (const value of ["true", "True", "yes", '"true"', "true # default"]) {
      expect(answer(`blank_issues_enabled: ${value}\n`)).toBe(false);
    }
    expect(answer("contact_links: []\n")).toBe(false);
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

  test("mergePr pins the head and adds --admin only when asked", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "pr", "merge"], {})]);
    const client = gh(runner);
    client.mergePr(REPO, 7, HEAD, "merge", false);
    client.mergePr(REPO, 7, HEAD, "rebase", true);
    expect(runner.calls[1]!.argv).toEqual(["gh", "pr", "merge", "7", `--repo=${REPO}`, "--merge", `--match-head-commit=${HEAD}`]);
    expect(runner.calls[2]!.argv).toEqual(["gh", "pr", "merge", "7", `--repo=${REPO}`, "--rebase", `--match-head-commit=${HEAD}`, "--admin"]);
  });

  test("watchChecks reports a timeout", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "pr", "checks"], { timedOut: true, code: null })]);
    expect(gh(runner).watchChecks(REPO, 7, 1000)).toBe("timed-out");
    expect(runner.calls[1]!.options.timeoutMs).toBe(1000);
  });
});
