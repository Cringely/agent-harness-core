// Runs the reviewing model as `claude -p` with no tools. The flags in claudeArgs() are measured, not
// assumed: on claude 2.1.268 (2026-09-10) the same tiny prompt cost 1,382 input tokens with
// --safe-mode and --setting-sources "", and 25,663 without them, and without them the model could
// see the operator's user rules, whose *.local.md files carry identifying strings.
//
// The model still sees two things that are not the prompt (captured 2026-09-11). The CLI adds
// environment notes: the working directory, the platform, the shell and the date. Run from a temp
// directory under the user profile, that working directory carried the account's username; run from
// the drive root it named no one. So the session runs from neutralWorkingDirectory(), and the system
// prompt file lives in a separate temp directory the notes never mention. The CLI also adds a
// "# userEmail" block with the logged-in account's email, from the drive root too, and no flag here
// removes it. The identity scan therefore reads that exact address from the CLI's account state
// (identity.ts), and a posting run with no email to scan for refuses (pipeline.ts).
//
// A second live capture, 2026-09-11 (claude 2.1.269, task-6-report.md Step 0), compared two runs from
// the same neutral cwd, one word on stdin, otherwise identical flags. With --safe-mode
// --setting-sources "" the init event had no memory_paths key, no plugins and output_style
// "default". Without them, init carried a memory_paths entry naming a project-specific directory
// under the profile, the account's ten cached plugins, and this session's own configured
// output_style. memory_paths is the primary check below: no clean account configuration can make
// that key appear at all, where plugins and output_style are also clean on an account that has no
// plugins and uses the default style. plugins and output_style stay checked too, as a second signal
// for the same failure, not because either closes a gap the memory_paths check leaves open.
//
// The flags are not the control. parseStreamJson() reads the session's stream and rejects the run
// unless: the init event lists exactly ["StructuredOutput"] (the tool --json-schema adds), no MCP
// server connected, no memory_paths key, no plugin loaded, the default output style, a cwd matching
// neutralWorkingDirectory(), and the pinned model resolved; no system event's subtype starts with
// "hook", since a hook firing means operator-configured automation ran against a session fed
// attacker-controlled pull request text; no model_refusal_fallback event appeared; at least one
// assistant turn exists and every assistant turn named the pinned model (a captured run fell back to
// another model while init still named the pinned one); no assistant turn's content held a tool_use,
// server_tool_use or mcp_tool_use block other than a StructuredOutput call naming a string; and
// exactly one result event ended in success. A CLI release that changes what a flag means turns every
// review into a rejection, which posts COMMENT and leaves the merge blocked.
//
// The model id is pinned in full rather than as the "opus" alias so the reviewer cannot change under
// the tool, the same reason CI pins its runner image.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { FINDINGS_JSON_SCHEMA } from "./findings";
import type { PromptPair, ReviewerRunner, RunnerResult } from "./types";

export const REVIEWER_MODEL = "claude-opus-5";
export const REVIEWER_EFFORT = "xhigh";
export const EXPECTED_TOOLS: readonly string[] = ["StructuredOutput"];
// A premium-model review of a large diff at high effort can take several minutes; twenty is a ceiling
// on a hung process, not an estimate.
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;

// The root of the filesystem holding the temp directory: the drive root on Windows, "/" elsewhere.
// A6.3: os.tmpdir() returns TMPDIR/TMP/TEMP verbatim, unresolved. A relative value (e.g. a test, or
// a misconfigured environment, setting one of those to a bare word) gives parse(...).root === "",
// and Bun.spawn({ cwd: "" }) then silently runs the reviewer in this process's own cwd, undoing the
// control this function exists to provide. Throwing here, rather than returning "", makes that
// state loud instead of a silent fallback; run() turns the throw into a rejection.
export function neutralWorkingDirectory(): string {
  const dir = tmpdir();
  const root = parse(dir).root;
  if (!isAbsolute(dir) || root === "") {
    throw new Error("the OS temp directory is not absolute, so no neutral working directory root exists");
  }
  return root;
}

