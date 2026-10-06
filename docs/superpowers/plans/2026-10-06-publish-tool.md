# Publish Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every issue, pull request and review-then-merge an agent publishes through one committed Bun tool whose gates fail closed, plus a skill and a permission rule that make it the only route (issue #274).

**Architecture:** `tools/publish/` is a Bun CLI in the style of `tools/pr-review/`, and it reuses that tool's identity matcher, severity lists, working-directory checks and checkout-state probe rather than copying them. Every process it starts goes through one `Runner` seam, so the suites script gh, git, the key command and the reviewer without touching any of them. The skill and the permission rule ship through the account layer, the only channel this repository has for either.

**Tech Stack:** Bun 1.3.14 (CI's pin), TypeScript run directly by Bun, `bun:test`, gh 2.89, git, PowerShell 7 with Pester 5 for one installer test.

**Spec:** GitHub issue #274 (`GH_TOKEN=$(gh auth token -u Cringely) gh issue view 274 -R Cringely/agent-harness-core`) plus the operator-approved design restated under "Design this plan implements" below. There is no separate spec file.

## Design this plan implements

Approved by the operator, 2026-10-06:

- `tools/publish/` (Bun, TypeScript) with subcommands for issue create and edit, pr create and edit, and review-merge.
- Create and edit always take an explicit repository and base, and read the body only from a file. They refuse, with exit 2 and a class-only message that never echoes matched text, on: an identity-scan hit in title or body (`tools/pr-review/identity.ts` plus a new Claude Code session-link pattern), an attribution line (Co-Authored-By, Generated with), closing keywords that differ from a declared `--closes` list (none declared means none allowed), closing keywords when the base is not the default branch, and an empty section of the repository's PR or issue template when one exists. Identity for git and gh comes from local configuration and the tool refuses when it is unset.
- review-merge waits with `gh pr checks --watch` (bounded), runs the App reviewer from a clean default-branch checkout it manages and from a working directory outside any checkout, and merges only on APPROVE, or by `--admin` only when the review reports zero findings at or above the floor, every check succeeded, and the head SHA equals the reviewed head. It parses the reviewer's `--json` output rather than its prose, and audits closing keywords in the body and the commit messages before merging.
- A skill carrying the body templates, the rule for when an issue is filed (fix-quality.md), and the rule that every publish goes through the tool.
- A permission rule denying raw `gh pr create`, `gh issue create` and `gh pr merge`, distributed the way the repository distributes other permission rules.
- Every gate fails closed when a dependency (gh, git, bun, config, reviewer) is missing. Tests pin each refusal and fail with the gate removed.

## Decisions this plan takes, with evidence

**Local configuration is one file, `~/.claude-publish/config.json`.** Chosen over git config keys because one file has to hold more than identity: per repository owner the git name, git email and gh account, and per repository the reviewer App's ID, the argv of the command that prints its key, that command's environment, and the reviewer checkout. It sits beside the existing `~/.claude-account-identity.json` convention and outside every repository. The tool's working directory is fixed beside it at `~/.claude-publish/work`.

**The tool runs as `bun --cwd <home>/.claude-publish/work <abs>/tools/publish/cli.ts`.** Measured on Bun 1.3.14 on this workstation, 2026-10-06: with a `bunfig.toml` preload and a `.env` in the launch directory, `bun --cwd <other dir> script.ts` loaded neither, and `process.cwd()` was the `--cwd` directory. This gives the same protection as `tools/pr-review`'s rule (BUN-CWD, `tools/pr-review/cli.ts:12-21`) without a shell `cd`, so one plain command works from an isolated worktree. The tool refuses unless its working directory is exactly that work directory, holds no `bunfig.toml` or `.env*`, and sits outside every git work tree.

**Skills and permission rules reach a project only through the account layer.** Evidence: `install/Install-Harness.ps1` installs agents, hooks and templates and merges only `hooks` from `core/claude/templates/settings.hooks.json` into a project's settings (`Install-Harness.ps1:1606` onward). It copies no skill and no permission rule. `/.claude/` is gitignored in this repository (`.gitignore`), so there is no committed project settings file either. The account layer does carry both: `install/AccountShared.ps1:42` mirrors `skills` from `~/.claude`, `account/claude/settings.account.json` carries `permissions`, and `install/Install-Account.ps1`'s `Merge-AccountSettings` unions `permissions.deny` into each machine's settings rather than replacing it. So the skill lives at `~/.claude/skills/publish/SKILL.md`, the six deny rules live in `~/.claude/settings.json`, and both reach `account/claude/` through `install/Export-Account.ps1`. The skill names the tool by its absolute path, so it needs an `$AccountTemplatedFiles` row that folds that path to `{{CORE_REPO}}`, and the exporter throws for a row whose file is absent or folds nothing (`Export-Account.ps1:804-861`). That is why the row, the live skill and the export land together in Task 11.

**The deny rule is a policy line, not a boundary.** Claude Code's permission docs (code.claude.com/docs/en/permissions, fetched 2026-10-06, reference tier) say a deny rule matches past any leading environment assignment and inside compound commands and command substitutions, but not the same program reached another way: `gh -R x pr create`, `gh api ... -X POST`, `sh -c '...'`. The skill says so and forbids routing around it. Task 12 confirms the env-prefixed case live.

**An administrator-bypass merge posts its reason first.** CONTRIBUTING.md:29 has every use of the bypass say why in the pull request. Automating the bypass without that would automate a breach of the documented process, so `--allow-admin` requires `--admin-reason-file`, the reason passes the same text gates as a body, and the tool comments it on the pull request immediately before the `--admin` merge. This is the one addition beyond the approved design.

**Only `SUCCESS` counts as a passing check.** The design says "every check succeeded". A `SKIPPED` or `NEUTRAL` conclusion therefore blocks review-merge. Measured on PR #271: all eight checks concluded `SUCCESS`, so this costs nothing today.

## Decisions for the operator before Task 11

1. The deny rules are user level, so they apply in every repository on every machine, the work account's included. In a repository whose owner has no entry in `~/.claude-publish/config.json`, an agent can then neither run raw gh publishing nor use the tool, and publishing there stops until an owner entry is added. That is fail-closed by design, and it may block work repositories. The smallest alternative is a project-level mechanism: teach `Install-Harness.ps1` to merge a `permissions.deny` fragment the way it merges hooks. This plan does not build it.
2. The "Generated with" gate refuses any body line that opens with those words after punctuation or an emoji. A legitimate line such as "Generated with the exporter, see below" is refused too. Mid-sentence prose passes.
3. review-merge refuses unless the checkout it runs from is clean, untracked files included, and at its origin's default branch head, because that code holds the token and makes the merge decision. The operator's working clone rarely meets that bar, so Task 12 sets up a dedicated clone at `~/.claude-publish/tool`, used as the reviewer checkout too, and the skill runs review-merge from it. One consequence: `tools/publish/` reaches the default branch only when this branch merges, so this branch's own pull request cannot pass through review-merge and is merged by the existing hand-run flow (Task 12, Step 4).

## Global Constraints

- Branch `feat/274-publish-tool`, cut from `origin/master`. Each task commits on it. Pushes are fast-forward only.
- Commit with `git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit ...`. No Co-Authored-By, no Claude-Session, no "Generated with", no claude.ai link in any commit, file or message. Never `--no-verify`. The repository's `commit-msg` and `pre-commit` hooks are live and refuse those.
- `bun test` from the repository root ends with `0 fail` after every task. Pester suites run as `pwsh -NoProfile -File install/<Name>.Tests.ps1`, never through `Invoke-Pester`.
- Never retype a code block from this plan. Lay each file down with the extractor below and compare the printed sha256 with the one under the block. Tool-call arguments decode backslash escapes, and several files here contain escape sequences (`\uFEFF`, `\u200B`, `\u{1F916}`) that must stay escape text.
- Do not modify anything under `tools/pr-review/`. Import from it: `identity.ts` (`findIdentityHits`, `loadIdentity`, `IdentityDecl`, `IdentityLoad`), `types.ts` (`parseRepo`, `SHA_RE`, `BELOW_FLOOR_SEVERITIES`), `cli.ts` (`cwdHasAutoloadFile`, `stripControlChars`), `tool-state.ts` (`toolState`).
- Fixture identities are synthetic only: `Fixture Person`, `fixture@example.test`, `fixtureuser`, `fixture-host`, repository `fixture-owner/fixture-repo`. No real name, email, App ID, secret reference or machine path appears in a test, a log or a message. A session-link fixture is assembled from parts so no committed file holds a whole link.
- Every refusal is a `PublishRefusal` (exit 2) whose message names a class and never the text that tripped it. Usage errors are `UsageError` (exit 1). A dependency failing partway is `PublishError` (exit 1).
- `tools/publish/` is repository tooling like `tools/pr-review/`. Nothing under `install/` copies it.
- Prose in comments and docs: no em dashes, no semicolons.

### Laying down a file from this plan

Each code block below is preceded by a `<!-- file: <marker> -->` line. From the worktree root, write the block for `<marker>` to its repository path (or to `<out>` when given) and print its sha256:

```bash
bun -e 'const fs=require("fs");const [plan,target,out]=process.argv.slice(1);const NL=String.fromCharCode(10),CR=String.fromCharCode(13);const lines=fs.readFileSync(plan,"utf8").split(NL).map(l=>l.endsWith(CR)?l.slice(0,-1):l);const at=lines.indexOf("<!-- file: "+target+" -->");if(at<0||!lines[at+1].startsWith("````"))throw new Error("no block for "+target);const end=lines.indexOf("````",at+2);const dest=out??target;fs.mkdirSync(require("path").dirname(dest),{recursive:true});fs.writeFileSync(dest,lines.slice(at+2,end).join(NL)+NL);console.log(require("crypto").createHash("sha256").update(fs.readFileSync(dest)).digest("hex"));' docs/superpowers/plans/2026-10-06-publish-tool.md <marker> [<out>]
```

A printed hash that differs from the block's expected sha256 means the file is wrong. Stop and re-extract rather than editing it by hand.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `tools/publish/errors.ts` | `PublishRefusal`, `UsageError`, `PublishError` | 1 |
| `tools/publish/config.ts` | Reads and validates `~/.claude-publish/config.json`, and looks up owners and reviewers | 1 |
| `tools/publish/exec.ts` | `Runner` seam, `realRunner`, `childEnv` (drops inherited GitHub tokens), the key pipe | 2 |
| `tools/publish/scan.ts` | Identity, session-link and attribution gates, plus closing-keyword parsing and comparison | 3 |
| `tools/publish/template.ts` | Template sections and the unfilled-section check | 4 |
| `tools/publish/gh.ts` | Every gh call, under the configured account's token | 5 |
| `tools/publish/publish.ts` | issue create/edit and pr create/edit, gates in fixed order | 6 |
| `tools/publish/merge-decision.ts` | Parses the reviewer's `--json` output and decides merge, bypass or refuse | 7 |
| `tools/publish/review-merge.ts` | CI wait, reviewer checkout, reviewer run, audit, merge | 8 |
| `tools/publish/cli.ts` | Argument parsing, working-directory guard, exit codes | 9 |
| `tools/publish/README.md` | Setup, commands, gates, limits | 10 |
| `test/publish-fakes.ts` | Scripted `Runner` and fixtures shared by the suites (not a test file) | 5 |
| `test/publish-*.test.ts` | One suite per module | 1-9 |
| `test/publish-permission-rule.test.ts` | Pins the deny rules and skill in `account/claude/` | 11 |
| `.github/CODEOWNERS` | Owns `/tools/publish/` like `/tools/pr-review/` | 1 |
| `README.md`, `CONTRIBUTING.md` | Living docs updated for the new route | 10 |
| `install/AccountShared.ps1`, `install/Export-Account.Tests.ps1` | Templated-file row and fixture for the skill | 11 |
| `~/.claude/skills/publish/SKILL.md`, `~/.claude/settings.json` | Live account layer: the skill and the deny rules | 11 |

## Review Focus

Five inputs the design implies but does not name, most likely to bite first. Each has its test in the owning task.

1. A body file saved with a UTF-8 byte-order mark, as Windows PowerShell 5.1's `Set-Content` writes: the template check must still find the first heading. Test in Task 4.
2. A body with CRLF line endings: template sections and the attribution gate must still match. Tests in Tasks 3 and 4.
3. A body path in Git Bash form (`/c/Users/...`) on Windows: the tool must read that file, not one at the current drive's root. Test in Task 6.
4. review-merge run straight after a push, before CI registers any check: refuse with "0 total" and never run the reviewer. Test in Task 8.
5. A pull request title carrying "Fixes #12": a `--merge` merge commit carries the title in its message, and a closing keyword in any commit message reaching the default branch closes its issue. So the title counts against `--closes` like the body, and an undeclared one refuses. Tests in Tasks 6 and 8.

---

### Task 1: Errors, local configuration, and code ownership

**Security-bearing:** yes. The config names the identity every publish uses and the command that prints the App's key.

**Files:**
- Create: `tools/publish/errors.ts`
- Create: `tools/publish/config.ts`
- Create: `test/publish-config.test.ts`
- Modify: `.github/CODEOWNERS` (add one line after line 15)

**Interfaces:**
- Consumes: `parseRepo(repo: string): { owner: string; name: string } | null` from `tools/pr-review/types.ts`.
- Produces:
  - `class PublishRefusal extends Error`, `class UsageError extends Error`, `class PublishError extends Error` (errors.ts)
  - `PUBLISH_HOME: string`, `CONFIG_PATH: string`, `WORK_DIR: string`
  - `interface OwnerIdentity { gitName: string; gitEmail: string; ghUser: string }`
  - `interface ReviewerConfig { appId: string; keyCommand: string[]; keyCommandEnv: Record<string, string>; checkout: string }`
  - `interface PublishConfig { owners: Record<string, OwnerIdentity>; reviewers: Record<string, ReviewerConfig> }` (keys lowercased)
  - `GH_USER_RE: RegExp`
  - `parsePublishConfig(raw: string): PublishConfig` (throws `PublishRefusal`)
  - `loadPublishConfig(path?: string): PublishConfig`
  - `ownerIdentity(config: PublishConfig, repo: string): OwnerIdentity`
  - `reviewerConfig(config: PublishConfig, repo: string): ReviewerConfig`

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-config.test.ts -->
````ts
// Tests for tools/publish/config.ts (#274): the local file naming the git and gh identity per
// repository owner and the reviewer per repository. Every refusal below is pinned, and every
// refusal message is checked for the value that tripped it. All identities are synthetic.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPublishConfig,
  ownerIdentity,
  parsePublishConfig,
  reviewerConfig,
} from "../tools/publish/config";
import { PublishRefusal } from "../tools/publish/errors";

const OWNER = { gitName: "fixture-owner", gitEmail: "fixture-owner@users.noreply.example.test", ghUser: "fixture-owner" };
const REVIEWER = { appId: "1", keyCommand: ["fixture-key-cmd", "--print"], keyCommandEnv: { FIXTURE_FLAG: "false" }, checkout: join(tmpdir(), "fixture-checkout") };

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ owners: { "fixture-owner": OWNER }, reviewers: { "fixture-owner/fixture-repo": REVIEWER }, ...overrides });
}

function refusal(raw: string): string {
  try {
    parsePublishConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(PublishRefusal);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("parsePublishConfig()", () => {
  test("parses a full config and looks owners and repos up case-insensitively", () => {
    const parsed = parsePublishConfig(config());
    expect(ownerIdentity(parsed, "Fixture-Owner/fixture-repo")).toEqual(OWNER);
    expect(reviewerConfig(parsed, "FIXTURE-OWNER/Fixture-Repo")).toEqual(REVIEWER);
  });

  test("accepts a config with no reviewers", () => {
    const parsed = parsePublishConfig(JSON.stringify({ owners: { "fixture-owner": OWNER } }));
    expect(parsed.reviewers).toEqual({});
  });

  test("refuses text that is not JSON", () => {
    expect(refusal("{ not json")).toContain("not valid JSON");
  });

  test("refuses an unknown top-level key", () => {
    expect(refusal(config({ extra: 1 }))).toContain("only owners and reviewers");
  });

  test("refuses a config with no owners", () => {
    expect(refusal(JSON.stringify({ owners: {} }))).toContain("declares no owners");
  });

  test("refuses an owner entry with an extra key", () => {
    expect(refusal(config({ owners: { "fixture-owner": { ...OWNER, token: "zzsecret9" } } }))).toContain("only gitName, gitEmail and ghUser");
  });

  test("refuses a blank gitName", () => {
    expect(refusal(config({ owners: { "fixture-owner": { ...OWNER, gitName: "  " } } }))).toContain("gitName");
  });

  test("refuses a gitEmail that is not an address, without echoing it", () => {
    const message = refusal(config({ owners: { "fixture-owner": { ...OWNER, gitEmail: "not-an-address-zz9" } } }));
    expect(message).toContain("gitEmail");
    expect(message).not.toContain("zz9");
  });

  test("refuses a ghUser carrying shell metacharacters", () => {
    expect(refusal(config({ owners: { "fixture-owner": { ...OWNER, ghUser: "a;touch x" } } }))).toContain("ghUser");
  });

  test("refuses a non-numeric appId without echoing it", () => {
    const message = refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, appId: "zz-app" } } }));
    expect(message).toContain("appId");
    expect(message).not.toContain("zz-app");
  });

  test("refuses an empty keyCommand", () => {
    expect(refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, keyCommand: [] } } }))).toContain("keyCommand");
  });

  test("refuses a keyCommandEnv with a malformed variable name", () => {
    expect(refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, keyCommandEnv: { "bad name": "x" } } } }))).toContain(
      "keyCommandEnv",
    );
  });

  test("refuses a keyCommandEnv variable named like a secret, without echoing its value", () => {
    for (const name of ["OP_SERVICE_ACCOUNT_TOKEN", "CLIENT_SECRET", "API_KEY", "DB_PASSWORD"]) {
      const message = refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, keyCommandEnv: { [name]: "zzsecret9" } } } }));
      expect(message).toContain("marks a secret");
      expect(message).not.toContain("zzsecret9");
    }
  });

  test("refuses a relative checkout path", () => {
    expect(refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, checkout: "relative/dir" } } }))).toContain("checkout");
  });

  test("refuses a reviewers key that is not owner/name", () => {
    expect(refusal(config({ reviewers: { "not-a-repo": REVIEWER } }))).toContain("owner/name");
  });
});

