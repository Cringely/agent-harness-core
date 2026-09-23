#!/usr/bin/env bun
// This repository's pull request reviewer (#120), run by hand. Not part of core and not installed
// anywhere: nothing under install/ copies tools/.
//
// The App's private key is read only from stdin, piped from 1Password (operator ruling, 2026-09-11):
//   op read "<secret reference>" | bun <absolute path>/tools/pr-review/cli.ts review --pr <n> --app-id <id> --key-stdin [--post [--comment-only]] [--json] [--repo owner/name] [--expect-head <sha40>]
//   op read "<secret reference>" | bun <absolute path>/tools/pr-review/cli.ts snapshot --pr <n> --app-id <id> --key-stdin [--repo owner/name] [--expect-head <sha40>]
// review without --post is a dry run. snapshot mints a token and reads the pull request, runs no model
// and posts nothing, and prints what the reviewer would be given plus the computed verification.
// --app-id may come from PR_REVIEW_APP_ID instead.
//
// BUN-CWD: Bun auto-loads bunfig.toml and .env from the current working directory rather than the
// script's own directory (live capture, 2026-09-11), and only from the literal cwd, never an
// ancestor directory (confirmed live, 2026-09-13). A pull request that added either at the
// repository root would otherwise run arbitrary code, or redirect where the network goes, inside the
// very process holding the App key. review and snapshot therefore refuse, before reading the key,
// when the working directory is (realpath-resolved) a repository checkout or anywhere under one, or
// when the working directory itself holds a bunfig.toml or .env* file regardless of where it sits --
// a worktree's parent clone root, a subst drive, or any other alias the first check does not name.
// The command line above invokes this file by its absolute path precisely so the working directory
// is free to be somewhere else, such as the operator's temp directory.
//
// Exit codes: 0 reviewed or snapshotted, 2 refused (nothing posted), 1 usage or runtime error,
// including any HTTP failure from GitHub.

import type { KeyObject } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppTokenMinter, readPrivateKey } from "./app-auth";
import { GitHubClient } from "./github";
import { findIdentityHits, loadIdentity, type IdentityDecl } from "./identity";
import { runReview, type ReviewOutcome } from "./pipeline";
import { ClaudeCliRunner } from "./runner";
import { REPO_ROOT, toolState } from "./tool-state";
import { RefusalError, SHA_RE, type PrSnapshot, type PrSource, type ReviewPoster } from "./types";
import { verificationOf } from "./verdict";

export const DEFAULT_REPO = "Cringely/agent-harness-core";

export class UsageError extends Error {}

export type CliCommand =
  | { command: "help" }
  | {
      command: "review" | "snapshot";
      repo: string;
      pr: number;
      appId: string;
      post: boolean;
      commentOnly: boolean;
      json: boolean;
      // #155: the head the caller means to review or snapshot, if it knows one (a 40-character
      // lowercase hex commit SHA). null when --expect-head was not given.
      expectHead: string | null;
    };

const USAGE = [
  'op read "<secret reference>" | bun <absolute path>/tools/pr-review/cli.ts review --pr <n> --app-id <id> --key-stdin [--post [--comment-only]] [--json] [--repo owner/name] [--expect-head <sha40>]',
  'op read "<secret reference>" | bun <absolute path>/tools/pr-review/cli.ts snapshot --pr <n> --app-id <id> --key-stdin [--repo owner/name] [--expect-head <sha40>]',
].join("\n");

export function parseCliArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") return { command: "help" };
  if (command !== "review" && command !== "snapshot") throw new UsageError(`unknown command: ${command}`);

  const options: Parameters<typeof parseArgs>[0]["options"] = {
    repo: { type: "string" },
    pr: { type: "string" },
    "app-id": { type: "string" },
    "key-stdin": { type: "boolean" },
    "expect-head": { type: "string" },
    ...(command === "review" ? { post: { type: "boolean" }, "comment-only": { type: "boolean" }, json: { type: "boolean" } } : {}),
  };
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: [...rest], options, strict: true, allowPositionals: false }).values as Record<string, string | boolean | undefined>;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (typeof values.pr !== "string" || !/^[1-9][0-9]*$/.test(values.pr) || !Number.isSafeInteger(Number(values.pr))) {
    throw new UsageError(`${command} needs --pr <positive integer>`);
  }
  const appId = typeof values["app-id"] === "string" ? values["app-id"] : env.PR_REVIEW_APP_ID;
  if (!appId) throw new UsageError(`${command} needs --app-id or PR_REVIEW_APP_ID`);
  if (values["key-stdin"] !== true) {
    throw new UsageError(`${command} reads the App key only from stdin: pass --key-stdin and pipe the key in from op read`);
  }
  if (values["comment-only"] === true && values.post !== true) throw new UsageError("--comment-only only applies with --post");

  // #155: optional on both commands. Absent leaves today's behaviour byte-identical (no check
  // downstream); present, it must already be shaped like a real commit SHA, the same check
  // github.ts applies to a fetched head, so a caller's typo is a usage error here rather than a
  // guaranteed mismatch refusal three network calls later.
  let expectHead: string | null = null;
  if (values["expect-head"] !== undefined) {
    if (typeof values["expect-head"] !== "string" || !SHA_RE.test(values["expect-head"])) {
      throw new UsageError(`${command} needs --expect-head to be a 40-character lowercase hex commit SHA`);
    }
    expectHead = values["expect-head"];
  }

  return {
    command,
    repo: typeof values.repo === "string" ? values.repo : DEFAULT_REPO,
    pr: Number(values.pr),
    appId,
    post: values.post === true,
    commentOnly: values["comment-only"] === true,
    json: command === "snapshot" || values.json === true,
    expectHead,
  };
}

