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
//     (fail toward safety for the type; hook-level fail-open is reserved for
//     malformed stdin and our own bugs).
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
// Fail-open contract: a broken hook must never brick dispatching. Every error
// path (malformed stdin, missing fields, our own bugs) logs to stderr and exits 0
// with no stdout, which Claude Code treats as "no opinion" — the normal
// permission flow proceeds. Only a well-formed deny emits JSON. If `bun` itself
// is missing from PATH the hook command fails non-zero-but-not-2, which Claude
// Code also treats as non-blocking. No network, no mutation, stdin→stdout only.
// (An unreadable agent-definition file is NOT a hook error — it resolves to
// "requires isolation" for that type, see above.)
//
// Decision logic lives in the exported pure `decide()`, exercised offline by
// test/agent-worktree-gate.test.ts without spawning a process. The stdin/stdout
// contract itself has no spawn-level test.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const BUILTIN_READ_ONLY = new Set(["explore", "plan"]);

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

export type GateDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

const ALLOW: GateDecision = { action: "allow" };

/** Per-process memo of agentsDir+type → requires-isolation. Short-lived by construction. */
const classificationCache = new Map<string, boolean>();

/**
 * True unless the frontmatter proves the role read-only: a `tools:` field whose
 * every entry is on the read-only allowlist. Absent/empty field means all tools.
 */
function frontmatterRequiresIsolation(text: string): boolean {
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
  return !tokens.every((tok) => READ_ONLY_TOOLS.has(tok));
}

/**
 * Derived classification: does `subagentType` (already trimmed + lowercased)
 * need worktree isolation? Ground truth is the agent-definition frontmatter;
 * built-ins are the only hardcoded cases; unknown fails toward isolation.
 */
export function requiresIsolation(
  subagentType: string,
  agentsDir: string = DEFAULT_AGENTS_DIR,
): boolean {
  if (PROJECT_EXCEPTIONS.includes(subagentType)) return false;

  const key = `${agentsDir} ${subagentType}`;
  const cached = classificationCache.get(key);
  if (cached !== undefined) return cached;

  let result: boolean;
  const defFile = join(agentsDir, `${subagentType}.md`);
  if (existsSync(defFile)) {
    try {
      result = frontmatterRequiresIsolation(readFileSync(defFile, "utf8"));
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

/** Pure decision over the PreToolUse stdin payload. Unrecognizable input allows. */
export function decide(
  payload: unknown,
  agentsDir: string = DEFAULT_AGENTS_DIR,
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

  if (!requiresIsolation(subagentType, agentsDir)) return ALLOW;

  if (typeof t.isolation === "string" && ISOLATED.has(t.isolation)) return ALLOW;

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
    const decision = decide(JSON.parse(await Bun.stdin.text()));
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
