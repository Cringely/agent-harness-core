// Tests for tools/pr-review/runner.ts. The runner's control is not its flags but its check of the
// session's own stream: a run whose init event lists any tool other than StructuredOutput, connects
// an MCP server, loaded a plugin, used a configured output style, or resolves a different model is
// rejected, and so is a run that shows another model answering, calls another tool, emits a second
// result, or does not end in success. The stream shapes below match captures from claude 2.1.268 on
// 2026-09-10 and 2026-09-11, and the plugins/output_style checks from a same-day capture on 2.1.269
// comparing a run with --safe-mode --setting-sources "" against one without (task-6-report.md, Step
// 0). ClaudeCliRunner is exercised against a fake `claude` written at runtime and run by bun itself.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { FINDINGS_JSON_SCHEMA } from "../tools/pr-review/findings";
import {
  ClaudeCliRunner,
  EXPECTED_TOOLS,
  REVIEWER_MODEL,
  claudeArgs,
  neutralWorkingDirectory,
  parseStreamJson,
} from "../tools/pr-review/runner";

const init = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    tools: ["StructuredOutput"],
    mcp_servers: [],
    plugins: [],
    output_style: "default",
    model: "claude-opus-5",
    ...patch,
  });
const assistantFrom = (model: string | undefined, ...blocks: Array<Record<string, unknown>>) =>
  JSON.stringify({ type: "assistant", message: { model, content: blocks } });
const assistant = (...blocks: Array<Record<string, unknown>>) => assistantFrom("claude-opus-5", ...blocks);
const result = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { summary: "s", findings: [], observed_instructions: [] }, ...patch });
const stream = (...lines: string[]) => lines.join("\n") + "\n";

// Saved and restored around the two tests below that need a temp-dir env variable no filesystem
// actually holds, so neither leaks into a test that runs after it.
function withRelativeTmpdir<T>(fn: () => T): T {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = "rel";
  process.env.TMP = "rel";
  process.env.TEMP = "rel";
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key as "TMPDIR" | "TMP" | "TEMP"];
      else process.env[key as "TMPDIR" | "TMP" | "TEMP"] = value;
    }
  }
}

describe("neutralWorkingDirectory()", () => {
  // Measured 2026-09-11: the CLI tells the model its working directory. From a temp directory under
  // the user profile that line carried the username; from the drive root it named no one.
  test("is the root of the temp directory's filesystem", () => {
    expect(neutralWorkingDirectory()).toBe(parse(tmpdir()).root);
  });

  test("does not contain the account's username", () => {
    const username = userInfo().username.toLowerCase();
    expect(neutralWorkingDirectory().toLowerCase().includes(username)).toBe(false);
  });

  // A6.3: a relative TMPDIR/TMP/TEMP gives tmpdir() a relative path whose root is "", and
  // Bun.spawn({ cwd: "" }) silently runs the reviewer in this process's own cwd instead.
  test("throws when the temp directory is not absolute", () => {
    withRelativeTmpdir(() => {
      expect(() => neutralWorkingDirectory()).toThrow();
    });
  });
});

