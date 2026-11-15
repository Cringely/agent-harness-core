// Local configuration for tools/publish (#274), read from ~/.claude-publish/config.json. It names,
// per repository owner, the git and gh identity every command uses, and, per repository, the
// command that prints the reviewer App's private key, the App's ID, the reviewer checkout and the
// personal-term list review-merge hands to premerge before every merge, and, for any repository
// but the reviewer's built-in one, the policy file the reviewer needs (tools/pr-review --policy). None
// of those may be committed, so there is no default: a missing file, a missing entry or a malformed
// field is a refusal. Messages name the field, never its value, because a value here is an
// identity, a secret reference or a machine path.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseRepo } from "../pr-review/types";
import { PublishRefusal } from "./errors";

export const PUBLISH_HOME = join(homedir(), ".claude-publish");
export const CONFIG_PATH = join(PUBLISH_HOME, "config.json");
// The only working directory the tool runs from (cli.ts). Empty and outside every checkout,
// because Bun loads bunfig.toml and .env files from the working directory before any code runs.
export const WORK_DIR = join(PUBLISH_HOME, "work");

export interface OwnerIdentity {
  gitName: string;
  gitEmail: string;
  ghUser: string;
}

export interface ReviewerConfig {
  appId: string;
  keyCommand: string[];
  keyCommandEnv: Record<string, string>;
  checkout: string;
  termsFile: string;
  // tools/pr-review's --policy file. review-merge requires it for every repository but
  // CORE_POLICY.repo, which the reviewer has built in.
  policyFile: string | null;
}

export interface PublishConfig {
  owners: Record<string, OwnerIdentity>;
  reviewers: Record<string, ReviewerConfig>;
}

// A GitHub account name. ghUser is interpolated into a git credential helper string
// (review-merge.ts), so this pattern is also what keeps shell metacharacters out of it.
export const GH_USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
// keyCommandEnv sits in this file as plain text, so a credential the key command needs must not
// live there: the key command fetches its own (tools/publish/README.md shows a wrapper that
// decrypts one into its child's environment). A name pattern cannot tell a session key or a
// passphrase from a setting, so keyCommandEnv accepts only these non-secret settings and refuses
// every other name.
export const KEY_COMMAND_ENV_NAMES: readonly string[] = ["OP_BIOMETRIC_UNLOCK_ENABLED", "OP_ACCOUNT", "NO_COLOR"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function cleanString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim() && !/[\r\n]/.test(value);
}

