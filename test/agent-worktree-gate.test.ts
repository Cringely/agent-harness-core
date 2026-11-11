// Offline tests for the worktree-isolation PreToolUse gate
// (core/claude/hooks/agent-worktree-gate.ts). Classification and the full
// stdin-payload decision live in the exported pure requiresIsolation() and
// decide(), so most of these run against real temp agent-definition files but
// never spawn the hook process itself. The header used to claim (at lines
// 53-55) that the stdin/stdout CLI wrapper was "covered separately by spawn
// tests in the same style" while no such spawn test existed here or anywhere
// else in test/ (#78) — the "spawned process" describe block at the end of
// this file is what makes that claim true now.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  BASE_SHA_TOKEN,
  decide,
  type GitProbe,
  loadWriteScopeParser,
  nonGitNote,
  OVERRIDE_TOKEN,
  probeGitWorkTree,
  PROJECT_EXCEPTIONS,
  projectRootOf,
  REQUIRED_WRITE_SCOPE_GATE_VERSION,
  requiresIsolation,
} from "../core/claude/hooks/agent-worktree-gate";
import { parseWriteScope } from "../core/claude/hooks/write-scope-parse";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOKS_SRC = join(REPO_ROOT, "core", "claude", "hooks");
const HOOK = join(HOOKS_SRC, "agent-worktree-gate.ts");

/**
 * Runs a hook as a real process with `stdinText` on stdin. Never goes through a shell. The project
 * root defaults to this repository so the git probe answers "repo" whatever the caller's shell
 * exported, and GIT_DIR / GIT_WORK_TREE are dropped so a git hook running this suite cannot turn a
 * non-git temp dir into a repo. `env` entries override, and an undefined value removes the key.
 */
function runHook(stdinText: string, env: Record<string, string | undefined> = {}, hook: string = HOOK) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: REPO_ROOT,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    ...env,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, hook],
    stdin: new TextEncoder().encode(stdinText),
    stdout: "pipe",
    stderr: "pipe",
    env: clean,
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// --- Fixture agent-definitions directory, built once. Every scenario below
// gets its own subagent_type name so none of them collide in the module's
// per-process classification cache (keyed on agentsDir + type). -----------

const agentsDir = mkdtempSync(join(tmpdir(), "worktree-gate-agents-"));

function writeDef(type: string, lines: string[]) {
  writeFileSync(join(agentsDir, `${type}.md`), ["---", ...lines, "---", "", "Body text."].join("\n"));
}

writeDef("reader", ["name: reader", "tools: Read, Grep, Glob"]);
writeDef("reader-mixed-case", ["name: reader-mixed-case", "tools: READ, Grep, WebFetch"]);
writeDef("writer", ["name: writer", "tools: Read, Write"]);
writeDef("no-tools", ["name: no-tools", "description: has no tools field at all"]);
writeDef("empty-tools", ["name: empty-tools", "tools:"]);
writeDef("memory-project", ["name: memory-project", "tools: Read, Grep, Glob", "memory: project"]);
writeDef("memory-user", ["name: memory-user", "tools: Read, Grep, Glob", "memory: user"]);
writeDef("memory-local", ["name: memory-local", "tools: Read, Grep, Glob", "memory: local"]);
writeDef("memory-substring", [
  "name: memory-substring",
  "description: tracks agent memory: cleanup notes",
  "tools: Read, Grep, Glob",
]);
writeFileSync(join(agentsDir, "malformed-no-close.md"), "---\nname: malformed-no-close\ntools: Read\n");
writeFileSync(join(agentsDir, "no-frontmatter.md"), "Just a body, no frontmatter delimiters at all.\n");
// A directory where a file is expected: existsSync sees it, readFileSync throws EISDIR.
mkdirSync(join(agentsDir, "unreadable-def.md"));