describe("claudeArgs()", () => {
  const args = claudeArgs("/tmp/system-prompt.md");
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  test("pins the model, effort, schema and system prompt file", () => {
    expect(after("--model")).toBe(REVIEWER_MODEL);
    expect(after("--effort")).toBe("xhigh");
    expect(after("--json-schema")).toBe(JSON.stringify(FINDINGS_JSON_SCHEMA));
    expect(after("--system-prompt-file")).toBe("/tmp/system-prompt.md");
    expect(after("--output-format")).toBe("stream-json");
  });

  test("gives the session no tools and no setting sources", () => {
    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
  });

  test.each(["-p", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--verbose"])(
    "includes %s",
    (flag) => {
      expect(args).toContain(flag);
    },
  );

  test.each([
    "--mcp-config",
    "--allowedTools",
    "--allowed-tools",
    "--add-dir",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "--agents",
    "--plugin-dir",
    "--settings",
  ])("never includes %s", (flag) => {
    expect(args).not.toContain(flag);
  });
});

describe("parseStreamJson()", () => {
  test("the captured shape of a clean run is accepted", () => {
    const text = stream(
      init(),
      JSON.stringify({ type: "rate_limit_event" }),
      assistant({ type: "thinking" }),
      assistant({ type: "tool_use", name: "StructuredOutput" }),
      result(),
    );
    expect(parseStreamJson(text, 0)).toEqual({
      ok: true,
      output: { summary: "s", findings: [], observed_instructions: [] },
      model: "claude-opus-5",
      tools: [...EXPECTED_TOOLS],
    });
  });

  test.each([
    ["a Bash tool beside StructuredOutput", stream(init({ tools: ["StructuredOutput", "Bash"] }), result()), 0, "tools"],
    ["no tools at all, so the schema was not applied", stream(init({ tools: [] }), result()), 0, "tools"],
    ["a connected MCP server", stream(init({ mcp_servers: [{ name: "x", status: "connected" }] }), result()), 0, "MCP"],
    // A6.2: measured 2026-09-11 (task-6-report.md, Step 0) - without --safe-mode --setting-sources ""
    // the init event carried the account's 10 cached plugins and a non-default output_style; with
    // them plugins was empty and output_style was "default". Both are user configuration reaching
    // the session the same way the rules text would.
    ["a run that loaded plugins", stream(init({ plugins: [{ name: "x" }] }), result()), 0, "plugins"],
    ["a run with a configured output style", stream(init({ output_style: "Explanatory" }), result()), 0, "output style"],
    ["a different model", stream(init({ model: "claude-haiku-4-5-20251001" }), result()), 0, "model"],
    ["a call to a tool other than StructuredOutput", stream(init(), assistant({ type: "tool_use", name: "Bash" }), result()), 0, "tool other"],
    // A6.1: only the block type spelled exactly "tool_use" was checked; server_tool_use and
    // mcp_tool_use (the API's server-side and MCP-connector tool-call block types) passed unchecked,
    // and so did a tool_use block whose name was not a string.
    ["a server-side tool call beside StructuredOutput", stream(init(), assistant({ type: "server_tool_use", name: "web_search" }), result()), 0, "tool other"],
    ["an MCP tool call beside StructuredOutput", stream(init(), assistant({ type: "mcp_tool_use", name: "x" }), result()), 0, "tool other"],
    ["a tool_use block whose name is not a string", stream(init(), assistant({ type: "tool_use", name: ["StructuredOutput"] }), result()), 0, "tool other"],
    // Captured 2026-09-11: a run emitted this event, and its modelUsage listed claude-opus-4-8, while
    // its init event still named claude-opus-5. A trivial prompt did not fall back.
    ["a model_refusal_fallback event", stream(init(), JSON.stringify({ type: "system", subtype: "model_refusal_fallback" }), assistant({ type: "tool_use", name: "StructuredOutput" }), result()), 0, "model_refusal_fallback"],
    ["an assistant turn from another model", stream(init(), assistantFrom("claude-opus-4-8", { type: "tool_use", name: "StructuredOutput" }), result()), 0, "assistant turn"],
    ["an assistant turn that names no model", stream(init(), assistantFrom(undefined, { type: "thinking" }), result()), 0, "assistant turn"],
    ["no init event", stream(result()), 0, "init"],
    ["two init events", stream(init(), init(), result()), 0, "init"],
    ["a non-JSON line", stream(init(), "not json", result()), 0, "JSON"],
    ["a non-zero exit", stream(init(), result()), 1, "exited"],
    ["no result event", stream(init()), 0, "result"],
    ["two result events", stream(init(), result(), result()), 0, "result"],
    ["a result that did not end in success", stream(init(), result({ subtype: "error_max_budget_usd" })), 0, "success"],
    ["an error result", stream(init(), result({ is_error: true })), 0, "success"],
    ["no structured output", stream(init(), result({ structured_output: undefined })), 0, "structured"],
  ] as const)("rejects %s", (_label, text, exitCode, reasonPart) => {
    const parsed = parseStreamJson(text, exitCode);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reasonPart);
  });
});