// I1: init.cwd can arrive with either slash style, and win32 paths compare case-insensitively.
function sameCwd(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, "/");
  const left = normalize(a);
  const right = normalize(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// I4: best-effort process-tree cleanup on a timed-out run. On POSIX, run() spawns the child
// detached, so it leads its own process group; a negative pid signals the whole group, and the
// group id stays valid as long as any member is alive, even after the leader itself has already
// exited, which is exactly what a descendant holding a pipe open produces. On win32, taskkill's /T
// walks the process tree by the target's recorded parent link, but only for a PID still alive: a
// process that has already exited by the time the deadline fires leaves any descendant it spawned
// unreachable by this call. Either way, the deadline race in run() is what actually bounds the
// wait; this call only decides whether the descendant is still running afterward.
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    } catch {
      // taskkill missing or unreachable; nothing more to try.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH: the group already has no living members.
    }
  }
}

export function claudeArgs(systemPromptFile: string): string[] {
  return [
    "-p",
    "--model", REVIEWER_MODEL,
    "--effort", REVIEWER_EFFORT,
    "--tools", "",
    "--strict-mcp-config",
    "--safe-mode",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt-file", systemPromptFile,
    "--json-schema", JSON.stringify(FINDINGS_JSON_SCHEMA),
    "--output-format", "stream-json",
    "--verbose",
  ];
}