describe("lookups", () => {
  test("ownerIdentity refuses an owner the config does not declare", () => {
    expect(() => ownerIdentity(parsePublishConfig(config()), "someone-else/repo")).toThrow(PublishRefusal);
  });

  test("reviewerConfig refuses a repository the config does not declare", () => {
    expect(() => reviewerConfig(parsePublishConfig(config()), "fixture-owner/other-repo")).toThrow(PublishRefusal);
  });

  test("ownerIdentity refuses an owner named like an inherited property", () => {
    for (const owner of ["constructor", "__proto__", "toString"]) {
      expect(() => ownerIdentity(parsePublishConfig(config()), `${owner}/repo`)).toThrow(PublishRefusal);
    }
  });

  test("reviewerConfig refuses a repository key named like an inherited property", () => {
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(() => reviewerConfig(parsePublishConfig(config()), key)).toThrow(PublishRefusal);
    }
  });
});

describe("loadPublishConfig()", () => {
  test("refuses a missing file without naming the path it tried", () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    let message = "";
    try {
      loadPublishConfig(path);
    } catch (error) {
      expect(error).toBeInstanceOf(PublishRefusal);
      message = (error as Error).message;
    }
    expect(message).toContain("no publish config");
    expect(message).not.toContain(dir);
  });

  test("reads and parses a present file", () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, config());
    expect(ownerIdentity(loadPublishConfig(path), "fixture-owner/fixture-repo").ghUser).toBe("fixture-owner");
  });
});
````

Expected sha256 of the extracted file: `450ba20dc2db323124002e7b7a9adc48025cb8bfb7c931733b2f94a6c3683045`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-config.test.ts`
Expected: FAIL, with an error that `../tools/publish/config` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/errors.ts -->
````ts
// The three ways a tools/publish command ends without success (#274). cli.ts maps each to an exit
// code by type, never by message: PublishRefusal is 2 (a gate refused, nothing new was published),
// UsageError is 1 (bad arguments), PublishError is 1 (a dependency failed mid-run, and a step may
// already have happened, and its message says which). Every message is written by this tool and names
// a class of problem, never the text that tripped it.

export class PublishRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRefusal";
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}
````

Expected sha256 of the extracted file: `6e5fe5e9f5d122eaaad92d18729798c3f01eefd6ad5d8901ddbbdd781b02d953`

<!-- file: tools/publish/config.ts -->
````ts
// Local configuration for tools/publish (#274), read from ~/.claude-publish/config.json. It names,
// per repository owner, the git and gh identity every command uses, and, per repository, the
// command that prints the reviewer App's private key, the App's ID and the reviewer checkout. None
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
// live there. The key command fetches its own (tools/publish/README.md shows a wrapper that
// decrypts one into its child's environment), and a variable named like a secret is refused.
const SECRET_NAME_RE = /TOKEN|SECRET|KEY|PASSWORD/;
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
      if (!isRecord(entry) || !onlyKeys(entry, ["appId", "keyCommand", "keyCommandEnv", "checkout"])) {
        throw new PublishRefusal("a reviewer entry may hold only appId, keyCommand, keyCommandEnv and checkout");
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
          if (SECRET_NAME_RE.test(name)) {
            throw new PublishRefusal(
              "a reviewer entry's keyCommandEnv names a variable that marks a secret (TOKEN, SECRET, KEY or PASSWORD). The key command must fetch its own credential",
            );
          }
          keyCommandEnv[name] = value;
        }
      }
      if (typeof entry.checkout !== "string" || !isAbsolute(entry.checkout)) {
        throw new PublishRefusal("a reviewer entry's checkout must be an absolute path");
      }
      reviewers[repo.toLowerCase()] = {
        appId: entry.appId,
        keyCommand: [...(entry.keyCommand as string[])],
        keyCommandEnv,
        checkout: entry.checkout,
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
````

Expected sha256 of the extracted file: `934740220af863d3a2c56aa72bba674279ec0d15f1d2c4ce701521f3413f040b`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-config.test.ts`
Expected: `21 pass`, `0 fail`.

- [ ] **Step 5: Ablate**

First, in `tools/publish/config.ts`, change `if (typeof entry.ghUser !== "string" || !GH_USER_RE.test(entry.ghUser)) {` to `if (typeof entry.ghUser !== "string") {`. Run `bun test test/publish-config.test.ts`. Expected: `refuses a ghUser carrying shell metacharacters` fails. Restore.

Second, change `if (SECRET_NAME_RE.test(name)) {` to `if (false) {`. Expected: `refuses a keyCommandEnv variable named like a secret, without echoing its value` fails. Restore the line and re-run to `21 pass`.

Third, in `ownerIdentity`, change `Object.hasOwn(config.owners, owner) ? config.owners[owner] : undefined` to `config.owners[owner]`. Expected: `ownerIdentity refuses an owner named like an inherited property` fails. Restore. Fourth, in `reviewerConfig`, change `Object.hasOwn(config.reviewers, key) ? config.reviewers[key] : undefined` to `config.reviewers[key]`. Expected: `reviewerConfig refuses a repository key named like an inherited property` fails. Restore and re-run to `21 pass`.

- [ ] **Step 6: Own the new path**

In `.github/CODEOWNERS`, insert after the line `/tools/pr-review/                           @Cringely` this line (the path, then spaces to column 45, then the owner):

```
/tools/publish/                             @Cringely
```

The tool is an enforcement path: a change that weakens a gate needs the operator's review, the same reasoning that owns `/tools/pr-review/`.

- [ ] **Step 7: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 8: Commit**

```bash
git add tools/publish/errors.ts tools/publish/config.ts test/publish-config.test.ts .github/CODEOWNERS
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): local config for publish identity and reviewer (#274)

The publish tool needs a git and gh identity per repository owner and,
per repository, the reviewer App's ID and the command that prints its
key. None of that may be committed, so it lives in
~/.claude-publish/config.json and every missing or malformed field is a
refusal naming the field, never its value. Git config keys were
rejected because one file has to hold the reviewer entry as well.
keyCommandEnv refuses a variable named like a secret, because that
file is plain text: the key command fetches its own credential.
CODEOWNERS now owns tools/publish/ like tools/pr-review/."
```

### Task 2: The process seam

**Security-bearing:** yes. It decides which token a child process sees and carries the App key from the key command to the reviewer.

**Files:**
- Create: `tools/publish/exec.ts`
- Create: `test/publish-exec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface RunResult { code: number | null; stdout: string; stderr: string; spawnError: boolean; timedOut: boolean }`
  - `interface RunOptions { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }`
  - `interface PipeSpec { argv: string[]; cwd: string; env: Record<string, string> }`
  - `interface PipedResult { producerCode: number | null; producerSpawnError: boolean; consumer: RunResult }`
  - `interface Runner { run(argv: readonly string[], options?: RunOptions): RunResult; runPiped(producer: PipeSpec, consumer: PipeSpec & { timeoutMs: number }): Promise<PipedResult> }`
  - `childEnv(base: Record<string, string | undefined>, extra?: Record<string, string>): Record<string, string>`
  - `realRunner: Runner`

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-exec.test.ts -->
````ts
// Tests for tools/publish/exec.ts (#274). These start real child processes, using the bun binary
// running this suite (process.execPath) as the child, so they need no gh, git or key.

import { describe, expect, test } from "bun:test";
import { childEnv, realRunner } from "../tools/publish/exec";

const BUN = process.execPath;

describe("childEnv()", () => {
  test("drops every GitHub token variable, whatever its case", () => {
    const env = childEnv({ GH_TOKEN: "a", gh_token: "b", GITHUB_TOKEN: "c", GH_ENTERPRISE_TOKEN: "d", GITHUB_ENTERPRISE_TOKEN: "e", KEEP: "1" });
    expect(env).toEqual({ KEEP: "1" });
  });

  test("adds the extras after the drop, so a caller's chosen token survives", () => {
    expect(childEnv({ GH_TOKEN: "inherited" }, { GH_TOKEN: "chosen" })).toEqual({ GH_TOKEN: "chosen" });
  });

  test("skips undefined values", () => {
    expect(childEnv({ A: undefined, B: "2" })).toEqual({ B: "2" });
  });
});

