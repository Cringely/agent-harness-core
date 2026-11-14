// issue create/edit and pr create/edit (#274). Each runs its gates in a fixed order, cheapest and
// most local first, and calls gh to publish only after every gate has passed:
//
//   1. the body file reads, and is not empty
//   2. the publish config names an identity for the repository's owner
//   3. the identity scan loads with a declared name and the claude CLI's account email
//      (tools/pr-review/identity.ts), and title, body and head branch carry no identifying string,
//      session link or attribution line (scan.ts)
//   4. the closing keywords equal --closes (none for an issue). A pull request's title counts with
//      its body: a --merge merge commit carries the title, and a keyword in any commit message
//      reaching the default branch closes its issue
//   5. gh is present and holds the configured account's token
//   6. closing keywords only on a pull request into the default branch
//   7. both branches exist on the remote (pr create), or the pull request's base is the --base
//      given (pr edit)
//   8. the repository's template, if any, has every section filled (template.ts)
//
// Every refusal is a PublishRefusal naming a class, never the text that tripped it.

import { isAbsolute } from "node:path";
import type { IdentityDecl, IdentityLoad } from "../pr-review/identity";
import { ownerIdentity, type OwnerIdentity, type PublishConfig } from "./config";
import { PublishRefusal, UsageError } from "./errors";
import type { Runner } from "./exec";
import { Gh } from "./gh";
import { compareClosing, findClosingRefs, scanText, type TextField } from "./scan";
import { templateSections, unfilledSections } from "./template";

export interface PublishContext {
  runner: Runner;
  config: PublishConfig;
  env: Record<string, string | undefined>;
  loadIdentity: () => IdentityLoad;
  readBody: (path: string) => string;
}

export interface IssueCreateArgs {
  repo: string;
  title: string;
  bodyFile: string;
  template: string | null;
}

export interface IssueEditArgs {
  repo: string;
  issue: number;
  title: string | null;
  bodyFile: string | null;
  template: string | null;
}

export interface PrCreateArgs {
  repo: string;
  base: string;
  head: string;
  title: string;
  bodyFile: string;
  closes: number[];
  draft: boolean;
}

export interface PrEditArgs {
  repo: string;
  pr: number;
  base: string;
  title: string | null;
  bodyFile: string | null;
  closes: number[];
}

// Git Bash hands out /c/Users/... paths, and on Windows a native process resolves one of those
// against the current drive's root instead. Only the single-letter drive form is translated.
export function nativePath(path: string, platform: string = process.platform): string {
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(path);
  return platform === "win32" && msys !== null ? `${msys[1]!.toUpperCase()}:${msys[2] ?? "/"}` : path;
}

// Exported for review-merge.ts, which reads and scans the administrator-bypass reason the same way.
export function loadBody(ctx: Pick<PublishContext, "readBody">, path: string, flag = "--body-file"): string {
  const native = nativePath(path);
  if (!isAbsolute(native)) throw new UsageError(`${flag} must be an absolute path`);
  let text: string;
  try {
    text = ctx.readBody(native);
  } catch {
    throw new PublishRefusal(`the file named by ${flag} could not be read`);
  }
  if (text.trim() === "") throw new PublishRefusal(`the file named by ${flag} is empty`);
  return text;
}

// The scan is only as good as what it scans for, so a missing input refuses rather than narrowing
// the scan: no identity file or one declaring no name leaves the name check empty, and no account
// email leaves out the address the claude CLI hands every model. Same precondition pr-review's
// posting run holds (tools/pr-review/pipeline.ts), plus a declared name.
function identityFor(ctx: Pick<PublishContext, "loadIdentity">): IdentityDecl {
  const identity = ctx.loadIdentity();
  if (!identity.ok) throw new PublishRefusal(`the identity scan cannot be built: ${identity.reason}`);
  if (!identity.declared || identity.decl.names.length === 0) {
    throw new PublishRefusal("the identity scan has no declared name to scan for. Declare names in ~/.claude-account-identity.json");
  }
  if (identity.accountEmail !== true || identity.decl.emails.length === 0) {
    throw new PublishRefusal("the identity scan has no account email to scan for. Log in to the claude CLI so its account state names an email address");
  }
  return identity.decl;
}

export function assertClean(ctx: Pick<PublishContext, "loadIdentity">, fields: TextField[]): void {
  const hits = scanText(fields, identityFor(ctx));
  if (hits.length > 0) throw new PublishRefusal(`refusing to publish (${hits.join(", ")}). Nothing was published`);
}

function localGates(ctx: PublishContext, repo: string, fields: TextField[]): OwnerIdentity {
  const owner = ownerIdentity(ctx.config, repo);
  assertClean(ctx, fields);
  return owner;
}

function closingGate(texts: readonly string[], declared: number[], repo: string): number {
  const found = texts.flatMap((text) => findClosingRefs(text, repo));
  const verdict = compareClosing(found, declared, repo);
  if (!verdict.ok) throw new PublishRefusal(`refusing to publish: ${verdict.reason}`);
  return found.length;
}

