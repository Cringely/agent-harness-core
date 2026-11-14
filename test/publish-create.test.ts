// Tests for tools/publish/publish.ts (#274): every gate on issue and pull request create and edit
// refuses with exit-2 semantics (PublishRefusal) and makes no publishing gh call. Each refusal
// case also asserts runner.publishing() is empty, which is the property a removed gate would break.

import { describe, expect, test } from "bun:test";
import type { IdentityLoad } from "../tools/pr-review/identity";
import { parsePublishConfig } from "../tools/publish/config";
import { PublishRefusal, UsageError } from "../tools/publish/errors";
import { issueCreate, issueEdit, nativePath, prCreate, prEdit, type PublishContext } from "../tools/publish/publish";
import { FakeRunner, HEAD, healthyRepo, NOT_FOUND, on, REPO, type Responder } from "./publish-fakes";

const CONFIG = parsePublishConfig(
  JSON.stringify({ owners: { "fixture-owner": { gitName: "fixture-owner", gitEmail: "fixture-owner@users.noreply.example.test", ghUser: "fixture-owner" } } }),
);
const IDENTITY: Extract<IdentityLoad, { ok: true }> = {
  ok: true,
  declared: true,
  accountEmail: true,
  decl: { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "fixtureuser", hostname: "fixture-host" },
};
const BODY_PATH = process.platform === "win32" ? "C:/fixture/body.md" : "/fixture/body.md";
const CLEAN_BODY = "## Why\n\nThe wait loop never waited.\n";
const PR_URL = `https://github.com/${REPO}/pull/9`;
const ISSUE_URL = `https://github.com/${REPO}/issues/9`;

function ctx(runner: FakeRunner, body: string = CLEAN_BODY, overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    runner,
    config: CONFIG,
    env: { PATH: "x" },
    loadIdentity: () => IDENTITY,
    readBody: () => body,
    ...overrides,
  };
}

function publishingRepo(extra: Responder[] = []): FakeRunner {
  return new FakeRunner([
    ...extra,
    on(["gh", "pr", "create"], { stdout: `${PR_URL}\n` }),
    on(["gh", "issue", "create"], { stdout: `${ISSUE_URL}\n` }),
    on(["gh", "pr", "edit"], {}),
    on(["gh", "issue", "edit"], {}),
    ...healthyRepo(),
  ]);
}

const PR_ARGS = { repo: REPO, base: "main", head: "feat/x", title: "fix: wait for checks", bodyFile: BODY_PATH, closes: [] as number[], draft: false };

function refuses(run: () => unknown, runner: FakeRunner, fragment: string): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PublishRefusal);
  expect((error as Error).message).toContain(fragment);
  expect(runner.publishing()).toEqual([]);
}

