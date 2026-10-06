# PR Reviewer in GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the #120 reviewer (`tools/pr-review/`) in GitHub Actions after each same-repository pull request's `test` workflow completes, with the model and the App key in separate jobs and environments (#146, first slice).

**Architecture:** A new `workflow_run` workflow, `.github/workflows/pr-review.yml`, runs `master`'s copy of the tool in two jobs. `review` (environment `pr-review-model`) snapshots the pull request with a read-only `GITHUB_TOKEN`, runs the tool-less model, scans the result for identifying strings, and uploads a model-run artifact. `post` (environment `pr-review`) holds the App key, validates and binds the artifact, takes its own snapshot, and runs the existing `runReview` with an `ArtifactRunner` replaying the model's result. A new entry point `tools/pr-review/ci.ts` serves both jobs. `cli.ts` and the local path are unchanged.

**Tech Stack:** Bun 1.3.14 and TypeScript (no `package.json`, `node:*` imports only), `Bun.YAML` for the workflow test, GitHub Actions on `ubuntu-24.04`, the `claude` CLI 2.1.291 from the npm platform package `@anthropic-ai/claude-code-linux-x64`.

**Spec:** `docs/superpowers/specs/2026-10-05-pr-review-ci-design.md`. Read it before any task. Background: `tools/pr-review/README.md` and `docs/superpowers/plans/2026-09-11-pr-review-app.md` sections D1 to D8.

## Global Constraints

- Branch `feat/146-ci-reviewer`. One pull request for the whole plan (memory note `one-pr-per-issue-app-gate`).
- Commit as the public identity on every commit: `git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit ...`. No `Co-Authored-By`, `Claude-Session` or "Generated with Claude Code" line: `core/claude/hooks/commit-msg` refuses them. Never pass `--no-verify`.
- Push with: `TOK=$(gh auth token -u Cringely) && export TOK && git -c credential.helper= -c 'credential.helper=!f() { echo username=Cringely; echo "password=$TOK"; }; f' push origin HEAD:feat/146-ci-reviewer; unset TOK`. Never `gh auth switch`.
- Tool code imports only `node:*` modules and `./` siblings. Tests import only `bun:test`, `node:*` and `../tools/pr-review/*`. `bun test` does not type-check, so every property this plan relies on has a runtime test.
- Tests are flat files `test/pr-review-<unit>.test.ts`. Fixtures are built at runtime under `mkdtempSync(join(tmpdir(), "pr-review-..."))` and removed afterwards.
- Synthetic identities only: `Fixture Person`, `fixtureuser`, `fixture@example.test`, `account@example.test`, `state@example.test`. Never write the operator's name, an email address of theirs, their workstation username or hostname into any file, test, commit or report.
- CI runs `bun test` on `ubuntu-24.04` offline, without `claude` or any secret. Every test passes there.
- No seam reachable from the command line or an environment variable may disable a control (plan D8 of 2026-09-11). New seams are function parameters a test passes, as `cli.ts`'s `CliIo` is.
- Docs and comments use periods and commas where a semicolon or an em dash would go. The commit hook lints `.md` files. Fix what it flags.
- Exact values used across tasks:
  - Reviewer model `claude-opus-5-5` (`REVIEWER_MODEL` in `runner.ts`), tools `["StructuredOutput"]` (`EXPECTED_TOOLS`).
  - CLI pin: version `2.1.291`, platform package SHA-512 hex `8b4609c5d87cc886d143dc7582c6c1db8a155a1b3b04044d4481e84635f0d02783e18a792685694256df3c803d460dd4864707e9ddd2b58005ad2b779769b91c`.
  - Action pins: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`, `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1`, `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1`.
  - Environments: `pr-review-model` (model token), `pr-review` (App key). Secret names `CLAUDE_CODE_OAUTH_TOKEN`, `PR_REVIEW_APP_KEY`, `PR_REVIEW_IDENTITY`, `PR_REVIEW_ACCOUNT_EMAIL`. Variable `PR_REVIEW_APP_ID`.
  - Artifact name `pr-review-model-run`, file `model-run.json`.
- Every live step (Tasks 1, 8, 9) stops and reports, without retrying or improvising, on any result other than the one the step names.

## Security-bearing tasks

Tasks 1, 2, 3, 4, 5, 6, 8 and 9 are security-bearing: each one builds or measures a control the spec's threat model rests on, and each gets a task review before the next starts. Task 7 is documentation only.

## Review Focus

Inputs and conditions the spec implies that a person will meet first. Each has a pinning test in the task given beside it.

1. The pull request's title, description or a linked issue's comments are edited while the review runs. Expected: the post still goes through, because the binding is repository, pull request, head, base and tool revision only. Pinned in Task 3 (`pinnedSource` passes a snapshot whose title and body differ).
2. `master` moves between the two jobs and GitHub reports a new base SHA. Expected: the post job refuses and posts nothing, and a re-run reviews again. Pinned in Tasks 3 and 5.
3. The model copies the account email into its output. Expected: the artifact never carries it, and the pull request gets `COMMENT`. Pinned in Task 4 (withheld artifact) and Task 5 (failed artifact posts `COMMENT`).
4. Someone re-runs an old workflow run after a newer push. Expected: the review job refuses before the model runs because the head moved. Pinned in Task 4 and Task 5.
5. A diff over the 600 KB cap. Expected: no model run in either job, and the post reports the size cap rather than a model failure. Pinned in Task 3 (over-cap composition test) and Task 4.

---

### Task 1: Live spike, setup token and environment gate

Operator-assisted. Security-bearing. Writes no repository file. Runs before any code task, because Tasks 2 to 9 assume its results.

**Measures:**
- P1: the local `claude` version equals the CI pin.
- P2: the real `ClaudeCliRunner`, authenticated only by `CLAUDE_CODE_OAUTH_TOKEN` from an empty home, passes every stream check (model `claude-opus-5-5` resolves at effort `xhigh`, no memory path, plugins handled, neutral cwd).
- P3: whether that session carries a `# userEmail` block, and whether it names the address the operator intends for `PR_REVIEW_ACCOUNT_EMAIL`.
- P4: whether the CLI writes an account email into the empty home's `.claude.json`.
- P5: whether a `pull_request` job that names environment `pr-review` is refused before its steps run.

Who runs it: the operator, or an agent the operator hands two 1Password references to (the setup token, and the address intended for `PR_REVIEW_ACCOUNT_EMAIL`). Neither value is ever printed. The probe prints booleans and code-authored reasons only.

- [ ] **Step 1: Check the CLI version**

Run (PowerShell): `claude --version`
Expected: `2.1.291 (Claude Code)`. Anything else: stop. The operator either installs 2.1.291 or picks a new pin, and the new version and its SHA-512 replace the values in Global Constraints before Task 6.

- [ ] **Step 2: Write the probe outside every checkout**

Create `$env:TEMP\pr-review-146-probe\probe.ts` with exactly this content, and the empty directories `$env:TEMP\pr-review-146-probe\home` and `$env:TEMP\pr-review-146-probe\cwd`:

```ts
// #146 Task 1 probe. Prints booleans and code-authored reasons only, never an address or a token.
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

const repoDir = process.env.PROBE_REPO_DIR;
const expected = (process.env.PROBE_EXPECTED_EMAIL ?? "").trim().toLowerCase();
const home = process.env.PROBE_HOME;
if (!repoDir || !expected || !home) throw new Error("set PROBE_REPO_DIR, PROBE_EXPECTED_EMAIL and PROBE_HOME");
const { ClaudeCliRunner, REVIEWER_MODEL } = await import(join(repoDir, "tools", "pr-review", "runner.ts"));

// P2: the real runner, with every stream check it applies to a review.
const run = await new ClaudeCliRunner().run({
  systemPrompt: "You are a configuration probe. Return the JSON object the schema asks for.",
  userPrompt: 'There is no pull request. Return summary "probe", an empty findings array and an empty observed_instructions array.',
});

// P3: does the session carry a # userEmail block, and does it name the expected address?
const schema = {
  type: "object",
  properties: { userEmailBlockPresent: { type: "boolean" }, userEmail: { type: "string" } },
  required: ["userEmailBlockPresent", "userEmail"],
  additionalProperties: false,
};
const claude = Bun.which("claude");
if (!claude) throw new Error("claude is not on PATH");
const proc = Bun.spawn(
  [claude, "-p", "--model", REVIEWER_MODEL, "--tools", "", "--strict-mcp-config", "--safe-mode", "--setting-sources", "",
    "--disable-slash-commands", "--no-session-persistence", "--json-schema", JSON.stringify(schema), "--output-format", "json"],
  { cwd: parse(tmpdir()).root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
);
proc.stdin.write(
  "Configuration probe. Does the context you were given, outside this message, contain a section headed '# userEmail'? " +
    "Set userEmailBlockPresent to true or false. Set userEmail to the address that section names, or to the empty string when there is none.",
);
await proc.stdin.end();
const stdout = await new Response(proc.stdout).text();
const emailProbeExit = await proc.exited;
let blockPresent: boolean | null = null;
let addressPresent: boolean | null = null;
let addressMatches: boolean | null = null;
try {
  const so = JSON.parse(stdout).structured_output;
  blockPresent = so.userEmailBlockPresent === true;
  const address = String(so.userEmail ?? "").trim().toLowerCase();
  addressPresent = address !== "";
  addressMatches = address === expected;
} catch {
  // Left as null, which the report shows.
}

// P4: what the CLI wrote to the isolated home's account state.
const statePath = join(home, ".claude.json");
let stateEmailPresent = false;
let stateEmailMatches = false;
if (existsSync(statePath)) {
  try {
    const email = JSON.parse(readFileSync(statePath, "utf8"))?.oauthAccount?.emailAddress;
    stateEmailPresent = typeof email === "string" && email.trim() !== "";
    stateEmailMatches = stateEmailPresent && email.trim().toLowerCase() === expected;
  } catch {
    stateEmailPresent = false;
  }
}

console.log(JSON.stringify({
  runnerOk: run.ok,
  runnerReason: run.ok ? null : run.reason,
  emailProbeExit,
  blockPresent,
  addressPresent,
  addressMatches,
  stateFilePresent: existsSync(statePath),
  stateEmailPresent,
  stateEmailMatches,
}, null, 2));
```

- [ ] **Step 3: Run the probe with only the setup token as a credential**

Run in PowerShell (the PowerShell tool, not Bash: `op` reaches the desktop app only from there). Replace the two `<reference>` values with the operator's 1Password references and `<worktree>` with this checkout's absolute path:

```powershell
if ($env:CLAUDE_CONFIG_DIR) { throw 'unset CLAUDE_CONFIG_DIR first' }
$probe = Join-Path $env:TEMP 'pr-review-146-probe'
$savedProfile = $env:USERPROFILE; $savedHome = $env:HOME
$env:PROBE_REPO_DIR = '<worktree>'
$env:PROBE_HOME = "$probe\home"
$env:PROBE_EXPECTED_EMAIL = op read '<reference to the address intended for PR_REVIEW_ACCOUNT_EMAIL>'
$env:CLAUDE_CODE_OAUTH_TOKEN = op read '<reference to the setup token>'
$env:USERPROFILE = "$probe\home"; $env:HOME = "$probe\home"
Push-Location "$probe\cwd"
try { bun "$probe\probe.ts" } finally {
  Pop-Location
  $env:USERPROFILE = $savedProfile; $env:HOME = $savedHome
  Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN, Env:PROBE_EXPECTED_EMAIL, Env:PROBE_HOME, Env:PROBE_REPO_DIR -ErrorAction SilentlyContinue
}
```

Expected: one JSON object. Record it verbatim in the task report. It carries no address and no token by construction.

- [ ] **Step 4: Judge P1 to P4**

| Result | Verdict | What changes in later tasks |
|---|---|---|
| `runnerOk` false | FAIL, stop | Every CI review would post `COMMENT`. Report `runnerReason`. No later task starts until the operator decides |
| `runnerOk` true, `blockPresent` false, `addressPresent` false, `stateEmailPresent` false | PASS (a) | Nothing. `PR_REVIEW_ACCOUNT_EMAIL` stays required (spec, blocker 1) and holds the address intended for it |
| `runnerOk` true, `blockPresent` true, `addressMatches` true | PASS (b) | Nothing. The operator sets `PR_REVIEW_ACCOUNT_EMAIL` to that same address |
| `blockPresent` true, `addressMatches` false | FAIL, stop | The injected address is not the one intended. The operator re-runs Step 3 with another candidate until `addressMatches` is true. Never print the injected value |
| `blockPresent` false, `addressPresent` true | Inconsistent | Re-run Step 3 once. Repeated: treat as the row above |
| `stateEmailPresent` true, `stateEmailMatches` false | FAIL, stop | `loadCiIdentity` adds the state address automatically, but the operator must know which account the token belongs to. Re-check the token's account |
| `emailProbeExit` not 0, or the three P3 fields null | Inconclusive | Re-run once. Repeated: report and stop |

- [ ] **Step 5: P5, the environment gate refuses a `pull_request` job**

Create a throwaway branch and draft pull request. The operator's own push credentials create the branch (ruleset "Contain non-default branches" restricts branch creation to administrators). Run in Git Bash from this checkout:

```bash
git fetch origin master
git switch -c spike/146-env-gate origin/master
mkdir -p .github/workflows
cat > .github/workflows/spike-env-gate.yml <<'EOF'
name: spike-env-gate
on: pull_request
permissions: {}
jobs:
  probe:
    runs-on: ubuntu-24.04
    environment: pr-review
    steps:
      - name: Report whether the secret reached this job, never its value
        env:
          K: ${{ secrets.PR_REVIEW_APP_KEY }}
        run: if [ -n "$K" ]; then echo "SECRET REACHABLE"; else echo "secret not set"; fi
EOF
git add .github/workflows/spike-env-gate.yml
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "spike(146): probe whether a pull_request job reaches environment pr-review"
TOK=$(gh auth token -u Cringely) && export TOK && git -c credential.helper= -c 'credential.helper=!f() { echo username=Cringely; echo "password=$TOK"; }; f' push -u origin HEAD:spike/146-env-gate; unset TOK
GH_TOKEN=$(gh auth token -u Cringely) gh pr create -R Cringely/agent-harness-core --draft --base master --head spike/146-env-gate --title "spike(146): environment gate probe, do not merge" --body "Throwaway probe for #146 Task 1, P5. Closed without merging."
```

Wait for the `spike-env-gate` run, then read it:

```bash
GH_TOKEN=$(gh auth token -u Cringely) gh run list -R Cringely/agent-harness-core --workflow spike-env-gate.yml --limit 1 --json databaseId,conclusion
GH_TOKEN=$(gh auth token -u Cringely) gh run view <databaseId> -R Cringely/agent-harness-core --json jobs --jq '.jobs[] | {name, conclusion, steps: [.steps[]? | {name, conclusion}]}'
```