export function parsePublishConfig(raw: string): PublishConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PublishRefusal("the publish config is not valid JSON");
  }
  if (!isRecord(parsed) || !onlyKeys(parsed, ["owners", "reviewers"])) {
    throw new PublishRefusal("the publish config must be an object holding only owners and reviewers");
  }
  if (!isRecord(parsed.owners) || Object.keys(parsed.owners).length === 0) {
    throw new PublishRefusal("the publish config declares no owners");
  }

  const owners: Record<string, OwnerIdentity> = {};
  for (const [owner, entry] of Object.entries(parsed.owners)) {
    if (!GH_USER_RE.test(owner)) throw new PublishRefusal("an owners key in the publish config is not a GitHub account name");
    if (!isRecord(entry) || !onlyKeys(entry, ["gitName", "gitEmail", "ghUser"])) {
      throw new PublishRefusal("an owner entry in the publish config may hold only gitName, gitEmail and ghUser");
    }
    if (!cleanString(entry.gitName)) throw new PublishRefusal("an owner entry's gitName is missing or blank");
    if (!cleanString(entry.gitEmail) || !EMAIL_RE.test(entry.gitEmail)) {
      throw new PublishRefusal("an owner entry's gitEmail is missing or not an address");
    }
    if (typeof entry.ghUser !== "string" || !GH_USER_RE.test(entry.ghUser)) {
      throw new PublishRefusal("an owner entry's ghUser is missing or not a GitHub account name");
    }
    owners[owner.toLowerCase()] = { gitName: entry.gitName, gitEmail: entry.gitEmail, ghUser: entry.ghUser };
  }

  const reviewers: Record<string, ReviewerConfig> = {};
  if (parsed.reviewers !== undefined) {
    if (!isRecord(parsed.reviewers)) throw new PublishRefusal("the publish config's reviewers must be an object");
    for (const [repo, entry] of Object.entries(parsed.reviewers)) {
      if (parseRepo(repo) === null) throw new PublishRefusal("a reviewers key in the publish config is not owner/name");
      if (!isRecord(entry) || !onlyKeys(entry, ["appId", "keyCommand", "keyCommandEnv", "checkout", "termsFile", "policyFile"])) {
        throw new PublishRefusal("a reviewer entry may hold only appId, keyCommand, keyCommandEnv, checkout, termsFile and policyFile");
      }
      if (typeof entry.appId !== "string" || !/^[0-9]{1,12}$/.test(entry.appId)) {
        throw new PublishRefusal("a reviewer entry's appId is missing or not numeric");
      }
      if (!Array.isArray(entry.keyCommand) || entry.keyCommand.length === 0 || !entry.keyCommand.every(cleanString)) {
        throw new PublishRefusal("a reviewer entry's keyCommand must be a non-empty array of non-empty strings");
      }
      const keyCommandEnv: Record<string, string> = {};
      if (entry.keyCommandEnv !== undefined) {
        if (!isRecord(entry.keyCommandEnv)) throw new PublishRefusal("a reviewer entry's keyCommandEnv must be an object");
        for (const [name, value] of Object.entries(entry.keyCommandEnv)) {
          if (!ENV_KEY_RE.test(name) || typeof value !== "string") {
            throw new PublishRefusal("a reviewer entry's keyCommandEnv must map variable names to strings");
          }
          if (!KEY_COMMAND_ENV_NAMES.includes(name)) {
            throw new PublishRefusal(
              `a reviewer entry's keyCommandEnv names a variable outside the permitted list (${KEY_COMMAND_ENV_NAMES.join(", ")}). The key command must fetch its own credential`,
            );
          }
          keyCommandEnv[name] = value;
        }
      }
      if (typeof entry.checkout !== "string" || !isAbsolute(entry.checkout)) {
        throw new PublishRefusal("a reviewer entry's checkout must be an absolute path");
      }
      if (typeof entry.termsFile !== "string" || !isAbsolute(entry.termsFile)) {
        throw new PublishRefusal("a reviewer entry's termsFile must be an absolute path to the personal-term list premerge reads");
      }
      if (entry.policyFile !== undefined && (typeof entry.policyFile !== "string" || !isAbsolute(entry.policyFile))) {
        throw new PublishRefusal("a reviewer entry's policyFile must be an absolute path to the reviewer's repository policy file");
      }
      reviewers[repo.toLowerCase()] = {
        appId: entry.appId,
        keyCommand: [...(entry.keyCommand as string[])],
        keyCommandEnv,
        checkout: entry.checkout,
        termsFile: entry.termsFile,
        policyFile: typeof entry.policyFile === "string" ? entry.policyFile : null,
      };
    }
  }
  return { owners, reviewers };
}

// path is a test seam. cli.ts never passes it.
export function loadPublishConfig(path: string = CONFIG_PATH): PublishConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new PublishRefusal("no publish config could be read at ~/.claude-publish/config.json (see tools/publish/README.md)");
  }
  return parsePublishConfig(raw);
}

export function ownerIdentity(config: PublishConfig, repo: string): OwnerIdentity {
  const owner = repo.split("/")[0]!.toLowerCase();
  // Own-property lookup: a plain object also answers for "constructor" and "__proto__", which would read as a declared owner.
  const identity = Object.hasOwn(config.owners, owner) ? config.owners[owner] : undefined;
  if (identity === undefined) throw new PublishRefusal("the publish config declares no identity for this repository's owner");
  return identity;
}

export function reviewerConfig(config: PublishConfig, repo: string): ReviewerConfig {
  const key = repo.toLowerCase();
  const reviewer = Object.hasOwn(config.reviewers, key) ? config.reviewers[key] : undefined;
  if (reviewer === undefined) throw new PublishRefusal("the publish config declares no reviewer for this repository");
  return reviewer;
}
