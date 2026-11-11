// PreToolUse hook (matcher: Agent|Task) — the worktree-isolation gate.
//
// Two writers in one checkout collide: a repo-writing agent gets dispatched
// without `isolation: "worktree"` and its commit lands on a branch the
// dispatcher is concurrently editing. The fix is a deterministic GATE at the
// exact moment of the mistake, not louder prose: this hook DENIES an
// Agent/Task dispatch whose subagent_type cannot be proven read-only unless
// the dispatch is isolated (worktree or remote) or carries an explicit
// written override with a reason.
//
// Floor: once the hook can read a subagent_type out of a well-formed payload,
// a write-capable dispatch never proceeds against this shared, non-isolated
// checkout unless the hook proved the type read-only or it is a built-in the
// hook trusts as read-only (Explore, Plan). The only other way through is a
// reasoned override the dispatcher wrote itself: an ISOLATION-OVERRIDE line
// in the prompt, or a PROJECT_EXCEPTIONS entry. The CLOSED path below
// derives from that floor:
// where classification runs but can't prove the type safe, the gate denies,
// because an unproven type is not a read-only type. The OPEN path is a
// deliberate reliability trade against the floor, not a consequence of it,
// taken only where the floor cannot be evaluated at all — the payload is
// missing the fields classification needs, or the hook itself errors. A
// control that blocks every dispatch gets disabled within a day, and then
// nothing is gated at all, so an unparseable payload passes unchecked rather
// than taking the gate down.
//
// Classification is DERIVED, not hand-listed: the ground truth for "which
// roles can write the repo" already lives in `.claude/agents/<type>.md`
// `tools:` frontmatter. A hand-maintained list of write-capable types drifts
// out of sync the first time a new role is added with a tools grant nobody
// updated the list for — which is the exact failure class this hook exists
// to close. The rule as shipped:
//   - Type has a definition file → parse its `tools:` frontmatter. Exempt only if
//     every listed tool is on the provably-read-only allowlist; an absent/empty
//     `tools:` field, `*`, "All tools", or any unlisted tool ⇒ requires isolation.
//   - Definition file exists but is unreadable ⇒ that TYPE requires isolation
//     (fail-closed tier: classification ran and found nothing provably safe.
//     The fail-open tier below is reserved for malformed stdin and our own
//     bugs, where classification never ran at all).
//   - No definition file → only the known built-ins are hardcoded: Explore and
//     Plan are read-only (their published grant excludes Edit/Write/NotebookEdit);
//     general-purpose, fork, and an OMITTED subagent_type (the tool defaults it to
//     general-purpose) have all tools. Any other unknown type requires isolation —
//     an unknown role is not evidence it is read-only.
//
// Design note: a write-token deny-list ("contains Write/Edit/NotebookEdit/
// Bash/…") was considered and rejected in favor of a read-only ALLOWLIST,
// because a deny-list silently exempts any write-capable tool it didn't
// anticipate (a new shell tool, an MCP writer), while the allowlist fails
// toward isolation by default. Frontmatter parses are memoized per process
// only; the hook is a short-lived invocation, so there is no persistent
// cache whose inputs need enumerating.
//
// Design note: guardrails hooks in this repo are otherwise POSIX sh. This
// hook must read structured fields (subagent_type, isolation) out of a
// payload whose `prompt` is arbitrary free text. Raw-text grep on stdin was
// tried first and rejected: a prompt merely *mentioning* `isolation:
// "worktree"` would wrongly pass the gate. Real JSON parsing needs bun,
// which projects using this hook are expected to have available.
//
// Fail-open contract, the trade against the floor above for the case the
// floor can't reach: a broken hook must never brick dispatching. Every error
// path (malformed stdin, missing fields,
// our own bugs) logs to stderr and exits 0 with no stdout, which Claude Code
// treats as "no opinion" — the normal permission flow proceeds. Only a
// well-formed deny emits JSON. If `bun` itself is missing from PATH the hook
// command fails non-zero-but-not-2, which Claude Code also treats as
// non-blocking. No network, no git binary, no mutation. Input is the stdin payload, the environment,
// and the few filesystem reads the git probe and the scoped-writer check make.
// (An unreadable agent-definition file is NOT a hook error — it resolves to
// "requires isolation" for that type, see above.)
//
// Base-sha check (#36). An isolated (worktree or remote) write dispatch must carry a base the agent
// can verify. The worktree branches from origin's default branch or from the dispatcher's local HEAD,
// depending on `worktree.baseRef`, and a brief written for one base fails silently on the other.
// Every isolated write dispatch whose prompt carries no base-sha line is denied. The line format is
// `BASE-SHA: <hex>`, 7 to 40 hex digits, at the start of a prompt line (leading spaces allowed). The
// agent compares it with its worktree HEAD before touching a file and aborts on a mismatch. The gate
// checks only that the line is present, since the worktree does not exist yet.
// The base check compares nothing. An earlier version denied only when the dispatcher HEAD differed
// from origin's default branch and let an equal pair through, but the local origin ref can be stale,
// so equal-HEAD was not a safe allow (operator ruling on #36, 2026-11-11).
//
// Git probe (#310). A worktree cannot exist outside a git repository, so denying a write dispatch
// there with "re-dispatch isolated" asks for the impossible. When the project root is provably not
// a repository, the gate allows the dispatch and attaches a note naming the cost and the `git init`
// remedy. The probe reads the filesystem only and spawns no git binary: GIT_DIR or GIT_WORK_TREE in
// the environment, or a `.git` entry (file or directory) at the path or any ancestor, means "repo".
// The project root decides (CLAUDE_PROJECT_DIR, else two levels above this script), and a payload
// `cwd` must agree with it. Any answer short of "not-repo" for either, "unknown" included, keeps the
// behaviour above, so a probe that cannot answer never widens what is allowed.
//
// Scoped writers (#310). A definition that declares `writeScope: scratch` and grants no shell is not
// a repo writer: agent-write-scope.ts reads the same file with the same parser and confines its
// Write and Edit calls to a scratch directory, and with no shell nothing else reaches the checkout.
// The gate trusts that only when the parser module loads, the installed write-scope gate is at the
// required version (it carries the scratch-parent containment fix) and settings.json registers it
// under a PreToolUse matcher covering Write and Edit. Anything less leaves the type requiring
// isolation, because a scoped writer behind two gates that do not both hold is an unconfined one.
// The modules load through a guarded dynamic import: a static import that fails to link exits the
// process before the entrypoint's try, which Claude Code reads as no opinion.
//
// Decision logic lives in the exported `decide()`, exercised offline by
// test/agent-worktree-gate.test.ts without spawning a process. The stdin/stdout
// contract itself IS spawn-tested (#78): see the
// "spawned process" describe block at the end of that file.

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isValidAgentName } from "./agent-name";
// Type only: erased at build, so nothing here can fail to link. The module itself loads through
// loadWriteScopeParser() below.
import type { WriteScopeParser } from "./write-scope-parse";