// Names, paths, counts and SHAs only: the pull request's own text is untrusted and has no business in
// a smoke test's output.
export function summarizeSnapshot(snapshot: PrSnapshot): Record<string, unknown> {
  return {
    repo: snapshot.repo,
    number: snapshot.number,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    isOpen: snapshot.isOpen,
    changedFiles: snapshot.changedFiles,
    changedFilesComplete: snapshot.changedFilesComplete,
    diffBytes: snapshot.diff === null ? null : Buffer.byteLength(snapshot.diff, "utf8"),
    headFiles: snapshot.headFiles.map((file) => file.path),
    omittedFiles: snapshot.omittedFiles,
    commitCount: snapshot.commitMessages.length,
    linkedIssues: snapshot.linkedIssues.map((issue) => issue.number),
    trustedContext: snapshot.trustedContext.map((file) => file.path),
    workflowPresent: snapshot.workflowText !== null,
    checkRuns: snapshot.checkRuns,
    // cv3: the one place that draws computeVerification's four fields out of a PrSnapshot, so this
    // call site and pipeline.ts's cannot drift apart the way the plan's own duplicates already had.
    verification: verificationOf(snapshot),
  };
}

// A11.1: distinguishes "the tool refused on purpose" from "the tool broke". Every deliberate
// refusal in this codebase throws RefusalError (github.ts's fork, default-branch and moved-pull-
// request checks; this file's cwd check; pipeline.ts's posting preconditions); anything else
// reaching the top-level handler below is a defect, not a gate.
export function exitCodeFor(error: unknown): number {
  return error instanceof RefusalError ? 2 : 1;
}

// A11.5: an allowlist, not a denylist. A denylist ("anything but refused exits 0") lets a status
// this file does not recognise exit 0 too, and Tasks 14-16's stop rules key on these exit codes.
function exitCodeForStatus(status: ReviewOutcome["status"]): number {
  if (status === "posted" || status === "dry-run") return 0;
  if (status === "refused") return 2;
  return 1;
}

// GitHub response text (a permission name, repository_selection, an API error body) can reach this
// file's console output by way of a thrown message; a control character embedded in it could corrupt
// or spoof what the operator's terminal shows (Task 10 review carry-forward). R11-7: C0 and DEL alone
// left the C1 range (U+0080-U+009F, including U+009B, an alternate CSI introducer) and the bidi
// override and isolate characters (U+202A-U+202E, U+2066-U+2069) untouched; \u007F-\u009F is DEL and
// all of C1 as one contiguous range. Tab, LF and CR pass through: ordinary formatting, and not
// something any of those GitHub fields has a reason to carry.
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, "");
}

// BUN-CWD (R11-1): realpath-resolves both sides before comparing, so a cwd reached through a
// symlink or an NTFS junction into the checkout still compares as the same physical directory
// rather than as two different path strings. realpathSync.native, not the JS wrapper, per the
// fix ruling; an unreadable path (already gone, or a dangling link) falls back to resolve() rather
// than throwing out of a security check. Paths are then `/`-joined and, on win32, case-folded, since
// a Windows checkout path and the live process cwd can differ only in case and still name the same
// directory. The trailing-separator join (`${root}/`) matters the same way parseRepo's exact-segment
// check does: without it, "E:/repo-other" would read as inside "E:/repo".
function realOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function isCwdInsideRepo(cwd: string, repoRoot: string): boolean {
  const normalize = (path: string) => {
    const absolute = realOrResolved(path).replace(/\\/g, "/");
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  const root = normalize(repoRoot);
  const current = normalize(cwd);
  return current === root || current.startsWith(`${root}/`);
}

// BUN-CWD (R11-1): a worktree's checkout lives under a parent clone (`.claude/worktrees/`), so
// running from that parent's root is not "inside" this checkout by the path check above, yet Bun
// still auto-loads whatever bunfig.toml or .env* file sits in that root -- and a subst drive or a
// drive-root checkout has the same gap the other way, where `${root}/` never matches a subdirectory
// at all. The real invariant is narrower and simpler than "inside the checkout": Bun reads only the
// literal cwd, never an ancestor (live capture, 2026-09-11 and reviewer confirmation, 2026-09-13),
// so refusing whenever the cwd itself holds one of those files closes every one of those cases with
// one readdir, regardless of how the cwd relates to REPO_ROOT. A cwd that cannot be listed (removed,
// permission denied) refuses too: this function only ever reports a cwd as safe when it can prove
// nothing is there.
export function cwdHasAutoloadFile(cwd: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return true;
  }
  return entries.some((name) => name === "bunfig.toml" || name.startsWith(".env"));
}

