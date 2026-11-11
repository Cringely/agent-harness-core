# Harness Layering Plan A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation the layered harness needs: a write-scope gate with no scratch-parent hole, a worktree gate that checks its own preconditions, a versioned manifest that records layers and settings, an installer that copies layer rules into projects, the move of the code-layer rules out of the account layer, and a model currency check.

**Architecture:** Layer rules live as files in `core/claude/rules/`, with `core/claude/rules/layers.json` saying which layers each file belongs to and what the project settings mean. `Install-Harness.ps1` reads the layers and settings recorded in the project's committed manifest (schema version 3), copies the matching rules into `.claude/rules/harness/`, and renders the settings into a generated rule file beside them. The account layer keeps the kernel. The move happens in two phases (copy into core, then remove from `~/.claude` after every installed project carries the copy) so no machine is left with neither copy.

**Tech Stack:** Bun and TypeScript for hooks and tools (`bun test`), PowerShell 7 with Pester 5 for the installers, POSIX sh and bash for shell hooks.

**Spec:** `docs/superpowers/specs/2026-11-11-harness-layering-design.md` (tracking issue #310). Model findings: the 2026-11-11 model pin audit, whose table the coordinator holds in the session scratchpad. Task 4 restates every finding it acts on.

## Global Constraints

- Public repository. Nothing identifying the operator reaches it. Rule text copied into `core/` is copied from the exported, redacted `account/claude/` tree at a commit, never from `~/.claude` directly.
- Commits: `git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit ...`. No attribution trailer, no session link. A commit message never mentions reviews or findings.
- Every isolated write dispatch carries a `BASE-SHA: <sha>` line. The agent compares it with its worktree HEAD before touching a file and aborts on a mismatch. Worktree agents commit only. The coordinator pushes.
- Tests: `bun test` from the repo root. Pester as `pwsh -NoProfile -File install/<name>.Tests.ps1`, never bare `Invoke-Pester` (it exits 0 on failure).
- PowerShell: wrap any output you index, count or iterate in `@()`. Filter a possibly-null source with `Where-Object { $_ }` before wrapping. Join multi-line native output with `-join "`n"` before a substring check.
- Every matcher that reads a repo file is CRLF-agnostic: split on `/\r?\n/` in TypeScript, use `\r?$` in regexes, and normalise `"\r\n"` to `"\n"` on both sides before comparing text in PowerShell.
- Timestamps are UTC at the point of formatting (`Get-Date -AsUTC`, `toISOString()`).
- A new executable artifact carries its registration (hook entry, installer copy path, or documented invocation) in the same commit.
- A gate's test pins its refusal and its allow.
- `account/claude/` is generated. Source edits happen under `~/.claude` on the operator's machine, then `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff account/claude` is reviewed and only the paths belonging to the change are staged. Task 8 is the one exception and says how it reconciles.
- Layer names are exactly `code`, `documents`, `physical`. The kernel is implied and never listed. The CLI value `none` means an empty layer list.
- Manifest `schemaVersion` is `3`.
- A probe that cannot answer fails closed: the gate behaves as it does today.
- One PR per task group. The App reviewer is the merge gate. Every PR body carries a `Docs: README ...` verdict line. README and rule-file prose follows `writing-style.md` (the Vale hook lints on write).

## Review Focus

1. A project checked out under a scratch-named ancestor whose spelling differs in case from the path being written (`C:\Scratch\repo` against `c:\scratch\repo\src\a.ts`): the write must still be denied. Test in Task 1.
2. A session whose cwd is a subfolder of a repository, or a linked worktree where `.git` is a file: the worktree gate must still treat it as a repository and deny an unisolated writer. Test in Task 2.
3. A hand-edited manifest whose `layers` is a string, names `kernel`, or names an unknown layer: the installer must throw before writing anything. Test in Task 7.
4. A re-run that drops a layer whose rule file the project edited: the file stays on disk, a warning names it, and the audit counts it. Test in Task 7.
5. The model check run with no API key, no `--latest` file and `--no-resolve`: it must exit 2 and say the latest models are unknown, never report a pin as current. Test in Task 3.

## Rule inventory

Source: `account/claude/rules/` at `898ef59`, plus the account agents, skills and hooks. The kernel stays in the account layer. Files assigned to a layer move to `core/claude/rules/` in Task 6 and leave the account layer in Task 10.

| File | Goes to | Reason |
|---|---|---|
| `rules/agent-usage.md` | kernel | Model-tier routing is its core (spec kernel item 8), and both field reports dispatched agents on non-code projects |
| `rules/challenge-mandate.md` | kernel | Spec kernel item 7 |
| `rules/change-management.md` | code, except the section "Deliverables Do Not Live in the Scratchpad", which becomes kernel file `rules/durable-deliverables.md` | Homelab change control, commit and push, and invariants are code and infrastructure practice. Durable deliverables is kernel item 4 |
| `rules/coordinator-output.md` | code | Silent mid-run is the code default. #308 shows it is wrong for documents work, which the status cadence setting now governs |
| `rules/fix-quality.md` | code, except the section "Work has to be able to end", which becomes kernel file `rules/bounded-review.md` | Producer fixes, complexity receipts and cache inputs are code-fix discipline. Bounded review is kernel item 6 |
| `rules/harness-core.md` | kernel | Carries the export flow and the install nudge, which every folder needs |
| `rules/no-overclaim.md` | kernel | Kernel item 3 |
| `rules/obsidian.md` | kernel (account infrastructure) | Memory sync is per person, not per project type |
| `rules/security.md` | kernel | Kernel items 1 and 2. The anti-goals forbid weakening it anywhere |
| `rules/ssh.md` | kernel (account infrastructure) | Per-workstation SSH config |
| `rules/subagent-prompting.md` | kernel | Brief failures recur on every project type that dispatches agents |
| `rules/writing-style.md` | code, documents, physical | Register becomes a project setting (`audience`). Every layer produces prose. A folder with no manifest no longer gets it, per the operator's kernel-only ruling for such folders |
| `rules/*.local.md` (never exported) | stay in `~/.claude/rules` | Machine overlays. `change-management.local.md` keeps loading on this machine |
| `agents/*.md` (8 defs) | stay in account | A def costs nothing until dispatched. The four domain defs are barred from core by `CONTRIBUTING.md` ("never in core") |
| `skills/*` (16 skills) | stay in account | A skill loads only on its trigger. `engineering-method` mirrors principles that do not change here |
| `hooks/harness-core-reminder.sh` | kernel | Becomes the one-time nudge (Task 8) |
| `hooks/Scan-MemorySecrets.ps1` | kernel | Leak protection |
| `hooks/Lint-DocumentProse.ps1` | stays in account | Lints prose writes in every folder. Moving hooks between layers is outside Plan A |
| `hooks/Guard-SkillSize.ps1`, `Sync-MemoryToObsidian.ps1`, `memory-proposal-digest.ts` | stay in account | Account infrastructure |
| `model-tier-gate.ts` (sourced from core) | kernel | Already wired in both the account settings and the project template. No change |
| `settings.account.json` | stays in account | No change |

Agents and hooks installed by `Install-Harness.ps1` stay ungated by layer in Plan A. The self-checks in Tasks 1 and 2 are what make them safe on a project that is not code.

## Interfaces for Plans B and C

- `pwsh install/Install-Harness.ps1 -Target <dir> [-Layers code,documents,physical|none] [-StatusCadence silent|heartbeat] [-Audience peer-engineer|plain-all-roles] [-LengthBudget <int>]`. Re-runnable. `-LengthBudget 0` clears the budget. Prints one line `Layers: <list>. Settings: statusCadence=<v>, audience=<v>, lengthBudgetDefault=<n|none>.`
- Manifest `.claude/.harness-manifest.json` fields `schemaVersion` (3), `layers` (string array), `settings` (`statusCadence`, `audience`, `lengthBudgetDefault`). The interview reads these as its recommended answers.
- `core/claude/rules/layers.json`: `rules` maps file name to layer list, `settings` holds each setting's values and their rule text. Plan C adds documents and physical rule files here. Plan B reads the settings values for its questions.
- `account/claude/hooks/harness-core-reminder.sh` nudge text. Plan B replaces the installer command in it with the interview skill's name.

## Task groups

| Group | Branch | Tasks | Who |
|---|---|---|---|
| A1 gates | `feat/310-gates` | 1, 2 | agents |
| A2 model currency | `feat/310-model-currency` | 3, 4 | agent, then coordinator |
| A3 layers | `feat/310-layers` | 5, 6, 7, 8, 9 | coordinator preflight, then agents |
| A4 cutover | `feat/310-cutover` | 10, 11, 12 | coordinator on the operator's machine, then agents |

A4 starts only after A3 merges. A1, A2 and A3 are independent of each other.

---

### Task 1: Close the scratch-parent gap in the write-scope gate

**Files:**
- Modify: `core/claude/hooks/agent-write-scope.ts` (header paragraph "Second coverage boundary", `inScratch`, `decide`, the `import.meta.main` block)
- Test: `test/agent-write-scope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `inScratch(filePath: string, cwd: string, projectDir: string): boolean` and `decide(scope: string | null, filePath: string | undefined, cwd: string, projectDir: string): Decision`. Task 2 relies on the semantics: a scratch-named directory counts only when it does not contain the project root.

- [ ] **Step 1: Write the failing tests.** Add a describe block "inScratch(): a scratch-named ancestor of the project is not scratch". Update every existing `inScratch`/`decide` call to pass `CWD` as `projectDir`.

```ts
const PROJ = "/home/x/scratch/myrepo";
test("a file inside a project checked out under a scratch folder is out of scope", () => {
  expect(inScratch(`${PROJ}/src/index.ts`, PROJ, PROJ)).toBe(false);
});
test("a sibling under the same scratch ancestor is out of scope", () => {
  expect(inScratch("/home/x/scratch/other/f.md", PROJ, PROJ)).toBe(false);
});
test("the project's own .claude/scratch is still in scope", () => {
  expect(inScratch(`${PROJ}/.claude/scratch/r.md`, PROJ, PROJ)).toBe(true);
});
test("a session scratchpad outside the project is still in scope", () => {
  expect(inScratch("/tmp/claude/s/scratchpad/r.md", PROJ, PROJ)).toBe(true);
});
test("containment ignores case, so a case-variant ancestor still fails closed", () => {
  expect(inScratch("/home/x/scratch/myrepo/src/a.ts", "/home/x/Scratch/myrepo", "/home/x/Scratch/myrepo")).toBe(false);
});
test("decide denies a scoped write into a project under a scratch folder", () => {
  expect(decide("scratch", `${PROJ}/src/index.ts`, PROJ, PROJ).action).toBe("deny");
});
```

Add a spawned-process case: build `<tmp>/scratch/proj/.claude/agents/scoped.md` with `writeScope: scratch`, run the hook with `CLAUDE_PROJECT_DIR=<tmp>/scratch/proj`, `agent_type: "scoped"`, `file_path: <tmp>/scratch/proj/src/x.ts`, and assert exit 0 with a deny JSON on stdout.

- [ ] **Step 2: Run to verify they fail.** `bun test test/agent-write-scope.test.ts`. Expected: the new cases FAIL (today any scratch segment counts).

- [ ] **Step 3: Implement.** In `inScratch`, split the resolved file path and the resolved `projectDir` into segments on `/[\\/]+/`. A segment at index `i` whose lowercased name is in `SCRATCH_SEGMENTS` counts only when the project's segments do not start with the file's segments `0..i` (compare lowercased, on every platform: case-insensitive containment can only add denies). `decide` passes `projectDir` through. The entrypoint passes the value it already computes for `readWriteScope` (`process.env.CLAUDE_PROJECT_DIR ?? cwd`). Replace the "Second coverage boundary" header paragraph with two sentences: a scratch-named directory counts only when it does not contain the project root, so a checkout under `/home/x/scratch/` no longer puts the project in scope, and a project whose root sits inside a scratch directory gets denies for every scoped write outside a deeper scratch folder, which is the fail-closed direction.

- [ ] **Step 4: Run to verify they pass.** `bun test test/agent-write-scope.test.ts`, then `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add core/claude/hooks/agent-write-scope.ts test/agent-write-scope.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "fix(write-scope): a scratch-named ancestor no longer puts the project in scope (#310)"
```

---

### Task 2: Worktree gate checks its own preconditions

**Files:**
- Modify: `core/claude/hooks/agent-worktree-gate.ts` (header, `BUILTIN_READ_ONLY`, `frontmatterRequiresIsolation`, `GateDecision`, `decide`, entrypoint)
- Test: `test/agent-worktree-gate.test.ts`

**Interfaces:**
- Consumes: Task 1's containment rule. The gate trusts `writeScope: scratch` only because Task 1 made that scope mean "scratch folders that do not contain the project". Task 2 lands after Task 1 in the same PR.
- Produces: `export type GitProbe = "repo" | "not-repo" | "unknown"`, `export function probeGitWorkTree(cwd: string, env?: Record<string, string | undefined>): GitProbe`, `export function nonGitNote(cwd: string): string`, `GateDecision = { action: "allow"; note?: string } | { action: "deny"; reason: string }`, `decide(payload: unknown, agentsDir?: string, probe?: (cwd: string) => GitProbe): GateDecision`.

- [ ] **Step 1: Write the failing tests.**

Probe (real temp dirs):
- `probeGitWorkTree(dirWithGitDir)` is `"repo"`, and so is a subfolder of it (Review Focus 2).
- A dir holding a `.git` file (the linked-worktree shape) is `"repo"` (Review Focus 2).
- A path that does not exist is `"unknown"`.
- Any dir with `env = { GIT_DIR: "/x" }` is `"repo"`.
- A fresh `mkdtempSync(tmpdir())` is `"not-repo"`, skipped with `test.skipIf` when a `.git` exists in any ancestor of `tmpdir()`.

Decide (stub probe, write-capable type `writer`, no isolation, no override):
- probe `"not-repo"` with payload `cwd: "/w"`: `{ action: "allow", note: nonGitNote("/w") }`, and the note contains `is not a git repository` and `git init`.
- probe `"repo"`: deny, reason unchanged.
- probe `"unknown"`: deny.
- payload without `cwd`: deny, and the stub records zero calls.
- read-only type `reader` with probe `"not-repo"`: `{ action: "allow" }` with no `note`, stub not called.

Write-scope trust (`requiresIsolation`, real def files):
- `tools: Read, Grep, Glob, WebFetch, WebSearch, Write, SendMessage` plus `writeScope: scratch`: `false`.
- The same with `Bash` added, or `PowerShell`, `Agent`, `Skill`, `mcp__x__y`, or `*`: `true`.
- The same tools with no `writeScope`: `true`. With `writeScope: repo`: `true`. With `memory: user` added: `true`.
- `web-fetch` with no def file: `false`. A `web-fetch.md` def granting `Write` with no `writeScope`: `true`.

Spawned process: payload with `cwd` set to a non-git temp dir (same skip guard), `subagent_type: "general-purpose"`, no isolation. Assert exit 0, stdout parses as JSON with `systemMessage` equal to the note and `hookSpecificOutput.additionalContext` equal to the note, and no `permissionDecision` key.

- [ ] **Step 2: Run to verify they fail.** `bun test test/agent-worktree-gate.test.ts`. Expected: FAIL on the new exports and cases.

- [ ] **Step 3: Implement.**
  - `probeGitWorkTree`: `"repo"` when `env.GIT_DIR` or `env.GIT_WORK_TREE` is a non-empty string. Otherwise `"unknown"` if `cwd` is not an existing directory, then walk from `resolve(cwd)` to the filesystem root and return `"repo"` at the first `.git` entry (file or directory), `"not-repo"` at the root. Any thrown error returns `"unknown"`. No git binary is spawned.
  - `nonGitNote(cwd)` returns exactly: `` Worktree gate: ${cwd} is not a git repository, so worktree isolation is not available and this dispatch runs in the shared folder. If this work should be versioned, run `git init` here and the gate will isolate concurrent writers. ``
  - In `decide`, after `requiresIsolation` returns true and before the isolation branch: when `p.cwd` is a non-empty string and `probe(p.cwd) === "not-repo"`, return the allow with the note.
  - `BUILTIN_READ_ONLY` gains `"web-fetch"` (its published grant is WebFetch only).
  - `frontmatterRequiresIsolation`: after the `memory:` check and the tools parse, return `false` when the frontmatter has a line matching `/^writeScope:\s*scratch\s*$/m` and every tools token is in `READ_ONLY_TOOLS` or in a new `SCOPED_WRITE_TOOLS = new Set(["write", "edit", "notebookedit", "sendmessage"])`. Comment why: `agent-write-scope.ts` reads this same file and confines those writes, and with no shell the confinement holds.
  - Entrypoint: when the decision is an allow with a note, print `{"systemMessage": note, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}}`. A plain allow still prints nothing.
  - Header: replace "No network, no git" with the probe's contract (filesystem only, no git spawned, unknown keeps today's behaviour), and add one paragraph on the scoped-writer rule naming Task 1's fix as its precondition.

- [ ] **Step 4: Run to verify they pass.** `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add core/claude/hooks/agent-worktree-gate.ts test/agent-worktree-gate.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(worktree-gate): allow with a note outside git, trust shell-less scratch writers (#310)"
```

PR A1 body: `Docs: README still accurate: the hooks row names the gates without describing their decisions`.

---

### Task 3: Model currency check

**Files:**
- Create: `tools/model-currency/check.ts`
- Test: `test/model-currency.test.ts`
- Modify: `README.md` ("What's here" table, one row for `tools/model-currency/`)

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `tools/model-currency/check.ts`:
  - `type Family = "fable" | "opus" | "sonnet" | "haiku"`
  - `interface ModelId { family: Family; major: number; minor: number; date: string | null; raw: string }`
  - `parseModelId(id: string): ModelId | null`
  - `compareModelIds(a: ModelId, b: ModelId): number` (major, then minor. Dates ignored)
  - `latestByFamily(ids: string[]): Partial<Record<Family, string>>`
  - `interface Finding { file: string; line: number; value: string; kind: "pin" | "alias" }`
  - `scanText(file: string, text: string): Finding[]`
  - `interface LatestTable { source: "api" | "file" | "alias"; models: Partial<Record<Family, string>> }`
  - `interface Row { status: "current" | "behind" | "stale-alias" | "unknown"; file: string; line: number; value: string; latest: string | null }`
  - `classify(findings: Finding[], latest: LatestTable | null, resolved: Partial<Record<Family, string | null>>): Row[]`
  - `fetchLatestFromApi(apiKey: string | undefined, fetchImpl: typeof fetch): Promise<LatestTable | null>`
  - `type ClaudeRunner = (args: string[]) => { code: number; stdout: string }`
  - `resolveAlias(alias: Family, runClaude: ClaudeRunner): string | null`
  - `interface RunDeps { env: Record<string, string | undefined>; fetchImpl: typeof fetch; runClaude: ClaudeRunner }`
  - `run(argv: string[], deps: RunDeps): Promise<{ exitCode: 0 | 1 | 2; output: string }>`
  - CLI: `bun tools/model-currency/check.ts [--root <dir>]... [--latest <file.json>] [--no-resolve]`

- [ ] **Step 1: Write the failing tests.** Lines that hold test model IDs carry the marker `model-currency: ignore`.

```ts
expect(parseModelId("claude-opus-5-5")).toMatchObject({ family: "opus", major: 5, minor: 5, date: null });
expect(parseModelId("claude-sonnet-4-20250514")).toMatchObject({ family: "sonnet", major: 4, minor: 0, date: "20250514" });
expect(parseModelId("claude-sonnet-5")).toMatchObject({ family: "sonnet", major: 5, minor: 0 });
expect(parseModelId("claude-3-5-sonnet-20241022")).toMatchObject({ family: "sonnet", major: 3, minor: 5 });
expect(parseModelId("sonnet")).toBeNull();
expect(latestByFamily(["claude-opus-5", "claude-opus-5-5", "claude-haiku-5-5"])).toEqual({ opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" });
```

`scanText` finds a pin in `--model claude-sonnet-5` with its 1-based line, an alias in a frontmatter line `model: sonnet`, in JSON `"model": "opus"` and in `--model haiku`. It returns nothing for prose "Opus 5" and for any line containing `model-currency: ignore`.

`classify`, with latest `{ source: "api", models: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } }`: pin `claude-sonnet-5` is `behind`, pin `claude-opus-5-5` is `current`, alias `sonnet` resolved to `claude-sonnet-5` is `stale-alias`, alias `opus` resolved to `null` is `unknown`, a `haiku` pin with no latest entry is `unknown`.

`resolveAlias("sonnet", stub)` with stdout `{"modelUsage":{"claude-sonnet-5-5":{},"claude-haiku-5-5":{}}}` returns `claude-sonnet-5-5`. A non-zero code or unparsable stdout returns `null`.

`fetchLatestFromApi(undefined, spy)` returns `null` and never calls `spy`. With a stub returning `{"data":[{"id":"claude-opus-5"},{"id":"claude-opus-5-5"}]}` it returns `{ source: "api", models: { opus: "claude-opus-5-5" } }`. A throwing fetch returns `null`.

`run` over a temp root holding one file with `--model claude-sonnet-5`:
- Review Focus 5: `env` with no `ANTHROPIC_API_KEY`, no `--latest`, `--no-resolve`: `exitCode` 2, output contains `latest unknown`, and no output line starts with `current`.
- With `--latest` pointing at `{"sonnet":"claude-sonnet-5-5"}`: `exitCode` 1, a `behind` row.
- With every pin current: `exitCode` 0.

- [ ] **Step 2: Run to verify they fail.** `bun test test/model-currency.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Implement.**
  - Pin patterns: `claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?` with a word boundary at the end, and the older shape `claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)(?:-(\d{8}))?`. Alias patterns: `^\s*model:\s*(fable|opus|sonnet|haiku)\s*$`, `"model"\s*:\s*"(fable|opus|sonnet|haiku)"`, `--model[ =](fable|opus|sonnet|haiku)\b`.
  - Walk each `--root` (default `process.cwd()`), skipping `.git`, `node_modules`, `runs` directories, files named `*.bak*`, files over 2 MB and files containing a NUL byte.
  - Latest source order: the Models API (`GET https://api.anthropic.com/v1/models?limit=1000`, headers `x-api-key` and `anthropic-version: 2023-06-01`), then the `--latest` JSON file, then the live alias resolutions with source `alias`. Print a first line naming the source. For `alias` the line adds `(unverified: an alias can itself resolve to an older model)`.
  - The default `ClaudeRunner` runs `claude -p --model <alias> --output-format json "Reply with the single word OK."` with cwd set to a fresh empty temp dir, and removes the dir afterwards. Only `modelUsage` keys are read. The response text is never printed.
  - Output rows: `<status>\t<file>:<line>\t<value>\t<latest or ->`.
  - Exit 1 when any row is `behind` or `stale-alias`, else 2 when any row is `unknown` or no latest source was found, else 0.
  - README row: `| tools/model-currency/ | The kernel's model currency check: every exact model ID and tier alias under the roots given, against the latest models, with aliases resolved live. Run by hand. Nothing installs it |`

- [ ] **Step 4: Run to verify they pass.** `bun test`. Expected: all PASS. Then `bun tools/model-currency/check.ts --root . --no-resolve` from the worktree root. Expected: exit 2 with `latest unknown` (no key, no file), and the `claude-sonnet-5` pin at `install/Start-CappedCopilot.ps1:59` listed.

- [ ] **Step 5: Commit.**

```bash
git add tools/model-currency/check.ts test/model-currency.test.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(model-currency): check model pins and aliases against the latest models (#310)"
```

---

### Task 4: Stale model prose and the kernel pointer (coordinator, operator's machine)

The edits are under `~/.claude`, so the coordinator does them on the operator's machine, in the main clone, on branch `feat/310-model-currency` after Task 3's commit.

**Files:**
- Modify (source): `~/.claude/skills/subagent-prompting/SKILL.md`, `~/.claude/rules/subagent-prompting.md`, `~/.claude/rules/agent-usage.md`
- Modify (repo, after export): `account/claude/skills/subagent-prompting/SKILL.md`, `account/claude/rules/subagent-prompting.md`, `account/claude/rules/agent-usage.md`
- Maybe modify: `install/Start-CappedCopilot.ps1:59`

**Interfaces:**
- Consumes: Task 3's CLI.
- Produces: nothing later tasks call.

- [ ] **Step 1: Dispatch the source read.** `research-scout` (it holds Write scoped to scratch), `model: sonnet`. Until group A1 merges, the worktree gate still requires isolation for this type, so the dispatch carries an `ISOLATION-OVERRIDE:` line naming its scratch-only write scope. Brief: read Anthropic's current model documentation for Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.2, and report for each: effort support and levels, adaptive or extended thinking support, and any published guidance on delegation or self-verification behaviour, each with the URL and a quoted line. The report goes to `<scratchpad>/model-docs-report.md`.

- [ ] **Step 2: Apply the findings in `~/.claude`.**
  - `skills/subagent-prompting/SKILL.md`: rewrite the Haiku 4.5 row (lines near 3, 77 and 79) for Haiku 5.5 from the report. Relabel the Fable 5, Opus 5 and Sonnet 5 tables (lines near 74-76, 83-99, 114-116) to the current point releases where the report confirms the claim, and label the rest "measured on 5.0, unverified on 5.x". Leave the historical Opus 4.x comparisons alone.
  - `rules/subagent-prompting.md:15` and `rules/agent-usage.md:24`: "Opus 5" becomes "Opus 5.x" when the report confirms the over-delegation and self-verification claims for Opus 5.5, otherwise add "(measured on Opus 5.0)".
  - `rules/agent-usage.md`, after the sentence that starts "Verify what an alias resolves to": add "The core repo's `tools/model-currency/check.ts` runs that check for every alias and exact model ID under the roots it is given, against the latest models."

- [ ] **Step 3: Copilot pin.** Run `copilot help config` (or the Copilot CLI's model listing). If it names a Sonnet 5.5 model, change the `--model` example at `install/Start-CappedCopilot.ps1:59` to that name. Leave the test fixture at `install/Start-CappedCopilot.Tests.ps1:71`: its value is an arbitrary passthrough. If the listing is unavailable, change nothing and record it in the PR body.

- [ ] **Step 4: Export and stage.** `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff --stat account/claude`. Stage only the three paths above (and the Copilot file if changed).

- [ ] **Step 5: Run the check.** `bun tools/model-currency/check.ts --root "$USERPROFILE/.claude" --root .`. Expected residual rows: `behind` for the `claude-opus-5` key in `~/.claude/settings.json` (harmless, audit item 3, kept by choice) and for the third-party example under `~/.claude/skills/synced/` (overwritten on sync). Any other `behind` or `stale-alias` row is fixed before commit.

- [ ] **Step 6: Commit.**

```bash
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "docs(account): current model names in the briefing guidance (#310)"
```

PR A2 body: `Docs: README updated: tools/model-currency row`.

---

### Task 5: Preflight for the rule move (coordinator, operator's machine)

- [ ] **Step 1: Export.** In the main clone on an up-to-date `master`: `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff --stat account/claude/rules`.
- [ ] **Step 2: Land any drift first.** If the diff is not empty, it lands through its own PR before group A3 starts. The rule files the move copies must be the operator's current text.
- [ ] **Step 3: Record the base.** After that merge, a second export shows no diff under `account/claude/rules`. That `master` sha is the `BASE-SHA` for Task 6. From here until Task 10, edits to the four moving files in `~/.claude/rules` are held, or ported into `core/claude/rules` by a follow-up commit. Task 6's transition test turns red on any divergence.

---

### Task 6: Copy the code-layer rules into core

**Files:**
- Create: `core/claude/rules/change-management.md`, `core/claude/rules/coordinator-output.md`, `core/claude/rules/fix-quality.md`, `core/claude/rules/writing-style.md`, `core/claude/rules/layers.json`
- Create: `test/layer-rules.test.ts`
- Modify: `.github/CODEOWNERS`, `tools/pr-review/types.ts` (`TRUSTED_CONTEXT_PATHS`), `README.md` ("What's here")

**Interfaces:**
- Consumes: the `BASE-SHA` from Task 5.
- Produces: `core/claude/rules/layers.json` with shape `{ "schemaVersion": 1, "rules": { "<file>.md": ["code" | "documents" | "physical", ...] } }`. Task 7 adds a `settings` key. Exported from `test/layer-rules.test.ts`: `KERNEL_SECTIONS: Record<string, string[]>` and `withoutSections(text: string, headings: string[]): string`.

- [ ] **Step 1: Write the failing test** `test/layer-rules.test.ts`:
  - "every rule listed in layers.json exists in core/claude/rules"
  - "every .md file in core/claude/rules is listed in layers.json"
  - "layer names are only code, documents and physical, and every list is non-empty"
  - "while the account copy exists, the core copy is the account copy minus its kernel sections": for each listed file, when `account/claude/rules/<file>` exists, `normalise(core)` equals `withoutSections(normalise(account), KERNEL_SECTIONS[file] ?? [])`, where `normalise` turns `\r\n` into `\n`. When the account copy is absent the case is skipped with a message naming Task 11.

```ts
export const KERNEL_SECTIONS: Record<string, string[]> = {
  "change-management.md": ["## Deliverables Do Not Live in the Scratchpad"],
  "fix-quality.md": ["## Work has to be able to end"],
};
```

`withoutSections` splits on `"\n"`, and for each heading removes the lines from the exact heading line up to, not including, the next line that starts with `## `, or to the end. It throws when a heading is absent, so a renamed section fails the test instead of passing vacuously.

- [ ] **Step 2: Run to verify it fails.** `bun test test/layer-rules.test.ts`. Expected: FAIL, `layers.json` missing.

- [ ] **Step 3: Create the files.**
  - `coordinator-output.md` and `writing-style.md`: `git show <BASE-SHA>:account/claude/rules/<file> > core/claude/rules/<file>`.
  - `change-management.md` and `fix-quality.md`: the same, then delete the kernel section named in `KERNEL_SECTIONS` by the rule `withoutSections` applies. Change nothing else.
  - `layers.json`:

```json
{
  "schemaVersion": 1,
  "rules": {
    "change-management.md": ["code"],
    "coordinator-output.md": ["code"],
    "fix-quality.md": ["code"],
    "writing-style.md": ["code", "documents", "physical"]
  }
}
```

  - `.github/CODEOWNERS`: add `/core/claude/rules/                         @Cringely` after the templates line. The rules are owned in the account layer today, and the move must not leave them unowned.
  - `tools/pr-review/types.ts`: add `"core/claude/rules/fix-quality.md"` to `TRUSTED_CONTEXT_PATHS`, keeping the account entry until Task 11.
  - README "What's here": `| core/claude/rules/ | Layer rule files and layers.json, which assigns each file to the code, documents or physical layer and defines the project settings. The installer copies the layers a project records into its .claude/rules/harness/ |`

- [ ] **Step 4: Verify.** `bun test`. Expected: all PASS, including the transition case for all four files. Then for the two whole-file moves, after `git add`, the index blob `git rev-parse :core/claude/rules/<file>` equals `git rev-parse <BASE-SHA>:account/claude/rules/<file>`.

- [ ] **Step 5: Commit.**

```bash
git add core/claude/rules test/layer-rules.test.ts .github/CODEOWNERS tools/pr-review/types.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(rules): code-layer rule files in core, unchanged from the account layer (#310)"
```

---

### Task 7: Manifest v3, layers and settings in the installer

**Files:**
- Modify: `install/Install-Harness.ps1` (param block and comment help, the `-Quiet` guard area, manifest load, `Get-CoreFilesMap`, the `-Audit` block, the install loops, the provenance block)
- Modify: `core/claude/rules/layers.json` (add `settings`)
- Create: `core/claude/templates/project-settings.template.md`
- Test: `install/Install-Harness.Tests.ps1`, `test/layer-rules.test.ts`
- Modify: `README.md` (Install section)

**Interfaces:**
- Consumes: `core/claude/rules/layers.json` and the four rule files from Task 6.
- Produces:
  - Params `[ValidateSet('code','documents','physical','none')][string[]]$Layers`, `[ValidateSet('silent','heartbeat')][string]$StatusCadence`, `[ValidateSet('peer-engineer','plain-all-roles')][string]$Audience`, `[ValidateRange(0,100000)][int]$LengthBudget`.
  - Functions inside the script: `Get-LayerRegistry` (returns the parsed, validated `layers.json`), `ConvertTo-ManifestV3 -Loaded`, `Resolve-ProjectLayers -Requested -Recorded` (returns `string[]` in the order code, documents, physical), `Get-DefaultProjectSettings -Layers`, `Resolve-ProjectSettings -Recorded -Defaults -Bound`, `Get-ProjectSettingsText -Layers -Settings -Registry`.
  - Manifest shape `{ schemaVersion: 3, files, accepted, coreCommit, layers: string[], settings: { statusCadence, audience, lengthBudgetDefault } }`.
  - Installed paths `.claude/rules/harness/<file>.md` under manifest keys `rules/harness/<file>.md`, and the generated `.claude/rules/harness/project-settings.md`, never tracked in `files`.
  - Audit statuses `not-installed (layer not selected)` (not counted), `installed (layer not selected)`, `settings-missing`, `settings-stale` (all three counted).

- [ ] **Step 1: Write the failing Pester tests** in `install/Install-Harness.Tests.ps1`, in a new `Context 'layers and settings'`:
  - "records schemaVersion 3 and layers code on a fresh install and installs the code rules": the four `.claude/rules/harness/*.md` files exist, `layers` is `@('code')`, the raw manifest text matches `'"layers":\s*\[\s*"code"\s*\]'` (a one-element array that PowerShell unrolled to a scalar would serialise as a string and fail the next load), `settings.statusCadence` is `silent`, `audience` is `peer-engineer`, `lengthBudgetDefault` is `$null`, and `project-settings.md` matches ``'Status cadence, `silent`'``.
  - "migrates a v2 manifest with no layers as the code layer": install, remove `schemaVersion`, `layers` and `settings` from the manifest, re-run, then `layers` is `@('code')` and the rule files are present.
  - "-Layers documents installs only documents rules and derives heartbeat and plain-all-roles": `writing-style.md` present, `coordinator-output.md` absent, `statusCadence` `heartbeat`, `audience` `plain-all-roles`.
  - "-Layers none records an empty list and installs no layer rules": `@($m.layers).Count` is 0, no file under `.claude/rules/harness/` except `project-settings.md`, which matches `no project layers`.
  - "rejects none combined with a layer, and rejects kernel": `-Layers none,code` throws, `-Layers kernel` throws, and the target has no `.claude` afterwards.
  - "keeps recorded settings when -Layers changes and sets them when a flag is given": install `-Layers code`, re-run `-Layers code,documents`, `statusCadence` stays `silent`. Re-run `-StatusCadence heartbeat -LengthBudget 1200`: `heartbeat`, `1200`. Re-run `-LengthBudget 0`: `$null`.
  - "a dropped layer's rule file is left in place, warned about, and counted by the audit": install `-Layers code,documents`, re-run `-Layers documents`. `coordinator-output.md` still exists, output matches `layer not selected`, and `-Audit` output has a row `installed (layer not selected)` for `rules/harness/coordinator-output.md`. Delete the file, re-run, and the manifest `files` no longer holds the key.
  - Review Focus 4, "a dropped layer's edited rule file is left in place too": as above with `"PROJECT EDIT"` appended before the re-run, and the file still contains it afterwards.
  - Review Focus 3, "an invalid recorded layers value fails before any write": after a clean install, set `layers` to the string `"code"`, then to `@("kernel")`, then to `@("prose")`. Each re-run throws a message matching `layers`, and the SHA256 of `.harness-manifest.json` and `settings.json` is unchanged.
  - "a hand-written rule file at the install path is kept and reported": create `.claude/rules/harness/fix-quality.md` with other content before the first install. It is unchanged after, and the output matches `Skipping 'rules/harness/fix-quality.md'`.
  - "audit reports settings-stale after a hand edit, in-sync after CRLF conversion, and writes nothing": convert `project-settings.md` to CRLF, `-Audit` shows no `settings-stale`. Append a line, `-Audit` shows `settings-stale`, and the manifest hash is unchanged.
  - "audit lists rules of unselected layers as not-installed (layer not selected) and does not count them": `-Layers documents`, then `-Audit` prints `All managed files in sync with core.`
  - "the layer and settings flags are refused with -Audit": `-Audit -Layers code` throws.

  In `test/layer-rules.test.ts` add "settings define exactly the values the installer accepts": `statusCadence` keys `silent` and `heartbeat`, `audience` keys `peer-engineer` and `plain-all-roles`, `lengthBudgetDefault` keys `none` and `words`, and `words` contains `{{WORDS}}`.

- [ ] **Step 2: Run to verify they fail.** `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`. Expected: the new cases FAIL, the existing ones PASS.

- [ ] **Step 3: Implement.**
  - Guard near the `-Quiet` guard: any of `-Layers`, `-StatusCadence`, `-Audience`, `-LengthBudget` (checked through `$PSBoundParameters`) with `-Audit`, `-Accept`, `-Unaccept` or `-Prune` throws "applies to an install run only". `none` together with another value throws.
  - `Get-LayerRegistry` reads `core/claude/rules/layers.json` and throws when the file is missing, `schemaVersion` is not 1, `rules` is empty, a listed file is missing, a layer name is outside the three, or `settings` lacks a value Step 1 names. An empty registry would make every installed rule file read as orphaned, so it refuses rather than answering "core ships no rules".
  - `ConvertTo-ManifestV3` calls `ConvertTo-ManifestV2`, then sets `schemaVersion = 3`. An absent `layers` becomes `@('code')`, which covers both a v2 manifest and a fresh install. A present `layers` that is not an array, or holds a value outside the three, throws with a message naming the valid values. A present `settings` with a value outside the accepted set throws the same way. It replaces every existing `ConvertTo-ManifestV2` call site, so `-Accept`, `-Unaccept` and `-Prune` carry layers and settings through. The load sits above every write, so a throw leaves disk untouched.
  - `Get-DefaultProjectSettings`: `statusCadence` is `heartbeat` when the layers include `documents` or `physical`, else `silent`. `audience` is `plain-all-roles` when the layers include `documents` and not `code`, else `peer-engineer`. `lengthBudgetDefault` is `$null`.
  - `Resolve-ProjectSettings`: a bound flag wins, then the recorded value, then the default. `-LengthBudget 0` records `$null`. Changing `-Layers` alone never re-derives a recorded setting.
  - `Get-CoreFilesMap` adds `rules/harness/<file>` for every registry rule, pointing at `core/claude/rules/<file>`.
  - Install: create `.claude/rules/harness` with the other directories. For each registry rule whose layers intersect the selected layers, call `Install-ManagedFile` with key `rules/harness/<file>`. For a rule whose layers do not intersect: when the file is on disk, add result `left-in-place (layer not selected)` and warn "'<key>' belongs to a layer this project no longer records. It was left in place. Delete it by hand if the layer is gone for good, and the next install drops its record." When it is absent and the key is in `files`, remove the key and add `record-dropped (layer not selected)`. The installer never deletes a file.
  - Render `project-settings.md` from `core/claude/templates/project-settings.template.md` with `Get-ProjectSettingsText`, write it with LF line endings every install, add result `generated`, and print the `Layers: ... Settings: ...` line from the Interfaces section.
  - Audit: read layers and settings through `ConvertTo-ManifestV3`, using the defaults for absent settings and writing nothing. For a `rules/harness/` key whose layer is not selected: present on disk gives `installed (layer not selected)`, absent gives `not-installed (layer not selected)`. Add a `rules/harness/project-settings.md` row: `settings-missing` when absent, `settings-stale` when its LF-normalised text differs from the render, else `in-sync`. Add `not-installed (layer not selected)` to the uncounted list. Extend the attention line: "installed (layer not selected) = delete the file by hand, and the next install drops its record. settings-missing/settings-stale = re-run the installer, which rewrites .claude/rules/harness/project-settings.md from the manifest."
  - Comment help: document the four params and add the four statuses, with those responses, to `.PARAMETER Audit`. Note in `.DESCRIPTION` that a manifest gains `schemaVersion`, `layers` and `settings` without dropping any v2 field, so an older installer reading a v3 manifest keeps them.
  - `layers.json` gains:

```json
"settings": {
  "statusCadence": {
    "silent": "Say nothing between tool calls on long runs and report once at the close.",
    "heartbeat": "During long work, post one line each time the work moves to a new phase, and never end a turn without text. The operator should not have to ask for status."
  },
  "audience": {
    "peer-engineer": "Write for engineers who share this project's vocabulary.",
    "plain-all-roles": "Write anything the operator or their readers will see for people in any role. Gloss or drop internal IDs, issue numbers, agent names and house vocabulary."
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

  `{{LAYERS}}` is the comma-joined list, or `no project layers` when empty.
  - README Install section: the four flags, the defaults (fresh install and v2 manifest record `code`), what lands in `.claude/rules/harness/`, the generated settings file, the dropped-layer behaviour, and the four new audit statuses.

- [ ] **Step 4: Run to verify they pass.** `pwsh -NoProfile -File install/Install-Harness.Tests.ps1` and `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add install/Install-Harness.ps1 install/Install-Harness.Tests.ps1 core/claude/rules/layers.json core/claude/templates/project-settings.template.md test/layer-rules.test.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(install): manifest v3 records layers and settings, installs layer rules (#310)"
```

---

### Task 8: One-time nudge for folders with no project layer

The script is authored in the payload copy so it can be tested in the worktree, then the coordinator applies it to the source in `~/.claude` before the next export. That is the one exception to "never hand-edit `account/claude/`", and Step 6 closes it with an export whose diff for this file is empty.

**Files:**
- Modify: `account/claude/hooks/harness-core-reminder.sh`
- Create: `test/harness-core-reminder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the nudge text below, and the state file `<CLAUDE_HOME>/state/harness-nudged.txt` holding one folder path per line. `state/` is outside the exporter's allowlist, so these folder paths are never exported.

- [ ] **Step 1: Write the failing test.** Copy the payload script into `<tmp>/home/hooks/harness-core-reminder.sh` and run it with `posixBash()` from `test/posix-sh.ts`, `CLAUDE_PROJECT_DIR=<folder>`:
  - "a folder with no manifest and no .git gets the nudge once": stdout contains `no agent-harness-core project layer`, and `<tmp>/home/state/harness-nudged.txt` holds the folder line.
  - "the same folder is silent on the second run": stdout is empty bytes.
  - "a different folder still gets it".
  - "a folder with .claude/.harness-manifest.json is silent and writes no state".
  - "a path containing agent-harness-core is silent".
  - "an unwritable state location still prints the nudge": create `<tmp>/home/state` as a file. Stdout holds the nudge.
  - Every case exits 0.

- [ ] **Step 2: Run to verify it fails.** `bun test test/harness-core-reminder.test.ts`. Expected: FAIL (today a folder without `.git` is silent, and nothing is recorded).

- [ ] **Step 3: Implement.** Keep the shebang, the `CLAUDE_PROJECT_DIR` fallback to `$PWD`, the `*agent-harness-core*` exit and the manifest check. Drop the `.git` requirement. Derive the state directory from the script's own location (`$(dirname "$0")/../state`), never from `$HOME`, which Git Bash on this workstation points at the wrong folder. Exit silently when `LC_ALL=C grep -Fxq -- "$d"` finds the folder in the state file. Otherwise append the folder (errors ignored) and print:

```text
This folder has no agent-harness-core project layer (.claude/.harness-manifest.json is missing), so only the kernel rules from your account apply here. To add the code, documents or physical layer, run: pwsh {{CORE_REPO}}/install/Install-Harness.ps1 -Target <folder> -Layers <code,documents,physical>. Offer this once if the session starts real work here, and do not run it unasked. This reminder does not repeat for this folder.
```

- [ ] **Step 4: Run to verify it passes.** `bun test`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add account/claude/hooks/harness-core-reminder.sh test/harness-core-reminder.test.ts
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(account): nudge any folder without a project layer, once (#310)"
```

- [ ] **Step 6 (coordinator, operator's machine, before pushing A3).** Copy the payload script to `~/.claude/hooks/harness-core-reminder.sh` with `{{CORE_REPO}}` replaced by the core checkout path. Run `pwsh -NoProfile -File install/Export-Account.ps1`. Expected: `git diff account/claude/hooks/harness-core-reminder.sh` is empty. Stage nothing else from the export.

---

### Task 9: Install-Account retires files the account layer no longer ships

`Install-Account.ps1` says removal does not propagate to a receiver. That leaves every earlier receiver loading the operator's code rules globally after the move, which is the bleed #308 reported. This task adds a retire list that renames, never deletes. The list ships empty here and gains its entries in Task 11, in the same PR as the export that drops the files.

**Files:**
- Create: `install/account-retired.json`
- Modify: `install/Install-Account.ps1`
- Test: `install/Install-Account.Tests.ps1`
- Modify: `README.md` (Account layer section)

**Interfaces:**
- Consumes: nothing.
- Produces: `install/account-retired.json` shape `{ "schemaVersion": 1, "retired": [ { "path": "rules/<file>.md", "reason": "<one sentence>" } ] }`, the param `-RetiredListPath` (default `install/account-retired.json` beside the script), and the function `Invoke-AccountRetirement -ClaudeHome <string> -PayloadRoot <string> -ListPath <string>`.

- [ ] **Step 1: Write the failing tests** in a new `Context 'retired paths'`, using the suite's existing sandbox pattern (`-PayloadRoot`, `-ClaudeHome`, `-ClaudeJson`, `-SkipPreflight`) plus `-RetiredListPath`:
  - "renames a retired file on the receiver and keeps its content": the sandbox home has `rules/old.md`, the list names it, the payload does not carry it. Afterwards `rules/old.md` is gone, exactly one `rules/old.md.retired-*` exists with the original content, and the output matches `Retired rules/old.md`.
  - "refuses before copying anything when the payload still carries a retired path": the throw message names the path, and a payload file absent from the home beforehand is still absent.
  - "rejects an entry that escapes the account home or names another tree": `../x.md`, an absolute path, and `tools/x.md` each throw.
  - "-WhatIf renames nothing".
  - "an empty list changes nothing".
  - "a missing list file throws".

- [ ] **Step 2: Run to verify they fail.** `pwsh -NoProfile -File install/Install-Account.Tests.ps1`. Expected: the new cases FAIL.

- [ ] **Step 3: Implement** `Invoke-AccountRetirement` and call it after the path canonicalisation and before the first copy. Validate every entry first: a relative path with no `..` segment, under `rules/`, `agents/`, `skills/` or `hooks/`, and absent from the payload. Then for each entry present under `-ClaudeHome`, `Move-Item` it to `<path>.retired-<yyyyMMddTHHmmssZ>` (UTC) and print `Retired <path> (now <new name>): <reason>`. `Move-Item` honours `-WhatIf` on its own. `install/account-retired.json` ships as `{ "schemaVersion": 1, "retired": [] }`. README Account layer section: one paragraph on the retire list, that it renames rather than deletes, and that Claude Code loads only `*.md` from `rules/`, so a renamed file stops loading.

- [ ] **Step 4: Run to verify they pass.** `pwsh -NoProfile -File install/Install-Account.Tests.ps1`. Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add install/account-retired.json install/Install-Account.ps1 install/Install-Account.Tests.ps1 README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "feat(install-account): rename files the account layer has retired (#310)"
```

PR A3 body: `Docs: README updated: core/claude/rules row, Install section for layers and settings, Account layer retire list`.

---

### Task 10: Cutover (coordinator, operator's machine)

Runs after A3 merges, in the main clone on `feat/310-cutover` from `origin/master`. Order matters: every installed project gets its copy before the account copy goes.

- [ ] **Step 1: Confirm the copies still match.** Export, then `bun test test/layer-rules.test.ts`. Expected: PASS. A red transition case means a source edit since Task 5. Port it into `core/claude/rules` first.

- [ ] **Step 2: Reinstall every installed project.** Glob `E:/projects/*/.claude/.harness-manifest.json`, and ask the operator in the same message as Step 3's confirmation whether projects live anywhere else. For each project, including this repo: `pwsh -NoProfile -File install/Install-Harness.ps1 -Target <project>`. Expected per project: `.claude/rules/harness/fix-quality.md` exists and the printed line reads `Layers: code.` Collect each project's `git status --short`.

- [ ] **Step 3: Confirm with the operator.** Send one message with the project list, each project's pending changes, and the request to commit them in those repositories (repositories outside this one, with their own owners and gates). Committing there waits on the answer. Steps 4 to 7 do not.

- [ ] **Step 4: Split and remove in `~/.claude/rules`.**
  - Back up the four files to `~/.claude-backups/rules-<yyyyMMddTHHmmssZ>/`, which is outside `~/.claude/rules`, so nothing there loads.
  - Create `durable-deliverables.md` as `# Durable Deliverables`, a blank line, then the "Deliverables Do Not Live in the Scratchpad" section copied verbatim from `change-management.md`, heading included. Create `bounded-review.md` as `# Bounded Review`, a blank line, then the "Work has to be able to end" section from `fix-quality.md`.
  - Remove `change-management.md`, `coordinator-output.md`, `fix-quality.md` and `writing-style.md` from `~/.claude/rules`. The `*.local.md` overlays stay.

- [ ] **Step 5: Update the kernel's own instructions.** In `~/.claude/rules/harness-core.md`, at the end of "Account layer, on this machine and on any other", add: "Layer rules are not authored here any more. `change-management.md`, `coordinator-output.md`, `fix-quality.md` and `writing-style.md` live in `core/claude/rules/` in the core repo and are edited there, and `Install-Harness.ps1` copies the layers a project records into its `.claude/rules/harness/`. A project picks up a rule change when it is reinstalled. The account layer keeps the kernel, including `durable-deliverables.md` and `bounded-review.md`, the two kernel sections split out of the moved files." In `~/.claude/skills/memory-system/SKILL.md:78`, `~/.claude/rules/change-management.md` becomes "the code layer's `change-management.md`". Other references to the moved files name the file without a path and stay.

- [ ] **Step 6: Export and check the diff.** `pwsh -NoProfile -File install/Export-Account.ps1`, then `git diff --stat account/claude`. Expected and staged: four rule files deleted, `rules/durable-deliverables.md` and `rules/bounded-review.md` added, `rules/harness-core.md` and `skills/memory-system/SKILL.md` modified. Anything else is unrelated drift and waits for its own PR.

- [ ] **Step 7: Commit.**

```bash
git add account/claude/rules account/claude/skills/memory-system/SKILL.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "refactor(account): the account layer keeps the kernel, layer rules live in core (#310)"
```

The sha of this commit is the `BASE-SHA` for Tasks 11 and 12.

---

### Task 11: Repoint references and fill the retire list

**Files:**
- Modify: `install/account-retired.json`, `tools/pr-review/types.ts` (comment near line 6 and `TRUSTED_CONTEXT_PATHS`), `tools/pr-review/reviewer-prompt.md:79`, `tools/pr-review/README.md:7`, `install/Install-Harness.Tests.ps1:45` (comment), `test/layer-rules.test.ts`, `README.md` (Account layer section)

**Interfaces:**
- Consumes: Task 10's commit, Task 9's list shape, Task 6's test.
- Produces: nothing later tasks call.

- [ ] **Step 1: Retire list.** Add four entries to `install/account-retired.json`: `rules/change-management.md`, `rules/coordinator-output.md`, `rules/fix-quality.md`, `rules/writing-style.md`, each with reason "Moved to core/claude/rules. Install-Harness.ps1 copies it into projects that record its layer."
- [ ] **Step 2: Reviewer standards.** In `TRUSTED_CONTEXT_PATHS`, replace `"account/claude/rules/fix-quality.md"` with `"account/claude/rules/bounded-review.md"`. `core/claude/rules/fix-quality.md` stays from Task 6. In the `types.ts` comment, `reviewer-prompt.md:79`, `tools/pr-review/README.md:7` and the `Install-Harness.Tests.ps1:45` comment, the citation of `account/claude/rules/fix-quality.md`'s "Work has to be able to end" becomes `account/claude/rules/bounded-review.md`.
- [ ] **Step 3: Retire the transition case.** Delete the "while the account copy exists" test, `KERNEL_SECTIONS` and `withoutSections` from `test/layer-rules.test.ts`. The account copies are gone, so the case can only skip from here on.
- [ ] **Step 4: README.** Account layer section: one sentence that the account layer carries the kernel and that layer rules ship from `core/claude/rules`.
- [ ] **Step 5: Verify.** `bun test`, `pwsh -NoProfile -File install/Install-Account.Tests.ps1`, `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`. Expected: all PASS. Then a dry run against a temp home whose `rules/` holds the four files from `git show <Task 10 parent>:account/claude/rules/<file>`: `pwsh -NoProfile -File install/Install-Account.ps1 -ClaudeHome <tmp-home> -ClaudeJson <tmp-home>/claude.json -SkipPreflight -WhatIf`. Expected: four `What if` move lines, one per retired rule file, and the four files still in place.
- [ ] **Step 6: Commit.**

```bash
git add install/account-retired.json tools/pr-review/types.ts tools/pr-review/reviewer-prompt.md tools/pr-review/README.md install/Install-Harness.Tests.ps1 test/layer-rules.test.ts README.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "chore(rules): point the reviewer at the kernel split, retire moved account rules (#310)"
```

---

### Task 12: Session close skips the push when there is no remote

This edit comes after the cutover because Task 6's transition case pins the core copy to the account copy until Task 11 removes it.

**Files:**
- Modify: `core/claude/rules/change-management.md` ("Session Close Protocol", step 2)

**Interfaces:**
- Consumes: Task 11's commit (transition case gone).
- Produces: nothing.

- [ ] **Step 1: Edit.** Replace step 2 with:

```markdown
2. **Push to remote** — ensure the commit is on GitHub, not just local. Run `git remote` first. When it prints nothing, the project has no remote: skip this step and say "No remote configured, push skipped" in the close. When the folder is not a git repository at all, skip steps 1 and 2 the same way and say so.
```

The em dash after the bold label matches steps 1 and 3 and is kept for that reason. The colon replaces what would otherwise be a semicolon.

- [ ] **Step 2: Verify.** `bun test`. Expected: PASS. Then `pwsh -NoProfile -File install/Install-Harness.ps1 -Target <tmp project>` and confirm `.claude/rules/harness/change-management.md` contains `No remote configured, push skipped`.

- [ ] **Step 3: Commit.**

```bash
git add core/claude/rules/change-management.md
git -c user.name=Cringely -c user.email=Cringely@users.noreply.github.com commit -m "docs(rules): session close skips the push when there is no remote (#310)"
```

PR A4 body: `Docs: README updated: Account layer section says the account layer carries the kernel`. After the merge, the coordinator reinstalls every project from Task 10 Step 2 once more so each picks up Task 12's text.

## Out of scope, recorded

- Plan B (the init interview) and Plan C (documents and physical rule content, heartbeat wording beyond the setting text, the office toolchain probe).
- Gating agents and hooks by layer. Plan A installs them for every layer and relies on the self-checks.
- The kernel rule additions the spec names (absence claims, asking before claiming a human step was skipped, the decision log, the scope-accumulation challenge) and worktree cleanup at session close. No plan in the A, B, C split owns them yet.
- Mirroring the `subagent-prompting` skill fix into the separate `agent-skills-core` repository.
- The #294 report that the model-tier hook demands xhigh effort. The spec files it separately.