/**
 * Project-specific escape hatch: subagent_type values this project has
 * decided are safe to dispatch without isolation regardless of what their
 * frontmatter grants (for example, a role whose write surface is scoped to
 * a directory outside the tracked checkout). Empty by default — a project
 * fills this in only when it has a specific, reasoned exception; an entry
 * here bypasses classification entirely, so keep the list short and leave a
 * comment next to each entry explaining why it's safe.
 */
export const PROJECT_EXCEPTIONS: string[] = [];

/**
 * Tools that provably cannot write the repo checkout. Anything NOT on this list
 * (Write, Edit, NotebookEdit, Bash, PowerShell, Agent, Skill, mcp__* tools, …)
 * counts as write-capable — see the allowlist note in the header.
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "toolsearch",
]);

/**
 * Built-in subagent types with no `.claude/agents/<type>.md` definition file.
 * Explore and Plan are read-only per their published grant ("All tools except
 * Agent, Artifact, ExitPlanMode, Edit, Write, NotebookEdit"). general-purpose
 * and fork carry all tools and deliberately have no entry here — they fall
 * through to the requires-isolation default, exactly like unknown types.
 */
const BUILTIN_READ_ONLY = new Set(["explore", "plan", "web-fetch"]);

/**
 * Write tools a `writeScope: scratch` definition may hold and still be trusted without isolation.
 * agent-write-scope.ts reads the same definition with the same parser and confines Write and Edit
 * to a scratch directory, and SendMessage writes no file. With no shell in the grant, nothing else
 * reaches the checkout. NotebookEdit stays out, and so does everything not named here.
 */