export function parseStreamJson(stdout: string, exitCode: number | null): RunnerResult {
  let init: Record<string, unknown> | null = null;
  let result: Record<string, unknown> | null = null;
  let foreignToolUse = false;
  let foreignModel = false;
  let sawAssistant = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: "the reviewer stream contained a line that is not JSON" };
    }
    // I3 (P7): JSON.parse accepts "null" and any primitive without throwing. Reading .type off one
    // of those would throw further down, escaping parseStreamJson as an exception rather than a
    // rejection, so it is rejected here instead.
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "the reviewer stream contained a line that is not a JSON object" };
    }
    const event = parsed as Record<string, unknown>;
    if (event.type === "system" && event.subtype === "init") {
      if (init !== null) return { ok: false, reason: "the reviewer stream contained more than one init event" };
      init = event;
    } else if (event.type === "system" && event.subtype === "model_refusal_fallback") {
      return { ok: false, reason: "the reviewer session emitted model_refusal_fallback, so another model may have answered" };
    } else if (event.type === "system" && typeof event.subtype === "string" && event.subtype.startsWith("hook")) {
      // C2: a hook event anywhere in the stream, before init or after the result, means
      // operator-configured automation ran during a session fed attacker-controlled pull request
      // text. --setting-sources "" is meant to prevent this; the stream is the only place that
      // claim can be checked. An allowlist of every other system event type and subtype is a
      // question for a later review, not this fix.
      return { ok: false, reason: "the reviewer stream contained a hook event, so operator-configured automation may have run" };
    } else if (event.type === "result") {
      if (result !== null) return { ok: false, reason: "the reviewer stream contained more than one result event" };
      result = event;
    } else if (event.type === "assistant") {
      sawAssistant = true;
      const message = event.message as { model?: unknown; content?: unknown } | undefined;
      if (message?.model !== REVIEWER_MODEL) foreignModel = true;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const raw of content) {
          // I3 (P8): a content block that is not an object cannot be shown to be the expected
          // StructuredOutput call, so it is treated the same as a foreign tool call instead of being
          // read into with `.type`/`.name`, which would throw on a primitive or null.
          if (typeof raw !== "object" || raw === null) {
            foreignToolUse = true;
            continue;
          }
          const block = raw as Record<string, unknown>;
          // A6.1: any block type ENDING in "tool_use" is a call, not only the literal "tool_use"
          // spelling. The API also emits server_tool_use (a server-side tool) and mcp_tool_use (an
          // MCP-connector tool); both are calls this session must not be able to make, and neither
          // was checked before. Only the exact type "tool_use" with a string name equal to
          // "StructuredOutput" is the expected call; everything else that looks like a call rejects.
          const blockType = block.type;
          if (typeof blockType === "string" && blockType.endsWith("tool_use")) {
            const isStructuredOutputCall = blockType === "tool_use" && typeof block.name === "string" && block.name === "StructuredOutput";
            if (!isStructuredOutputCall) foreignToolUse = true;
          }
        }
      }
    }
  }

  if (init === null) return { ok: false, reason: "the reviewer stream had no init event, so its tool set is unknown" };
  const tools = init.tools;
  if (!Array.isArray(tools) || tools.length !== EXPECTED_TOOLS.length || !tools.every((tool, i) => tool === EXPECTED_TOOLS[i])) {
    return { ok: false, reason: "the reviewer session exposed tools other than StructuredOutput" };
  }
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length !== 0) {
    return { ok: false, reason: "the reviewer session connected MCP servers" };
  }
  // C1: measured 2026-09-11 (task-6-report.md, Step 0). memory_paths is the sharpest of the three
  // fields the capture found: it was absent with --safe-mode --setting-sources "" and present,
  // naming a project-specific directory under the operator's profile, without them. Unlike plugins
  // or output_style, no clean account configuration can make this key appear at all, so its presence
  // alone means the exclusion did not hold, on any account, including one with no plugins and the
  // default style.
  if ("memory_paths" in init) {
    return { ok: false, reason: "the reviewer session's init event carried memory_paths, so --setting-sources may not have excluded the operator's configuration" };
  }
  // Secondary signal for the same failure as the memory_paths check above, not coverage for a gap
  // it leaves open: an account with no plugins or a default style is clean on both of these while
  // still failing the memory_paths check if the exclusion did not hold.
  if (!Array.isArray(init.plugins) || init.plugins.length !== 0) {
    return { ok: false, reason: "the reviewer session loaded plugins, so --setting-sources may not have excluded the operator's configuration" };
  }
  if (init.output_style !== "default") {
    return { ok: false, reason: "the reviewer session used a configured output style, so --setting-sources may not have excluded the operator's configuration" };
  }
  // I1: plan-audit-t4-t11.md's cwd clause. init.cwd is the CLI's own report of where it ran; this
  // checks that report against the spawn option that put it there (D6's first control), rather than
  // trusting the spawn option alone.
  if (typeof init.cwd !== "string" || !sameCwd(init.cwd, neutralWorkingDirectory())) {
    return { ok: false, reason: "the reviewer session's working directory was not the neutral root" };
  }
  if (init.model !== REVIEWER_MODEL) return { ok: false, reason: "the reviewer session resolved a model other than the pinned one" };
  if (foreignModel) return { ok: false, reason: "an assistant turn came from a model other than the pinned one, or named none" };
  if (foreignToolUse) return { ok: false, reason: "the reviewer session called a tool other than StructuredOutput" };
  if (exitCode !== 0) return { ok: false, reason: `claude exited with code ${exitCode}` };
  if (result === null) return { ok: false, reason: "the reviewer stream had no result event" };
  if (result.subtype !== "success" || result.is_error !== false) return { ok: false, reason: "the reviewer run did not end in success" };
  if (result.structured_output === undefined) return { ok: false, reason: "the reviewer run returned no structured output" };
  // I2: a stream with no assistant turn at all vacuously passes every per-turn model check above.
  // D6 requires every assistant turn to name the pinned model, which is void of content unless at
  // least one exists.
  if (!sawAssistant) return { ok: false, reason: "the reviewer stream had no assistant turn to attribute the output to" };
  return { ok: true, output: result.structured_output, model: REVIEWER_MODEL, tools: [...EXPECTED_TOOLS] };
}

