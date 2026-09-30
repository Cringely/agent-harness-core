// Every harness hook stands down outside Claude Code (issue #227).
//
// Copilot CLI reads Claude-format hooks out of .claude/settings.json and treats a non-zero
// preToolUse exit as a deny, so a gate written for Claude Code's fail-open contract blocks
// every Copilot dispatch. The rule each hook carries inline, stated once here:
//
//   stand down iff COPILOT_CLI is non-empty AND CLAUDECODE is empty or unset.
//
// Standing down means exit 0, nothing on stdout or stderr, and no side effect. The CLAUDECODE
// clause is what keeps a Claude Code session from ever skipping a gate: when both are set the
// hook acts. When neither is set it also acts, which is the fail-closed direction on a detection
// miss and keeps CI and every other spawned test on the act path unchanged.
//
// There is no shared module holding the rule. Install-Account.ps1 copies model-tier-gate.ts on its
// own, so a sibling import would break the user-scope gate. Each script repeats the check, and
// this table is what holds them to one definition.
//
// Two kinds of row. "Copilot only" deletes CLAUDECODE from the child env explicitly, because a
// developer running bun test from inside Claude Code inherits CLAUDECODE=1 and a row that only
// added COPILOT_CLI would take the act path. Those rows fail on the unfixed hooks. "Both set" rows
// are pins: they pass before and after the fix, and fail only if the CLAUDECODE clause is dropped
// from a guard.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { posixSh, posixShDir } from "./posix-sh";

const HOOKS = join(import.meta.dir, "..", "core", "claude", "hooks");
const TEMPLATE = join(import.meta.dir, "..", "core", "claude", "templates", "settings.hooks.json");

type Env = Record<string, string | undefined>;
type Mode = "copilot" | "both";
type Result = { exitCode: number; stdout: string; stderr: string; effect: boolean };

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A child env isolated from the runner's home and harness vars, with the stand-down vars set for
 * the mode under test. */
function childEnv(mode: Mode, overrides: Env): Env {
  const home = tempDir("standdown-home-");
  const basePath = process.env.PATH ?? "";
  const shDir = (posixSh(), posixShDir());
  const env: Env = {
    ...process.env,
    PATH: shDir ? `${shDir}${delimiter}${basePath}` : basePath,
    HOME: home,
    USERPROFILE: home,
    GH_PROMPT_DISABLED: "1",
    ...overrides,
    COPILOT_CLI: "1",
  };
  delete env.PROSE_LINT_VALE_CONFIG;
  if (overrides.PROSE_LINT_VALE_CONFIG) env.PROSE_LINT_VALE_CONFIG = overrides.PROSE_LINT_VALE_CONFIG;
  if (mode === "copilot") delete env.CLAUDECODE;
  else env.CLAUDECODE = "1";
  return env;
}

function spawn(cmd: string[], cwd: string, env: Env, stdin: string) {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    env: env as Record<string, string>,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const bunHook = (name: string) => [process.execPath, join(HOOKS, name)];
const shHook = (name: string) => [posixSh(), join(HOOKS, name)];

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function gitRepo(prefix: string): string {
  const dir = tempDir(prefix);
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], dir);
  git(["commit", "-q", "-m", "seed"], dir);
  return dir;
}

/** A dispatch both PreToolUse gates refuse today: no subagent_type (so general-purpose), no
 * isolation, and a model string that is not a tier. */
const dispatchPayload = JSON.stringify({
  tool_name: "Task",
  tool_input: { agent_type: "general-purpose", model: "claude-sonnet-5", description: "d", prompt: "do a thing" },
});

interface Row {
  hook: string;
  run(mode: Mode): Result;
  /** What the hook does when it acts, as it does on master. */
  acted(r: Result): void;
}

