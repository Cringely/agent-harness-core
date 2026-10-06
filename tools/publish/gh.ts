// Every gh call tools/publish makes (#274), each under the configured account's own token.
//
// Gh.forUser reads that token with `gh auth token -u <ghUser>` and passes it to each later call as
// GH_TOKEN in the child's environment only. It is never printed, logged or put on a command line,
// and the active gh account is never consulted or switched. gh missing from PATH, or holding no
// token for the account, is a refusal.
//
// Read failures are PublishError (exit 1). A 404 on a lookup that can legitimately be absent (a
// template, a branch) is reported as null instead. Titles and bodies go to gh as `--title=<value>`
// and on stdin through `--body-file -`, so a value starting with "-" is never read as a flag and a
// body is never written to a temp file between the scan and the publish.

import { SHA_RE } from "../pr-review/types";
import { PublishError, PublishRefusal } from "./errors";
import { childEnv, type RunResult, type Runner } from "./exec";

export interface CheckEntry {
  kind: "CheckRun" | "StatusContext";
  name: string;
  status: string;
  conclusion: string;
}

export interface PrState {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  mergeStateStatus: string;
  title: string;
  body: string;
  checks: CheckEntry[];
}

const PR_FIELDS = "number,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,mergeStateStatus,title,body,statusCheckRollup";
const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const ISSUE_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/;
const NOT_FOUND_RE = /HTTP 404/;
export const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return lines[lines.length - 1]!.trim();
}

export class Gh {
  private constructor(
    private readonly runner: Runner,
    private readonly env: Record<string, string>,
  ) {}

  static forUser(runner: Runner, ghUser: string, base: Record<string, string | undefined>): Gh {
    const probe = runner.run(["gh", "auth", "token", "-u", ghUser], { env: childEnv(base) });
    if (probe.spawnError) throw new PublishRefusal("gh is not on PATH");
    const token = probe.stdout.trim();
    if (probe.code !== 0 || token === "" || /\s/.test(token)) {
      throw new PublishRefusal("gh holds no token for the account the publish config names");
    }
    return new Gh(runner, childEnv(base, { GH_TOKEN: token, GH_PROMPT_DISABLED: "1" }));
  }

  // review-merge.ts hands this to git's credential helper through the child environment.
  get token(): string {
    return this.env.GH_TOKEN!;
  }

  call(args: readonly string[], options: { stdin?: string; timeoutMs?: number } = {}): RunResult {
    const result = this.runner.run(["gh", ...args], { env: this.env, stdin: options.stdin, timeoutMs: options.timeoutMs });
    if (result.spawnError) throw new PublishRefusal("gh is not on PATH");
    return result;
  }

  private ok(args: readonly string[], what: string, stdin?: string): string {
    const result = this.call(args, { stdin });
    if (result.code !== 0) throw new PublishError(`gh failed while ${what}`);
    return result.stdout;
  }

  defaultBranch(repo: string): string {
    const branch = this.ok(["api", `repos/${repo}`, "--jq", ".default_branch"], "reading the default branch").trim();
    if (!BRANCH_RE.test(branch)) throw new PublishError("gh returned an unusable default branch name");
    return branch;
  }

  // The branch goes into the API path as written (GitHub's branches endpoint takes a name with
  // slashes), so it is held to the same character set as a default branch name first.
  branchHead(repo: string, branch: string): string | null {
    if (!BRANCH_RE.test(branch) || branch.includes("..")) throw new PublishRefusal("a branch name holds characters this tool does not accept");
    const result = this.call(["api", `repos/${repo}/branches/${branch}`, "--jq", ".commit.sha"]);
    if (result.code !== 0) {
      if (NOT_FOUND_RE.test(result.stderr)) return null;
      throw new PublishError("gh failed while reading a branch");
    }
    const sha = result.stdout.trim();
    if (!SHA_RE.test(sha)) throw new PublishError("gh returned an unusable branch head");
    return sha;
  }

