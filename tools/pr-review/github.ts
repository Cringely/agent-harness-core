// The live PrSource and ReviewPoster, over the GitHub REST API with the App's installation token.
// One token is minted on first use and serves the whole run; it lives in this object and nowhere else.
//
// Refused outright, before any review: a pull request from a fork (its author has no write access
// here and the review of an outside contribution stays a human's call), and a pull request into any
// branch but the repository's default (its base commit is where trusted context comes from, and only
// the default branch's history is trusted). Both throw RefusalError, the same class every other
// deliberate refusal in this tool throws, so cli.ts's exitCodeFor can tell "the tool refused on
// purpose" from "the tool broke" without inspecting a message string.
//
// A pull request's own diff and file listing describe whatever its head happens to be at the moment
// of each call, not the two commits this snapshot is pinned to. A push between the calls below would
// otherwise let one commit's diff sit beside another commit's file listing and check runs, with the
// review then posted pinned to the first. The diff is fetched from the compare API against the exact
// base and head SHAs already read, and the pull request is re-read once more after the file listing
// and commits to confirm its head has not moved and its changed_files count has not changed. This
// narrows the window; it does not close it. pipeline.ts's own head re-check, immediately before
// posting, is what catches a push landing after this function returns.

import { GITHUB_API, githubHeaders } from "./app-auth";
import { linkedIssueNumbers, selectHeadFiles } from "./snapshot";
import {
  LIVING_DOC_PATHS,
  MAX_HEAD_FILE_FETCHES,
  RefusalError,
  SHA_RE,
  TRUSTED_CONTEXT_PATHS,
  WORKFLOW_PATH,
  parseRepo,
  type CheckRun,
  type FileText,
  type InstallationToken,
  type IssueText,
  type PostedReview,
  type PrSnapshot,
  type PrSource,
  type ReviewEvent,
  type ReviewPoster,
  type TokenMinter,
} from "./types";

const PER_PAGE = 100;
// GitHub lists at most 3,000 files for a pull request, 100 per page.
export const MAX_FILE_PAGES = 30;
// GitHub docs cap a single ref's check-run listing at what fits this many pages: past it, a
// listing that never reaches its own reported total_count is a defect this tool refuses on rather
// than one it silently trusts a partial page for.
const MAX_CHECK_RUN_PAGES = 10;

const EXPECTED_REVIEW_STATE: Readonly<Record<ReviewEvent, string>> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};

interface PullData {
  state?: string;
  title?: string | null;
  body?: string | null;
  changed_files?: number;
  head?: { sha?: string; repo?: { full_name?: string } | null };
  base?: { sha?: string; ref?: string };
}

interface FileData {
  filename: string;
  previous_filename?: string;
  status?: string;
}

interface CheckRunPage {
  total_count?: unknown;
  check_runs?: Array<{ name: string; app?: { slug?: string } | null; status: string; conclusion?: string | null; head_sha?: string }>;
}

async function describeFailure(method: string, path: string, response: Response): Promise<string> {
  let message = "";
  try {
    const data = (await response.json()) as { message?: unknown };
    if (typeof data.message === "string") message = `: ${data.message.slice(0, 200)}`;
  } catch {
    // Not JSON; the status says enough.
  }
  return `GitHub ${method} ${path} returned ${response.status}${message}`;
}

const contentsPath = (repo: string, path: string, ref: string) =>
  `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`;

export class GitHubClient implements PrSource, ReviewPoster {
  private token: InstallationToken | null = null;
  private readonly fetchImpl: typeof fetch;
  // R11-2: the base this review was pinned to at snapshot time. currentHeadSha() re-checks these
  // alongside the head SHA, immediately before posting: minutes can pass between the model run and
  // the post, and retargeting a pull request to another base needs no new commit, so a head-only
  // check let an approval computed against the old base's diff post pinned to a commit whose actual
  // base had already changed.
  private baseline: { baseRef: string; baseSha: string; changedFiles: number | undefined } | null = null;

