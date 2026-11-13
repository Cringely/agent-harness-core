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
// checkout unless one of these holds:
//   - the hook proved the type read-only, or it is a built-in the hook trusts as
//     read-only (Explore, Plan);
//   - neither the project root nor the session folder is a git repository, so no
//     worktree can exist (see the git-probe paragraph below). The dispatch is allowed
//     with a note rather than denied for something that cannot be done;
//   - the dispatcher wrote a reasoned override itself: an ISOLATION-OVERRIDE line in
//     the prompt, or a PROJECT_EXCEPTIONS entry.
// The CLOSED path below derives from that floor:
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
//     The key is matched case-sensitively, as Claude Code reads it, so `Tools:` is no
//     grant. A `writeScope: scratch` declaration changes nothing here: such an agent
//     is write-capable and needs isolation like any other (a redesign of trust for
//     scoped writers is tracked in #312).
//   - Definition file exists but is unreadable ⇒ that TYPE requires isolation
//     (fail-closed tier: classification ran and found nothing provably safe.
//     The fail-open tier below is reserved for malformed stdin and our own
//     bugs, where classification never ran at all).
//   - No definition file → only the known built-ins are hardcoded: Explore and
//     Plan are trusted as read-only (see BUILTIN_READ_ONLY). Their grant is not
//     read-only, since it still includes Bash. The trust rests on their built-in
//     prompt, which tells them not to modify files;
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
// and the few filesystem reads the git probe and the agent-definition lookup make.
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
// Scoped writers (#312). An agent that declares `writeScope: scratch` is classified like any other
// write-capable type and needs isolation. agent-write-scope.ts confines its Write and Edit calls to
// a scratch folder, but the worktree gate does not rely on that. Trusting it needs the two gates to
// agree on the definition, the type name, the project root and the registration, and the redesign
// is tracked in #312.
//
// Decision logic lives in the exported `decide()`, exercised offline by
// test/agent-worktree-gate.test.ts without spawning a process. The stdin/stdout
// contract itself IS spawn-tested (#78): see the
// "spawned process" describe block at the end of that file.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidAgentName } from "./agent-name";
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
 * Explore and Plan are trusted as read-only because their built-in prompt is read-only, not
 * because their tool grant is. The Agent tool's own roster lists them with "All tools except Agent,
 * Artifact, ExitPlanMode, Edit, Write, NotebookEdit", so both hold Bash and could write through it.
 * The gate exempts them anyway (operator ruling, #190): the prompt keeps them to reading and
 * Write and Edit are withheld. No source documents a read-only prompt for any other built-in,
 * so none is listed. general-purpose
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
 * a linked worktree uses), searched from the directory's real path so links resolve. `unknown` when
 * `dir` is not an existing directory or a read fails for any reason but absence. `not-repo` only when the walk reaches the filesystem root (`/` or a drive
 * root) having found nothing. Unknown fails closed in the caller: the gate behaves as it did.
 */
export function probeGitWorkTree(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): GitProbe {
  if (env.GIT_DIR || env.GIT_WORK_TREE) return "repo";
  try {
    if (!statSync(dir).isDirectory()) return "unknown";
    // Walk from the real location. A junction or symlink into a repository is that repository, and
    // a lexical walk would climb the link's own parents and call it not-repo.
    let p = realpathSync.native(dir);
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

const ALLOW: GateDecision = { action: "allow" };

/** Per-process memo of agentsDir+type → requires-isolation. Short-lived by construction. */
const classificationCache = new Map<string, boolean>();

/**
 * The lines between the opening and closing frontmatter fences, or null when the block cannot be
 * read with confidence. A fence is a whole line: three dashes and optional trailing ASCII spaces or
 * tabs, so a no-break space or U+FEFF after them is not a fence. The first line must be one and the
 * close is the next one, so a line that merely starts with `---`
 * (`----`, `---x`) is not a close. Claude Code does not close there, so closing there would let
 * lines after it decide the classification against a block Claude Code reads differently. Such a
 * line inside the block makes the result null, as do a missing close, a missing opening fence and a
 * leading byte order mark. Null means the type requires isolation.
 *
 * This is deliberately not the shared writeScope parser's fence code (write-scope-parse.ts). The
 * two sides need opposite failure directions. This gate decides whether a type may skip isolation,
 * so it must under-detect: anything odd reads as no frontmatter. The write-scope gate decides what
 * to confine, so it must over-detect: it strips a byte order mark and ignores a dash-led line. One
 * shared function would force a single direction on both. The plain fence test is the same in both.
 */
export function frontmatterLines(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  if (!/^---[ \t]*\r?$/.test(lines[0] ?? "")) return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?$/.test(lines[i])) return lines.slice(1, i);
    if (lines[i].startsWith("---")) return null;
  }
  return null;
}

/**
 * True unless the frontmatter proves the role read-only: a `tools:` field whose
 * every entry is on the read-only allowlist. Absent/empty field means all tools.
 * The key is matched case-sensitively, as Claude Code reads it, so `Tools:` or `TOOLS:` is no grant
 * at all and the role inherits every tool.
 */
function frontmatterRequiresIsolation(text: string): boolean {
  const lines = frontmatterLines(text);
  if (lines === null) return true; // no readable frontmatter → cannot prove read-only
  // A `memory:` field (any scope) auto-enables Read, Write, and Edit regardless
  // of what `tools:` grants, per the docs' persistent-memory section.
  // `memory: user` writes outside the checkout (~/.claude/agent-memory/), so
  // isolating it is a known false positive, but that is the safe direction and
  // PROJECT_EXCEPTIONS is the carve-out if a real def ever needs it. Anchored
  // at line start so a `memory:` substring inside a description value does
  // not false-positive.
  if (lines.some((l) => /^memory\s*:\s*\S/i.test(l))) return true;
  // Case-sensitive on purpose: Claude Code reads the `tools` key exactly, so `Tools:` grants nothing
  // and the role inherits every tool. A case-insensitive match would read it as a restriction.
  const toolsLine = lines.find((l) => /^tools\s*:/.test(l));
  if (!toolsLine) return true; // no tools: restriction = all tools
  const tokens = toolsLine
    .replace(/^tools\s*:/, "")
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
): boolean {
  if (PROJECT_EXCEPTIONS.includes(subagentType)) return false;
  if (!isValidAgentName(subagentType)) return true;

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

/**
 * Decision over the PreToolUse stdin payload. Unrecognizable input allows.
 *
 * `projectRoot` null or omitted means no root is known: the probe is not called and the non-git
 * allow never fires.
 */
export function decide(
  payload: unknown,
  agentsDir: string = DEFAULT_AGENTS_DIR,
  projectRoot: string | null = null,
  probe: (dir: string) => GitProbe = (dir) => probeGitWorkTree(dir),
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
    const decision = decide(payload, DEFAULT_AGENTS_DIR, projectRootOf(process.env));
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