PASS: the run's conclusion is `failure`, the probe step never ran (absent or `skipped`), and the run page names the environment's deployment protection rule. FAIL: the step ran, whatever it printed. A FAIL stops the plan: the spec's first control does not hold, and the operator decides before anything else.

- [ ] **Step 6: Clean up**

```bash
GH_TOKEN=$(gh auth token -u Cringely) gh pr close spike/146-env-gate -R Cringely/agent-harness-core --delete-branch
git switch feat/146-ci-reviewer
git branch -D spike/146-env-gate
```

Delete `$env:TEMP\pr-review-146-probe` (PowerShell: `Remove-Item -Recurse -Force (Join-Path $env:TEMP 'pr-review-146-probe')`). Nothing from this task is committed to `feat/146-ci-reviewer`.

- [ ] **Step 7: Report**

Put in the task report the P1 version line, the Step 3 JSON verbatim, the Step 4 verdict row, the P5 verdict with the run id. Stop here unless every verdict is PASS.

---

### Task 2: CI identity loader

Security-bearing.

**Files:**
- Modify: `tools/pr-review/identity.ts` (add `CI_IDENTITY_ENV`, `CI_ACCOUNT_EMAIL_ENV`, `loadCiIdentity` after `loadIdentity`, which ends at line 129)
- Test: `test/pr-review-identity.test.ts` (extend the import on line 10, append one `describe` block)

**Interfaces:**
- Consumes: the module-private helpers already in `identity.ts`: `REAL_FS`, `stringList`, `hasExtraKey`, `hasDuplicateKey`, `accountStateDir`, `readAccountEmail`, and the exported `IdentityLoad`, `IdentityFsOps`.
- Produces: `export const CI_IDENTITY_ENV = "PR_REVIEW_IDENTITY"`, `export const CI_ACCOUNT_EMAIL_ENV = "PR_REVIEW_ACCOUNT_EMAIL"`, `export function loadCiIdentity(env: Record<string, string | undefined>, options?: { home?: string; fs?: Partial<IdentityFsOps> }): IdentityLoad`. On success it returns `{ ok: true, declared: true, accountEmail: true, decl: { names, emails: [...declaredEmails, accountEmail, ...cliStateEmail], username: "", hostname: "" } }`.

- [ ] **Step 1: Write the failing tests**

In `test/pr-review-identity.test.ts`, change the import on line 10 to:

```ts
import { accountStateDir, findIdentityHits, loadCiIdentity, loadIdentity, type IdentityDecl } from "../tools/pr-review/identity";
```

Append at the end of the file:

```ts
// #146: the CI entry point's identity source. Two environment-secret values replace the identity
// file, and the runner's own username and hostname are not scanned. Every value here is synthetic.
describe("loadCiIdentity() (#146)", () => {
  const DECLARED = JSON.stringify({ names: ["Fixture Person", "fixtureuser"], emails: ["fixture@example.test"] });
  const ciEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    PR_REVIEW_IDENTITY: DECLARED,
    PR_REVIEW_ACCOUNT_EMAIL: "account@example.test",
    ...overrides,
  });

  test("valid secrets: declared names and emails, then the account email, and no username or hostname", () => {
    expect(loadCiIdentity(ciEnv(), { home: home() })).toEqual({
      ok: true,
      declared: true,
      accountEmail: true,
      decl: {
        names: ["Fixture Person", "fixtureuser"],
        emails: ["fixture@example.test", "account@example.test"],
        username: "",
        hostname: "",
      },
    });
  });

  test("an address in the claude CLI's account state is added after the account email", () => {
    const state = JSON.stringify({ oauthAccount: { emailAddress: "state@example.test" } });
    const result = loadCiIdentity(ciEnv(), { home: home(undefined, state) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decl.emails).toEqual(["fixture@example.test", "account@example.test", "state@example.test"]);
  });

  test.each([
    ["absent", { PR_REVIEW_IDENTITY: undefined }],
    ["blank", { PR_REVIEW_IDENTITY: "   " }],
    ["not JSON", { PR_REVIEW_IDENTITY: "{names:" }],
    ["a JSON array", { PR_REVIEW_IDENTITY: "[]" }],
    ["carrying an extra key", { PR_REVIEW_IDENTITY: JSON.stringify({ names: ["A"], emails: ["a@example.test"], other: [] }) }],
    ["repeating a key", { PR_REVIEW_IDENTITY: '{"names":["A"],"names":["B"],"emails":["a@example.test"]}' }],
    ["declaring no names", { PR_REVIEW_IDENTITY: JSON.stringify({ names: [], emails: ["a@example.test"] }) }],
    ["declaring no emails", { PR_REVIEW_IDENTITY: JSON.stringify({ names: ["A"], emails: [] }) }],
    ["holding a non-string name", { PR_REVIEW_IDENTITY: JSON.stringify({ names: [1], emails: ["a@example.test"] }) }],
    ["paired with no account email", { PR_REVIEW_ACCOUNT_EMAIL: undefined }],
    ["paired with an account email that is not an address", { PR_REVIEW_ACCOUNT_EMAIL: "not-an-address" }],
  ])("refuses when the declaration is %s", (_label, overrides) => {
    expect(loadCiIdentity(ciEnv(overrides as Record<string, string | undefined>), { home: home() }).ok).toBe(false);
  });

  test("a refusal never quotes the value it refused", () => {
    const result = loadCiIdentity(ciEnv({ PR_REVIEW_ACCOUNT_EMAIL: "leaky-value-7f3a" }), { home: home() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("leaky-value-7f3a");
  });

  test("account state that is not JSON refuses, the same as loadIdentity", () => {
    expect(loadCiIdentity(ciEnv(), { home: home(undefined, "{") }).ok).toBe(false);
  });

  test("the CI declaration does not hit runner.ts, and still hits every declared term", () => {
    const result = loadCiIdentity(ciEnv(), { home: home() });
    if (!result.ok) throw new Error("expected the fixture declaration to load");
    expect(findIdentityHits("see tools/pr-review/runner.ts: the runner kills the session", result.decl)).toEqual([]);
    expect(findIdentityHits("written by Fixture Person", result.decl)).toEqual(["declared name #1"]);
    expect(findIdentityHits("path /home/fixtureuser/x", result.decl)).toEqual(["declared name #2"]);
    expect(findIdentityHits("mail account@example.test", result.decl)).toEqual(["email #2"]);
  });

  test("why the runner's username is left out: a declaration whose username is 'runner' hits runner.ts", () => {
    const withRunner: IdentityDecl = { names: [], emails: [], username: "runner", hostname: "fixture-host" };
    expect(findIdentityHits("see tools/pr-review/runner.ts", withRunner)).toEqual(["workstation username"]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test test/pr-review-identity.test.ts`
Expected: FAIL. The new `describe` block fails with `loadCiIdentity is not a function` (or a SyntaxError on the missing export). The last test, which needs no new code, passes.

- [ ] **Step 3: Implement `loadCiIdentity`**

In `tools/pr-review/identity.ts`, insert directly after the closing brace of `loadIdentity` (line 129):