  fileAt(repo: string, path: string, ref: string): string | null {
    const result = this.call(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`]);
    if (result.code !== 0) {
      if (NOT_FOUND_RE.test(result.stderr)) return null;
      throw new PublishError("gh failed while reading a template file");
    }
    return result.stdout;
  }

  listFiles(repo: string, dir: string, ref: string): string[] | null {
    const path = dir === "" ? "" : `/${dir}`;
    const result = this.call(["api", `repos/${repo}/contents${path}?ref=${encodeURIComponent(ref)}`, "--jq", '.[] | select(.type == "file") | .name']);
    if (result.code !== 0) {
      if (NOT_FOUND_RE.test(result.stderr)) return null;
      throw new PublishError("gh failed while listing template locations");
    }
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  }

  // GitHub's three single-template locations, .github first.
  prTemplate(repo: string, ref: string): string | null {
    for (const dir of [".github", "", "docs"]) {
      const name = this.listFiles(repo, dir, ref)?.find((file) => file.toLowerCase() === "pull_request_template.md");
      if (name === undefined) continue;
      const text = this.fileAt(repo, dir === "" ? name : `${dir}/${name}`, ref);
      if (text === null) throw new PublishError("the pull request template disappeared while it was being read");
      return text;
    }
    return null;
  }

  issueTemplate(repo: string, ref: string, name: string): string {
    if (!/^[A-Za-z0-9._-]+\.md$/i.test(name)) {
      throw new PublishRefusal("--template must name a Markdown file in .github/ISSUE_TEMPLATE. Issue forms are not supported");
    }
    const text = this.fileAt(repo, `.github/ISSUE_TEMPLATE/${name}`, ref);
    if (text === null) throw new PublishRefusal("the named issue template does not exist on the default branch");
    return text;
  }

  blankIssuesDisabled(repo: string, ref: string): boolean {
    for (const name of ["config.yml", "config.yaml"]) {
      const text = this.fileAt(repo, `.github/ISSUE_TEMPLATE/${name}`, ref);
      if (text !== null) return /^blank_issues_enabled:[ \t]*false[ \t]*(?:#.*)?$/m.test(text);
    }
    return false;
  }

  prView(repo: string, pr: number): PrState {
    const out = this.ok(["pr", "view", String(pr), `--repo=${repo}`, `--json=${PR_FIELDS}`], "reading the pull request");
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(out) as Record<string, unknown>;
    } catch {
      throw new PublishError("gh returned pull request data that is not JSON");
    }
    const headRefOid = raw.headRefOid;
    if (typeof headRefOid !== "string" || !SHA_RE.test(headRefOid) || typeof raw.baseRefName !== "string" || typeof raw.state !== "string") {
      throw new PublishError("gh returned pull request data without a head, base or state");
    }
    const rollup = Array.isArray(raw.statusCheckRollup) ? (raw.statusCheckRollup as Record<string, unknown>[]) : [];
    return {
      number: Number(raw.number),
      state: raw.state,
      isDraft: raw.isDraft === true,
      baseRefName: raw.baseRefName,
      headRefName: String(raw.headRefName ?? ""),
      headRefOid,
      isCrossRepository: raw.isCrossRepository !== false,
      mergeStateStatus: String(raw.mergeStateStatus ?? "UNKNOWN"),
      title: typeof raw.title === "string" ? raw.title : "",
      body: typeof raw.body === "string" ? raw.body : "",
      checks: rollup.map((entry) =>
        entry.__typename === "StatusContext"
          ? { kind: "StatusContext", name: String(entry.context ?? ""), status: "COMPLETED", conclusion: String(entry.state ?? "") }
          : { kind: "CheckRun", name: String(entry.name ?? ""), status: String(entry.status ?? ""), conclusion: String(entry.conclusion ?? "") },
      ),
    };
  }

  // Every commit message on the pull request, or a refusal when the list cannot be read whole
  // (GitHub's commits endpoint stops at 250), because a closing keyword in an unread message still
  // closes its issue on merge.
  prCommitMessages(repo: string, pr: number): string[] {
    const total = Number(this.ok(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".commits"], "counting the pull request's commits").trim());
    const out = this.ok(["api", "--paginate", `repos/${repo}/pulls/${pr}/commits?per_page=100`, "--jq", ".[].commit.message | @json"], "reading commit messages");
    let messages: string[];
    try {
      messages = out
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as string);
    } catch {
      throw new PublishError("gh returned commit messages that are not JSON strings");
    }
    if (!Number.isInteger(total) || messages.length !== total || !messages.every((m) => typeof m === "string")) {
      throw new PublishRefusal("the pull request's commit list could not be read whole, so its closing keywords cannot be audited");
    }
    return messages;
  }

  watchChecks(repo: string, pr: number, timeoutMs: number): "finished" | "timed-out" {
    const result = this.call(["pr", "checks", String(pr), `--repo=${repo}`, "--watch", "--interval=30"], { timeoutMs });
    return result.timedOut ? "timed-out" : "finished";
  }

  createIssue(repo: string, title: string, body: string): string {
    const url = lastLine(this.ok(["issue", "create", `--repo=${repo}`, `--title=${title}`, "--body-file=-"], "creating the issue", body));
    if (!ISSUE_URL_RE.test(url)) throw new PublishError("gh created something but returned no issue URL. Check the repository");
    return url;
  }

  editIssue(repo: string, issue: number, title: string | null, body: string | null): void {
    const args = ["issue", "edit", String(issue), `--repo=${repo}`];
    if (title !== null) args.push(`--title=${title}`);
    if (body !== null) args.push("--body-file=-");
    this.ok(args, "editing the issue", body ?? undefined);
  }

  createPr(repo: string, base: string, head: string, title: string, body: string, draft: boolean): string {
    const args = ["pr", "create", `--repo=${repo}`, `--base=${base}`, `--head=${head}`, `--title=${title}`, "--body-file=-"];
    if (draft) args.push("--draft");
    const url = lastLine(this.ok(args, "creating the pull request", body));
    if (!PR_URL_RE.test(url)) throw new PublishError("gh created something but returned no pull request URL. Check the repository");
    return url;
  }

  editPr(repo: string, pr: number, title: string | null, body: string | null): void {
    const args = ["pr", "edit", String(pr), `--repo=${repo}`];
    if (title !== null) args.push(`--title=${title}`);
    if (body !== null) args.push("--body-file=-");
    this.ok(args, "editing the pull request", body ?? undefined);
  }

  commentPr(repo: string, pr: number, body: string): void {
    this.ok(["pr", "comment", String(pr), `--repo=${repo}`, "--body-file=-"], "commenting on the pull request", body);
  }

  mergePr(repo: string, pr: number, headSha: string, method: "merge" | "rebase", admin: boolean): void {
    const args = ["pr", "merge", String(pr), `--repo=${repo}`, `--${method}`, `--match-head-commit=${headSha}`];
    if (admin) args.push("--admin");
    this.ok(args, "merging the pull request");
  }

  mergedState(repo: string, pr: number): { state: string; mergeSha: string | null } {
    const out = this.ok(["pr", "view", String(pr), `--repo=${repo}`, "--json=state,mergeCommit"], "confirming the merge");
    try {
      const raw = JSON.parse(out) as { state?: unknown; mergeCommit?: { oid?: unknown } | null };
      const oid = raw.mergeCommit?.oid;
      return { state: String(raw.state ?? ""), mergeSha: typeof oid === "string" && SHA_RE.test(oid) ? oid : null };
    } catch {
      throw new PublishError("gh returned merge data that is not JSON");
    }
  }
}