describe("ClaudeCliRunner against a fake claude", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-fake-claude-"));
  const fake = join(dir, "fake-claude.ts");
  writeFileSync(
    fake,
    [
      'const mode = process.argv[2]!.slice("--fake-mode=".length);',
      "const args = process.argv.slice(3);",
      "const stdin = await new Response(Bun.stdin.stream()).text();",
      'const systemPromptFile = args[args.indexOf("--system-prompt-file") + 1]!;',
      "const systemPrompt = await Bun.file(systemPromptFile).text();",
      'if (mode === "sleep") await Bun.sleep(10_000);',
      'const tools = mode === "extra-tool" ? ["StructuredOutput", "Bash"] : ["StructuredOutput"];',
      'console.log(JSON.stringify({ type: "system", subtype: "init", tools, mcp_servers: [], plugins: [], output_style: "default", model: "claude-opus-5" }));',
      'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { stdin, systemPrompt, systemPromptFile, cwd: process.cwd(), args } }));',
      'if (mode === "exit-1") process.exit(1);',
    ].join("\n"),
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runner = (mode: string, timeoutMs?: number) => new ClaudeCliRunner({ command: [process.execPath, fake, `--fake-mode=${mode}`], timeoutMs });

  test("runs from the neutral directory, passes the prompt on stdin and the system prompt through a file it then removes", async () => {
    const userPrompt = "USER-PROMPT ".repeat(40_000);
    const run = await runner("ok").run({ systemPrompt: "SYSTEM-PROMPT", userPrompt });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const seen = run.output as { stdin: string; systemPrompt: string; systemPromptFile: string; cwd: string; args: string[] };
    expect(seen.stdin).toBe(userPrompt);
    expect(seen.systemPrompt).toBe("SYSTEM-PROMPT");
    expect(resolve(seen.cwd)).toBe(resolve(neutralWorkingDirectory()));
    expect(basename(dirname(seen.systemPromptFile)).startsWith("pr-review-run-")).toBe(true);
    expect(seen.args).toEqual(claudeArgs(seen.systemPromptFile));
    expect(existsSync(dirname(seen.systemPromptFile))).toBe(false);
  }, 20_000);

  test("a session that exposes an extra tool is rejected", async () => {
    const run = await runner("extra-tool").run({ systemPrompt: "s", userPrompt: "u" });
    expect(run.ok).toBe(false);
  }, 20_000);

  test("a non-zero exit is rejected", async () => {
    const run = await runner("exit-1").run({ systemPrompt: "s", userPrompt: "u" });
    expect(run.ok).toBe(false);
  }, 20_000);

  test("a run past its time limit is killed and rejected", async () => {
    const started = Date.now();
    const run = await runner("sleep", 300).run({ systemPrompt: "s", userPrompt: "u" });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toContain("time limit");
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  // F17: this does not put claude off PATH; it passes an empty command directly, the same seam a
  // PATH lookup failure produces inside the constructor.
  test("an empty command is a rejection, not a crash", async () => {
    const run = await new ClaudeCliRunner({ command: [] }).run({ systemPrompt: "s", userPrompt: "u" });
    expect(run.ok).toBe(false);
  });

  // A6.3: run() must convert neutralWorkingDirectory()'s throw into a result, not an unhandled
  // rejection, and must do so before creating any temp resources.
  test("a relative temp directory is a rejection, not a crash", async () => {
    const run = await withRelativeTmpdir(() => runner("ok").run({ systemPrompt: "s", userPrompt: "u" }));
    expect(run.ok).toBe(false);
  }, 20_000);
});
