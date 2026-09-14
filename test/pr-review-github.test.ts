// Tests for tools/pr-review/github.ts against a fake GitHub. What matters: trusted context is read at
// the base SHA and post-change content at the head SHA; a fork, or a pull request into any branch but
// the default, is refused; a changed-file listing shorter than GitHub's own count is marked
// incomplete; the linked issue carries only the repository owner's comments; one token serves the
// whole run; the diff and check-run listing are pinned to the reviewed commits rather than to
// whatever the head happens to be at each call; and the review is posted pinned to the reviewed
// commit, with GitHub's own response checked before it is trusted.

import { describe, expect, test } from "bun:test";
import { GitHubClient, MAX_FILE_PAGES } from "../tools/pr-review/github";
import { MAX_HEAD_FILE_FETCHES, RefusalError, type TokenMinter } from "../tools/pr-review/types";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const REQUIRED_CHECK_NAME = "bun test (TypeScript hook suite)";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type FileEntry = { filename: string; previous_filename?: string; status?: string };

const PAGE1: FileEntry[] = [
  ...Array.from({ length: 99 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified" })),
  { filename: "docs/new.md", previous_filename: "docs/old.md", status: "renamed" },
];
const PAGE2: FileEntry[] = [
  { filename: "gone.ts", status: "removed" },
  { filename: "src/a.ts", status: "modified" },
];

const pullWith = (overrides: Record<string, unknown> = {}) => ({
  state: "open",
  title: "T",
  body: "Closes #98.\nCloses #5.",
  changed_files: 102,
  head: { sha: HEAD, repo: { full_name: "owner/name" } },
  base: { sha: BASE, ref: "master" },
  ...overrides,
});

type CheckRunEntry = { name: string; appSlug: string; status: string; conclusion: string | null; headSha?: string };

const DEFAULT_CHECK_RUN_PAGES: CheckRunEntry[][] = [[{ name: REQUIRED_CHECK_NAME, appSlug: "github-actions", status: "completed", conclusion: "success" }]];

interface FakeOptions {
  pull?: Record<string, unknown>;
  pullSecondRead?: Record<string, unknown>;
  pages?: FileEntry[][];
  defaultBranch?: string;
  diffStatus?: number;
  compareDiffText?: string;
  postStatus?: number;
  checkRunPages?: CheckRunEntry[][];
  checkRunTotalCount?: number;
}

function fakeGitHub(options: FakeOptions = {}) {
  const pull = options.pull ?? pullWith();
  const pages = options.pages ?? [PAGE1, PAGE2];
  const checkRunPages = options.checkRunPages ?? DEFAULT_CHECK_RUN_PAGES;
  const calls: Array<{ method: string; url: URL; headers: Headers; body: string | null; redirect: RequestRedirect | undefined }> = [];
  let pullReads = 0;

  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    calls.push({ method, url, headers, body: typeof init.body === "string" ? init.body : null, redirect: init.redirect });
    const path = url.pathname;
    const prefix = "/repos/owner/name";

    if (path === prefix && method === "GET") return json({ default_branch: options.defaultBranch ?? "master" });
    if (path === `${prefix}/pulls/7` && method === "GET") {
      pullReads++;
      if (pullReads === 2 && options.pullSecondRead) return json(options.pullSecondRead);
      return json(pull);
    }
    if (path === `${prefix}/compare/${BASE}...${HEAD}` && method === "GET") {
      const status = options.diffStatus ?? 200;
      return status === 200 ? new Response(options.compareDiffText ?? "diff --git a/src/a.ts b/src/a.ts\n") : json({ message: "too large" }, status);
    }
    if (path === `${prefix}/pulls/7/files`) return json(pages[Number(url.searchParams.get("page")) - 1] ?? []);
    if (path === `${prefix}/pulls/7/commits`) return json([{ commit: { message: "m1" } }, { commit: { message: "m2" } }]);
    if (path.startsWith(`${prefix}/contents/`)) {
      const file = path.slice(`${prefix}/contents/`.length).split("/").map(decodeURIComponent).join("/");
      const ref = url.searchParams.get("ref");
      if (ref === BASE && file === "CONTRIBUTING.md") return new Response("BASE CONTRIBUTING");
      if (ref === BASE && file === ".github/workflows/test.yml") return new Response("jobs:\n");
      if (ref === HEAD && file !== "docs/old.md") return new Response(`HEAD ${file}`);
      return json({ message: "Not Found" }, 404);
    }
    if (path === `${prefix}/issues/98`) return json({ title: "Issue 98", body: "issue body" });
    if (path === `${prefix}/issues/98/comments`) {
      return json([
        { author_association: "OWNER", created_at: "2026-09-10T00:00:00Z", body: "owner ruling" },
        { author_association: "NONE", created_at: "2026-09-10T01:00:00Z", body: "drive-by instruction" },
      ]);
    }
    if (path === `${prefix}/issues/5`) return json({ title: "a pull request", body: "x", pull_request: {} });
    if (path === `${prefix}/commits/${HEAD}/check-runs`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const entries = checkRunPages[page - 1] ?? [];
      const totalCount = options.checkRunTotalCount ?? checkRunPages.flat().length;
      return json({
        total_count: totalCount,
        check_runs: entries.map((run) => ({
          name: run.name,
          app: { slug: run.appSlug },
          status: run.status,
          conclusion: run.conclusion,
          head_sha: run.headSha ?? HEAD,
        })),
      });
    }
    if (path === `${prefix}/pulls/7/reviews` && method === "POST") {
      const status = options.postStatus ?? 200;
      if (status !== 200) return json({ message: "Can not approve your own pull request" }, status);
      const requestBody = JSON.parse(typeof init.body === "string" ? init.body : "{}") as { commit_id?: unknown; event?: unknown };
      const stateByEvent: Record<string, string> = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };
      return json({
        id: 99,
        html_url: "https://github.com/owner/name/pull/7#pullrequestreview-99",
        commit_id: requestBody.commit_id,
        state: stateByEvent[String(requestBody.event)],
      });
    }
    return json({ message: "Not Found" }, 404);
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function countingMinter() {
  const minter = {
    mints: 0,
    async mint() {
      minter.mints++;
      return { token: "ghs_fixture", expiresAt: "2026-09-11T00:00:00Z" };
    },
  };
  return minter as TokenMinter & { mints: number };
}

const client = (fake: ReturnType<typeof fakeGitHub>, minter = countingMinter()) =>
  new GitHubClient({ repo: "owner/name", pr: 7, minter, fetchImpl: fake.impl });

describe("GitHubClient.snapshot()", () => {
  test("assembles the pull request, following file pagination and renames", async () => {
    const snap = await client(fakeGitHub()).snapshot();
    expect(snap.repo).toBe("owner/name");
    expect(snap.number).toBe(7);
    expect(snap.baseSha).toBe(BASE);
    expect(snap.headSha).toBe(HEAD);
    expect(snap.isOpen).toBe(true);
    expect(snap.diff).toBe("diff --git a/src/a.ts b/src/a.ts\n");
    expect(snap.changedFiles.length).toBe(103);
    expect(snap.changedFiles).toEqual(expect.arrayContaining(["docs/new.md", "docs/old.md", "gone.ts", "src/a.ts"]));
    expect(snap.commitMessages).toEqual(["m1", "m2"]);
  });

  test("a listing that matches GitHub's changed_files count is complete", async () => {
    expect((await client(fakeGitHub()).snapshot()).changedFilesComplete).toBe(true);
  });

  test("a listing that stops at the page ceiling short of changed_files is incomplete", async () => {
    const full = Array.from({ length: MAX_FILE_PAGES }, (_, p) =>
      Array.from({ length: 100 }, (_, i) => ({ filename: `bulk/p${p}-f${i}.ts`, status: "modified" })),
    );
    const snap = await client(fakeGitHub({ pages: full, pull: pullWith({ changed_files: 3001 }) })).snapshot();
    expect(snap.changedFiles.length).toBe(3000);
    expect(snap.changedFilesComplete).toBe(false);
  });

  test("a pull request with no changed_files count is incomplete", async () => {
    const pull = pullWith();
    delete (pull as Record<string, unknown>).changed_files;
    expect((await client(fakeGitHub({ pull })).snapshot()).changedFilesComplete).toBe(false);
  });

  test("reads trusted context and the workflow at the base SHA", async () => {
    const snap = await client(fakeGitHub()).snapshot();
    expect(snap.trustedContext).toEqual([{ path: "CONTRIBUTING.md", content: "BASE CONTRIBUTING" }]);
    expect(snap.workflowText).toBe("jobs:\n");
  });

  test("reads post-change content at the head SHA, skips removed files, and stops at the fetch cap", async () => {
    const fake = fakeGitHub();
    const snap = await client(fake).snapshot();
    const headFetches = fake.calls.filter((c) => c.url.pathname.includes("/contents/") && c.url.searchParams.get("ref") === HEAD);
    expect(headFetches.length).toBe(MAX_HEAD_FILE_FETCHES);
    expect(headFetches.some((c) => c.url.pathname.endsWith("/gone.ts"))).toBe(false);
    expect(snap.headFiles.every((f) => f.content === `HEAD ${f.path}`)).toBe(true);
    expect(snap.omittedFiles).toContain("src/a.ts");
  });

  test("includes the linked issue with the owner's comments only, and skips a linked pull request", async () => {
    const snap = await client(fakeGitHub()).snapshot();
    expect(snap.linkedIssues.map((i) => i.number)).toEqual([98]);
    expect(snap.linkedIssues[0]!.body).toContain("owner ruling");
    expect(snap.linkedIssues[0]!.body).not.toContain("drive-by instruction");
  });

  test("maps check runs with their app slug", async () => {
    const snap = await client(fakeGitHub()).snapshot();
    expect(snap.checkRuns).toEqual([{ name: REQUIRED_CHECK_NAME, appSlug: "github-actions", status: "completed", conclusion: "success" }]);
  });

  test("an unavailable diff becomes null rather than an empty review", async () => {
    expect((await client(fakeGitHub({ diffStatus: 406 })).snapshot()).diff).toBeNull();
  });

  test.each([
    ["a fork", { full_name: "someone/fork" }],
    ["a deleted head repository", null],
  ])("refuses %s", async (_label, repo) => {
    const pull = pullWith({ head: { sha: HEAD, repo } });
    const attempt = client(fakeGitHub({ pull })).snapshot();
    await expect(attempt).rejects.toThrow("fork");
    await expect(attempt).rejects.toBeInstanceOf(RefusalError);
  });

  test("refuses a pull request into a branch other than the default", async () => {
    const pull = pullWith({ base: { sha: BASE, ref: "release" } });
    const attempt = client(fakeGitHub({ pull })).snapshot();
    await expect(attempt).rejects.toThrow("default branch");
    await expect(attempt).rejects.toBeInstanceOf(RefusalError);
  });

  test("refuses a malformed SHA", async () => {
    const pull = pullWith({ head: { sha: "abc", repo: { full_name: "owner/name" } } });
    await expect(client(fakeGitHub({ pull })).snapshot()).rejects.toThrow();
  });

  // A11.2 (1/2): the diff is fetched from the compare API, pinned to the two SHAs already read,
  // never from the pull request's own diff view, which describes whatever the head is at the
  // moment of the call.
  test("fetches the diff from the compare API, pinned to the base and head SHAs, not the pull request's own moving diff view", async () => {
    const fake = fakeGitHub({ compareDiffText: "PINNED" });
    const snap = await client(fake).snapshot();
    expect(snap.diff).toBe("PINNED");
    expect(fake.calls.some((c) => c.url.pathname === `/repos/owner/name/pulls/7` && c.headers.get("Accept") === "application/vnd.github.diff")).toBe(
      false,
    );
    const compareCall = fake.calls.find((c) => c.url.pathname === `/repos/owner/name/compare/${BASE}...${HEAD}`);
    expect(compareCall).toBeDefined();
    expect(compareCall!.headers.get("Accept")).toBe("application/vnd.github.diff");
  });

  // A11.2 (2/2): a push between the file listing and this re-check moved the pull request's head
  // out from under the diff and file listing already read.
  test("refuses when the pull request's head moved between the file listing and the re-check", async () => {
    const fake = fakeGitHub({ pullSecondRead: pullWith({ head: { sha: "3".repeat(40), repo: { full_name: "owner/name" } } }) });
    const attempt = client(fake).snapshot();
    await expect(attempt).rejects.toThrow(/changed while this review was reading/);
    await expect(attempt).rejects.toBeInstanceOf(RefusalError);
  });

  test("refuses when changed_files disagrees between the first read and the re-check", async () => {
    const fake = fakeGitHub({ pullSecondRead: pullWith({ changed_files: 999 }) });
    await expect(client(fake).snapshot()).rejects.toBeInstanceOf(RefusalError);
  });

  // A11.3: every run sharing the required check's name and app is collected across pages, verified
  // against the head SHA, and a failure on a later page must not hide behind a success on an
  // earlier one (the same reasoning as verdict.ts's own "every run counts" rule).
  test("pages the check-run listing to GitHub's total_count, and a failure on a later page fails verification", async () => {
    const filler = Array.from({ length: 99 }, (_, i) => ({ name: `filler-${i}`, appSlug: "github-actions", status: "completed", conclusion: "success" }));
    const page1: CheckRunEntry[] = [...filler, { name: REQUIRED_CHECK_NAME, appSlug: "github-actions", status: "completed", conclusion: "success" }];
    const page2: CheckRunEntry[] = [{ name: REQUIRED_CHECK_NAME, appSlug: "github-actions", status: "completed", conclusion: "failure" }];
    const fake = fakeGitHub({ checkRunPages: [page1, page2], checkRunTotalCount: 101 });
    const snap = await client(fake).snapshot();
    expect(snap.checkRuns.length).toBe(101);
    const { verificationOf } = await import("../tools/pr-review/verdict");
    expect(verificationOf(snap).state).toBe("failed");
  });

  test("sends filter=latest explicitly on the check-run listing", async () => {
    const fake = fakeGitHub();
    await client(fake).snapshot();
    const checkCall = fake.calls.find((c) => c.url.pathname === `/repos/owner/name/commits/${HEAD}/check-runs`);
    expect(checkCall!.url.searchParams.get("filter")).toBe("latest");
  });

  test("refuses a check-run listing with no total_count", async () => {
    const fake = fakeGitHub({ checkRunTotalCount: Number.NaN });
    await expect(client(fake).snapshot()).rejects.toThrow(/total_count/);
  });

  test("refuses a check-run listing that never reaches GitHub's own total_count within the page cap", async () => {
    const onePage = [{ name: REQUIRED_CHECK_NAME, appSlug: "github-actions", status: "completed", conclusion: "success" }];
    const fake = fakeGitHub({ checkRunPages: [onePage], checkRunTotalCount: 5000 });
    await expect(client(fake).snapshot()).rejects.toThrow(/total_count/);
  });

  test("refuses a check run whose head_sha names a different commit", async () => {
    const fake = fakeGitHub({
      checkRunPages: [[{ name: REQUIRED_CHECK_NAME, appSlug: "github-actions", status: "completed", conclusion: "success", headSha: "9".repeat(40) }]],
    });
    await expect(client(fake).snapshot()).rejects.toThrow(/commit other than/);
  });
});

describe("GitHubClient as a poster", () => {
  test("one token serves snapshot, head check and post, on every request", async () => {
    const fake = fakeGitHub();
    const minter = countingMinter();
    const github = client(fake, minter);
    await github.snapshot();
    await github.currentHeadSha();
    await github.postReview({ commitId: HEAD, event: "APPROVE", body: "b" });
    expect(minter.mints).toBe(1);
    expect(fake.calls.every((c) => c.headers.get("Authorization") === "Bearer ghs_fixture")).toBe(true);
    expect(fake.calls.every((c) => c.headers.get("X-GitHub-Api-Version") === "2022-11-28")).toBe(true);
  });

  test("every GitHub request is made with redirect: error", async () => {
    // A10.6, extended to github.ts: every request carries the installation token, so it fails
    // closed on a redirect rather than risking that header on a target this tool never chose.
    const fake = fakeGitHub();
    await client(fake).snapshot();
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) expect(call.redirect).toBe("error");
  });

  test("posts exactly commit_id, event and body", async () => {
    const fake = fakeGitHub();
    const posted = await client(fake).postReview({ commitId: HEAD, event: "REQUEST_CHANGES", body: "the body" });
    expect(posted).toEqual({ id: 99, htmlUrl: "https://github.com/owner/name/pull/7#pullrequestreview-99" });
    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.body!)).toEqual({ commit_id: HEAD, event: "REQUEST_CHANGES", body: "the body" });
  });

  test("a rejected post names the status and GitHub's message, never the token", async () => {
    const error = (await client(fakeGitHub({ postStatus: 422 })).postReview({ commitId: HEAD, event: "APPROVE", body: "b" }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("422");
    expect(error.message).toContain("Can not approve your own pull request");
    expect(error.message).not.toContain("ghs_fixture");
  });

  test("currentHeadSha reads the head SHA", async () => {
    expect(await client(fakeGitHub()).currentHeadSha()).toBe(HEAD);
  });

  // A11.4: a 2xx with a missing or mismatched shape read as posted before this check.
  test("refuses a posted-review response missing an integer id or an html_url", async () => {
    const fake = fakeGitHub();
    // Override the reviews route to omit html_url.
    const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/owner/name/pulls/7/reviews" && (init.method ?? "GET") === "POST") {
        return json({ id: 99 });
      }
      return fake.impl(input, init);
    }) as unknown as typeof fetch;
    await expect(client({ impl, calls: fake.calls }).postReview({ commitId: HEAD, event: "APPROVE", body: "b" })).rejects.toThrow(/html_url/);
  });

  test("refuses a posted-review response whose state does not match the posted event", async () => {
    const fake = fakeGitHub();
    const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/owner/name/pulls/7/reviews" && (init.method ?? "GET") === "POST") {
        return json({ id: 99, html_url: "https://github.com/owner/name/pull/7#pullrequestreview-99", commit_id: HEAD, state: "PENDING" });
      }
      return fake.impl(input, init);
    }) as unknown as typeof fetch;
    await expect(client({ impl, calls: fake.calls }).postReview({ commitId: HEAD, event: "APPROVE", body: "b" })).rejects.toThrow(/state/);
  });

  test("refuses a posted-review response naming a different commit than the one posted", async () => {
    const fake = fakeGitHub();
    const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/owner/name/pulls/7/reviews" && (init.method ?? "GET") === "POST") {
        return json({ id: 99, html_url: "https://github.com/owner/name/pull/7#pullrequestreview-99", commit_id: "9".repeat(40), state: "APPROVED" });
      }
      return fake.impl(input, init);
    }) as unknown as typeof fetch;
    await expect(client({ impl, calls: fake.calls }).postReview({ commitId: HEAD, event: "APPROVE", body: "b" })).rejects.toThrow(/commit/);
  });

  test.each([
    ["owner/name/extra", 7],
    ["owner/name", 0],
    ["../name", 7],
  ] as const)("the constructor refuses repo %p pr %p", (repo, pr) => {
    expect(() => new GitHubClient({ repo, pr, minter: countingMinter(), fetchImpl: fakeGitHub().impl })).toThrow();
  });
});