describe("pr create", () => {
  test("publishes a clean body and returns the URL", () => {
    const runner = publishingRepo();
    expect(prCreate(ctx(runner), PR_ARGS)).toBe(PR_URL);
    expect(runner.publishing()).toHaveLength(1);
  });

  // Review Focus 3: an agent in Git Bash passes its scratch path in /c/... form.
  test("translates a Git Bash drive path on Windows and leaves it alone elsewhere", () => {
    expect(nativePath("/c/Users/fixture/body.md", "win32")).toBe("C:/Users/fixture/body.md");
    expect(nativePath("/c", "win32")).toBe("C:/");
    expect(nativePath("/c/Users/fixture/body.md", "linux")).toBe("/c/Users/fixture/body.md");
    expect(nativePath("/srv/body.md", "win32")).toBe("/srv/body.md");
  });

  test("reads the body from the translated path", () => {
    const seen: string[] = [];
    const runner = publishingRepo();
    prCreate(ctx(runner, CLEAN_BODY, { readBody: (path) => (seen.push(path), CLEAN_BODY) }), { ...PR_ARGS, bodyFile: "/c/fixture/body.md" });
    expect(seen).toEqual([process.platform === "win32" ? "C:/fixture/body.md" : "/c/fixture/body.md"]);
  });

  // Review Focus 5: a --merge merge commit carries the title, and a closing keyword in any commit
  // message reaching the default branch closes its issue, so the title counts against --closes.
  test("refuses a title that carries an undeclared closing keyword", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner), { ...PR_ARGS, title: "Fixes #12: wait for checks" }), runner, "undeclared: 1");
  });

  test("publishes a title keyword that --closes declares", () => {
    const runner = publishingRepo();
    expect(prCreate(ctx(runner), { ...PR_ARGS, title: "Fixes #12: wait for checks", closes: [12] })).toBe(PR_URL);
  });

  test("refuses a relative body path as a usage error", () => {
    const runner = publishingRepo();
    expect(() => prCreate(ctx(runner), { ...PR_ARGS, bodyFile: "body.md" })).toThrow(UsageError);
  });

  test("refuses an empty body", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner, "  \n"), PR_ARGS), runner, "empty");
  });

  test("refuses when the config names no identity for the owner", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner), { ...PR_ARGS, repo: "someone-else/repo" }), runner, "no identity");
  });

  test("refuses when the identity scan cannot be built", () => {
    const runner = publishingRepo();
    refuses(
      () => prCreate(ctx(runner, CLEAN_BODY, { loadIdentity: () => ({ ok: false, reason: "the identity file is not a JSON object" }) }), PR_ARGS),
      runner,
      "identity scan cannot be built",
    );
  });

  // The scan fails closed on a missing input rather than running narrower. Each case pairs the
  // missing input with a body the full scan would catch, so a gate that only warned would publish it.
  test("refuses when no identity file is declared", () => {
    const runner = publishingRepo();
    const identity: IdentityLoad = { ...IDENTITY, declared: false, decl: { ...IDENTITY.decl, names: [] } };
    refuses(() => prCreate(ctx(runner, "Thanks to Fixture Person.\n", { loadIdentity: () => identity }), PR_ARGS), runner, "no declared name");
  });

  test("refuses when the identity file declares no name", () => {
    const runner = publishingRepo();
    const identity: IdentityLoad = { ...IDENTITY, decl: { ...IDENTITY.decl, names: [] } };
    refuses(() => prCreate(ctx(runner, "Thanks to Fixture Person.\n", { loadIdentity: () => identity }), PR_ARGS), runner, "no declared name");
  });

  test("refuses when the claude CLI's account email is unknown", () => {
    const runner = publishingRepo();
    const identity: IdentityLoad = { ...IDENTITY, accountEmail: false, decl: { ...IDENTITY.decl, emails: [] } };
    refuses(() => prCreate(ctx(runner, "Mail fixture@example.test.\n", { loadIdentity: () => identity }), PR_ARGS), runner, "no account email");
  });

  // identity.ts: an email declared in the identity file never satisfies the account-email check, so
  // a file that declares emails beside an unknown CLI account still refuses.
  test("refuses when the CLI's account email is unknown even though the identity file declares emails", () => {
    const runner = publishingRepo();
    const identity: IdentityLoad = { ...IDENTITY, accountEmail: false };
    expect(identity.decl.emails).not.toEqual([]);
    refuses(() => prCreate(ctx(runner, CLEAN_BODY, { loadIdentity: () => identity }), PR_ARGS), runner, "no account email");
  });

  test("refuses an identifying string in the body, naming only its class", () => {
    const runner = publishingRepo();
    let message = "";
    try {
      prCreate(ctx(runner, "Thanks to Fixture Person.\n"), PR_ARGS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("body: declared name #1");
    expect(message).not.toContain("Fixture Person");
    expect(runner.publishing()).toEqual([]);
  });

  test("refuses an identifying string in the title", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner), { ...PR_ARGS, title: "fix from fixture-host" }), runner, "title: machine hostname");
  });

  test("refuses an identifying string in the head branch name", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner), { ...PR_ARGS, head: "fixtureuser/wip" }), runner, "head branch: workstation username");
  });

  test("refuses an attribution line", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner, `${CLEAN_BODY}\nCo-Authored-By: Someone <s@example.test>\n`), PR_ARGS), runner, "Co-Authored-By line");
  });

  test("refuses a closing keyword that was not declared", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner, `${CLEAN_BODY}\nCloses #12\n`), PR_ARGS), runner, "undeclared: 1");
  });

  test("refuses a declared issue the body does not close", () => {
    const runner = publishingRepo();
    refuses(() => prCreate(ctx(runner), { ...PR_ARGS, closes: [12] }), runner, "missing: 1");
  });

  test("publishes when the closing keywords equal --closes", () => {
    const runner = publishingRepo();
    expect(prCreate(ctx(runner, `${CLEAN_BODY}\nCloses #12\n`), { ...PR_ARGS, closes: [12] })).toBe(PR_URL);
  });

  test("refuses closing keywords on a pull request into a non-default base", () => {
    const runner = publishingRepo([on(["gh", "api", `repos/${REPO}/branches/release`], { stdout: `${HEAD}\n` })]);
    refuses(() => prCreate(ctx(runner, `${CLEAN_BODY}\nCloses #12\n`), { ...PR_ARGS, base: "release", closes: [12] }), runner, "default branch");
  });

  test("refuses when gh holds no token", () => {
    const runner = new FakeRunner([on(["gh", "auth", "token"], { code: 1 })]);
    refuses(() => prCreate(ctx(runner), PR_ARGS), runner, "no token");
  });

  test("refuses when gh is not on PATH", () => {
    const runner = new FakeRunner([(argv) => (argv[0] === "gh" ? { spawnError: true, code: null } : undefined)]);
    refuses(() => prCreate(ctx(runner), PR_ARGS), runner, "not on PATH");
  });

  test("refuses a head branch that is not on the remote", () => {
    const runner = publishingRepo([on(["gh", "api", `repos/${REPO}/branches/feat/x`], NOT_FOUND)]);
    refuses(() => prCreate(ctx(runner), PR_ARGS), runner, "Push it first");
  });

  test("refuses a body that leaves a pull request template section empty", () => {
    const runner = publishingRepo([
      on(["gh", "api", `repos/${REPO}/contents/.github?ref=main`], { stdout: "pull_request_template.md\n" }),
      on(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/.github/pull_request_template.md?ref=main`], {
        stdout: "## Why\n\n## Testing\n",
      }),
    ]);
    refuses(() => prCreate(ctx(runner), PR_ARGS), runner, "section(s) 2 of 2");
  });
});

describe("pr edit", () => {
  const VIEW = JSON.stringify({
    number: 9,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/x",
    headRefOid: HEAD,
    isCrossRepository: false,
    mergeStateStatus: "CLEAN",
    body: "",
    statusCheckRollup: [],
  });
  const EDIT_ARGS = { repo: REPO, pr: 9, base: "main", title: null, bodyFile: BODY_PATH, closes: [] as number[] };

  test("edits a clean body", () => {
    const runner = publishingRepo([on(["gh", "pr", "view"], { stdout: VIEW })]);
    expect(prEdit(ctx(runner), EDIT_ARGS)).toBe("edited pull request #9");
    expect(runner.publishing()).toEqual([["gh", "pr", "edit", "9", `--repo=${REPO}`, "--body-file=-"]]);
  });

  test("refuses when the pull request's base is not the --base given", () => {
    const runner = publishingRepo([on(["gh", "pr", "view"], { stdout: VIEW })]);
    refuses(() => prEdit(ctx(runner), { ...EDIT_ARGS, base: "release" }), runner, "--base given");
  });

  test("refuses closing keywords on an edit of a pull request into a non-default base", () => {
    const runner = publishingRepo([on(["gh", "pr", "view"], { stdout: VIEW.replace('"baseRefName":"main"', '"baseRefName":"release"') })]);
    refuses(
      () => prEdit(ctx(runner, `${CLEAN_BODY}\nCloses #12\n`), { ...EDIT_ARGS, base: "release", closes: [12] }),
      runner,
      "default branch",
    );
  });

  test("refuses a closing keyword in a title-only edit, which can declare none", () => {
    const runner = publishingRepo([on(["gh", "pr", "view"], { stdout: VIEW })]);
    refuses(() => prEdit(ctx(runner), { ...EDIT_ARGS, title: "Closes #12", bodyFile: null }), runner, "undeclared: 1");
  });

  test("refuses a session link in a new body", () => {
    const link = "https://" + ["claude", "ai"].join(".") + "/code/session_" + "abc";
    const runner = publishingRepo([on(["gh", "pr", "view"], { stdout: VIEW })]);
    refuses(() => prEdit(ctx(runner, `${CLEAN_BODY}\n${link}\n`), EDIT_ARGS), runner, "session link");
  });
});

