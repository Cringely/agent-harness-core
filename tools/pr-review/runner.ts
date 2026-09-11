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
// A second live capture, 2026-09-11 (claude 2.1.269, task-6-report.md Step 0), found what the two
// flags actually gate beyond token count: two runs from the same neutral cwd, one word on stdin,
// otherwise identical flags. With --safe-mode --setting-sources "" the init event had no plugins,
// no memory_paths key at all, and output_style "default". Without them, init carried the account's
// ten cached plugins (with filesystem paths under the operator's profile), a memory_paths entry
// naming a project-specific directory under the profile, and this session's own configured
// output_style. plugins and output_style are checked below; memory_paths is not, since its presence
// already implies a non-empty plugins or agents/settings load the other two checks catch, and its
// value is more tied to this process's own project resolution than to the child session's config.
//
// The flags are not the control. parseStreamJson() reads the session's stream and rejects the run
// unless the init event lists exactly ["StructuredOutput"] (the tool --json-schema adds), no MCP
// server connected, no plugin loaded, the default output style, the pinned model resolved, no
// model_refusal_fallback event appeared, every assistant turn named the pinned model (a captured run
// fell back to another model while init still named the pinned one), no assistant turn's content
// held a tool_use, server_tool_use or mcp_tool_use block other than a StructuredOutput call naming a
// string, and exactly one result event ended in success. A CLI release that changes what a flag
// means turns every review into a rejection, which posts COMMENT and leaves the merge blocked.
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
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, reason: "the reviewer stream contained a line that is not JSON" };
    }
    if (event.type === "system" && event.subtype === "init") {
      if (init !== null) return { ok: false, reason: "the reviewer stream contained more than one init event" };
      init = event;
    } else if (event.type === "system" && event.subtype === "model_refusal_fallback") {
      return { ok: false, reason: "the reviewer session emitted model_refusal_fallback, so another model may have answered" };
    } else if (event.type === "result") {
      if (result !== null) return { ok: false, reason: "the reviewer stream contained more than one result event" };
      result = event;
    } else if (event.type === "assistant") {
      const message = event.message as { model?: unknown; content?: unknown } | undefined;
      if (message?.model !== REVIEWER_MODEL) foreignModel = true;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: unknown; name?: unknown }>) {
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
  // A6.2: measured 2026-09-11 (task-6-report.md, Step 0). A session without --safe-mode
  // --setting-sources "" loaded the account's plugins and this session's configured output style;
  // a session with them had neither. Both are user configuration reaching the model the same way
  // the rules text D6 worries about would, and no other check here would have caught it.
  if (!Array.isArray(init.plugins) || init.plugins.length !== 0) {
    return { ok: false, reason: "the reviewer session loaded plugins, so --setting-sources may not have excluded the operator's configuration" };
  }
  if (init.output_style !== "default") {
    return { ok: false, reason: "the reviewer session used a configured output style, so --setting-sources may not have excluded the operator's configuration" };
  }
  if (init.model !== REVIEWER_MODEL) return { ok: false, reason: "the reviewer session resolved a model other than the pinned one" };
  if (foreignModel) return { ok: false, reason: "an assistant turn came from a model other than the pinned one, or named none" };
  if (foreignToolUse) return { ok: false, reason: "the reviewer session called a tool other than StructuredOutput" };
  if (exitCode !== 0) return { ok: false, reason: `claude exited with code ${exitCode}` };
  if (result === null) return { ok: false, reason: "the reviewer stream had no result event" };
  if (result.subtype !== "success" || result.is_error !== false) return { ok: false, reason: "the reviewer run did not end in success" };
  if (result.structured_output === undefined) return { ok: false, reason: "the reviewer run returned no structured output" };
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
      const proc = Bun.spawn([...this.command, ...claudeArgs(systemPromptFile)], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, this.timeoutMs);
      const stdoutText = new Response(proc.stdout).text();
      const stderrText = new Response(proc.stderr).text();
      try {
        proc.stdin.write(prompt.userPrompt);
        await proc.stdin.end();
      } catch {
        // A process that exits before reading its input is judged by its exit code and stream below.
      }
      const exitCode = await proc.exited;
      clearTimeout(timer);
      const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
      if (timedOut) return { ok: false, reason: "the reviewer run exceeded its time limit", diagnostic: stderr.slice(0, 2_000) };
      const parsed = parseStreamJson(stdout, exitCode);
      return parsed.ok ? parsed : { ...parsed, diagnostic: stderr.slice(0, 2_000) };
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  }
}