  constructor(private readonly options: { repo: string; pr: number; minter: TokenMinter; fetchImpl?: typeof fetch }) {
    if (parseRepo(options.repo) === null) throw new Error("the repository must be given as owner/name");
    if (!Number.isInteger(options.pr) || options.pr < 1) throw new Error("the pull request number must be a positive integer");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(method: "GET" | "POST", path: string, accept: string, body?: unknown): Promise<Response> {
    if (this.token === null) this.token = await this.options.minter.mint();
    const headers = { ...githubHeaders(`Bearer ${this.token.token}`), Accept: accept };
    return this.fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A10.6, extended here: every request carries the installation token, so it fails closed on
      // any redirect (same reasoning as app-auth.ts's JWT- and token-bearing calls) rather than
      // risking the Authorization header on a redirect target this tool never chose.
      redirect: "error",
    });
  }

  private async json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, "application/vnd.github+json", body);
    if (!response.ok) throw new Error(await describeFailure(method, path, response));
    return (await response.json()) as T;
  }

  private async rawOrNull(path: string): Promise<string | null> {
    const response = await this.request("GET", path, "application/vnd.github.raw+json");
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await describeFailure("GET", path, response));
    return response.text();
  }

  // A11.3: pages while the running total is short of GitHub's own total_count, up to
  // MAX_CHECK_RUN_PAGES. Every run sharing a required check's name and app is what verdict.ts
  // counts (I5), so a listing that stopped after one page could hide a failing run on a later one;
  // and a run is trusted only once its own head_sha confirms it belongs to the commit under review,
  // rather than to this repository's check-runs endpoint in general.
  private async fetchCheckRuns(repo: string, headSha: string): Promise<CheckRun[]> {
    const collected: CheckRun[] = [];
    let totalCount: number | null = null;
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page++) {
      const data = await this.json<CheckRunPage>(
        "GET",
        `/repos/${repo}/commits/${headSha}/check-runs?per_page=${PER_PAGE}&page=${page}&filter=latest`,
      );
      if (typeof data.total_count !== "number" || !Number.isInteger(data.total_count)) {
        throw new Error("GitHub returned no total_count for the check-run listing");
      }
      totalCount = data.total_count;
      const runs = data.check_runs ?? [];
      for (const run of runs) {
        if (run.head_sha !== headSha) throw new Error("GitHub returned a check run for a commit other than the one under review");
        collected.push({ name: run.name, appSlug: run.app?.slug ?? "", status: run.status, conclusion: run.conclusion ?? null });
      }
      if (collected.length >= totalCount || runs.length === 0) break;
    }
    if (totalCount === null || collected.length < totalCount) {
      throw new Error("GitHub's check-run listing never reached its own reported total_count");
    }
    return collected;
  }

  async snapshot(): Promise<PrSnapshot> {
    const { repo, pr } = this.options;
    const pull = await this.json<PullData>("GET", `/repos/${repo}/pulls/${pr}`);
    const headSha = pull.head?.sha;
    const baseSha = pull.base?.sha;
    if (typeof headSha !== "string" || !SHA_RE.test(headSha) || typeof baseSha !== "string" || !SHA_RE.test(baseSha)) {
      throw new Error("GitHub returned a pull request without valid base and head SHAs");
    }
    if (pull.head?.repo?.full_name !== repo) {
      throw new RefusalError("the pull request comes from a fork or a deleted repository; this tool reviews branches of the repository itself");
    }
    const repository = await this.json<{ default_branch?: string }>("GET", `/repos/${repo}`);
    if (typeof repository.default_branch !== "string" || pull.base?.ref !== repository.default_branch) {
      throw new RefusalError("the pull request does not target the repository's default branch; this tool reviews pull requests into it only");
    }
    // R11-2: recorded once the base has passed the default-branch check, so currentHeadSha() has
    // something to compare a later read against.
    this.baseline = { baseRef: repository.default_branch, baseSha, changedFiles: pull.changed_files };

    // A11.2 (1/2): pinned to these exact commits via compare, not the pull request's own moving
    // diff view.
    const diffResponse = await this.request("GET", `/repos/${repo}/compare/${baseSha}...${headSha}`, "application/vnd.github.diff");
    const diff = diffResponse.ok ? await diffResponse.text() : null;

    const changedFiles: string[] = [];
    const removed = new Set<string>();
    let listed = 0;
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const files = await this.json<FileData[]>("GET", `/repos/${repo}/pulls/${pr}/files?per_page=${PER_PAGE}&page=${page}`);
      for (const file of files) {
        listed++;
        changedFiles.push(file.filename);
        if (typeof file.previous_filename === "string") changedFiles.push(file.previous_filename);
        if (file.status === "removed") removed.add(file.filename);
      }
      if (files.length < PER_PAGE) break;
    }
    // GitHub reports the true number of changed files beside a listing capped at 3,000. A listing
    // short of that count left files unseen, and one of them could be a workflow edit or an uncovered
    // .ps1, so the review may reject on what it saw but may not approve.
    const changedFilesComplete = Number.isInteger(pull.changed_files) && listed === pull.changed_files;

    // The first page of commits only: messages are context, and a pull request with more than a
    // hundred commits is reviewed on its diff.
    const commits = await this.json<Array<{ commit?: { message?: string } }>>("GET", `/repos/${repo}/pulls/${pr}/commits?per_page=${PER_PAGE}`);
    const commitMessages = commits.map((c) => c.commit?.message ?? "").filter((message) => message !== "");

    // A11.2 (2/2): a push away and back between the first read above and here would leave the diff
    // and file listing pinned to a commit GitHub no longer calls this pull request's head. Refusing
    // here does not close that window (a push after this point, before the eventual post, is still
    // possible; pipeline.ts's own re-check at post time narrows that one), but it catches a push
    // that happened during the listing itself.
    const recheck = await this.json<PullData>("GET", `/repos/${repo}/pulls/${pr}`);
    if (recheck.head?.sha !== headSha || recheck.changed_files !== pull.changed_files) {
      throw new RefusalError("the pull request changed while this review was reading it; nothing was posted, so run the review again");
    }

    const candidates: FileText[] = [];
    const beyondFetchCap: string[] = [];
    let fetches = 0;
    for (const path of changedFiles) {
      if (removed.has(path)) continue;
      if (fetches >= MAX_HEAD_FILE_FETCHES) {
        beyondFetchCap.push(path);
        continue;
      }
      fetches++;
      const content = await this.rawOrNull(contentsPath(repo, path, headSha));
      if (content !== null) candidates.push({ path, content });
    }
    const { headFiles, omittedFiles } = selectHeadFiles(candidates);

    const linkedIssues: IssueText[] = [];
    for (const number of linkedIssueNumbers(pull.body ?? "")) {
      const response = await this.request("GET", `/repos/${repo}/issues/${number}`, "application/vnd.github+json");
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(await describeFailure("GET", `/repos/${repo}/issues/${number}`, response));
      const issue = (await response.json()) as { title?: string; body?: string | null; pull_request?: unknown };
      if (issue.pull_request !== undefined) continue;
      const comments = await this.json<Array<{ author_association?: string; created_at?: string; body?: string | null }>>(
        "GET",
        `/repos/${repo}/issues/${number}/comments?per_page=${PER_PAGE}`,
      );
      const ownerComments = comments
        .filter((comment) => comment.author_association === "OWNER")
        .map((comment) => `--- comment by the repository owner, ${comment.created_at ?? "undated"}\n${comment.body ?? ""}`);
      linkedIssues.push({ number, title: issue.title ?? "", body: [issue.body ?? "", ...ownerComments].join("\n\n") });
    }

    const trustedContext: FileText[] = [];
    for (const path of TRUSTED_CONTEXT_PATHS) {
      const content = await this.rawOrNull(contentsPath(repo, path, baseSha));
      if (content !== null) trustedContext.push({ path, content });
    }
    const livingDocs: FileText[] = [];
    for (const path of LIVING_DOC_PATHS) {
      const content = await this.rawOrNull(contentsPath(repo, path, baseSha));
      if (content !== null) livingDocs.push({ path, content });
    }
    const workflowText = await this.rawOrNull(contentsPath(repo, WORKFLOW_PATH, baseSha));

    const checkRuns = await this.fetchCheckRuns(repo, headSha);

    return {
      repo,
      number: pr,
      title: pull.title ?? "",
      body: pull.body ?? "",
      baseSha,
      headSha,
      isOpen: pull.state === "open",
      diff,
      changedFiles,
      changedFilesComplete,
      commitMessages,
      headFiles,
      omittedFiles: [...omittedFiles, ...beyondFetchCap],
      linkedIssues,
      trustedContext,
      livingDocs,
      workflowText,
      checkRuns,
    };
  }

  async currentHeadSha(): Promise<string> {
    const pull = await this.json<PullData>("GET", `/repos/${this.options.repo}/pulls/${this.options.pr}`);
    if (this.baseline !== null) {
      // R11-2: a pull request retargeted to a different base, or whose base moved, between the
      // snapshot and this call (called immediately before posting) means the diff the model saw is
      // no longer this pull request's diff against its actual base.
      if (
        pull.base?.ref !== this.baseline.baseRef ||
        pull.base?.sha !== this.baseline.baseSha ||
        pull.changed_files !== this.baseline.changedFiles
      ) {
        throw new RefusalError("the pull request's base changed after it was reviewed; nothing was posted, so run the review again");
      }
    }
    return pull.head?.sha ?? "";
  }

  async postReview(input: { commitId: string; event: ReviewEvent; body: string }): Promise<PostedReview> {
    const data = await this.json<{ id?: unknown; html_url?: unknown; commit_id?: unknown; state?: unknown }>(
      "POST",
      `/repos/${this.options.repo}/pulls/${this.options.pr}/reviews`,
      { commit_id: input.commitId, event: input.event, body: input.body },
    );
    // A11.4: a 2xx with a missing or mismatched shape read as posted before this check (id and
    // html_url undefined, and Task 14 would then read a review with no real id). The response's own
    // commit_id and state are compared against what was requested rather than trusted to match.
    const problems: string[] = [];
    if (!Number.isInteger(data.id)) problems.push("carried no integer id");
    if (typeof data.html_url !== "string") problems.push("carried no html_url");
    if (data.commit_id !== input.commitId) problems.push("names a different commit than the one posted");
    if (data.state !== EXPECTED_REVIEW_STATE[input.event]) problems.push("names a different state than the event that was posted");
    if (problems.length > 0) {
      // R11-3: GitHub already accepted this POST (a 2xx) by the time any check above can run, so a
      // validation failure here means a review now exists that this run cannot fully describe, not
      // that nothing happened. A blind retry would double-post. The id and html_url are named
      // whenever the response carried something recognisable as one, so the operator can find and
      // dismiss the review by hand instead of guessing from a bare validation error; the top-level
      // handler prints this message through the same control-character strip as every other error
      // (cli.ts), so nothing further is sanitized here.
      const id = Number.isInteger(data.id) ? String(data.id) : "unknown";
      const url = typeof data.html_url === "string" ? data.html_url : "unknown";
      throw new Error(
        `GitHub accepted this review post, but its response is invalid (${problems.join("; ")}). ` +
          `A review may already exist on this pull request (id=${id}, url=${url}); check it before running this again.`,
      );
    }
    return { id: data.id as number, htmlUrl: data.html_url as string };
  }
}
