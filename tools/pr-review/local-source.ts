// A PrSource over two commits in a local repository, with no GitHub access. It exists for the
// offline acceptance runs in tools/pr-review/acceptance/offline.ts, where the diff under review is
// a historical one (round one of #98) or a fixture built on top of it, neither of which can be
// opened as a pull request against master today.
//
// CI's result is not something a local repository knows, so the caller states it with `checks`,
// and syntheticCheckRuns() turns that statement into check runs with the real required names.

import { selectHeadFiles } from "./snapshot";
import { TRUSTED_CONTEXT_PATHS, WORKFLOW_PATH, type CheckRun, type FileText, type IssueText, type PrSnapshot, type PrSource } from "./types";
import { REQUIRED_CHECKS } from "./verdict";

export type SyntheticChecks = "passed" | "failed" | "incomplete";

export function syntheticCheckRuns(state: SyntheticChecks): CheckRun[] {
  return REQUIRED_CHECKS.map((check, i) => {
    if (i === 0 && state === "failed") return { name: check.name, appSlug: check.appSlug, status: "completed", conclusion: "failure" };
    if (i === 0 && state === "incomplete") return { name: check.name, appSlug: check.appSlug, status: "in_progress", conclusion: null };
    return { name: check.name, appSlug: check.appSlug, status: "completed", conclusion: "success" };
  });
}

export interface LocalSourceOptions {
  repoDir: string;
  base: string;
  head: string;
  checks: SyntheticChecks;
  issues?: IssueText[];
  title?: string;
  body?: string;
}

function git(repoDir: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed with exit code ${proc.exitCode}: ${proc.stderr.toString().trim().slice(0, 300)}`);
  }
  return proc.stdout.toString();
}

function gitOrNull(repoDir: string, args: string[]): string | null {
  const proc = Bun.spawnSync(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe" });
  return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

export class LocalGitSource implements PrSource {
  constructor(private readonly options: LocalSourceOptions) {}

  async snapshot(): Promise<PrSnapshot> {
    const { repoDir } = this.options;
    const baseSha = git(repoDir, ["rev-parse", "--verify", `${this.options.base}^{commit}`]).trim();
    const headSha = git(repoDir, ["rev-parse", "--verify", `${this.options.head}^{commit}`]).trim();

    const diff = git(repoDir, ["diff", "--no-color", "--no-ext-diff", baseSha, headSha]);
    // --no-renames lists both sides of a rename, which is what the coverage rules in verdict.ts need.
    const changedFiles = git(repoDir, ["diff", "--name-only", "-z", "--no-renames", baseSha, headSha]).split("\0").filter(Boolean);
    const commitMessages = git(repoDir, ["log", "--reverse", "--format=%B%x00", `${baseSha}..${headSha}`])
      .split("\0")
      .map((message) => message.trim())
      .filter(Boolean);

    const candidates: FileText[] = [];
    for (const path of changedFiles) {
      const content = gitOrNull(repoDir, ["show", `${headSha}:${path}`]);
      if (content !== null) candidates.push({ path, content });
    }
    const { headFiles, omittedFiles } = selectHeadFiles(candidates);

    const trustedContext: FileText[] = [];
    for (const path of TRUSTED_CONTEXT_PATHS) {
      const content = gitOrNull(repoDir, ["show", `${baseSha}:${path}`]);
      if (content !== null) trustedContext.push({ path, content });
    }

    return {
      repo: "local",
      number: null,
      title: this.options.title ?? "(local review)",
      body: this.options.body ?? "",
      baseSha,
      headSha,
      isOpen: true,
      diff,
      changedFiles,
      // git diff --name-only lists every changed path; there is no ceiling to fall short of.
      changedFilesComplete: true,
      commitMessages,
      headFiles,
      omittedFiles,
      linkedIssues: this.options.issues ?? [],
      trustedContext,
      workflowText: gitOrNull(repoDir, ["show", `${baseSha}:${WORKFLOW_PATH}`]),
      checkRuns: syntheticCheckRuns(this.options.checks),
    };
  }
}