const rows: Row[] = [
  {
    hook: "agent-worktree-gate.ts",
    run(mode) {
      const dir = tempDir("standdown-wt-");
      const r = spawn(bunHook(this.hook), dir, childEnv(mode, { CLAUDE_PROJECT_DIR: dir }), dispatchPayload);
      return { ...r, effect: false };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    },
  },
  {
    hook: "model-tier-gate.ts",
    run(mode) {
      const dir = tempDir("standdown-mt-");
      const r = spawn(bunHook(this.hook), dir, childEnv(mode, { CLAUDE_PROJECT_DIR: dir }), dispatchPayload);
      return { ...r, effect: false };
    },
    acted(r) {
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("claude-sonnet-5");
    },
  },
  {
    hook: "agent-write-scope.ts",
    run(mode) {
      const dir = tempDir("standdown-ws-");
      mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "agents", "scratch-agent.md"),
        ["---", "name: scratch-agent", "writeScope: scratch", "---", "", "Body."].join("\n"),
      );
      const payload = JSON.stringify({
        agent_type: "scratch-agent",
        cwd: dir,
        tool_input: { file_path: join(dir, "src", "index.ts") },
      });
      const r = spawn(bunHook(this.hook), dir, childEnv(mode, { CLAUDE_PROJECT_DIR: dir }), payload);
      return { ...r, effect: false };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    },
  },
  {
    hook: "lint-doc-prose.ts",
    run(mode) {
      // A relative README.md is in scope whatever the temp root looks like. The explicit config
      // points nowhere and the child home is empty, so the act path is the no-config advisory
      // line whether or not vale is installed.
      const dir = tempDir("standdown-lint-");
      const env = childEnv(mode, { CLAUDE_PROJECT_DIR: dir, PROSE_LINT_VALE_CONFIG: join(dir, "missing.ini") });
      const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "README.md" } });
      const r = spawn(bunHook(this.hook), dir, env, payload);
      return { ...r, effect: false };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("lint-doc-prose:");
    },
  },
  {
    hook: "review-gate.ts",
    run(mode) {
      const dir = gitRepo("standdown-rg-");
      writeFileSync(join(dir, "changed.txt"), "v2\n");
      git(["add", "changed.txt"], dir);
      const transcript = join(tempDir("standdown-rg-transcript-"), "t.jsonl");
      const edit = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Write", input: { file_path: join(dir, "changed.txt") } }],
        },
      };
      writeFileSync(transcript, JSON.stringify(edit) + "\n");
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git commit -m test" },
        cwd: dir,
        transcript_path: transcript,
      });
      const r = spawn(bunHook(this.hook), dir, childEnv(mode, { CLAUDE_PROJECT_DIR: dir }), payload);
      return { ...r, effect: false };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    },
  },
  {
    hook: "memory-transition-log.ts",
    run(mode) {
      const dir = tempDir("standdown-mem-");
      mkdirSync(join(dir, "memory"), { recursive: true });
      const env = childEnv(mode, { CLAUDE_PROJECT_DIR: dir });
      const payload = JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "memory/note.md", old_string: "  status: proposed", new_string: "  status: accepted" },
        cwd: dir,
        session_id: "standdown",
      });
      const r = spawn(bunHook(this.hook), dir, env, payload);
      const state = join(env.HOME!, ".claude", "state", "memory-transitions.jsonl");
      return { ...r, effect: existsSync(state) };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(r.effect).toBe(true);
    },
  },
  {
    hook: "session-start-guardrails.sh",
    run(mode) {
      const dir = tempDir("standdown-gr-");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "guardrails.md"), "RULE ONE\nguardrails:session-start-end\nAFTER\n");
      const r = spawn(shHook(this.hook), dir, childEnv(mode, { CLAUDE_PROJECT_DIR: dir }), "");
      return { ...r, effect: false };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("=== Guardrails");
      expect(r.stdout).toContain("RULE ONE");
    },
  },
  {
    hook: "session-start-drift-check.sh",
    run(mode) {
      // A committed manifest with no sidecar is the one state where this hook speaks without
      // needing a core checkout or pwsh.
      const dir = tempDir("standdown-dc-");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", ".harness-manifest.json"), "{}\n");
      const r = spawn(shHook(this.hook), dir, childEnv(mode, { CLAUDE_PROJECT_DIR: dir }), "");
      return { ...r, effect: false };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("sidecar unavailable");
    },
  },
  {
    hook: "wave-close-handoff.sh",
    run(mode) {
      const dir = gitRepo("standdown-wave-");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --squash" } });
      const r = spawn(shHook(this.hook), dir, childEnv(mode, { CLAUDE_PROJECT_DIR: dir }), payload);
      return { ...r, effect: existsSync(join(dir, ".claude", "wave-state.md")) };
    },
    acted(r) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("WAVE HANDOFF");
      expect(r.effect).toBe(true);
    },
  },
];