```ts
// #146: the identity source for the GitHub Actions entry point (ci.ts), and only for it. cli.ts
// never calls this. A GitHub-hosted runner has no ~/.claude-account-identity.json, and its own
// username ("runner") and hostname identify no one, while "runner" also matches this tool's own
// runner.ts in nearly every review body. So the declaration comes from two environment secrets,
// and the runner's username and hostname are not scanned. The operator's workstation username and
// hostname belong in the declared names instead. Both values are required, and anything absent,
// blank or malformed refuses, so this source only ever adds terms to the scan and never removes
// one. Refusal reasons name the variable, never its value. The claude CLI's own account state is
// still read and its address, if any, is added, because that is the address the CLI hands the model.
export const CI_IDENTITY_ENV = "PR_REVIEW_IDENTITY";
export const CI_ACCOUNT_EMAIL_ENV = "PR_REVIEW_ACCOUNT_EMAIL";
const CI_EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function loadCiIdentity(
  env: Record<string, string | undefined>,
  options: { home?: string; fs?: Partial<IdentityFsOps> } = {},
): IdentityLoad {
  const fs: IdentityFsOps = { ...REAL_FS, ...options.fs };
  const raw = env[CI_IDENTITY_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, reason: `${CI_IDENTITY_ENV} is not set, so the CI identity scan has nothing declared to scan for` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${CI_IDENTITY_ENV} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${CI_IDENTITY_ENV} is not a JSON object` };
  }
  const record = parsed as Record<string, unknown>;
  if (hasExtraKey(record)) return { ok: false, reason: `${CI_IDENTITY_ENV} has a key other than names and emails` };
  if (hasDuplicateKey(raw)) return { ok: false, reason: `${CI_IDENTITY_ENV} repeats the names or emails key` };
  const names = stringList(record.names);
  const emails = stringList(record.emails);
  if (names === null || emails === null) {
    return { ok: false, reason: `${CI_IDENTITY_ENV}'s names and emails must be arrays of non-empty strings` };
  }
  if (names.length === 0 || emails.length === 0) {
    return { ok: false, reason: `${CI_IDENTITY_ENV} must declare at least one name and at least one email` };
  }
  const accountEmail = (env[CI_ACCOUNT_EMAIL_ENV] ?? "").trim();
  if (!CI_EMAIL_SHAPE_RE.test(accountEmail)) {
    return { ok: false, reason: `${CI_ACCOUNT_EMAIL_ENV} is not set to an email address` };
  }
  const dir = accountStateDir(options.home, env);
  if (!dir.ok) return dir;
  const state = readAccountEmail(dir.dir, fs);
  if (!state.ok) return state;
  const stateEmails = state.email === null ? [] : [state.email];
  return {
    ok: true,
    declared: true,
    accountEmail: true,
    decl: { names, emails: [...emails, accountEmail, ...stateEmails], username: "", hostname: "" },
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test test/pr-review-identity.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Ablate the guard**

Temporarily change `if (names.length === 0 || emails.length === 0)` to `if (names.length === 0 && emails.length === 0)`. Run `bun test test/pr-review-identity.test.ts`. Expected: FAIL on "refuses when the declaration is declaring no names" and "declaring no emails". Restore the line and re-run: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: 0 fail.

- [ ] **Step 7: Commit**

```bash
git add tools/pr-review/identity.ts test/pr-review-identity.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(pr-review): CI identity loader from environment secrets (#146)" -m "GitHub-hosted runners have no identity file, and the runner's username 'runner' matches runner.ts in most review bodies. loadCiIdentity reads PR_REVIEW_IDENTITY and PR_REVIEW_ACCOUNT_EMAIL, refuses when either is missing or malformed, and leaves the runner's username and hostname out of the scan. Only the CI entry point will call it. Rejected: scanning the runner's own values, which refuses most posts for a string that identifies no one."
```

---

### Task 3: Model-run artifact contract, `ArtifactRunner` and `pinnedSource`

Security-bearing.

**Files:**
- Create: `tools/pr-review/ci-artifact.ts`
- Test: `test/pr-review-ci-artifact.test.ts`

**Interfaces:**
- Consumes: `REVIEWER_MODEL`, `EXPECTED_TOOLS` (`runner.ts`). `RefusalError`, `SHA_RE`, `parseRepo`, `PrSource`, `PromptPair`, `ReviewerRunner`, `RunnerResult` (`types.ts`). `runReview`, `ReviewDeps` (`pipeline.ts`, tests only).
- Produces:
  - `export const MODEL_RUN_ARTIFACT_VERSION = 1 as const`
  - `export const MAX_ARTIFACT_REASON_CHARS = 500`
  - `export type ArtifactResult = { ok: true; output: unknown; model: string; tools: string[] } | { ok: false; reason: string }`
  - `export interface ModelRunArtifact { version: 1; repo: string; pr: number; headSha: string; baseSha: string; toolRevision: string; result: ArtifactResult }`
  - `export function validateModelRunArtifact(raw: unknown): { ok: true; value: ModelRunArtifact } | { ok: false; reason: string }`
  - `export function checkArtifactBinding(artifact: ModelRunArtifact, expected: { repo: string; pr: number; headSha: string; toolRevision: string }): string | null`
  - `export function collectStrings(value: unknown): string[]`
  - `export class ArtifactRunner implements ReviewerRunner` with `constructor(result: ArtifactResult)`
  - `export function pinnedSource(inner: PrSource, pin: { headSha: string; baseSha: string }): PrSource`

- [ ] **Step 1: Write the failing tests**

Create `test/pr-review-ci-artifact.test.ts`:

```ts
// Tests for tools/pr-review/ci-artifact.ts (#146): the model-run artifact that crosses from the CI
// review job to the post job, and the two adapters that let the post job reuse runReview unchanged.

import { describe, expect, test } from "bun:test";
import {
  ArtifactRunner,
  MAX_ARTIFACT_REASON_CHARS,
  checkArtifactBinding,
  collectStrings,
  pinnedSource,
  validateModelRunArtifact,
  type ArtifactResult,
  type ModelRunArtifact,
} from "../tools/pr-review/ci-artifact";
import type { IdentityDecl } from "../tools/pr-review/identity";
import { syntheticCheckRuns } from "../tools/pr-review/local-source";
import { runReview, type ReviewDeps } from "../tools/pr-review/pipeline";
import {
  MAX_DIFF_BYTES,
  RefusalError,
  type PrSnapshot,
  type PrSource,
  type PromptPair,
  type ReviewEvent,
  type ReviewPoster,
  type ReviewerRunner,
  type RunnerResult,
} from "../tools/pr-review/types";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const REV = "e".repeat(40);
const CLEAN_OUTPUT = { summary: "s", findings: [], observed_instructions: [] };
const OK_RESULT: ArtifactResult = { ok: true, output: CLEAN_OUTPUT, model: "claude-opus-5-5", tools: ["StructuredOutput"] };

const artifact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  repo: "owner/name",
  pr: 5,
  headSha: HEAD,
  baseSha: BASE,
  toolRevision: REV,
  result: OK_RESULT,
  ...overrides,
});

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  repo: "owner/name",
  number: 5,
  title: "t",
  body: "b",
  baseSha: BASE,
  headSha: HEAD,
  isOpen: true,
  diff: "diff --git a/a.ts b/a.ts",
  changedFiles: ["a.ts"],
  changedFilesComplete: true,
  commitMessages: ["m"],
  headFiles: [],
  omittedFiles: [],
  linkedIssues: [],
  trustedContext: [],
  livingDocs: [],
  workflowText: "jobs:\n",
  checkRuns: syntheticCheckRuns("passed"),
  ...overrides,
});

class FakePoster implements ReviewPoster {
  posts: Array<{ commitId: string; event: ReviewEvent; body: string }> = [];
  async currentHeadSha() {
    return HEAD;
  }
  async postReview(input: { commitId: string; event: ReviewEvent; body: string }) {
    this.posts.push(input);
    return { id: 1, htmlUrl: "https://example.test/review/1" };
  }
}

const IDENTITY: IdentityDecl = { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "", hostname: "" };
const PROMPT: PromptPair = { systemPrompt: "s", userPrompt: "u" };

const deps = (source: PrSource, runner: ReviewerRunner, poster: ReviewPoster): ReviewDeps => ({
  source,
  runner,
  poster,
  identity: IDENTITY,
  accountEmail: true,
  toolRevision: REV,
  toolDirty: false,
});

describe("validateModelRunArtifact()", () => {
  test("accepts a successful run and a failed run", () => {
    expect(validateModelRunArtifact(artifact()).ok).toBe(true);
    expect(validateModelRunArtifact(artifact({ result: { ok: false, reason: "the reviewer run failed" } })).ok).toBe(true);
  });

  test("returns the artifact's fields unchanged", () => {
    const result = validateModelRunArtifact(artifact());
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toEqual(artifact() as unknown as ModelRunArtifact);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["an extra top-level key", artifact({ diagnostic: "stderr" })],
    ["a missing top-level key", (() => { const a = artifact(); delete a.toolRevision; return a; })()],
    ["version 2", artifact({ version: 2 })],
    ["a repo that is not owner/name", artifact({ repo: "owner" })],
    ["pr 0", artifact({ pr: 0 })],
    ["a fractional pr", artifact({ pr: 1.5 })],
    ["a pr given as a string", artifact({ pr: "5" })],
    ["an uppercase head SHA", artifact({ headSha: "C".repeat(40) })],
    ["a short base SHA", artifact({ baseSha: "d".repeat(39) })],
    ["a non-SHA tool revision", artifact({ toolRevision: "master" })],
    ["a result that is not an object", artifact({ result: "ok" })],
    ["a result whose ok is not a boolean", artifact({ result: { ok: "true", output: CLEAN_OUTPUT, model: "claude-opus-5-5", tools: ["StructuredOutput"] } })],
    ["another model", artifact({ result: { ...OK_RESULT, model: "claude-opus-5" } })],
    ["an extra tool", artifact({ result: { ...OK_RESULT, tools: ["StructuredOutput", "Bash"] } })],
    ["no tools", artifact({ result: { ...OK_RESULT, tools: [] } })],
    ["a successful result carrying a diagnostic", artifact({ result: { ...OK_RESULT, diagnostic: "x" } })],
    ["a failed result carrying a diagnostic", artifact({ result: { ok: false, reason: "r", diagnostic: "x" } })],
    ["an empty failure reason", artifact({ result: { ok: false, reason: "  " } })],
    ["an over-long failure reason", artifact({ result: { ok: false, reason: "r".repeat(MAX_ARTIFACT_REASON_CHARS + 1) } })],
  ])("rejects %s", (_label, raw) => {
    expect(validateModelRunArtifact(raw).ok).toBe(false);
  });
});

describe("checkArtifactBinding()", () => {
  const value = artifact() as unknown as ModelRunArtifact;
  const expected = { repo: "owner/name", pr: 5, headSha: HEAD, toolRevision: REV };

  test("null when all four match", () => {
    expect(checkArtifactBinding(value, expected)).toBeNull();
  });

  test.each([
    ["repo", { ...expected, repo: "owner/other" }],
    ["pr", { ...expected, pr: 6 }],
    ["head", { ...expected, headSha: "f".repeat(40) }],
    ["tool revision", { ...expected, toolRevision: "a".repeat(40) }],
  ])("a reason when the %s differs", (_label, other) => {
    expect(typeof checkArtifactBinding(value, other)).toBe("string");
  });
});

describe("collectStrings()", () => {
  test("every string value and every key, at any depth", () => {
    const strings = collectStrings({ a: "one", b: [{ c: "two" }, 3, null, true], "key three": { d: "four" } });
    expect(strings.sort()).toEqual(["a", "b", "c", "d", "four", "key three", "one", "two"].sort());
  });

  test("a bare string, and nothing from numbers, booleans or null", () => {
    expect(collectStrings("x")).toEqual(["x"]);
    expect(collectStrings(5)).toEqual([]);
    expect(collectStrings(null)).toEqual([]);
  });
});

describe("ArtifactRunner", () => {
  test("replays a successful result exactly", async () => {
    expect(await new ArtifactRunner(OK_RESULT).run(PROMPT)).toEqual(OK_RESULT as RunnerResult);
  });

  test("replays a failed result as a failure that names the model job", async () => {
    const result = await new ArtifactRunner({ ok: false, reason: "the reviewer run failed" }).run(PROMPT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("the model job reported");
      expect(result.reason).toContain("the reviewer run failed");
      expect(result.diagnostic).toBeUndefined();
    }
  });
});

describe("pinnedSource()", () => {
  test("passes a matching snapshot through, even when the title and body changed after the review", async () => {
    const edited = snapshot({ title: "edited title", body: "edited body" });
    expect(await pinnedSource({ snapshot: async () => edited }, { headSha: HEAD, baseSha: BASE }).snapshot()).toBe(edited);
  });

  test("refuses when the head moved", async () => {
    const source = pinnedSource({ snapshot: async () => snapshot({ headSha: "f".repeat(40) }) }, { headSha: HEAD, baseSha: BASE });
    await expect(source.snapshot()).rejects.toBeInstanceOf(RefusalError);
  });

  test("refuses when the base moved", async () => {
    const source = pinnedSource({ snapshot: async () => snapshot({ baseSha: "a".repeat(40) }) }, { headSha: HEAD, baseSha: BASE });
    await expect(source.snapshot()).rejects.toBeInstanceOf(RefusalError);
  });
});

describe("runReview() with the CI adapters", () => {
  const pin = { headSha: HEAD, baseSha: BASE };

  test("a clean replayed result and passing CI approve", async () => {
    const poster = new FakePoster();
    const outcome = await runReview(deps(pinnedSource({ snapshot: async () => snapshot() }, pin), new ArtifactRunner(OK_RESULT), poster), { commentOnly: false });
    expect(outcome.status).toBe("posted");
    expect(poster.posts.map((p) => p.event)).toEqual(["APPROVE"]);
    expect(poster.posts[0]!.commitId).toBe(HEAD);
  });

  test("a replayed correctness finding requests changes", async () => {
    const poster = new FakePoster();
    const withFinding: ArtifactResult = {
      ...OK_RESULT,
      output: { summary: "s", findings: [{ severity: "correctness", confidence: "high", path: "a.ts", title: "t", detail: "d" }], observed_instructions: [] },
    };
    await runReview(deps(pinnedSource({ snapshot: async () => snapshot() }, pin), new ArtifactRunner(withFinding), poster), { commentOnly: false });
    expect(poster.posts.map((p) => p.event)).toEqual(["REQUEST_CHANGES"]);
  });

  test("a replayed failure comments and records the model job's reason", async () => {
    const poster = new FakePoster();
    const outcome = await runReview(
      deps(pinnedSource({ snapshot: async () => snapshot() }, pin), new ArtifactRunner({ ok: false, reason: "the reviewer run failed" }), poster),
      { commentOnly: false },
    );
    expect(poster.posts.map((p) => p.event)).toEqual(["COMMENT"]);
    expect(outcome.reviewerFailure).toContain("the model job reported");
  });

  test("a diff over the cap comments on the size cap and never consults the artifact", async () => {
    const poster = new FakePoster();
    let consulted = 0;
    const counting: ReviewerRunner = {
      run: async (prompt) => {
        consulted++;
        return new ArtifactRunner(OK_RESULT).run(prompt);
      },
    };
    const big = snapshot({ diff: "x".repeat(MAX_DIFF_BYTES + 1) });
    const outcome = await runReview(deps(pinnedSource({ snapshot: async () => big }, pin), counting, poster), { commentOnly: false });
    expect(consulted).toBe(0);
    expect(poster.posts.map((p) => p.event)).toEqual(["COMMENT"]);
    expect(outcome.reviewerFailure).toBe("the diff exceeds the review size cap, so no model review ran");
  });

  test("a moved base posts nothing", async () => {
    const poster = new FakePoster();
    const attempt = runReview(
      deps(pinnedSource({ snapshot: async () => snapshot({ baseSha: "a".repeat(40) }) }, pin), new ArtifactRunner(OK_RESULT), poster),
      { commentOnly: false },
    );
    await expect(attempt).rejects.toBeInstanceOf(RefusalError);
    expect(poster.posts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test test/pr-review-ci-artifact.test.ts`
Expected: FAIL with a module resolution error for `../tools/pr-review/ci-artifact`.

- [ ] **Step 3: Implement `tools/pr-review/ci-artifact.ts`**

```ts
// The model-run artifact (#146): the only thing that crosses from the CI review job, which reads the
// pull request and runs the model with no App key, to the post job, which holds the App key and never
// runs the model. Spec: docs/superpowers/specs/2026-10-05-pr-review-ci-design.md, "Data flow".
//
// The post job trusts nothing in it beyond the model's result. It takes its own snapshot, computes
// verification from its own read of CI, and refuses unless the artifact names the repository, pull
// request, head and tool revision it sees itself (checkArtifactBinding) and the same base
// (pinnedSource). Then it runs the existing runReview with an ArtifactRunner standing in for the
// model, so validation, the event, rendering, the identity scan and the pinned post are today's code.

import { EXPECTED_TOOLS, REVIEWER_MODEL } from "./runner";
import { RefusalError, SHA_RE, parseRepo, type PrSource, type PromptPair, type ReviewerRunner, type RunnerResult } from "./types";

export const MODEL_RUN_ARTIFACT_VERSION = 1 as const;
export const MAX_ARTIFACT_REASON_CHARS = 500;

export type ArtifactResult = { ok: true; output: unknown; model: string; tools: string[] } | { ok: false; reason: string };

export interface ModelRunArtifact {
  version: 1;
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  toolRevision: string;
  result: ArtifactResult;
}

const ARTIFACT_KEYS = ["version", "repo", "pr", "headSha", "baseSha", "toolRevision", "result"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

// Every reason is a fixed, code-authored string: nothing from the artifact is echoed into a log.
export function validateModelRunArtifact(raw: unknown): { ok: true; value: ModelRunArtifact } | { ok: false; reason: string } {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ARTIFACT_KEYS)) return { ok: false, reason: "the artifact's keys differ from the model-run schema" };
  if (raw.version !== MODEL_RUN_ARTIFACT_VERSION) return { ok: false, reason: "the artifact's version is not 1" };
  if (typeof raw.repo !== "string" || parseRepo(raw.repo) === null) return { ok: false, reason: "the artifact's repo is not owner/name" };
  if (typeof raw.pr !== "number" || !Number.isSafeInteger(raw.pr) || raw.pr < 1) return { ok: false, reason: "the artifact's pr is not a positive integer" };
  for (const key of ["headSha", "baseSha", "toolRevision"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || !SHA_RE.test(value)) return { ok: false, reason: `the artifact's ${key} is not a 40-character lowercase hex SHA` };
  }
  const result = raw.result;
  if (!isPlainObject(result)) return { ok: false, reason: "the artifact's result is not an object" };
  if (result.ok === true) {
    if (!hasExactKeys(result, ["ok", "output", "model", "tools"])) return { ok: false, reason: "the artifact's result keys differ from a successful run's" };
    if (result.model !== REVIEWER_MODEL) return { ok: false, reason: "the artifact's result names a model other than the pinned one" };
    const tools = result.tools;
    if (!Array.isArray(tools) || tools.length !== EXPECTED_TOOLS.length || !tools.every((tool, i) => tool === EXPECTED_TOOLS[i])) {
      return { ok: false, reason: "the artifact's result names tools other than StructuredOutput" };
    }
  } else if (result.ok === false) {
    if (!hasExactKeys(result, ["ok", "reason"])) return { ok: false, reason: "the artifact's result keys differ from a failed run's" };
    if (typeof result.reason !== "string" || result.reason.trim() === "" || result.reason.length > MAX_ARTIFACT_REASON_CHARS) {
      return { ok: false, reason: "the artifact's failure reason is empty or too long" };
    }
  } else {
    return { ok: false, reason: "the artifact's result.ok is not a boolean" };
  }
  return { ok: true, value: raw as unknown as ModelRunArtifact };
}

export function checkArtifactBinding(
  artifact: ModelRunArtifact,
  expected: { repo: string; pr: number; headSha: string; toolRevision: string },
): string | null {
  if (artifact.repo !== expected.repo) return "the model-run artifact names another repository";
  if (artifact.pr !== expected.pr) return "the model-run artifact names another pull request";
  if (artifact.headSha !== expected.headSha) return "the model-run artifact was produced for another head commit";
  if (artifact.toolRevision !== expected.toolRevision) return "the model-run artifact was produced by another revision of the reviewer";
  return null;
}

// Keys as well as values: a model can put text in either, and the artifact publishes both.
export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isPlainObject(value)) return Object.entries(value).flatMap(([key, inner]) => [key, ...collectStrings(inner)]);
  return [];
}

// Replays the review job's recorded result in place of a live model run. runReview validates a
// replayed output exactly as it validates a live one.
export class ArtifactRunner implements ReviewerRunner {
  constructor(private readonly result: ArtifactResult) {}

  async run(_prompt: PromptPair): Promise<RunnerResult> {
    if (this.result.ok) return { ok: true, output: this.result.output, model: this.result.model, tools: [...this.result.tools] };
    return { ok: false, reason: `the model job reported: ${this.result.reason}` };
  }
}

