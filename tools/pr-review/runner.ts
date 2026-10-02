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
// for that failure. Since #238 the plugins check is also the only signal for CLI built-in plugins,
// which load with memory_paths absent, so it must not be relaxed.
//
// That capture no longer holds on its own (#238). From claude 2.1.283 the CLI registers built-in
// plugins in every session, headless included, and --safe-mode, --setting-sources "", --bare and an
// empty CLAUDE_CONFIG_DIR all leave them loaded. A 2.1.285 run with the flags above carried
// cc-plugin-agents-md@builtin and cc-plugin-telemetry@builtin in init.plugins (on 2.1.283 and
// 2.1.284 the names were agents-md@builtin and telemetry@builtin), and 2.1.269 showed none. So
// claudeArgs() passes --settings with an inline enabledPlugins object setting every BUILTIN_PLUGINS
// name to false, which left init.plugins empty on 2.1.285. The set also changes server-side under an
// unchanged binary, and varies from one session to the next: cc-plugin-diff@builtin arrived on
// 2026-09-30 (#247), and a session on 2026-10-01 carried cc-plugin-plugin-authoring@builtin
// instead. enabledPlugins takes no wildcard ("*@builtin" and "@builtin" were both ignored), so no
// static list can keep up.
//
// So run() adapts (#250). It reads the session's stream as it arrives. The init event comes first,
// before the model does any work. When init.plugins is non-empty and EVERY entry is a CLI built-in
// (path exactly "builtin", source ending exactly "@builtin"), run() kills that session at once and
// relaunches with those sources added to the disable set, which starts from BUILTIN_PLUGINS, up to
// MAX_ATTEMPTS launches in all. Any other non-empty plugin list is killed at init and rejected
// with no relaunch. The killed session's stream is discarded, and the accepted session still has to
// pass parseStreamJson()'s plugins check unchanged. That check is deliberately not narrowed to admit
// @builtin sources: agents-md injects AGENTS.md instructions, and a built-in is only tolerated by
// being switched off, never by passing because of where it came from.
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

export const REVIEWER_MODEL = "claude-opus-5-5";
export const REVIEWER_EFFORT = "xhigh";
export const EXPECTED_TOOLS: readonly string[] = ["StructuredOutput"];
// A premium-model review of a large diff at high effort can take several minutes; twenty is a ceiling
// on a hung process, not an estimate.
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
// #250: launches per run, counting the first. A killed launch never reaches the model, so the cost of
// a relaunch is one CLI start. Three covers one round of newly seen built-ins with a launch to spare.
// A session still loading built-ins after that is refused rather than chased.
export const MAX_ATTEMPTS = 3;

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

// Built-in plugins switched off through --settings on every launch (#238, #247), the seed of the
// disable set run() grows (#250). The names #238 found, then their 2.1.283-2.1.284 forms, then names
// seen server-side since. A name the CLI does not know is ignored. Adding a name seen in a live run
// saves a relaunch whenever that built-in turns up again.
export const BUILTIN_PLUGINS: readonly string[] = [
  "cc-plugin-agents-md@builtin",
  "cc-plugin-telemetry@builtin",
  "agents-md@builtin",
  "telemetry@builtin",
  // Arrived on 2026-09-30 under an unchanged 2.1.285 binary, so the built-in set can change server-side (#247).
  "cc-plugin-diff@builtin",
  // Seen on 2.1.287 on 2026-10-01, in a session that did not carry cc-plugin-diff (#250).
  "cc-plugin-plugin-authoring@builtin",
];

// #250: an init.plugins entry counts as a CLI built-in only when both fields say so exactly. Anything
// else, including an entry that is not an object, is treated as a plugin from somewhere else.
function isBuiltinPlugin(entry: unknown): entry is { source: string } {
  if (typeof entry !== "object" || entry === null) return false;
  const { path, source } = entry as Record<string, unknown>;
  return path === "builtin" && typeof source === "string" && source.endsWith("@builtin");
}