// The wave-close act path makes three gh calls, measured at about 5 s on a Windows host, which is
// bun's default per-test timeout.
const ROW_TIMEOUT_MS = 30_000;

describe("Copilot only (COPILOT_CLI set, CLAUDECODE absent): every hook stands down", () => {
  test.each(rows.map((r) => [r.hook, r] as const))(
    "%s: exit 0, silent, no side effect",
    (_name, row) => {
      const r = row.run("copilot");
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.effect).toBe(false);
    },
    ROW_TIMEOUT_MS,
  );
});

describe("pin: COPILOT_CLI and CLAUDECODE both set, every hook acts as it does without Copilot", () => {
  test.each(rows.map((r) => [r.hook, r] as const))(
    "%s: acts",
    (_name, row) => {
      row.acted(row.run("both"));
    },
    ROW_TIMEOUT_MS,
  );
});

// --- SessionStart command strings ---------------------------------------------------------------
//
// The template's SessionStart strings moved to an sh -c form so a PowerShell host does not expand
// $CLAUDE_PROJECT_DIR as one of its own (empty) variables. Under a POSIX shell, which is what Claude
// Code uses, the new form must behave exactly like the old one. These two strings are the ones the
// installer migrates in place.

const LEGACY_SESSION_START: Record<string, string> = {
  "session-start-guardrails.sh": 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-guardrails.sh"',
  "session-start-drift-check.sh": 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-drift-check.sh"',
};

function templateSessionStartCommand(script: string): string {
  const tpl = JSON.parse(readFileSync(TEMPLATE, "utf8"));
  const commands: string[] = tpl.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) =>
    g.hooks.map((h) => h.command),
  );
  const hit = commands.filter((c) => c.includes(`/.claude/hooks/${script}`));
  expect(hit.length).toBe(1);
  return hit[0];
}

/** bash beside the resolved sh, so a Windows host gets Git's bash rather than the WSL launcher
 * that System32 puts on PATH. Throws rather than skipping when there is none. */
function posixBash(): string {
  const sh = posixSh();
  for (const name of ["bash", "bash.exe"]) {
    const candidate = join(dirname(sh), name);
    if (existsSync(candidate)) return candidate;
  }
  const onPath = Bun.which("bash");
  if (onPath) return onPath;
  throw new Error(`no bash beside ${sh} and none on PATH`);
}

describe("pin: new SessionStart strings match the legacy ones under bash with CLAUDECODE=1", () => {
  test.each(Object.keys(LEGACY_SESSION_START))("%s: identical stdout and exit code", (script) => {
    // The space is the point: a form that drops the inner double quotes splits this path.
    const dir = tempDir("standdown cmd-");
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    copyFileSync(join(HOOKS, script), join(dir, ".claude", "hooks", script));
    writeFileSync(join(dir, ".claude", "guardrails.md"), "RULE ONE\nguardrails:session-start-end\n");
    writeFileSync(join(dir, ".claude", ".harness-manifest.json"), "{}\n");

    const shDir = (posixSh(), posixShDir());
    const basePath = process.env.PATH ?? "";
    const env: Env = {
      ...process.env,
      PATH: shDir ? `${shDir}${delimiter}${basePath}` : basePath,
      CLAUDE_PROJECT_DIR: dir,
      CLAUDECODE: "1",
    };
    delete env.COPILOT_CLI;

    const bash = posixBash();
    const legacy = spawn([bash, "-c", LEGACY_SESSION_START[script]], dir, env, "");
    const current = spawn([bash, "-c", templateSessionStartCommand(script)], dir, env, "");

    // Not vacuous: the legacy string reaches the script and prints something.
    expect(legacy.exitCode).toBe(0);
    expect(legacy.stdout.length).toBeGreaterThan(0);
    expect(current.stdout).toBe(legacy.stdout);
    expect(current.exitCode).toBe(legacy.exitCode);
  });
});