// A11.7: the diagnostic is the claude child's raw stderr (runner.ts) and can quote a profile path or
// the account email; pipeline.ts already scans and blanks it into the outcome it returns (T8-1), but
// this is a second, independent check at the point of printing, so a caller that builds a
// ReviewOutcome by hand (this file's own tests do exactly that) cannot bypass it either.
export function reportOutcome(outcome: ReviewOutcome, json: boolean, identity: IdentityDecl): number {
  const diagnosticHits = outcome.reviewerDiagnostic !== null ? findIdentityHits(outcome.reviewerDiagnostic, identity) : [];
  const safeDiagnostic =
    outcome.reviewerDiagnostic === null
      ? null
      : diagnosticHits.length > 0
        ? `(diagnostic withheld: identifying strings: ${diagnosticHits.join(", ")})`
        : stripControlChars(outcome.reviewerDiagnostic);
  const safeRefusal = outcome.refusal === null ? null : stripControlChars(outcome.refusal);
  const safeOutcome: ReviewOutcome = { ...outcome, reviewerDiagnostic: safeDiagnostic, refusal: safeRefusal };

  if (json) {
    console.log(JSON.stringify(safeOutcome, null, 2));
  } else {
    console.log(safeOutcome.body);
    console.error(`status=${safeOutcome.status} event=${safeOutcome.event} computed=${safeOutcome.computedEvent}`);
    if (safeOutcome.refusal) console.error(`refused: ${safeOutcome.refusal}`);
    if (safeOutcome.posted) console.error(`posted: ${safeOutcome.posted.htmlUrl}`);
  }
  if (safeOutcome.reviewerDiagnostic) console.error(`reviewer diagnostic: ${safeOutcome.reviewerDiagnostic}`);
  return exitCodeForStatus(outcome.status);
}

// #167: the shape for a refusal that never reached a ReviewOutcome to hand reportOutcome above --
// runReview()'s own two thrown preconditions (no account email, an unclean checkout) and, since
// #155, a mismatched --expect-head on either command. Before this, a --json caller got empty
// stdout and a plain-text stderr line for these instead of the {status: "refused", ...} shape it
// parses for every refusal runReview returns rather than throws. Only status and refusal are
// filled in: no snapshot backs these three, so there is no real event, verification or finding
// list to put in the rest of ReviewOutcome's shape without inventing one.
export function reportRefusal(message: string, json: boolean): number {
  const refusal = stripControlChars(message);
  if (json) {
    console.log(JSON.stringify({ status: "refused", refusal }, null, 2));
  } else {
    console.error(`refused: ${refusal}`);
  }
  return 2;
}

// #167: how main() turns a validated key into the client both commands fetch through. Pulled out
// of main() and put on the CliIo seam below so a test can hand back a PrSource/ReviewPoster that
// returns a chosen headSha with no App key or network call, which is what proves the
// --expect-head wiring (into runReview's options, and the snapshot command's own check) and the
// refusal shape above without needing a real installation. Optional and defaulted rather than
// added as a fourth required CliIo field: every existing test that builds a partial CliIo (the
// BUN-CWD and stdin-refusal tests below) never reaches this call, so requiring it there would
// break them for no reason.
function realBuildSource(repo: string, pr: number, appId: string, key: KeyObject): PrSource & ReviewPoster {
  return new GitHubClient({ repo, pr, minter: new AppTokenMinter({ appId, key, repo }) });
}

// A seam over process-level effects (the real stdin read, and process.exit itself), so main() can be
// exercised without ever truly reading a console's stdin or truly terminating the test runner. cli.ts
// never passes an override in production; import.meta.main below relies on the default.
interface CliIo {
  cwd: () => string;
  exit: (code: number) => never;
  stdin: { isTTY: boolean; read: () => Promise<string> };
  buildSource?: (repo: string, pr: number, appId: string, key: KeyObject) => PrSource & ReviewPoster;
}

