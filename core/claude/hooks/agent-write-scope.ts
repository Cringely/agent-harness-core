// PreToolUse hook (matcher: Write|Edit|NotebookEdit) — the scratch-scope gate.
//
// A subagent that only needs somewhere to drop a report should not hold an
// unrestricted write. The obvious lever, dropping Write from its `tools:`
// grant, over-corrects: an agent with no write tool has no file to leave its
// findings in, so its whole report comes back as a message, into the
// dispatcher's context and the operator's view. That is the problem the
// scratch file existed to solve, reintroduced by the fix.
//
// So the grant stays and the PATH gets constrained. An agent definition
// declaring `writeScope: scratch` may write inside a scratch directory and
// nowhere else; every other file write it attempts is denied here, before the
// permission system is consulted.
//
// Why a hook rather than a permission rule: `Edit(path)` rules do exactly this
// job, but they live in settings.json and apply session-wide. There is no
// per-subagent permission block, so a rule tight enough for a research agent
// would also bind the main session. A PreToolUse hook is the only layer that
// sees `agent_type` on the call and can scope by it. (Note the umbrella
// oddity while you are here: a `Write(path)` permission rule is accepted and
// never matched — `Edit(path)` is what governs Write, Edit, and NotebookEdit
// alike. That trap is why this gate keys on the tool call instead.)
//
// Scope is DERIVED from `.claude/agents/<type>.md` frontmatter, not from a
// list kept in this file. A hand-maintained list drifts the first time
// someone adds an agent and forgets to update it, which is the failure class
// the gate exists to close. An agent with no `writeScope` declared gets no
// opinion from this hook at all, so adding it to a project changes nothing
// until a definition opts in.
//
// Coverage boundary, stated because it is easy to over-trust: this gate sees
// the Claude Code tool call. It does not see a shell redirect or a script that
// opens a file itself. An agent holding Bash can write wherever the OS lets
// it regardless of what this hook says. Pair `writeScope` with a tools grant
// that excludes Bash, or with OS-level sandbox filesystem rules, if the agent
// is untrusted rather than merely narrow.
//
// Scratch-named ancestors. SCRATCH_SEGMENTS matches a path segment, and a segment
// counts only when the directory it names does not contain the project root. Without
// that condition a project checked out under `/home/x/scratch/myrepo` put every file
// in scope, so decide() allowed every write by every agent and nothing logged it.
// Now:
//
//   - A scratch-named directory that contains the project root is not scratch.
//   - A project whose root sits inside a scratch directory therefore gets denies for
//     scoped writes outside a deeper scratch folder. That is the fail-closed
//     direction: the scoped agent can still write under `<project>/.claude/scratch`,
//     which the harness ships, and nowhere else.
//   - A tracked subfolder of the project named `scratch`, `scratchpad` or `.scratch`
//     is still in scope, because it does not contain the project root.
//
// The project root is CLAUDE_PROJECT_DIR when set and the session cwd otherwise. A
// relative filePath resolves against the session cwd, which arrives on stdin as
// `payload.cwd`. readSessionCwd() below type-checks that field but cannot narrow it
// further, since a cwd IS a directory path, so the project root and the base for
// relative paths are both payload- or environment-driven with no narrower shape.
//
// Fail-open contract, matching agent-worktree-gate.ts: malformed stdin,
// missing fields, an unreadable definition, or our own bugs all log to stderr
// and exit 0 with no stdout, which Claude Code reads as "no opinion" and the
// normal permission flow proceeds. Only a well-formed deny emits JSON. A
// broken gate must never brick writing.
//
// Decision logic is the exported pure decide(); `bun test
// test/agent-write-scope.test.ts` exercises it with no spawn and no filesystem.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isValidAgentName } from "./agent-name";
import { parseWriteScope } from "./write-scope-parse";

/**
 * Marks the scratch-parent fix and the shared writeScope parser. The worktree gate trusts a
 * definition's `writeScope` only when the installed scope gate is at this version or later. Bump it
 * whenever a change to this gate alters what `writeScope: scratch` confines.
 */
export const WRITE_SCOPE_GATE_VERSION = 2;

/**
 * Directory names that count as scratch. A path is in scope if a segment matches and that
 * directory does not contain the project root (see the header).
 * `scratch` is here because it is the drop box `install/Install-Harness.ps1` creates
 * under a project's `.claude`; without it this gate denied the one scratch directory
 * the harness itself ships. Rejected matching the `.claude/scratch` suffix instead:
 * that adds a second matching rule beside segment matching to buy precision this gate
 * does not claim, per the coverage boundary above.
 */
const SCRATCH_SEGMENTS = new Set(["scratchpad", ".scratch", "scratch"]);

