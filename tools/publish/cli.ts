#!/usr/bin/env bun
// tools/publish (#274): the one route by which an agent files an issue, opens or edits a pull
// request, or reviews and merges one. Every gate fails closed and every refusal exits 2 with a
// class-only message. See tools/publish/README.md.
//
//   bun --cwd <home>/.claude-publish/work <absolute path>/tools/publish/cli.ts <command> ...
//
// BUN-CWD: Bun loads bunfig.toml and .env files from the working directory before any code runs,
// and `bun --cwd <dir>` moves that load to <dir> (measured on Bun 1.3.14: a preload and a .env in
// the launch directory both stayed unloaded under --cwd). This process holds a GitHub token and,
// for review-merge, streams the reviewer App's key, so it refuses to run anywhere but the
// dedicated, empty work directory, outside every git work tree. A run started without --cwd from
// inside a checkout has already loaded that checkout's config by the time this check refuses,
// which is why the documented invocation always carries --cwd.
//
// Exit codes: 0 done, 2 refused (nothing new published), 1 usage or runtime error.

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cwdHasAutoloadFile, stripControlChars } from "../pr-review/cli";
import { loadIdentity, type IdentityLoad } from "../pr-review/identity";
import { toolState } from "../pr-review/tool-state";
import { parseRepo } from "../pr-review/types";
import { loadPublishConfig, WORK_DIR, type PublishConfig } from "./config";
import { PublishError, PublishRefusal, UsageError } from "./errors";
import { childEnv, realRunner, type Runner } from "./exec";
import { BRANCH_RE } from "./gh";
import { issueCreate, issueEdit, prCreate, prEdit, type IssueCreateArgs, type IssueEditArgs, type PrCreateArgs, type PrEditArgs } from "./publish";
import { realExists, reviewMerge, type ReviewMergeArgs } from "./review-merge";
import { parseClosesList } from "./scan";

export const USAGE = [
  "bun --cwd <home>/.claude-publish/work <abs>/tools/publish/cli.ts issue create --repo <owner/name> --title <t> --body-file <abs path> [--template <file.md>]",
  "bun --cwd <home>/.claude-publish/work <abs>/tools/publish/cli.ts issue edit --repo <owner/name> --issue <n> [--title <t>] [--body-file <abs path> [--template <file.md>]]",
  "bun --cwd <home>/.claude-publish/work <abs>/tools/publish/cli.ts pr create --repo <owner/name> --base <branch> --head <branch> --title <t> --body-file <abs path> [--closes <n,n>] [--draft]",
  "bun --cwd <home>/.claude-publish/work <abs>/tools/publish/cli.ts pr edit --repo <owner/name> --pr <n> --base <branch> [--title <t>] [--body-file <abs path> [--closes <n,n>]]",
  "bun --cwd <home>/.claude-publish/work <abs>/tools/publish/cli.ts review-merge --repo <owner/name> --pr <n> [--closes <n,n>] [--allow-admin --admin-reason-file <abs path>] [--method merge|rebase] [--checks-timeout-min <1-180>]",
].join("\n");

export type Command =
  | { kind: "help" }
  | ({ kind: "issue-create" } & IssueCreateArgs)
  | ({ kind: "issue-edit" } & IssueEditArgs)
  | ({ kind: "pr-create" } & PrCreateArgs)
  | ({ kind: "pr-edit" } & PrEditArgs)
  | ({ kind: "review-merge" } & ReviewMergeArgs);

type Values = Record<string, string | boolean | undefined>;

function parse(rest: readonly string[], strings: string[], booleans: string[] = []): Values {
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const name of strings) options[name] = { type: "string" };
  for (const name of booleans) options[name] = { type: "boolean" };
  try {
    return parseArgs({ args: [...rest], options, strict: true, allowPositionals: false }).values as Values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function repoOf(values: Values): string {
  const repo = values.repo;
  if (typeof repo !== "string" || parseRepo(repo) === null) throw new UsageError("--repo <owner/name> is required");
  return repo;
}

function numberOf(values: Values, name: string): number {
  const raw = values[name];
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,9}$/.test(raw)) throw new UsageError(`--${name} <positive integer> is required`);
  return Number(raw);
}