const SCOPED_WRITE_TOOLS = new Set(["write", "edit", "sendmessage"]);

/** The write-scope gate version that carries the scratch-parent containment fix (Task 1). */
export const REQUIRED_WRITE_SCOPE_GATE_VERSION = 2;

/** Where the agent definitions live, relative to this script. */
export const DEFAULT_AGENTS_DIR = join(import.meta.dir, "..", "agents");

/** isolation values that put the agent outside the shared checkout. */
const ISOLATED = new Set(["worktree", "remote"]);

/**
 * Conscious-override token: a dispatcher who deliberately wants a non-isolated
 * repo-writing agent writes `ISOLATION-OVERRIDE: <reason>` in the agent prompt.
 * The regex requires non-empty reason text after the colon — a bare token is
 * not a reasoned override. Without an in-band override, the only bypass is
 * muting the hook in settings.json — and a muted hook protects nothing. The
 * token forces the override to be written, reasoned, and visible in the
 * transcript.
 */
export const OVERRIDE_TOKEN = "ISOLATION-OVERRIDE:";
const OVERRIDE_RE = /ISOLATION-OVERRIDE:[ \t]*\S/;

/**
 * Base-sha declaration: `BASE-SHA: <7-40 hex digits>` at the start of a prompt line. Anchored to
 * line start so prose that merely mentions the token mid-sentence does not count.
 */
export const BASE_SHA_TOKEN = "BASE-SHA:";
const BASE_SHA_RE = /^[ \t]*BASE-SHA:[ \t]*[0-9a-f]{7,40}\b/im;

export type GateDecision =
  | { action: "allow"; note?: string }
  | { action: "deny"; reason: string };

export type GitProbe = "repo" | "not-repo" | "unknown";

/**
 * Is `dir` inside a git work tree? Filesystem only, no git binary. `repo` when GIT_DIR or
 * GIT_WORK_TREE is set, or when `dir` or an ancestor holds a `.git` entry (a directory, or the file
 * a linked worktree uses). `unknown` when `dir` is not an existing directory or a read fails for any
 * reason but absence. `not-repo` only when the walk reaches the filesystem root (`/` or a drive
 * root) having found nothing. Unknown fails closed in the caller: the gate behaves as it did.
 */
export function probeGitWorkTree(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): GitProbe {
  if (env.GIT_DIR || env.GIT_WORK_TREE) return "repo";
  try {
    if (!statSync(dir).isDirectory()) return "unknown";
    let p = resolve(dir);
    for (;;) {
      try {
        lstatSync(join(p, ".git"));
        return "repo";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Absent here (or the parent is a file): keep climbing. Anything else, such as a denied
        // read, means the answer is not known.
        if (code !== "ENOENT" && code !== "ENOTDIR") return "unknown";
      }
      const parent = dirname(p);
      if (parent === p) return "not-repo";
      p = parent;
    }
  } catch {
    return "unknown";
  }
}

/** The note attached to an allow when the project root is not a git repository. */
export function nonGitNote(projectRoot: string): string {
  return (
    `Worktree gate: ${projectRoot} is not a git repository, so worktree isolation is not available ` +
    `and this dispatch runs in the shared folder. A git repository in a subfolder of it is not ` +
    `isolated either. If this work should be versioned, run \`git init\` here and the gate will ` +
    `isolate concurrent writers.`
  );
}

/** The project root: CLAUDE_PROJECT_DIR when set, else two levels above this script's directory. */
export function projectRootOf(env: Record<string, string | undefined>): string {
  return env.CLAUDE_PROJECT_DIR || join(import.meta.dir, "..", "..");
}

/**
 * Does a settings.json matcher cover `tool`? Claude Code treats an empty or `*` matcher as every
 * tool and anything else as a regular expression over the tool name. Anchored, so `WriteFile` does
 * not cover `Write`. An invalid expression covers nothing.
 */
