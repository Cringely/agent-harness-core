// Tests for tools/pr-review/runner.ts. The runner's control is not its flags but its check of the
// session's own stream: a run whose init event lists any tool other than StructuredOutput, connects
// an MCP server, carries a memory_paths key, loaded a plugin, used a configured output style, ran
// from a working directory other than neutralWorkingDirectory(), or resolves a different model is
// rejected. So is a run whose stream carries any hook_* event, shows another model answering, calls
// another tool, has no assistant turn at all, emits a second result, or does not end in success. The
// stream shapes below match captures from claude 2.1.268 on 2026-09-10 and 2026-09-11, and the
// plugins/output_style/memory_paths checks from a same-day capture on 2.1.269 comparing a run with
// --safe-mode --setting-sources "" against one without (task-6-report.md, Step 0). ClaudeCliRunner is
// exercised against a fake `claude` written at runtime and run by bun itself.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join, parse, resolve } from "node:path";
import { FINDINGS_JSON_SCHEMA } from "../tools/pr-review/findings";
import {
  BUILTIN_PLUGINS,
  ClaudeCliRunner,
  EXPECTED_TOOLS,
  MAX_ATTEMPTS,
  REVIEWER_MODEL,
  claudeArgs,
  neutralWorkingDirectory,
  parseStreamJson,
} from "../tools/pr-review/runner";
import { posixSh, posixShDir } from "./posix-sh";