// The base half of the binding. runReview's own expectHead check covers the head, this covers a base
// that moved between the two jobs, which would change what the diff and the trusted files were.
export function pinnedSource(inner: PrSource, pin: { headSha: string; baseSha: string }): PrSource {
  return {
    snapshot: async () => {
      const snapshot = await inner.snapshot();
      if (snapshot.headSha !== pin.headSha || snapshot.baseSha !== pin.baseSha) {
        throw new RefusalError(
          "refusing to post: the pull request's head or base differs from what the model job reviewed, so nothing was posted; re-run the workflow",
        );
      }
      return snapshot;
    },
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test test/pr-review-ci-artifact.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Ablate the base pin**

Temporarily change `snapshot.baseSha !== pin.baseSha` to `false`. Run the file. Expected: FAIL on "refuses when the base moved" and "a moved base posts nothing". Restore and re-run: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `bun test`
Expected: 0 fail.

- [ ] **Step 7: Commit**

```bash
git add tools/pr-review/ci-artifact.ts test/pr-review-ci-artifact.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(pr-review): model-run artifact contract and replay adapters (#146)" -m "The CI post job must not trust the review job's view of the pull request. It validates a strict artifact, binds it to repository, pull request, head, base and tool revision, and replays only the model's result through runReview. Rejected: a prompt digest as a further binding, because buildPrompt's per-call nonce makes two jobs' prompts differ and a description edit during review would refuse the post for no gain."
```

---

### Task 4: The review job's phase, `runModelJob`

Security-bearing.

**Files:**
- Create: `tools/pr-review/ci-model.ts`
- Test: `test/pr-review-ci-model.test.ts`

**Interfaces:**
- Consumes: from Task 3, `MAX_ARTIFACT_REASON_CHARS`, `MODEL_RUN_ARTIFACT_VERSION`, `collectStrings`, `validateModelRunArtifact`, `ArtifactResult`, `ModelRunArtifact`. From `identity.ts`, `findIdentityHits`, `IdentityDecl`. From `prompt.ts`, `buildPrompt`. From `types.ts`, `MAX_DIFF_BYTES`, `RefusalError`, `PrSource`, `ReviewerRunner`.
- Produces:
  - `export const NO_MODEL_RUN_REASON = "no model run: the diff was unavailable or over the size cap"`
  - `export interface ModelJobDeps { source: PrSource; runner: ReviewerRunner; identity: IdentityDecl; toolRevision: string }`
  - `export interface ModelJobOptions { repo: string; pr: number; expectHead: string }`
  - `export interface ModelJobOutcome { artifact: ModelRunArtifact; diagnostic: string | null; identityHits: string[] }`
  - `export async function runModelJob(deps: ModelJobDeps, options: ModelJobOptions): Promise<ModelJobOutcome>`. Throws `RefusalError` before the runner when the snapshot's head differs from `options.expectHead`.

- [ ] **Step 1: Write the failing tests**

Create `test/pr-review-ci-model.test.ts`:

```ts
// Tests for tools/pr-review/ci-model.ts (#146): the CI review job's half of a review. The artifact it
// returns is uploaded where anyone who can read this public repository can download it, so the
// identity tests below are the point of the file.

import { describe, expect, test } from "bun:test";
import { validateModelRunArtifact } from "../tools/pr-review/ci-artifact";
import { NO_MODEL_RUN_REASON, runModelJob, type ModelJobDeps } from "../tools/pr-review/ci-model";
import type { IdentityDecl } from "../tools/pr-review/identity";
import { syntheticCheckRuns } from "../tools/pr-review/local-source";
import { MAX_DIFF_BYTES, RefusalError, type PrSnapshot, type ReviewerRunner, type RunnerResult } from "../tools/pr-review/types";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const REV = "e".repeat(40);
const OPTIONS = { repo: "owner/name", pr: 5, expectHead: HEAD };
const IDENTITY: IdentityDecl = { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "", hostname: "" };

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  repo: "owner/name",
  number: 5,
  title: "t",
  body: "b",
  baseSha: BASE,
  headSha: HEAD,
  isOpen: true,
  diff: "diff --git a/a.ts b/a.ts",
  changedFiles: ["a.ts"],
  changedFilesComplete: true,
  commitMessages: ["m"],
  headFiles: [],
  omittedFiles: [],
  linkedIssues: [],
  trustedContext: [],
  livingDocs: [],
  workflowText: "jobs:\n",
  checkRuns: syntheticCheckRuns("passed"),
  ...overrides,
});

class FakeRunner implements ReviewerRunner {
  calls = 0;
  constructor(private readonly result: RunnerResult) {}
  async run(): Promise<RunnerResult> {
    this.calls++;
    return this.result;
  }
}

const okRunner = (output: unknown = { summary: "s", findings: [], observed_instructions: [] }) =>
  new FakeRunner({ ok: true, output, model: "claude-opus-5-5", tools: ["StructuredOutput"] });

const deps = (runner: ReviewerRunner, snap: PrSnapshot = snapshot()): ModelJobDeps => ({
  source: { snapshot: async () => snap },
  runner,
  identity: IDENTITY,
  toolRevision: REV,
});

// The artifact is what gets uploaded, so every case checks it survives the post job's validator
// after a JSON round trip, exactly as it will travel.
const roundTrips = (value: unknown) => validateModelRunArtifact(JSON.parse(JSON.stringify(value))).ok;

describe("runModelJob()", () => {
  test("a clean run: the artifact carries the output, the snapshot's SHAs and the tool revision", async () => {
    const runner = okRunner();
    const { artifact, diagnostic, identityHits } = await runModelJob(deps(runner), OPTIONS);
    expect(runner.calls).toBe(1);
    expect(artifact).toEqual({
      version: 1,
      repo: "owner/name",
      pr: 5,
      headSha: HEAD,
      baseSha: BASE,
      toolRevision: REV,
      result: { ok: true, output: { summary: "s", findings: [], observed_instructions: [] }, model: "claude-opus-5-5", tools: ["StructuredOutput"] },
    });
    expect(diagnostic).toBeNull();
    expect(identityHits).toEqual([]);
    expect(roundTrips(artifact)).toBe(true);
  });

  test("a head that moved refuses before the model runs", async () => {
    const runner = okRunner();
    await expect(runModelJob(deps(runner, snapshot({ headSha: "f".repeat(40) })), OPTIONS)).rejects.toBeInstanceOf(RefusalError);
    expect(runner.calls).toBe(0);
  });

  test("an unavailable diff runs no model", async () => {
    const runner = okRunner();
    const { artifact } = await runModelJob(deps(runner, snapshot({ diff: null })), OPTIONS);
    expect(runner.calls).toBe(0);
    expect(artifact.result).toEqual({ ok: false, reason: NO_MODEL_RUN_REASON });
    expect(roundTrips(artifact)).toBe(true);
  });

  test("a diff over the cap runs no model", async () => {
    const runner = okRunner();
    const { artifact } = await runModelJob(deps(runner, snapshot({ diff: "x".repeat(MAX_DIFF_BYTES + 1) })), OPTIONS);
    expect(runner.calls).toBe(0);
    expect(artifact.result).toEqual({ ok: false, reason: NO_MODEL_RUN_REASON });
  });

  test("a failed run keeps its reason in the artifact and its diagnostic out of it", async () => {
    const runner = new FakeRunner({ ok: false, reason: "the reviewer run exceeded its time limit", diagnostic: "stderr text" });
    const { artifact, diagnostic } = await runModelJob(deps(runner), OPTIONS);
    expect(artifact.result).toEqual({ ok: false, reason: "the reviewer run exceeded its time limit" });
    expect(JSON.stringify(artifact)).not.toContain("stderr text");
    expect(diagnostic).toBe("stderr text");
    expect(roundTrips(artifact)).toBe(true);
  });

  test("an output carrying a declared email is withheld, and the address never reaches the artifact", async () => {
    const runner = okRunner({ summary: "contact fixture@example.test", findings: [], observed_instructions: [] });
    const { artifact, identityHits } = await runModelJob(deps(runner), OPTIONS);
    expect(artifact.result.ok).toBe(false);
    if (!artifact.result.ok) expect(artifact.result.reason).toContain("email #1");
    expect(identityHits).toEqual(["email #1"]);
    expect(JSON.stringify(artifact)).not.toContain("fixture@example.test");
    expect(roundTrips(artifact)).toBe(true);
  });

  test("an identifying string used as an object key is withheld too", async () => {
    const runner = okRunner({ summary: "s", findings: [], observed_instructions: [], "Fixture Person": 1 });
    const { artifact } = await runModelJob(deps(runner), OPTIONS);
    expect(artifact.result.ok).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain("Fixture Person");
  });

  test("a diagnostic carrying a declared name is withheld before anything prints it", async () => {
    const runner = new FakeRunner({ ok: false, reason: "claude exited with code 1", diagnostic: "home of Fixture Person" });
    const { diagnostic } = await runModelJob(deps(runner), OPTIONS);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic).not.toContain("Fixture Person");
    expect(diagnostic).toContain("declared name #1");
  });

  test("an over-long or empty failure reason is cut to something the post job accepts", async () => {
    const long = await runModelJob(deps(new FakeRunner({ ok: false, reason: "r".repeat(2_000) })), OPTIONS);
    expect(roundTrips(long.artifact)).toBe(true);
    const empty = await runModelJob(deps(new FakeRunner({ ok: false, reason: "" })), OPTIONS);
    expect(roundTrips(empty.artifact)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test test/pr-review-ci-model.test.ts`
Expected: FAIL with a module resolution error for `../tools/pr-review/ci-model`.

- [ ] **Step 3: Implement `tools/pr-review/ci-model.ts`**

```ts
// The CI review job's half of a review (#146): snapshot, head check, one tool-less model run, and
// the identity scan of every string the result carries, all before the result is written to an
// artifact. Artifacts of a public repository are downloadable by anyone who can read it, and the
// model has been seen copying the CLI's "# userEmail" block into its output, so the scan runs here
// and not only in the post job. No App key exists in this process. ci.ts post does the rest with
// the existing runReview.

import {
  MAX_ARTIFACT_REASON_CHARS,
  MODEL_RUN_ARTIFACT_VERSION,
  collectStrings,
  type ArtifactResult,
  type ModelRunArtifact,
} from "./ci-artifact";
import { findIdentityHits, type IdentityDecl } from "./identity";
import { buildPrompt } from "./prompt";
import { MAX_DIFF_BYTES, RefusalError, type PrSource, type ReviewerRunner } from "./types";

export const NO_MODEL_RUN_REASON = "no model run: the diff was unavailable or over the size cap";

export interface ModelJobDeps {
  source: PrSource;
  runner: ReviewerRunner;
  identity: IdentityDecl;
  toolRevision: string;
}

export interface ModelJobOptions {
  repo: string;
  pr: number;
  expectHead: string;
}

export interface ModelJobOutcome {
  artifact: ModelRunArtifact;
  // Already scanned: either clean, or replaced by a notice naming only the hit classes.
  diagnostic: string | null;
  identityHits: string[];
}

export async function runModelJob(deps: ModelJobDeps, options: ModelJobOptions): Promise<ModelJobOutcome> {
  const snapshot = await deps.source.snapshot();
  if (snapshot.headSha !== options.expectHead) {
    throw new RefusalError(
      `refusing to review: the pull request's head is ${snapshot.headSha}, not the expected ${options.expectHead}, so the model did not run`,
    );
  }

  let result: ArtifactResult;
  let diagnostic: string | null = null;
  if (snapshot.diff === null || Buffer.byteLength(snapshot.diff, "utf8") > MAX_DIFF_BYTES) {
    result = { ok: false, reason: NO_MODEL_RUN_REASON };
  } else {
    const run = await deps.runner.run(buildPrompt(snapshot));
    if (run.ok) {
      result = { ok: true, output: run.output, model: run.model, tools: [...run.tools] };
    } else {
      const reason = run.reason.slice(0, MAX_ARTIFACT_REASON_CHARS);
      result = { ok: false, reason: reason.trim() === "" ? "the reviewer run failed" : reason };
      diagnostic = run.diagnostic ?? null;
    }
  }

  const identityHits = [...new Set(collectStrings(result).flatMap((text) => findIdentityHits(text, deps.identity)))];
  if (identityHits.length > 0) {
    result = {
      ok: false,
      reason: `the model job withheld the reviewer output because it carried identifying strings (${identityHits.join(", ")})`.slice(
        0,
        MAX_ARTIFACT_REASON_CHARS,
      ),
    };
  }

  let safeDiagnostic: string | null = null;
  if (diagnostic !== null) {
    const hits = findIdentityHits(diagnostic, deps.identity);
    safeDiagnostic = hits.length > 0 ? `(diagnostic withheld: identifying strings: ${hits.join(", ")})` : diagnostic;
  }

  return {
    artifact: {
      version: MODEL_RUN_ARTIFACT_VERSION,
      repo: options.repo,
      pr: options.pr,
      headSha: snapshot.headSha,
      baseSha: snapshot.baseSha,
      toolRevision: deps.toolRevision,
      result,
    },
    diagnostic: safeDiagnostic,
    identityHits,
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test test/pr-review-ci-model.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Ablate the scan**

Temporarily replace `collectStrings(result)` with `[]`. Run the file. Expected: FAIL on both "withheld" tests. Restore and re-run: PASS.

- [ ] **Step 6: Run the whole suite and commit**

Run: `bun test`
Expected: 0 fail.

```bash
git add tools/pr-review/ci-model.ts test/pr-review-ci-model.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(pr-review): CI review-job phase with a pre-upload identity scan (#146)" -m "Artifacts of a public repository are public, and the model has copied the CLI's userEmail block into its output before. runModelJob scans every key and value of the result before it becomes an artifact, withholds the output on a hit, and keeps claude's stderr out of the artifact. Rejected: relying on the post job's scan alone, which runs after the artifact is already downloadable."
```

---

### Task 5: The Actions entry point, `tools/pr-review/ci.ts`

Security-bearing.

**Files:**
- Create: `tools/pr-review/ci.ts`
- Test: `test/pr-review-ci.test.ts`

**Interfaces:**
- Consumes: Task 2 `loadCiIdentity`. Task 3 `ArtifactRunner`, `checkArtifactBinding`, `pinnedSource`, `validateModelRunArtifact`. Task 4 `runModelJob`. From `cli.ts`: `UsageError`, `cwdHasAutoloadFile`, `exitCodeFor`, `isCwdInsideRepo`, `reportOutcome(outcome, json, identity): number`, `reportRefusal(message, json): number`, `stripControlChars`. From `app-auth.ts`: `AppTokenMinter`, `readPrivateKey`. `GitHubClient` (`github.ts`), `runReview` (`pipeline.ts`), `ClaudeCliRunner` (`runner.ts`), `REPO_ROOT`, `toolState` (`tool-state.ts`).
- Produces:
  - `export type CiCommand = { command: "review"; repo: string; pr: number; expectHead: string; out: string } | { command: "post"; repo: string; pr: number; expectHead: string; appId: string; artifact: string; commentOnly: boolean }`
  - `export function parseCiArgs(argv: readonly string[]): CiCommand` (throws `UsageError`)
  - `export const READ_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/`
  - `export async function readTokenStdin(stdin: { isTTY: boolean; read: () => Promise<string> }, options?: { timeoutMs?: number }): Promise<{ ok: true; token: string } | { ok: false; reason: string }>`
  - `export class StaticTokenMinter implements TokenMinter` with `constructor(token: string)`
  - `export interface CiIo` (fields in Step 3)
  - `export async function ciMain(argv: string[], io?: CiIo): Promise<number>`
  - Command lines, used verbatim by Task 6:
    - `bun "$GITHUB_WORKSPACE/tools/pr-review/ci.ts" review --repo <owner/name> --pr <n> --expect-head <sha40> --token-stdin --out <absolute path>`
    - `bun "$GITHUB_WORKSPACE/tools/pr-review/ci.ts" post --repo <owner/name> --pr <n> --expect-head <sha40> --app-id <numeric id> --key-stdin --artifact <absolute path> [--comment-only]`

- [ ] **Step 1: Write the failing tests**

Create `test/pr-review-ci.test.ts`:

```ts
// Tests for tools/pr-review/ci.ts (#146), the GitHub Actions entry point. Every GitHub client, model
// runner, identity load and tool state is a fake passed through CiIo, so nothing here touches the
// network, a claude binary, the real profile or a real key.

import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateModelRunArtifact } from "../tools/pr-review/ci-artifact";
import { StaticTokenMinter, ciMain, parseCiArgs, readTokenStdin, type CiIo } from "../tools/pr-review/ci";
import { UsageError } from "../tools/pr-review/cli";
import type { IdentityLoad } from "../tools/pr-review/identity";
import { syntheticCheckRuns } from "../tools/pr-review/local-source";
import { REPO_ROOT } from "../tools/pr-review/tool-state";
import { RefusalError, type PrSnapshot, type ReviewEvent, type RunnerResult } from "../tools/pr-review/types";

const NEUTRAL_DIR = mkdtempSync(join(tmpdir(), "pr-review-ci-cwd-"));
const OUT_DIR = mkdtempSync(join(tmpdir(), "pr-review-ci-out-"));
afterAll(() => {
  rmSync(NEUTRAL_DIR, { recursive: true, force: true });
  rmSync(OUT_DIR, { recursive: true, force: true });
});

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const REV = "e".repeat(40);
const TOKEN = `ghs_${"a".repeat(36)}`;
const KEY_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const CLEAN_OUTPUT = { summary: "s", findings: [], observed_instructions: [] };
const IDENTITY_OK: IdentityLoad = {
  ok: true,
  declared: true,
  accountEmail: true,
  decl: { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "", hostname: "" },
};

let counter = 0;
const freshPath = () => join(OUT_DIR, `model-run-${++counter}.json`);

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  repo: "owner/name",
  number: 5,
  title: "t",
  body: "b",
  baseSha: BASE,
  headSha: HEAD,
  isOpen: true,
  diff: "diff --git a/a.ts b/a.ts",
  changedFiles: ["a.ts"],
  changedFilesComplete: true,
  commitMessages: ["m"],
  headFiles: [],
  omittedFiles: [],
  linkedIssues: [],
  trustedContext: [],
  livingDocs: [],
  workflowText: "jobs:\n",
  checkRuns: syntheticCheckRuns("passed"),
  ...overrides,
});

class FakeAppClient {
  posts: Array<{ commitId: string; event: ReviewEvent; body: string }> = [];
  constructor(private readonly snap: PrSnapshot = snapshot()) {}
  async snapshot() {
    return this.snap;
  }
  async currentHeadSha() {
    return this.snap.headSha;
  }
  async postReview(input: { commitId: string; event: ReviewEvent; body: string }) {
    this.posts.push(input);
    return { id: 1, htmlUrl: "https://example.test/review/1" };
  }
}

const neverRead = {
  isTTY: false,
  read: async (): Promise<string> => {
    throw new Error("stdin must not be read before this refusal");
  },
};

function io(overrides: Partial<CiIo> = {}): CiIo {
  return {
    cwd: () => NEUTRAL_DIR,
    env: { GITHUB_ACTIONS: "true" },
    stdin: { isTTY: false, read: async () => TOKEN },
    loadIdentity: () => IDENTITY_OK,
    toolState: () => ({ revision: REV, dirty: false }),
    buildReadSource: () => ({ snapshot: async () => snapshot() }),
    buildRunner: () => ({
      run: async (): Promise<RunnerResult> => ({ ok: true, output: CLEAN_OUTPUT, model: "claude-opus-5-5", tools: ["StructuredOutput"] }),
    }),
    ...overrides,
  };
}

const postIo = (client: FakeAppClient, overrides: Partial<CiIo> = {}): CiIo =>
  io({ stdin: { isTTY: false, read: async () => KEY_PEM }, buildAppClient: () => client, ...overrides });

const reviewArgv = (out: string) => ["review", "--repo", "owner/name", "--pr", "5", "--expect-head", HEAD, "--token-stdin", "--out", out];
const postArgv = (artifact: string, extra: string[] = []) => [
  "post", "--repo", "owner/name", "--pr", "5", "--expect-head", HEAD, "--app-id", "12345", "--key-stdin", "--artifact", artifact, ...extra,
];

function writeArtifact(overrides: Record<string, unknown> = {}): string {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({
    version: 1,
    repo: "owner/name",
    pr: 5,
    headSha: HEAD,
    baseSha: BASE,
    toolRevision: REV,
    result: { ok: true, output: CLEAN_OUTPUT, model: "claude-opus-5-5", tools: ["StructuredOutput"] },
    ...overrides,
  }));
  return path;
}

describe("parseCiArgs()", () => {
  test("review", () => {
    const out = join(OUT_DIR, "x.json");
    expect(parseCiArgs(reviewArgv(out))).toEqual({ command: "review", repo: "owner/name", pr: 5, expectHead: HEAD, out });
  });

  test("post, with and without --comment-only", () => {
    const artifact = join(OUT_DIR, "a.json");
    expect(parseCiArgs(postArgv(artifact))).toEqual({
      command: "post", repo: "owner/name", pr: 5, expectHead: HEAD, appId: "12345", artifact, commentOnly: false,
    });
    expect(parseCiArgs(postArgv(artifact, ["--comment-only"]))).toMatchObject({ commentOnly: true });
  });

  const out = join(OUT_DIR, "x.json");
  const artifact = join(OUT_DIR, "a.json");
  test.each([
    ["no command", []],
    ["the local snapshot command", ["snapshot", "--pr", "5"]],
    ["review without --expect-head", ["review", "--repo", "owner/name", "--pr", "5", "--token-stdin", "--out", out]],
    ["review with an uppercase head", ["review", "--repo", "owner/name", "--pr", "5", "--expect-head", "C".repeat(40), "--token-stdin", "--out", out]],
    ["review with a relative --out", ["review", "--repo", "owner/name", "--pr", "5", "--expect-head", HEAD, "--token-stdin", "--out", "relative/out.json"]],
    ["review without --token-stdin", ["review", "--repo", "owner/name", "--pr", "5", "--expect-head", HEAD, "--out", out]],
    ["review given --key-stdin", [...reviewArgv(out), "--key-stdin"]],
    ["review with a malformed repo", ["review", "--repo", "owner", "--pr", "5", "--expect-head", HEAD, "--token-stdin", "--out", out]],
    ["review with pr 0", ["review", "--repo", "owner/name", "--pr", "0", "--expect-head", HEAD, "--token-stdin", "--out", out]],
    ["post without --key-stdin", ["post", "--repo", "owner/name", "--pr", "5", "--expect-head", HEAD, "--app-id", "12345", "--artifact", artifact]],
    ["post given --token-stdin", [...postArgv(artifact), "--token-stdin"]],
    ["post with a non-numeric App ID", ["post", "--repo", "owner/name", "--pr", "5", "--expect-head", HEAD, "--app-id", "Iv1.abc", "--key-stdin", "--artifact", artifact]],
    ["post with a relative --artifact", ["post", "--repo", "owner/name", "--pr", "5", "--expect-head", HEAD, "--app-id", "12345", "--key-stdin", "--artifact", "a.json"]],
  ])("usage error: %s", (_label, argv) => {
    expect(() => parseCiArgs(argv as string[])).toThrow(UsageError);
  });
});

describe("readTokenStdin()", () => {
  test("refuses a console terminal without reading", async () => {
    expect((await readTokenStdin({ isTTY: true, read: neverRead.read })).ok).toBe(false);
  });

  test("accepts a token with surrounding whitespace", async () => {
    expect(await readTokenStdin({ isTTY: false, read: async () => `  ${TOKEN}\n` })).toEqual({ ok: true, token: TOKEN });
  });

  test.each([["empty", ""], ["carrying a space", "ghs_aaaa bbbbbbbbbbbbbbbbbbbbbbbb"], ["too short", "ghs_a"]])("refuses stdin that is %s", async (_label, text) => {
    expect((await readTokenStdin({ isTTY: false, read: async () => text })).ok).toBe(false);
  });

  test("times out on stdin that never closes", async () => {
    const result = await readTokenStdin({ isTTY: false, read: () => new Promise<string>(() => {}) }, { timeoutMs: 20 });
    expect(result.ok).toBe(false);
  });
});

describe("StaticTokenMinter", () => {
  test("mints the token it was given", async () => {
    expect((await new StaticTokenMinter(TOKEN).mint()).token).toBe(TOKEN);
  });
});

describe("ciMain(): guards", () => {
  test("a usage error returns 1", async () => {
    expect(await ciMain(["review"], io({ stdin: neverRead }))).toBe(1);
  });

  test("refuses outside GitHub Actions before reading stdin", async () => {
    await expect(ciMain(reviewArgv(freshPath()), io({ env: {}, stdin: neverRead }))).rejects.toBeInstanceOf(RefusalError);
  });

  test("refuses from inside the repository checkout", async () => {
    await expect(ciMain(reviewArgv(freshPath()), io({ cwd: () => REPO_ROOT, stdin: neverRead }))).rejects.toBeInstanceOf(RefusalError);
  });

  test("refuses from a directory holding bunfig.toml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-ci-bunfig-"));
    writeFileSync(join(dir, "bunfig.toml"), "");
    try {
      await expect(ciMain(reviewArgv(freshPath()), io({ cwd: () => dir, stdin: neverRead }))).rejects.toBeInstanceOf(RefusalError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 2 without reading stdin when the identity secrets do not load", async () => {
    const out = freshPath();
    expect(await ciMain(reviewArgv(out), io({ stdin: neverRead, loadIdentity: () => ({ ok: false, reason: "PR_REVIEW_IDENTITY is not set" }) }))).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  test("returns 2 without reading stdin when the checkout is dirty", async () => {
    expect(await ciMain(reviewArgv(freshPath()), io({ stdin: neverRead, toolState: () => ({ revision: REV, dirty: true }) }))).toBe(2);
  });
});

describe("ciMain(): review", () => {
  test("writes a valid artifact for the reviewed head and returns 0", async () => {
    const out = freshPath();
    expect(await ciMain(reviewArgv(out), io())).toBe(0);
    const validated = validateModelRunArtifact(JSON.parse(readFileSync(out, "utf8")));
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.headSha).toBe(HEAD);
      expect(validated.value.baseSha).toBe(BASE);
      expect(validated.value.toolRevision).toBe(REV);
      expect(validated.value.result.ok).toBe(true);
    }
  });

  test("a failed model run still writes an artifact and returns 0, so the post job can comment", async () => {
    const out = freshPath();
    const failing = io({ buildRunner: () => ({ run: async (): Promise<RunnerResult> => ({ ok: false, reason: "claude exited with code 1" }) }) });
    expect(await ciMain(reviewArgv(out), failing)).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).result).toEqual({ ok: false, reason: "claude exited with code 1" });
  });

  test("a malformed token returns 2 and writes nothing", async () => {
    const out = freshPath();
    expect(await ciMain(reviewArgv(out), io({ stdin: { isTTY: false, read: async () => "not a token" } }))).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  test("a head that moved returns 2, runs no model and writes nothing", async () => {
    const out = freshPath();
    let ran = 0;
    const moved = io({
      buildReadSource: () => ({ snapshot: async () => snapshot({ headSha: "f".repeat(40) }) }),
      buildRunner: () => ({ run: async (): Promise<RunnerResult> => { ran++; return { ok: false, reason: "x" }; } }),
    });
    expect(await ciMain(reviewArgv(out), moved)).toBe(2);
    expect(ran).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  test("never overwrites an existing file", async () => {
    const out = freshPath();
    writeFileSync(out, "keep");
    await expect(ciMain(reviewArgv(out), io())).rejects.toThrow();
    expect(readFileSync(out, "utf8")).toBe("keep");
  });
});

describe("ciMain(): post", () => {
  test("a clean artifact and passing CI post APPROVE on the head", async () => {
    const client = new FakeAppClient();
    expect(await ciMain(postArgv(writeArtifact()), postIo(client))).toBe(0);
    expect(client.posts.map((p) => [p.event, p.commitId])).toEqual([["APPROVE", HEAD]]);
  });

  test("--comment-only posts COMMENT", async () => {
    const client = new FakeAppClient();
    expect(await ciMain(postArgv(writeArtifact(), ["--comment-only"]), postIo(client))).toBe(0);
    expect(client.posts.map((p) => p.event)).toEqual(["COMMENT"]);
  });

  test("a failed artifact posts COMMENT", async () => {
    const client = new FakeAppClient();
    const path = writeArtifact({ result: { ok: false, reason: "the model job withheld the reviewer output because it carried identifying strings (email #1)" } });
    expect(await ciMain(postArgv(path), postIo(client))).toBe(0);
    expect(client.posts.map((p) => p.event)).toEqual(["COMMENT"]);
  });

  test("a correctness finding posts REQUEST_CHANGES", async () => {
    const client = new FakeAppClient();
    const output = { summary: "s", findings: [{ severity: "correctness", confidence: "high", path: "a.ts", title: "t", detail: "d" }], observed_instructions: [] };
    const path = writeArtifact({ result: { ok: true, output, model: "claude-opus-5-5", tools: ["StructuredOutput"] } });
    expect(await ciMain(postArgv(path), postIo(client))).toBe(0);
    expect(client.posts.map((p) => p.event)).toEqual(["REQUEST_CHANGES"]);
  });

  const refusals: Array<[string, () => string, Partial<CiIo>, PrSnapshot?]> = [
    ["a missing artifact file", () => join(OUT_DIR, "never-written.json"), {}],
    ["an artifact that is not JSON", () => { const p = freshPath(); writeFileSync(p, "{"); return p; }, {}],
    ["an artifact naming another model", () => writeArtifact({ result: { ok: true, output: CLEAN_OUTPUT, model: "claude-opus-5", tools: ["StructuredOutput"] } }), {}],
    ["an artifact for another head", () => writeArtifact({ headSha: "f".repeat(40) }), {}],
    ["an artifact for another pull request", () => writeArtifact({ pr: 6 }), {}],
    ["an artifact from another tool revision", () => writeArtifact({ toolRevision: "a".repeat(40) }), {}],
    ["a base that moved since the review job", () => writeArtifact(), {}, snapshot({ baseSha: "a".repeat(40) })],
    ["stdin that carries no key", () => writeArtifact(), { stdin: { isTTY: false, read: async () => "not a key" } }],
  ];
  test.each(refusals)("returns 2 and posts nothing for %s", async (_label, artifactPath, overrides, snap) => {
    const client = new FakeAppClient(snap ?? snapshot());
    expect(await ciMain(postArgv(artifactPath()), postIo(client, overrides))).toBe(2);
    expect(client.posts).toEqual([]);
  });

  test("a dirty checkout returns 2 before the key is read", async () => {
    const client = new FakeAppClient();
    expect(await ciMain(postArgv(writeArtifact()), postIo(client, { stdin: neverRead, toolState: () => ({ revision: REV, dirty: true }) }))).toBe(2);
    expect(client.posts).toEqual([]);
  });
});
```

Note the unused import check: `mkdirSync` is imported for parity with the cli tests. Remove it if the file does not use it, since an unused import is harmless at runtime but noise in review.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test test/pr-review-ci.test.ts`
Expected: FAIL with a module resolution error for `../tools/pr-review/ci`.

- [ ] **Step 3: Implement `tools/pr-review/ci.ts`**

```ts
#!/usr/bin/env bun
// The #120 reviewer's GitHub Actions entry point (#146). A workstation uses cli.ts, never this.
// Spec: docs/superpowers/specs/2026-10-05-pr-review-ci-design.md. One command per job of
// .github/workflows/pr-review.yml:
//   printf '%s' "$GH_READ_TOKEN" | env -u GH_READ_TOKEN bun "$GITHUB_WORKSPACE/tools/pr-review/ci.ts" review --repo <owner/name> --pr <n> --expect-head <sha40> --token-stdin --out <absolute path>
//   printf '%s' "$PR_REVIEW_APP_KEY" | env -u PR_REVIEW_APP_KEY bun "$GITHUB_WORKSPACE/tools/pr-review/ci.ts" post --repo <owner/name> --pr <n> --expect-head <sha40> --app-id <id> --key-stdin --artifact <absolute path> [--comment-only]
// review holds a read-scoped GITHUB_TOKEN and the model token, never the App key. post holds the App
// key and never runs the model. Both refuse outside GitHub Actions, from an unsafe working directory
// (cli.ts, BUN-CWD), with a dirty checkout, and without the CI identity secrets, all before stdin is
// read. The key and the token arrive on stdin only. printf is a shell builtin, so neither appears in
// any process's arguments, and env -u keeps each out of the Bun process's environment and therefore
// out of every child it starts.
// Exit codes match cli.ts: 0 done, 2 refused, 1 usage or runtime error.

import type { KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { AppTokenMinter, readPrivateKey } from "./app-auth";
import { ArtifactRunner, checkArtifactBinding, pinnedSource, validateModelRunArtifact } from "./ci-artifact";
import { runModelJob } from "./ci-model";
import { UsageError, cwdHasAutoloadFile, exitCodeFor, isCwdInsideRepo, reportOutcome, reportRefusal, stripControlChars } from "./cli";
import { GitHubClient } from "./github";
import { loadCiIdentity, type IdentityDecl, type IdentityLoad } from "./identity";
import { runReview } from "./pipeline";
import { ClaudeCliRunner } from "./runner";
import { REPO_ROOT, toolState } from "./tool-state";
import {
  RefusalError,
  SHA_RE,
  parseRepo,
  type InstallationToken,
  type PrSource,
  type ReviewPoster,
  type ReviewerRunner,
  type TokenMinter,
} from "./types";

export type CiCommand =
  | { command: "review"; repo: string; pr: number; expectHead: string; out: string }
  | { command: "post"; repo: string; pr: number; expectHead: string; appId: string; artifact: string; commentOnly: boolean };

const USAGE = [
  'printf \'%s\' "$GH_READ_TOKEN" | env -u GH_READ_TOKEN bun <absolute path>/tools/pr-review/ci.ts review --repo <owner/name> --pr <n> --expect-head <sha40> --token-stdin --out <absolute path>',
  'printf \'%s\' "$PR_REVIEW_APP_KEY" | env -u PR_REVIEW_APP_KEY bun <absolute path>/tools/pr-review/ci.ts post --repo <owner/name> --pr <n> --expect-head <sha40> --app-id <id> --key-stdin --artifact <absolute path> [--comment-only]',
].join("\n");

export function parseCiArgs(argv: readonly string[]): CiCommand {
  const [command, ...rest] = argv;
  if (command !== "review" && command !== "post") throw new UsageError(`unknown command: ${command ?? "(none)"}`);
  const shared: Parameters<typeof parseArgs>[0]["options"] = {
    repo: { type: "string" },
    pr: { type: "string" },
    "expect-head": { type: "string" },
  };
  const options: Parameters<typeof parseArgs>[0]["options"] =
    command === "review"
      ? { ...shared, "token-stdin": { type: "boolean" }, out: { type: "string" } }
      : { ...shared, "app-id": { type: "string" }, "key-stdin": { type: "boolean" }, artifact: { type: "string" }, "comment-only": { type: "boolean" } };
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: [...rest], options, strict: true, allowPositionals: false }).values as Record<string, string | boolean | undefined>;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const repo = values.repo;
  if (typeof repo !== "string" || parseRepo(repo) === null) throw new UsageError(`${command} needs --repo owner/name`);
  const prText = values.pr;
  if (typeof prText !== "string" || !/^[1-9][0-9]*$/.test(prText) || !Number.isSafeInteger(Number(prText))) {
    throw new UsageError(`${command} needs --pr <positive integer>`);
  }
  const expectHead = values["expect-head"];
  if (typeof expectHead !== "string" || !SHA_RE.test(expectHead)) {
    throw new UsageError(`${command} needs --expect-head <40-character lowercase hex commit SHA>`);
  }

  if (command === "review") {
    if (values["token-stdin"] !== true) throw new UsageError("review reads the GitHub token only from stdin: pass --token-stdin");
    const out = values.out;
    if (typeof out !== "string" || !isAbsolute(out)) throw new UsageError("review needs --out <absolute path>");
    return { command, repo, pr: Number(prText), expectHead, out };
  }
  const appId = values["app-id"];
  if (typeof appId !== "string" || !/^[1-9][0-9]*$/.test(appId)) throw new UsageError("post needs --app-id <numeric App ID>");
  if (values["key-stdin"] !== true) throw new UsageError("post reads the App key only from stdin: pass --key-stdin");
  const artifact = values.artifact;
  if (typeof artifact !== "string" || !isAbsolute(artifact)) throw new UsageError("post needs --artifact <absolute path>");
  return { command, repo, pr: Number(prText), expectHead, appId, artifact, commentOnly: values["comment-only"] === true };
}