const REAL_IO: CliIo = {
  cwd: () => process.cwd(),
  exit: (code) => process.exit(code) as never,
  stdin: { isTTY: Boolean(process.stdin.isTTY), read: () => Bun.stdin.text() },
  buildSource: realBuildSource,
};

export async function main(argv: string[], io: CliIo = REAL_IO): Promise<number> {
  let parsed: CliCommand;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${stripControlChars(error.message)}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
  if (parsed.command === "help") {
    console.log(USAGE);
    return 0;
  }

  // BUN-CWD: checked before anything else review or snapshot does, including reading the key --
  // snapshot mints and uses a real installation token exactly as review does. R11-9: the message
  // names the general policy, not the absolute checkout path (which, under the user's own profile,
  // would put the workstation username into stderr that later tasks paste into reports).
  if (isCwdInsideRepo(io.cwd(), REPO_ROOT) || cwdHasAutoloadFile(io.cwd())) {
    throw new RefusalError(
      "refusing to run: this command holds the App key, and Bun auto-loads bunfig.toml and .env files from the working directory; the working directory is either inside a repository checkout or itself holds one of those files, so invoke it from a directory with neither, outside every checkout",
    );
  }

  const key = await readPrivateKey(io.stdin);
  if (!key.ok) {
    console.error(`refused: ${stripControlChars(key.reason)}`);
    // Carry-forward from Task 10's review: readPrivateKey's internal stdin read can still be
    // pending when this refusal fires (a stdin that never closes only resolves via the internal
    // timeout, and the read itself keeps running), and that pending read would otherwise keep this
    // process alive past the exit code returned here. Exiting immediately, rather than only
    // returning a code for import.meta.main's own process.exit to act on once this promise settles,
    // means nothing downstream can end up waiting on that dangling read first.
    io.exit(2);
  }
  const github = (io.buildSource ?? realBuildSource)(parsed.repo, parsed.pr, parsed.appId, key.key);

  if (parsed.command === "snapshot") {
    const snap = await github.snapshot();
    // #155: snapshot never posts, so this only ever refuses a print, but it lets a wrapper that
    // pinned a head confirm before it decides whether to run review at all. #167: routed through
    // reportRefusal rather than thrown, since snapshot's own --json is always true (parseCliArgs
    // above) and a thrown RefusalError here used to reach import.meta.main's plain-text handler
    // unconditionally, never the JSON shape a snapshot caller parses.
    if (parsed.expectHead !== null && parsed.expectHead !== snap.headSha) {
      return reportRefusal(`refusing to snapshot: the pull request's head is ${snap.headSha}, not the expected ${parsed.expectHead}`, parsed.json);
    }
    console.log(JSON.stringify(summarizeSnapshot(snap), null, 2));
    return 0;
  }

  const identity = loadIdentity();
  if (!identity.ok) {
    console.error(`refused: ${stripControlChars(identity.reason)}`);
    return 2;
  }
  if (!identity.declared) {
    console.error(
      "warning: ~/.claude-account-identity.json is absent, so the review body is checked only for the username, the hostname and any email in the claude CLI's account state",
    );
  }
  const tool = toolState();
  let outcome: ReviewOutcome;
  try {
    outcome = await runReview(
      {
        source: github,
        runner: new ClaudeCliRunner(),
        poster: parsed.post ? github : null,
        identity: identity.decl,
        // A11.6: without this, ReviewDeps.accountEmail defaults to undefined, and pipeline.ts's
        // posting precondition (deps.accountEmail !== true) refuses every posting run regardless of
        // whether the claude CLI's account state actually named an email.
        accountEmail: identity.accountEmail,
        toolRevision: tool.revision,
        toolDirty: tool.dirty,
      },
      { commentOnly: parsed.commentOnly, expectHead: parsed.expectHead },
    );
  } catch (error) {
    // #167: runReview() throws RefusalError for a precondition checked before any snapshot-backed
    // ReviewOutcome exists to report (no account email, an unclean checkout, and #155's
    // expect-head mismatch, all before the model runs) -- every refusal it returns instead of
    // throwing already reaches reportOutcome below. Without this catch, a --json caller got empty
    // stdout and a stderr line for these three, unlike every refusal runReview returns.
    if (error instanceof RefusalError) return reportRefusal(error.message, parsed.json);
    throw error;
  }
  return reportOutcome(outcome, parsed.json, identity.decl);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`error: ${stripControlChars(error instanceof Error ? error.message : String(error))}`);
      process.exit(exitCodeFor(error));
    },
  );
}