// learnedBuiltins: sources earlier launches of this run reported in init.plugins (#250).
export function claudeArgs(systemPromptFile: string, learnedBuiltins: readonly string[] = []): string[] {
  const disabled = new Set([...BUILTIN_PLUGINS, ...learnedBuiltins]);
  const enabledPlugins = Object.fromEntries([...disabled].map((name) => [name, false]));
  return [
    "-p",
    "--model", REVIEWER_MODEL,
    "--effort", REVIEWER_EFFORT,
    "--tools", "",
    "--strict-mcp-config",
    "--safe-mode",
    "--setting-sources", "",
    "--settings", JSON.stringify({ enabledPlugins }),
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
  // A second signal for the memory_paths failure above, and since #238 the ONLY signal for CLI
  // built-in plugins, which load with memory_paths absent. Keep it strict: an unknown plugin fails closed.
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

type AttemptOutcome = { kind: "finished"; result: RunnerResult } | { kind: "relaunch"; sources: string[] };

// #250: one launch. stdout is read as it arrives and scanned line by line only until the init event.
// - init.plugins empty: read on to the end and judge the whole stream with parseStreamJson().
// - init is the first event and every plugin is a built-in: kill now, before the model runs, and
//   hand the sources back for a relaunch. This launch's stream is discarded.
// - anything else non-empty, or a plugins field that is not an array: kill now and reject. The
//   reason comes from parseStreamJson() over the stream so far, which always rejects here because
//   init.plugins is not empty, so the existing rejection reasons are the ones reported.
// An init event preceded by any other event is never relaunched, so a hook event, which
// parseStreamJson() rejects, cannot be dropped by discarding the launch that showed it.
async function runAttempt(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, userPrompt: string): Promise<AttemptOutcome> {
  const stderrText = new Response(proc.stderr).text().catch(() => "");
  const fed = (async () => {
    try {
      proc.stdin.write(userPrompt);
      await proc.stdin.end();
    } catch {
      // A process that exits before reading its input is judged by its exit code and stream below.
    }
  })();
  const reader = proc.stdout.getReader();
  const kill = async (): Promise<void> => {
    killProcessTree(proc.pid);
    reader.cancel().catch(() => {});
    try {
      await proc.exited;
    } catch {
      // Already gone.
    }
  };

  const decoder = new TextDecoder();
  let stdout = "";
  let scanned = 0;
  let sawEvent = false;
  let scanning = true;
  for (;;) {
    const { done, value } = await reader.read();
    stdout += done ? decoder.decode() : decoder.decode(value, { stream: true });
    while (scanning) {
      const newline = stdout.indexOf("\n", scanned);
      if (newline === -1) break;
      const line = stdout.slice(scanned, newline);
      scanned = newline + 1;
      if (line.trim() === "") continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        event = null;
      }
      const isInit = typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "system" && (event as Record<string, unknown>).subtype === "init";
      if (!isInit) {
        sawEvent = true;
        continue;
      }
      scanning = false;
      const plugins = (event as Record<string, unknown>).plugins;
      if (Array.isArray(plugins) && plugins.length === 0) break;
      await kill();
      if (!sawEvent && Array.isArray(plugins) && plugins.every(isBuiltinPlugin)) {
        return { kind: "relaunch", sources: plugins.map((p) => p.source) };
      }
      const rejected = parseStreamJson(stdout.slice(0, scanned), null);
      return { kind: "finished", result: rejected.ok ? { ok: false, reason: "the reviewer session loaded plugins" } : rejected };
    }
    if (done) break;
  }

  let exitCode: number | null;
  try {
    exitCode = await proc.exited;
  } catch (err) {
    return { kind: "finished", result: { ok: false, reason: "the reviewer process ended unexpectedly", diagnostic: err instanceof Error ? err.message : String(err) } };
  }
  await fed;
  const stderr = await stderrText;
  const parsed = parseStreamJson(stdout, exitCode);
  return { kind: "finished", result: parsed.ok ? parsed : { ...parsed, diagnostic: stderr.slice(0, 2_000) } };
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

      // #250: each launch whose init event lists only built-ins is killed there, and the next one
      // disables those too. `current` is the launch the deadline below kills, and `expired` stops a
      // relaunch from starting after the deadline has already fired.
      let current: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
      let expired = false;
      const learned: string[] = [];
      const runToCompletion = (async (): Promise<RunnerResult> => {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !expired; attempt++) {
          // I3 (Q1): Bun.spawn throws synchronously when the command does not resolve (for example
          // the claude binary removed between the Bun.which() lookup in the constructor and this
          // call). That is caught here instead of escaping run() as a rejected promise. The thrown
          // message can carry a path, so it stays in diagnostic, never reason (types.ts: reason may
          // be rendered publicly).
          let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
          try {
            proc = Bun.spawn([...this.command, ...claudeArgs(systemPromptFile, learned)], {
              cwd,
              // I5: without this, the child gets Bun's own startup environment, not this process's
              // live process.env. identity.ts reads process.env at run time; passing it explicitly
              // here is what keeps the reviewer process and the identity scan reading the same source.
              env: process.env,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              // I4: on POSIX this makes the child the leader of its own new process group (setsid),
              // so a group-kill on timeout below reaches any descendant it spawns, whether or not
              // the child itself has already exited by then. See killProcessTree.
              detached: process.platform !== "win32",
            });
          } catch (err) {
            return { ok: false, reason: "the reviewer process could not be started", diagnostic: err instanceof Error ? err.message : String(err) };
          }
          current = proc;
          const outcome = await runAttempt(proc, prompt.userPrompt);
          if (outcome.kind === "finished") return outcome.result;
          for (const source of outcome.sources) if (!learned.includes(source)) learned.push(source);
        }
        // Built-in plugin names carry no account data, so they can go in the diagnostic, which the
        // operator reads to extend BUILTIN_PLUGINS.
        return {
          ok: false,
          reason: `the reviewer session still loaded built-in plugins after ${MAX_ATTEMPTS} attempts`,
          diagnostic: `built-in plugins disabled beyond BUILTIN_PLUGINS: ${learned.join(", ")}`,
        };
      })();

      // I4: the previous version cleared this deadline as soon as proc.exited resolved, so a
      // process that exited quickly but left a descendant holding stdout or stderr open (a hook, an
      // MCP helper) made this call wait for that descendant with no bound at all (Q2, Q3, Q3b). The
      // deadline below instead covers the whole run, through both pipes fully read, by racing the
      // drain itself rather than only the child's own exit. Since #250 it covers every launch.
      let timer!: ReturnType<typeof setTimeout>;
      const timedOut = new Promise<RunnerResult>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          if (current) killProcessTree(current.pid);
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