afterAll(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

describe("requiresIsolation() — tools: frontmatter, pre-existing paths", () => {
  test("read-only tools allowlist: exempted", () => {
    expect(requiresIsolation("reader", agentsDir)).toBe(false);
  });

  test("tokens are matched case-insensitively", () => {
    expect(requiresIsolation("reader-mixed-case", agentsDir)).toBe(false);
  });

  test("any write-capable tool in the list: requires isolation", () => {
    expect(requiresIsolation("writer", agentsDir)).toBe(true);
  });

  test("no tools: field at all: all tools, requires isolation", () => {
    expect(requiresIsolation("no-tools", agentsDir)).toBe(true);
  });

  test("empty tools: value: all tools, requires isolation", () => {
    expect(requiresIsolation("empty-tools", agentsDir)).toBe(true);
  });
});

describe("requiresIsolation() — memory: field forces isolation", () => {
  test.each(["memory-project", "memory-user", "memory-local"])(
    "%s: memory: overrides an otherwise read-only tools list",
    (type) => {
      expect(requiresIsolation(type, agentsDir)).toBe(true);
    },
  );

  test("no memory: key present: unaffected, falls through to the tools check", () => {
    expect(requiresIsolation("reader", agentsDir)).toBe(false);
    expect(requiresIsolation("writer", agentsDir)).toBe(true);
  });

  test("a `memory:` substring inside a description value does not trigger isolation (anchored at line start)", () => {
    expect(requiresIsolation("memory-substring", agentsDir)).toBe(false);
  });
});

describe("requiresIsolation() — fails toward isolation for a def it cannot prove read-only (not hook-level fail-open)", () => {
  test("malformed frontmatter (no closing ---): cannot parse, requires isolation", () => {
    expect(requiresIsolation("malformed-no-close", agentsDir)).toBe(true);
  });

  test("no frontmatter delimiters at all: requires isolation", () => {
    expect(requiresIsolation("no-frontmatter", agentsDir)).toBe(true);
  });

  test("def file exists but can't be read (EISDIR): requires isolation, does not throw", () => {
    expect(() => requiresIsolation("unreadable-def", agentsDir)).not.toThrow();
    expect(requiresIsolation("unreadable-def", agentsDir)).toBe(true);
  });

  test("no definition file, unknown type: requires isolation", () => {
    expect(requiresIsolation("some-unknown-role", agentsDir)).toBe(true);
  });

  test("no definition file, general-purpose: requires isolation (all tools)", () => {
    expect(requiresIsolation("general-purpose", agentsDir)).toBe(true);
  });

  test("no definition file, fork: requires isolation (all tools)", () => {
    expect(requiresIsolation("fork", agentsDir)).toBe(true);
  });
});

describe("requiresIsolation() — built-in read-only types", () => {
  test("explore: exempted", () => {
    expect(requiresIsolation("explore", agentsDir)).toBe(false);
  });

  test("plan: exempted", () => {
    expect(requiresIsolation("plan", agentsDir)).toBe(false);
  });
});

describe("requiresIsolation() — PROJECT_EXCEPTIONS", () => {
  afterEach(() => {
    PROJECT_EXCEPTIONS.length = 0;
  });

  test("a type listed in PROJECT_EXCEPTIONS bypasses classification entirely, even for a write-capable def", () => {
    PROJECT_EXCEPTIONS.push("writer");
    expect(requiresIsolation("writer", agentsDir)).toBe(false);
  });

  test("without the exception the same def still requires isolation", () => {
    expect(requiresIsolation("writer", agentsDir)).toBe(true);
  });

  // Claude Code dispatches a plugin's agent as `plugin:agent`, and `:` is deliberately outside the
  // agent-name allowlist because it is the alternate-data-stream separator on Windows. Running the
  // name check ahead of this list therefore made every plugin-namespaced exception silently inert:
  // an operator's entry stopped exempting and the deny message blamed the role's tools frontmatter,
  // which was not the reason. An exception entry is an operator-written literal that never becomes
  // a path, so the check that keeps payload text out of a path does not apply to it.
  test.each([
    ["caveman:cavecrew-investigator", "a plugin-namespaced type"],
    ["feature-dev:code-explorer", "another plugin-namespaced type"],
    ["my.reader", "a dotted type"],
  ])("an exception entry the allowlist rejects still exempts: %p (%s)", (type) => {
    PROJECT_EXCEPTIONS.push(type);
    expect(requiresIsolation(type, agentsDir)).toBe(false);
  });

  // The exception list is the only thing that lets such a name through. Without an entry it stays
  // on the requires-isolation default, so moving the check has not opened a hole.
  test.each(["caveman:cavecrew-investigator", "../outside/escaped", "my.reader"])(
    "with no exception entry, a name the allowlist rejects still requires isolation: %p",
    (type) => {
      expect(requiresIsolation(type, agentsDir)).toBe(true);
    },
  );
});

describe("decide() — payload-level fail-open (unrecognizable input allows)", () => {
  test("non-object payload", () => {
    expect(decide(null, agentsDir)).toEqual({ action: "allow" });
    expect(decide("nope", agentsDir)).toEqual({ action: "allow" });
  });

  test("tool_name other than Agent/Task is ignored", () => {
    expect(
      decide({ tool_name: "Bash", tool_input: { subagent_type: "writer" } }, agentsDir),
    ).toEqual({ action: "allow" });
  });

  test("tool_input not an object", () => {
    expect(decide({ tool_name: "Agent", tool_input: "nope" }, agentsDir)).toEqual({ action: "allow" });
  });

  test("subagent_type is a non-string value", () => {
    expect(
      decide({ tool_name: "Agent", tool_input: { subagent_type: 5 } }, agentsDir),
    ).toEqual({ action: "allow" });
  });
});

describe("decide() — subagent_type defaulting", () => {
  test("omitted subagent_type defaults to general-purpose, which requires isolation", () => {
    const verdict = decide({ tool_name: "Agent", tool_input: {} }, agentsDir);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain("general-purpose");
  });

  test("blank subagent_type also defaults to general-purpose", () => {
    const verdict = decide({ tool_name: "Task", tool_input: { subagent_type: "   " } }, agentsDir);
    expect(verdict.action).toBe("deny");
  });
});

describe("decide() — read-only type: always allowed", () => {
  test("no isolation needed for a read-only type", () => {
    expect(
      decide({ tool_name: "Agent", tool_input: { subagent_type: "reader" } }, agentsDir),
    ).toEqual({ action: "allow" });
  });
});

const SHA = "b".repeat(40);

describe("decide() — every isolated write dispatch needs a base sha (#36)", () => {
  const dispatch = (prompt: string | undefined, isolation = "worktree") => ({
    tool_name: "Agent",
    tool_input: { subagent_type: "writer", isolation, prompt },
  });

  test("worktree dispatch, no base sha: denied and names the token", () => {
    const v = decide(dispatch("do a thing"), agentsDir);
    expect(v.action).toBe("deny");
    if (v.action === "deny") expect(v.reason).toContain(BASE_SHA_TOKEN);
  });

  test("worktree dispatch, base sha line present: allowed", () => {
    expect(decide(dispatch(`intro\nBASE-SHA: ${SHA}\nbody`), agentsDir)).toEqual({ action: "allow" });
  });

  test("a missing prompt is the same as no base sha line", () => {
    expect(decide(dispatch(undefined), agentsDir).action).toBe("deny");
  });

  test("a mid-sentence mention of the token does not count", () => {
    expect(decide(dispatch("put a BASE-SHA: abcdef1 somewhere"), agentsDir).action).toBe("deny");
  });

  test("a non-hex value does not count", () => {
    expect(decide(dispatch("BASE-SHA: not-a-sha"), agentsDir).action).toBe("deny");
  });

  test("a leading-space line and a 7-digit sha count", () => {
    expect(decide(dispatch("  BASE-SHA: abcdef1"), agentsDir).action).toBe("allow");
  });

  test("remote isolation needs the line too", () => {
    expect(decide(dispatch("x", "remote"), agentsDir).action).toBe("deny");
    expect(decide(dispatch(`BASE-SHA: ${SHA}`, "remote"), agentsDir).action).toBe("allow");
  });

  test("a read-only type is never asked for a base sha", () => {
    expect(
      decide(
        { tool_name: "Agent", tool_input: { subagent_type: "reader", isolation: "worktree", prompt: "x" } },
        agentsDir,
      ).action,
    ).toBe("allow");
  });
});

describe("decide() — write-capable type: isolation or override required", () => {
  test("no isolation, no override: denied", () => {
    const verdict = decide({ tool_name: "Agent", tool_input: { subagent_type: "writer" } }, agentsDir);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("writer");
      expect(verdict.reason).toContain(OVERRIDE_TOKEN);
    }
  });

  test.each(["worktree", "remote"])("isolation: %s allows", (isolation) => {
    expect(
      decide(
        { tool_name: "Agent", tool_input: { subagent_type: "writer", isolation, prompt: `BASE-SHA: ${SHA}` } },
        agentsDir,
      ),
    ).toEqual({ action: "allow" });
  });

  test("an isolation value that isn't worktree/remote does not pass", () => {
    const verdict = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "writer", isolation: "none" } },
      agentsDir,
    );
    expect(verdict.action).toBe("deny");
  });

  test("a reasoned override in the prompt allows", () => {
    expect(
      decide(
        {
          tool_name: "Agent",
          tool_input: { subagent_type: "writer", prompt: `${OVERRIDE_TOKEN} needed for X` },
        },
        agentsDir,
      ),
    ).toEqual({ action: "allow" });
  });

  test("a bare override token with no reason text does not pass", () => {
    const verdict = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "writer", prompt: OVERRIDE_TOKEN } },
      agentsDir,
    );
    expect(verdict.action).toBe("deny");
  });
});