function matcherCovers(matcher: unknown, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

/**
 * True when settings.json registers a command containing `agent-write-scope.ts` under ONE
 * PreToolUse group whose matcher covers both Write and Edit. Two groups that each cover one tool
 * leave the other unguarded, so they do not count.
 */
function registersWriteScopeGate(settingsPath: string): boolean {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
  const groups = (settings as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return false;
  return groups.some((g: unknown) => {
    if (typeof g !== "object" || g === null) return false;
    const group = g as { matcher?: unknown; hooks?: unknown };
    if (!matcherCovers(group.matcher, "Write") || !matcherCovers(group.matcher, "Edit")) return false;
    if (!Array.isArray(group.hooks)) return false;
    return group.hooks.some((h: unknown) => {
      const command = (h as { command?: unknown } | null)?.command;
      return typeof command === "string" && command.includes("agent-write-scope.ts");
    });
  });
}

/** An import specifier for a path: absolute paths become file URLs, relative ones pass through. */
function specifier(p: string): string {
  return isAbsolute(p) ? pathToFileURL(p).href : p;
}

/**
 * Loads the write-scope parser, or null when trusting `writeScope` would be unsafe. Null on any
 * load error, and also unless the write-scope gate beside it exports WRITE_SCOPE_GATE_VERSION at or
 * above REQUIRED_WRITE_SCOPE_GATE_VERSION and settings.json registers that gate for Write and Edit.
 * A project that modified or pinned agent-write-scope.ts keeps its old copy across a reinstall,
 * and that copy still has the scratch-parent gap, so trusting `writeScope` beside it would let a
 * scoped writer through both gates.
 *
 * Both imports are dynamic and inside the try. A static import that fails to link exits the process
 * before the entrypoint's try, which Claude Code reads as no opinion. Importing agent-write-scope.ts
 * is safe: its entrypoint sits behind `import.meta.main`.
 */
export async function loadWriteScopeParser(
  parserPath: string = "./write-scope-parse",
  gatePath: string = "./agent-write-scope",
  settingsPath: string = join(projectRootOf(process.env), ".claude", "settings.json"),
): Promise<WriteScopeParser | null> {
  try {
    const parser = (await import(specifier(parserPath))) as { parseWriteScope?: unknown };
    const gate = (await import(specifier(gatePath))) as { WRITE_SCOPE_GATE_VERSION?: unknown };
    if (typeof parser.parseWriteScope !== "function") return null;
    const version = gate.WRITE_SCOPE_GATE_VERSION;
    if (typeof version !== "number" || !(version >= REQUIRED_WRITE_SCOPE_GATE_VERSION)) return null;
    if (!registersWriteScopeGate(settingsPath)) return null;
    return parser.parseWriteScope as WriteScopeParser;
  } catch {
    return null;
  }
}

const ALLOW: GateDecision = { action: "allow" };

/** Per-process memo of agentsDir+type → requires-isolation. Short-lived by construction. */
const classificationCache = new Map<string, boolean>();

/**
 * True unless the frontmatter proves the role read-only: a `tools:` field whose
 * every entry is on the read-only allowlist. Absent/empty field means all tools.
 */
function frontmatterRequiresIsolation(text: string, parseScope: WriteScopeParser | null): boolean {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (fm === undefined) return true; // no parseable frontmatter → cannot prove read-only
  const lines = fm.split(/\r?\n/);
  // A `memory:` field (any scope) auto-enables Read, Write, and Edit regardless
  // of what `tools:` grants, per the docs' persistent-memory section.
  // `memory: user` writes outside the checkout (~/.claude/agent-memory/), so
  // isolating it is a known false positive, but that is the safe direction and
  // PROJECT_EXCEPTIONS is the carve-out if a real def ever needs it. Anchored
  // at line start so a `memory:` substring inside a description value does
  // not false-positive.
  if (lines.some((l) => /^memory\s*:\s*\S/i.test(l))) return true;
  const toolsLine = lines.find((l) => /^tools\s*:/i.test(l));
  if (!toolsLine) return true; // no tools: restriction = all tools
  const tokens = toolsLine
    .replace(/^tools\s*:/i, "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  if (tokens.length === 0) return true; // empty value = all tools
  if (tokens.every((tok) => READ_ONLY_TOOLS.has(tok))) return false;
  // A shell-less scratch writer is not a repo writer. agent-write-scope.ts reads this same file with
  // the same parser and confines Write and Edit to a scratch directory, and with no shell in the
  // grant nothing else reaches the checkout. The memory: check above has already run, and only a
  // non-null parser (see loadWriteScopeParser) lets this line fire.
  if (
    parseScope !== null &&
    parseScope(text) === "scratch" &&
    tokens.every((tok) => READ_ONLY_TOOLS.has(tok) || SCOPED_WRITE_TOOLS.has(tok))
  ) {
    return false;
  }
  return true;
}

/**
 * Derived classification: does `subagentType` (already trimmed + lowercased)
 * need worktree isolation? Ground truth is the agent-definition frontmatter;
 * built-ins are the only hardcoded cases; unknown fails toward isolation.
 *
 * The "already trimmed + lowercased" precondition above is a claim about the caller, and
 * `decide()` is not the only caller of an exported function. So the name is checked against the
 * agent-name allowlist here, at the line that turns it into a path, rather than at the payload
 * read (backlog item 38): a name that is not filename-safe proves nothing about the role, which
 * is what "requires isolation" already means for every unknown type, so it takes that answer.
 *
 * BELOW the exceptions check, not above it. The first version had it above, on the reasoning
 * that an exception names a role and a traversal is not a role. That reasoning holds for a
 * traversal and misses `:`, which is outside the allowlist because it is the alternate-data-
 * stream separator on Windows, and which is also how Claude Code names a plugin's agent
 * (`caveman:cavecrew-investigator`). Six such types are on this session's roster. Checking the
 * name first made every plugin-namespaced exception entry silently inert in a consumer project,
 * and the resulting deny blamed the role's tools frontmatter, which was not the reason. The
 * ordering is safe because an exception entry is an operator-written literal in this file and the
 * early return never builds a path from it: the allowlist exists to keep payload text out of
 * `join()`, and nothing below this line is reached on the exception path.
 */
export function requiresIsolation(
  subagentType: string,
  agentsDir: string = DEFAULT_AGENTS_DIR,
  parseScope: WriteScopeParser | null = null,
): boolean {
  if (PROJECT_EXCEPTIONS.includes(subagentType)) return false;
  if (!isValidAgentName(subagentType)) return true;

  // The answer depends on whether a parser was supplied, so the key says so.
  const key = `${agentsDir} ${subagentType} ${parseScope === null ? "plain" : "scoped"}`;
  const cached = classificationCache.get(key);
  if (cached !== undefined) return cached;

  let result: boolean;
  const defFile = join(agentsDir, `${subagentType}.md`);
  if (existsSync(defFile)) {
    try {
      result = frontmatterRequiresIsolation(readFileSync(defFile, "utf8"), parseScope);
    } catch {
      // Definition exists but can't be read: cannot prove read-only, so this
      // TYPE requires isolation. Not a hook-level fail-open — that is reserved
      // for malformed stdin / internal errors.
      result = true;
    }
  } else if (BUILTIN_READ_ONLY.has(subagentType)) {
    result = false;
  } else {
    // general-purpose, fork, and every unknown type: all-tools or unproven.
    result = true;
  }

  classificationCache.set(key, result);
  return result;
}

/**
 * Decision over the PreToolUse stdin payload. Unrecognizable input allows.
 *
 * `projectRoot` null or omitted means no root is known: the probe is not called and the non-git
 * allow never fires. `parseScope` null or omitted means no scoped-writer trust.
 */
export function decide(
  payload: unknown,
  agentsDir: string = DEFAULT_AGENTS_DIR,
  projectRoot: string | null = null,
  probe: (dir: string) => GitProbe = (dir) => probeGitWorkTree(dir),
  parseScope: WriteScopeParser | null = null,
): GateDecision {
  if (typeof payload !== "object" || payload === null) return ALLOW;
  const p = payload as Record<string, unknown>;

  // Defense in depth: only judge the subagent-spawn tool, whatever the matcher.
  if (typeof p.tool_name === "string" && p.tool_name !== "Agent" && p.tool_name !== "Task") {
    return ALLOW;
  }

  const input = p.tool_input;
  if (typeof input !== "object" || input === null) return ALLOW;
  const t = input as Record<string, unknown>;

  // Absent/empty subagent_type defaults to general-purpose (the tool's default —
  // otherwise omission would silently bypass the gate). A non-string value is
  // unrecognizable input → fail open.
  if (t.subagent_type !== undefined && typeof t.subagent_type !== "string") return ALLOW;
  const subagentType =
    typeof t.subagent_type === "string" && t.subagent_type.trim() !== ""
      ? t.subagent_type.trim().toLowerCase()
      : "general-purpose";

  if (!requiresIsolation(subagentType, agentsDir, parseScope)) return ALLOW;

  // Nothing to isolate into: the project root is provably not a repository, and the session cwd
  // (when the payload names one) agrees. Allow and say so. Any other probe answer, "unknown"
  // included, falls through to the logic below.
  if (typeof projectRoot === "string" && projectRoot !== "" && probe(projectRoot) === "not-repo") {
    if (typeof p.cwd !== "string" || probe(p.cwd) === "not-repo") {
      return { action: "allow", note: nonGitNote(projectRoot) };
    }
  }

  if (typeof t.isolation === "string" && ISOLATED.has(t.isolation)) {
    if (typeof t.prompt === "string" && BASE_SHA_RE.test(t.prompt)) return ALLOW;
    return {
      action: "deny",
      reason:
        `Worktree base gate: this isolated write dispatch names no base sha. The worktree may come ` +
        `up on origin's default branch or on the dispatcher's HEAD depending on worktree.baseRef, ` +
        `and a brief written for one fails silently on the other. Add a line ` +
        `"${BASE_SHA_TOKEN} <sha>" (7 to 40 hex digits, at the start of a prompt line) with the sha ` +
        `the work must start from, and tell the agent to compare it with its worktree HEAD before ` +
        `reading or writing and to abort on a mismatch.`,
    };
  }

  if (typeof t.prompt === "string" && OVERRIDE_RE.test(t.prompt)) return ALLOW;

  return {
    action: "deny",
    reason:
      `Worktree-isolation gate: subagent_type "${subagentType}" is not provably ` +
      `read-only (its tools grant — .claude/agents/${subagentType}.md frontmatter, or the ` +
      `built-in default — allows repo writes), and this dispatch has no isolation, so it ` +
      `would share the checkout with the dispatcher — two writers on one branch collide. ` +
      `Re-dispatch with isolation: "worktree" (auto-cleaned if the agent changes nothing; ` +
      `"remote" also passes). For a read-only task, use a read-only type (Explore, Plan, or a ` +
      `role whose tools: frontmatter is read-only) instead. To consciously dispatch without ` +
      `isolation, write "${OVERRIDE_TOKEN} <reason>" in the agent prompt — the reason is required.`,
  };
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text();
    // Copilot CLI also runs .claude/settings.json hooks and fails closed on them (#227). Stand
    // down there, but never while CLAUDECODE is set, so a Claude Code session always runs the rest.
    if (process.env.COPILOT_CLI && !process.env.CLAUDECODE) process.exit(0);
    const payload = JSON.parse(raw);
    const decision = decide(
      payload,
      DEFAULT_AGENTS_DIR,
      projectRootOf(process.env),
      undefined,
      await loadWriteScopeParser(),
    );
    if (decision.action === "allow" && decision.note !== undefined) {
      console.log(
        JSON.stringify({
          systemMessage: decision.note,
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: decision.note },
        }),
      );
    }
    if (decision.action === "deny") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason,
          },
        }),
      );
    }
  } catch (err) {
    // Fail open: log and allow. A broken gate must never brick dispatching.
    console.error(`agent-worktree-gate: hook error, allowing dispatch: ${String(err)}`);
  }
  process.exit(0);
}