function branchOf(values: Values, name: string): string {
  const raw = values[name];
  if (typeof raw !== "string" || !BRANCH_RE.test(raw) || raw.startsWith("-") || raw.includes("..")) {
    throw new UsageError(`--${name} <branch> is required, and must be a plain branch name`);
  }
  return raw;
}

function titleOf(values: Values, required: boolean): string | null {
  const raw = values.title;
  if (raw === undefined && !required) return null;
  if (typeof raw !== "string" || raw.trim() === "" || /[\r\n]/.test(raw) || raw.length > 256) {
    throw new UsageError("--title must be one non-empty line of at most 256 characters");
  }
  return raw;
}

function bodyFileOf(values: Values, required: boolean): string | null {
  const raw = values["body-file"];
  if (raw === undefined && !required) return null;
  if (typeof raw !== "string" || raw === "" || raw === "-") throw new UsageError("--body-file <absolute path> is required. The body comes only from a file");
  return raw;
}

export function parseCommand(argv: readonly string[]): Command {
  const [first, second, ...rest] = argv;
  if (first === undefined || first === "help" || first === "--help") return { kind: "help" };

  if (first === "issue" && (second === "create" || second === "edit")) {
    if (second === "create") {
      const v = parse(rest, ["repo", "title", "body-file", "template"]);
      return {
        kind: "issue-create",
        repo: repoOf(v),
        title: titleOf(v, true)!,
        bodyFile: bodyFileOf(v, true)!,
        template: typeof v.template === "string" ? v.template : null,
      };
    }
    const v = parse(rest, ["repo", "issue", "title", "body-file", "template"]);
    const args = { repo: repoOf(v), issue: numberOf(v, "issue"), title: titleOf(v, false), bodyFile: bodyFileOf(v, false), template: typeof v.template === "string" ? v.template : null };
    if (args.title === null && args.bodyFile === null) throw new UsageError("issue edit needs --title, --body-file or both");
    if (args.template !== null && args.bodyFile === null) throw new UsageError("--template applies only with --body-file");
    return { kind: "issue-edit", ...args };
  }

  if (first === "pr" && (second === "create" || second === "edit")) {
    if (second === "create") {
      const v = parse(rest, ["repo", "base", "head", "title", "body-file", "closes"], ["draft"]);
      return {
        kind: "pr-create",
        repo: repoOf(v),
        base: branchOf(v, "base"),
        head: branchOf(v, "head"),
        title: titleOf(v, true)!,
        bodyFile: bodyFileOf(v, true)!,
        closes: parseClosesList(v.closes as string | undefined),
        draft: v.draft === true,
      };
    }
    const v = parse(rest, ["repo", "pr", "base", "title", "body-file", "closes"]);
    const args = {
      repo: repoOf(v),
      pr: numberOf(v, "pr"),
      base: branchOf(v, "base"),
      title: titleOf(v, false),
      bodyFile: bodyFileOf(v, false),
      closes: parseClosesList(v.closes as string | undefined),
    };
    if (args.title === null && args.bodyFile === null) throw new UsageError("pr edit needs --title, --body-file or both");
    if (v.closes !== undefined && args.bodyFile === null) throw new UsageError("--closes applies only with --body-file");
    return { kind: "pr-edit", ...args };
  }

  if (first === "review-merge") {
    const v = parse(second === undefined ? [] : [second, ...rest], ["repo", "pr", "closes", "method", "checks-timeout-min", "admin-reason-file"], ["allow-admin"]);
    const allowAdmin = v["allow-admin"] === true;
    const reason = v["admin-reason-file"];
    if (allowAdmin !== (reason !== undefined)) throw new UsageError("--allow-admin and --admin-reason-file <absolute path> go together");
    if (reason !== undefined && (typeof reason !== "string" || reason === "" || reason === "-")) {
      throw new UsageError("--admin-reason-file takes an absolute path");
    }
    const method = v.method ?? "merge";
    if (method !== "merge" && method !== "rebase") throw new UsageError("--method must be merge or rebase");
    const timeout = v["checks-timeout-min"] ?? "30";
    if (typeof timeout !== "string" || !/^[0-9]{1,3}$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 180) {
      throw new UsageError("--checks-timeout-min must be a whole number from 1 to 180");
    }
    return {
      kind: "review-merge",
      repo: repoOf(v),
      pr: numberOf(v, "pr"),
      closes: parseClosesList(v.closes as string | undefined),
      allowAdmin,
      adminReasonFile: typeof reason === "string" ? reason : null,
      method,
      checksTimeoutMin: Number(timeout),
    };
  }

  throw new UsageError("unknown command");
}