function templateGate(template: string, body: string): void {
  const unfilled = unfilledSections(template, body);
  if (unfilled.length > 0) {
    throw new PublishRefusal(
      `refusing to publish: template section(s) ${unfilled.join(", ")} of ${templateSections(template).length} are missing or empty`,
    );
  }
}

function issueTemplateGate(gh: Gh, repo: string, ref: string, template: string | null, body: string, requireWhenBlankDisabled: boolean): void {
  if (template === null) {
    if (requireWhenBlankDisabled && gh.blankIssuesDisabled(repo, ref)) {
      throw new PublishRefusal("this repository disables blank issues. Pass --template naming one of its issue templates");
    }
    return;
  }
  templateGate(gh.issueTemplate(repo, ref, template), body);
}

export function issueCreate(ctx: PublishContext, args: IssueCreateArgs): string {
  const body = loadBody(ctx, args.bodyFile);
  const owner = localGates(ctx, args.repo, [
    { label: "title", text: args.title },
    { label: "body", text: body },
  ]);
  closingGate([body], [], args.repo);
  const gh = Gh.forUser(ctx.runner, owner.ghUser, ctx.env);
  const defaultBranch = gh.defaultBranch(args.repo);
  issueTemplateGate(gh, args.repo, defaultBranch, args.template, body, true);
  return gh.createIssue(args.repo, args.title, body);
}

export function issueEdit(ctx: PublishContext, args: IssueEditArgs): string {
  const body = args.bodyFile === null ? null : loadBody(ctx, args.bodyFile);
  const fields: TextField[] = [];
  if (args.title !== null) fields.push({ label: "title", text: args.title });
  if (body !== null) fields.push({ label: "body", text: body });
  const owner = localGates(ctx, args.repo, fields);
  if (body !== null) closingGate([body], [], args.repo);
  const gh = Gh.forUser(ctx.runner, owner.ghUser, ctx.env);
  if (body !== null && args.template !== null) {
    issueTemplateGate(gh, args.repo, gh.defaultBranch(args.repo), args.template, body, false);
  }
  gh.editIssue(args.repo, args.issue, args.title, body);
  return `edited issue #${args.issue}`;
}

export function prCreate(ctx: PublishContext, args: PrCreateArgs): string {
  const body = loadBody(ctx, args.bodyFile);
  const owner = localGates(ctx, args.repo, [
    { label: "title", text: args.title },
    { label: "body", text: body },
    { label: "head branch", text: args.head },
  ]);
  const closing = closingGate([args.title, body], args.closes, args.repo);
  const gh = Gh.forUser(ctx.runner, owner.ghUser, ctx.env);
  const defaultBranch = gh.defaultBranch(args.repo);
  if (args.base !== defaultBranch && closing > 0) {
    throw new PublishRefusal("refusing to publish: closing keywords act only on a pull request into the default branch, and this one targets another base");
  }
  if (gh.branchHead(args.repo, args.base) === null) throw new PublishRefusal("the base branch does not exist on the remote");
  if (gh.branchHead(args.repo, args.head) === null) throw new PublishRefusal("the head branch is not on the remote. Push it first");
  const template = gh.prTemplate(args.repo, defaultBranch);
  if (template !== null) templateGate(template, body);
  return gh.createPr(args.repo, args.base, args.head, args.title, body, args.draft);
}

export function prEdit(ctx: PublishContext, args: PrEditArgs): string {
  const body = args.bodyFile === null ? null : loadBody(ctx, args.bodyFile);
  const fields: TextField[] = [];
  if (args.title !== null) fields.push({ label: "title", text: args.title });
  if (body !== null) fields.push({ label: "body", text: body });
  const owner = localGates(ctx, args.repo, fields);
  // Only what this edit publishes is checked here. A title-only edit declares nothing (cli.ts takes
  // --closes only with --body-file), so a keyword in it refuses. review-merge audits the title,
  // body and commits as they stand before it merges.
  const closing = closingGate([args.title, body].filter((text): text is string => text !== null), args.closes, args.repo);
  const gh = Gh.forUser(ctx.runner, owner.ghUser, ctx.env);
  const pr = gh.prView(args.repo, args.pr);
  if (pr.baseRefName !== args.base) throw new PublishRefusal("the pull request's base branch is not the --base given");
  const defaultBranch = gh.defaultBranch(args.repo);
  if (args.base !== defaultBranch && closing > 0) {
    throw new PublishRefusal("refusing to publish: closing keywords act only on a pull request into the default branch, and this one targets another base");
  }
  if (body !== null) {
    const template = gh.prTemplate(args.repo, defaultBranch);
    if (template !== null) templateGate(template, body);
  }
  gh.editPr(args.repo, args.pr, args.title, body);
  return `edited pull request #${args.pr}`;
}