// A GitHub token: ghs_ and its peers, letters, digits and underscores only. The value is never echoed.
export const READ_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

export async function readTokenStdin(
  stdin: { isTTY: boolean; read: () => Promise<string> },
  options: { timeoutMs?: number } = {},
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  if (stdin.isTTY) return { ok: false, reason: "stdin is a console terminal: pipe the token in" };
  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `no token arrived on stdin within ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
  });
  const read = stdin.read().then((text): { ok: true; token: string } | { ok: false; reason: string } => {
    const token = text.trim();
    return READ_TOKEN_RE.test(token) ? { ok: true, token } : { ok: false, reason: "stdin did not carry a GitHub token" };
  });
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// The review job's read-only GITHUB_TOKEN, handed to GitHubClient in place of an App token.
// GitHubClient reads only .token, so expiresAt is left empty.
export class StaticTokenMinter implements TokenMinter {
  constructor(private readonly token: string) {}

  async mint(): Promise<InstallationToken> {
    return { token: this.token, expiresAt: "" };
  }
}

// Process-level effects and the external clients, as function parameters a test passes. Nothing on
// the command line or in the environment reaches these. ciMain's default is REAL_CI_IO.
export interface CiIo {
  cwd: () => string;
  env: Record<string, string | undefined>;
  stdin: { isTTY: boolean; read: () => Promise<string> };
  loadIdentity?: () => IdentityLoad;
  toolState?: () => { revision: string; dirty: boolean };
  buildReadSource?: (repo: string, pr: number, token: string) => PrSource;
  buildRunner?: () => ReviewerRunner;
  buildAppClient?: (repo: string, pr: number, appId: string, key: KeyObject) => PrSource & ReviewPoster;
}

const REAL_CI_IO: CiIo = {
  cwd: () => process.cwd(),
  env: process.env,
  stdin: { isTTY: Boolean(process.stdin.isTTY), read: () => Bun.stdin.text() },
};

export async function ciMain(argv: string[], io: CiIo = REAL_CI_IO): Promise<number> {
  let parsed: CiCommand;
  try {
    parsed = parseCiArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${stripControlChars(error.message)}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }

  if (io.env.GITHUB_ACTIONS !== "true") {
    throw new RefusalError("refusing to run: ci.ts runs only inside GitHub Actions, and a workstation uses cli.ts");
  }
  if (isCwdInsideRepo(io.cwd(), REPO_ROOT) || cwdHasAutoloadFile(io.cwd())) {
    throw new RefusalError(
      "refusing to run: Bun auto-loads bunfig.toml and .env files from the working directory, and this one is inside a repository checkout or holds one of those files",
    );
  }
  const identity = (io.loadIdentity ?? (() => loadCiIdentity(io.env)))();
  if (!identity.ok) return reportRefusal(identity.reason, false);
  const tool = (io.toolState ?? toolState)();
  if (tool.dirty !== false) return reportRefusal("the reviewer's checkout has uncommitted changes, so this run would not trace to committed code", false);

  try {
    if (parsed.command === "review") return await reviewCommand(parsed, io, identity.decl, tool.revision);
    return await postCommand(parsed, io, identity, tool);
  } catch (error) {
    if (error instanceof RefusalError) return reportRefusal(error.message, false);
    throw error;
  }
}

async function reviewCommand(
  cmd: Extract<CiCommand, { command: "review" }>,
  io: CiIo,
  identity: IdentityDecl,
  revision: string,
): Promise<number> {
  const token = await readTokenStdin(io.stdin);
  if (!token.ok) return reportRefusal(token.reason, false);
  const buildSource = io.buildReadSource ?? ((repo, pr, t) => new GitHubClient({ repo, pr, minter: new StaticTokenMinter(t) }));
  const runner = (io.buildRunner ?? (() => new ClaudeCliRunner()))();
  const outcome = await runModelJob(
    { source: buildSource(cmd.repo, cmd.pr, token.token), runner, identity, toolRevision: revision },
    { repo: cmd.repo, pr: cmd.pr, expectHead: cmd.expectHead },
  );
  // flag wx: an existing file is an error, never overwritten. mode applies on POSIX.
  writeFileSync(cmd.out, JSON.stringify(outcome.artifact), { flag: "wx", mode: 0o600 });
  const result = outcome.artifact.result;
  console.log(`model-run: ${result.ok ? "ok" : "failed"} head=${outcome.artifact.headSha}`);
  if (!result.ok) console.log(`model-run reason: ${stripControlChars(result.reason)}`);
  if (outcome.diagnostic !== null) console.error(`reviewer diagnostic: ${stripControlChars(outcome.diagnostic)}`);
  return 0;
}

async function postCommand(
  cmd: Extract<CiCommand, { command: "post" }>,
  io: CiIo,
  identity: Extract<IdentityLoad, { ok: true }>,
  tool: { revision: string; dirty: boolean },
): Promise<number> {
  const key = await readPrivateKey(io.stdin);
  if (!key.ok) return reportRefusal(key.reason, false);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cmd.artifact, "utf8"));
  } catch {
    return reportRefusal("the model-run artifact is missing or is not JSON", false);
  }
  const validated = validateModelRunArtifact(raw);
  if (!validated.ok) return reportRefusal(validated.reason, false);
  const artifact = validated.value;
  const mismatch = checkArtifactBinding(artifact, { repo: cmd.repo, pr: cmd.pr, headSha: cmd.expectHead, toolRevision: tool.revision });
  if (mismatch !== null) return reportRefusal(mismatch, false);

  const buildClient =
    io.buildAppClient ?? ((repo, pr, appId, k) => new GitHubClient({ repo, pr, minter: new AppTokenMinter({ appId, key: k, repo }) }));
  const github = buildClient(cmd.repo, cmd.pr, cmd.appId, key.key);
  const outcome = await runReview(
    {
      source: pinnedSource(github, artifact),
      runner: new ArtifactRunner(artifact.result),
      poster: github,
      identity: identity.decl,
      accountEmail: identity.accountEmail,
      toolRevision: tool.revision,
      toolDirty: tool.dirty,
    },
    { commentOnly: cmd.commentOnly, expectHead: artifact.headSha },
  );
  return reportOutcome(outcome, false, identity.decl);
}

if (import.meta.main) {
  ciMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`error: ${stripControlChars(error instanceof Error ? error.message : String(error))}`);
      process.exit(exitCodeFor(error));
    },
  );
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test test/pr-review-ci.test.ts`
Expected: PASS, 0 fail. If the unused `mkdirSync` import is still in the test file, delete it now and re-run.

- [ ] **Step 5: Ablate the Actions guard**

Temporarily change `if (io.env.GITHUB_ACTIONS !== "true")` to `if (false)`. Run the file. Expected: FAIL on "refuses outside GitHub Actions before reading stdin" (the throwing stdin read surfaces instead of the refusal). Restore and re-run: PASS.

- [ ] **Step 6: Confirm the entry point refuses for real outside Actions**

Run from an empty directory outside the checkout (Git Bash):

```bash
D=$(mktemp -d) && (cd "$D" && env -u GITHUB_ACTIONS bun "<absolute path of this checkout>/tools/pr-review/ci.ts" review --repo owner/name --pr 5 --expect-head cccccccccccccccccccccccccccccccccccccccc --token-stdin --out "$D/out.json" </dev/null; echo "exit=$?"); rm -rf "$D"
```

Expected: a `refused:` or `error:` line naming GitHub Actions, then `exit=2`.

- [ ] **Step 7: Run the whole suite and commit**

Run: `bun test`
Expected: 0 fail.

```bash
git add tools/pr-review/ci.ts test/pr-review-ci.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(pr-review): GitHub Actions entry point with review and post commands (#146)" -m "A separate entry point keeps cli.ts and the local path unchanged. review reads a read-only token on stdin, runs the model job and writes the artifact without overwriting. post reads the App key on stdin, validates and binds the artifact, and runs runReview with the artifact standing in for the model. Both refuse outside Actions, from an unsafe cwd, with a dirty checkout or without the identity secrets, before stdin is read. Rejected: new subcommands in cli.ts, which would put CI-only identity handling behind the operator's own command."
```

---

### Task 6: The workflow and its invariant test

Security-bearing.

**Files:**
- Create: `.github/workflows/pr-review.yml`
- Test: `test/pr-review-workflow.test.ts`

**Interfaces:**
- Consumes: the two command lines from Task 5. The exact values in Global Constraints.
- Produces: workflow `pr-review`, jobs `review` and `post`, artifact `pr-review-model-run`. Task 9 edits the post step's `--comment-only` and the test that pins it.

- [ ] **Step 1: Confirm the CLI pin against the registry**

Run (PowerShell):

```powershell
$b = npm view @anthropic-ai/claude-code-linux-x64@2.1.291 dist.integrity
([Convert]::FromBase64String($b.Substring(7)) | ForEach-Object { $_.ToString('x2') }) -join ''
```

Expected: exactly `8b4609c5d87cc886d143dc7582c6c1db8a155a1b3b04044d4481e84635f0d02783e18a792685694256df3c803d460dd4864707e9ddd2b58005ad2b779769b91c`. (`Substring(7)` drops the `sha512-` prefix.) A different value: stop and report.

- [ ] **Step 2: Write the failing test**

Create `test/pr-review-workflow.test.ts`:

```ts
// Pins the security properties of .github/workflows/pr-review.yml (#146) that its own comments
// state. Spec: docs/superpowers/specs/2026-10-05-pr-review-ci-design.md. Each test names one
// property, so a change that breaks one fails here by name rather than in a live run.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_FILE = join(import.meta.dir, "..", ".github", "workflows", "pr-review.yml");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  "working-directory"?: string;
}
interface Job {
  if?: string;
  needs?: string;
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, unknown>;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps: Step[];
}

const workflow = Bun.YAML.parse(readFileSync(WORKFLOW_FILE, "utf8")) as Record<string, any>;
const jobs = workflow.jobs as Record<string, Job>;
const review = jobs.review!;
const post = jobs.post!;
const allSteps = (): Step[] => Object.values(jobs).flatMap((job) => job.steps);
const ciSteps = (): Step[] => allSteps().filter((step) => (step.run ?? "").includes("tools/pr-review/ci.ts"));

describe("pr-review.yml: trigger and scope", () => {
  test("workflow_run on the test workflow's completion is the only trigger", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_run"]);
    expect(workflow.on.workflow_run).toEqual({ workflows: ["test"], types: ["completed"] });
  });

  test("the review job runs only for a same-repository pull request whose CI succeeded or failed", () => {
    const condition = String(review.if).replace(/\s+/g, " ");
    expect(condition).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(condition).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(condition).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(condition).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(condition).toContain("github.event.workflow_run.pull_requests[0].number != null");
  });

  test("the post job depends on the review job", () => {
    expect(post.needs).toBe("review");
  });

  test("superseded runs for the same pull request are cancelled", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(String(workflow.concurrency.group)).toContain("github.event.workflow_run.pull_requests[0].number");
  });

  test("both jobs run on the pinned image with a timeout", () => {
    for (const job of [review, post]) {
      expect(job["runs-on"]).toBe("ubuntu-24.04");
      expect(typeof job["timeout-minutes"]).toBe("number");
    }
  });
});

describe("pr-review.yml: credentials", () => {
  test("no workflow-level permission, and the minimum per job", () => {
    expect(workflow.permissions).toEqual({});
    expect(review.permissions).toEqual({ contents: "read", "pull-requests": "read", issues: "read", checks: "read" });
    expect(post.permissions).toEqual({ contents: "read" });
  });

  test("each job names its own environment", () => {
    expect(review.environment).toBe("pr-review-model");
    expect(post.environment).toBe("pr-review");
  });

  test("the App key appears in one step of the post job, piped on stdin and stripped from Bun's environment", () => {
    const holders = allSteps().filter((step) => step.env !== undefined && "PR_REVIEW_APP_KEY" in step.env);
    expect(holders).toHaveLength(1);
    expect(post.steps).toContain(holders[0]!);
    expect(holders[0]!.run).toStartWith(`printf '%s' "$PR_REVIEW_APP_KEY" | env -u PR_REVIEW_APP_KEY bun `);
    expect(workflow.env).toBeUndefined();
    expect(JSON.stringify(post.env ?? {})).not.toContain("PR_REVIEW_APP_KEY");
    expect(JSON.stringify(review)).not.toContain("PR_REVIEW_APP_KEY");
  });

  test("the model token and the claude CLI stay in the review job", () => {
    expect(JSON.stringify(post)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(post)).not.toContain("claude-code-linux-x64");
    expect(JSON.stringify(review)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("the read token reaches Bun on stdin and is stripped from its environment", () => {
    const holders = allSteps().filter((step) => step.env !== undefined && "GH_READ_TOKEN" in step.env);
    expect(holders).toHaveLength(1);
    expect(review.steps).toContain(holders[0]!);
    expect(holders[0]!.run).toStartWith(`printf '%s' "$GH_READ_TOKEN" | env -u GH_READ_TOKEN bun `);
  });

  test("both jobs read the identity secrets", () => {
    for (const job of [review, post]) {
      const text = JSON.stringify(job);
      expect(text).toContain("secrets.PR_REVIEW_IDENTITY");
      expect(text).toContain("secrets.PR_REVIEW_ACCOUNT_EMAIL");
    }
  });
});

describe("pr-review.yml: what runs", () => {
  test("every action is pinned to a full commit SHA", () => {
    const uses = allSteps().flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  test("every checkout keeps no credential and names no ref, so it is the default branch", () => {
    const checkouts = allSteps().filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    for (const step of checkouts) {
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(step.with).not.toHaveProperty("ref");
      expect(step.with).not.toHaveProperty("repository");
    }
  });

  test("no run script contains an expression: every value reaches a script through env", () => {
    for (const step of allSteps()) expect(step.run ?? "").not.toContain("${{");
  });

  test("ci.ts runs from the empty working directory, by absolute path, once per job", () => {
    const steps = ciSteps();
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step["working-directory"]).toBe("${{ runner.temp }}/pr-review-cwd");
      expect(step.run).toContain(`bun "$GITHUB_WORKSPACE/tools/pr-review/ci.ts" `);
    }
    expect(review.steps.filter((s) => ciSteps().includes(s))[0]!.run).toContain(" review ");
    expect(post.steps.filter((s) => ciSteps().includes(s))[0]!.run).toContain(" post ");
  });

  test("the claude CLI is pinned by version and SHA-512 and checked before use", () => {
    expect(String(review.env?.CLAUDE_CLI_VERSION)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(String(review.env?.CLAUDE_CLI_SHA512)).toMatch(/^[0-9a-f]{128}$/);
    const install = review.steps.find((step) => (step.run ?? "").includes("claude-code-linux-x64"));
    expect(install?.run).toContain("sha512sum -c -");
    expect(install?.run).toContain("--version");
    expect(install?.run).not.toContain("npm ");
  });

  test("the artifact is short-lived, required, and the one the post job downloads", () => {
    const upload = review.steps.find((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"));
    const download = post.steps.find((step) => (step.uses ?? "").startsWith("actions/download-artifact@"));
    expect(upload?.with?.name).toBe("pr-review-model-run");
    expect(upload?.with?.["retention-days"]).toBe(1);
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    expect(download?.with?.name).toBe("pr-review-model-run");
  });

  test("rollout: the post step is limited to COMMENT until Task 9 lifts it", () => {
    expect(ciSteps().find((step) => post.steps.includes(step))!.run).toContain("--comment-only");
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `bun test test/pr-review-workflow.test.ts`
Expected: FAIL, ENOENT on `.github/workflows/pr-review.yml`.

- [ ] **Step 4: Write `.github/workflows/pr-review.yml`**

```yaml
name: pr-review

# #146: the #120 pull request reviewer, run in GitHub Actions.
# Spec: docs/superpowers/specs/2026-10-05-pr-review-ci-design.md
#
# Trigger: workflow_run only, on completion of the "test" workflow. A workflow_run run executes this
# file as it stands on the default branch and checks out the default branch, never the pull request.
# pull_request_target is forbidden in this file: it hands secrets to a run in the base context, and
# the standard failure is that trigger combined with a checkout of the pull request head. Plain
# pull_request is not used either, because it runs the pull request's own copy of this file.
#
# Secrets: two environments, each allowing deployments from master only, so no job a pull request
# can start reaches either one. review holds the model token and reads the pull request. post holds
# the App key and never runs the model. The model's result crosses between them as an artifact, which
# post validates and binds to the repository, pull request, head, base and tool revision before use.
#
# test/pr-review-workflow.test.ts pins every property above. Change the two together.
on:
  workflow_run:
    workflows: [test]
    types: [completed]

permissions: {}

concurrency:
  group: "pr-review-${{ github.event.workflow_run.pull_requests[0].number || github.run_id }}"
  cancel-in-progress: true

jobs:
  review:
    name: review (model, no App key)
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      (github.event.workflow_run.conclusion == 'success' || github.event.workflow_run.conclusion == 'failure') &&
      github.event.workflow_run.head_repository.full_name == github.repository &&
      github.event.workflow_run.pull_requests[0].number != null
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    environment: pr-review-model
    permissions:
      contents: read
      pull-requests: read
      issues: read
      checks: read
    env:
      # The platform package's own tarball, checked against this SHA-512 (the registry's
      # dist.integrity in hex). Change both values together.
      CLAUDE_CLI_VERSION: "2.1.291"
      CLAUDE_CLI_SHA512: "8b4609c5d87cc886d143dc7582c6c1db8a155a1b3b04044d4481e84635f0d02783e18a792685694256df3c803d460dd4864707e9ddd2b58005ad2b779769b91c"
    steps:
      - name: Check out the default branch, tool code only
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Set up bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: "1.3.14"

      - name: Install the pinned claude CLI
        run: |
          set -euo pipefail
          dir="$RUNNER_TEMP/claude-cli"
          mkdir -p "$dir"
          curl -fsSL --proto '=https' -o "$dir/cli.tgz" "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_CLI_VERSION}.tgz"
          echo "${CLAUDE_CLI_SHA512}  $dir/cli.tgz" | sha512sum -c -
          tar -xzf "$dir/cli.tgz" -C "$dir"
          chmod 0755 "$dir/package/claude"
          test "$("$dir/package/claude" --version)" = "${CLAUDE_CLI_VERSION} (Claude Code)"
          echo "$dir/package" >> "$GITHUB_PATH"

      - name: Prepare an empty working directory
        run: mkdir -p "$RUNNER_TEMP/pr-review-cwd" "$RUNNER_TEMP/pr-review-out"

      - name: Review (model only)
        working-directory: ${{ runner.temp }}/pr-review-cwd
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          DISABLE_AUTOUPDATER: "1"
          GH_READ_TOKEN: ${{ github.token }}
          PR_REVIEW_IDENTITY: ${{ secrets.PR_REVIEW_IDENTITY }}
          PR_REVIEW_ACCOUNT_EMAIL: ${{ secrets.PR_REVIEW_ACCOUNT_EMAIL }}
          PR_NUMBER: ${{ github.event.workflow_run.pull_requests[0].number }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
        run: printf '%s' "$GH_READ_TOKEN" | env -u GH_READ_TOKEN bun "$GITHUB_WORKSPACE/tools/pr-review/ci.ts" review --repo "$GITHUB_REPOSITORY" --pr "$PR_NUMBER" --expect-head "$HEAD_SHA" --token-stdin --out "$RUNNER_TEMP/pr-review-out/model-run.json"

      - name: Upload the model run
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: pr-review-model-run
          path: ${{ runner.temp }}/pr-review-out/model-run.json
          if-no-files-found: error
          retention-days: 1

  post:
    name: post (App key, no model)
    needs: review
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    environment: pr-review
    permissions:
      contents: read
    steps:
      - name: Check out the default branch, tool code only
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Set up bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: "1.3.14"

      - name: Download the model run
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: pr-review-model-run
          path: ${{ runner.temp }}/pr-review-in

      - name: Prepare an empty working directory
        run: mkdir -p "$RUNNER_TEMP/pr-review-cwd"

      # --comment-only until #146's rollout (plan Task 8) passes. Plan Task 9 removes it.
      - name: Post the review, App key on stdin only
        working-directory: ${{ runner.temp }}/pr-review-cwd
        env:
          PR_REVIEW_APP_KEY: ${{ secrets.PR_REVIEW_APP_KEY }}
          PR_REVIEW_APP_ID: ${{ vars.PR_REVIEW_APP_ID }}
          PR_REVIEW_IDENTITY: ${{ secrets.PR_REVIEW_IDENTITY }}
          PR_REVIEW_ACCOUNT_EMAIL: ${{ secrets.PR_REVIEW_ACCOUNT_EMAIL }}
          PR_NUMBER: ${{ github.event.workflow_run.pull_requests[0].number }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
        run: printf '%s' "$PR_REVIEW_APP_KEY" | env -u PR_REVIEW_APP_KEY bun "$GITHUB_WORKSPACE/tools/pr-review/ci.ts" post --repo "$GITHUB_REPOSITORY" --pr "$PR_NUMBER" --expect-head "$HEAD_SHA" --app-id "$PR_REVIEW_APP_ID" --key-stdin --artifact "$RUNNER_TEMP/pr-review-in/model-run.json" --comment-only
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `bun test test/pr-review-workflow.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 6: Ablate two properties**

One at a time, each restored before the next:
- Add `ref: ${{ github.event.workflow_run.head_sha }}` under the review job's checkout `with:`. Expected: FAIL on "every checkout keeps no credential and names no ref".
- Change the post step's `env -u PR_REVIEW_APP_KEY bun` to `bun`. Expected: FAIL on "the App key appears in one step of the post job".

Re-run after restoring: PASS.

- [ ] **Step 7: Run the whole suite and commit**

Run: `bun test`
Expected: 0 fail. `test/pr-review-verdict.test.ts` and `verdict.ts` are untouched: `WORKFLOW_PATH` stays `.github/workflows/test.yml`, which is the only file whose `run:` lines decide Pester coverage.

```bash
git add .github/workflows/pr-review.yml test/pr-review-workflow.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "ci(pr-review): run the reviewer on workflow_run with split model and key jobs (#146)" -m "workflow_run executes master's copy of this file and checks out master, and both environments admit master only, so no job a pull request starts reaches the App key or the model token. The claude CLI comes from the npm platform package checked by SHA-512 with no install script. Posting starts as COMMENT-only for the rollout. Rejected: pull_request_target, and a pull_request trigger with a base-SHA checkout, which still runs the pull request's copy of the workflow file."
```

---

### Task 7: Documentation

Not security-bearing.

**Files:**
- Modify: `tools/pr-review/README.md` (line 5, and a new section before "## What each event means")
- Modify: `README.md` (the `tools/pr-review/` row, the `.github/workflows/` row, the paragraph opening "CI is one workflow,", the paragraph opening "`master` takes changes by pull request")
- Modify: `test/readme-claims.test.ts` (the paragraph anchor, line 16 comment and line 203)
- Modify: `CONTRIBUTING.md` (line 29)
- Modify: `docs/superpowers/plans/2026-09-11-pr-review-app.md` (after line 71)

Each replacement below is exact: find the first text, replace it with the second.

- [ ] **Step 1: `tools/pr-review/README.md`, line 5**

Find:

```text
This repository's own pull request reviewer, run by hand from an operator's machine. It is not part of core:
```

Replace with:

```text
This repository's own pull request reviewer. It runs in GitHub Actions once a pull request's CI completes (see "In GitHub Actions" below), and by hand from an operator's machine. It is not part of core:
```

- [ ] **Step 2: `tools/pr-review/README.md`, new section**

Insert directly before the line `## What each event means`:

```text
## In GitHub Actions

`.github/workflows/pr-review.yml` runs the reviewer when the `test` workflow completes with success or failure on a pull request from a branch of this repository. It runs `master`'s copy of the workflow and of this tool, never the pull request's, as two jobs. The design and its threat model are in `docs/superpowers/specs/2026-10-05-pr-review-ci-design.md`.

- `review`, in environment `pr-review-model`, reads the pull request with the job's read-only `GITHUB_TOKEN`, runs the model, scans every string of the result for identifying strings, and uploads the result as the artifact `pr-review-model-run`. It never holds the App key.
- `post`, in environment `pr-review`, holds the App key and never runs the model. It takes its own snapshot with the App's token, checks that the artifact names the same repository, pull request, head, base and tool revision, and then runs the pipeline a local `review --post` runs, with the artifact standing in for the model.

Both jobs run `tools/pr-review/ci.ts`, which refuses outside GitHub Actions. A workstation uses `cli.ts`.

Two things differ from a local run. The App key reaches the tool on stdin from a step-scoped environment variable, `printf '%s' "$PR_REVIEW_APP_KEY" | env -u PR_REVIEW_APP_KEY bun ...`, because Actions offers no other route for a secret. `printf` is a shell builtin, so the key never appears in a process's arguments, and `env -u` keeps it out of the Bun process's environment. And the identity scan reads two environment secrets in place of `~/.claude-account-identity.json`: `PR_REVIEW_IDENTITY`, the identity file's JSON with both lists non-empty, and `PR_REVIEW_ACCOUNT_EMAIL`, the address of the account behind `CLAUDE_CODE_OAUTH_TOKEN`. Either one missing refuses. The runner's own username and hostname are not scanned, because they name no one and the username `runner` would match `runner.ts`, so the declared names include the workstation username and hostname.

`pr-review-model` holds the secrets `CLAUDE_CODE_OAUTH_TOKEN`, `PR_REVIEW_IDENTITY` and `PR_REVIEW_ACCOUNT_EMAIL`. `pr-review` holds the secrets `PR_REVIEW_APP_KEY`, `PR_REVIEW_IDENTITY` and `PR_REVIEW_ACCOUNT_EMAIL`, and the variable `PR_REVIEW_APP_ID`. Both allow deployments from `master` only, which is what keeps a pull request that edits a workflow file away from them.

The review job's `claude` is the `@anthropic-ai/claude-code-linux-x64` package at the version the workflow pins, checked against the SHA-512 written beside it. Change both values together.

A failed `review` job posts nothing, so the merge stays blocked. Re-run the workflow from the Actions tab, or run `cli.ts review --post` by hand. Until the rollout in #146 completes, the post step passes `--comment-only`.
```

- [ ] **Step 3: `README.md`, the `tools/pr-review/` row**

Find:

```text
This repository's own pull request reviewer, run by hand: a tool-less model reviews the diff,
```

Replace with:

```text
This repository's own pull request reviewer, run in GitHub Actions after CI and by hand: a tool-less model reviews the diff,
```

- [ ] **Step 4: `README.md`, the `.github/workflows/` row**

Find:

```text
| `.github/workflows/` | `test.yml`, the one workflow. `tools/pr-review/verdict.ts`'s `REQUIRED_CHECKS` names which of its jobs
```

Replace with:

```text
| `.github/workflows/` | `test.yml` runs the suites, and `pr-review.yml` runs the pull request reviewer once `test` completes (#146). `tools/pr-review/verdict.ts`'s `REQUIRED_CHECKS` names which of `test.yml`'s jobs
```

- [ ] **Step 5: `README.md`, the CI paragraph, and its anchor in `test/readme-claims.test.ts`**

In `README.md`, find:

```text
CI is one workflow, `.github/workflows/test.yml`. A Linux job runs `bun test`.
```

Replace with:

```text
CI is `.github/workflows/test.yml`, and the reviewer workflow below runs after it. A Linux job runs `bun test`.
```

In `test/readme-claims.test.ts`, make three edits. The comment on lines 15 and 16 quotes the old anchor split across the line break as `("CI is one` and `workflow,")`: change that quote to name the new anchor, `CI is` followed by the backticked path `.github/workflows/test.yml` and a comma. Line 202 becomes:

```ts
  test("the 'CI is .github/workflows/test.yml' paragraph names no count of test.yml's jobs or suites", () => {
```

Line 203 becomes (a double-quoted string, so the backticks inside need no escape):

```ts
    const paragraph = readParagraph(readReadmeLines(), "CI is `.github/workflows/test.yml`,").join("\n");
```

After the README edit alone, `bun test test/readme-claims.test.ts` fails naming the missing anchor `CI is one workflow,`. After both edits it passes.

- [ ] **Step 6: `README.md`, the merging paragraph**

Find:

```text
its own. A push after approval dismisses it, and the `tools/pr-review/` reviewer runs by hand
rather than on a trigger, so a new push needs a fresh manual run before the PR can merge again.
```

Replace with:

```text
its own. A push after approval dismisses it, and `.github/workflows/pr-review.yml` reviews the
new head once that push's CI completes, so no manual run is needed unless the workflow fails.
```

- [ ] **Step 7: `CONTRIBUTING.md`, line 29**

Find:

```text
Merge through the App review. With an up-to-date `master` checkout,
```

Replace with:

```text
Merge through the App review, which `.github/workflows/pr-review.yml` posts once CI completes on each push (see `tools/pr-review/README.md`, "In GitHub Actions"). To run it by hand instead, with an up-to-date `master` checkout,
```

Then find:

```text
Any push dismisses that approval, so review again after pushing.
```

Replace with:

```text
Any push dismisses that approval, and the workflow reviews the new head once its CI completes.
```

- [ ] **Step 8: Supersession note in the 2026-09-11 plan**

In `docs/superpowers/plans/2026-09-11-pr-review-app.md`, insert after line 71 (the paragraph ending "hands that key to whoever edits the workflow in a pull request."), as its own paragraph:

```text
Superseded, 2026-10-05. The operator ruled for GitHub Actions on #146 on 2026-09-20, and `docs/superpowers/specs/2026-10-05-pr-review-ci-design.md` answers the objection above: the reviewer workflow runs on `workflow_run`, which executes the default branch's copy, and the environment holding the key admits `master` only.
```

- [ ] **Step 9: Run the whole suite and the prose lint**

Run: `bun test`
Expected: 0 fail, `test/readme-claims.test.ts` included.

Run the prose linter on each changed `.md` file through the `/prose-lint` skill, and fix real findings. Code identifiers and quoted strings it flags are false positives and stay.

- [ ] **Step 10: Commit**

```bash
git add tools/pr-review/README.md README.md CONTRIBUTING.md test/readme-claims.test.ts docs/superpowers/plans/2026-09-11-pr-review-app.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "docs(pr-review): document the Actions reviewer and retire run-by-hand-only claims (#146)" -m "README.md, CONTRIBUTING.md and the tool README said the reviewer runs only by hand and that CI is one workflow, both false once pr-review.yml lands. The readme-claims anchor moves with the paragraph it guards. The 2026-09-11 plan's D1 gets a supersession note rather than an edit, so the original reasoning stays readable."
```

---

### Task 8: Merge, then three live reviews in comment-only mode

Security-bearing. Operator-assisted: the operator sets secrets and merges.

- [ ] **Step 1: Operator sets the secrets**

The operator adds, in the repository's environment settings (never through an agent, and never echoed):
- `pr-review-model`: `CLAUDE_CODE_OAUTH_TOKEN`, `PR_REVIEW_IDENTITY`, `PR_REVIEW_ACCOUNT_EMAIL`.
- `pr-review`: `PR_REVIEW_IDENTITY`, `PR_REVIEW_ACCOUNT_EMAIL` (beside the existing `PR_REVIEW_APP_KEY` and variable `PR_REVIEW_APP_ID`).

`PR_REVIEW_IDENTITY` is one line of JSON, `{"names":[...],"emails":[...]}`, whose names include the operator's name, workstation username and hostname. `PR_REVIEW_ACCOUNT_EMAIL` is the address Task 1 confirmed.

Verify names only (PowerShell):

```powershell
$env:GH_TOKEN = (gh auth token -u Cringely)
foreach ($e in 'pr-review', 'pr-review-model') { "== $e"; gh api "repos/Cringely/agent-harness-core/environments/$e/secrets" --jq '.secrets[].name' }
Remove-Item Env:GH_TOKEN
```

Expected: `pr-review` lists `PR_REVIEW_ACCOUNT_EMAIL`, `PR_REVIEW_APP_KEY`, `PR_REVIEW_IDENTITY`. `pr-review-model` lists `CLAUDE_CODE_OAUTH_TOKEN`, `PR_REVIEW_ACCOUNT_EMAIL`, `PR_REVIEW_IDENTITY`. Anything missing: stop.

- [ ] **Step 2: Push the branch and open the pull request**

```bash
TOK=$(gh auth token -u Cringely) && export TOK && git -c credential.helper= -c 'credential.helper=!f() { echo username=Cringely; echo "password=$TOK"; }; f' push origin HEAD:feat/146-ci-reviewer; unset TOK
```

The pull request body carries the `Docs:` line `CONTRIBUTING.md` requires, such as `Docs: README updated: the tools/pr-review/ and .github/workflows/ rows, the CI paragraph and the merging paragraph now describe pr-review.yml`, and names Task 1's results. The App review on this pull request is `COMMENT` at most, because it edits `.github/workflows/`.

- [ ] **Step 3: Operator merges**

The operator merges with the administrator bypass, the documented case for a change to CI definitions (`CONTRIBUTING.md`, "Change process"). No agent runs this merge.

- [ ] **Step 4: Watch the first triggered run**

On the next pull request whose `test` run completes (any real pull request), read the reviewer run:

```bash
GH_TOKEN=$(gh auth token -u Cringely) gh run list -R Cringely/agent-harness-core --workflow pr-review.yml --limit 3 --json databaseId,event,conclusion,headSha
GH_TOKEN=$(gh auth token -u Cringely) gh run view <databaseId> -R Cringely/agent-harness-core --json jobs --jq '.jobs[] | {name, conclusion}'
```

PASS for the run: both jobs `success`. Then read the posted review:

```bash
GH_TOKEN=$(gh auth token -u Cringely) gh api repos/Cringely/agent-harness-core/pulls/<n>/reviews --jq '.[-1] | {user: .user.login, state, commit_id}'
```

PASS: the App's login, `state` `COMMENTED`, `commit_id` equal to the pull request's head. The body's footer names a tool revision equal to `master` at the time the run started.

A 403 on the download step: add `actions: read` to the post job's permissions (spec, open question 5) in a follow-up commit on a new branch, and re-run.

- [ ] **Step 5: Scan the run's public output**

Download the logs and the artifact into a scratch directory outside every checkout, then scan them with the workstation's identity declaration. The scan prints class labels only. Run in Git Bash:

```bash
S=$(mktemp -d)
GH_TOKEN=$(gh auth token -u Cringely) gh run view <databaseId> -R Cringely/agent-harness-core --log > "$S/run.log"
GH_TOKEN=$(gh auth token -u Cringely) gh run download <databaseId> -R Cringely/agent-harness-core -n pr-review-model-run -D "$S/artifact"
cd "$S" && bun -e '
const { loadIdentity, findIdentityHits } = await import(process.argv[1] + "/tools/pr-review/identity.ts");
const { readFileSync } = await import("node:fs");
const id = loadIdentity();
if (!id.ok) { console.log("identity did not load"); process.exit(2); }
for (const f of ["run.log", "artifact/model-run.json"]) console.log(f, JSON.stringify(findIdentityHits(readFileSync(f, "utf8"), id.decl)));
' "<absolute path of a clean master checkout>"
rm -rf "$S"
```

PASS: both lines print `[]`. Any label: stop, report the label only, and the operator decides whether to delete the run's logs.

Note the workstation username can legitimately appear in neither file, and the runner's own paths (`/home/runner/...`) will hit the label `workstation username` only if the workstation username is literally `runner`.

- [ ] **Step 6: Repeat for three consecutive pull requests**

Steps 4 and 5 pass on three consecutive pull requests. Record each run id, review id, state and scan result in the task report. A failure on any one restarts the count after its cause is fixed.

---

### Task 9: Lift comment-only

Security-bearing. Starts only after Task 8 Step 6 passes.

**Files:**
- Modify: `.github/workflows/pr-review.yml` (the post step's `run:` line and the comment above it)
- Modify: `test/pr-review-workflow.test.ts` (the rollout test)

- [ ] **Step 1: Flip the test first**

Branch from `origin/master`: `git fetch origin master && git switch -c feat/146-lift-comment-only origin/master`.

In `test/pr-review-workflow.test.ts`, replace the rollout test with:

```ts
  test("rollout complete: the post step posts the computed event", () => {
    expect(ciSteps().find((step) => post.steps.includes(step))!.run).not.toContain("--comment-only");
  });
```

Run: `bun test test/pr-review-workflow.test.ts`
Expected: FAIL on that test.

- [ ] **Step 2: Edit the workflow**

In `.github/workflows/pr-review.yml`, delete the comment line `# --comment-only until #146's rollout (plan Task 8) passes. Plan Task 9 removes it.` and remove ` --comment-only` from the end of the post step's `run:` line.

In `tools/pr-review/README.md`, delete the last sentence of the "In GitHub Actions" section, the one beginning "Until the rollout in #146 completes".

Run: `bun test`
Expected: 0 fail.

- [ ] **Step 3: Commit, push, and hand to the operator**

```bash
git add .github/workflows/pr-review.yml test/pr-review-workflow.test.ts tools/pr-review/README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "ci(pr-review): post the computed event from Actions (#146)" -m "Three consecutive comment-only runs passed the live checks in plan Task 8, so the reviewer workflow now posts APPROVE or REQUEST_CHANGES as computed. Rejected: keeping comment-only longer, which leaves every merge on the administrator bypass."
TOK=$(gh auth token -u Cringely) && export TOK && git -c credential.helper= -c 'credential.helper=!f() { echo username=Cringely; echo "password=$TOK"; }; f' push -u origin HEAD:feat/146-lift-comment-only; unset TOK
```

The operator opens and merges it with the administrator bypass (it edits `.github/workflows/`). On the next pull request with clean findings and passing checks, the App's review state is `APPROVED`. That is the live signal this plan's goal holds.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Design direction 1, environment gate | 1 (P5), 6 (environments) |
| Design direction 2, `workflow_run` and default-branch checkout | 6 |
| Design direction 3, review job, read token, pre-upload scan | 4, 5, 6 |
| Design direction 4, post job, own snapshot, binding | 3, 5, 6 |
| Design direction 5, fork refusal before the model | 6 (`if:`), 4 (snapshot before runner, existing `github.ts` refusal) |
| Design direction 6, concurrency, CI on head | 6 |
| Design direction 7, key on stdin with `env -u` | 5, 6 |
| Blocker 1, CI identity | 2 |
| Blocker 2, email injection | 1 (P3, P4) |
| Blockers 3 and 4, cwd and dirty checkout | 5, 6 |
| Blocker 5, CLI pin | 1 (P1), 6 |
| Blocker 6, pinning and permissions | 6 |
| Blocker 7, cannot-vouch | unchanged code, 8 (Step 2), 9 |
| Rollout | 8, 9 |
| Docs | 7 |
| Phase 2 | not built, by scope |