function canonical(path: string): string | null {
  try {
    const real = realpathSync.native(path).replace(/\\/g, "/");
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

export function assertNeutralCwd(cwd: string, workDir: string, runner: Runner, env: Record<string, string | undefined>): void {
  const here = canonical(cwd);
  const work = canonical(workDir);
  if (here === null || work === null || here !== work) {
    throw new PublishRefusal(
      "run this tool as bun --cwd <home>/.claude-publish/work <path>/tools/publish/cli.ts: it holds credentials, and Bun loads bunfig.toml and .env files from the working directory",
    );
  }
  if (cwdHasAutoloadFile(cwd)) throw new PublishRefusal("the work directory holds a bunfig.toml or .env file. Empty it");
  const probe = runner.run(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { env: childEnv(env, { LC_ALL: "C", LANGUAGE: "C" }) });
  if (probe.spawnError) throw new PublishRefusal("git is not on PATH");
  if (probe.stdout.trim() === "true" || !/not a git repository/i.test(probe.stderr)) {
    throw new PublishRefusal("the work directory sits inside a git work tree. Move it outside every checkout");
  }
}

export interface CliDeps {
  runner: Runner;
  cwd: string;
  workDir: string;
  toolRoot: string;
  env: Record<string, string | undefined>;
  loadConfig: () => PublishConfig;
  loadIdentity: () => IdentityLoad;
  readBody: (path: string) => string;
  exists: (path: string) => boolean;
  toolState: (root: string) => { revision: string; dirty: boolean };
  sleep: (ms: number) => void;
  bunPath: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function realDeps(): CliDeps {
  return {
    runner: realRunner,
    cwd: process.cwd(),
    workDir: WORK_DIR,
    // The checkout holding this file, which review-merge requires to be clean and current.
    toolRoot: join(import.meta.dir, "..", ".."),
    env: process.env,
    loadConfig: () => loadPublishConfig(),
    loadIdentity: () => loadIdentity(),
    readBody: (path) => readFileSync(path, "utf8"),
    exists: realExists,
    toolState: (root) => toolState(root),
    sleep: (ms) => Bun.sleepSync(ms),
    bunPath: process.execPath,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`usage error: ${stripControlChars(error.message)}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
  if (command.kind === "help") {
    deps.out(USAGE);
    return 0;
  }
  try {
    assertNeutralCwd(deps.cwd, deps.workDir, deps.runner, deps.env);
    const config = deps.loadConfig();
    const publishCtx = { runner: deps.runner, config, env: deps.env, loadIdentity: deps.loadIdentity, readBody: deps.readBody };
    switch (command.kind) {
      case "issue-create":
        deps.out(issueCreate(publishCtx, command));
        break;
      case "issue-edit":
        deps.out(issueEdit(publishCtx, command));
        break;
      case "pr-create":
        deps.out(prCreate(publishCtx, command));
        break;
      case "pr-edit":
        deps.out(prEdit(publishCtx, command));
        break;
      case "review-merge":
        deps.out(
          await reviewMerge(
            {
              runner: deps.runner,
              config,
              env: deps.env,
              workDir: deps.workDir,
              toolRoot: deps.toolRoot,
              bunPath: deps.bunPath,
              exists: deps.exists,
              toolState: deps.toolState,
              sleep: deps.sleep,
              log: deps.err,
              loadIdentity: deps.loadIdentity,
              readBody: deps.readBody,
            },
            command,
          ),
        );
        break;
    }
    return 0;
  } catch (error) {
    if (error instanceof PublishRefusal) {
      deps.err(`refused: ${stripControlChars(error.message)}`);
      return 2;
    }
    if (error instanceof UsageError) {
      deps.err(`usage error: ${stripControlChars(error.message)}\n\n${USAGE}`);
      return 1;
    }
    if (error instanceof PublishError) {
      deps.err(`error: ${stripControlChars(error.message)}`);
      return 1;
    }
    // Not one of this tool's own messages: a library error can quote its input, so only the class
    // is printed.
    deps.err(`error: unexpected failure (${error instanceof Error ? error.name : typeof error})`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2), realDeps()).then((code) => process.exit(code));
}
