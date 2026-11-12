# Harness Layering Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build what the layered harness stands on. That means a write-scope gate with no scratch-parent hole, a worktree gate that checks its own preconditions, the kernel rule additions, a versioned manifest that records layers and settings, an installer that copies layer rules into projects, the move of the code-repo rules out of the account layer, and a model currency check.

**Architecture:** Layer rules live as files in `core/claude/rules/`, and `core/claude/rules/layers.json` says which layer each file belongs to and what each project setting means. `Install-Harness.ps1` reads the layers and settings recorded in the project's committed manifest (schema version 3), copies the matching rules into `.claude/rules/harness/`, and renders the settings into a generated rule file beside them. The account layer keeps the kernel, which after this plan still holds most of today's rules. Only the code-repo halves of `change-management.md` and `fix-quality.md` move, and only after a live check shows isolated agents can see the project copy.

**Tech Stack:** Bun and TypeScript for hooks and tools (`bun test`), PowerShell 7 with Pester 5 for the installers, POSIX sh and bash for shell hooks.

**Spec:** `docs/superpowers/specs/2026-11-11-harness-layering-design.md` (tracking issue #310). Task 4 restates every model-audit finding it acts on.

## Global Constraints

- Public repository. Nothing identifying the operator reaches it. Rule text copied into `core/` or `test/fixtures/` comes from the exported, redacted `account/claude/` tree at a commit, never from `~/.claude` directly.
- Commits use `git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit ...`, with no attribution trailer or session link. A commit message never mentions reviews or findings.
- Every isolated write dispatch carries a `BASE-SHA: <sha>` line. The agent compares it with its worktree HEAD before touching a file and aborts on a mismatch. Worktree agents commit only, and the coordinator pushes.
- Tests: `bun test` from the repo root. Pester as `pwsh -NoProfile -File install/<name>.Tests.ps1`, never bare `Invoke-Pester` (it exits 0 on failure).
- PowerShell: wrap any output you index, count or iterate in `@()`. Filter a possibly-null source with `Where-Object { $_ }` before wrapping. Join multi-line native output with `-join "`n"` before a substring check. Test presence with `.Contains(key)`, never truthiness, wherever an empty value means something.
- Every matcher that reads a repo file is CRLF-agnostic: split on `/\r?\n/` in TypeScript, use `\r?$` in regexes, and normalise `"\r\n"` to `"\n"` on both sides before comparing text in PowerShell.
- Timestamps are UTC at the point of formatting (`Get-Date -AsUTC`, `toISOString()`).
- A new executable artifact carries its registration (hook entry, installer copy path, or documented invocation) in the same commit.
- A gate's test pins its refusal and its allow.
- `account/claude/` is generated. Source edits happen under `~/.claude` on the operator's machine, then `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff account/claude` is reviewed and only the paths belonging to the change are staged. Task 9 is the one exception and says how it reconciles.
- Layer names are exactly `code`, `documents`, `physical`. The kernel is implied and never listed. The CLI value `none` means an empty layer list.
- Manifest `schemaVersion` is `3`.
- A probe that cannot answer fails closed: the gate behaves as it does today.
- One PR per task group. The App reviewer is the merge gate. Every PR body carries a `Docs: README ...` verdict line. README and rule-file prose follows `writing-style.md` (the Vale hook lints on write).
- Redirect `git show` output to a file from Git Bash, never from PowerShell, which re-encodes it.

## Review Focus

1. A project checked out under a scratch-named ancestor whose spelling differs in case from the path being written (`C:\Scratch\repo` against `c:\scratch\repo\src\a.ts`): the write must still be denied. Test in Task 1.
2. A git project whose session has moved its cwd into a non-git folder (an added directory): the worktree gate must still deny an unisolated writer, because the project root is a repository. Test in Task 2.
3. A hand-edited manifest whose `layers` is a string, names `kernel`, or names an unknown layer: the installer must throw before writing anything, and `-Audit -Quiet` must report it rather than go silent. Test in Task 8.
4. A project that chose `-Layers none` and is then re-run with no flags: the empty list must stay empty and no code rule may be installed. Test in Task 8.
5. The model check run with no API key and no `--latest` file: it must exit 2 and never report a pin or alias as current. Test in Task 3.

## Rule inventory

Source: `account/claude/rules/` at `898ef59`, plus the account agents, skills and hooks.

| File | Goes to | Reason |
|---|---|---|
| `rules/agent-usage.md` | kernel | Model-tier routing is its core (spec kernel item 8), and both field reports dispatched agents on non-code projects |
| `rules/challenge-mandate.md` | kernel | Spec kernel item 7. Gains the scope-accumulation sentence (Task 5) |
| `rules/change-management.md` | split. Code layer gets "Decision Documentation" and "Session Close Protocol" as `core/claude/rules/change-management-code.md`. Every other section stays in the kernel file of the same name | The confirmation list, backups, non-destructive practice, script and secret hygiene, commit identity, decision notes and invariant promotion apply wherever destructive or credentialed work runs, including SSH sessions from folders with no manifest. Commit-message rationale and the commit-and-push close are code-repo process |
| `rules/coordinator-output.md` | kernel, minus "say nothing mid-run", which becomes the `statusCadence: silent` setting text (Task 12) | The stop-and-ask exception, decision restating, Needs-you shape and close format apply on every project type. #308's repeated status requests are what they answer |
| `rules/fix-quality.md` | split. "Work has to be able to end" becomes kernel file `rules/bounded-review.md`. The rest moves to `core/claude/rules/fix-quality.md` | Producer fixes, complexity receipts and cache inputs are code-fix discipline. Bounded review is kernel item 6 |
| `rules/harness-core.md` | kernel | Carries the export flow and the install nudge, which every folder needs |
| `rules/no-overclaim.md` | kernel | Kernel item 3. Gains the absence rules (Task 5) |
| `rules/obsidian.md`, `rules/ssh.md` | kernel (account infrastructure) | Per person and per workstation, not per project type |
| `rules/security.md` | kernel | Kernel items 1 and 2. The anti-goals forbid weakening it |
| `rules/subagent-prompting.md` | kernel | Brief failures recur on every project type that dispatches agents |
| `rules/writing-style.md` | kernel | Nearly all of it binds every surface. `audience: plain-all-roles` overrides its peer-engineer principle and its Scannable Structure section through `project-settings.md` |
| new `rules/decision-log.md` | kernel | Kernel item 5 (Task 5) |
| `rules/*.local.md` (never exported) | stay in `~/.claude/rules` | Machine overlays |
| `agents/*.md` (8 defs) | stay in account | A def costs nothing until dispatched. The four domain defs are barred from core by `CONTRIBUTING.md` |
| `skills/*` | stay in account | A skill loads only on its trigger |
| `hooks/harness-core-reminder.sh` | kernel | Becomes the one-time nudge (Task 9) |
| `hooks/Scan-MemorySecrets.ps1` | kernel | Leak protection |
| `hooks/Lint-DocumentProse.ps1`, `Guard-SkillSize.ps1`, `Sync-MemoryToObsidian.ps1`, `memory-proposal-digest.ts` | stay in account | Account infrastructure. Moving hooks between layers is outside Plan A |
| `model-tier-gate.ts` (sourced from core) | kernel | Already wired in both the account settings and the project template. No change |

Agents and hooks installed by `Install-Harness.ps1` stay ungated by layer in Plan A. The self-checks in Tasks 1 and 2 are what make them safe on a project that is not code.

## Interfaces for Plans B and C

- `pwsh install/Install-Harness.ps1 -Target <dir> [-Layers code,documents,physical|none] [-StatusCadence silent|heartbeat] [-Audience peer-engineer|plain-all-roles] [-LengthBudget <int>]`. `-Layers` accepts a comma list in one argument from any shell. Re-runnable. `-LengthBudget 0` clears the budget. Prints one line `Layers: <list>. Settings: statusCadence=<v>, audience=<v>, lengthBudgetDefault=<n|none>.`
- Manifest `.claude/.harness-manifest.json` fields `schemaVersion` (3), `layers` (string array), `settings` (`statusCadence`, `audience`, `lengthBudgetDefault`). The interview reads these as its recommended answers.
- `core/claude/rules/layers.json`: `rules` maps file name to layer list, and `settings` holds each setting's values and rule text. Plan C adds documents and physical rule files here. Plan B reads the settings values for its questions, and adds a decision-log template if one is wanted.
- `account/claude/hooks/harness-core-reminder.sh` nudge text. Plan B replaces the installer command in it with the interview skill's name.
- `core/claude/deps.json` and `-InstallDeps` (Task 15). Plan C adds the documents and physical dependencies. Plan B's interview can offer `-InstallDeps` when the preflight reports something missing.

## Task groups

| Group | Branch | Tasks | Who |
|---|---|---|---|
| A1 gates | `feat/310-gates` | 1, 2 | agents |
| A2 model currency and kernel rules | `feat/310-kernel` | 3, 4, 5 | agent, then coordinator |
| A3 layers | `feat/310-layers` | 6, 7, 8, 15, 9, 10 (Task 15 runs after Task 8) | coordinator preflight, then agents |
| A4 cutover | `feat/310-cutover` | 11, 12, 13 | coordinator on the operator's machine, then an agent |
| A5 session close | `feat/310-session-close` | 14 | agent |

A1, A2 and A3 are independent. A4 starts after A1 and A3 merge. Task 11's live check then picks one of two A4 paths:
- **Cutover** (check passes): Task 12 Steps 1-5, then Task 13.
- **Fallback** (check fails): Task 12 Step 1 and its commit (Step 5F) only. Task 13 does not run. The code halves stay in the account layer beside the project copies, so nothing names `bounded-review.md` or retires `fix-quality.md`.

A5 starts after A4 merges on either path.

A1, A2 and A3 run in parallel but are not file-independent. A1 (Task 1) and A3 (Tasks 8, 15) edit the opening lines of `install/Install-Harness.Tests.ps1`. A2 (Task 3) and A3 (Task 7) add rows to the README "What's here" table. Merge A1 first, then A2, then A3. Each later PR rebases on `origin/master` and re-runs both suites before review.

---

### Task 1: Close the scratch-parent gap and share one writeScope parser

**Files:**
- Create: `core/claude/hooks/write-scope-parse.ts`
- Modify: `core/claude/hooks/agent-write-scope.ts` (header paragraph "Second coverage boundary", `inScratch`, `readWriteScope`, `decide`, the `import.meta.main` block)
- Test: `test/agent-write-scope.test.ts`, `install/Install-Harness.Tests.ps1` (one assertion)

**Interfaces:**
- Consumes: nothing.
- Produces: `export type WriteScopeParser = (text: string) => string | null` and `export function parseWriteScope(text: string): string | null` in `core/claude/hooks/write-scope-parse.ts`, a new file beside the hooks. It sits flat in the hooks directory, like `agent-name.ts`, because the installer copies that directory file by file and not recursively. A new file is installed fresh, never skipped as project-modified. Also produces `export const WRITE_SCOPE_GATE_VERSION = 2` in `agent-write-scope.ts`, `inScratch(filePath: string, cwd: string, projectDir: string): boolean` and `decide(scope: string | null, filePath: string | undefined, cwd: string, projectDir: string): Decision`. Inside the project root only `<project>/.claude/scratch` counts as scratch. Outside it, a scratch-named directory counts only when it does not contain the project root.

- [ ] **Step 1: Write the failing tests.** Add a describe block "inScratch(): a scratch-named ancestor of the project is not scratch", and update every existing `inScratch`/`decide` call to pass `CWD` as `projectDir`.

```ts
const PROJ = "/home/x/scratch/myrepo";
expect(inScratch(`${PROJ}/src/index.ts`, PROJ, PROJ)).toBe(false);
expect(inScratch("/home/x/scratch/other/f.md", PROJ, PROJ)).toBe(false);
expect(inScratch(`${PROJ}/.claude/scratch/r.md`, PROJ, PROJ)).toBe(true);
expect(inScratch(`${PROJ}/scratchpad/r.md`, PROJ, PROJ)).toBe(false);
expect(inScratch("/tmp/claude/s/scratchpad/r.md", PROJ, PROJ)).toBe(true);
expect(inScratch("/home/x/scratch/myrepo/src/a.ts", "/home/x/Scratch/myrepo", "/home/x/Scratch/myrepo")).toBe(false);
expect(decide("scratch", `${PROJ}/src/index.ts`, PROJ, PROJ).action).toBe("deny");
```

`parseWriteScope` cases: `"---\nwriteScope: scratch\n---\n"` gives `"scratch"`. CRLF frontmatter gives the same. A `writeScope:` line in the body after the closing `---` gives `null`. Two keys, `writeScope: repo` then `writeScope: scratch`, give `"repo"`. Frontmatter longer than 4,096 characters with the key at the end gives `"scratch"`. No frontmatter gives `null`. `readWriteScope` on a def file with the duplicate keys returns `"repo"`.

A NotebookEdit call: the entrypoint reads `tool_input.file_path ?? tool_input.notebook_path`. A spawned case with a scoped agent and `notebook_path` outside scratch is denied.

In `install/Install-Harness.Tests.ps1`'s first case, add `Test-Path "$script:target/.claude/hooks/write-scope-parse.ts" | Should -BeTrue`, so the module provably ships.

Spawned case for the ancestor: build `<tmp>/scratch/proj/.claude/agents/scoped.md` with `writeScope: scratch`, run the hook with `CLAUDE_PROJECT_DIR=<tmp>/scratch/proj`, `agent_type: "scoped"`, `file_path: <tmp>/scratch/proj/src/x.ts`. Expected: exit 0 and a deny JSON on stdout.

- [ ] **Step 2: Run to verify they fail.** `bun test test/agent-write-scope.test.ts`. Expected: the new cases FAIL.

- [ ] **Step 3: Implement.**
  - `parseWriteScope` in `write-scope-parse.ts` reads only the frontmatter between a leading `---` line and the next `---` line, split on `/\r?\n/`, and returns the value of the first `writeScope:` key. `agent-write-scope.ts` imports it, and `readWriteScope` reads the whole file and calls it.
  - `inScratch` first resolves the file path and `projectDir` with `realpathSync.native` (the deepest existing ancestor plus the tail that does not exist yet). A failure to resolve and a dangling link give "not scratch". It then splits both resolved paths into segments on the host's separators: `/[\\/]+/` on Windows and `/\/+/` elsewhere, since a backslash is an ordinary file-name character on POSIX. A trailing empty segment is dropped, so a project at a filesystem root (`/` or `C:\`) still contains its files. If the resolved file is inside the resolved project root, only `<project>/.claude/scratch` counts, and the spelling used must reach it through the project's own path, resolved or as given, so a link, junction or short name that reaches a project file by another route is denied. This spelling check applies only inside the project. Otherwise the resolved path decides, so a scratchpad under a linked temp directory still counts, and a segment at index `i` whose lowercased name is in `SCRATCH_SEGMENTS` counts only when the project's segments do not start with the file's segments `0..i`. Compare lowercased on every platform, since case-insensitive containment can only add denies. Tests that need links, an 8.3 short name or a dangling link build real temporary directories.
  - The entrypoint passes `process.env.CLAUDE_PROJECT_DIR ?? cwd` as `projectDir`, and reads the target path as `tool_input.file_path ?? tool_input.notebook_path`. Extend the test file's spawned `runHook` helper to take an env, for the `CLAUDE_PROJECT_DIR` cases.
  - Export `WRITE_SCOPE_GATE_VERSION = 2` from `agent-write-scope.ts`, with a comment: it marks the scratch-parent fix and the shared parser. Bump it whenever a change to this gate alters what `writeScope: scratch` confines.
  - Header: replace "Second coverage boundary" with three facts. A scratch-named directory counts only when it does not contain the project root. A project whose root sits inside a scratch directory gets denies for scoped writes outside a deeper scratch folder, the fail-closed direction. Inside the project root only `<project>/.claude/scratch` is scratch, so a tracked subfolder named `scratch`, `scratchpad` or `.scratch` is not. Rewrite the next paragraph, "And it is reachable from the payload ... unchanged from master", which goes stale with the same change.

- [ ] **Step 4: Run to verify they pass.** `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add core/claude/hooks/write-scope-parse.ts core/claude/hooks/agent-write-scope.ts test/agent-write-scope.test.ts install/Install-Harness.Tests.ps1
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "fix(write-scope): a scratch-named ancestor no longer puts the project in scope (#310)"
```

---

### Task 2: Worktree gate allows with a note outside git

**Files:**
- Modify: `core/claude/hooks/agent-worktree-gate.ts` (header including the "reads no git state" line near 79, `frontmatterRequiresIsolation`, `GateDecision`, `decide`, entrypoint)
- Test: `test/agent-worktree-gate.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1. Task 2 lands after Task 1 in the same PR.
- Produces: `export type GitProbe = "repo" | "not-repo" | "unknown"`, `export function probeGitWorkTree(dir: string, env?: Record<string, string | undefined>): GitProbe`, `export function nonGitNote(projectRoot: string): string`, `export function projectRootOf(env: Record<string, string | undefined>): string` (the `CLAUDE_PROJECT_DIR` value, else `join(import.meta.dir, "..", "..")`), `GateDecision = { action: "allow"; note?: string } | { action: "deny"; reason: string }`, and `decide(payload: unknown, agentsDir?: string, projectRoot?: string | null, probe?: (dir: string) => GitProbe): GateDecision`. An omitted or `null` `projectRoot` means no root is known: the probe is never called. `requiresIsolation` keeps its signature. A `writeScope: scratch` agent is classified like any other write-capable type, and trusting it is tracked in #312.

- [ ] **Step 1: Write the failing tests.**

Probe (real temp dirs):
- `probeGitWorkTree` on a dir holding a `.git` directory is `"repo"`, and so is a subfolder of it.
- A dir holding a `.git` file (the linked-worktree shape) is `"repo"`.
- A junction or symlink into a repo is `"repo"`, and a dangling link is `"unknown"`.
- A path that does not exist, or is a file, is `"unknown"`.
- Any dir with `env = { GIT_DIR: "/x" }` is `"repo"`.
- A fresh `mkdtempSync(tmpdir())` is `"not-repo"`, skipped with `test.skipIf` when a `.git` exists in any ancestor of `tmpdir()`.

Decide (stub probe, write-capable type `writer`, no isolation, no override):
- Project root `"/p"` probed `"not-repo"`, payload with no `cwd`: `{ action: "allow", note: nonGitNote("/p") }`. The note contains `is not a git repository` and `git init`.
- Root `"not-repo"`, payload `cwd` probed `"repo"`: deny. Review Focus 2's inverse: root `"repo"`, payload `cwd` probed `"not-repo"`: deny.
- Root probed `"unknown"`: deny. `projectRoot` `null`: deny, and the stub records zero calls.
- Read-only type `reader` with root `"not-repo"`: `{ action: "allow" }` with no `note`, stub not called.
- Root `"repo"` and an isolated write dispatch with no base sha: still denied.

Classification:
- A `writeScope: scratch` def granting `Write` requires isolation, and so does the same def dispatched in a git project.
- A def whose grant key is `Tools:` or `TOOLS:` (not `tools:`) requires isolation, as does a read-only list under such a key. The lowercase key keeps working, and a cased line before it does not hide it.
- `web-fetch` with no def file requires isolation, since no source documents a grant for it.

Spawned process: `CLAUDE_PROJECT_DIR` set to a git temp dir and payload `cwd` set to a non-git temp dir, `subagent_type: "general-purpose"`, no isolation: deny JSON. `CLAUDE_PROJECT_DIR` set to a non-git temp dir (same skip guard): exit 0, stdout JSON with `systemMessage` and `hookSpecificOutput.additionalContext` both equal to the note, and no `permissionDecision` key. With `GIT_DIR` in the environment the same root is a repo and the dispatch is denied.

- [ ] **Step 2: Run to verify they fail.** `bun test test/agent-worktree-gate.test.ts`. Expected: FAIL on the new exports and cases.

- [ ] **Step 3: Implement.**
  - `probeGitWorkTree` returns `"repo"` when `env.GIT_DIR` or `env.GIT_WORK_TREE` is non-empty. Otherwise it returns `"unknown"` if `dir` is not an existing directory, then walks upward from `realpathSync.native(dir)` so a link resolves to its target, and returns `"repo"` at the first `.git` entry (file or directory). It returns `"not-repo"` when `dirname(p) === p`, which is how the walk ends at `/` and at a Windows drive root. Any error other than absence returns `"unknown"`. No git binary is spawned.
  - `nonGitNote(root)` returns exactly: `` Worktree gate: ${root} is not a git repository, so worktree isolation is not available and this dispatch runs in the shared folder. A git repository in a subfolder of it is not isolated either. If this work should be versioned, run `git init` here and the gate will isolate concurrent writers. ``
  - In `decide`, after `requiresIsolation` returns true and before the isolation branch: allow with the note only when `projectRoot` is a non-empty string, `probe(projectRoot)` is `"not-repo"`, and either the payload has no string `cwd` or `probe(cwd)` is also `"not-repo"`. Any other answer falls through to today's logic.
  - `frontmatterRequiresIsolation` matches the `tools` key case-sensitively, as Claude Code does. `BUILTIN_READ_ONLY` stays `explore` and `plan`, and its comment cites the Claude Code subagent docs.
  - The entrypoint passes `projectRootOf(process.env)`. On an allow with a note it prints `{"systemMessage": note, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}}`. A plain allow prints nothing.
  - Header: replace "No network, no git" and "The gate reads no git state" with the probe's contract (filesystem only, no git spawned, the project root decides, unknown keeps today's behaviour). Add a short paragraph saying a `writeScope: scratch` agent is still write-capable and needs isolation, and that #312 tracks trusting it.

- [ ] **Step 4: Run to verify they pass.** `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add core/claude/hooks/agent-worktree-gate.ts test/agent-worktree-gate.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(worktree-gate): allow with a note outside git (#310)"
```

PR A1 body: `Docs: README still accurate: the hooks row names the gates without describing their decisions`. PR checklist: one live run in a non-git folder confirms the note reaches the session (`systemMessage` shown, and the model can repeat the `git init` offer). If Claude Code rejects `additionalContext` on PreToolUse, drop that key and keep `systemMessage`.

---

### Task 3: Model currency check

**Files:**
- Create: `tools/model-currency/check.ts`
- Test: `test/model-currency.test.ts`
- Modify: `README.md` ("What's here" table)

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `tools/model-currency/check.ts`:
  - `type Family = "fable" | "opus" | "sonnet" | "haiku"`
  - `interface ModelId { family: Family; major: number; minor: number; date: string | null; raw: string }`
  - `parseModelId(id: string): ModelId | null`
  - `compareModelIds(a: ModelId, b: ModelId): number` (major, then minor, dates ignored)
  - `latestByFamily(ids: string[]): Partial<Record<Family, string>>`
  - `interface Finding { file: string; line: number; value: string; kind: "pin" | "alias" }`
  - `scanText(file: string, text: string): Finding[]`
  - `interface LatestTable { source: "api" | "file" | "alias"; models: Partial<Record<Family, string>> }`
  - `interface Row { status: "current" | "behind" | "stale-alias" | "unknown"; file: string; line: number; value: string; latest: string | null }`
  - `classify(findings: Finding[], latest: LatestTable | null, resolved: Partial<Record<Family, string | null>>): Row[]`
  - `fetchLatestFromApi(apiKey: string | undefined, fetchImpl: typeof fetch): Promise<LatestTable | null>`
  - `type ClaudeRunner = (args: string[]) => { code: number; stdout: string }`
  - `resolveAlias(alias: Family, runClaude: ClaudeRunner): string | null`
  - `DEFAULT_EXCLUDES: string[]`
  - `interface RunDeps { env: Record<string, string | undefined>; fetchImpl: typeof fetch; runClaude: ClaudeRunner }`
  - `run(argv: string[], deps: RunDeps): Promise<{ exitCode: 0 | 1 | 2; output: string }>`
  - CLI: `bun tools/model-currency/check.ts [--root <dir-or-file>]... [--exclude <name>]... [--latest <file.json>] [--no-resolve]`

- [ ] **Step 1: Write the failing tests.** Lines holding test model IDs carry the marker `model-currency: ignore`.

```ts
expect(parseModelId("claude-opus-5-5")).toMatchObject({ family: "opus", major: 5, minor: 5, date: null });
expect(parseModelId("claude-sonnet-4-20250514")).toMatchObject({ family: "sonnet", major: 4, minor: 0, date: "20250514" });
expect(parseModelId("claude-sonnet-5")).toMatchObject({ family: "sonnet", major: 5, minor: 0 });
expect(parseModelId("claude-3-5-sonnet-20241022")).toMatchObject({ family: "sonnet", major: 3, minor: 5 });
expect(parseModelId("sonnet")).toBeNull();
expect(latestByFamily(["claude-opus-5", "claude-opus-5-5", "claude-haiku-5-5"])).toEqual({ opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" });
```

- `scanText` finds a pin in `--model claude-sonnet-5` with its 1-based line, and aliases in a frontmatter line `model: sonnet`, in JSON `"model": "opus"`, and in `--model haiku`. It returns nothing for prose "Opus 5" or for a line containing `model-currency: ignore`.
- `classify` with latest `{ source: "api", models: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } }`:
  - pin `claude-sonnet-5` is `behind`, and pin `claude-opus-5-5` is `current`
  - alias `sonnet` resolved to `claude-sonnet-5` is `stale-alias`
  - alias `opus` resolved to `null` is `unknown`
  - a `haiku` pin with no latest entry is `unknown`
- `classify` with source `alias`: every alias row is `unknown`, a pin below the alias-derived latest is `behind`, and a pin equal to it is `unknown`.
- `resolveAlias("sonnet", stub)` with stdout `{"modelUsage":{"claude-sonnet-5-5":{},"claude-haiku-5-5":{}}}` returns `claude-sonnet-5-5`. A non-zero code or unparsable stdout returns `null`.
- `fetchLatestFromApi(undefined, spy)` returns `null` and never calls `spy`. A stub returning `{"data":[{"id":"claude-opus-5"},{"id":"claude-opus-5-5"}]}` gives `{ source: "api", models: { opus: "claude-opus-5-5" } }`. A throwing fetch returns `null`.
- The walker skips every `DEFAULT_EXCLUDES` name (a temp root with `.claude/worktrees/x/a.md`, `projects/t.jsonl`, `docs/superpowers/p.md`, each holding a pin, reports none of them). An `--exclude extra` argument skips `extra/`.
- `run` over a temp root holding one file with `--model claude-sonnet-5`:
  - Review Focus 5: no `ANTHROPIC_API_KEY`, no `--latest`, and a stub runner resolving all four family aliases, with `sonnet` resolving to `claude-sonnet-5`. The pin row is `unknown`, `exitCode` is 2, and no output row starts with `current`.
  - Alias source with a stale pin: the same, but `sonnet` resolves to `claude-sonnet-5-5`. A `behind` row appears and `exitCode` is 1.
  - The same with `--no-resolve`: `exitCode` 2, and the first output line is exactly `latest source: none (latest unknown)`.
  - `--latest` pointing at `{"sonnet":"claude-sonnet-5-5"}`: `exitCode` 1 and a `behind` row.
  - Every pin current under source `file`: `exitCode` 0.

- [ ] **Step 2: Run to verify they fail.** `bun test test/model-currency.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Implement.**
  - Pin patterns: `claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?` ending on a word boundary, plus the older shape `claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)(?:-(\d{8}))?`. Alias patterns: `^\s*model:\s*(fable|opus|sonnet|haiku)\s*$`, `"model"\s*:\s*"(fable|opus|sonnet|haiku)"`, and `--model[ =](fable|opus|sonnet|haiku)\b`.
  - `DEFAULT_EXCLUDES = [".git", "node_modules", "runs", "worktrees", "projects", "file-history", "plugins", "debug", "backups", "superpowers"]` are directory names skipped at any depth. Files named `*.jsonl` or `*.bak*`, over 2 MB, or holding a NUL byte are skipped too. A `--root` may name a file.
  - With no API answer and no `--latest`, `run` resolves all four family aliases, not only those found in files. With no source at all, the first output line is `latest source: none (latest unknown)`.
  - Latest source order: the Models API (`GET https://api.anthropic.com/v1/models?limit=1000` with headers `x-api-key` and `anthropic-version: 2023-06-01`), then the `--latest` JSON file, then the live alias resolutions with source `alias`. The first output line names the source. For `alias` it adds `(unverified: an alias can itself resolve to an older model)`.
  - The default `ClaudeRunner` runs `claude -p --model <alias> --output-format json "Reply with the single word OK."` with cwd set to a fresh empty temp dir and `CLAUDE_PROJECT_DIR` removed from its environment, then removes the dir. Only `modelUsage` keys are read, and the response text is never printed. Each run can still append one dead temp path to the nudge state file (Task 9), and that growth is accepted.
  - Output rows: `<status>\t<file>:<line>\t<value>\t<latest or ->`.
  - Exit 1 when any row is `behind` or `stale-alias`. Otherwise exit 2 when any row is `unknown`, the source is `alias`, or no source was found. Otherwise exit 0.
  - README row, with the first cell backticked like every other row: `` | `tools/model-currency/` | The kernel's model currency check: every exact model ID and tier alias under the roots given, against the latest models, with aliases resolved live. Run by hand. Nothing installs it | ``

- [ ] **Step 4: Run to verify they pass.** `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add tools/model-currency/check.ts test/model-currency.test.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(model-currency): check model pins and aliases against the latest models (#310)"
```

---

### Task 4: Stale model prose and the kernel pointer (coordinator, operator's machine)

In the main clone on `feat/310-kernel` after Task 3's commit.

**Files:**
- Modify (source): `~/.claude/skills/subagent-prompting/SKILL.md`, `~/.claude/rules/subagent-prompting.md`, `~/.claude/rules/agent-usage.md`
- Maybe modify: `install/Start-CappedCopilot.ps1:59`

**Interfaces:**
- Consumes: Task 3's CLI.
- Produces: nothing later tasks call.

- [ ] **Step 1: Dispatch the source read.** Use `research-scout` (it holds Write scoped to scratch) with `model: sonnet`. Add an `ISOLATION-OVERRIDE:` line naming its scratch-only write scope, since the worktree gate does not trust `writeScope` (#312). The brief: read Anthropic's current model documentation for Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.2. For each, report effort support and levels, adaptive or extended thinking support, and any published guidance on delegation or self-verification, with the URL and a quoted line. The report goes to `<scratchpad>/model-docs-report.md`.
- [ ] **Step 2: Apply the findings in `~/.claude`.**
  - In `skills/subagent-prompting/SKILL.md`, rewrite the Haiku 4.5 row (lines near 3, 77 and 79) for Haiku 5.5.
  - Relabel the Fable 5, Opus 5 and Sonnet 5 tables (near 74-76, 83-99 and 114-116) to the current point releases where the report confirms each claim. Label the rest "measured on 5.0, unverified on 5.x". The Opus 4.x history stays.
  - At `rules/subagent-prompting.md:15` and `rules/agent-usage.md:24`, "Opus 5" becomes "Opus 5.x" when the report confirms the claim for Opus 5.5. Otherwise add "(measured on Opus 5.0)".
  - In `rules/agent-usage.md`, after the sentence starting "Verify what an alias resolves to", add: "The core repo's `tools/model-currency/check.ts` runs that check for every alias and exact model ID under the roots it is given, against the latest models."
- [ ] **Step 3: Copilot pin.** Run Copilot CLI's model listing (`copilot help config`). If it names a Sonnet 5.5 model, change the `--model` example at `install/Start-CappedCopilot.ps1:59` to that name. The fixture at `install/Start-CappedCopilot.Tests.ps1:71` is an arbitrary passthrough value. Its value stays, and the line gains a trailing `# model-currency: ignore` comment. If no listing is available, change nothing and say so in the PR body.
- [ ] **Step 4: Run the check.** Run two commands:
  - `bun tools/model-currency/check.ts --root "$USERPROFILE/.claude/rules" --root "$USERPROFILE/.claude/agents" --root "$USERPROFILE/.claude/skills" --root "$USERPROFILE/.claude/hooks" --root "$USERPROFILE/.claude/settings.json"`
  - `bun tools/model-currency/check.ts --root . --exclude test`

  The expected residual `behind` rows are:
  - the `claude-opus-5` key in `~/.claude/settings.json` (kept by choice, audit item 3)
  - the third-party example under `~/.claude/skills/synced/` (overwritten on sync)
  - `install/Start-CappedCopilot.ps1:59`, if Step 3 could not confirm a name

  Any other `behind` or `stale-alias` row in rules, agents, skills, hooks or source is fixed before commit.
- [ ] **Step 5: Export, stage and commit** together with Task 5 (Task 5 Step 3).

---

### Task 5: Kernel rule additions (coordinator, operator's machine)

The same branch as Task 4. These are `~/.claude` edits that land through one export.

**Files:**
- Modify (source): `~/.claude/rules/no-overclaim.md`, `~/.claude/rules/challenge-mandate.md`
- Create (source): `~/.claude/rules/decision-log.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the kernel file `rules/decision-log.md`, which Plan B may pair with a template.

- [ ] **Step 1: Write the rule text.**
  - In `no-overclaim.md`, a new section before "How to apply":

```markdown
## Absence is a claim too

A failed fetch, an empty search or a thin result supports only "could not find it, tried X, Y and Z", never "it does not exist". Name what was tried.

Before stating that a human step did not happen (a spot check, a review, a call), ask the operator. Offline human work leaves no transcript, so missing evidence of it is not evidence it was skipped.
```

  - In `challenge-mandate.md`, a new last bullet under "How to apply": `- After repeated additions or rework rounds on one part of the work, volunteer a keep-or-drop challenge for that part, with the cost so far.`
  - The new `decision-log.md`:

```markdown
# Decision Log

Each project keeps a decision log at `docs/decision-log.md`, or at `decision-log.md` in the project root when there is no `docs/` folder. A project's own rules may name another path.

Append one entry per consequential choice: the UTC date, the choice in one sentence, the options rejected, who drafted it and who decided it. Name roles, never people: `operator`, `coordinator`, or an agent type such as `task-reviewer`. That is what keeps the log safe in a public repository.

Write the entry when the choice is made. An entry reconstructed at the close records what the coordinator remembers, which is the failure the log exists to prevent.
```

- [ ] **Step 2: Mirror the principle.** `harness-core.md` says a principle change in no-overclaim or challenge-mandate updates `skills/engineering-method/SKILL.md` in the same change. Add one line for each addition there.
- [ ] **Step 3: Export, stage and commit.** `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff --stat account/claude`. Stage only the files Tasks 4 and 5 changed: `rules/agent-usage.md`, `rules/subagent-prompting.md`, `rules/no-overclaim.md`, `rules/challenge-mandate.md`, `rules/decision-log.md`, `skills/subagent-prompting/SKILL.md` and `skills/engineering-method/SKILL.md`, plus the Copilot files if they changed. `skills/engineering-method` is the only member of the `engineering-method` pack in `packs.json`. Bump that pack's `version` from `0.1.0` to `0.1.1`, run `bun tools/packs/cli.ts` in write mode, then stage `packs.json`, `packs/engineering-method/` and `.claude-plugin/marketplace.json`. `bun tools/packs/cli.ts --check` must then pass. Commit with `-m "docs(account): kernel absence rules, decision log, current model names (#310)"`.

PR A2 body: `Docs: README updated: tools/model-currency row`.

---

### Task 6: Preflight for the rule move (coordinator, operator's machine)

- [ ] **Step 1: Export.** In the main clone on an up-to-date `master`, run `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff --stat account/claude/rules`.
- [ ] **Step 2: Land any drift first.** If the diff is not empty, it lands through its own PR before Task 7 starts.
- [ ] **Step 3: Record the base.** After that merge, a second export shows no diff under `account/claude/rules`. That `master` sha is the `BASE-SHA` for Task 7. From here until Task 12, `change-management.md` and `fix-quality.md` in `~/.claude/rules` are frozen. Task 7's split test turns red on any edit to them.

---

### Task 7: Copy the code-layer rules into core

**Files:**
- Create: `core/claude/rules/change-management-code.md`, `core/claude/rules/fix-quality.md`, `core/claude/rules/layers.json`
- Create: `test/fixtures/rules-premove/change-management.md`, `test/fixtures/rules-premove/fix-quality.md`, `test/layer-rules.test.ts`
- Modify: `.github/CODEOWNERS`, `tools/pr-review/types.ts` (`TRUSTED_CONTEXT_PATHS`), `README.md` ("What's here")

**Interfaces:**
- Consumes: the `BASE-SHA` from Task 6.
- Produces:
  - `core/claude/rules/layers.json`, shaped `{ "schemaVersion": 1, "rules": { "<file>.md": ["code" | "documents" | "physical", ...] } }`. Task 8 adds `settings`.
  - Exported from `test/layer-rules.test.ts`: `SPLITS` and `sectionsOf(text: string): { preamble: string; sections: { heading: string; body: string }[] }`. Task 12 runs the test, and Task 14 deletes it with the fixtures.

- [ ] **Step 1: Write the failing test** `test/layer-rules.test.ts`.

```ts
export const SPLITS = {
  "change-management.md": {
    kernelFile: "change-management.md", codeFile: "change-management-code.md", preambleStaysIn: "kernel",
    newPreamble: "# Change Management: Code Projects\n\nThe code-repo half of `change-management.md`. The confirmation list, backups, commit identity, decision notes, invariant promotion and script hygiene stay in the kernel file of that name.",
    codeSections: ["## Decision Documentation", "## Session Close Protocol"],
  },
  "fix-quality.md": {
    kernelFile: "bounded-review.md", codeFile: "fix-quality.md", preambleStaysIn: "code",
    newPreamble: "# Bounded Review",
    codeSections: ["## Fix the producer, not the consumer", "## Prove the premise before replacing a mechanism",
      "## Complexity needs a receipt", "## A dirty cache is only as complete as its enumerated inputs",
      "## Review with a joint verdict, not a separate simplicity gate", "## Pin the correctness baseline", "## Set the right target"],
  },
} as const;
```

`sectionsOf` normalises `\r\n` to `\n`, takes the text before the first line starting `## ` as the preamble, and cuts each section from its `## ` heading line to the line before the next one. Preamble and bodies are compared with trailing newlines trimmed. A listed heading missing from the fixture throws, so a renamed section fails instead of passing vacuously.

Cases:
- "every rule listed in layers.json exists in core/claude/rules", and "every .md file in core/claude/rules is listed in layers.json".
- "layer names are only code, documents and physical, and every list is non-empty".
- "the split loses and adds nothing". For each entry in `SPLITS`, the fixture is the original. Every comparison normalises `\r\n` to `\n` on both sides first, since `test/fixtures/` has no eol rule and checks out CRLF on Windows. Before cutover, `account/claude/rules/<original>` equals the fixture. Then the core code file must be `newPreamble` (or the original preamble, per `preambleStaysIn`) followed by exactly the `codeSections`, in original order and byte-identical. After cutover, the account copy differs and `account/claude/rules/<kernelFile>` holds the kernel half. Then the kernel file's sections plus the code file's sections must equal the fixture's sections: each fixture section appears exactly once across the two files, byte-identical, each file keeps the original order, and the preambles follow `preambleStaysIn` and `newPreamble`. Export mirrors the rules directory, so after cutover a removed file is absent rather than different. An absent account copy counts as after-cutover only when `kernelFile` differs from the original name (fix-quality.md, whose kernel half is `bounded-review.md`). For change-management.md, whose kernel file keeps the name, an absent account copy fails. Read with an existence check first, so absence never throws. An account copy that matches neither shape fails with a message saying the source changed since the move and must be ported into core.

- [ ] **Step 2: Run to verify it fails.** `bun test test/layer-rules.test.ts`. Expected: FAIL, files missing.

- [ ] **Step 3: Create the files** (Git Bash for every redirect).
  - Fixtures: `git show <BASE-SHA>:account/claude/rules/<file> > test/fixtures/rules-premove/<file>` for both files.
  - Build `change-management-code.md` and the core `fix-quality.md` from the fixture by keeping the preamble that `SPLITS` assigns to the code side and the listed `codeSections`, in their original order. Change nothing else.
  - `layers.json`:

```json
{
  "schemaVersion": 1,
  "rules": {
    "change-management-code.md": ["code"],
    "fix-quality.md": ["code"]
  }
}
```

  - `.github/CODEOWNERS`: add `/core/claude/rules/                         @Cringely` after the templates line. The account rules are owned today, and the move must not leave the code half unowned.
  - `tools/pr-review/types.ts`: add `"core/claude/rules/fix-quality.md"` to `TRUSTED_CONTEXT_PATHS`, keeping the account entry until Task 13.
  - README "What's here", first cell backticked: `` | `core/claude/rules/` | Layer rule files and layers.json, which assigns each file to the code, documents or physical layer and defines the project settings. The installer copies the layers a project records into its .claude/rules/harness/ | ``

- [ ] **Step 4: Verify.** Run `bun test`. Expected: all PASS, with the split case in its before-cutover mode for both files.

- [ ] **Step 5: Commit.**

```bash
git add core/claude/rules test/fixtures/rules-premove test/layer-rules.test.ts .github/CODEOWNERS tools/pr-review/types.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(rules): code-repo halves of two account rules in core, byte-identical (#310)"
```

---

### Task 8: Manifest v3, layers and settings in the installer

**Files:**
- Modify: `install/Install-Harness.ps1` (param block and comment help, the `-Quiet` guard area, manifest load, `Get-CoreFilesMap`, the `-Audit` block, the install loops, the provenance block)
- Modify: `core/claude/rules/layers.json` (add `settings`)
- Create: `core/claude/templates/project-settings.template.md`
- Test: `install/Install-Harness.Tests.ps1`, `test/layer-rules.test.ts`
- Modify: `README.md` (Install section, the templates row at line 17, the Layering model section)

**Interfaces:**
- Consumes: `core/claude/rules/layers.json` and the two rule files from Task 7.
- Produces:
  - Params `[string[]]$Layers` (no ValidateSet, since the script validates), `[ValidateSet('silent','heartbeat')][string]$StatusCadence`, `[ValidateSet('peer-engineer','plain-all-roles')][string]$Audience`, and `[ValidateRange(0,100000)][int]$LengthBudget`.
  - Functions inside the script:
    - `Get-LayerRegistry` returns the parsed and validated `layers.json`.
    - `ConvertTo-ManifestV3 -Loaded`
    - `ConvertTo-LayerList -Requested` turns the `-Layers` tokens into a `string[]` in the order code, documents, physical.
    - `Resolve-ProjectLayers -Requested -Manifest` returns `string[]`.
    - `Get-DefaultProjectSettings -Layers`
    - `Resolve-ProjectSettings -Recorded -Defaults -Bound`
    - `Get-ProjectSettingsText -Layers -Settings -Registry`
  - Manifest shape `{ schemaVersion: 3, files, accepted, coreCommit, layers: string[], settings: { statusCadence, audience, lengthBudgetDefault } }`.
  - Installed paths are `.claude/rules/harness/<file>.md` under keys `rules/harness/<file>.md`. The generated `.claude/rules/harness/project-settings.md` is never tracked in `files`.
  - New audit statuses:
    - `not-installed (layer not selected)`, which is not counted
    - `installed (layer not selected)`, `settings-missing`, `settings-stale` and `manifest-invalid`, which are counted

- [ ] **Step 1: Write the failing Pester tests** in a new `Context 'layers and settings'`.
  - "records schemaVersion 3 and layers code on a fresh install and installs the code rules":
    - `.claude/rules/harness/change-management-code.md` and `fix-quality.md` exist, and `layers` is `@('code')`.
    - The raw manifest text matches `'"layers":\s*\[\s*"code"\s*\]'`. A one-element array unrolled to a scalar would serialise as a string and fail the next load.
    - `statusCadence` is `silent`, `audience` is `peer-engineer` and `lengthBudgetDefault` is `$null`.
    - `project-settings.md` matches ``'Status cadence, `silent`'``.
  - "a comma list binds from a spawned shell": `pwsh -NoProfile -File install/Install-Harness.ps1 -Target <t> -Layers code,documents` records `@('code','documents')`.
  - "migrates a v2 manifest with no layers key as the code layer": install, delete the `schemaVersion`, `layers` and `settings` keys, re-run. `layers` is `@('code')` and the rule files are present.
  - "-Layers documents installs no code rules and derives heartbeat and plain-all-roles". `fix-quality.md` is absent, `statusCadence` is `heartbeat`, and `audience` is `plain-all-roles`.
  - "-Layers none records an empty list and installs no layer rules":
    - `@($m.layers).Count` is 0.
    - Nothing is under `.claude/rules/harness/` except `project-settings.md`, which matches `no project layers`.
  - Review Focus 4, "an empty layer list survives a re-run with no flags": install `-Layers none` and re-run bare. `@($m.layers).Count` is still 0 and `fix-quality.md` is absent. Ablate the fix by switching the presence check to truthiness, and confirm the test fails.
  - "rejects none combined with a layer, kernel, and an unknown name":
    - `-Layers none,code`, `-Layers kernel` and `-Layers prose` each throw a message naming the valid values.
    - The target has no `.claude` afterwards.
  - "keeps recorded settings when -Layers changes and sets them when a flag is given":
    - Install `-Layers code`, then re-run `-Layers code,documents`. `statusCadence` stays `silent`.
    - Re-run `-StatusCadence heartbeat -LengthBudget 1200`. The settings become `heartbeat` and `1200`.
    - Re-run `-LengthBudget 0`. `lengthBudgetDefault` becomes `$null`.
  - "a dropped layer's rule file is left in place, warned about, and counted by the audit":
    - Install `-Layers code`, append `"PROJECT EDIT"` to `fix-quality.md`, and re-run `-Layers documents`.
    - The file still exists with the edit, the output matches `layer not selected`, and `-Audit` has an `installed (layer not selected)` row for `rules/harness/fix-quality.md`.
    - Delete the file and re-run. The manifest `files` no longer holds the key.
  - Review Focus 3, "an invalid recorded layers value fails before any write and is reported under -Quiet":
    - After a clean install, set `layers` to the string `"code"`, then `@("kernel")`, then `@("prose")`.
    - Each install re-run throws a message matching `layers`, and the SHA256 of `.harness-manifest.json` and `settings.json` is unchanged.
    - `-Audit -Quiet` prints a `manifest-invalid` row and does not throw.
  - "a hand-written rule file at the install path is kept and reported": create `.claude/rules/harness/fix-quality.md` before the first install. It is unchanged afterwards, and the output matches `Skipping 'rules/harness/fix-quality.md'`.
  - "audit reports settings-stale after a hand edit but not after CRLF conversion, and writes nothing":
    - CRLF-convert `project-settings.md`. `-Audit` shows no `settings-stale`.
    - Append a line. `-Audit` shows `settings-stale`.
    - The manifest hash is unchanged.
  - "audit leaves rules of unselected layers uncounted": `-Layers documents`, then `-Audit` prints `All managed files in sync with core.`
  - "the layer and settings flags are refused with -Audit": `-Audit -Layers code` throws.

  - "each settings ValidateSet matches layers.json": the `ValidateSet` values of `-StatusCadence` and `-Audience`, read through `(Get-Command install/Install-Harness.ps1).Parameters`, equal the keys of `settings.statusCadence` and `settings.audience` in `layers.json`.

  In `test/layer-rules.test.ts`, add "settings define exactly the values the installer accepts". The `settings` keys are:
  - `statusCadence`, with keys `silent` and `heartbeat`
  - `audience`, with keys `peer-engineer` and `plain-all-roles`
  - `lengthBudgetDefault`, with keys `none` and `words`. The `words` text contains `{{WORDS}}`.

- [ ] **Step 2: Run to verify they fail.** `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`. Expected: the new cases FAIL, and the existing ones PASS.

- [ ] **Step 3: Implement.**
  - **Parameter guard** (near the `-Quiet` guard):
    - `ConvertTo-LayerList` splits every `-Layers` element on `,`, trims, and drops empties.
    - A token outside `code`, `documents`, `physical` or `none` throws `-Layers takes code, documents, physical, or none. The kernel is always on and is never listed.`
    - `none` with any other token throws.
    - Any of `-Layers`, `-StatusCadence`, `-Audience` or `-LengthBudget` (checked through `$PSBoundParameters`) combined with `-Audit`, `-Accept`, `-Unaccept` or `-Prune` throws "applies to an install run only".
  - **`Get-LayerRegistry`** throws when:
    - the file is missing, `schemaVersion` is not 1, or `rules` is empty
    - a listed file is missing, or a layer name is outside the three
    - `settings` lacks a value that Step 1 names

    An empty registry would read every installed rule file as orphaned, so it refuses instead.
  - **`ConvertTo-ManifestV3`** calls `ConvertTo-ManifestV2`, then sets `schemaVersion = 3`. `ConvertTo-ManifestV2`'s v1 skip list gains `schemaVersion`, `layers`, `settings` and `allowUnpinnedPlugins`, so its v1 branch never folds them into `files`. The accepted layer names and setting values come from `Get-LayerRegistry`, not from literals. `ConvertTo-LayerList` takes them from there too.
    - `layers` is absent only when `-not $m.Contains('layers')`, and then becomes `@('code')`. A present empty array stays empty.
    - A present `layers` that is not an array, or that holds a value outside the three, throws with a message naming the valid values. A present `settings` value outside the accepted set throws the same way.
    - It replaces every `ConvertTo-ManifestV2` call site, so `-Accept`, `-Unaccept` and `-Prune` carry layers and settings through.
    - The load sits above every write, so a throw leaves disk untouched. Under `-Audit -Quiet` the throw is caught, and the script prints `manifest-invalid<TAB>.harness-manifest.json` and returns.
  - **Writing the manifest:** assign `layers` as `[string[]]@(...)`. Use `,@(...)` only on a function's return, where a single element could unroll.
  - **`Get-DefaultProjectSettings`:**
    - `statusCadence` is `heartbeat` when the layers include `documents` or `physical`, else `silent`.
    - `audience` is `plain-all-roles` when the layers include `documents` and not `code`, else `peer-engineer`.
    - `lengthBudgetDefault` is `$null`.
  - **`Resolve-ProjectSettings`:** a bound flag wins, then the recorded value, then the default. `-LengthBudget 0` records `$null`. Changing `-Layers` alone never re-derives a recorded setting.
  - **`Get-CoreFilesMap`** adds `rules/harness/<file>` for every registry rule.
  - **Install:**
    - Create `.claude/rules/harness` with the other directories.
    - One classifier decides what is selected: `Get-ComponentGate -Key <manifestKey> -Layers <string[]> -IncludeCeremonies <bool>` returns `$null` when selected, else `ceremony-gated` or `layer not selected`. The agent, hook and rule loops, the settings-hook filter, and the audit all ask it. `$ceremonyKeys` feeds it and is no longer consulted directly.
    - For each registry rule the classifier selects, call `Install-ManagedFile` with key `rules/harness/<file>`.
    - For a rule whose layers do not intersect, when the file is on disk, add result `left-in-place (layer not selected)` and warn: "'<key>' belongs to a layer this project no longer records. It was left in place. Delete it by hand if the layer is gone for good, and the next install drops its record."
    - When the file is absent and the key is in `files`, remove the key and add `record-dropped (layer not selected)`.
    - The installer never deletes a file.
  - **Settings file:**
    - Render `project-settings.md` from the template with `Get-ProjectSettingsText`.
    - Write it with LF endings on every install and add result `generated`.
    - Print the `Layers: ... Settings: ...` line.
  - **Audit:**
    - Read layers and settings through `ConvertTo-ManifestV3`, defaulting absent settings and writing nothing.
    - An unselected key that is absent is `not-installed (<reason>)` from the classifier, which keeps the existing `not-installed (ceremony-gated)` string. An unselected `layer not selected` key that is present is `installed (layer not selected)`. A present ceremony file keeps its ordinary status, because `-IncludeCeremonies` is not recorded in the manifest.
    - A `rules/harness/project-settings.md` row is `settings-missing` when the file is absent, `settings-stale` when its LF-normalised text differs from the render, and `in-sync` otherwise.
    - Both `not-installed (<reason>)` statuses stay uncounted.
    - Extend the attention line with: "installed (layer not selected) = delete the file by hand, and the next install drops its record. settings-missing/settings-stale = re-run the installer, which rewrites .claude/rules/harness/project-settings.md from the manifest. manifest-invalid = fix the layers or settings value the error names."
  - **Comment help:**
    - Document the four params, and add the five statuses with those responses to `.PARAMETER Audit`.
    - `.DESCRIPTION` says a manifest gains `schemaVersion`, `layers` and `settings` without dropping any v2 field. It also says `project-settings.md` is regenerated every install, so a hand edit there is lost and `settings-stale` is the only signal.
  - `layers.json` gains:

```json
"settings": {
  "statusCadence": {
    "silent": "Between tool calls, and on any turn opened by an agent or workflow completion notification, emit no text. Read the report file, update the Needs-you queue, and continue. Explanatory-style insights are held until the close, not printed beside the code they explain.",
    "heartbeat": "During long work, post one line each time the work moves to a new phase, and never end a turn without text. The operator should not have to ask for status."
  },
  "audience": {
    "peer-engineer": "Write for engineers who share this project's vocabulary, as writing-style.md describes.",
    "plain-all-roles": "Write anything the operator or their readers will see for people in any role. Gloss or drop internal IDs, issue numbers, agent names and house vocabulary. For this project this replaces writing-style.md's \"senior engineer talking to peers\" principle and its Scannable Structure section."
  },
  "lengthBudgetDefault": {
    "none": "No default length budget. Follow the length the operator asks for.",
    "words": "A deliverable aims at {{WORDS}} words or fewer unless the operator asks for something else. A reviewer who says something is missing names what to cut to make room for it."
  }
}
```

  - `project-settings.template.md`:

```markdown
# Project settings

Generated by `install/Install-Harness.ps1` from this project's `.claude/.harness-manifest.json`. Change a setting by re-running the installer with that setting's flag. The next install overwrites a hand edit here.

These settings belong to the project, not to whoever is working in it. Where any other rule file, including one from your account, says something different, the setting here wins.

Layers: kernel (always on), {{LAYERS}}.

- Status cadence, `{{STATUS_CADENCE}}`: {{STATUS_CADENCE_TEXT}}
- Audience, `{{AUDIENCE}}`: {{AUDIENCE_TEXT}}
- Length budget: {{LENGTH_BUDGET_TEXT}}
```

  `{{LAYERS}}` is the comma-joined list, or `no project layers` when the list is empty.
  - README:
    - The Install section gets the four flags, the defaults (a fresh install and a v2 manifest record `code`), what goes into `.claude/rules/harness/`, the generated settings file, the dropped-layer behaviour and the new audit statuses.
    - The templates row (line 17) names `project-settings.template.md` as applied on every run.
    - The Layering model section gets one sentence: the account layer is the kernel, and layer rules ship from core into each project.
  - **Citations.** These edits shift `install/Install-Harness.ps1:1616-1618`, which `Export-Account.ps1:771`, `Install-Account.ps1:511` and `Install-Account.Tests.ps1:1320` cite. Re-pin each one to the moved lines, or rewrite it to name the construct, then run `bun test test/citation-drift.test.ts`. The suite pins the citation population at 30.

- [ ] **Step 4: Run to verify they pass.** `pwsh -NoProfile -File install/Install-Harness.Tests.ps1` and `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add install/Install-Harness.ps1 install/Install-Harness.Tests.ps1 core/claude/rules/layers.json core/claude/templates/project-settings.template.md test/layer-rules.test.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(install): manifest v3 records layers and settings, installs layer rules (#310)"
```

---

### Task 9: One-time nudge for folders with no project layer

The script is authored in the payload copy so it can be tested in the worktree. The coordinator then applies it to the source in `~/.claude` before the next export. That is the one exception to "never hand-edit `account/claude/`", and Step 6 closes it with an export whose diff for this file is empty.

**Files:**
- Modify: `account/claude/hooks/harness-core-reminder.sh`
- Create: `test/harness-core-reminder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the nudge text below, and the state file `<CLAUDE_HOME>/state/harness-nudged.txt` with one folder path per line. `state/` is outside the exporter's allowlist, so these paths are never exported.

- [ ] **Step 1: Write the failing test.** Copy the payload script into `<tmp>/home/hooks/harness-core-reminder.sh`, then run it with `posixBash()` from `test/posix-sh.ts` and `CLAUDE_PROJECT_DIR=<folder>`:
  - "a folder with no manifest and no .git gets the nudge once": stdout contains `no agent-harness-core project layer`, and `<tmp>/home/state/harness-nudged.txt` holds the folder line.
  - "the same folder is silent on the second run": stdout is zero bytes.
  - "a different folder still gets it".
  - "a folder with .claude/.harness-manifest.json is silent and writes no state".
  - "a path containing agent-harness-core is silent".
  - "an unwritable state location still prints the nudge": `<tmp>/home/state` is created as a file.
  - Every case exits 0.

- [ ] **Step 2: Run to verify it fails.** `bun test test/harness-core-reminder.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Keep the shebang, the `CLAUDE_PROJECT_DIR` fallback to `$PWD`, the `*agent-harness-core*` exit and the manifest check. Drop the `.git` requirement.
  - Take the state directory from the script's own location (`$(dirname "$0")/../state`), never from `$HOME`, which Git Bash on this workstation points at the wrong folder.
  - Exit silently when `LC_ALL=C grep -Fxq -- "$d"` finds the folder in the state file. Otherwise append the folder, ignoring errors, and print:

```text
This folder has no agent-harness-core project layer (.claude/.harness-manifest.json is missing), so only the kernel rules from your account apply here. To add a project layer, run: pwsh {{CORE_REPO}}/install/Install-Harness.ps1 -Target <folder> -Layers <code,documents,physical>. Offer this once if the session starts real work here, and do not run it unasked. This reminder does not repeat for this folder.
```

- [ ] **Step 4: Run to verify it passes.** `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add account/claude/hooks/harness-core-reminder.sh test/harness-core-reminder.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(account): nudge any folder without a project layer, once (#310)"
```

- [ ] **Step 6 (coordinator, operator's machine, before pushing A3).** Copy the payload script to `~/.claude/hooks/harness-core-reminder.sh`, with `{{CORE_REPO}}` replaced by the core checkout path in the forward-slash form `Get-MainCheckout` returns (an absolute path such as `<drive>:/<projects>/agent-harness-core`). Run `pwsh -NoProfile -File install/Export-Account.ps1`. Expected: `git diff account/claude/hooks/harness-core-reminder.sh` is empty. Stage nothing else from the export.

---

### Task 10: Install-Account retires files the account layer no longer ships

**Files:**
- Create: `install/account-retired.json`
- Modify: `install/Install-Account.ps1` (including the `.DESCRIPTION` sentence "Removal does not propagate to a receiver")
- Test: `install/Install-Account.Tests.ps1`
- Modify: `README.md` (Account layer section)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `install/account-retired.json`, shaped `{ "schemaVersion": 1, "retired": [ { "path": "rules/<file>.md", "reason": "<one sentence>" } ] }`
  - The param `-RetiredListPath`, which defaults to `install/account-retired.json` beside the script.
  - The function `Invoke-AccountRetirement -ClaudeHome <string> -PayloadRoot <string> -ListPath <string>`.

- [ ] **Step 1: Write the failing tests** in a new `Context 'retired paths'`. Use the suite's sandbox pattern (`-PayloadRoot`, `-ClaudeHome`, `-ClaudeJson`, `-SkipPreflight`) plus `-RetiredListPath`.
  - "renames a retired file on the receiver, keeps its content, and says what to run next":
    - The sandbox home has `rules/old.md`, the list names it, and the payload does not carry it.
    - Afterwards `rules/old.md` is gone, and exactly one `rules/old.md.retired-*` exists with the original content.
    - The output matches `Retired rules/old.md` and `Install-Harness.ps1 -Target`.
  - "refuses before copying anything when the payload still carries a retired path": the message names the path, and a payload file that was absent from the home is still absent.
  - "rejects an entry that escapes the account home or names another tree": `../x.md`, an absolute path and `tools/x.md` each throw.
  - "-WhatIf renames nothing".
  - "an empty list changes nothing and prints no Install-Harness advice".
  - "a missing list file throws".

- [ ] **Step 2: Run to verify they fail.** `pwsh -NoProfile -File install/Install-Account.Tests.ps1`. Expected: the new cases FAIL.

- [ ] **Step 3: Implement.**
  - Call `Invoke-AccountRetirement` immediately before the first copy, after Task 15's dependency preflight and after its own payload-carries-retired-path check. A receiver that is refused for a missing dependency must not have had its rules renamed first.
  - Validate every entry first. It must be a relative path with no `..` segment, sit under `rules/`, `agents/`, `skills/` or `hooks/`, and be absent from the payload.
  - For each entry present under `-ClaudeHome`:
    - `Move-Item` it to `<path>.retired-<yyyyMMddTHHmmssZ>` (UTC). `Move-Item` honours `-WhatIf` on its own.
    - Print `Retired <path> (now <new name>): <reason>`.
  - After one or more renames, warn: `Rule files moved out of the account layer into project layers. Run pwsh <core>/install/Install-Harness.ps1 -Target <project> in each project on this machine that uses the harness, so each keeps its copy.`
  - Ship `install/account-retired.json` as `{ "schemaVersion": 1, "retired": [] }`.
  - Replace the `.DESCRIPTION` removal sentence with one stating that the retire list is how removal reaches a receiver.
  - README Account layer section:
    - The retire list renames rather than deletes, and Claude Code loads only `*.md` from `rules/`.
    - Update order on a receiver: `git pull`, then `Install-Harness.ps1` on each project, then `Install-Account.ps1`.
  - **Citations.** These edits shift `install/Install-Account.ps1:662-673`, which `Install-Account.Tests.ps1:1386` cites. Re-pin it, then run `bun test test/citation-drift.test.ts`.

- [ ] **Step 4: Run to verify they pass.** `pwsh -NoProfile -File install/Install-Account.Tests.ps1`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add install/account-retired.json install/Install-Account.ps1 install/Install-Account.Tests.ps1 README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(install-account): rename files the account layer has retired (#310)"
```

PR A3 body: `Docs: README updated: core/claude/rules row, Install section for layers and settings, templates row, Layering model, Account layer retire list and update order`.

---

### Task 11: Reinstall projects and check what isolated agents see (coordinator, operator's machine, gates Task 12)

This runs after A1 and A3 merge. Until it passes, nothing leaves `~/.claude/rules`.

- [ ] **Step 1: Confirm the copies still match.** Export, then run `bun test test/layer-rules.test.ts`. Expected: PASS in before-cutover mode. A red split case means a source edit since Task 6, which gets ported into core first.

- [ ] **Step 2: Reinstall every installed project.**
  - For each project root in the operator's per-machine list, glob `<project-root>/*/.claude/.harness-manifest.json`. The list is supplied by the operator and not recorded in this repository. When none is recorded, ask for it once, with Step 3's question.
  - For each project, including this repo, run `pwsh -NoProfile -File install/Install-Harness.ps1 -Target <project>`.
  - Expected per project: `.claude/rules/harness/fix-quality.md` exists and the printed line reads `Layers: code.`
  - Collect each project's `git status --short`.

- [ ] **Step 3: Ask the operator once.** The message carries:
  - the project list and each project's pending changes
  - whether projects live anywhere else
  - the request to commit and push the reinstalled `.claude/rules/harness/` files in those repositories, which have their own owners and gates

  Committing there waits on the answer.

- [ ] **Step 4: Run the live check, in this repo only.** This repo gitignores `/.claude/`, so its isolated worktrees cannot carry the rule files, which makes it the hardest case. Everything runs in one Git Bash command from the repo root, after Step 2. The coordinator's own session takes no part, because its rules were loaded before the reinstall.
  - **Marker.** Generate a random token at run time, for example `harness-check-` plus 16 hex digits from `/dev/urandom`. Hold it in a shell variable and append it as a `Check token: <token>` line to `.claude/rules/harness/project-settings.md` only. It is never printed, never written anywhere else, and never appears in this plan or in the coordinator's context.
  - **Brief.** Both runs use the same neutral question: "Without reading any file or running any tool, quote the line that starts with `Check token:` from the project rules in your context, or reply NOT IN CONTEXT."
  - **Control.** Run `claude -p --model haiku "<brief>"` as a fresh headless session from the repo root. The shell compares the output with the token and prints only `CONTROL MATCH` or `CONTROL NO MATCH`. A match also confirms that Claude Code loads `.claude/rules/` subfolders.
  - **Check.** Run a second fresh session, `claude -p --model haiku --output-format stream-json --verbose`. Its prompt asks it to dispatch one `general-purpose` agent with `isolation: "worktree"` and `model: haiku`, whose prompt is a `BASE-SHA: <git rev-parse HEAD>` line followed by the brief. The stream goes to a temp file under the session scratchpad. A `bun -e` one-liner finds the Agent `tool_use` with `isolation` set to `worktree` and its `tool_result`. It also checks that the token is absent from that `tool_use`'s `prompt` input, and prints `CHECK INVALID` when it is present, because then the outer session leaked the token into the brief. Otherwise it prints `CHECK MATCH` when the result contains the token, `CHECK NO MATCH` when it does not, and `CHECK NO DISPATCH` when no such call exists. `CHECK INVALID` is treated like `CHECK NO DISPATCH`: one retry, then it counts as `CHECK NO MATCH`. The outer session's own text is never read, because it can see the token itself.
  - **Cleanup.** Unset the variable, delete the temp file, and re-run `Install-Harness.ps1` on this repo, which rewrites `project-settings.md` without the token. Headless output can carry the account email, which is why only verdicts are printed.
  - **Predictions.** If isolated agents load project rules from the main checkout, `CHECK MATCH`. If they load them from the worktree's own tree, `CHECK NO MATCH`. `CHECK NO DISPATCH` gets one retry, and a second one counts as `CHECK NO MATCH`.

- [ ] **Step 5: Gate.**
  - `CONTROL NO MATCH`: stop. Claude Code does not load `.claude/rules/harness/`, so Plan A's install path is wrong. Neither A4 path runs. The coordinator raises a Needs-you item to move the installed rules to `.claude/rules/` directly, with a file-name prefix.
  - `CONTROL MATCH` and `CHECK MATCH`: the cutover path, Task 12 Steps 1-5, then Task 13.
  - `CONTROL MATCH` and `CHECK NO MATCH`: the fallback path, Task 12 Step 1 and Step 5F only, and Task 13 does not run. Both copies of the code halves stay: the account `fix-quality.md` and the full account `change-management.md` remain in `~/.claude/rules` beside the project copies. The coordinator raises a Needs-you item. Option A: change this repo's `.gitignore` from `/.claude/` to `/.claude/*` plus `!/.claude/rules/`, commit and push the installed rules in every project, and re-run Task 11. Option B: keep the duplication.

---

### Task 12: Cutover (coordinator, operator's machine)

In the main clone, on `feat/310-cutover` from `origin/master`, after Task 11's gate. On the cutover path, run Steps 1-5. On the fallback path, run Step 1, then Step 5F, and stop. Steps 2-5 name `bounded-review.md` and the removal of `fix-quality.md`, which the fallback never produces.

- [ ] **Step 1: Coordinator output in the kernel.** Edit `~/.claude/rules/coordinator-output.md`:
  - The title becomes `# Coordinator Output: One Self-Contained Close`.
  - Replace the section "Mid-run: say nothing" with the two sections below. The "Decisions" section's "as above" still points at the second.

```markdown
## Mid-run cadence

How much to say between tool calls is the project's `statusCadence` setting in `.claude/rules/harness/project-settings.md`. Where a folder has no project settings, stay silent between tool calls and hold explanatory insights for the close.

## Stop and ask before a risky step

Whatever the cadence, ask before any action on the `change-management.md` confirmation list (Risky Operations Requiring Confirmation), reversible or not, any other irreversible action, and any step that would introduce a known security weakness (`security.md`, Default Posture: flag before proceeding). Ask immediately, and make the question complete under the restating rule below.
```

- [ ] **Step 2: Split in `~/.claude/rules`.**
  - Back up `change-management.md` and `fix-quality.md` to `~/.claude-backups/rules-<yyyyMMddTHHmmssZ>/`.
  - In `change-management.md`, delete the two `codeSections` that `SPLITS` lists ("Decision Documentation", "Session Close Protocol"). Change nothing else.
  - Create `bounded-review.md` as `# Bounded Review`, a blank line, then the "Work has to be able to end" section copied verbatim from `fix-quality.md`.
  - Remove `fix-quality.md`.
  - The `*.local.md` overlays stay.

- [ ] **Step 3: Repoint kernel pointers.**
  - In `~/.claude/rules/harness-core.md`, at the end of "Account layer, on this machine and on any other", add: "Code-layer rules are not authored here. `fix-quality.md` and `change-management-code.md` live in `core/claude/rules/` in the core repo and are edited there, and `Install-Harness.ps1` copies them into each code project's `.claude/rules/harness/`. A project picks up a rule change when it is reinstalled. The kernel keeps `bounded-review.md`, split out of `fix-quality.md`, and the rest of `change-management.md`."
  - In `~/.claude/agents/senior-developer.md:16`, `~/.claude/rules/fix-quality.md` becomes "`.claude/rules/harness/fix-quality.md` in a code project, and `~/.claude/rules/bounded-review.md`". At `:18`, add "and, in a code project, `.claude/rules/harness/change-management-code.md`".
  - Make the same addition at `~/.claude/agents/project-lead.md:19`.
  - In `~/.claude/rules/writing-style.md:31`, the pointer to `change-management.md` for commit-message rationale becomes "`.claude/rules/harness/change-management-code.md` in a code project", because "Decision Documentation" moves there.
  - The other `change-management.md` pointers (`governance-sme.md:23` and `:93`, `memory-system/SKILL.md:78`, the `subagent-prompting/SKILL.md` sentence naming its Verification Gates, `senior-developer.md:64`, `core/claude/hooks/commit-msg`) name content the kernel keeps, and they stay.

- [ ] **Step 4: Export and check the diff.** Run `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff --stat account/claude`. Expected, and the only paths staged:
  - `rules/fix-quality.md` deleted
  - `rules/bounded-review.md` added
  - `rules/change-management.md`, `rules/coordinator-output.md`, `rules/harness-core.md` and `rules/writing-style.md` modified
  - `agents/senior-developer.md` and `agents/project-lead.md` modified

  Then run `bun test test/layer-rules.test.ts`. Expected: PASS in after-cutover mode, which proves the kernel and code halves reassemble the original sections exactly.

- [ ] **Step 5: Commit (cutover path).** Stage the explicit paths only. With A2 unmerged, the export also carries other kernel edits, and those wait for their own PR.

```bash
git add account/claude/rules/fix-quality.md account/claude/rules/bounded-review.md account/claude/rules/change-management.md account/claude/rules/coordinator-output.md account/claude/rules/harness-core.md account/claude/rules/writing-style.md account/claude/agents/senior-developer.md account/claude/agents/project-lead.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "refactor(account): the account layer keeps the kernel, code-repo rules live in core (#310)"
```

This commit's sha is the `BASE-SHA` for Task 13.

- [ ] **Step 5F: Commit (fallback path).** Run `pwsh -NoProfile -File install/Export-Account.ps1`. Expected: `git diff --stat account/claude/rules/coordinator-output.md` shows the Step 1 change. Stage that one path and commit with `-m "docs(account): status cadence becomes a project setting (#310)"`. The A4 PR then carries this commit alone, with body `Docs: README still accurate: no README section describes coordinator output`.

---

### Task 13: Repoint references, fill the retire list, pin the pointers

Cutover path only. On the fallback path this task does not run. `fix-quality.md` is still shipped from the account layer then, so retiring it would make Install-Account refuse. Pointing the reviewer at `bounded-review.md` would silently drop its standard, and the pointer test would flag a pointer that is still valid.

**Files:**
- Modify: `install/account-retired.json`, `tools/pr-review/types.ts` (comment near line 6 and `TRUSTED_CONTEXT_PATHS`), `tools/pr-review/reviewer-prompt.md:79`, `tools/pr-review/README.md:7`, `install/Install-Harness.Tests.ps1` (the comment naming "Work has to be able to end", one line lower after Task 1), `test/layer-rules.test.ts`, `README.md` (Account layer section)

**Interfaces:**
- Consumes: Task 12's commit, Task 10's list shape, Task 7's test.
- Produces: `DANGLING_RULE_POINTER: RegExp`, exported from `test/layer-rules.test.ts`.

- [ ] **Step 1: Write the pointer test** in `test/layer-rules.test.ts`: "no account or core file points at a moved rule by its account path". Use `DANGLING_RULE_POINTER = /(?:~\/\.claude|\{\{CLAUDE_HOME\}\})\/rules\/fix-quality\.md/` and scan every text file under `account/claude` and `core/claude`. Expect zero hits. A canary asserts the regex matches the literal string `` `~/.claude/rules/fix-quality.md` `` built at runtime, so a broken matcher cannot pass.
- [ ] **Step 2: Run.** `bun test test/layer-rules.test.ts`. Expected: PASS, since Task 12 Step 3 repointed `senior-developer.md`. To ablate, restore the old pointer in `account/claude/agents/senior-developer.md` in the worktree, confirm the test fails, then revert the file.
- [ ] **Step 3: Retire list.** Add `{ "path": "rules/fix-quality.md", "reason": "Split: the code-repo rules moved to core/claude/rules and the review-termination rule to rules/bounded-review.md." }`.
- [ ] **Step 4: Reviewer standards.**
  - In `TRUSTED_CONTEXT_PATHS`, replace `"account/claude/rules/fix-quality.md"` with `"account/claude/rules/bounded-review.md"`. `core/claude/rules/fix-quality.md` stays from Task 7.
  - Repoint the citation of `account/claude/rules/fix-quality.md`'s "Work has to be able to end" to `account/claude/rules/bounded-review.md` in four places: the `types.ts` comment, `reviewer-prompt.md:79`, `tools/pr-review/README.md:7`, and the `Install-Harness.Tests.ps1:45` comment.
- [ ] **Step 5: README.** Add one sentence to the Account layer section: the account layer carries the kernel, and code-layer rules ship from `core/claude/rules`.
- [ ] **Step 6: Verify.**
  - Run `bun test`, `pwsh -NoProfile -File install/Install-Account.Tests.ps1` and `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`. Expected: all PASS.
  - Dry run: seed a temp home's `rules/` with `fix-quality.md` from `git show <Task 12 parent>:account/claude/rules/fix-quality.md` (Git Bash). Run `pwsh -NoProfile -File install/Install-Account.ps1 -ClaudeHome <tmp-home> -ClaudeJson <tmp-home>/claude.json -SkipPreflight -WhatIf`. Expected: one `What if` move line for `rules/fix-quality.md`, and the file still in place.
- [ ] **Step 7: Commit.**

```bash
git add install/account-retired.json tools/pr-review/types.ts tools/pr-review/reviewer-prompt.md tools/pr-review/README.md install/Install-Harness.Tests.ps1 test/layer-rules.test.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "chore(rules): point the reviewer at the kernel split, retire the moved account rule (#310)"
```

PR A4 body: `Docs: README updated: Account layer section says the account layer carries the kernel`.

---

### Task 14: Session close skips the push without a remote, and the kernel cleans up worktrees

This runs after A4 merges, on either path. The split test's job ends when A4 merges with it green, and this edit changes a code section the test pins. Worktree cleanup is kernel housekeeping (spec: #308 E3), so it goes into the kernel half of `change-management.md` through a coordinator step (Step 5) on both paths. The code-layer edit keeps only the no-remote skip. On the fallback path, the full account `change-management.md` still carries its own Session Close Protocol, so Step 5 also applies the step 2 edit there, keeping the two copies in agreement.

**Files:**
- Modify: `core/claude/rules/change-management-code.md` ("Session Close Protocol")
- Delete: `test/fixtures/rules-premove/`, and the split case, `SPLITS` and `sectionsOf` from `test/layer-rules.test.ts`

**Interfaces:**
- Consumes: A4 merged.
- Produces: nothing.

- [ ] **Step 1: Retire the split test.** Delete the fixtures and the split case, and keep the registry and pointer cases.
- [ ] **Step 2: Edit.** Replace step 2 of the Session Close Protocol.

```markdown
2. **Push to remote** — ensure the commit is on GitHub, not just local. Run `git remote` first. When it prints nothing, the project has no remote: skip this step and say "No remote configured, push skipped" in the close. When the folder is not a git repository at all, skip steps 1 and 2 the same way and say so.
```

The em dash after the bold label matches steps 1 and 3.

- [ ] **Step 3: Verify.**
  - Run `bun test`. Expected: PASS.
  - Run `pwsh -NoProfile -File install/Install-Harness.ps1 -Target <tmp project>`. `.claude/rules/harness/change-management-code.md` contains `No remote configured, push skipped`.

- [ ] **Step 4: Commit.**

```bash
git add -A core/claude/rules/change-management-code.md test/layer-rules.test.ts test/fixtures/rules-premove
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "docs(rules): session close skips the push when there is no remote (#310)"
```

- [ ] **Step 5 (coordinator, operator's machine, both paths).**
  - Append this section to the end of `~/.claude/rules/change-management.md`:

```markdown
## Session Close Housekeeping

At session close, for each agent worktree under `.claude/worktrees/`, remove it only when `git -C <worktree> status --porcelain` prints nothing and `git log <worktree-branch> --not --exclude=<worktree-branch> --branches --remotes --tags --oneline` prints nothing, which means no commit on it is unreachable from another ref. Report how many were removed and how many were kept, and why. A folder that is not a git repository has no worktrees, so this step does nothing there.
```

  - On the fallback path, apply Step 2's replacement to that file's own Session Close Protocol as well.
  - Verify the rule's commands in a temp repo with two worktrees, one clean and merged and one holding an unpushed commit. The `git log` command prints nothing for the first and the commit for the second.
  - Export, stage only `account/claude/rules/change-management.md`, and commit in the A5 PR with `-m "docs(account): kernel session close removes finished worktrees (#310)"`.

PR A5 body: `Docs: README still accurate: no README section describes the session close`. After the merge, the coordinator reinstalls every project from Task 11 Step 2 once more.

### Task 15: Declared dependencies, a refusing preflight, and opt-in installs

Group A3, after Task 8, which it shares `Install-Harness.ps1` with. It is numbered last because it was added last.

**Files:**
- Create: `core/claude/deps.json`, `install/Deps.ps1` (dot-sourced by both installers)
- Modify: `install/Install-Harness.ps1` (replaces the bun-only probe and its warning), `install/Install-Account.ps1` (replaces the `$wanted` list at line 232, and drops `pwsh` and `uvx`)
- Test: `install/Install-Harness.Tests.ps1` (new `Context 'dependencies'` plus the existing-case changes in Step 1), `install/Install-Account.Tests.ps1` (new cases plus the existing-case changes in Step 1). The cases sit in suites CI already runs, so `.github/workflows/test.yml` does not change.
- Modify: `README.md` (Install and Account layer sections), `.github/CODEOWNERS` (adds `/core/claude/deps.json                     @Cringely`, since the file decides what the installers download and which plugins are trusted), `.github/workflows/test.yml` (the two setup-bun comments that cite the `bun is not on PATH` negative control). Both are owned paths, so this rides the same administrator-bypass merge.

**Interfaces:**
- Consumes: `ConvertTo-LayerList` and `Resolve-ProjectLayers` (Task 8).
- Produces:
  - `core/claude/deps.json`, shaped `{ "schemaVersion": 1, "deps": [ { "name", "severity": { "<kernel|code|documents|physical>": "hard" | "optional", ... }, "platforms"?: ["windows" | "linux"], "onlyWhenAbsent"?: "<dep name>", "resolve"?: "git-bash", "needs"?: ["<dep name>"], "minVersion", "failMode", "probe": [argv...], "versionPattern"?: "<regex>", "install": { "windows"?: { "winget", "version" }, "linux"?: { "apt", "version" } | { "npm", "version" } } } ] }`.
    - Names are unique, so one entry per tool. The layers an entry belongs to are the keys of `severity`.
    - An absent `platforms` means both.
    - `onlyWhenAbsent` makes the entry apply only while the named dependency is missing.
  - In `install/Deps.ps1`:
    - `Get-DepsManifest -Path <string>` returns the validated manifest.
    - `Get-RequiredDeps -Manifest -Layers <string[]> -IsWindows <bool>` returns one record per tool for this platform. Its severity is the strictest across `kernel` and the chosen layers, so `hard` wins.
    - `Resolve-GitBashPath -Runner -IsWindows -GitExe <string|null>` returns an absolute path or `$null`. `-GitExe` is the injected git location. The preflight passes `(Get-Command git -CommandType Application -ErrorAction SilentlyContinue).Source`, and tests pass `$null` or a temp path.
    - `Test-Dep -Dep -Runner <scriptblock> -GitExe <string|null> -IsWindows <bool>` returns `[pscustomobject]@{ Name; Present; Version; MeetsMin; Reason }`.
    - `Get-DepInstallCommand -Dep -IsWindows <bool>` returns `string[]` or `$null`.
    - `Invoke-DepsPreflight -Manifest -Layers -IsWindows -InstallDeps <bool> -Runner <scriptblock> -ShouldInstall <scriptblock>`. The last parameter receives `(target, action)` and returns a bool. The callers pass `$PSCmdlet.ShouldProcess`.
    - `Invoke-DefaultDepsRunner -Argv <string[]> -TimeoutSeconds <int> -WorkingDirectory <string|null>`
  - The runner contract is `& $Runner $argv $timeoutSeconds $workingDirectory`, returning `[pscustomobject]@{ ExitCode; Output; TimedOut }`. A `$null` working directory inherits the installer's own. Project-scope plugin commands pass the resolved `-Target`. User-scope plugin commands pass the user's home directory.
    - Probes get 10 seconds. Installs, marketplace adds and plugin installs get 900.
    - A command that is not on PATH returns `ExitCode` 127 without throwing. A timeout returns `TimedOut = $true` and `ExitCode` 124, and the process tree is killed.
    - A dependency is present only when the probe exits 0, did not time out, and its output matches the version pattern at or above `minVersion`.
  - New params on both installers: `[switch]$InstallDeps`, plus the test seams `[string]$DepsManifestPath` and `[scriptblock]$DepsRunner`. `Install-Harness.ps1` gains `SupportsShouldProcess` for `-WhatIf` (Step 3 says what that covers).

- [ ] **Step 1: Write the failing tests.** Each uses a fixture manifest through `-DepsManifestPath` and a recording mock `-DepsRunner`, so no real tool is probed or installed. The fixture's hard dep `harness-fake-hard` (probe `harness-fake-hard --version`, `minVersion` `1.2.0`) has install entries `{ "winget": "Example.FakeHard", "version": "1.2.3" }` and `{ "apt": "fake-hard", "version": "1.2.3" }`.
  - "a missing hard dependency refuses before any write and prints the pinned command":
    - The mock returns 127 for the probe.
    - The install throws a message containing the platform's command: `winget install --id Example.FakeHard --version 1.2.3 --exact --source winget` on Windows, `sudo apt-get install -y fake-hard=1.2.3` on Linux.
    - The target has no `.claude`, and the mock recorded no install argv.
  - "a missing optional dependency warns, installs nothing, and the install completes": the output matches the optional dep's name and command, `.claude/.harness-manifest.json` exists, and the mock recorded no install argv.
  - "a probe that exits non-zero is absent even when its output carries a version": the mock returns `ExitCode` 1 with output `harness-fake-hard 1.2.3`, and the install refuses.
  - "a probe that times out is absent": the mock returns `TimedOut = $true`, and the install refuses.
  - "one entry per tool, strictest severity wins": a fixture tool mapped `{ "kernel": "optional", "code": "hard" }` is probed once. With `-Layers code` a missing one refuses, and with `-Layers none` it warns. Under `-InstallDeps` exactly one install call is recorded.
  - "-InstallDeps -WhatIf runs nothing": the probe misses, no install argv is recorded, and the target has no `.claude`. Those absences are the binding check. The output also carries the preflight's own `WhatIf: would run <argv>` line.
  - "-Audit -InstallDeps is refused with a message", per Task 8's install-run-only guard.
  - "Git Bash resolves from Git for Windows, never from PATH". These are unit tests: dot-source `install/Deps.ps1` and call `Test-Dep` with the shipped git-bash entry and `-IsWindows $true`, so they run on both platforms.
    - **Positive.** `-GitExe` is `<tmp>/cmd/git.exe`, and `<tmp>/usr/bin/bash.exe` exists. The mock answers `git --exec-path` with exit 1 and answers that absolute bash path with exit 0 and `GNU bash, version 5.2.21(1)-release`. The recorded probe argv starts with that absolute path, and the result is present.
    - **Negative.** `-GitExe` is `$null`, and the mock answers `git --exec-path` with exit 1.
      - The mock answers any argv whose first element's leaf is `bash` or `bash.exe` (bare `bash`, or `<tmp>/System32/bash.exe`) with exit 0 and the same GNU bash banner.
      - Expected: absent, and no recorded argv starts with a bare `bash` or a `System32` path.
      - A mutant that probes bare `bash` gets the banner and turns this case red.
  - The real default runner, called directly:
    - `Invoke-DefaultDepsRunner @('harness-absent-<guid>') 10` returns 127 without throwing.
    - `@('pwsh','-NoProfile','-Command','Start-Sleep 30')` with a 2-second limit returns `TimedOut` within 6 seconds.
    - `@('pwsh','-NoProfile','-Command','[Console]::In.ReadToEnd() | Out-Null; exit 0')` returns `ExitCode` 0 within the limit, which proves stdin is closed.
  - "-InstallDeps runs the pinned command, re-probes, and proceeds": the first probe returns 127, the install returns 0, and the second probe prints `harness-fake-hard 1.2.3`. The recorded calls are exactly probe, install argv, probe, and the install completes.
  - "-InstallDeps refuses when the re-probe still fails": the message names the dependency and says the install did not verify.
  - "a version below minVersion counts as missing": a probe printing `harness-fake-hard 1.1.9` refuses.
  - "a hard dependency with no pinned install for this platform refuses with install-by-hand guidance", even with `-InstallDeps`. The mock records no install.
  - "the dependency preflight is skipped by -Audit": `-Audit` with the failing fixture does not throw.
  - "the shipped deps.json validates":
    - `Get-DepsManifest` on the real file passes.
    - `bun` and `git-bash` are `hard` in the kernel, `git-bash` is Windows-only with `resolve: git-bash`, and `bun` on Linux installs through `npm` with `needs: ["npm"]`.
    - There is one `git` entry, mapped `{ "kernel": "optional", "code": "hard" }`.
    - No entry is named `uvx` or `pwsh`, and no install uses `brew`.
    - Every install entry carries an exact version.
  - "Get-DepsManifest rejects a range or tag":
    - `latest`, `1.x`, `>=1.2`, `^1.2.3` and an empty version each throw for winget and npm.
    - For apt, `*` and `>=` throw. The Debian strings `1:2.43.0-1ubuntu7.1` and `1.7.1-1build1` pass.
  - In `install/Install-Account.Tests.ps1`:
    - "a missing hard kernel dependency refuses the account install".
    - "uvx and pwsh are no longer probed".
    - "-InstallDeps -WhatIf runs nothing".

  Existing cases that change. Every changed case is listed here, and no other existing case changes behaviour:
  - **Both suites.** Every existing installer invocation runs with a stub runner that reports every probe present, so no suite probes a real tool.
    - `BeforeAll` defines `$script:dep = @{ DepsRunner = <all-present stub> }`, and each existing `& "$PSScriptRoot/Install-*.ps1"` call gains `@script:dep`. This is a mechanical edit.
    - A spawned `pwsh -File` case (the Task 8 comma-list case) passes `-DepsManifestPath` to a fixture whose one optional entry probes `pwsh --version`.
  - **`Install-Harness.Tests.ps1:33`.** The negative control `Should -Not -Match 'bun is not on PATH'` becomes `Should -Not -Match 'missing hard dependenc'`. The refusal case above is its positive pair.
  - **`Install-Harness.Tests.ps1:1687`, "warns that the gates stop enforcing when bun is not on PATH, and installs anyway".** Inverted and renamed "refuses when bun is missing, because every TypeScript gate would fail open".
    - It drops the emptied-PATH setup and makes bun absent through the mock runner (127).
    - The refusal names `bun` and contains `every TypeScript gate fails open`.
    - The target has no `.claude` afterwards.
  - **`Install-Account.Tests.ps1`, "names <_> as an absent prerequisite".** The list at HEAD is `vale, bun, node, bash, uvx, jq`. It becomes the kernel optional names `deps.json` defines for a Linux target: `vale`, `npm`, `python3`, `op`, `ccstatusline`, plus `jq` while npm is absent. Each is named as a warning. `bun` moves to the refusal case. The case runs through a mock runner returning 127, not an emptied PATH. `Install-Account.ps1` passes `-IsWindows $TargetIsWindows`, not the host's `$IsWindows`, because the suite runs Linux-target cases on the Windows CI leg.
  - **`Install-Account.Tests.ps1`, "still completes the install: preflight warns, it does not gate".** Split in two. With only optional entries missing, the install completes. With a hard entry missing, it refuses.
  - **`Install-Account.Tests.ps1`, "does not offer jq when npm is present", and its npm-absent pair.** Rewritten, because npm presence moves from `-NpmGlobal` to the `npm` probe. With the mock's npm probe present, jq is not named. With the npm probe returning 127, jq is named. The pair must discriminate, and neither runs under the all-present stub.

- [ ] **Step 2: Run to verify they fail.** `pwsh -NoProfile -File install/Install-Harness.Tests.ps1` and `pwsh -NoProfile -File install/Install-Account.Tests.ps1`. Expected: the new cases FAIL.

- [ ] **Step 3: Implement.**
  - **`deps.json`.** It declares the following, one entry per tool. Each `minVersion` comes from the version the repo is tested on (Bun 1.3.14 per the bun-autoload note).

    | Dependency | Severity by layer | Applies to |
    |---|---|---|
    | bun | kernel hard | Both platforms. On Linux it installs through `npm` (`bun@<exact>`), with `needs: ["npm"]` |
    | git-bash | kernel hard | Windows only, with `resolve: git-bash` |
    | git | kernel optional, code hard | Both |
    | vale | kernel optional | Both. No Linux install entry |
    | python3 | kernel optional | Both. The not-ai gate, stdlib only |
    | npm | kernel optional | Both. Probe `npm --version`. It installs the node package that carries npm, for ccstatusline and the Linux bun install |
    | ccstatusline | kernel optional | Both. An npm package |
    | op | kernel optional | Both |
    | jq | kernel optional | Linux only, with `onlyWhenAbsent: "npm"`, keeping today's npm-absent condition |
    | gh, claude | code optional | Both. The pr-review and model-currency tools |

    Each `failMode` is one sentence. For bun and git-bash it reads "every TypeScript (or shell) gate fails open".
  - **Install ids.** Fill winget ids and versions from `winget show --id <id> --versions` output taken while implementing, never from memory. Fill apt versions from `apt-cache policy <pkg>` and npm versions from `npm view <pkg> versions`. Per `security.md`, each pinned version's release is at least 30 days old.
  - **Missing install entry or prerequisite.** A tool with no install entry for this platform (vale on Linux) gets `no pinned install for <platform>: install <name> <minVersion> or later from a pinned release, then re-run`. A tool whose `needs` entry is missing (bun on Linux without npm) names that prerequisite and its pinned command first. Under `-InstallDeps` the prerequisite installs first, then the tool.
  - **Install commands.** Built as argv arrays, never strings:
    - `winget install --id <id> --version <v> --exact --source winget --silent --accept-package-agreements --accept-source-agreements`
    - `sudo apt-get install -y <pkg>=<v>`
    - `npm install -g <pkg>@<v>`, which npm verifies against the registry integrity hash

    brew is not a source, since macOS is not a target receiver. No download-and-execute form is accepted.
  - **`Get-DepsManifest`** throws on:
    - duplicate names
    - an unknown severity, layer, `resolve` value, or `needs`/`onlyWhenAbsent` name
    - an empty probe
    - a version that fails its source's grammar:
      - winget: `^\d+(\.\d+){1,3}$`
      - npm: `^\d+\.\d+\.\d+$`
      - apt: a Debian version string, `^(\d+:)?[0-9][A-Za-z0-9.+~-]*$`, with no `*`, comparison operator or space

    Every refusal comes before any write.
  - **Default runner.** `Invoke-DefaultDepsRunner` resolves `Argv[0]` with `Get-Command -CommandType Application` and returns 127 when that fails.
    - It starts the process with `System.Diagnostics.Process`, with `RedirectStandardInput` set and stdin closed at once. Stdout and stderr are read asynchronously.
    - It waits `TimeoutSeconds`. On expiry it kills the process tree (`Kill($true)`) and returns `TimedOut`.
    - Probes pass 10 and installs pass 900.
  - **Git Bash** (`resolve: git-bash`, Windows only). Implement `Resolve-GitBashPath`:
    - Take the Git root from `git --exec-path` through the runner (three levels up from `mingw64/libexec/git-core`). If that fails, take it from `-GitExe` (two levels up from `cmd/git.exe`). `-GitExe` is the only git-location fallback, so a test can make it miss.
    - Use the first of `<root>/usr/bin/bash.exe` or `<root>/bin/bash.exe` that exists.
    - Reject any path under `System32` or `WindowsApps`.
    - Never probe a bare `bash`.

    The probe argv is `<resolved path> --version`, present only on exit 0 with output matching `GNU bash, version \d+\.\d+`. An unresolved path is absent.
  - **Version parsing.** Use the entry's `versionPattern`, defaulting to the first `\d+(\.\d+)+` in the probe output, and compare as `[version]`. A probe with a non-zero exit, a timeout, or no match is absent.
  - **`Invoke-DepsPreflight`** collects every problem before deciding:
    - **Without `-InstallDeps`.** A missing or old hard dependency throws one message beginning `missing hard dependency`, listing each with its command or the no-pinned-install text. A missing optional one gets `Write-Warning` with its command.
    - **With `-InstallDeps`.** For each available command it calls `-ShouldInstall` first. Under `-WhatIf` that returns false, and the preflight prints its own `WhatIf: would run <argv>` line through `Write-Host` and runs nothing. Otherwise it runs the command through the runner with the install limit and re-probes. A hard dependency that still fails throws, and an optional one warns.
    - Nothing is installed without `-InstallDeps`.
  - **Plugin probes** from part 2 follow the same rules.
    - The plugin list, the marketplace list and the `git rev-parse` pin check go through the runner with the 10-second limit and closed stdin, and anything other than exit 0 within the limit is absent.
    - Marketplace adds, plugin installs and rollbacks go through `-ShouldInstall` with the 900-second limit.
    - Every plugin command carries the working directory the runner contract names.
  - **`Install-Harness.ps1`.**
    - Order: the layer and manifest load, then `Get-SidecarPlan` (which can refuse and writes nothing), then the preflight with `@('kernel') + <resolved layers>`, then the first write. Every refusal, the sidecar's included, therefore comes before any external install under `-InstallDeps`.
    - Never calls it on `-Audit`, `-Accept`, `-Unaccept` or `-Prune`.
    - Adds `-InstallDeps` to Task 8's install-run-only guard, so `-Audit -InstallDeps` throws "applies to an install run only".
    - Under `-WhatIf` it runs the preflight and then returns before the first write with `WhatIf: stopped before writing`. That keeps native writes such as the `core.hooksPath` config from running in a dry run.
    - The bun warning block goes.
  - **`Install-Account.ps1`.** Calls it with the kernel only, in place of `Test-Prerequisite`'s fixed list, passing `$PSCmdlet.ShouldProcess` as `-ShouldInstall`. jq's npm-absent condition is now carried by `onlyWhenAbsent`. `-SkipPreflight` keeps working.
  - **README.** The Install and Account sections list the hard dependencies, the refusal, `-InstallDeps`, `-WhatIf`, and the pinned sources (winget, apt, npm). The sentence saying the installers only warn goes.
  - **Citations.** Re-pin whatever `install/Install-Harness.ps1:1616-1618` and `install/Install-Account.ps1:662-673` citations this task's edits move, then run `bun test test/citation-drift.test.ts`.

- [ ] **Step 4: Run to verify they pass.** Both Pester suites and `bun test`. Expected: all PASS. Then check by hand on this machine that `pwsh -NoProfile -File install/Install-Harness.ps1 -Target <tmp>` passes the real preflight with no warning about bun or Git Bash.

- [ ] **Step 5: Commit.**

```bash
git add core/claude/deps.json install/Deps.ps1 install/Install-Harness.ps1 install/Install-Account.ps1 install/Install-Harness.Tests.ps1 install/Install-Account.Tests.ps1 README.md .github/CODEOWNERS .github/workflows/test.yml
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(install): declared layer dependencies, a refusing preflight, opt-in installs (#310)"
```

#### Task 15, part 2: Claude Code plugins as dependencies

Same task and same PR, as a second test-and-commit cycle on top of Step 5.

**Trust rule** (design for #310):
- **First-party marketplaces are trusted without a commit pin.** These are `claude-plugins-official` (source `anthropics/claude-plugins-official`) and `anthropic-agent-skills` (source `anthropics/skills`). At install the installer records a content hash of the installed plugin directory. Later probes and the drift check warn when it changes.
- **Third-party marketplaces need one of two things:** a real pin verified before the plugin is enabled, or a per-project opt-in carrying a risk sentence.
- **A first-party plugin whose marketplace entry carries its own sha has that sha tracked too.** superpowers is the case. A sha move in the marketplace is how such a plugin updates (7.0.0 to 7.0.2, say), so a mismatch warns, naming the old and new sha so the operator can read the diff. A plain run changes nothing, and `-Audit` keeps reporting `plugin-changed`. Installing the marketplace's version and re-recording both the sha and the content hash happen only under `-InstallDeps`, the same rule as content drift. It never uninstalls or refuses.

**Plugin inventory.** Taken from `enabledPlugins` and `extraKnownMarketplaces` in `account/claude/settings.account.json` at `898ef59` and in the live `~/.claude/settings.json`. The live file adds `document-skills`, `core-presentations`, `core-workflow` and their two marketplaces, which the export leaves out.

| Plugin | Goes to | Scope | Severity | Pin | Reason |
|---|---|---|---|---|---|
| `superpowers@claude-plugins-official` | kernel | user | optional | first-party, marketplace `sha` and hash recorded, a sha move warns and re-records under `-InstallDeps` | Brainstorming owns the start of new efforts on every project type, and plans run through it |
| `code-review@claude-plugins-official` | code | project | optional | first-party, hash recorded | The pull request review flow |
| `feature-dev@claude-plugins-official` | code | project | optional | first-party, hash recorded | The code-architect and code-explorer agents |
| `security-guidance@claude-plugins-official` | code | project | optional | first-party, hash recorded | Edit-time security reminders on code |
| `github@claude-plugins-official` | code | project | optional | first-party, hash recorded | GitHub MCP for pull request and issue work |
| `document-skills@anthropic-agent-skills` | documents | project | optional | first-party, hash recorded, no opt-in | Office file skills |
| `core-presentations@agent-skills-core` | documents | project | optional | `commit` of the directory marketplace, plus the recorded hash | Deck and briefing skills, from a third-party local-folder marketplace |
| `core-workflow@agent-skills-core` | none in Plan A | none | none | none | Duplicates account skills (council, handoff, subagent-prompting). Which copy owns them is the spec's open related observation |
| `caveman@caveman`, `ponytail@ponytail`, `ralph-loop@claude-plugins-official`, `ask-questions-if-underspecified@trailofbits`, `microsoft-docs@claude-plugins-official` | account only | none | none | none | Personal preference or domain tooling, not something a layer relies on |
| Every entry set to `false` (code-simplifier, greptile, commit-commands, claude-md-management, audit-context-building, differential-review, the four `*-master` plugins, claude-code-setup, context7, frontend-design) | none | none | none | none | Not enabled |

Moving plugin skills between layers is Plan C.

**Interfaces:**
- Consumes: Task 15 part 1 (`Get-DepsManifest`, `Invoke-DepsPreflight`, the runner with its working directory).
- Produces:
  - A plugin entry kind in `deps.json`. An entry without `kind` is a tool.

    ```
    { "kind": "plugin", "name", "plugin": "<id>@<marketplace>",
      "marketplace": { "name", "source": { "github": "owner/repo" } | { "git": "<url>" } | { "directory": true } },
      "pin": { "firstParty": true, "sha"?: "<40 hex>" } | { "sha": "<40 hex>", "contentHash": "sha256:<hex>" } | { "commit": "<40 hex>", "contentHash": "sha256:<hex>" } | { "unpinned": true },
      "scope": "user" | "project", "severity", "failMode" }
    ```

    - `firstParty` is valid only for the two first-party marketplace names. Its optional `sha` is the value expected at first install, and later runs compare against the recorded one.
    - A `directory` source carries no path, because a path is machine-specific. The probe takes the path where Claude Code registered that marketplace.
  - `Get-PluginContentHash -Path <dir>` returns `sha256:<64 hex>`.
  - `Test-PluginDep -Dep -Runner -Target <string|null> -RecordedHash <string|null>` returns the `Test-Dep` shape plus `InstallPath`, `Hash` and `Changed`.
  - `Get-PluginInstallCommands -Dep -MarketplaceKnown <bool>` returns `string[][]`.
  - Recorded hashes:
    - Project scope: the sidecar `.claude/.harness-manifest.local.json` key `pluginHashes`.
    - User scope: `<CLAUDE_HOME>/state/harness-plugin-hashes.json`. That folder is outside the exporter's allowlist.
    - Both map `<id>@<marketplace>` to `{ "hash", "sha", "installPath", "version", "recordedAt" }` (`sha` only for first-party entries that carry one), with `recordedAt` in UTC.
    - Project-scope records go through the existing `Get-SidecarPlan` and `Invoke-SidecarPlan` gate. When that gate refuses the sidecar, no hash is recorded, and a warning says plugin drift cannot be checked until the ignore rule is fixed.
  - The project manifest field `allowUnpinnedPlugins: [ { "plugin": "<id>@<marketplace>", "risk": "<sentence>" } ]`, for third-party `unpinned` entries only. `ConvertTo-ManifestV3 -Loaded` (Task 8) checks only its shape: an array of objects with non-empty string `plugin` and `risk`. Whether each name matches an unpinned third-party entry is checked in the preflight, which is the only place that loads `deps.json`.
  - A new audit status, `plugin-changed` (counted), with the response: "re-run the installer with -InstallDeps to re-record after reviewing the change".

- [ ] **Step 6: Verify the CLI.** Read `claude plugin --help`, `claude plugin marketplace --help`, `claude plugin install --help` and `claude plugin uninstall --help` from the installed CLI, or code.claude.com/docs/en/plugins. Record the exact syntax in a comment in `Deps.ps1`:
  - the machine-readable plugin list
  - the marketplace list and the marketplace add
  - the plugin install with `--scope`, and whether it can install without enabling
  - the uninstall or disable at a scope

  Report BLOCKED with the help text if the plugin list has no machine-readable form, or lacks the plugin id, scope, enabled state, project path or install path. The installer never reads an installed commit from the CLI. It hashes the install path itself.

- [ ] **Step 7: Write the failing tests** in `Context 'dependencies'`, with fixture entries and the recording mock runner. The mock records `(argv, cwd)`.
  - "a missing project-scope plugin with -InstallDeps adds its marketplace, installs at project scope in the target, and records the hash":
    - Calls in order: list, marketplace list, marketplace add, install with project scope, list.
    - Every plugin call records cwd equal to the resolved `-Target`.
    - The mock's second list reports an `installPath` under a temp dir.
    - The sidecar's `pluginHashes` entry equals `Get-PluginContentHash` of that dir.
  - "Install-Harness skips user-scope plugins": with a fixture kernel plugin, no plugin command is recorded for it, and the output notes that Install-Account owns user scope. The user-scope install case lives in the Install-Account suite.
  - "a known marketplace is not added again".
  - "a first-party plugin whose content changed warns, and -InstallDeps re-records it": change a file in the temp install dir after recording. A plain run warns `changed since recorded`, `-Audit` reports `plugin-changed`, and an `-InstallDeps` run re-records the new hash.
  - "Get-PluginContentHash is order- and line-ending-stable": the same files created in a different order, or with CRLF in place of LF, give the same hash. Changing one byte of content, or renaming a file, changes it.
  - "a first-party plugin's sha move warns, and -InstallDeps re-records":
    - A superpowers-like fixture (`firstParty` with `sha`) has its sha and hash recorded.
    - The mock's marketplace file now lists another sha, and its install dir has different content.
    - A plain run warns, naming both shas, records no install argv, and leaves the record unchanged.
    - An `-InstallDeps` run installs the marketplace's version, and the record then holds the new sha and the new hash.
    - Neither run records an uninstall argv or refuses.
  - "a third-party sha-pinned plugin is checked before install". The mock's registered marketplace file lists the plugin with another sha. Expected: refusal for a hard entry or a warning for an optional one, and no install argv recorded.
  - "a third-party pinned plugin is rolled back when the installed copy does not verify":
    - The install succeeds, and the installed dir's hash differs from the entry's `contentHash` (or the directory marketplace's `git rev-parse` returns another commit).
    - The next recorded call is the uninstall at the same scope and cwd. A hard entry then refuses, and an optional one warns.
  - "a plugin present but not enabled at the declared scope counts as missing".
  - "an unpinned third-party plugin is refused without the project opt-in": no install is recorded. With an opt-in entry carrying a `risk`, the preflight proceeds and the warning quotes the risk.
  - "plugin list output is never echoed":
    - The mock's list output carries an MCP server entry with `"Authorization": "Bearer harness-secret-<guid>"`.
    - Across a failing run and a passing run, the secret appears in no captured stream (`*>&1`), no thrown message, no warning and no written file.
  - "Install-Account handles only user-scope plugins": it probes `superpowers` with cwd at the home directory, and skips a fixture project-scope entry with the note `project-scope plugin <id> is installed per project by Install-Harness`.
  - "the shipped deps.json plugin entries validate":
    - Kernel plugins are user scope and layer plugins are project scope.
    - `firstParty` appears only on the two first-party marketplaces.
    - `superpowers` is `firstParty` with a `sha` and no `contentHash`, and `core-presentations` carries `commit` and `contentHash`.
    - `document-skills` is first-party with no opt-in.
    - `caveman` and `ponytail` are absent.

- [ ] **Step 8: Run to verify they fail.** `pwsh -NoProfile -File install/Install-Harness.Tests.ps1` and `pwsh -NoProfile -File install/Install-Account.Tests.ps1`. Expected: the new cases FAIL.

- [ ] **Step 9: Implement.**
  - **Content hash.** `Get-PluginContentHash` does the following:
    - List every regular file under the directory recursively, skipping any `.git` directory. Symlinks are not followed, and each one contributes `link:<target>` in place of content.
    - Order by the relative path with `/` separators, compared ordinally on its UTF-8 bytes.
    - For each file, hash the content with SHA-256 after converting CRLF to LF. A file holding a NUL byte is hashed raw.
    - Feed `<relative path>\n<file hex>\n` for every file, in order, into one SHA-256, and format the result as `sha256:<hex>`.
  - **Probe.**
    - Run the plugin list through the runner with the working directory the scope needs. Parse it in memory only.
    - Present means the id is listed at the declared scope and enabled there. For project scope the project path must equal `-Target`.
    - Then hash `installPath` and compare with the recorded hash (first-party) or the entry's `contentHash` (pinned).
    - Captured output never reaches a message, a warning, a log or a file. Messages name the plugin id and the field that failed, nothing more.
  - **Pins.**
    - Third-party `sha` and `commit` entries carry a `contentHash`, computed while implementing from a verified install of the pinned version.
    - A first-party entry with a `sha` compares the marketplace entry's current `source.sha` against the recorded sha, or against `pin.sha` before the first record. On a mismatch it warns with both values. Only under `-InstallDeps` does it install the marketplace's version and re-record sha and hash. The rollback below never applies to first-party entries.
    - Before any install of a third-party `sha` entry, read the plugin's entry in the registered marketplace's `marketplace.json`, located through the marketplace list, and require its `source.sha` to equal `pin.sha`. A mismatch installs nothing.
    - A `commit` entry compares `git -C <registered path> rev-parse HEAD`, run through the runner, before installing.
  - **Verify, then enable.**
    - If Step 6 found an install-without-enable form, install disabled, verify the hash, then enable.
    - Otherwise install and verify at once, and on a mismatch run the uninstall at that scope and cwd. A hard entry then refuses, and an optional one warns.
    - First-party entries record their hash after a successful install.
  - **`-InstallDeps` on a first-party plugin** that is present but changed re-records the new hash after printing the warning. A plain run only warns.
  - **Unpinned third-party plugins** are processed only when the project manifest's `allowUnpinnedPlugins` names them, and the warning quotes the recorded `risk` on every install run.
  - **Audit.** `-Audit` hashes each project-scope recorded `installPath` without calling the CLI, and reports `plugin-changed` on a difference.
  - **Scope ownership.** Install-Harness handles project-scope plugins only and skips user-scope entries with a note. Install-Account owns user scope through its existing `-ClaudeHome`, so Install-Harness reads no user-home path and needs no home seam.
  - **`Install-Account`** handles user-scope entries only, with cwd at the home directory. It skips project-scope entries with the note above.
  - **Scope rules.** `Get-DepsManifest` throws when:
    - a kernel plugin is not user scope
    - a layer plugin is not project scope
    - `firstParty` names another marketplace
    - a third-party entry has none of `sha`, `commit` or `unpinned`

- [ ] **Step 10: Run to verify they pass, then commit.** Both Pester suites. Expected: all PASS.

```bash
git add core/claude/deps.json install/Deps.ps1 install/Install-Harness.ps1 install/Install-Account.ps1 install/Install-Harness.Tests.ps1 install/Install-Account.Tests.ps1
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(install): Claude Code plugins in the layer dependency manifest (#310)"
```

## Out of scope, recorded

- Plan B (the init interview, and a decision-log template if one is wanted) and Plan C (documents and physical rule content, and the office toolchain probe).
- Gating agents and hooks by layer. Plan A installs them for every layer and relies on the self-checks.
- Mirroring the `subagent-prompting` skill fix into the separate `agent-skills-core` repository.
- The #294 report that the model-tier hook demands xhigh effort. The spec files it separately.
- An `eol` rule for `core/claude/rules/` in `.gitattributes`. It is a pre-existing pattern shared with `core/claude/agents/`, and any `.gitattributes` change is an admin-bypass merge.