describe("realRunner.run()", () => {
  test("returns stdout and the exit code", () => {
    const result = realRunner.run([BUN, "-e", "process.stdout.write('out'); process.exit(3)"]);
    expect(result).toMatchObject({ code: 3, stdout: "out", spawnError: false, timedOut: false });
  });

  test("feeds stdin", () => {
    const result = realRunner.run([BUN, "-e", "process.stdout.write((await Bun.stdin.text()).toUpperCase())"], { stdin: "body text" });
    expect(result.stdout).toBe("BODY TEXT");
  });

  test("passes only the env it is given", () => {
    const result = realRunner.run([BUN, "-e", "process.stdout.write(String(process.env.GH_TOKEN ?? 'unset'))"], {
      env: childEnv({ ...process.env, GH_TOKEN: "inherited" }),
    });
    expect(result.stdout).toBe("unset");
  });

  test("reports a missing executable as spawnError instead of throwing", () => {
    expect(realRunner.run(["zz-no-such-binary-274"])).toMatchObject({ spawnError: true, code: null });
  });

  test("reports a timeout", () => {
    const result = realRunner.run([BUN, "-e", "await Bun.sleep(5000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });
});

describe("realRunner.runPiped()", () => {
  test("moves the producer's stdout into the consumer's stdin", async () => {
    const env = childEnv(process.env);
    const result = await realRunner.runPiped(
      { argv: [BUN, "-e", "process.stdout.write('twelve bytes')"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "process.stdout.write(String((await Bun.stdin.text()).length))"], cwd: process.cwd(), env, timeoutMs: 10_000 },
    );
    expect(result.producerCode).toBe(0);
    expect(result.consumer).toMatchObject({ code: 0, stdout: "12", spawnError: false });
  });

  test("reports the producer's own exit code", async () => {
    const env = childEnv(process.env);
    const result = await realRunner.runPiped(
      { argv: [BUN, "-e", "process.exit(5)"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "await Bun.stdin.text()"], cwd: process.cwd(), env, timeoutMs: 10_000 },
    );
    expect(result.producerCode).toBe(5);
  });

  // A key command that hangs (an authorization prompt nobody answers) must not hold review-merge
  // open after the reviewer has been killed at its timeout.
  test("kills a producer still running when the consumer times out", async () => {
    const env = childEnv(process.env);
    const started = Date.now();
    const result = await realRunner.runPiped(
      { argv: [BUN, "-e", "await Bun.sleep(6000)"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "await Bun.stdin.text()"], cwd: process.cwd(), env, timeoutMs: 500 },
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.consumer.timedOut).toBe(true);
    expect(result.producerCode).not.toBe(0);
  });

  test("reports a producer that cannot start", async () => {
    const env = childEnv(process.env);
    const result = await realRunner.runPiped(
      { argv: ["zz-no-such-binary-274"], cwd: process.cwd(), env },
      { argv: [BUN, "-e", "0"], cwd: process.cwd(), env, timeoutMs: 10_000 },
    );
    expect(result.producerSpawnError).toBe(true);
    expect(result.consumer.spawnError).toBe(true);
  });
});
````

Expected sha256 of the extracted file: `ce8aafc268c14bb93883cceec389a4e37b121fade31fc8d806a907312b76e1b3`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-exec.test.ts`
Expected: FAIL, `../tools/publish/exec` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/exec.ts -->
````ts
// The one place tools/publish starts another process (#274). Everything else goes through the
// Runner interface, so tests replace it with a scripted fake and never touch gh, git or a key.
//
// A child never inherits a GitHub token from this process's environment: childEnv drops every
// variable gh or git would read one from, and the caller adds back the token it chose for the
// configured account. That is what keeps the active gh account (a different identity on the
// operator's workstation) out of every call.
//
// runPiped moves the key command's stdout straight into the reviewer's stdin. The key passes
// through this process as a byte stream Bun forwards, and is never held in a variable here.

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  // The executable could not be started at all (not on PATH). Callers treat it as a missing
  // dependency and refuse.
  spawnError: boolean;
  // Killed for overrunning timeoutMs (runPiped: killed by any signal).
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface PipeSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface PipedResult {
  producerCode: number | null;
  producerSpawnError: boolean;
  consumer: RunResult;
}

export interface Runner {
  run(argv: readonly string[], options?: RunOptions): RunResult;
  runPiped(producer: PipeSpec, consumer: PipeSpec & { timeoutMs: number }): Promise<PipedResult>;
}

const TOKEN_VARS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

export function childEnv(base: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || TOKEN_VARS.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

const NOT_STARTED: RunResult = { code: null, stdout: "", stderr: "", spawnError: true, timedOut: false };

export const realRunner: Runner = {
  run(argv, options = {}) {
    try {
      const result = Bun.spawnSync([...argv], {
        cwd: options.cwd,
        env: options.env ?? childEnv(process.env),
        stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeoutMs,
      });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        spawnError: false,
        timedOut: result.exitedDueToTimeout === true,
      };
    } catch {
      // Bun throws "Executable not found in $PATH" rather than returning a code (measured on
      // Bun 1.3.14).
      return { ...NOT_STARTED };
    }
  },

  async runPiped(producer, consumer) {
    let producerProc: ReturnType<typeof Bun.spawn>;
    try {
      producerProc = Bun.spawn(producer.argv, { cwd: producer.cwd, env: producer.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    } catch {
      return { producerCode: null, producerSpawnError: true, consumer: { ...NOT_STARTED } };
    }
    let consumerProc: ReturnType<typeof Bun.spawn>;
    try {
      consumerProc = Bun.spawn(consumer.argv, {
        cwd: consumer.cwd,
        env: consumer.env,
        stdin: producerProc.stdout as ReadableStream<Uint8Array>,
        stdout: "pipe",
        stderr: "pipe",
        timeout: consumer.timeoutMs,
      });
    } catch {
      producerProc.kill();
      return { producerCode: await producerProc.exited, producerSpawnError: false, consumer: { ...NOT_STARTED } };
    }
    const [stdout, stderr, consumerCode] = await Promise.all([
      new Response(consumerProc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(consumerProc.stderr as ReadableStream<Uint8Array>).text(),
      consumerProc.exited,
    ]);
    // The consumer has exited or been killed at its timeout. A producer still running now, such as a
    // key command stalled on an authorization prompt, would hold this await open with no bound, so
    // it is killed here. One that already exited keeps its own exit code.
    producerProc.kill();
    const producerCode = await producerProc.exited;
    return {
      producerCode,
      producerSpawnError: false,
      consumer: { code: consumerCode, stdout, stderr, spawnError: false, timedOut: consumerProc.signalCode !== null },
    };
  },
};
````

Expected sha256 of the extracted file: `ab7d4a472ea1a5b7b0c688a84403c981e15a886283fde8c9fba5d600bea88e1d`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-exec.test.ts`
Expected: `12 pass`, `0 fail`. The suite starts real child processes using the running bun binary. The timeout test takes about half a second, and the rest under a second together.

- [ ] **Step 5: Ablate**

First, in `childEnv`, change `if (value === undefined || TOKEN_VARS.has(name.toUpperCase())) continue;` to `if (value === undefined) continue;`. Run the suite. Expected: `drops every GitHub token variable, whatever its case` and `passes only the env it is given` fail. Restore.

Second, in `runPiped`, delete the line `producerProc.kill();` that follows the consumer's `Promise.all`. Expected: `kills a producer still running when the consumer times out` fails at bun's 5-second test timeout (measured 2026-10-06), because the await on the sleeping producer has no bound. Restore and re-run to `12 pass`.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add tools/publish/exec.ts test/publish-exec.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): one seam for every child process (#274)

Every gh, git, key-command and reviewer process goes through a Runner,
so the suites script them all. childEnv drops every inherited GitHub
token variable, which keeps the active gh account out of each call.
runPiped hands the key command's stdout straight to the reviewer's
stdin, so the key is never held in a variable here. Once the reviewer
exits or is killed at its timeout, runPiped kills a key command still
running, so one stalled on an authorization prompt cannot hold
review-merge open forever. Bun 1.3.14 throws on a missing executable
rather than returning a code, measured, so run() reports that as
spawnError."
```

### Task 3: Text gates and closing keywords

**Security-bearing:** yes. These are the identity, session-link and attribution gates.

**Files:**
- Create: `tools/publish/scan.ts`
- Create: `test/publish-scan.test.ts`

**Interfaces:**
- Consumes: `UsageError` (Task 1). `findIdentityHits(text: string, decl: IdentityDecl): string[]` and `IdentityDecl` from `tools/pr-review/identity.ts`.
- Produces:
  - `interface TextField { label: string; text: string }`
  - `scanText(fields: readonly TextField[], identity: IdentityDecl): string[]` (labels such as `body: session link`)
  - `interface ClosingRef { repo: string; number: number }` (repo lowercased)
  - `findClosingRefs(text: string, repo: string): ClosingRef[]`
  - `parseClosesList(value: string | undefined): number[]` (throws `UsageError`)
  - `compareClosing(found: readonly ClosingRef[], declared: readonly number[], repo: string): { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-scan.test.ts -->
````ts
// Tests for tools/publish/scan.ts (#274). Every identity is synthetic. The session-link fixture is
// assembled from parts so no committed file carries a whole link.

import { describe, expect, test } from "bun:test";
import type { IdentityDecl } from "../tools/pr-review/identity";
import { UsageError } from "../tools/publish/errors";
import { compareClosing, findClosingRefs, parseClosesList, scanText } from "../tools/publish/scan";

const DECL: IdentityDecl = { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "fixtureuser", hostname: "fixture-host" };
const REPO = "fixture-owner/fixture-repo";
const SESSION_LINK = "https://" + ["claude", "ai"].join(".") + "/code/session_" + "0123456789abcdef";

const scanBody = (text: string) => scanText([{ label: "body", text }], DECL);

describe("scanText()", () => {
  test("passes clean text", () => {
    expect(scanBody("## Why\n\nThe retry loop never waited.\n")).toEqual([]);
  });

  test("reports a declared name by class and never by value", () => {
    const hits = scanBody("Reported by Fixture Person.");
    expect(hits).toEqual(["body: declared name #1"]);
    expect(hits.join(" ")).not.toContain("Fixture Person");
  });

  test("reports the workstation username", () => {
    expect(scanBody("path C:/Users/fixtureuser/x")).toContain("body: workstation username");
  });

  test("reports a Claude Code session link", () => {
    expect(SESSION_LINK.includes("/code/session_0123")).toBe(true);
    expect(scanBody(`See ${SESSION_LINK}`)).toEqual(["body: session link"]);
  });

  test("reports a session link split by a zero-width character", () => {
    const hidden = SESSION_LINK.replace("/code/", "/co\u200Bde/");
    expect(scanBody(hidden)).toEqual(["body: session link"]);
  });

  test("reports a Co-Authored-By line whoever it names", () => {
    expect(scanBody("Fix.\n\nCo-Authored-By: Someone <someone@example.test>\n")).toEqual(["body: Co-Authored-By line"]);
  });

  // Review Focus 2: a body written with CRLF line endings.
  test("reports a Co-Authored-By line in a CRLF body", () => {
    expect(scanBody("Fix.\r\n\r\nCo-Authored-By: Someone <someone@example.test>\r\n")).toEqual(["body: Co-Authored-By line"]);
  });

  test("reports a Claude-Session line", () => {
    expect(scanBody("Fix.\n\nClaude-Session: abc\n")).toEqual(["body: Claude-Session line"]);
  });

  test("reports a line opening with Generated with, after an emoji", () => {
    expect(scanBody("Body\n\n\u{1F916} Generated with a tool\n")).toEqual(["body: Generated-with line"]);
  });

  test("leaves mid-sentence prose about generation alone", () => {
    expect(scanBody("The payload is generated with the exporter.")).toEqual([]);
  });

  test("labels hits by field", () => {
    expect(scanText([{ label: "title", text: "fixture-host fix" }, { label: "body", text: "clean" }], DECL)).toEqual(["title: machine hostname"]);
  });
});

describe("findClosingRefs()", () => {
  test("reads every keyword form GitHub accepts", () => {
    const text = "Closes #1\nfixed: #2\nResolves fixture-owner/fixture-repo#3\nfix https://github.com/fixture-owner/fixture-repo/issues/4\ncloses GH-5";
    expect(findClosingRefs(text, REPO).map((ref) => ref.number)).toEqual([1, 2, 3, 4, 5]);
  });

  test("normalises the repository and reads a cross-repository reference", () => {
    expect(findClosingRefs("Fixes Other-Owner/Other#9", REPO)).toEqual([{ repo: "other-owner/other", number: 9 }]);
  });

  test("ignores plain references and words that only contain a keyword", () => {
    expect(findClosingRefs("See #12. Prefixes #13. Closing #14.", REPO)).toEqual([]);
  });

  test("counts keywords inside code spans too", () => {
    expect(findClosingRefs("Write `fixes #20` to close one.", REPO)).toHaveLength(1);
  });
});

describe("parseClosesList()", () => {
  test("parses and dedupes", () => {
    expect(parseClosesList("12, 34,12")).toEqual([12, 34]);
  });

  test("treats absent and empty as nothing declared", () => {
    expect(parseClosesList(undefined)).toEqual([]);
    expect(parseClosesList("")).toEqual([]);
  });

  test("rejects anything else", () => {
    expect(() => parseClosesList("#12")).toThrow(UsageError);
    expect(() => parseClosesList("0")).toThrow(UsageError);
  });
});

describe("compareClosing()", () => {
  test("accepts an exact match", () => {
    expect(compareClosing(findClosingRefs("Closes #12", REPO), [12], REPO)).toEqual({ ok: true });
  });

  test("accepts no keywords and nothing declared", () => {
    expect(compareClosing([], [], REPO)).toEqual({ ok: true });
  });

  test("refuses an undeclared keyword", () => {
    expect(compareClosing(findClosingRefs("Closes #12", REPO), [], REPO)).toEqual({
      ok: false,
      reason: "closing keywords do not match --closes (undeclared: 1, missing: 0)",
    });
  });

  test("refuses a declared issue the text never closes", () => {
    expect(compareClosing([], [12], REPO)).toEqual({ ok: false, reason: "closing keywords do not match --closes (undeclared: 0, missing: 1)" });
  });

  test("refuses a keyword naming another repository even when the number is declared", () => {
    expect(compareClosing(findClosingRefs("Closes other/repo#12", REPO), [12], REPO)).toMatchObject({ ok: false });
  });
});
````

Expected sha256 of the extracted file: `05e8bd1f2f8f17fff77ec43b4a3968be7bcbf939a6bddc6431a90494d3c9b969`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-scan.test.ts`
Expected: FAIL, `../tools/publish/scan` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/scan.ts -->
````ts
// The text gates every publish runs before anything leaves the machine (#274).
//
// scanText refuses identifying strings (the PR reviewer's matcher, tools/pr-review/identity.ts,
// reused rather than copied), a Claude Code session link, and an attribution line. Hits come back
// as "<field>: <class>" labels and never as the matched text, so a refusal cannot republish what it
// caught. The session link and attribution checks also run over a copy with invisible characters
// removed, so a zero-width character inside the URL or the trailer does not slip past.
//
// findClosingRefs reads GitHub's closing keywords (close, closes, closed, fix, fixes, fixed,
// resolve, resolves, resolved) followed by an issue reference. It deliberately counts keywords
// inside code spans and fences too: that can refuse a body GitHub would not act on, never the
// reverse.

import { findIdentityHits, type IdentityDecl } from "../pr-review/identity";
import { UsageError } from "./errors";

export interface TextField {
  label: string;
  text: string;
}

const SESSION_LINK_RE = /claude\.ai\/code\/session_/i;

const ATTRIBUTION: ReadonlyArray<readonly [string, RegExp]> = [
  ["Co-Authored-By line", /^[ \t>]*co-authored-by[ \t]*:/im],
  ["Claude-Session line", /^[ \t>]*claude-session[ \t]*:/im],
  // A line opening with "Generated with", after any run of non-letters (an emoji, a bullet, a
  // quote marker). Mid-sentence prose ("the file is generated with bun") does not match.
  ["Generated-with line", /^[^\p{L}\p{N}\n]*generated with\b/imu],
];

function stripInvisible(text: string): string {
  return text.normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, "");
}

export function scanText(fields: readonly TextField[], identity: IdentityDecl): string[] {
  const hits = new Set<string>();
  for (const { label, text } of fields) {
    const visible = stripInvisible(text);
    for (const hit of findIdentityHits(text, identity)) hits.add(`${label}: ${hit}`);
    if (SESSION_LINK_RE.test(text) || SESSION_LINK_RE.test(visible)) hits.add(`${label}: session link`);
    for (const [cls, re] of ATTRIBUTION) {
      if (re.test(text) || re.test(visible)) hits.add(`${label}: ${cls}`);
    }
  }
  return [...hits];
}

export interface ClosingRef {
  repo: string;
  number: number;
}

const CLOSING_RE =
  /(?<![A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![A-Za-z0-9_])[ \t]*:?[ \t]*(?:#(\d+)|gh-(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+))/gi;

export function findClosingRefs(text: string, repo: string): ClosingRef[] {
  const refs: ClosingRef[] = [];
  for (const match of text.matchAll(CLOSING_RE)) {
    const [, hash, gh, crossRepo, crossNumber, urlRepo, urlNumber] = match;
    const target = (crossRepo ?? urlRepo ?? repo).toLowerCase();
    const number = Number(hash ?? gh ?? crossNumber ?? urlNumber);
    refs.push({ repo: target, number });
  }
  return refs;
}

// "--closes 12,34". An absent or empty value declares nothing, so no closing keyword is allowed.
export function parseClosesList(value: string | undefined): number[] {
  if (value === undefined || value.trim() === "") return [];
  const numbers = value.split(",").map((part) => part.trim());
  if (!numbers.every((part) => /^[1-9][0-9]{0,9}$/.test(part))) {
    throw new UsageError("--closes takes a comma-separated list of issue numbers, such as 12,34");
  }
  return [...new Set(numbers.map(Number))];
}

export function compareClosing(
  found: readonly ClosingRef[],
  declared: readonly number[],
  repo: string,
): { ok: true } | { ok: false; reason: string } {
  const own = repo.toLowerCase();
  if (found.some((ref) => ref.repo !== own)) {
    return { ok: false, reason: "a closing keyword names another repository" };
  }
  const foundSet = new Set(found.map((ref) => ref.number));
  const declaredSet = new Set(declared);
  const undeclared = [...foundSet].filter((n) => !declaredSet.has(n)).length;
  const missing = [...declaredSet].filter((n) => !foundSet.has(n)).length;
  if (undeclared === 0 && missing === 0) return { ok: true };
  return { ok: false, reason: `closing keywords do not match --closes (undeclared: ${undeclared}, missing: ${missing})` };
}
````

Expected sha256 of the extracted file: `8dfecd85aeed0db914cd7b064414a038d76991433ba05157b14117fef07c877d`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-scan.test.ts`
Expected: `23 pass`, `0 fail`.

- [ ] **Step 5: Ablate, twice**

First, in `scanText`, delete the one line that begins `if (SESSION_LINK_RE.test(text)`. Run the suite. Expected: `reports a Claude Code session link` and `reports a session link split by a zero-width character` fail. Restore.

Second, in `compareClosing`, change `const missing = [...declaredSet].filter((n) => !foundSet.has(n)).length;` to `const missing = 0;`. Expected: `refuses a declared issue the text never closes` fails. Restore and re-run to `23 pass`.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add tools/publish/scan.ts test/publish-scan.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): identity, session-link, attribution and closing-keyword gates (#274)

A session link passed the identity scan into six pull request bodies on
2026-10-05/06, so the scan adds that pattern on top of the PR
reviewer's matcher, reused rather than copied. Hits come back as field
and class labels, never as text. Closing keywords are read in every
form GitHub accepts and compared both ways against --closes, since a
declared issue the body never closes is as wrong as an undeclared one.
Keywords inside code spans still count: that can refuse a body GitHub
would ignore, never the reverse."
```

### Task 4: Template sections

**Security-bearing:** no.

**Files:**
- Create: `tools/publish/template.ts`
- Create: `test/publish-template.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface TemplateSection { level: number; key: string }`
  - `templateSections(template: string): TemplateSection[]`
  - `unfilledSections(template: string, body: string): number[]` (1-based indexes)

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-template.test.ts -->
````ts
// Tests for tools/publish/template.ts (#274): a body must fill every section of the repository's
// PR or issue template.

import { describe, expect, test } from "bun:test";
import { templateSections, unfilledSections } from "../tools/publish/template";

const TEMPLATE = [
  "---",
  "name: Fixture",
  "title: \"## Not a heading\"",
  "---",
  "",
  "<!-- Write something under every heading. -->",
  "",
  "## Source",
  "",
  "<!-- Give the path. -->",
  "",
  "## Why it transfers",
  "",
  "```",
  "## not a section, inside a fence",
  "```",
  "",
  "### Detail",
  "",
].join("\n");

describe("templateSections()", () => {
  test("lists headings outside front matter, comments and fences", () => {
    expect(templateSections(TEMPLATE)).toEqual([
      { level: 2, key: "source" },
      { level: 2, key: "why it transfers" },
      { level: 3, key: "detail" },
    ]);
  });

  test("a template with no headings has no sections", () => {
    expect(templateSections("<!-- describe the change -->\n- [ ] tested\n")).toEqual([]);
  });
});

describe("unfilledSections()", () => {
  test("accepts a body that fills every section, at any heading level and case", () => {
    const body = "# SOURCE\n\npath/to/file\n\n## Why it transfers\n\nIt checks a contract.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([]);
  });

  test("reports a missing section by index", () => {
    const body = "## Source\n\npath\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([2]);
  });

  test("reports a section left holding only the template's comment", () => {
    const body = "## Source\n\n<!-- Give the path. -->\n\n## Why it transfers\n\nYes.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([1]);
  });

  test("counts a subsection's content toward its parent", () => {
    const body = "## Source\n\np\n\n## Why it transfers\n\n### Detail\n\nOnly here.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([]);
  });

  test("stops a section at the next heading of the same level", () => {
    const body = "## Source\n\n## Why it transfers\n\nYes.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([1]);
  });

  // Review Focus 1 and 2: bodies written on Windows.
  test("reads a body saved with a byte-order mark and CRLF line endings", () => {
    const body = "\uFEFF## Source\r\n\r\npath\r\n\r\n## Why it transfers\r\n\r\nYes.\r\n\r\n### Detail\r\n\r\nMore.\r\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([]);
  });

  test("a heading inside the body's own fence does not fill a section", () => {
    const body = "```\n## Source\nfilled?\n```\n\n## Why it transfers\n\nYes.\n\n### Detail\n\nMore.\n";
    expect(unfilledSections(TEMPLATE, body)).toEqual([1]);
  });
});
````

Expected sha256 of the extracted file: `83dd9e64b58a3e44b764e815c921e25fcab78bace87932309d09e84e202b4ac6`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-template.test.ts`
Expected: FAIL, `../tools/publish/template` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/template.ts -->
````ts
// Checks a body against a repository's PR or issue template (#274). Every heading in the template
// is a section the body must carry, by heading text at any level, with something other than
// whitespace and HTML comments under it before the next heading at the same level or above. The
// template's own instruction comments are stripped first, so leaving them in place does not count
// as filling the section. Headings inside fenced code are not headings.
//
// Only section indexes come back, never heading or body text.

export interface TemplateSection {
  level: number;
  key: string;
}

interface Line {
  heading: TemplateSection | null;
  text: string;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function stripFrontMatter(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

function headingKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  // A leading byte-order mark (Windows PowerShell 5.1's Set-Content writes one) would otherwise
  // hide a heading on the first line.
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(raw);
    if (fenceMatch) {
      const mark = fenceMatch[1]![0]!;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      out.push({ heading: null, text: raw });
      continue;
    }
    const heading = fence === null ? HEADING_RE.exec(raw) : null;
    const key = heading ? headingKey(heading[2]!) : "";
    out.push({ heading: heading && key !== "" ? { level: heading[1]!.length, key } : null, text: raw });
  }
  return out;
}

export function templateSections(template: string): TemplateSection[] {
  return splitLines(stripComments(stripFrontMatter(template))).flatMap((line) => (line.heading ? [line.heading] : []));
}

// 1-based indexes of the template's sections that the body lacks or leaves empty.
export function unfilledSections(template: string, body: string): number[] {
  const lines = splitLines(stripComments(body));
  const unfilled: number[] = [];
  templateSections(template).forEach((section, index) => {
    const start = lines.findIndex((line) => line.heading?.key === section.key);
    if (start === -1) {
      unfilled.push(index + 1);
      return;
    }
    const level = lines[start]!.heading!.level;
    let content = "";
    for (let i = start + 1; i < lines.length; i++) {
      const heading = lines[i]!.heading;
      if (heading && heading.level <= level) break;
      if (heading) continue;
      content += lines[i]!.text;
    }
    if (content.trim() === "") unfilled.push(index + 1);
  });
  return unfilled;
}
````

Expected sha256 of the extracted file: `17266648fabbea7803e60e99de3b8f7574a01dcf9dfc80a1e7deee4a8e2778f0`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-template.test.ts`
Expected: `9 pass`, `0 fail`.

- [ ] **Step 5: Ablate**

In `unfilledSections`, change `const lines = splitLines(stripComments(body));` to `const lines = splitLines(body);`. Expected: `reports a section left holding only the template's comment` fails. Restore. Then in `splitLines`, delete the `.replace(/^\uFEFF/, "")` call (leaving `text.split(/\r?\n/)`). Expected: `reads a body saved with a byte-order mark and CRLF line endings` fails. Restore and re-run to `9 pass`.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add tools/publish/template.ts test/publish-template.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): refuse a body that leaves a template section empty (#274)

Every heading in a repository's PR or issue template is a section the
body must carry with real content under it. The template's own HTML
comments are stripped first, so leaving them in place does not count
as filling a section. Front matter, fenced code and a leading
byte-order mark are handled, because Windows PowerShell 5.1 writes one."
```

### Task 5: The gh client and the scripted runner

**Security-bearing:** yes. It reads the configured account's token and decides what reaches gh's command line.

**Files:**
- Create: `tools/publish/gh.ts`
- Create: `test/publish-fakes.ts`
- Create: `test/publish-gh.test.ts`

**Interfaces:**
- Consumes: `PublishRefusal`, `PublishError` (Task 1). `Runner`, `RunResult`, `childEnv` (Task 2). `SHA_RE` from `tools/pr-review/types.ts`.
- Produces, from `gh.ts`:
  - `BRANCH_RE: RegExp`
  - `interface CheckEntry { kind: "CheckRun" | "StatusContext"; name: string; status: string; conclusion: string }`
  - `interface PrState { number; state; isDraft; baseRefName; headRefName; headRefOid; isCrossRepository; mergeStateStatus; title; body; checks: CheckEntry[] }`
  - `class Gh` with `static forUser(runner: Runner, ghUser: string, base: Record<string, string | undefined>): Gh`, `token: string`, `call(args, options?)`, `defaultBranch(repo): string`, `branchHead(repo, branch): string | null`, `fileAt(repo, path, ref): string | null`, `listFiles(repo, dir, ref): string[] | null`, `prTemplate(repo, ref): string | null`, `issueTemplate(repo, ref, name): string`, `blankIssuesDisabled(repo, ref): boolean`, `prView(repo, pr): PrState`, `prCommitMessages(repo, pr): string[]`, `watchChecks(repo, pr, timeoutMs): "finished" | "timed-out"`, `createIssue(repo, title, body): string`, `editIssue(repo, issue, title | null, body | null): void`, `createPr(repo, base, head, title, body, draft): string`, `editPr(repo, pr, title | null, body | null): void`, `commentPr(repo, pr, body): void`, `mergePr(repo, pr, headSha, method: "merge" | "rebase", admin: boolean): void`, `mergedState(repo, pr): { state: string; mergeSha: string | null }`
- Produces, from `test/publish-fakes.ts`: `REPO`, `HEAD`, `BASE_HEAD`, `NOT_FOUND`, `type Responder`, `on(prefix, result): Responder`, `class FakeRunner` (with `calls`, `piped`, settable `pipedResult`, `publishing(): string[][]`), `healthyRepo(): Responder[]`.

- [ ] **Step 1: Lay down the fakes and the failing test**

<!-- file: test/publish-fakes.ts -->
````ts
// A scripted Runner for the tools/publish suites (#274). Not a test file itself (bun test only
// collects *.test.ts). Each responder sees one call's argv and returns a result, or undefined to
// pass. An unanswered call fails with exit 1, so a test never reaches a real gh, git or key.

import type { PipedResult, PipeSpec, RunOptions, RunResult, Runner } from "../tools/publish/exec";

export type Responder = (argv: readonly string[], options: RunOptions) => Partial<RunResult> | undefined;

export const REPO = "fixture-owner/fixture-repo";
export const HEAD = "a".repeat(40);
export const BASE_HEAD = "b".repeat(40);

// Answers any call whose argv starts with the given prefix.
export function on(prefix: readonly string[], result: Partial<RunResult>): Responder {
  return (argv) => (prefix.every((part, i) => argv[i] === part) ? result : undefined);
}

export const NOT_FOUND: Partial<RunResult> = { code: 1, stderr: "gh: Not Found (HTTP 404)" };

export class FakeRunner implements Runner {
  readonly calls: { argv: string[]; options: RunOptions }[] = [];
  readonly piped: { producer: PipeSpec; consumer: PipeSpec & { timeoutMs: number } }[] = [];

  constructor(
    private readonly responders: Responder[],
    // What runPiped answers: the key command's exit code and the reviewer's result. Tests set it.
    public pipedResult: PipedResult = {
      producerCode: 0,
      producerSpawnError: false,
      consumer: { code: 1, stdout: "", stderr: "", spawnError: false, timedOut: false },
    },
  ) {}

  run(argv: readonly string[], options: RunOptions = {}): RunResult {
    this.calls.push({ argv: [...argv], options });
    for (const responder of this.responders) {
      const hit = responder(argv, options);
      if (hit !== undefined) return { code: 0, stdout: "", stderr: "", spawnError: false, timedOut: false, ...hit };
    }
    return { code: 1, stdout: "", stderr: "unscripted call", spawnError: false, timedOut: false };
  }

  async runPiped(producer: PipeSpec, consumer: PipeSpec & { timeoutMs: number }): Promise<PipedResult> {
    this.piped.push({ producer, consumer });
    return this.pipedResult;
  }

  // gh calls that publish or change something on GitHub.
  publishing(): string[][] {
    return this.calls
      .map((call) => call.argv)
      .filter((argv) => argv[0] === "gh" && (argv[1] === "issue" || argv[1] === "pr") && ["create", "edit", "merge", "comment"].includes(argv[2] ?? ""));
  }
}

// The read-side gh answers a healthy repository gives: a token, a default branch "main", both
// branches present, and no templates anywhere.
export function healthyRepo(): Responder[] {
  return [
    on(["gh", "auth", "token", "-u", "fixture-owner"], { stdout: "fake-token\n" }),
    on(["gh", "api", `repos/${REPO}`, "--jq", ".default_branch"], { stdout: "main\n" }),
    on(["gh", "api", `repos/${REPO}/branches/main`], { stdout: `${BASE_HEAD}\n` }),
    on(["gh", "api", `repos/${REPO}/branches/feat/x`], { stdout: `${HEAD}\n` }),
    (argv) => (argv[0] === "gh" && argv[1] === "api" && String(argv[2] ?? "").startsWith(`repos/${REPO}/contents`) ? NOT_FOUND : undefined),
    (argv) =>
      argv[0] === "gh" && argv[1] === "api" && argv[2] === "-H" && String(argv[4] ?? "").startsWith(`repos/${REPO}/contents`) ? NOT_FOUND : undefined,
  ];
}
````

Expected sha256 of the extracted file: `d89badb0a2d5e335341f1b8acd00e57473efac17c2355da4544b8a566ef220d1`

<!-- file: test/publish-gh.test.ts -->
````ts
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

  test("issueTemplate refuses an issue form and a missing file", () => {
    const runner = new FakeRunner([TOKEN, on(["gh", "api"], NOT_FOUND)]);
    expect(() => gh(runner).issueTemplate(REPO, "main", "bug.yml")).toThrow(PublishRefusal);
    expect(() => gh(runner).issueTemplate(REPO, "main", "absent.md")).toThrow(PublishRefusal);
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
````

Expected sha256 of the extracted file: `be04c39d73492ad79412532ec77c3ad8d62657dae1c064588e6ab2c394a4c5b2`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-gh.test.ts`
Expected: FAIL, `../tools/publish/gh` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/gh.ts -->
````ts
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
````

Expected sha256 of the extracted file: `808f74d6503ae927ddea850b568147ece085fc8c8db656bc5d07a57984a44261`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-gh.test.ts`
Expected: `20 pass`, `0 fail`.

- [ ] **Step 5: Ablate, twice**

First, in `Gh.forUser`, delete the whole `if (probe.code !== 0 || token === "" || /\s/.test(token)) { ... }` block. Expected: `refuses when gh holds no token for the account` and `refuses an empty token` fail. Restore.

Second, in `prCommitMessages`, change `messages.length !== total` to `false`. Expected: `refuses a list shorter than the pull request's commit count` fails. Restore and re-run to `20 pass`.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add tools/publish/gh.ts test/publish-fakes.ts test/publish-gh.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): gh client under the configured account's token (#274)

The token comes from gh auth token -u <configured account> and reaches
later calls only as GH_TOKEN in the child's environment, so the active
gh account is never consulted and never switched. Titles go as
--title=<value> and bodies on stdin, so a value starting with a dash is
never a flag and no temp file sits between the scan and the publish.
The commit-message list refuses when it does not reconcile with the
pull request's commit count, since an unread message can still close an
issue on merge."
```

### Task 6: issue create/edit and pr create/edit

**Security-bearing:** yes. This is where the gates guard what gets published.

**Files:**
- Create: `tools/publish/publish.ts`
- Create: `test/publish-create.test.ts`

**Interfaces:**
- Consumes: `ownerIdentity`, `OwnerIdentity`, `PublishConfig` (Task 1). `PublishRefusal`, `UsageError` (Task 1). `Runner` (Task 2). `scanText`, `findClosingRefs`, `compareClosing`, `TextField` (Task 3). `templateSections`, `unfilledSections` (Task 4). `Gh` (Task 5). `IdentityDecl`, `IdentityLoad` from `tools/pr-review/identity.ts`.
- Produces:
  - `interface PublishContext { runner: Runner; config: PublishConfig; env: Record<string, string | undefined>; loadIdentity: () => IdentityLoad; readBody: (path: string) => string }`
  - `interface IssueCreateArgs { repo; title; bodyFile; template: string | null }`, `IssueEditArgs { repo; issue: number; title: string | null; bodyFile: string | null; template: string | null }`, `PrCreateArgs { repo; base; head; title; bodyFile; closes: number[]; draft: boolean }`, `PrEditArgs { repo; pr: number; base; title: string | null; bodyFile: string | null; closes: number[] }`
  - `nativePath(path: string, platform?: string): string`
  - `loadBody(ctx: Pick<PublishContext, "readBody">, path: string, flag?: string): string`
  - `assertClean(ctx: Pick<PublishContext, "loadIdentity">, fields: TextField[]): void` (refuses unless the identity file declares a name and the claude CLI's account email is known)
  - `issueCreate(ctx, args: IssueCreateArgs): string` (URL), `issueEdit(ctx, args): string`, `prCreate(ctx, args: PrCreateArgs): string` (URL), `prEdit(ctx, args): string`

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-create.test.ts -->
````ts
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
````

Expected sha256 of the extracted file: `b66810d8027ae9943ef411cdbc0af94f9f5552e18091f0bf5ab2787cfdd8f240`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-create.test.ts`
Expected: FAIL, `../tools/publish/publish` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/publish.ts -->
````ts
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
````

Expected sha256 of the extracted file: `80d6cb73981f35689065410141328c952ece7e2a16da4afd49cfe7e07bad5425`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-create.test.ts`
Expected: `34 pass`, `0 fail`.

- [ ] **Step 5: Ablate, four times**

First, in `prCreate`, change `const closing = closingGate([args.title, body], args.closes, args.repo);` to `const closing = 0;`. Expected: `refuses a title that carries an undeclared closing keyword`, `refuses a closing keyword that was not declared`, `refuses a declared issue the body does not close` and `refuses closing keywords on a pull request into a non-default base` fail, each because a publishing call was made (measured 2026-10-06). Restore.

Second, in `prCreate`, delete `if (template !== null) templateGate(template, body);`. Expected: `refuses a body that leaves a pull request template section empty` fails. Restore.

Third, in `identityFor`, change `if (!identity.declared || identity.decl.names.length === 0) {` to `if (false) {`. Expected: `refuses when no identity file is declared` and `refuses when the identity file declares no name` fail, because a body naming the fixture person publishes (measured 2026-10-06). Restore.

Fourth, change `if (identity.accountEmail !== true || identity.decl.emails.length === 0) {` to `if (false) {`. Expected: `refuses when the claude CLI's account email is unknown` fails. Restore and re-run to `34 pass`.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add tools/publish/publish.ts test/publish-create.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): issue and pull request create and edit behind fixed-order gates (#274)

Local gates run first, so a body with an identifying string or an
undeclared closing keyword is refused before any token is read. Then
the default branch decides whether closing keywords may act at all,
both branches must exist on the remote, and the repository's template
must be filled. Each refusal test asserts no publishing gh call was
made. The identity scan refuses rather than narrowing when the identity
file declares no name or the claude CLI's account email is unknown, the
precondition pr-review's posting run holds. A pull request's title
counts against --closes with its body, because a --merge merge commit
carries the title. Git Bash's /c/... body paths are translated on
Windows, because a native process resolves them against the current
drive's root."
```

### Task 7: The merge decision

**Security-bearing:** yes. It is the only place that decides a merge or a bypass.

**Files:**
- Create: `tools/publish/merge-decision.ts`
- Create: `test/publish-merge-decision.test.ts`

**Interfaces:**
- Consumes: `PublishError` (Task 1). `CheckEntry` (Task 5). `BELOW_FLOOR_SEVERITIES` from `tools/pr-review/types.ts`.
- Produces:
  - `interface ReviewResult { status: string; event: string; reviewerOk: boolean; headSha: string; severities: string[]; refusal: string | null; postedUrl: string | null }`
  - `type MergeDecision = { action: "merge"; admin: boolean } | { action: "refuse"; reason: string }`
  - `enumText(value: string): string`
  - `parseReviewOutput(stdout: string): ReviewResult` (throws `PublishError`)
  - `atFloorCount(severities: readonly string[]): number`
  - `checksSummary(checks: readonly CheckEntry[]): { ok: boolean; total: number; failing: number; pending: number }`
  - `decideMerge(input: { review: ReviewResult; reviewedHead: string; currentHead: string; checks: readonly CheckEntry[]; mergeState: string; allowAdmin: boolean }): MergeDecision`

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-merge-decision.test.ts -->
````ts
// Tests for tools/publish/merge-decision.ts (#274): every way the merge decision refuses, and the
// only two ways it merges.

import { describe, expect, test } from "bun:test";
import { PublishError } from "../tools/publish/errors";
import type { CheckEntry } from "../tools/publish/gh";
import { atFloorCount, checksSummary, decideMerge, parseReviewOutput, type ReviewResult } from "../tools/publish/merge-decision";
import { HEAD } from "./publish-fakes";

const GREEN: CheckEntry[] = [
  { kind: "CheckRun", name: "bun test", status: "COMPLETED", conclusion: "SUCCESS" },
  { kind: "StatusContext", name: "legacy", status: "COMPLETED", conclusion: "SUCCESS" },
];
const APPROVED: ReviewResult = {
  status: "posted",
  event: "APPROVE",
  reviewerOk: true,
  headSha: HEAD,
  severities: ["naming"],
  refusal: null,
  postedUrl: "https://github.com/o/r/pull/9#pullrequestreview-1",
};
const base = { review: APPROVED, reviewedHead: HEAD, currentHead: HEAD, checks: GREEN, mergeState: "CLEAN", allowAdmin: false };
type Input = Parameters<typeof decideMerge>[0];
const decide = (overrides: Partial<Input>) => decideMerge({ ...base, ...overrides });

describe("decideMerge(): merges", () => {
  test("a plain merge on APPROVE and CLEAN", () => {
    expect(decide({})).toEqual({ action: "merge", admin: false });
  });

  test("the bypass on APPROVE and BLOCKED with --allow-admin", () => {
    expect(decide({ mergeState: "BLOCKED", allowAdmin: true })).toEqual({ action: "merge", admin: true });
  });

  test("the bypass on a COMMENT with no at-floor finding and --allow-admin", () => {
    expect(decide({ review: { ...APPROVED, event: "COMMENT" }, mergeState: "BLOCKED", allowAdmin: true })).toEqual({ action: "merge", admin: true });
  });
});

describe("decideMerge(): refuses", () => {
  const refused = (overrides: Partial<Input>) => {
    const decision = decide(overrides);
    expect(decision.action).toBe("refuse");
    return decision.action === "refuse" ? decision.reason : "";
  };

  test("a review that was not posted", () => {
    expect(refused({ review: { ...APPROVED, status: "dry-run" } })).toContain("not posted");
  });

  test("a COMMENT from a reviewer that never produced findings, even with --allow-admin", () => {
    expect(refused({ review: { ...APPROVED, event: "COMMENT", reviewerOk: false, severities: [] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "no valid findings",
    );
  });

  test("a review of a different head", () => {
    expect(refused({ review: { ...APPROVED, headSha: "c".repeat(40) } })).toContain("not the one that was reviewed");
  });

  test("a head that moved after the review", () => {
    expect(refused({ currentHead: "c".repeat(40) })).toContain("not the one that was reviewed");
  });

  test("a failed check", () => {
    expect(refused({ checks: [...GREEN, { kind: "CheckRun", name: "Pester", status: "COMPLETED", conclusion: "FAILURE" }] })).toContain("1 not successful");
  });

  test("a skipped check, because only SUCCESS counts", () => {
    expect(refused({ checks: [{ kind: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" }] })).toContain("not every check");
  });

  test("a pending check", () => {
    expect(refused({ checks: [{ kind: "CheckRun", name: "x", status: "IN_PROGRESS", conclusion: "" }] })).toContain("1 pending");
  });

  test("no checks at all", () => {
    expect(refused({ checks: [] })).toContain("0 total");
  });

  test("APPROVE on a blocked merge without --allow-admin", () => {
    expect(refused({ mergeState: "BLOCKED" })).toContain("--allow-admin");
  });

  test("APPROVE on a merge state other than CLEAN or BLOCKED", () => {
    expect(refused({ mergeState: "BEHIND", allowAdmin: true })).toContain("merge state BEHIND");
  });

  test("a COMMENT without --allow-admin", () => {
    expect(refused({ review: { ...APPROVED, event: "COMMENT" }, mergeState: "BLOCKED" })).toContain("Only --allow-admin");
  });

  test("a COMMENT with an at-floor finding, even with --allow-admin", () => {
    expect(refused({ review: { ...APPROVED, event: "COMMENT", severities: ["security"] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "1 finding(s) at or above the floor",
    );
  });

  test("REQUEST_CHANGES, even with --allow-admin and no findings", () => {
    expect(refused({ review: { ...APPROVED, event: "REQUEST_CHANGES", severities: [] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "event REQUEST_CHANGES",
    );
  });

  test("an unknown severity, which counts as at the floor", () => {
    expect(refused({ review: { ...APPROVED, event: "COMMENT", severities: ["novel"] }, mergeState: "BLOCKED", allowAdmin: true })).toContain(
      "1 finding(s)",
    );
  });
});

describe("helpers", () => {
  test("atFloorCount counts load-bearing and unknown severities", () => {
    expect(atFloorCount(["correctness", "naming", "fails-open", "other", "made-up"])).toBe(3);
  });

  test("checksSummary needs at least one check", () => {
    expect(checksSummary([]).ok).toBe(false);
    expect(checksSummary(GREEN).ok).toBe(true);
  });
});

describe("parseReviewOutput()", () => {
  test("reads the fields the decision uses", () => {
    const out = JSON.stringify({
      status: "posted",
      event: "APPROVE",
      reviewerOk: true,
      headSha: HEAD,
      severities: ["naming"],
      refusal: null,
      posted: { id: 1, htmlUrl: "https://example.test/r" },
      body: "ignored",
    });
    expect(parseReviewOutput(out)).toEqual({ ...APPROVED, postedUrl: "https://example.test/r" });
  });

  test("throws on output that is not JSON", () => {
    expect(() => parseReviewOutput("status=posted event=APPROVE")).toThrow(PublishError);
  });

  test("throws on output missing a field", () => {
    expect(() => parseReviewOutput(JSON.stringify({ status: "posted", event: "APPROVE" }))).toThrow(PublishError);
  });
});
````

Expected sha256 of the extracted file: `acc484aa59c471c0c90aded566b5006e4f3384b9bd0fae2148f4d90fa55a08ec`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-merge-decision.test.ts`
Expected: FAIL, `../tools/publish/merge-decision` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/merge-decision.ts -->
````ts
// The merge decision for review-merge (#274), as a pure function of the reviewer's structured
// output and the pull request's state read back after the review. No prose is parsed: the inputs
// are the --json fields tools/pr-review/cli.ts prints (status, event, reviewerOk, headSha,
// severities, posted) and GitHub's own enums.
//
// Two ways to merge, and nothing else:
//   - the App approved, the merge state is CLEAN: a plain merge.
//   - the App approved but the merge is BLOCKED (an owned path needs a code-owner review the
//     operator cannot give), or the App could only COMMENT (it cannot vouch for CI edits): the
//     administrator bypass, and only when --allow-admin was passed, the reviewer actually ran,
//     no finding sits at or above the severity floor, and the event is not REQUEST_CHANGES.
// Both also require the review to have been posted, every check to have succeeded, and the head
// to be the one reviewed. A severity this file does not know counts as at or above the floor.

import { BELOW_FLOOR_SEVERITIES } from "../pr-review/types";
import { PublishError } from "./errors";
import type { CheckEntry } from "./gh";

export interface ReviewResult {
  status: string;
  event: string;
  reviewerOk: boolean;
  headSha: string;
  severities: string[];
  refusal: string | null;
  postedUrl: string | null;
}

export type MergeDecision = { action: "merge"; admin: boolean } | { action: "refuse"; reason: string };

const BELOW_FLOOR: ReadonlySet<string> = new Set(BELOW_FLOOR_SEVERITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// GitHub enum values and the reviewer's status words are safe to print. Anything else is not.
export function enumText(value: string): string {
  return /^[A-Za-z_-]{1,40}$/.test(value) ? value : "unrecognised";
}

export function parseReviewOutput(stdout: string): ReviewResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new PublishError("the reviewer's --json output is not JSON. A review may already have been posted, so check the pull request");
  }
  if (!isRecord(raw) || typeof raw.status !== "string") throw new PublishError("the reviewer's --json output has no status");
  const { status, event, reviewerOk, headSha, severities, refusal, posted } = raw;
  if (
    typeof event !== "string" ||
    typeof reviewerOk !== "boolean" ||
    typeof headSha !== "string" ||
    !Array.isArray(severities) ||
    !severities.every((severity) => typeof severity === "string")
  ) {
    throw new PublishError("the reviewer's --json output lacks event, reviewerOk, headSha or severities");
  }
  return {
    status,
    event,
    reviewerOk,
    headSha,
    severities: severities as string[],
    refusal: typeof refusal === "string" ? refusal : null,
    postedUrl: isRecord(posted) && typeof posted.htmlUrl === "string" ? posted.htmlUrl : null,
  };
}

export function atFloorCount(severities: readonly string[]): number {
  return severities.filter((severity) => !BELOW_FLOOR.has(severity)).length;
}

export function checksSummary(checks: readonly CheckEntry[]): { ok: boolean; total: number; failing: number; pending: number } {
  const pending = checks.filter((check) => check.status !== "COMPLETED").length;
  const failing = checks.filter((check) => check.status === "COMPLETED" && check.conclusion !== "SUCCESS").length;
  return { ok: checks.length > 0 && pending === 0 && failing === 0, total: checks.length, failing, pending };
}

export function decideMerge(input: {
  review: ReviewResult;
  reviewedHead: string;
  currentHead: string;
  checks: readonly CheckEntry[];
  mergeState: string;
  allowAdmin: boolean;
}): MergeDecision {
  const { review } = input;
  const refuse = (reason: string): MergeDecision => ({ action: "refuse", reason });
  if (review.status !== "posted") return refuse(`the review was not posted (status ${enumText(review.status)})`);
  if (review.reviewerOk !== true) return refuse("the reviewer produced no valid findings, so nothing vouches for this change");
  if (review.headSha !== input.reviewedHead || input.currentHead !== input.reviewedHead) {
    return refuse("the head commit is not the one that was reviewed");
  }
  const checks = checksSummary(input.checks);
  if (!checks.ok) {
    return refuse(`not every check succeeded (${checks.total} total, ${checks.failing} not successful, ${checks.pending} pending)`);
  }
  const atFloor = atFloorCount(review.severities);
  const state = enumText(input.mergeState);
  if (review.event === "APPROVE" && atFloor === 0) {
    if (input.mergeState === "CLEAN") return { action: "merge", admin: false };
    if (input.mergeState === "BLOCKED") {
      return input.allowAdmin
        ? { action: "merge", admin: true }
        : refuse("the App approved but the merge is blocked, as on an owned path. Rerun with --allow-admin to use the administrator bypass");
    }
    return refuse(`the pull request is not mergeable (merge state ${state})`);
  }
  if (review.event === "COMMENT" && atFloor === 0) {
    if (!input.allowAdmin) return refuse("the review is a COMMENT with no finding at or above the floor. Only --allow-admin may merge it");
    if (input.mergeState === "BLOCKED" || input.mergeState === "CLEAN") return { action: "merge", admin: true };
    return refuse(`the pull request is not mergeable (merge state ${state})`);
  }
  return refuse(`the review did not approve (event ${enumText(review.event)}, ${atFloor} finding(s) at or above the floor)`);
}
````

Expected sha256 of the extracted file: `2d4a9c28571d8c70fa31b32dc17ecf0f5e75c3b628a93d23de7d21d52b7cb3cd`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-merge-decision.test.ts`
Expected: `22 pass`, `0 fail`.

- [ ] **Step 5: Ablate, twice**

First, delete `if (review.reviewerOk !== true) return refuse("the reviewer produced no valid findings, so nothing vouches for this change");`. Expected: `a COMMENT from a reviewer that never produced findings, even with --allow-admin` fails, because zero findings from a reviewer that never ran would otherwise read as clean. Restore.

Second, in `atFloorCount`, change `!BELOW_FLOOR.has(severity)` to `["correctness", "security", "fails-open"].includes(severity)`. Expected: `an unknown severity, which counts as at the floor` and `atFloorCount counts load-bearing and unknown severities` fail. Restore and re-run to `22 pass`.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add tools/publish/merge-decision.ts test/publish-merge-decision.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): merge decision from the reviewer's structured output (#274)

The helper this replaces grepped the reviewer's prose for event=APPROVE
and for a findings heading, and was rewritten three times. This reads
the --json fields instead. A plain merge needs APPROVE and a CLEAN
merge state. The bypass needs --allow-admin, a reviewer that actually
ran, no finding at or above the floor, and an event other than
REQUEST_CHANGES. A severity this file does not know counts as at the
floor, and only SUCCESS counts as a passing check."
```

### Task 8: review-merge

**Security-bearing:** yes. It runs the reviewer with the App key and merges.

**Files:**
- Create: `tools/publish/review-merge.ts`
- Create: `test/publish-review-merge.test.ts`

**Interfaces:**
- Consumes: `ownerIdentity`, `reviewerConfig`, `OwnerIdentity`, `PublishConfig`, `ReviewerConfig` (Task 1). `PublishRefusal`, `PublishError` (Task 1). `childEnv`, `Runner`, `RunResult` (Task 2). `compareClosing`, `findClosingRefs` (Task 3). `Gh`, `PrState` (Task 5). `assertClean`, `loadBody` (Task 6). `checksSummary`, `decideMerge`, `enumText`, `parseReviewOutput`, `ReviewResult` (Task 7). `stripControlChars` from `tools/pr-review/cli.ts`. `IdentityLoad` from `tools/pr-review/identity.ts`. `parseRepo` from `tools/pr-review/types.ts`.
- Produces:
  - `REVIEWER_TIMEOUT_MS: number`
  - `interface ReviewMergeArgs { repo: string; pr: number; closes: number[]; allowAdmin: boolean; adminReasonFile: string | null; method: "merge" | "rebase"; checksTimeoutMin: number }`
  - `interface ReviewMergeContext { runner; config; env; workDir: string; toolRoot: string; bunPath: string; exists: (path: string) => boolean; toolState: (root: string) => { revision: string; dirty: boolean }; sleep: (ms: number) => void; log: (line: string) => void; loadIdentity: () => IdentityLoad; readBody: (path: string) => string }`
  - `realExists: (path: string) => boolean`
  - `remoteRepo(url: string): string | null`, `remoteMatches(url: string, repo: string): boolean`
  - `reviewMerge(ctx: ReviewMergeContext, args: ReviewMergeArgs): Promise<string>`

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-review-merge.test.ts -->
````ts
// Tests for tools/publish/review-merge.ts (#274), end to end against a scripted Runner: no gh,
// git, key command or reviewer runs. Every refusal asserts that no merge call was made, and the
// early ones that the reviewer never ran.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parsePublishConfig } from "../tools/publish/config";
import { PublishError, PublishRefusal } from "../tools/publish/errors";
import type { PipedResult } from "../tools/publish/exec";
import { remoteMatches, reviewMerge, type ReviewMergeArgs, type ReviewMergeContext } from "../tools/publish/review-merge";
import { BASE_HEAD, FakeRunner, HEAD, on, REPO, type Responder } from "./publish-fakes";

const CHECKOUT = process.platform === "win32" ? "C:/fixture/reviewer-checkout" : "/fixture/reviewer-checkout";
const WORK = process.platform === "win32" ? "C:/fixture/work" : "/fixture/work";
const TOOL_ROOT = process.platform === "win32" ? "C:/fixture/tool-checkout" : "/fixture/tool-checkout";
const CONFIG = parsePublishConfig(
  JSON.stringify({
    owners: { "fixture-owner": { gitName: "fixture-owner", gitEmail: "fixture-owner@users.noreply.example.test", ghUser: "fixture-owner" } },
    reviewers: { [REPO]: { appId: "1", keyCommand: ["fixture-key-cmd"], keyCommandEnv: { FIXTURE_FLAG: "false" }, checkout: CHECKOUT } },
  }),
);
const ARGS: ReviewMergeArgs = { repo: REPO, pr: 9, closes: [], allowAdmin: false, adminReasonFile: null, method: "merge", checksTimeoutMin: 30 };
const REASON_PATH = process.platform === "win32" ? "C:/fixture/reason.md" : "/fixture/reason.md";
const ADMIN_ARGS: ReviewMergeArgs = { ...ARGS, allowAdmin: true, adminReasonFile: REASON_PATH };
const REASON = "Administrator bypass: this change edits .github/workflows/, which the App cannot vouch for.";
const MERGE_SHA = "d".repeat(40);

const GREEN = [{ __typename: "CheckRun", name: "bun test", status: "COMPLETED", conclusion: "SUCCESS" }];
const VIEW = {
  number: 9,
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat/x",
  headRefOid: HEAD,
  isCrossRepository: false,
  mergeStateStatus: "CLEAN",
  title: "fix: wait for checks",
  body: "## Why\n\nBecause.\n",
  statusCheckRollup: GREEN,
};
const APPROVE_OUTPUT = JSON.stringify({
  status: "posted",
  event: "APPROVE",
  reviewerOk: true,
  headSha: HEAD,
  severities: [],
  refusal: null,
  posted: { id: 1, htmlUrl: `https://github.com/${REPO}/pull/9#pullrequestreview-1` },
});
const reviewerSays = (stdout: string, code = 0, producerCode = 0): PipedResult => ({
  producerCode,
  producerSpawnError: false,
  consumer: { code, stdout, stderr: "", spawnError: false, timedOut: false },
});

// Answers successive `gh pr view --json=<PR fields>` calls with the given states, repeating the last.
function views(...states: object[]): Responder {
  let i = 0;
  return (argv) =>
    argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view" && String(argv[5]).startsWith("--json=number")
      ? { stdout: JSON.stringify(states[Math.min(i++, states.length - 1)]) }
      : undefined;
}

function gitSub(argv: readonly string[]): string[] {
  const at = argv.indexOf("-C");
  return argv[0] === "git" && at !== -1 ? argv.slice(at + 2) : [];
}

function scenario(opts: { views?: object[]; commits?: string[]; extra?: Responder[]; merged?: string } = {}): FakeRunner {
  const commits = opts.commits ?? ["feat: x"];
  return new FakeRunner([
    ...(opts.extra ?? []),
    on(["gh", "auth", "token", "-u", "fixture-owner"], { stdout: "fake-token\n" }),
    on(["gh", "api", `repos/${REPO}`, "--jq", ".default_branch"], { stdout: "main\n" }),
    on(["gh", "api", `repos/${REPO}/branches/main`], { stdout: `${BASE_HEAD}\n` }),
    on(["gh", "api", `repos/${REPO}/pulls/9`], { stdout: `${commits.length}\n` }),
    on(["gh", "api", "--paginate"], { stdout: commits.map((m) => JSON.stringify(m)).join("\n") + "\n" }),
    on(["gh", "pr", "checks"], { code: 0 }),
    views(...(opts.views ?? [VIEW])),
    on(["gh", "pr", "merge"], {}),
    on(["gh", "pr", "view", "9", `--repo=${REPO}`, "--json=state,mergeCommit"], {
      stdout: JSON.stringify({ state: opts.merged ?? "MERGED", mergeCommit: { oid: MERGE_SHA } }),
    }),
    (argv) => (gitSub(argv)[0] === "remote" ? { stdout: `https://github.com/${REPO}.git\n` } : undefined),
    (argv) => (gitSub(argv)[0] === "fetch" ? {} : undefined),
    (argv) => (gitSub(argv)[0] === "rev-parse" ? { stdout: `${BASE_HEAD}\n` } : undefined),
    (argv) => (gitSub(argv)[0] === "checkout" ? {} : undefined),
  ]);
}

function ctx(runner: FakeRunner, overrides: Partial<ReviewMergeContext> = {}): ReviewMergeContext {
  return {
    runner,
    config: CONFIG,
    env: { PATH: "x", GH_TOKEN: "inherited" },
    workDir: WORK,
    toolRoot: TOOL_ROOT,
    bunPath: "/fixture/bun",
    exists: () => true,
    toolState: () => ({ revision: BASE_HEAD, dirty: false }),
    sleep: () => {},
    log: () => {},
    loadIdentity: () => ({
      ok: true,
      declared: true,
      accountEmail: true,
      decl: { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "fixtureuser", hostname: "fixture-host" },
    }),
    readBody: () => REASON,
    ...overrides,
  };
}

function withReviewer(runner: FakeRunner, result: PipedResult): FakeRunner {
  runner.pipedResult = result;
  return runner;
}

async function refusal(run: Promise<unknown>, runner: FakeRunner, fragment: string, reviewerRan: boolean): Promise<void> {
  let error: unknown;
  try {
    await run;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PublishRefusal);
  expect((error as Error).message).toContain(fragment);
  expect(runner.publishing()).toEqual([]);
  expect(runner.piped.length > 0).toBe(reviewerRan);
}

describe("review-merge: merges", () => {
  test("merges on APPROVE with the reviewed head pinned", async () => {
    const runner = withReviewer(scenario(), reviewerSays(APPROVE_OUTPUT));
    expect(await reviewMerge(ctx(runner), ARGS)).toBe(`merged #9 at ${MERGE_SHA.slice(0, 7)} (App approval)`);
    expect(runner.publishing()).toEqual([["gh", "pr", "merge", "9", `--repo=${REPO}`, "--merge", `--match-head-commit=${HEAD}`]]);
  });

  test("runs the reviewer from the work directory with the key piped, the head pinned and no inherited token", async () => {
    const runner = withReviewer(scenario(), reviewerSays(APPROVE_OUTPUT));
    await reviewMerge(ctx(runner), ARGS);
    const { producer, consumer } = runner.piped[0]!;
    expect(producer.argv).toEqual(["fixture-key-cmd"]);
    expect(producer.cwd).toBe(WORK);
    expect(producer.env.FIXTURE_FLAG).toBe("false");
    expect(producer.env.GH_TOKEN).toBeUndefined();
    expect(consumer.argv).toEqual([
      "/fixture/bun",
      "--cwd",
      WORK,
      join(CHECKOUT, "tools", "pr-review", "cli.ts"),
      "review",
      "--pr",
      "9",
      "--repo",
      REPO,
      "--key-stdin",
      "--post",
      "--json",
      "--expect-head",
      HEAD,
    ]);
    expect(consumer.cwd).toBe(WORK);
    expect(consumer.env.PR_REVIEW_APP_ID).toBe("1");
    expect(consumer.env.GH_TOKEN).toBeUndefined();
  });

  test("names the configured identity and token helper on every git call", async () => {
    const runner = withReviewer(scenario(), reviewerSays(APPROVE_OUTPUT));
    await reviewMerge(ctx(runner), ARGS);
    const gitCalls = runner.calls.filter((call) => call.argv[0] === "git");
    expect(gitCalls.length).toBe(5);
    for (const call of gitCalls) {
      expect(call.argv).toContain("user.name=fixture-owner");
      expect(call.argv).toContain("credential.helper=");
      expect(call.options.env?.PUBLISH_GIT_TOKEN).toBe("fake-token");
      expect(call.options.env?.GH_TOKEN).toBeUndefined();
    }
  });

  test("uses the administrator bypass for a COMMENT with --allow-admin, posting the reason first", async () => {
    const output = JSON.stringify({ ...JSON.parse(APPROVE_OUTPUT), event: "COMMENT", severities: ["naming"] });
    const runner = withReviewer(
      scenario({ views: [VIEW, VIEW, { ...VIEW, mergeStateStatus: "BLOCKED" }], extra: [on(["gh", "pr", "comment"], {})] }),
      reviewerSays(output),
    );
    expect(await reviewMerge(ctx(runner), ADMIN_ARGS)).toContain("administrator bypass");
    const published = runner.publishing();
    expect(published.map((argv) => argv[2])).toEqual(["comment", "merge"]);
    expect(published[1]).toContain("--admin");
    expect(runner.calls.find((call) => call.argv[2] === "comment")!.options.stdin).toBe(REASON);
  });

  test("posts no reason when --allow-admin was given but a plain merge sufficed", async () => {
    const runner = withReviewer(scenario({ extra: [on(["gh", "pr", "comment"], {})] }), reviewerSays(APPROVE_OUTPUT));
    expect(await reviewMerge(ctx(runner), ADMIN_ARGS)).toContain("App approval");
    expect(runner.publishing().map((argv) => argv[2])).toEqual(["merge"]);
  });

  test("waits out an UNKNOWN merge state", async () => {
    let slept = 0;
    const runner = withReviewer(scenario({ views: [VIEW, VIEW, { ...VIEW, mergeStateStatus: "UNKNOWN" }, VIEW] }), reviewerSays(APPROVE_OUTPUT));
    await reviewMerge(ctx(runner, { sleep: () => slept++ }), ARGS);
    expect(slept).toBe(1);
  });
});

describe("review-merge: refuses before the reviewer runs", () => {
  // The checkout this tool runs from holds the token and the merge rule, so it meets the reviewer
  // checkout's bar: clean, and at its origin's default branch head.
  test("this tool's own checkout carrying uncommitted changes", async () => {
    const runner = scenario();
    await refusal(
      reviewMerge(ctx(runner, { toolState: (root) => ({ revision: BASE_HEAD, dirty: root === TOOL_ROOT }) }), ARGS),
      runner,
      "own checkout has uncommitted changes",
      false,
    );
    expect(runner.calls.some((call) => call.argv[1] === "pr")).toBe(false);
  });

  test("this tool's own checkout away from the default branch head", async () => {
    const runner = scenario();
    await refusal(
      reviewMerge(ctx(runner, { toolState: (root) => ({ revision: root === TOOL_ROOT ? "e".repeat(40) : BASE_HEAD, dirty: false }) }), ARGS),
      runner,
      "not at its default branch's current head",
      false,
    );
    expect(runner.calls.some((call) => call.argv[1] === "pr")).toBe(false);
  });

  test("no reviewer in the config", async () => {
    const runner = scenario();
    const config = parsePublishConfig(JSON.stringify({ owners: { "fixture-owner": CONFIG.owners["fixture-owner"] } }));
    await refusal(reviewMerge(ctx(runner, { config }), ARGS), runner, "no reviewer", false);
  });

  test("an admin reason carrying an identifying string", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner, { readBody: () => "Bypass approved by Fixture Person." }), ADMIN_ARGS), runner, "admin reason: declared name #1", false);
  });

  test("an admin reason carrying a closing keyword", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner, { readBody: () => "Bypass; fixes #3." }), ADMIN_ARGS), runner, "closing keyword", false);
  });

  test("--allow-admin with no reason file", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner), { ...ADMIN_ARGS, adminReasonFile: null }), runner, "needs --admin-reason-file", false);
  });

  test("a reviewer checkout without the reviewer", async () => {
    const runner = scenario();
    await refusal(reviewMerge(ctx(runner, { exists: () => false }), ARGS), runner, "holds no tools/pr-review/cli.ts", false);
  });

  test("a draft", async () => {
    const runner = scenario({ views: [{ ...VIEW, isDraft: true }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "draft", false);
  });

  test("a pull request into another base", async () => {
    const runner = scenario({ views: [{ ...VIEW, baseRefName: "release" }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "default branch", false);
  });

  // Review Focus 5: a --merge merge commit carries the title onto the default branch.
  test("an undeclared closing keyword in the title", async () => {
    const runner = scenario({ views: [{ ...VIEW, title: "Fixes #12: wait for checks" }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "undeclared: 1", false);
  });

  test("an undeclared closing keyword in a commit message", async () => {
    const runner = scenario({ commits: ["feat: x\n\ncloses #4"] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "undeclared: 1", false);
  });

  test("checks that outlast the timeout", async () => {
    const runner = scenario({ extra: [on(["gh", "pr", "checks"], { timedOut: true, code: null })] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "did not finish within 30 minutes", false);
  });

  test("a head that moved while checks ran", async () => {
    const runner = scenario({ views: [VIEW, { ...VIEW, headRefOid: "c".repeat(40) }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "head moved", false);
  });

  test("a failed check", async () => {
    const red = { ...VIEW, statusCheckRollup: [{ __typename: "CheckRun", name: "Pester", status: "COMPLETED", conclusion: "FAILURE" }] };
    const runner = scenario({ views: [VIEW, red] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "1 not successful", false);
  });

  // Review Focus 4: run straight after a push, before CI has registered any check.
  test("no checks registered yet", async () => {
    const runner = scenario({ views: [VIEW, { ...VIEW, statusCheckRollup: [] }] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "0 total", false);
  });

  test("a reviewer checkout whose origin is another repository", async () => {
    const runner = scenario({
      extra: [(argv) => (gitSub(argv)[0] === "remote" && argv.includes(CHECKOUT) ? { stdout: "https://github.com/someone/else.git\n" } : undefined)],
    });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "origin is not this repository", false);
  });

  test("a reviewer checkout that lags the default branch", async () => {
    const runner = scenario({ extra: [(argv) => (gitSub(argv)[0] === "rev-parse" ? { stdout: `${"e".repeat(40)}\n` } : undefined)] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "current head", false);
  });

  test("a dirty reviewer checkout", async () => {
    const runner = scenario();
    await refusal(
      reviewMerge(ctx(runner, { toolState: (root) => ({ revision: BASE_HEAD, dirty: root === CHECKOUT }) }), ARGS),
      runner,
      "not a clean copy",
      false,
    );
  });

  test("git missing from PATH", async () => {
    const runner = scenario({ extra: [(argv) => (argv[0] === "git" ? { spawnError: true, code: null } : undefined)] });
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "git is not on PATH", false);
  });
});

describe("review-merge: refuses after the reviewer runs", () => {
  test("a key command that failed", async () => {
    const runner = withReviewer(scenario(), reviewerSays("", 2, 1));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "key command failed", true);
  });

  test("a reviewer refusal, passing on its class-only reason", async () => {
    const runner = withReviewer(scenario(), reviewerSays(JSON.stringify({ status: "refused", refusal: "the pull request comes from a fork" }), 2));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "the reviewer refused: the pull request comes from a fork", true);
  });

  test("a COMMENT without --allow-admin", async () => {
    const output = JSON.stringify({ ...JSON.parse(APPROVE_OUTPUT), event: "COMMENT" });
    const runner = withReviewer(scenario(), reviewerSays(output));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "Only --allow-admin", true);
  });

  test("a head that moved after the review", async () => {
    const runner = withReviewer(scenario({ views: [VIEW, VIEW, { ...VIEW, headRefOid: "c".repeat(40) }] }), reviewerSays(APPROVE_OUTPUT));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "not the one that was reviewed", true);
  });

  test("a closing keyword added to the body after the review", async () => {
    const runner = withReviewer(scenario({ views: [VIEW, VIEW, { ...VIEW, body: "Closes #8" }] }), reviewerSays(APPROVE_OUTPUT));
    await refusal(reviewMerge(ctx(runner), ARGS), runner, "undeclared: 1", true);
  });

  test("a merge gh accepted that did not land is an error, not a success", async () => {
    const runner = withReviewer(scenario({ merged: "OPEN" }), reviewerSays(APPROVE_OUTPUT));
    await expect(reviewMerge(ctx(runner), ARGS)).rejects.toBeInstanceOf(PublishError);
  });

  test("reviewer output that is not JSON is an error", async () => {
    const runner = withReviewer(scenario(), reviewerSays("status=posted event=APPROVE"));
    await expect(reviewMerge(ctx(runner), ARGS)).rejects.toBeInstanceOf(PublishError);
    expect(runner.publishing()).toEqual([]);
  });
});

describe("remoteMatches()", () => {
  test("accepts https and ssh forms, with or without .git", () => {
    expect(remoteMatches(`https://github.com/${REPO}.git`, REPO)).toBe(true);
    expect(remoteMatches(`git@github.com:${REPO}`, REPO)).toBe(true);
    expect(remoteMatches(`https://github.com/${REPO}-fork.git`, REPO)).toBe(false);
  });
});
````

Expected sha256 of the extracted file: `5d9c5e2d5d002e5684b7316a4a2d1439d9bf31c52f5d74975be7b986335549e1`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-review-merge.test.ts`
Expected: FAIL, `../tools/publish/review-merge` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/review-merge.ts -->
````ts
// review-merge (#274): wait for CI, run the App reviewer from a clean default-branch checkout,
// and merge only on what merge-decision.ts allows. In order:
//
//   1. config names an owner identity for the repository. This tool's own checkout is clean and at
//      its origin's default branch head, the bar the reviewer checkout meets in step 6, because the
//      code that holds the token and makes the merge decision must be reviewed code too
//   2. config names a reviewer for the repository. With --allow-admin, the reason file reads and
//      passes the same text gates as a body. The reviewer checkout holds tools/pr-review/cli.ts
//   3. the pull request is open, not a draft, from this repository, and into the default branch.
//      Its head is pinned here as the head to review
//   4. closing keywords in the title, the body and every commit message equal --closes (early, so
//      a mismatch costs no model run). The title counts because a --merge merge commit carries it
//   5. `gh pr checks --watch`, bounded by --checks-timeout-min. Then every check must have
//      succeeded on the pinned head, which must not have moved
//   6. the reviewer checkout is fetched and detached at the default branch's current head, and
//      must then be clean (tools/pr-review/tool-state.ts) and at exactly that commit
//   7. the reviewer runs from the work directory, outside every checkout, with the key piped from
//      the configured key command, --expect-head pinned, --post and --json
//   8. the pull request is read again (waiting out an UNKNOWN merge state), the closing-keyword
//      audit repeats, and decideMerge rules
//   9. for an administrator-bypass merge, the reason is posted as a pull request comment first
//      (CONTRIBUTING.md has every bypass say why). Then gh pr merge with --match-head-commit, and
//      the merge is confirmed
//
// Every git call names the configured identity and a credential helper that answers with the
// configured account's token from the child environment, never the active gh account.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripControlChars } from "../pr-review/cli";
import type { IdentityLoad } from "../pr-review/identity";
import { ownerIdentity, reviewerConfig, type OwnerIdentity, type PublishConfig, type ReviewerConfig } from "./config";
import { PublishError, PublishRefusal } from "./errors";
import { parseRepo } from "../pr-review/types";
import { childEnv, type RunResult, type Runner } from "./exec";
import { Gh, type PrState } from "./gh";
import { checksSummary, decideMerge, enumText, parseReviewOutput, type ReviewResult } from "./merge-decision";
import { assertClean, loadBody } from "./publish";
import { compareClosing, findClosingRefs } from "./scan";

export const REVIEWER_TIMEOUT_MS = 45 * 60_000;
const MERGE_STATE_POLLS = 12;
const MERGE_STATE_POLL_MS = 10_000;

export interface ReviewMergeArgs {
  repo: string;
  pr: number;
  closes: number[];
  allowAdmin: boolean;
  // Required with allowAdmin (cli.ts enforces it). CONTRIBUTING.md has every administrator
  // bypass say why in the pull request, so this text is posted as a comment before such a merge.
  adminReasonFile: string | null;
  method: "merge" | "rebase";
  checksTimeoutMin: number;
}

export interface ReviewMergeContext {
  runner: Runner;
  config: PublishConfig;
  env: Record<string, string | undefined>;
  workDir: string;
  // The checkout this tool runs from. cli.ts passes the repository root above tools/publish.
  toolRoot: string;
  bunPath: string;
  exists: (path: string) => boolean;
  toolState: (root: string) => { revision: string; dirty: boolean };
  sleep: (ms: number) => void;
  log: (line: string) => void;
  loadIdentity: () => IdentityLoad;
  readBody: (path: string) => string;
}

export const realExists = existsSync;

function assertReviewable(pr: PrState, defaultBranch: string): void {
  if (pr.state !== "OPEN") throw new PublishRefusal("the pull request is not open");
  if (pr.isDraft) throw new PublishRefusal("the pull request is a draft");
  if (pr.isCrossRepository) throw new PublishRefusal("the pull request comes from another repository. Forks are not reviewed");
  if (pr.baseRefName !== defaultBranch) throw new PublishRefusal("the pull request does not target the default branch");
}

function auditClosing(gh: Gh, repo: string, view: PrState, declared: number[]): void {
  const texts = [view.title, view.body, ...gh.prCommitMessages(repo, view.number)];
  const verdict = compareClosing(
    texts.flatMap((text) => findClosingRefs(text, repo)),
    declared,
    repo,
  );
  if (!verdict.ok) throw new PublishRefusal(`not merged: ${verdict.reason} across the title, body and commit messages`);
}

// owner/name of a GitHub remote URL, or null for anything else.
export function remoteRepo(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match !== null && parseRepo(match[1]!) !== null ? match[1]! : null;
}

export function remoteMatches(url: string, repo: string): boolean {
  return remoteRepo(url)?.toLowerCase() === repo.toLowerCase();
}

function git(ctx: ReviewMergeContext, owner: OwnerIdentity, token: string, dir: string, args: string[]): RunResult {
  // ghUser is held to GH_USER_RE by config.ts, so it cannot carry shell syntax into the helper.
  const helper = `!f() { echo username=${owner.ghUser}; echo "password=$PUBLISH_GIT_TOKEN"; }; f`;
  const result = ctx.runner.run(
    [
      "git",
      "-c",
      `user.name=${owner.gitName}`,
      "-c",
      `user.email=${owner.gitEmail}`,
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helper}`,
      "-C",
      dir,
      ...args,
    ],
    { env: childEnv(ctx.env, { PUBLISH_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" }) },
  );
  if (result.spawnError) throw new PublishRefusal("git is not on PATH");
  return result;
}

function prepareReviewerCheckout(ctx: ReviewMergeContext, gh: Gh, owner: OwnerIdentity, reviewer: ReviewerConfig, repo: string, defaultBranch: string): void {
  const dir = reviewer.checkout;
  const origin = git(ctx, owner, gh.token, dir, ["remote", "get-url", "origin"]);
  if (origin.code !== 0 || !remoteMatches(origin.stdout, repo)) {
    throw new PublishRefusal("the reviewer checkout's origin is not this repository");
  }
  if (git(ctx, owner, gh.token, dir, ["fetch", "--quiet", "origin", defaultBranch]).code !== 0) {
    throw new PublishError("git fetch failed in the reviewer checkout");
  }
  const tracked = git(ctx, owner, gh.token, dir, ["rev-parse", `refs/remotes/origin/${defaultBranch}`]);
  const sha = tracked.stdout.trim();
  if (tracked.code !== 0 || sha !== gh.branchHead(repo, defaultBranch)) {
    throw new PublishRefusal("the reviewer checkout could not be brought to the default branch's current head");
  }
  if (git(ctx, owner, gh.token, dir, ["checkout", "--quiet", "--detach", sha]).code !== 0) {
    throw new PublishRefusal("the reviewer checkout could not be switched to the default branch head. It may carry local changes");
  }
  let state: { revision: string; dirty: boolean };
  try {
    state = ctx.toolState(dir);
  } catch {
    throw new PublishRefusal("the reviewer checkout is not a readable git checkout");
  }
  if (state.dirty || state.revision !== sha) throw new PublishRefusal("the reviewer checkout is not a clean copy of the default branch head");
}

// The tool's own checkout is often an operator's working clone, on another branch or carrying
// edits. An edited or stale merge-decision.ts there would decide merges, so that checkout must be
// clean and at its origin's default branch head before anything else runs.
function assertToolCurrent(ctx: ReviewMergeContext, gh: Gh, owner: OwnerIdentity): void {
  let state: { revision: string; dirty: boolean };
  try {
    state = ctx.toolState(ctx.toolRoot);
  } catch {
    throw new PublishRefusal("this tool is not running from a readable git checkout");
  }
  if (state.dirty) {
    throw new PublishRefusal("this tool's own checkout has uncommitted changes. Run review-merge from a clean checkout of the default branch");
  }
  const origin = git(ctx, owner, gh.token, ctx.toolRoot, ["remote", "get-url", "origin"]);
  const toolRepo = origin.code === 0 ? remoteRepo(origin.stdout) : null;
  if (toolRepo === null) throw new PublishRefusal("this tool's own checkout has no GitHub origin");
  if (state.revision !== gh.branchHead(toolRepo, gh.defaultBranch(toolRepo))) {
    throw new PublishRefusal("this tool's own checkout is not at its default branch's current head. Update it and run again");
  }
}

async function runReviewer(ctx: ReviewMergeContext, reviewer: ReviewerConfig, cli: string, repo: string, pr: number, head: string): Promise<ReviewResult> {
  const run = await ctx.runner.runPiped(
    { argv: reviewer.keyCommand, cwd: ctx.workDir, env: childEnv(ctx.env, reviewer.keyCommandEnv) },
    {
      argv: [ctx.bunPath, "--cwd", ctx.workDir, cli, "review", "--pr", String(pr), "--repo", repo, "--key-stdin", "--post", "--json", "--expect-head", head],
      cwd: ctx.workDir,
      env: childEnv(ctx.env, { PR_REVIEW_APP_ID: reviewer.appId }),
      timeoutMs: REVIEWER_TIMEOUT_MS,
    },
  );
  if (run.producerSpawnError) throw new PublishRefusal("the configured key command could not be started");
  if (run.consumer.spawnError) throw new PublishRefusal("bun could not start the reviewer");
  if (run.consumer.timedOut) {
    throw new PublishError("the reviewer did not finish in time. Check the pull request for a posted review before running again");
  }
  if (run.producerCode !== 0) throw new PublishRefusal("the configured key command failed. Nothing was merged");
  if (run.consumer.code === 2) {
    let detail = "";
    try {
      const parsed = JSON.parse(run.consumer.stdout) as { refusal?: unknown };
      if (typeof parsed.refusal === "string") detail = `: ${stripControlChars(parsed.refusal)}`;
    } catch {
      // A refusal raised before the reviewer reads its key prints no JSON. The exit code says enough.
    }
    throw new PublishRefusal(`the reviewer refused${detail}. Nothing was merged`);
  }
  if (run.consumer.code !== 0) {
    throw new PublishError("the reviewer exited with an error. A review may already have been posted, so check the pull request before running again");
  }
  return parseReviewOutput(run.consumer.stdout);
}

function settledView(ctx: ReviewMergeContext, gh: Gh, repo: string, pr: number): PrState {
  let view = gh.prView(repo, pr);
  for (let i = 0; i < MERGE_STATE_POLLS && view.mergeStateStatus === "UNKNOWN"; i++) {
    ctx.sleep(MERGE_STATE_POLL_MS);
    view = gh.prView(repo, pr);
  }
  return view;
}

export async function reviewMerge(ctx: ReviewMergeContext, args: ReviewMergeArgs): Promise<string> {
  const owner = ownerIdentity(ctx.config, args.repo);
  const gh = Gh.forUser(ctx.runner, owner.ghUser, ctx.env);
  assertToolCurrent(ctx, gh, owner);
  // Read and scanned before the pull request is touched, so a reason that would be refused costs
  // no model run.
  let adminReason: string | null = null;
  if (args.allowAdmin) {
    if (args.adminReasonFile === null) throw new PublishRefusal("--allow-admin needs --admin-reason-file");
    adminReason = loadBody(ctx, args.adminReasonFile, "--admin-reason-file");
    assertClean(ctx, [{ label: "admin reason", text: adminReason }]);
    if (findClosingRefs(adminReason, args.repo).length > 0) throw new PublishRefusal("the admin reason carries a closing keyword");
  }
  const reviewer = reviewerConfig(ctx.config, args.repo);
  const cli = join(reviewer.checkout, "tools", "pr-review", "cli.ts");
  if (!ctx.exists(cli)) throw new PublishRefusal("the reviewer checkout holds no tools/pr-review/cli.ts");

  const defaultBranch = gh.defaultBranch(args.repo);
  const first = gh.prView(args.repo, args.pr);
  assertReviewable(first, defaultBranch);
  const head = first.headRefOid;
  auditClosing(gh, args.repo, first, args.closes);

  if (gh.watchChecks(args.repo, args.pr, args.checksTimeoutMin * 60_000) === "timed-out") {
    throw new PublishRefusal(`checks did not finish within ${args.checksTimeoutMin} minutes. Nothing was reviewed or merged`);
  }
  const afterChecks = gh.prView(args.repo, args.pr);
  if (afterChecks.headRefOid !== head) throw new PublishRefusal("the head moved while checks ran. Nothing was reviewed or merged");
  const checks = checksSummary(afterChecks.checks);
  if (!checks.ok) {
    throw new PublishRefusal(
      `not every check succeeded (${checks.total} total, ${checks.failing} not successful, ${checks.pending} pending). Nothing was reviewed or merged`,
    );
  }

  prepareReviewerCheckout(ctx, gh, owner, reviewer, args.repo, defaultBranch);
  const review = await runReviewer(ctx, reviewer, cli, args.repo, args.pr, head);
  ctx.log(`review: status=${enumText(review.status)} event=${enumText(review.event)} findings=${review.severities.length}`);

  const final = settledView(ctx, gh, args.repo, args.pr);
  assertReviewable(final, defaultBranch);
  auditClosing(gh, args.repo, final, args.closes);
  const decision = decideMerge({
    review,
    reviewedHead: head,
    currentHead: final.headRefOid,
    checks: final.checks,
    mergeState: final.mergeStateStatus,
    allowAdmin: args.allowAdmin,
  });
  if (decision.action === "refuse") throw new PublishRefusal(`not merged: ${decision.reason}`);

  if (decision.admin) {
    if (adminReason === null) throw new PublishRefusal("an administrator-bypass merge needs a reason");
    gh.commentPr(args.repo, args.pr, adminReason);
  }
  gh.mergePr(args.repo, args.pr, head, args.method, decision.admin);
  const merged = gh.mergedState(args.repo, args.pr);
  if (merged.state !== "MERGED" || merged.mergeSha === null) {
    throw new PublishError("gh reported no error, but the pull request is not merged. Check it for auto-merge before running again");
  }
  return `merged #${args.pr} at ${merged.mergeSha.slice(0, 7)} (${decision.admin ? "administrator bypass" : "App approval"})`;
}
````

Expected sha256 of the extracted file: `057fa12de3f13e368db25b287e97b2b083dd41f166d4eed9166fe57bc603ce63`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-review-merge.test.ts`
Expected: `33 pass`, `0 fail`.

- [ ] **Step 5: Ablate, three times**

First, delete the block that starts `const checks = checksSummary(afterChecks.checks);` and ends with its closing `}` (the pre-review check gate). Expected: `a failed check` and `no checks registered yet` fail, because the reviewer now runs before the later decision refuses (measured on the prototype, 2026-10-06). Restore.

Second, delete `gh.commentPr(args.repo, args.pr, adminReason);`. Expected: `uses the administrator bypass for a COMMENT with --allow-admin, posting the reason first` fails. Restore.

Third, in `prepareReviewerCheckout`, change `if (state.dirty || state.revision !== sha)` to `if (state.revision !== sha)`. Expected: `a dirty reviewer checkout` fails. Restore.

Fourth, in `reviewMerge`, delete `assertToolCurrent(ctx, gh, owner);`. Expected: `this tool's own checkout carrying uncommitted changes`, `this tool's own checkout away from the default branch head` and `names the configured identity and token helper on every git call` (which counts five git calls) fail (measured 2026-10-06). Restore.

Fifth, in `auditClosing`, change `const texts = [view.title, view.body, ` to `const texts = [view.body, `. Expected: `an undeclared closing keyword in the title` fails. Restore and re-run to `33 pass`.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add tools/publish/review-merge.ts test/publish-review-merge.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): review-merge from a clean default-branch checkout (#274)

Waits on gh pr checks --watch with a bound, then requires every check to
have succeeded on the pinned head before spending a model run. The
reviewer runs from a checkout fetched and detached at the default
branch's current head, verified clean, with its key piped from the
configured command and --expect-head pinned. The checkout this tool
runs from meets the same bar first, clean and at its origin's default
branch head, because it holds the token and makes the merge decision.
Closing keywords in the title, the body and every commit message are
audited before and after the review. The title counts because a
--merge merge commit carries it.
An administrator-bypass merge first posts the operator's reason on the
pull request, because CONTRIBUTING.md has every bypass say why, and
every merge passes --match-head-commit."
```

### Task 9: The command line and the working-directory guard

**Security-bearing:** yes. The guard keeps Bun from loading a checkout's config into a process holding credentials.

**Files:**
- Create: `tools/publish/cli.ts`
- Create: `test/publish-cli.test.ts`

**Interfaces:**
- Consumes: everything above. `cwdHasAutoloadFile`, `stripControlChars` from `tools/pr-review/cli.ts`. `loadIdentity`, `IdentityLoad` from `tools/pr-review/identity.ts`. `toolState` from `tools/pr-review/tool-state.ts`. `parseRepo` from `tools/pr-review/types.ts`.
- Produces:
  - `USAGE: string`
  - `type Command` (union of `help` and the five commands, each carrying its Args fields)
  - `parseCommand(argv: readonly string[]): Command` (throws `UsageError`)
  - `assertNeutralCwd(cwd: string, workDir: string, runner: Runner, env: Record<string, string | undefined>): void`
  - `interface CliDeps`, `realDeps(): CliDeps`
  - `main(argv: readonly string[], deps: CliDeps): Promise<number>`

- [ ] **Step 1: Lay down the failing test**

<!-- file: test/publish-cli.test.ts -->
````ts
// Tests for tools/publish/cli.ts (#274): argument parsing, the working-directory guard, and the
// exit code and output for each way a command ends.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNeutralCwd, main, parseCommand, type CliDeps } from "../tools/publish/cli";
import { parsePublishConfig } from "../tools/publish/config";
import { PublishRefusal, UsageError } from "../tools/publish/errors";
import { FakeRunner, on, REPO } from "./publish-fakes";

const ROOT = mkdtempSync(join(tmpdir(), "publish-cli-"));
const WORK = join(ROOT, "work");
const ELSEWHERE = join(ROOT, "elsewhere");
mkdirSync(WORK);
mkdirSync(ELSEWHERE);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const NOT_A_REPO = on(["git", "-C"], { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" });
const ABS = process.platform === "win32" ? "C:/fixture/body.md" : "/fixture/body.md";

describe("parseCommand()", () => {
  test("parses pr create", () => {
    expect(
      parseCommand(["pr", "create", "--repo", REPO, "--base", "main", "--head", "feat/x", "--title", "t", "--body-file", ABS, "--closes", "4,5", "--draft"]),
    ).toEqual({ kind: "pr-create", repo: REPO, base: "main", head: "feat/x", title: "t", bodyFile: ABS, closes: [4, 5], draft: true });
  });

  test("parses review-merge with its defaults", () => {
    expect(parseCommand(["review-merge", "--repo", REPO, "--pr", "9"])).toEqual({
      kind: "review-merge",
      repo: REPO,
      pr: 9,
      closes: [],
      allowAdmin: false,
      adminReasonFile: null,
      method: "merge",
      checksTimeoutMin: 30,
    });
  });

  test("takes --allow-admin only together with --admin-reason-file", () => {
    expect(() => parseCommand(["review-merge", "--repo", REPO, "--pr", "9", "--allow-admin"])).toThrow(UsageError);
    expect(() => parseCommand(["review-merge", "--repo", REPO, "--pr", "9", "--admin-reason-file", ABS])).toThrow(UsageError);
    expect(parseCommand(["review-merge", "--repo", REPO, "--pr", "9", "--allow-admin", "--admin-reason-file", ABS])).toMatchObject({
      allowAdmin: true,
      adminReasonFile: ABS,
    });
  });

  test("requires an explicit repository", () => {
    expect(() => parseCommand(["issue", "create", "--title", "t", "--body-file", ABS])).toThrow(UsageError);
  });

  test("requires an explicit base on pr create and pr edit", () => {
    expect(() => parseCommand(["pr", "create", "--repo", REPO, "--head", "feat/x", "--title", "t", "--body-file", ABS])).toThrow(UsageError);
    expect(() => parseCommand(["pr", "edit", "--repo", REPO, "--pr", "9", "--title", "t"])).toThrow(UsageError);
  });

  test("takes the body only from a file", () => {
    expect(() => parseCommand(["issue", "create", "--repo", REPO, "--title", "t", "--body", "inline"])).toThrow(UsageError);
    expect(() => parseCommand(["issue", "create", "--repo", REPO, "--title", "t", "--body-file", "-"])).toThrow(UsageError);
  });

  test("rejects a multi-line title", () => {
    expect(() => parseCommand(["issue", "create", "--repo", REPO, "--title", "a\nb", "--body-file", ABS])).toThrow(UsageError);
  });

  test("rejects a branch name that reads as a flag", () => {
    expect(() => parseCommand(["pr", "create", "--repo", REPO, "--base", "main", "--head", "-x", "--title", "t", "--body-file", ABS])).toThrow(UsageError);
  });

  test("rejects --closes on pr edit without a new body", () => {
    expect(() => parseCommand(["pr", "edit", "--repo", REPO, "--pr", "9", "--base", "main", "--title", "t", "--closes", "4"])).toThrow(UsageError);
  });

  test("rejects an out-of-range checks timeout and an unknown merge method", () => {
    expect(() => parseCommand(["review-merge", "--repo", REPO, "--pr", "9", "--checks-timeout-min", "0"])).toThrow(UsageError);
    expect(() => parseCommand(["review-merge", "--repo", REPO, "--pr", "9", "--method", "squash"])).toThrow(UsageError);
  });
});

describe("assertNeutralCwd()", () => {
  test("passes in the empty work directory outside any work tree", () => {
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([NOT_A_REPO]), {})).not.toThrow();
  });

  test("refuses any other working directory", () => {
    expect(() => assertNeutralCwd(ELSEWHERE, WORK, new FakeRunner([NOT_A_REPO]), {})).toThrow(PublishRefusal);
  });

  test("refuses a work directory that does not exist", () => {
    const missing = join(ROOT, "missing");
    expect(() => assertNeutralCwd(missing, missing, new FakeRunner([NOT_A_REPO]), {})).toThrow(PublishRefusal);
  });

  test("refuses a work directory holding a bunfig.toml", () => {
    const dir = join(ROOT, "with-bunfig");
    mkdirSync(dir);
    writeFileSync(join(dir, "bunfig.toml"), "");
    expect(() => assertNeutralCwd(dir, dir, new FakeRunner([NOT_A_REPO]), {})).toThrow(PublishRefusal);
  });

  test("refuses a work directory inside a git work tree", () => {
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([on(["git", "-C"], { stdout: "true\n" })]), {})).toThrow(PublishRefusal);
  });

  test("refuses when git is not on PATH", () => {
    expect(() => assertNeutralCwd(WORK, WORK, new FakeRunner([on(["git"], { spawnError: true, code: null })]), {})).toThrow(PublishRefusal);
  });

  test("runs the git probe in the C locale", () => {
    const runner = new FakeRunner([NOT_A_REPO]);
    assertNeutralCwd(WORK, WORK, runner, {});
    expect(runner.calls[0]!.options.env?.LC_ALL).toBe("C");
  });
});

describe("main()", () => {
  function deps(overrides: Partial<CliDeps> = {}): CliDeps & { lines: { out: string[]; err: string[] } } {
    const lines = { out: [] as string[], err: [] as string[] };
    return {
      runner: new FakeRunner([NOT_A_REPO]),
      cwd: WORK,
      workDir: WORK,
      toolRoot: WORK,
      env: {},
      loadConfig: () => parsePublishConfig(JSON.stringify({ owners: { other: { gitName: "o", gitEmail: "o@example.test", ghUser: "other" } } })),
      loadIdentity: () => ({ ok: true, declared: true, accountEmail: true, decl: { names: [], emails: [], username: "fixtureuser", hostname: "fixture-host" } }),
      readBody: () => "body",
      exists: () => true,
      toolState: () => ({ revision: "x", dirty: false }),
      sleep: () => {},
      bunPath: "bun",
      out: (line) => lines.out.push(line),
      err: (line) => lines.err.push(line),
      lines,
      ...overrides,
    };
  }
  const CREATE = ["issue", "create", "--repo", REPO, "--title", "t", "--body-file", ABS];

  test("help exits 0", async () => {
    expect(await main(["help"], deps())).toBe(0);
  });

  test("a usage error exits 1", async () => {
    const d = deps();
    expect(await main(["issue", "create"], d)).toBe(1);
    expect(d.lines.err[0]).toStartWith("usage error:");
  });

  test("a refusal exits 2 with a refused line", async () => {
    const d = deps();
    expect(await main(CREATE, d)).toBe(2);
    expect(d.lines.err).toEqual(["refused: the publish config declares no identity for this repository's owner"]);
  });

  test("the working-directory guard refuses before the config is read", async () => {
    let read = false;
    const d = deps({
      cwd: ELSEWHERE,
      loadConfig: () => {
        read = true;
        throw new Error("unreachable");
      },
    });
    expect(await main(CREATE, d)).toBe(2);
    expect(read).toBe(false);
  });

  test("an unexpected error prints its class and never its message", async () => {
    const d = deps({
      loadConfig: () => {
        throw new SyntaxError("Unexpected token in fixture-secret-text");
      },
    });
    expect(await main(CREATE, d)).toBe(1);
    expect(d.lines.err).toEqual(["error: unexpected failure (SyntaxError)"]);
  });
});
````

Expected sha256 of the extracted file: `02cbacd28f00f8c219d87afbbef9712af0feb59b0c5244050800b673eeb707e8`

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/publish-cli.test.ts`
Expected: FAIL, `../tools/publish/cli` cannot be found.

- [ ] **Step 3: Lay down the implementation**

<!-- file: tools/publish/cli.ts -->
````ts
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
````

Expected sha256 of the extracted file: `5a6fae292bde962cf16315480517425ac8959402253a27d42860c66a30709e0e`

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/publish-cli.test.ts`
Expected: `22 pass`, `0 fail`.

- [ ] **Step 5: Ablate**

In `assertNeutralCwd`, change `if (here === null || work === null || here !== work) {` to `if (here === null || work === null) {`. Expected: `refuses any other working directory` and `the working-directory guard refuses before the config is read` fail. Restore and re-run to `22 pass`.

- [ ] **Step 6: Smoke the real entry point**

From the worktree root in Bash:

Run: `bun --cwd "$(mktemp -d)" "$PWD/tools/publish/cli.ts" help`
Expected: five usage lines, exit 0.

Run: `bun --cwd "$(mktemp -d)" "$PWD/tools/publish/cli.ts" issue create --repo fixture-owner/fixture-repo --title t --body-file /nonexistent/body.md; echo "exit=$?"`
Expected: `refused: run this tool as bun --cwd <home>/.claude-publish/work ...` and `exit=2`. A temp directory is not the work directory, so this is the guard refusing before any config or gh call. The same two results were measured on the prototype from PowerShell, 2026-10-06.

- [ ] **Step 7: Run the whole suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 8: Commit**

```bash
git add tools/publish/cli.ts test/publish-cli.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(publish): command line and working-directory guard (#274)

Bun loads bunfig.toml and .env from the working directory before any
code runs, and bun --cwd moves that load to the named directory
(measured on 1.3.14). The tool holds a token and, for review-merge,
streams the App key, so it runs only from ~/.claude-publish/work, empty
and outside every git work tree. An error that is not one of the tool's
own prints only its class, since a library message can quote its input."
```

### Task 10: Documentation

**Security-bearing:** no.

**Executor:** a prose agent dispatched with `model: fable`, per the operator's rule for prose deliverables. The facts below are the contract. The wording is the agent's.

**Files:**
- Create: `tools/publish/README.md`
- Modify: `README.md` (the "What's here" table and the "Testing and merging" section)
- Modify: `CONTRIBUTING.md:29` (the merge flow)

- [ ] **Step 1: Write `tools/publish/README.md`**

It must state each of these, and nothing that contradicts the code laid down in Tasks 1-9:

- What it is: the route by which agents file issues, open and edit pull requests, and review and merge them. Repository tooling like `tools/pr-review/`, not part of core, and nothing under `install/` copies it.
- How to run it: `bun --cwd <home>/.claude-publish/work <absolute path>/tools/publish/cli.ts <command>`, and why: the BUN-CWD reason and the 2026-10-06 measurement that `--cwd` moves the bunfig and `.env` load. The work directory must be empty and outside every git work tree, and the tool refuses otherwise.
- review-merge runs only from a checkout that is clean, untracked files included, and at its origin's default branch head, the bar the reviewer checkout meets, because that code holds the token and makes the merge decision. Keep a dedicated clone for it (`~/.claude-publish/tool` in the operator's setup, which also serves as the reviewer checkout) and bring it to the default branch head before each run: `git -C <clone> fetch origin <default branch>`, then `git -C <clone> checkout --detach origin/<default branch>`.
- review-merge is a long run: up to `--checks-timeout-min` (30 by default) waiting for checks, then up to 45 minutes for the reviewer. That is longer than a tool shell's foreground limit (10 minutes in Claude Code's Bash tool). Run it in the background with stdout and stderr redirected to a log file and an exit line appended after it (`... > <log> 2>&1; echo "exit=$?" >> <log>`), then poll the log with a bounded wait until the exit line appears. Do not wait on the background task's completion notice instead: it reports on the shell that started the run, and a dispatched agent is not woken by it.
- Setup: `~/.claude-publish/config.json`, shown with placeholders only:
  `{ "owners": { "<owner>": { "gitName": "...", "gitEmail": "...", "ghUser": "..." } }, "reviewers": { "<owner>/<name>": { "appId": "<numeric App ID>", "keyCommand": ["pwsh", "-NoProfile", "-File", "<absolute path>/read-reviewer-key.ps1"], "keyCommandEnv": { "OP_BIOMETRIC_UNLOCK_ENABLED": "false" }, "checkout": "<absolute path to a dedicated clone>" } } }`.
  Every field is validated and a missing one refuses. Values are never printed. The reviewer checkout's origin must be the repository, the tool fetches it and detaches it at the default branch head, and refuses when it is dirty.
- The key command fetches its own credential. The config file is plain text, so `keyCommandEnv` carries only non-secret settings, and the tool refuses a variable whose name contains TOKEN, SECRET, KEY or PASSWORD. Where the key sits behind a 1Password service account, whose token `op` reads from `OP_SERVICE_ACCOUNT_TOKEN`, the key command is a wrapper script kept outside every repository that decrypts the token into its own environment and runs `op read`, so the token exists only in that process and its `op` child. Show this Windows form, placeholders only, with the token saved once by `Read-Host -AsSecureString | Export-Clixml <token file>` (DPAPI, readable only by the same user on the same machine):

  ```powershell
  $ErrorActionPreference = 'Stop'
  $secure = Import-Clixml '<absolute path to the token file>'
  $env:OP_SERVICE_ACCOUNT_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
  op read '<secret reference>'
  exit $LASTEXITCODE
  ```
- The five commands with their flags, copied from `USAGE` in `tools/publish/cli.ts`.
- Exit codes: 0 done, 2 refused with nothing new published, 1 usage or runtime error. After a review-merge refusal that follows its `review:` line, the App's review was posted and nothing merged.
- The create and edit gates in the order `tools/publish/publish.ts`'s header lists them.
- review-merge's steps in the order `tools/publish/review-merge.ts`'s header lists them, and the merge rule from `tools/publish/merge-decision.ts`'s header, including that `--allow-admin` requires `--admin-reason-file` and that the reason is posted before the bypass merge.
- Limits: forks are refused. Closing keywords inside code spans count. A pull request with more commits than GitHub's commits endpoint returns (250) is refused. Only `SUCCESS` counts as a passing check. Issue forms (`.yml`) are not supported. A body line opening with "Generated with" is refused.
- The permission rule: the account layer denies raw `gh pr create`, `gh issue create` and `gh pr merge` in the Bash and PowerShell tools. It is a policy line rather than a boundary, citing Claude Code's permission docs: `gh -R x pr create`, `gh api` and `sh -c` are not matched.

- [ ] **Step 2: Update `README.md`**

- Add a row to the "What's here" table, after the `tools/pr-review/` row: `tools/publish/`, the publish route for issues, pull requests and review-then-merge, fail-closed, not part of core and installed nowhere, with a link to `tools/publish/README.md`.
- In the `test/` row, add `tools/publish/` to the list of what the suite covers.
- In "Testing and merging", say that merges go through `tools/publish/cli.ts review-merge`, which runs the App reviewer and merges only on what its merge rule allows, and that the account layer denies raw `gh pr merge`. Keep the existing sentence that the bypass is policy rather than enforcement true: the deny rule does not change that, and say so.

- [ ] **Step 3: Update `CONTRIBUTING.md:29`**

Replace the instruction to pipe the key into `tools/pr-review/cli.ts ... --post` and merge with `gh pr merge` by hand with the `review-merge` command (`bun --cwd <home>/.claude-publish/work <absolute path>/tools/publish/cli.ts review-merge --repo Cringely/agent-harness-core --pr <n> [--closes <n,n>]`), and add that issues and pull requests are opened through the same tool. Keep every other sentence of that paragraph, including the bypass rules, the "CI required" ruleset, and that each bypass says why in the pull request, now posted by `--admin-reason-file`.

- [ ] **Step 4: Check the facts landed**

Run: `grep -c "tools/publish/" README.md`
Expected: 2 or more.

Run: `grep -c "review-merge" CONTRIBUTING.md`
Expected: 1 or more.

Run: `grep -c -e "--admin-reason-file" -e "claude-publish/config.json" -e "bun --cwd" tools/publish/README.md`
Expected: 3 or more.

- [ ] **Step 5: Commit**

The `pre-commit` hook lints staged Markdown with Vale and refuses on findings. Fix any finding in the prose rather than bypassing the hook.

```bash
git add tools/publish/README.md README.md CONTRIBUTING.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "docs(publish): document the publish route and the merge flow (#274)

README's What's here, test row and Testing and merging, and
CONTRIBUTING's merge paragraph, now describe merging through
tools/publish review-merge. Both are living docs the reviewer reads
against the diff, so a merge-flow change that left them describing the
hand-run pipe would be drift."
```

### Task 11: Skill and deny rules through the account layer

**Security-bearing:** yes. It writes the operator's live settings and distributes a permission rule.

**Executor:** the coordinator, after the operator approves "Decisions for the operator before Task 11". Not a dispatched agent: this task edits the live account layer under `~/.claude/`, and `install/AccountShared.ps1`'s new row must land in the same commit as the export, because the exporter throws for a templated row whose file is absent (`install/Export-Account.ps1:804-861`).

**Files:**
- Create (live): `~/.claude/skills/publish/SKILL.md`
- Modify (live): `~/.claude/settings.json` (`permissions.deny`)
- Modify: `install/AccountShared.ps1` (`$AccountTemplatedFiles`)
- Modify: `install/Export-Account.Tests.ps1` (`New-StandInHome` fixture)
- Create: `test/publish-permission-rule.test.ts`
- Generated: `account/claude/skills/publish/SKILL.md`, `account/claude/settings.account.json`

Every command in this task runs in Bash from the worktree root. Git Bash's `$HOME` is not the Windows profile on this workstation, so the live paths come from `os.homedir()` inside bun or from `${USERPROFILE:-$HOME}`.

- [ ] **Step 1: Back up the live settings**

Run:

```bash
bun -e 'const fs=require("fs"),path=require("path");const p=path.join(require("os").homedir(),".claude","settings.json");const stamp=new Date().toISOString().slice(0,19).split("-").join("").split(":").join("").replace("T","-");fs.copyFileSync(p,p+".bak."+stamp);console.log("backup "+stamp);'
```

Expected: `backup <yyyyMMdd-HHmmss>` in UTC, and that backup beside the live file.

- [ ] **Step 2: Lay down the live skill**

The marker below is not a repository path, so the extractor from Global Constraints gets an explicit destination as its third argument:

Run:

```bash
bun -e 'const fs=require("fs");const [plan,target,out]=process.argv.slice(1);const NL=String.fromCharCode(10),CR=String.fromCharCode(13);const lines=fs.readFileSync(plan,"utf8").split(NL).map(l=>l.endsWith(CR)?l.slice(0,-1):l);const at=lines.indexOf("<!-- file: "+target+" -->");if(at<0||!lines[at+1].startsWith("````"))throw new Error("no block for "+target);const end=lines.indexOf("````",at+2);const dest=out??target;fs.mkdirSync(require("path").dirname(dest),{recursive:true});fs.writeFileSync(dest,lines.slice(at+2,end).join(NL)+NL);console.log(require("crypto").createHash("sha256").update(fs.readFileSync(dest)).digest("hex"));' docs/superpowers/plans/2026-10-06-publish-tool.md live:skills/publish/SKILL.md "${USERPROFILE:-$HOME}/.claude/skills/publish/SKILL.md"
```

Expected: the sha256 printed under the block below.

<!-- file: live:skills/publish/SKILL.md -->
````markdown
---
name: publish
description: Use before filing a GitHub issue, opening or editing a pull request, or merging one. Every publish goes through tools/publish in agent-harness-core, which refuses identifying strings, session links, attribution lines, undeclared closing keywords and unfilled templates. Carries the pull request and issue body shapes and the rule for when an issue gets filed.
---

# Publish

Every issue, pull request and merge goes through `tools/publish/cli.ts` in agent-harness-core. A permission rule denies raw `gh pr create`, `gh issue create` and `gh pr merge`. Do not route around it with `gh api`, a flag placed before the subcommand, `sh -c` or a script. The rule is a policy line rather than a sandbox, and crossing it breaks the policy even where the shell lets the command through.

## Running it

The tool holds a GitHub token and, for review-merge, streams the reviewer App's key. It runs only from its own empty work directory, named with `bun --cwd`, and refuses anywhere else.

Bash:

    bun --cwd "${USERPROFILE:-$HOME}/.claude-publish/work" E:/projects/agent-harness-core/tools/publish/cli.ts <command> ...

PowerShell:

    bun --cwd "$HOME/.claude-publish/work" E:/projects/agent-harness-core/tools/publish/cli.ts <command> ...

Commands:

    issue create  --repo <owner/name> --title <t> --body-file <abs path> [--template <file.md>]
    issue edit    --repo <owner/name> --issue <n> [--title <t>] [--body-file <abs path> [--template <file.md>]]
    pr create     --repo <owner/name> --base <branch> --head <branch> --title <t> --body-file <abs path> [--closes <n,n>] [--draft]
    pr edit       --repo <owner/name> --pr <n> --base <branch> [--title <t>] [--body-file <abs path> [--closes <n,n>]]
    review-merge  --repo <owner/name> --pr <n> [--closes <n,n>] [--allow-admin --admin-reason-file <abs path>] [--method merge|rebase] [--checks-timeout-min <1-180>]

Write every body to a file in your scratchpad first and pass its absolute path. There is no inline body option. Push the head branch before `pr create`, because the tool never pushes.

review-merge runs from the dedicated clone at `~/.claude-publish/tool` instead, and refuses unless that clone is clean and at its origin's default branch head, because that code holds the token and makes the merge decision. It can also run for over an hour: up to `--checks-timeout-min` (30 by default) for checks, then up to 45 minutes for the reviewer, past a tool shell's 10-minute foreground limit. So bring the clone up to date, start the run in the background with its output in a log file in your scratchpad, and poll that log with a bounded wait until its `exit=` line appears. In Bash, each line its own command, with `<n>` the pull request number:

    git -C "${USERPROFILE:-$HOME}/.claude-publish/tool" fetch --quiet origin master
    git -C "${USERPROFILE:-$HOME}/.claude-publish/tool" checkout --quiet --detach origin/master
    bun --cwd "${USERPROFILE:-$HOME}/.claude-publish/work" "${USERPROFILE:-$HOME}/.claude-publish/tool/tools/publish/cli.ts" review-merge --repo <owner/name> --pr <n> ... > <scratchpad>/review-merge-<n>.log 2>&1; echo "exit=$?" >> <scratchpad>/review-merge-<n>.log

Start the third line with the shell tool's background option, and never wait on that option's completion notice: it reports on the shell, and a dispatched agent is not woken by it. Read the log's last lines once the `exit=` line is there.

## Exit codes

- 0: done. The last line on stdout is the URL or the merge result.
- 2: refused, and nothing new was published. The message names the class of problem, such as `body: Co-Authored-By line` or `closing keywords do not match --closes (undeclared: 1, missing: 0)`, and never the text that tripped it. Fix the body or the arguments and run again. Never disguise a name or a link to get it past a gate, since a disguised one still publishes it.
- 1: a usage error, or a dependency failed partway. When the message says a review may already have been posted, look at the pull request before running again.

A review-merge refusal printed after its `review:` line means the App's review was posted and nothing was merged.

## Closing keywords

`--closes` lists exactly the issues the merge closes, and the body carries `Closes #<n>` for each one. Every keyword in the body, and for review-merge in every commit message, has to be declared, and every declared issue has to be closed by one. GitHub acts on keywords only on a pull request into the default branch, so the tool refuses them on any other base. A keyword in prose counts too, inside backticks included. Write "issue 12" rather than "fixes #12" to mention an issue without closing it.

## Pull request body

The shape follows the scannable-structure row of writing-style.md: an opening sentence or two, then bold labels, each over a real bulleted list.

    <One or two sentences: what the change is and which part matters most.>

    **<Area, in the order a reader walks the diff>**
    - <One or two sentences per claim, linked to the diff where that helps.>

    **Testing**
    - <The command that ran and what it reported.>

    **Known gaps**
    - <What is still unproven or uncovered, or "None known.">

    Closes #<n>
    Docs: README still accurate: <what was checked>

The `Closes` line appears only with a matching `--closes`. In agent-harness-core the Docs line is required, in one of the two forms CONTRIBUTING.md defines. When the repository has a pull request template, fill every one of its sections instead, since the tool refuses a body that leaves one empty.

When a later push changes what the body claims, update the body with `pr edit` before running review-merge.

## Issue body

    <One sentence: what is wanted and who asked for it.>

    **Why**
    - <The failure or the need, with its evidence.>

    **Scope**
    1. <Each deliverable.>

    **Constraints**
    - <What has to hold.>

    **Done when**
    - <The checkable condition that closes it.>

When one of the repository's issue templates applies, pass `--template <file.md>` and fill every section of it instead.

## When an issue gets filed

From "Discovery is not commitment, and not a filing either" in fix-quality.md:

- An issue is filed for an operator instruction that names work, for a correctness or security gap outside the scope of the pull request under review, or for a decision that belongs to the operator. The operator is told each time one is filed.
- A finding below the review's severity floor stays in the review comment and does not become an issue.
- An agent doing the work never opens an issue of its own. The coordinator files one after deciding the finding qualifies.
- A burn-down is reported by its net change in open issues, never by closes alone.

## Merging

`review-merge` waits for CI, runs the App reviewer from a clean default-branch checkout, and merges only when the App approved, every check succeeded and the head is the one that was reviewed. `--allow-admin` permits the administrator bypass in two cases: the App approved a change on an owned path, or the App could only comment and reported no finding at or above the severity floor. It needs `--admin-reason-file`, and the tool posts that reason on the pull request before it merges. Pass it only when the operator ordered the bypass for that pull request.
````

Expected sha256 of the extracted file: `c67f274d21368e8d72c21b0cdc31eedce1882c16f6717a28fc83e10d3899500c`

The skill names `E:/projects/agent-harness-core` because that is this workstation's core checkout. The export folds it to `{{CORE_REPO}}` once Step 4's row exists.

- [ ] **Step 3: Add the six deny rules to the live settings**

Run:

```bash
bun -e 'const fs=require("fs");const p=require("path").join(require("os").homedir(),".claude","settings.json");const s=JSON.parse(fs.readFileSync(p,"utf8"));s.permissions??={};const deny=new Set(Array.isArray(s.permissions.deny)?s.permissions.deny:[]);for(const r of ["Bash(gh pr create *)","Bash(gh issue create *)","Bash(gh pr merge *)","PowerShell(gh pr create *)","PowerShell(gh issue create *)","PowerShell(gh pr merge *)"])deny.add(r);s.permissions.deny=[...deny];fs.writeFileSync(p,JSON.stringify(s,null,2)+String.fromCharCode(10));console.log(s.permissions.deny.length);'
```

Expected: a count of 6 or more, with every key the file held before still present.

- [ ] **Step 4: Add the templated-file row and its fixture**

In `install/AccountShared.ps1`, replace

```powershell
    'skills/subagent-prompting/SKILL.md' = @('OBSIDIAN_VAULT', 'HOME_SLUG')
}
```

with

```powershell
    'skills/subagent-prompting/SKILL.md' = @('OBSIDIAN_VAULT', 'HOME_SLUG')
    'skills/publish/SKILL.md'            = @('CORE_REPO')
}
```

In `install/Export-Account.Tests.ps1`, inside `New-StandInHome`:

- change `'skills/not-ai', 'skills/cloned-skill/.git/refs/heads',` to `'skills/not-ai', 'skills/publish', 'skills/cloned-skill/.git/refs/heads',`
- change `# All seven rows of $AccountTemplatedFiles, each carrying a foldable literal. The fold` to `# All eight rows of $AccountTemplatedFiles, each carrying a foldable literal. The fold`
- after the two lines ending `Set-Content (Join-Path $claude 'skills/not-ai/SKILL.md')`, insert:

```powershell
            'bun --cwd x E:/projects/agent-harness-core/tools/publish/cli.ts help' |
                Set-Content (Join-Path $claude 'skills/publish/SKILL.md')
```

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Failed: 0`. Measured with exactly these edits on 2026-10-06: `Tests Passed: 116, Failed: 0`.

- [ ] **Step 5: Export and review the diff**

Run: `pwsh -NoProfile -File install/Export-Account.ps1`
Then: `git diff --stat account/claude` and `git status --short account/claude`
Expected: `account/claude/skills/publish/SKILL.md` is new and contains `{{CORE_REPO}}/tools/publish/cli.ts` and no drive-letter path. `account/claude/settings.account.json` gains the six deny entries. Any other content change in the diff is unrelated drift in the live layer: stop and ask the operator rather than committing it. A line-ending-only flip elsewhere is undone with `git checkout -- account/claude` on those paths (see `rules/harness-core.md`).

- [ ] **Step 6: Pin the distribution**

<!-- file: test/publish-permission-rule.test.ts -->
````ts
// Pins #274's distribution: the account layer (account/claude/, generated by
// install/Export-Account.ps1 from the live ~/.claude and merged on every machine by
// install/Install-Account.ps1) must carry the permission rules that deny raw gh publishing and
// the skill that points every publish at tools/publish. Deleting one rule or the skill fails here.
// What the rules do inside Claude Code is a live property this file cannot see. Task 12 of
// docs/superpowers/plans/2026-10-06-publish-tool.md probes it in a session.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RULES = [
  "Bash(gh pr create *)",
  "Bash(gh issue create *)",
  "Bash(gh pr merge *)",
  "PowerShell(gh pr create *)",
  "PowerShell(gh issue create *)",
  "PowerShell(gh pr merge *)",
];

describe("publish distribution in the account layer", () => {
  test("settings.account.json denies raw gh pr create, gh issue create and gh pr merge in both shells", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, "account", "claude", "settings.account.json"), "utf8")) as {
      permissions?: { deny?: unknown };
    };
    const deny = settings.permissions?.deny;
    expect(Array.isArray(deny)).toBe(true);
    for (const rule of RULES) expect(deny as string[]).toContain(rule);
  });

  test("the publish skill ships with the tool path folded to the core-repo token", () => {
    const skill = readFileSync(join(ROOT, "account", "claude", "skills", "publish", "SKILL.md"), "utf8");
    expect(skill).toStartWith("---");
    expect(skill).toContain("name: publish");
    expect(skill).toContain("{{CORE_REPO}}/tools/publish/cli.ts");
    expect(skill).not.toMatch(/[A-Za-z]:[\\/][^\n]*tools[\\/]publish/);
  });
});
````

Expected sha256 of the extracted file: `2d98a84ad72a68de1c8fb658261924a8b223e8e834bd270b8abc529594dd9cb8`

Run: `bun test test/publish-permission-rule.test.ts`
Expected: `2 pass`, `0 fail`.

Ablate: delete `"PowerShell(gh pr merge *)",` from `account/claude/settings.account.json`'s deny list, re-run, expect the first test to fail, then `git checkout -- account/claude/settings.account.json` and re-run to `2 pass`.

- [ ] **Step 7: Run every suite**

Run: `bun test`
Expected: ends with `0 fail`.

- [ ] **Step 8: Commit**

```bash
git add install/AccountShared.ps1 install/Export-Account.Tests.ps1 test/publish-permission-rule.test.ts account/claude/skills/publish/SKILL.md account/claude/settings.account.json
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(account): publish skill and deny rules for raw gh publishing (#274)

The installer copies no skill and merges no permission rule into a
project, and /.claude/ is gitignored here, so the account layer is the
only channel for either: the exporter mirrors ~/.claude/skills, and
Install-Account unions permissions.deny on every machine. The skill
names the tool by path, so it gets an AccountTemplatedFiles row folding
that path to CORE_REPO, landing with the export because the exporter
throws for a row whose file is absent. The deny rules are a policy line,
not a boundary: gh -R x pr create and gh api are not matched."
```

### Task 12: Operator setup and live acceptance

**Security-bearing:** yes. It creates the file that holds the key command and App ID, and confirms the gates live.

**Executor:** the operator, with the coordinator running the probes. Nothing here is committed.

- [ ] **Step 1: Create the work directory and config**

Create an empty `~/.claude-publish/work`. Clone the repository to `~/.claude-publish/tool`, the dedicated clean clone review-merge runs from and the reviewer checkout. Write the key wrapper `~/.claude-publish/read-reviewer-key.ps1` in the form `tools/publish/README.md` shows, reading the service-account token from the DPAPI-protected file the hand-written helper already uses, so the token never enters the config. Then write `~/.claude-publish/config.json` in the shape the README shows: an `owners` entry for `Cringely` naming the public identity, and a `reviewers` entry for `Cringely/agent-harness-core` holding the App ID, the wrapper as `keyCommand` (`pwsh -NoProfile -File <wrapper>`) with `OP_BIOMETRIC_UNLOCK_ENABLED` set to `false` in `keyCommandEnv`, and `~/.claude-publish/tool` as the checkout. Never paste the config's or the wrapper's values into a chat, an issue or a commit.

- [ ] **Step 2: Probe three refusals live, none of which publishes**

Write a body file in a scratch directory holding `Closes #1` and nothing else, then run `issue create --repo Cringely/agent-harness-core --title probe --body-file <that file>` through the documented invocation.
Expected: `refused: refusing to publish: closing keywords do not match --closes (undeclared: 1, missing: 0)`, exit 2.

Rewrite it to a clean line plus a `Co-Authored-By:` trailer line, run `pr create --repo Cringely/agent-harness-core --base master --head feat/274-publish-tool --title probe --body-file <that file>`.
Expected: `refused: refusing to publish (body: Co-Authored-By line). Nothing was published`, exit 2.

Run any command without `--cwd`, from inside a checkout.
Expected: the working-directory refusal, exit 2.

- [ ] **Step 3: Probe the deny rules in a fresh Claude Code session**

Ask the session to run `gh pr create --help`, then `GH_TOKEN=x gh pr merge --help`, in the Bash tool, then `gh issue create --help` in the PowerShell tool.
Expected: each is denied by a permission rule. The second is the live check of the documented claim that a deny rule matches past a leading environment assignment. Until it is seen denied, that claim stays reference-tier.

- [ ] **Step 4: First real use**

Open this branch's pull request with `pr create ... --closes 274` and a body in the skill's shape. review-merge cannot merge it: the tool refuses to run from a checkout that is not at the default branch head, and `tools/publish/` reaches the default branch only with this merge. So this pull request is reviewed and merged by the existing hand-run flow in CONTRIBUTING.md, with the bypass the owned paths need (`.github/`, `test/`, `install/`, `account/claude/settings.account.json`).

The first review-merge runs on the next pull request after this one merges, from `~/.claude-publish/tool` brought to the new default branch head, in the background form the skill gives. That run completes issue #274's "Done when".