export type Decision = { action: "allow" } | { action: "deny"; reason: string };

/**
 * Is `filePath` inside a scratch directory? Resolved against `cwd` when
 * relative, so a bare `../../etc/hosts` cannot slip through as "not absolute".
 *
 * A scratch-named segment counts only when the project's own segments do not start with the file's
 * segments up to and including it, i.e. when that directory does not contain the project root.
 * Compared lowercased on every platform: case-insensitive containment can only add denies.
 */
export function inScratch(filePath: string, cwd: string, projectDir: string): boolean {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const segments = abs.split(/[\\/]+/).map((s) => s.toLowerCase());
  const project = resolve(projectDir)
    .split(/[\\/]+/)
    .map((s) => s.toLowerCase());
  return segments.some(
    (segment, i) =>
      SCRATCH_SEGMENTS.has(segment) &&
      !(project.length > i && segments.slice(0, i + 1).every((s, j) => s === project[j])),
  );
}

/**
 * The `writeScope` value declared in an agent definition's frontmatter, or null
 * when the file is absent, unreadable, or declares nothing. Null means this
 * hook has no opinion — absence of a declaration is not a reason to block.
 *
 * `agentType` is payload text and becomes a path one line down, so it is checked against the
 * agent-name allowlist first (backlog item 38). A name that fails is treated as a name with no
 * definition — the same null this returns for an absent file — because that is already the
 * outcome for every unrecognized type, and because a throw here would break the hook's fail-open
 * contract. The check subsumes the empty-string guard that used to sit on this line: "" has no
 * first character, so the allowlist rejects it, and it must be rejected — `${""}.md` names the
 * readable file `.md`.
 */
export function readWriteScope(agentType: string, projectDir: string): string | null {
  if (!isValidAgentName(agentType)) return null;
  const defPath = join(projectDir, ".claude", "agents", `${agentType}.md`);
  if (!existsSync(defPath)) return null;
  try {
    return parseWriteScope(readFileSync(defPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The session working directory from the hook payload, or this process's own when the payload
 * does not carry a usable one.
 *
 * Why this is a TYPE check and not the charset check `agent_type` gets. Both fields arrive on the
 * same stdin, and the difference is what they are, not where they come from. `agent_type` names a
 * definition file, so a filename-safe segment is the whole of what it may be, and anything else is
 * malformed. `cwd` IS a directory path — it is the base `inScratch()` resolves a relative write
 * against, and it stands in for projectDir when CLAUDE_PROJECT_DIR is unset — so there is no
 * narrower shape to demand. Treating it as untrusted text would mean rejecting the legitimate
 * value.
 *
 * What it does need is to be a string. `join(42, …)` and `resolve({}, …)` throw, the throw is
 * caught by the outermost handler below, and the hook then exits 0 with no stdout — so a
 * malformed cwd used to convert a deny this gate would have made into silence. Falling back keeps
 * the gate deciding. */
export function readSessionCwd(payload: unknown): string {
  const value = (payload as Record<string, unknown> | null | undefined)?.cwd;
  return typeof value === "string" && value !== "" ? value : process.cwd();
}

/**
 * Deny a write that a scratch-scoped agent aims outside its scratch directory.
 * Every other combination allows: unscoped agents, the main session (no
 * agent_type), and in-scope writes.
 */
export function decide(
  scope: string | null,
  filePath: string | undefined,
  cwd: string,
  projectDir: string,
): Decision {
  if (scope !== "scratch") return { action: "allow" };
  if (!filePath) return { action: "allow" };
  if (inScratch(filePath, cwd, projectDir)) return { action: "allow" };
  return {
    action: "deny",
    reason:
      `This agent declares writeScope: scratch, so it may only write inside a ` +
      `scratch directory. ${filePath} is outside one. Write your report to the ` +
      `session scratchpad and send the path, or report your findings in a message ` +
      `if they are short enough to fit in one.`,
  };
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text();
    // Copilot CLI also runs .claude/settings.json hooks and fails closed on them (#227). Stand
    // down there, but never while CLAUDECODE is set, so a Claude Code session always runs the rest.
    if (process.env.COPILOT_CLI && !process.env.CLAUDECODE) process.exit(0);
    const payload = JSON.parse(raw);
    const cwd = readSessionCwd(payload);
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;
    const scope = readWriteScope(payload.agent_type ?? "", projectDir);
    const verdict = decide(
      scope,
      payload.tool_input?.file_path ?? payload.tool_input?.notebook_path,
      cwd,
      projectDir,
    );
    if (verdict.action === "deny") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: verdict.reason,
          },
        }),
      );
    }
  } catch (err) {
    console.error(`agent-write-scope: ${err}`);
  }
  process.exit(0);
}