export class ClaudeCliRunner implements ReviewerRunner {
  private readonly command: string[];
  private readonly timeoutMs: number;

  // `command` is a test seam. cli.ts never passes it, and nothing on the command line or in the
  // environment reaches it, so it cannot swap the reviewer for another program in production.
  constructor(options: { command?: string[]; timeoutMs?: number } = {}) {
    const claude = Bun.which("claude");
    this.command = options.command ?? (claude ? [claude] : []);
    this.timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  }

  async run(prompt: PromptPair): Promise<RunnerResult> {
    if (this.command.length === 0) return { ok: false, reason: "the claude CLI was not found on PATH" };
    // A6.3: resolved before any temp resource is created, so a bad temp-dir environment rejects
    // cleanly instead of throwing out of an async function (an unhandled rejection) or creating a
    // prompt directory under a path this process does not control.
    let cwd: string;
    try {
      cwd = neutralWorkingDirectory();
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "no neutral working directory could be determined" };
    }
    const promptDir = mkdtempSync(join(tmpdir(), "pr-review-run-"));
    try {
      const systemPromptFile = join(promptDir, "system-prompt.md");
      writeFileSync(systemPromptFile, prompt.systemPrompt);

      // I3 (Q1): Bun.spawn throws synchronously when the command does not resolve (for example the
      // claude binary removed between the Bun.which() lookup in the constructor and this call).
      // That is caught here instead of escaping run() as a rejected promise. The thrown message can
      // carry a path, so it stays in diagnostic, never reason (types.ts: reason may be rendered
      // publicly).
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...this.command, ...claudeArgs(systemPromptFile)], {
          cwd,
          // I5: without this, the child gets Bun's own startup environment, not this process's live
          // process.env. identity.ts reads process.env at run time; passing it explicitly here is
          // what keeps the reviewer process and the identity scan reading the same source.
          env: process.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          // I4: on POSIX this makes the child the leader of its own new process group (setsid), so
          // a group-kill on timeout below reaches any descendant it spawns, whether or not the
          // child itself has already exited by then. See killProcessTree.
          detached: process.platform !== "win32",
        });
      } catch (err) {
        return { ok: false, reason: "the reviewer process could not be started", diagnostic: err instanceof Error ? err.message : String(err) };
      }

      const runToCompletion = (async (): Promise<RunnerResult> => {
        const stdoutText = new Response(proc.stdout).text();
        const stderrText = new Response(proc.stderr).text();
        try {
          proc.stdin.write(prompt.userPrompt);
          await proc.stdin.end();
        } catch {
          // A process that exits before reading its input is judged by its exit code and stream below.
        }
        let exitCode: number | null;
        try {
          exitCode = await proc.exited;
        } catch (err) {
          return { ok: false, reason: "the reviewer process ended unexpectedly", diagnostic: err instanceof Error ? err.message : String(err) };
        }
        const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
        const parsed = parseStreamJson(stdout, exitCode);
        return parsed.ok ? parsed : { ...parsed, diagnostic: stderr.slice(0, 2_000) };
      })();

      // I4: the previous version cleared this deadline as soon as proc.exited resolved, so a
      // process that exited quickly but left a descendant holding stdout or stderr open (a hook, an
      // MCP helper) made this call wait for that descendant with no bound at all (Q2, Q3, Q3b). The
      // deadline below instead covers the whole run, through both pipes fully read, by racing the
      // drain itself rather than only the child's own exit.
      let timer!: ReturnType<typeof setTimeout>;
      const timedOut = new Promise<RunnerResult>((resolve) => {
        timer = setTimeout(() => {
          killProcessTree(proc.pid);
          resolve({ ok: false, reason: "the reviewer run exceeded its time limit" });
        }, this.timeoutMs);
      });
      const outcome = await Promise.race([runToCompletion, timedOut]);
      clearTimeout(timer);
      return outcome;
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  }
}