describe("issue create", () => {
  const ISSUE_ARGS = { repo: REPO, title: "Publish tool", bodyFile: BODY_PATH, template: null };

  test("publishes a clean issue", () => {
    const runner = publishingRepo();
    expect(issueCreate(ctx(runner), ISSUE_ARGS)).toBe(ISSUE_URL);
  });

  test("refuses any closing keyword, since an issue declares none", () => {
    const runner = publishingRepo();
    refuses(() => issueCreate(ctx(runner, `${CLEAN_BODY}\nFixes #3\n`), ISSUE_ARGS), runner, "undeclared: 1");
  });

  test("refuses a blank issue when the repository disables them", () => {
    const runner = publishingRepo([
      on(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/.github/ISSUE_TEMPLATE/config.yml?ref=main`], {
        stdout: "blank_issues_enabled: false\n",
      }),
    ]);
    refuses(() => issueCreate(ctx(runner), ISSUE_ARGS), runner, "disables blank issues");
  });

  test("refuses a body that leaves a named template's section empty", () => {
    const runner = publishingRepo([
      on(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/.github/ISSUE_TEMPLATE/promotion.md?ref=main`], {
        stdout: "---\nname: P\n---\n## Why\n\n## Source\n",
      }),
    ]);
    refuses(() => issueCreate(ctx(runner), { ...ISSUE_ARGS, template: "promotion.md" }), runner, "section(s) 2 of 2");
  });
});

describe("issue edit", () => {
  test("refuses an attribution line in a new body", () => {
    const runner = publishingRepo();
    refuses(
      () => issueEdit(ctx(runner, `${CLEAN_BODY}\nClaude-Session: x\n`), { repo: REPO, issue: 3, title: null, bodyFile: BODY_PATH, template: null }),
      runner,
      "Claude-Session line",
    );
  });

  test("edits a title alone", () => {
    const runner = publishingRepo();
    expect(issueEdit(ctx(runner), { repo: REPO, issue: 3, title: "New title", bodyFile: null, template: null })).toBe("edited issue #3");
    expect(runner.publishing()).toEqual([["gh", "issue", "edit", "3", `--repo=${REPO}`, "--title=New title"]]);
  });
});