describe("decide() — memory: field end to end", () => {
  test("a memory: def with read-only tools still requires isolation via decide()", () => {
    const verdict = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "memory-project" } },
      agentsDir,
    );
    expect(verdict.action).toBe("deny");
  });

  test("isolation: worktree still clears a memory: def", () => {
    expect(
      decide(
        {
          tool_name: "Agent",
          tool_input: { subagent_type: "memory-project", isolation: "worktree", prompt: `BASE-SHA: ${SHA}` },
        },
        agentsDir,
      ),
    ).toEqual({ action: "allow" });
  });
});

describe("decide() — subagent_type is normalized before classification", () => {
  test("mixed-case and padded type resolves the same def file", () => {
    expect(
      decide({ tool_name: "Agent", tool_input: { subagent_type: "  Reader  " } }, agentsDir),
    ).toEqual({ action: "allow" });
  });
});

// --- item 38: subagent_type is payload text, not a path fragment -------------------------------
//
// requiresIsolation() interpolates subagent_type straight into `<agentsDir>/<type>.md`. Its own
// fixture tree, separate from the shared one above, because these definitions have to sit in
// places a well-formed name cannot reach. Every planted definition declares a read-only tools
// grant, so an unguarded read RESOLVES it and returns false — the gate stands down for a
// definition the dispatcher chose the path to. A guarded read returns true, the same answer a
// missing definition gives.

const traversalRoot = mkdtempSync(join(tmpdir(), "worktree-gate-agent-type-"));
const traversalAgentsDir = join(traversalRoot, "agents");
mkdirSync(join(traversalAgentsDir, "sub"), { recursive: true });
mkdirSync(join(traversalRoot, "outside"), { recursive: true });

function writeReadOnlyDef(absPath: string) {
  writeFileSync(absPath, ["---", "name: planted", "tools: Read, Grep, Glob", "---", "", "Body."].join("\n"));
}

writeReadOnlyDef(join(traversalAgentsDir, "valid-reader.md"));
// The file an empty subagent_type resolves to once `<type>.md` is interpolated.
writeReadOnlyDef(join(traversalAgentsDir, ".md"));
// Reached by a separator-bearing name, and by an absolute one: node's join() folds a leading
// separator instead of restarting from the filesystem root, so `/sub/nested` lands here too.
writeReadOnlyDef(join(traversalAgentsDir, "sub", "nested.md"));
// Outside the agents directory entirely — only a traversal reaches this one.
writeReadOnlyDef(join(traversalRoot, "outside", "escaped.md"));

afterAll(() => {
  rmSync(traversalRoot, { recursive: true, force: true });
});

describe("requiresIsolation() — item 38: only a filename-safe type name resolves a definition", () => {
  test("a normal type name still resolves its definition and is exempted", () => {
    expect(requiresIsolation("valid-reader", traversalAgentsDir)).toBe(false);
  });

  test.each([
    ["traversal", "../outside/escaped"],
    ["absolute path", "/sub/nested"],
    ["path separator", "sub/nested"],
    ["empty string", ""],
  ])("%s in subagent_type proves nothing, so isolation is required: %p", (_label, type) => {
    expect(requiresIsolation(type, traversalAgentsDir)).toBe(true);
  });

  test("a traversing subagent_type is denied end to end, not silently exempted", () => {
    const verdict = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "../outside/escaped", prompt: "go" } },
      traversalAgentsDir,
    );
    expect(verdict.action).toBe("deny");
  });
});

// --- #78: the import.meta.main stdin/stdout entrypoint itself, spawned for real ------------------
//
// Every test above calls decide()/requiresIsolation() directly with an injected agentsDir, which
// proves the classification policy is correct but not that the entrypoint reads stdin, calls
// decide() with the REAL default agents directory, and serializes the answer the way Claude Code
// expects. The CLI wrapper takes no agentsDir override (unlike decide() itself), so this test uses
// the hardcoded BUILTIN classification (general-purpose requires isolation, explore does not)
// rather than a planted fixture def — those two are stable regardless of what
// core/claude/agents/*.md happens to contain.
//
// Deleting the `if (import.meta.main)` block leaves this hook doing nothing at all: no stdin read,
// no stdout, exit 0 — identical to the allow path on any assertion that only checks "exit 0, empty
// output". Confirmed live during this fix (ablate, then restore): with the block deleted, a
// general-purpose dispatch with no isolation — which should deny — instead exits 0 silently, and
// nothing in this file's PRE-#78 suite caught it, since none of it spawned the process. The deny
// case below is what actually catches that.