// #144: the "descendant holding the pipes open" case below needs a real POSIX `sh` (plus `cat`
// and `sleep` beside it) to drive ClaudeCliRunner through a real spawn. Resolved once here,
// the same shape as gitignore-sidecar-protection.test.ts's pwshPath, so a host with no `sh`
// anywhere (posixSh() exhausted PATH and git's own usr/bin) gets a named skip instead of the
// resolution failure reading as "the reviewer process could not be started" -- the runner's
// generic rejection for a command that never spawned -- or, from inside the test body, an
// uncaught throw.
let grandchildSh: string | undefined;
try {
  grandchildSh = posixSh();
} catch (err) {
  console.warn(
    `pr-review-runner.test.ts: no POSIX sh found, "a descendant holding the pipes open..." skipped. ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

const init = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    tools: ["StructuredOutput"],
    mcp_servers: [],
    plugins: [],
    output_style: "default",
    cwd: neutralWorkingDirectory(),
    model: "claude-opus-5-5",
    ...patch,
  });
const assistantFrom = (model: string | undefined, ...blocks: Array<Record<string, unknown>>) =>
  JSON.stringify({ type: "assistant", message: { model, content: blocks } });
const assistant = (...blocks: Array<Record<string, unknown>>) => assistantFrom("claude-opus-5-5", ...blocks);
const result = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { summary: "s", findings: [], observed_instructions: [] }, ...patch });
const stream = (...lines: string[]) => lines.join("\n") + "\n";

// Saved and restored around the "descendant holding the pipes open" test, which spawns
// grandchildSh through ClaudeCliRunner -- and that always runs the child with this process's
// own process.env, never a caller-supplied one. When grandchildSh came from git's own usr/bin
// (posixShDir() set) rather than off the ambient PATH, the shell's own `cat` and `sleep` live
// beside it and need that directory on PATH too, or the shell resolves but its subprocesses
// don't. Restored unconditionally so a host where the ambient PATH already carries sh (posix,
// or Git Bash) is untouched.
async function withGrandchildShOnPath<T>(fn: () => Promise<T>): Promise<T> {
  const shDir = posixShDir();
  if (!shDir) return fn();
  const saved = process.env.PATH;
  process.env.PATH = `${saved ?? ""}${delimiter}${shDir}`;
  try {
    // Awaited here, not just returned: fn's promise must settle before the finally below puts
    // PATH back, or the restore races the still-running spawn and the grandchild loses `cat`
    // and `sleep` mid-flight.
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

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
  ])("never includes %s", (flag) => {
    expect(args).not.toContain(flag);
  });

  // #238: claude 2.1.283 and later load built-in plugins in every session, headless included, and
  // no other flag here unloads them. The one --settings value may only switch those plugins off: a
  // settings path, or any other key, would hand the session configuration the checks never see.
  test("passes exactly one --settings, whose JSON only disables the built-in plugins", () => {
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(after("--settings"))).toEqual({
      enabledPlugins: {
        "cc-plugin-agents-md@builtin": false,
        "cc-plugin-telemetry@builtin": false,
        "agents-md@builtin": false,
        "telemetry@builtin": false,
        "cc-plugin-diff@builtin": false,
        "cc-plugin-plugin-authoring@builtin": false,
      },
    });
  });

  // #250: a relaunch adds the built-ins the previous attempt's init event named to the seed list.
  test("adds learned built-in names to the seed list, once each", () => {
    const relaunch = claudeArgs("/tmp/system-prompt.md", ["cc-plugin-new@builtin", "cc-plugin-diff@builtin"]);
    const settings = JSON.parse(relaunch[relaunch.indexOf("--settings") + 1]!);
    expect(Object.keys(settings)).toEqual(["enabledPlugins"]);
    expect(settings.enabledPlugins).toEqual({
      ...Object.fromEntries(BUILTIN_PLUGINS.map((name) => [name, false])),
      "cc-plugin-new@builtin": false,
    });
    expect(relaunch.filter((a) => a !== relaunch[relaunch.indexOf("--settings") + 1])).toEqual(
      args.filter((a) => a !== after("--settings")),
    );
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
      model: "claude-opus-5-5",
      tools: [...EXPECTED_TOOLS],
    });
  });

  test.each([
    ["a Bash tool beside StructuredOutput", stream(init({ tools: ["StructuredOutput", "Bash"] }), result()), 0, "tools"],
    ["no tools at all, so the schema was not applied", stream(init({ tools: [] }), result()), 0, "tools"],
    ["a connected MCP server", stream(init({ mcp_servers: [{ name: "x", status: "connected" }] }), result()), 0, "MCP"],
    // C1: measured 2026-09-11 (task-6-report.md, Step 0) - without --safe-mode --setting-sources ""
    // the init event carried a memory_paths key naming a project-specific directory under the
    // profile; with them the key was absent entirely. No clean account configuration produces this
    // key, so its mere presence is rejected regardless of value.
    ["a run whose init carried memory_paths", stream(init({ memory_paths: { auto: "X:/p/memory/" } }), result()), 0, "memory_paths"],
    // Secondary signal for the same failure as memory_paths, kept for accounts where the leak also
    // shows up here.
    ["a run that loaded plugins", stream(init({ plugins: [{ name: "x" }] }), result()), 0, "plugins"],
    // #238: the init shape captured live on claude 2.1.285 without the --settings override. Built-in
    // plugins are rejected like any other: agents-md injects AGENTS.md instructions, and a future
    // built-in must fail closed rather than pass because of where it came from.
    [
      "a run that loaded the built-in plugins",
      stream(
        init({
          plugins: [
            { name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" },
            { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
          ],
        }),
        assistant({ type: "tool_use", name: "StructuredOutput" }),
        result(),
      ),
      0,
      "plugins",
    ],
    ["a run with a configured output style", stream(init({ output_style: "Explanatory" }), result()), 0, "output style"],
    // I1: plan-audit-t4-t11.md's cwd clause. init.cwd is the CLI's own report of where it ran.
    ["a foreign working directory", stream(init({ cwd: "X:/Users/someone/work" }), result()), 0, "directory"],
    ["a different model", stream(init({ model: "claude-haiku-4-5-20251001" }), result()), 0, "model"],
    ["a call to a tool other than StructuredOutput", stream(init(), assistant({ type: "tool_use", name: "Bash" }), result()), 0, "tool other"],
    // A6.1: only the block type spelled exactly "tool_use" was checked; server_tool_use and
    // mcp_tool_use (the API's server-side and MCP-connector tool-call block types) passed unchecked,
    // and so did a tool_use block whose name was not a string.
    ["a server-side tool call beside StructuredOutput", stream(init(), assistant({ type: "server_tool_use", name: "web_search" }), result()), 0, "tool other"],
    ["an MCP tool call beside StructuredOutput", stream(init(), assistant({ type: "mcp_tool_use", name: "x" }), result()), 0, "tool other"],
    ["a tool_use block whose name is not a string", stream(init(), assistant({ type: "tool_use", name: ["StructuredOutput"] }), result()), 0, "tool other"],
    // I3 (P8): a null content block would throw reading `.type` off it instead of being rejected.
    ["an assistant content block that is not an object", stream(init(), JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [null] } }), result()), 0, "tool other"],
    // Captured 2026-09-11: a run emitted this event, and its modelUsage listed claude-opus-4-8, while
    // its init event still named claude-opus-5. A trivial prompt did not fall back.
    ["a model_refusal_fallback event", stream(init(), JSON.stringify({ type: "system", subtype: "model_refusal_fallback" }), assistant({ type: "tool_use", name: "StructuredOutput" }), result()), 0, "model_refusal_fallback"],
    // C2: Step 0 saw hook_started/hook_response/hook_progress events in the run without
    // --setting-sources "" and none in the run with it. Rejected regardless of where in the stream
    // they appear, since a hook running at all means operator-configured automation ran against
    // attacker-controlled pull request text.
    ["a hook event before init", stream(JSON.stringify({ type: "system", subtype: "hook_started" }), init(), result()), 0, "hook"],
    ["a hook event after the result", stream(init(), result(), JSON.stringify({ type: "system", subtype: "hook_response" })), 0, "hook"],
    ["an assistant turn from another model", stream(init(), assistantFrom("claude-opus-4-8", { type: "tool_use", name: "StructuredOutput" }), result()), 0, "assistant turn"],
    ["an assistant turn that names no model", stream(init(), assistantFrom(undefined, { type: "thinking" }), result()), 0, "assistant turn"],
    // I2: a stream with no assistant turn at all passes every per-turn model check vacuously.
    ["no assistant turn", stream(init(), result()), 0, "assistant turn"],
    ["no init event", stream(result()), 0, "init"],
    ["two init events", stream(init(), init(), result()), 0, "init"],
    ["a non-JSON line", stream(init(), "not json", result()), 0, "JSON"],
    // I3 (P7): JSON.parse("null") succeeds; reading `.type` off the result would throw.
    ["a JSON line that is not an object", stream(init(), "null", result()), 0, "JSON"],
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
      'console.log(JSON.stringify({ type: "system", subtype: "init", tools, mcp_servers: [], plugins: [], output_style: "default", cwd: process.cwd(), model: "claude-opus-5-5" }));',
      'console.log(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", name: "StructuredOutput" }] } }));',
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

  // I3 (Q1): a command that does not resolve to a real executable makes Bun.spawn throw
  // synchronously; before the fix that escaped run() as a rejected promise instead of an { ok: false }.
  test("a command that does not resolve is a rejection, not a crash", async () => {
    const run = await new ClaudeCliRunner({ command: ["pr-review-no-such-binary-probe"] }).run({ systemPrompt: "s", userPrompt: "u" });
    expect(run.ok).toBe(false);
  });

  // A6.3: run() must convert neutralWorkingDirectory()'s throw into a result, not an unhandled
  // rejection, and must do so before creating any temp resources.
  test("a relative temp directory is a rejection, not a crash", async () => {
    const run = await withRelativeTmpdir(() => runner("ok").run({ systemPrompt: "s", userPrompt: "u" }));
    expect(run.ok).toBe(false);
  }, 20_000);

  // I4: a plain `sh` process that prints a clean stream, backgrounds a sleep with its stdout
  // inherited, and exits immediately leaves that backgrounded process holding the pipe's write end
  // open. Before the fix, run() cleared its deadline as soon as the immediate `sh` process exited,
  // so draining the pipe then waited for the backgrounded process with no bound at all (Q2, Q3,
  // Q3b, all captured against the same shape of descendant).
  test.skipIf(!grandchildSh)("a descendant holding the pipes open past the time limit does not hang the run", async () => {
    const streamFile = join(dir, "grandchild-stream.jsonl");
    writeFileSync(streamFile, stream(init(), assistant({ type: "tool_use", name: "StructuredOutput" }), result()));
    await withGrandchildShOnPath(async () => {
      const started = Date.now();
      const run = await new ClaudeCliRunner({
        command: [grandchildSh!, "-c", `cat "${streamFile}"; sleep 5 & exit 0`],
        timeoutMs: 300,
      }).run({ systemPrompt: "s", userPrompt: "u" });
      expect(run.ok).toBe(false);
      if (!run.ok) expect(run.reason).toContain("time limit");
      expect(Date.now() - started).toBeLessThan(8_000);
    });
  }, 20_000);
});

// #250: the CLI's built-in plugin set varies per session, server-side, and enabledPlugins takes no
// wildcard. So the runner reads the init event as it arrives, kills a session whose plugins are all
// built-ins before the model runs, and relaunches with those names disabled too. This fake models
// that: it loads every plugin in its spec that --settings does not set to false, logs each launch's
// arguments, and, when it loaded any plugin, waits a second before writing a marker file that stands
// for the model having run, then prints a result that names its attempt.
describe("ClaudeCliRunner relaunch on built-in plugins (#250)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-fake-plugins-"));
  const fake = join(dir, "fake-claude-plugins.ts");
  writeFileSync(
    fake,
    [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      'const spec = JSON.parse(Buffer.from(process.argv[2]!.slice("--fake-spec=".length), "base64url").toString("utf8"));',
      "const args = process.argv.slice(3);",
      "await new Response(Bun.stdin.stream()).text();",
      'const NL = String.fromCharCode(10);',
      'const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);',
      'appendFileSync(spec.log, JSON.stringify({ args, settings }) + NL);',
      'const attempt = readFileSync(spec.log, "utf8").trim().split(NL).length;',
      "const candidates = spec.fresh ? [{ name: `cc-plugin-fresh-${attempt}`, path: \"builtin\", source: `cc-plugin-fresh-${attempt}@builtin` }] : spec.loaded;",
      "const plugins = candidates.filter((p: { source: string }) => settings.enabledPlugins[p.source] !== false);",
      'console.log(JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [], plugins, output_style: "default", cwd: process.cwd(), model: "claude-opus-5-5" }));',
      "if (plugins.length > 0) {",
      "  await Bun.sleep(1_000);",
      '  writeFileSync(`${spec.marker}-${attempt}`, "model ran");',
      "}",
      'console.log(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", name: "StructuredOutput" }] } }));',
      'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { attempt } }));',
    ].join("\n"),
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const builtin = (name: string) => ({ name, path: "builtin", source: `${name}@builtin` });
  const PLUGINS_REASON = "the reviewer session loaded plugins, so --setting-sources may not have excluded the operator's configuration";

  let caseNo = 0;
  async function runCase(spec: { loaded?: unknown[]; fresh?: boolean }) {
    caseNo += 1;
    const log = join(dir, `launches-${caseNo}.jsonl`);
    const marker = join(dir, `model-ran-${caseNo}`);
    const encoded = Buffer.from(JSON.stringify({ ...spec, log, marker }), "utf8").toString("base64url");
    const run = await new ClaudeCliRunner({ command: [process.execPath, fake, `--fake-spec=${encoded}`] }).run({ systemPrompt: "s", userPrompt: "u" });
    // Past the fake's one-second wait, so a session that was not killed has written its marker.
    await Bun.sleep(1_500);
    const launches = existsSync(log)
      ? (await Bun.file(log).text()).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { args: string[]; settings: { enabledPlugins: Record<string, boolean> } })
      : [];
    const modelRan = [1, 2, 3, 4].filter((n) => existsSync(`${marker}-${n}`));
    return { run, launches, modelRan };
  }

  test("built-ins on attempt 1, then clean on attempt 2, is accepted from attempt 2", async () => {
    const { run, launches, modelRan } = await runCase({ loaded: [builtin("cc-plugin-unseen")] });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.output).toEqual({ attempt: 2 });
    expect(launches).toHaveLength(2);
    // The killed attempt never reached its model turn, so its output never reached acceptance.
    expect(modelRan).toEqual([]);
  }, 20_000);

  test("the relaunch carries the learned names beside the seed list and changes nothing else", async () => {
    const { launches } = await runCase({ loaded: [builtin("cc-plugin-unseen-a"), builtin("cc-plugin-unseen-b")] });
    expect(launches).toHaveLength(2);
    const [first, second] = launches as [(typeof launches)[0], (typeof launches)[0]];
    expect(first.settings.enabledPlugins["cc-plugin-unseen-a@builtin"]).toBeUndefined();
    expect(second.settings.enabledPlugins).toEqual({
      ...Object.fromEntries(BUILTIN_PLUGINS.map((name) => [name, false])),
      "cc-plugin-unseen-a@builtin": false,
      "cc-plugin-unseen-b@builtin": false,
    });
    const systemPromptFile = second.args[second.args.indexOf("--system-prompt-file") + 1]!;
    expect(second.args).toEqual(claudeArgs(systemPromptFile, ["cc-plugin-unseen-a@builtin", "cc-plugin-unseen-b@builtin"]));
  }, 20_000);

  test.each([
    ["a non-built-in plugin", [{ name: "x", path: "X:/plugins/x", source: "x@some-marketplace" }]],
    ["a mix of built-in and non-built-in plugins", [builtin("cc-plugin-unseen"), { name: "x", path: "X:/plugins/x", source: "x@some-marketplace" }]],
    ["a built-in source whose path is not builtin", [{ name: "cc-plugin-z", path: "X:/plugins/z", source: "cc-plugin-z@builtin" }]],
    ["a builtin path whose source does not end in @builtin", [{ name: "cc-plugin-z", path: "builtin", source: "cc-plugin-z@builtin-ish" }]],
    ["a plugin entry that is not an object", ["cc-plugin-z@builtin"]],
  ])("%s is refused at init, with no relaunch and before the model runs", async (_label, loaded) => {
    const { run, launches, modelRan } = await runCase({ loaded });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toBe(PLUGINS_REASON);
    expect(launches).toHaveLength(1);
    expect(modelRan).toEqual([]);
  }, 20_000);

  test("built-ins on every attempt are refused at the attempt cap", async () => {
    const { run, launches, modelRan } = await runCase({ fresh: true });
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.reason).toContain("built-in plugins");
      expect(run.reason).toContain(`${MAX_ATTEMPTS} attempts`);
    }
    expect(launches).toHaveLength(MAX_ATTEMPTS);
    expect(modelRan).toEqual([]);
  }, 20_000);
});