describe("spawned process — the deny path is observable", () => {
  test("general-purpose with no isolation and no override: exit 0, deny JSON on stdout", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", description: "d", prompt: "do a thing" },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("general-purpose");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(OVERRIDE_TOKEN);
  });

  test("an isolated dispatch with a base sha line: exit 0, silent (no opinion)", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Agent",
        tool_input: {
          subagent_type: "general-purpose",
          prompt: `BASE-SHA: ${"a".repeat(40)}\ndo a thing`,
          isolation: "worktree",
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("an isolated dispatch with no base sha line: exit 0, deny JSON naming the token", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", prompt: "do a thing", isolation: "worktree" },
      }),
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(BASE_SHA_TOKEN);
  });

  test("a built-in read-only type (explore): exit 0, silent, no isolation required", () => {
    const result = runHook(
      JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "explore", prompt: "look around" } }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("spawned process — the fail-open path stays open and says why", () => {
  test("malformed JSON exits 0, no stdout, and leaves a diagnostic instead of vanishing", () => {
    const result = runHook("{not json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("agent-worktree-gate: hook error, allowing dispatch:");
  });

  test("a non-Agent/Task tool is ignored: exit 0, silent", () => {
    const result = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

// --- #310: the gate checks its own preconditions -----------------------------------------------
//
// Outside a git repository a worktree cannot exist, so a deny that says "re-dispatch isolated"
// sends the dispatcher to an impossible fix. The gate asks the filesystem (no git binary) and, when
// the project root is provably not a repository, lets the dispatch through with a note. Every
// answer short of "not-repo" keeps today's behaviour.

/** True when a `.git` entry exists at `dir` or any ancestor, so a temp dir there is not a clean non-repo. */
function hasGitAncestor(dir: string): boolean {
  let p = resolve(dir);
  for (;;) {
    if (existsSync(join(p, ".git"))) return true;
    if (dirname(p) === p) return false;
    p = dirname(p);
  }
}
const TMP_UNDER_GIT = hasGitAncestor(tmpdir());

const scratchDirs: string[] = [];
function tmpRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
}
function gitTmpRoot(prefix: string): string {
  const d = tmpRoot(prefix);
  mkdirSync(join(d, ".git"));
  return d;
}
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

describe("probeGitWorkTree() — filesystem only, no git binary", () => {
  test("a dir holding a .git directory is a repo, and so is a subfolder of it", () => {
    const root = gitTmpRoot("wg-probe-dir-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(probeGitWorkTree(root, {})).toBe("repo");
    expect(probeGitWorkTree(join(root, "a", "b"), {})).toBe("repo");
  });

  test("a .git FILE (the linked-worktree shape) is a repo", () => {
    const root = tmpRoot("wg-probe-file-");
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    expect(probeGitWorkTree(root, {})).toBe("repo");
  });

  // A junction (Windows) or symlink into a repository is that repository: git answers true there.
  // A lexical walk from the link's own spelling climbs the link's parents instead and says not-repo.
  test("a link into a repo reads as a repo, not as the folder the link sits in", () => {
    const repo = gitTmpRoot("wg-probe-target-");
    mkdirSync(join(repo, "sub"));
    const holder = tmpRoot("wg-probe-holder-");
    const link = join(holder, "linked");
    symlinkSync(join(repo, "sub"), link, "junction");
    expect(probeGitWorkTree(link, {})).toBe("repo");
  });

  test("a dangling link is unknown", () => {
    const holder = tmpRoot("wg-probe-dangling-");
    const link = join(holder, "dangling");
    symlinkSync(join(holder, "gone"), link, "junction");
    expect(probeGitWorkTree(link, {})).toBe("unknown");
  });

  test("a path that does not exist is unknown", () => {
    expect(probeGitWorkTree(join(tmpdir(), "wg-probe-no-such-dir-xyz"), {})).toBe("unknown");
  });

  test("a path that is a file, not a directory, is unknown", () => {
    const root = tmpRoot("wg-probe-notdir-");
    const f = join(root, "plain.txt");
    writeFileSync(f, "x");
    expect(probeGitWorkTree(f, {})).toBe("unknown");
  });

  test.each([["GIT_DIR"], ["GIT_WORK_TREE"]])("%s set makes any dir a repo", (key) => {
    const root = tmpRoot("wg-probe-env-");
    expect(probeGitWorkTree(root, { [key]: "/x" })).toBe("repo");
  });

  test("an empty GIT_DIR does not count", () => {
    expect(probeGitWorkTree(join(tmpdir(), "wg-probe-no-such-dir-xyz"), { GIT_DIR: "" })).toBe("unknown");
  });

  test.skipIf(TMP_UNDER_GIT)("a fresh temp dir with no .git in any ancestor is not-repo", () => {
    const root = tmpRoot("wg-probe-none-");
    expect(probeGitWorkTree(root, {})).toBe("not-repo");
  });
});

describe("projectRootOf() and nonGitNote()", () => {
  test("CLAUDE_PROJECT_DIR wins", () => {
    expect(projectRootOf({ CLAUDE_PROJECT_DIR: "/some/proj" })).toBe("/some/proj");
  });

  test("without it the root is two levels above the hooks dir", () => {
    expect(projectRootOf({})).toBe(join(HOOKS_SRC, "..", ".."));
    expect(projectRootOf({ CLAUDE_PROJECT_DIR: "" })).toBe(join(HOOKS_SRC, "..", ".."));
  });

  test("the note names the root and the git init remedy", () => {
    const note = nonGitNote("/p");
    expect(note).toContain("/p is not a git repository");
    expect(note).toContain("`git init`");
    expect(note).toBe(
      "Worktree gate: /p is not a git repository, so worktree isolation is not available and this " +
        "dispatch runs in the shared folder. A git repository in a subfolder of it is not isolated " +
        "either. If this work should be versioned, run `git init` here and the gate will isolate " +
        "concurrent writers.",
    );
  });
});

/** A probe that answers from a table and records every directory it was asked about. */
function stubProbe(table: Record<string, GitProbe>) {
  const calls: string[] = [];
  const probe = (dir: string): GitProbe => {
    calls.push(dir);
    return table[dir] ?? "unknown";
  };
  return { calls, probe };
}

const writerDispatch = (extra: Record<string, unknown> = {}, tool: Record<string, unknown> = {}) => ({
  tool_name: "Agent",
  tool_input: { subagent_type: "writer", prompt: "do a thing", ...tool },
  ...extra,
});

describe("decide() — a project root that is not a git repository (#310)", () => {
  test("root not-repo and no payload cwd: allow with the note", () => {
    const { probe } = stubProbe({ "/p": "not-repo" });
    const v = decide(writerDispatch(), agentsDir, "/p", probe);
    expect(v).toEqual({ action: "allow", note: nonGitNote("/p") });
    if (v.action === "allow") {
      expect(v.note).toContain("is not a git repository");
      expect(v.note).toContain("git init");
    }
  });

  test("root not-repo and payload cwd also not-repo: allow with the note", () => {
    const { probe } = stubProbe({ "/p": "not-repo", "/p/sub": "not-repo" });
    expect(decide(writerDispatch({ cwd: "/p/sub" }), agentsDir, "/p", probe)).toEqual({
      action: "allow",
      note: nonGitNote("/p"),
    });
  });

  test("root not-repo but payload cwd is a repo: deny", () => {
    const { probe } = stubProbe({ "/p": "not-repo", "/p/nested": "repo" });
    expect(decide(writerDispatch({ cwd: "/p/nested" }), agentsDir, "/p", probe).action).toBe("deny");
  });

  test("root a repo but payload cwd not-repo: deny", () => {
    const { probe } = stubProbe({ "/p": "repo", "/elsewhere": "not-repo" });
    expect(decide(writerDispatch({ cwd: "/elsewhere" }), agentsDir, "/p", probe).action).toBe("deny");
  });

  test("root not-repo but payload cwd unknown: deny", () => {
    const { probe } = stubProbe({ "/p": "not-repo" });
    expect(decide(writerDispatch({ cwd: "/gone" }), agentsDir, "/p", probe).action).toBe("deny");
  });

  test("root unknown: deny", () => {
    const { probe } = stubProbe({ "/p": "unknown" });
    expect(decide(writerDispatch(), agentsDir, "/p", probe).action).toBe("deny");
  });

  test("root a repo: today's logic, deny without isolation and an override", () => {
    const { probe } = stubProbe({ "/p": "repo" });
    expect(decide(writerDispatch(), agentsDir, "/p", probe).action).toBe("deny");
  });

  test("projectRoot null: deny, and the probe is never called", () => {
    const { calls, probe } = stubProbe({ "/p": "not-repo" });
    expect(decide(writerDispatch(), agentsDir, null, probe).action).toBe("deny");
    expect(calls).toEqual([]);
  });

  test("projectRoot omitted behaves like null", () => {
    expect(decide(writerDispatch(), agentsDir).action).toBe("deny");
  });

  test("a read-only type outside git: plain allow, no note, probe not called", () => {
    const { calls, probe } = stubProbe({ "/p": "not-repo" });
    const v = decide({ tool_name: "Agent", tool_input: { subagent_type: "reader" } }, agentsDir, "/p", probe);
    expect(v).toEqual({ action: "allow" });
    expect("note" in v).toBe(false);
    expect(calls).toEqual([]);
  });

  // The non-git allow replaces the isolation demand only where isolation is impossible. In a repo
  // an isolated write dispatch still has to name its base.
  test("in a repo an isolated write dispatch with no base sha is still denied", () => {
    const { probe } = stubProbe({ "/p": "repo" });
    const v = decide(writerDispatch({}, { isolation: "worktree" }), agentsDir, "/p", probe);
    expect(v.action).toBe("deny");
    if (v.action === "deny") expect(v.reason).toContain(BASE_SHA_TOKEN);
  });
});

// --- scoped writers: shell-less scratch agents are not repo writers ------------------------------

const scopedDir = mkdtempSync(join(tmpdir(), "worktree-gate-scoped-"));
scratchDirs.push(scopedDir);
function writeScopedDef(type: string, lines: string[], body: string[] = []) {
  writeFileSync(join(scopedDir, `${type}.md`), ["---", `name: ${type}`, ...lines, "---", "", ...body].join("\n"));
}
const SCOPED_TOOLS = "tools: Read, Grep, Glob, WebFetch, WebSearch, Write, SendMessage";
writeScopedDef("scoped", [SCOPED_TOOLS, "writeScope: scratch"]);
writeScopedDef("scoped-edit", ["tools: Read, Edit, Write", "writeScope: scratch"]);
writeScopedDef("scoped-readonly", ["tools: Read, Grep", "writeScope: scratch"]);
writeScopedDef("unscoped", [SCOPED_TOOLS]);
writeScopedDef("scoped-repo", [SCOPED_TOOLS, "writeScope: repo"]);
writeScopedDef("scoped-memory", [SCOPED_TOOLS, "writeScope: scratch", "memory: user"]);
writeScopedDef("dup-repo-first", [SCOPED_TOOLS, "writeScope: repo", "writeScope: scratch"]);
writeScopedDef("scoped-in-body", [SCOPED_TOOLS], ["writeScope: scratch"]);
const EXTRA_TOOLS: Array<[string, string]> = [
  ["scoped-plus-notebookedit", "NotebookEdit"],
  ["scoped-plus-bash", "Bash"],
  ["scoped-plus-powershell", "PowerShell"],
  ["scoped-plus-agent", "Agent"],
  ["scoped-plus-skill", "Skill"],
  ["scoped-plus-mcp", "mcp__x__y"],
  ["scoped-plus-star", "*"],
];
for (const [name, tool] of EXTRA_TOOLS) writeScopedDef(name, [`${SCOPED_TOOLS}, ${tool}`, "writeScope: scratch"]);
writeScopedDef("web-fetch", ["tools: Write"]);

describe("requiresIsolation() — a shell-less scratch writer is trusted only with the parser (#310)", () => {
  test("scratch scope, Write + Edit + SendMessage, no shell: not an isolation case", () => {
    expect(requiresIsolation("scoped", scopedDir, parseWriteScope)).toBe(false);
    expect(requiresIsolation("scoped-edit", scopedDir, parseWriteScope)).toBe(false);
  });

  test("the same def with parseScope null or omitted still requires isolation", () => {
    expect(requiresIsolation("scoped", scopedDir, null)).toBe(true);
    expect(requiresIsolation("scoped", scopedDir)).toBe(true);
  });

  test("a read-only grant stays exempt with or without the parser", () => {
    expect(requiresIsolation("scoped-readonly", scopedDir, null)).toBe(false);
    expect(requiresIsolation("scoped-readonly", scopedDir, parseWriteScope)).toBe(false);
  });

  test.each(EXTRA_TOOLS)("%s: adding %s to the grant requires isolation again", (type) => {
    expect(requiresIsolation(type, scopedDir, parseWriteScope)).toBe(true);
  });

  test("no writeScope declared: requires isolation", () => {
    expect(requiresIsolation("unscoped", scopedDir, parseWriteScope)).toBe(true);
  });

  test("writeScope: repo: requires isolation", () => {
    expect(requiresIsolation("scoped-repo", scopedDir, parseWriteScope)).toBe(true);
  });

  test("a memory: line puts the scratch writer back under isolation", () => {
    expect(requiresIsolation("scoped-memory", scopedDir, parseWriteScope)).toBe(true);
  });

  test("duplicate keys: the first one wins, so repo-then-scratch requires isolation", () => {
    expect(requiresIsolation("dup-repo-first", scopedDir, parseWriteScope)).toBe(true);
  });

  test("a writeScope line in the body is prose, not a declaration", () => {
    expect(requiresIsolation("scoped-in-body", scopedDir, parseWriteScope)).toBe(true);
  });

  // No source documents a grant for a built-in named web-fetch, so it is an unknown type.
  test("web-fetch with no def file is an unknown type and requires isolation", () => {
    expect(requiresIsolation("web-fetch", join(scopedDir, "no-such-dir"))).toBe(true);
  });

  test("a web-fetch.md def granting Write with no writeScope requires isolation", () => {
    expect(requiresIsolation("web-fetch", scopedDir, parseWriteScope)).toBe(true);
  });

  test("the classification cache keeps the with-parser and without-parser answers apart", () => {
    // Same agentsDir + type, asked both ways, in both orders: neither answer may leak to the other.
    expect(requiresIsolation("scoped-edit", scopedDir, null)).toBe(true);
    expect(requiresIsolation("scoped-edit", scopedDir, parseWriteScope)).toBe(false);
    expect(requiresIsolation("scoped-edit", scopedDir, null)).toBe(true);
  });

});

// A scoped writer is trusted only through decide(), and only for a definition the write-scope gate
// would read too: the gate looks the type up verbatim under `<projectRoot>/.claude/agents`.
describe("decide() — scoped-writer trust needs the project agents dir and the verbatim type name", () => {
  const projectRoot = tmpRoot("wg-scoped-project-");
  const projectAgents = join(projectRoot, ".claude", "agents");
  mkdirSync(projectAgents, { recursive: true });
  for (const f of ["scoped.md"]) copyFileSync(join(scopedDir, f), join(projectAgents, f));
  const inRepo = () => "repo" as GitProbe;
  const dispatch = (type: string) => ({ tool_name: "Agent", tool_input: { subagent_type: type, prompt: "go" } });

  test("a def in the project agents dir with the parser: allowed, silently", () => {
    expect(decide(dispatch("scoped"), projectAgents, projectRoot, inRepo, parseWriteScope)).toEqual({
      action: "allow",
    });
  });

  test("the same dispatch without the parser, or with no project root: denied", () => {
    expect(decide(dispatch("scoped"), projectAgents, projectRoot, inRepo, null).action).toBe("deny");
    expect(decide(dispatch("scoped"), projectAgents, null, inRepo, parseWriteScope).action).toBe("deny");
    expect(decide(dispatch("scoped"), projectAgents, undefined, inRepo, parseWriteScope).action).toBe("deny");
  });

  test("a def outside the project agents dir is not trusted, though the type name matches", () => {
    // scopedDir holds the same `scoped.md`, but the write-scope gate reads the project's own folder.
    expect(decide(dispatch("scoped"), scopedDir, projectRoot, inRepo, parseWriteScope).action).toBe("deny");
  });

  // Built by concatenation: join() and resolve() would normalise these away before the gate saw
  // them, and the point is that the gate's own comparison does.
  test.each([
    ["a trailing separator", projectAgents + sep],
    ["a trailing dot segment", projectAgents + sep + "."],
    ["an embedded dot segment", projectAgents + sep + "." + sep + sep],
    ["a doubled separator before the last segment", dirname(projectAgents) + sep + sep + "agents"],
    ["a parent segment that returns to it", projectAgents + sep + "x" + sep + ".."],
  ])("an agents dir spelled with %s still matches the project's", (_label, spelled) => {
    expect(spelled).not.toBe(projectAgents);
    expect(decide(dispatch("scoped"), spelled, projectRoot, inRepo, parseWriteScope)).toEqual({ action: "allow" });
  });

  test.each(["Scoped", "SCOPED", " scoped ", "scoped\t"])(
    "raw subagent_type %p differs from its normalized form: no trust, denied",
    (type) => {
      expect(decide(dispatch(type), projectAgents, projectRoot, inRepo, parseWriteScope).action).toBe("deny");
    },
  );
});

// --- loadWriteScopeParser(): the guarded dynamic import ----------------------------------------

function settingsJson(groups: Array<{ matcher?: string; command: string }>): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: groups.map((g) => ({
        ...(g.matcher === undefined ? {} : { matcher: g.matcher }),
        hooks: [{ type: "command", command: g.command }],
      })),
    },
  });
}
const SCOPE_CMD = 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-write-scope.ts"';

/**
 * Builds an installed-layout project: `<root>/.claude/{hooks,agents}`, a settings file and a git
 * marker. `gate` is "real" (a copy of the shipped agent-write-scope.ts), a stub source string, or
 * null for none.
 */
function makeInstall(opts: { parser?: boolean; gate?: "real" | string | null; settings?: string | null }) {
  const root = gitTmpRoot("wg-install-");
  const hooks = join(root, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  copyFileSync(join(HOOKS_SRC, "agent-name.ts"), join(hooks, "agent-name.ts"));
  copyFileSync(HOOK, join(hooks, "agent-worktree-gate.ts"));
  if (opts.parser !== false) copyFileSync(join(HOOKS_SRC, "write-scope-parse.ts"), join(hooks, "write-scope-parse.ts"));
  if (opts.gate === "real") copyFileSync(join(HOOKS_SRC, "agent-write-scope.ts"), join(hooks, "agent-write-scope.ts"));
  else if (typeof opts.gate === "string") writeFileSync(join(hooks, "agent-write-scope.ts"), opts.gate);
  if (opts.settings !== null) {
    writeFileSync(
      join(root, ".claude", "settings.json"),
      opts.settings ?? settingsJson([{ matcher: "Write|Edit|NotebookEdit", command: SCOPE_CMD }]),
    );
  }
  writeFileSync(
    join(root, ".claude", "agents", "scoped.md"),
    ["---", "name: scoped", SCOPED_TOOLS, "writeScope: scratch", "---", "", "Body."].join("\n"),
  );
  return {
    root,
    parserPath: join(hooks, "write-scope-parse.ts"),
    gatePath: join(hooks, "agent-write-scope.ts"),
    settingsPath: join(root, ".claude", "settings.json"),
    gate: join(hooks, "agent-worktree-gate.ts"),
  };
}

const VERSION_STUB = (v: string | null) =>
  v === null ? "export const SOMETHING_ELSE = 1;\n" : `export const WRITE_SCOPE_GATE_VERSION = ${v};\n`;

describe("loadWriteScopeParser() — trusts a parser only beside a current, registered scope gate", () => {
  test("the required version is 2", () => {
    expect(REQUIRED_WRITE_SCOPE_GATE_VERSION).toBe(2);
  });

  test("a module that does not exist resolves to null and does not throw", async () => {
    await expect(loadWriteScopeParser("./no-such-module")).resolves.toBeNull();
  });

  test("the shipped modules, registered under Write|Edit|NotebookEdit, load", async () => {
    const inst = makeInstall({ gate: "real" });
    const parser = await loadWriteScopeParser(undefined, undefined, inst.settingsPath, inst.root);
    expect(typeof parser).toBe("function");
    expect(parser!("---\nwriteScope: scratch\n---\n")).toBe("scratch");
  });

  test("installed copies of all three modules load from an absolute path", async () => {
    const inst = makeInstall({ gate: "real" });
    const parser = await loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root);
    expect(typeof parser).toBe("function");
  });

  test("a scope gate with no version export gives null", async () => {
    const inst = makeInstall({ gate: VERSION_STUB(null) });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a scope gate at version 1 gives null", async () => {
    const inst = makeInstall({ gate: VERSION_STUB("1") });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test('a version that is not a number ("2") gives null', async () => {
    const inst = makeInstall({ gate: VERSION_STUB('"2"') });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a scope gate at version 2 gives a parser", async () => {
    const inst = makeInstall({ gate: VERSION_STUB("2") });
    expect(typeof (await loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root))).toBe("function");
  });

  test("a later version also gives a parser", async () => {
    const inst = makeInstall({ gate: VERSION_STUB("3") });
    expect(typeof (await loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root))).toBe("function");
  });

  test("a missing scope gate module gives null", async () => {
    const inst = makeInstall({ gate: null });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a missing parser module gives null", async () => {
    const inst = makeInstall({ parser: false, gate: VERSION_STUB("2") });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a parser module that exports no parseWriteScope function gives null", async () => {
    const inst = makeInstall({ gate: VERSION_STUB("2") });
    writeFileSync(inst.parserPath, "export const parseWriteScope = 5;\n");
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a scope gate that throws on import gives null", async () => {
    const inst = makeInstall({ gate: 'throw new Error("boom");\nexport const WRITE_SCOPE_GATE_VERSION = 2;\n' });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a settings file that does not register the scope gate gives null", async () => {
    const inst = makeInstall({
      gate: VERSION_STUB("2"),
      settings: settingsJson([{ matcher: "Agent|Task", command: 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-worktree-gate.ts"' }]),
    });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test.each(["Write", "Edit", "NotebookEdit"])("registered only under %s gives null", async (matcher) => {
    const inst = makeInstall({ gate: VERSION_STUB("2"), settings: settingsJson([{ matcher, command: SCOPE_CMD }]) });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a matcher naming other tools that merely contain Write and Edit does not count", async () => {
    const inst = makeInstall({
      gate: VERSION_STUB("2"),
      settings: settingsJson([{ matcher: "WriteFile|EditFile", command: SCOPE_CMD }]),
    });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test.each(["Write|Edit", "Edit|Write", "Write|Edit|NotebookEdit", "*", ""])(
    "registered under a matcher that covers both (%p) gives a parser",
    async (matcher) => {
      const inst = makeInstall({ gate: VERSION_STUB("2"), settings: settingsJson([{ matcher, command: SCOPE_CMD }]) });
      expect(typeof (await loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root))).toBe("function");
    },
  );

  test("a group with no matcher at all covers every tool", async () => {
    const inst = makeInstall({ gate: VERSION_STUB("2"), settings: settingsJson([{ command: SCOPE_CMD }]) });
    expect(typeof (await loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root))).toBe("function");
  });

  test("the registration must be under PreToolUse, not PostToolUse", async () => {
    const inst = makeInstall({
      gate: VERSION_STUB("2"),
      settings: JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: SCOPE_CMD }] }] },
      }),
    });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test.each([
    ["a missing settings file", null],
    ["malformed JSON", "{not json"],
    ["a non-object", "5"],
    ["hooks that is not an object", '{"hooks": 5}'],
    ["PreToolUse that is not an array", '{"hooks": {"PreToolUse": {}}}'],
    ["a group that is null", '{"hooks": {"PreToolUse": [null]}}'],
    ["a hooks entry that is not an array", '{"hooks": {"PreToolUse": [{"matcher": "Write|Edit", "hooks": 3}]}}'],
    ["an invalid matcher regex", settingsJson([{ matcher: "Write|(Edit", command: SCOPE_CMD }])],
  ])("%s gives null and does not throw", async (_label, settings) => {
    const inst = makeInstall({ gate: VERSION_STUB("2"), settings });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });

  test("a registration split across two groups, one per tool, does not count", async () => {
    // Each group alone leaves one tool unguarded, so a scoped writer's Edit would go unconfined.
    const inst = makeInstall({
      gate: VERSION_STUB("2"),
      settings: settingsJson([
        { matcher: "Write", command: SCOPE_CMD },
        { matcher: "Edit", command: SCOPE_CMD },
      ]),
    });
    await expect(loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root)).resolves.toBeNull();
  });
});

describe("loadWriteScopeParser() — the registered command must name THIS project's scope gate", () => {
  const load = (inst: ReturnType<typeof makeInstall>) =>
    loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root);
  const withCommand = (command: string) => makeInstall({ gate: VERSION_STUB("2"), settings: settingsJson([{ matcher: "Write|Edit", command }]) });

  test.each([
    ["$CLAUDE_PROJECT_DIR", 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-write-scope.ts"'],
    ["${CLAUDE_PROJECT_DIR}", 'bun "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-write-scope.ts"'],
    ["unquoted", "bun $CLAUDE_PROJECT_DIR/.claude/hooks/agent-write-scope.ts"],
  ])("the project-dir variable form %s is accepted", async (_label, command) => {
    expect(typeof (await load(withCommand(command)))).toBe("function");
  });

  test("an absolute path to this project's copy is accepted, in either slash style", async () => {
    const inst = withCommand("placeholder");
    const abs = join(inst.root, ".claude", "hooks", "agent-write-scope.ts");
    for (const spelled of [abs, abs.replace(/\\/g, "/")]) {
      writeFileSync(inst.settingsPath, settingsJson([{ matcher: "Write|Edit", command: `bun "${spelled}"` }]));
      expect(typeof (await load(inst))).toBe("function");
    }
  });

  test("an absolute path to some other project's copy gives null", async () => {
    const other = gitTmpRoot("wg-other-project-");
    const cmd = `bun "${join(other, ".claude", "hooks", "agent-write-scope.ts").replace(/\\/g, "/")}"`;
    await expect(load(withCommand(cmd))).resolves.toBeNull();
  });

  test.each([
    ["a different folder under the project", 'bun "$CLAUDE_PROJECT_DIR/vendor/agent-write-scope.ts"'],
    ["a home-relative copy", 'bun "$HOME/.claude/hooks/agent-write-scope.ts"'],
    ["a bare relative path", "bun .claude/hooks/agent-write-scope.ts"],
    ["the file name only as a substring", 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/not-agent-write-scope.ts"'],
    ["the file name in an unrelated command", "echo agent-write-scope.ts"],
    ["a parent traversal out of the project", 'bun "$CLAUDE_PROJECT_DIR/../x/.claude/hooks/agent-write-scope.ts"'],
  ])("%s gives null", async (_label, command) => {
    await expect(load(withCommand(command))).resolves.toBeNull();
  });
});

describe("requiresIsolation() — an old scope gate beside the new parser keeps the scoped writer isolated", () => {
  test.each([
    ["no version export", VERSION_STUB(null), true],
    ["version 1", VERSION_STUB("1"), true],
    ["version 2", VERSION_STUB("2"), false],
  ])("%s", async (_label, gateSrc, isolated) => {
    const inst = makeInstall({ gate: gateSrc });
    const parser = await loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root);
    expect(parser === null).toBe(isolated);
    expect(requiresIsolation("scoped", scopedDir, parser)).toBe(isolated);
  });

  test("an unregistered scope gate keeps the scoped writer isolated", async () => {
    const inst = makeInstall({ gate: VERSION_STUB("2"), settings: settingsJson([{ matcher: "Write", command: SCOPE_CMD }]) });
    const parser = await loadWriteScopeParser(inst.parserPath, inst.gatePath, inst.settingsPath, inst.root);
    expect(parser).toBeNull();
    expect(requiresIsolation("scoped", scopedDir, parser)).toBe(true);
  });
});

// --- spawned process: the #310 entrypoint behaviour ----------------------------------------------

const GP = (cwd?: string) =>
  JSON.stringify({
    tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", prompt: "do a thing" },
    ...(cwd === undefined ? {} : { cwd }),
  });

describe("spawned process — project root and git probe (#310)", () => {
  test("project root a repo, payload cwd a non-git dir: deny JSON", () => {
    const repo = gitTmpRoot("wg-spawn-repo-");
    const plain = tmpRoot("wg-spawn-plain-");
    const result = runHook(GP(plain), { CLAUDE_PROJECT_DIR: repo });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test.skipIf(TMP_UNDER_GIT)("project root not a git repo: allow with systemMessage and additionalContext, no permissionDecision", () => {
    const plain = tmpRoot("wg-spawn-nongit-");
    const result = runHook(GP(), { CLAUDE_PROJECT_DIR: plain });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const note = nonGitNote(plain);
    expect(parsed.systemMessage).toBe(note);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(note);
    expect("permissionDecision" in parsed.hookSpecificOutput).toBe(false);
    expect(result.stderr).toBe("");
  });

  test.skipIf(TMP_UNDER_GIT)("GIT_DIR in the environment makes the same non-git root a repo: deny", () => {
    const plain = tmpRoot("wg-spawn-gitdir-");
    const result = runHook(GP(), { CLAUDE_PROJECT_DIR: plain, GIT_DIR: join(plain, "x") });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("spawned process — installed layout and the guarded dynamic import (#310)", () => {
  const scopedDispatch = (root: string) =>
    JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "scoped", prompt: "go" }, cwd: root });

  test("write-scope-parse.ts missing: exit 0 and a deny JSON, not silence", () => {
    const inst = makeInstall({ parser: false, gate: VERSION_STUB("2") });
    const result = runHook(scopedDispatch(inst.root), { CLAUDE_PROJECT_DIR: inst.root }, inst.gate);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("agent-write-scope.ts missing entirely: exit 0 and a deny JSON", () => {
    const inst = makeInstall({ gate: null });
    const result = runHook(scopedDispatch(inst.root), { CLAUDE_PROJECT_DIR: inst.root }, inst.gate);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("an old agent-write-scope.ts without the version export: exit 0 and a deny JSON", () => {
    const inst = makeInstall({ gate: VERSION_STUB(null) });
    const result = runHook(scopedDispatch(inst.root), { CLAUDE_PROJECT_DIR: inst.root }, inst.gate);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("all three modules at version 2 and the gate registered: exit 0, no stdout", () => {
    const inst = makeInstall({ gate: "real" });
    const result = runHook(scopedDispatch(inst.root), { CLAUDE_PROJECT_DIR: inst.root }, inst.gate);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("the same layout with the gate registered only under Write: deny JSON", () => {
    const inst = makeInstall({ gate: "real", settings: settingsJson([{ matcher: "Write", command: SCOPE_CMD }]) });
    const result = runHook(scopedDispatch(inst.root), { CLAUDE_PROJECT_DIR: inst.root }, inst.gate);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
