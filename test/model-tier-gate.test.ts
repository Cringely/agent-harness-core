// Tests for the model-tier PreToolUse gate (core/claude/hooks/model-tier-gate.ts).
//
// Two halves, and the second one is not optional. The pure half imports the exported
// scanAgentCalls/checkAgent/checkWorkflow/decide and runs offline, matching how
// test/agent-worktree-gate.test.ts covers its own decision logic.
//
// The spawn half exists because this gate's entire failure mode is a silent no-op. It fails open on
// every error path, so a hook that never runs, never parses its stdin, or exits 0 where it meant to
// exit 2 looks exactly like a hook that examined the dispatch and approved it. Pure-function tests
// cannot tell those apart: they call decide() directly and would keep passing with the process
// entrypoint deleted. The cases under "spawned process" pipe a real payload on stdin and assert the
// exit code, which is the only observable that distinguishes a working gate from an absent one.
// Every payload is built with JSON.stringify and handed to the process as stdin bytes, never
// interpolated into a shell command, because a payload mangled by shell quoting reaches a fail-open
// hook as garbage and comes back as exit 0, which reads as a pass.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgent,
  checkWorkflow,
  decide,
  effortViolation,
  OVERRIDE_TOKEN,
  scanAgentCalls,
  VALID_TIERS,
} from "../core/claude/hooks/model-tier-gate";

const ALLOW = { action: "allow" } as const;

/** No workflow script is readable unless a test says otherwise. */
const noRead = () => null;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

describe("scanAgentCalls() — finding call sites", () => {
  test("counts a bare agent() call", () => {
    expect(scanAgentCalls(`const r = await agent("do a thing", { label: "x" })`).map((c) => c.hasModel))
      .toEqual([false]);
  });

  test("accepts a call that names a tier", () => {
    expect(scanAgentCalls(`await agent("x", { label: "y", model: "haiku" })`).map((c) => c.hasModel))
      .toEqual([true]);
  });

  test("reports line numbers", () => {
    expect(scanAgentCalls(`const a = 1\n\nawait agent("x", {})`).map((c) => c.line)).toEqual([3]);
  });

  test("reports the label", () => {
    expect(scanAgentCalls(`await agent("x", { label: "measure:events" })`).map((c) => c.label))
      .toEqual(["measure:events"]);
  });

  test("falls back to phase when unlabelled", () => {
    expect(scanAgentCalls(`await agent("x", { phase: "Verify" })`).map((c) => c.label))
      .toEqual(["phase Verify"]);
  });

  test("extracts the model and effort values", () => {
    expect(scanAgentCalls(`await agent("x", { model: "sonnet", effort: "xhigh" })`).map((c) => [c.model, c.effort]))
      .toEqual([["sonnet", "xhigh"]]);
  });
});

describe("scanAgentCalls() — text that must not read as a call site", () => {
  test("ignores agent( inside a string literal", () => {
    expect(scanAgentCalls(`const s = "call agent( like this"; const t = 'agent(';`).length).toBe(0);
  });

  test("ignores agent( inside a line comment", () => {
    expect(scanAgentCalls(`// agent("x", {})\nconst a = 1`).length).toBe(0);
  });

  test("ignores agent( inside a block comment", () => {
    expect(scanAgentCalls(`/* agent("x", {})\n more */\nconst a = 1`).length).toBe(0);
  });

  test("does not match subagent( or obj.agent(", () => {
    expect(scanAgentCalls(`subagent("x", {}); thing.agent("y", {})`).length).toBe(0);
  });
});

describe("scanAgentCalls() — nesting", () => {
  // The real-world shape. An earlier draft of the scanner skipped to the end of the outer call and
  // silently missed every inner one, which would have let the exact fan-out that motivated this
  // gate sail through.
  test("finds agent() calls nested inside parallel()", () => {
    expect(
      scanAgentCalls(`await parallel([() => agent("a", {model:"haiku"}), () => agent("b", { label: "z" })])`)
        .map((c) => c.hasModel),
    ).toEqual([true, false]);
  });

  test("finds a call inside a template-literal interpolation", () => {
    expect(scanAgentCalls('const p = `x ${await agent("deep", { label: "t" })} y`').length).toBe(1);
  });
});

describe("scanAgentCalls() — known gap: interpolated templates hide call sites", () => {
  // These two assert what the scanner does today, not what it should do. The walk leaves
  // template-literal mode at `${` and never re-enters it, so the template's closing backtick reads
  // as an opening quote and swallows everything up to the next backtick or the end of the file.
  // Pinned rather than fixed: the gap was inherited from the account-layer original and a rewrite
  // of the walk is its own change. They are here so the gap is visible to the next reader and so a
  // later change to the walk cannot widen it without a test moving.
  test("a call whose prompt is an interpolated template is not seen, and neither is the one after it", () => {
    const script = 'await agent(`ssh ${h} uptime`, { label: "one" });\nawait agent("b", { label: "two" })';
    expect(scanAgentCalls(script).length).toBe(0);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW); // known gap, not intended behavior
  });

  test("an unrelated interpolated template hides every bare call after it", () => {
    const script = 'const msg = `x ${y} z`;\nawait agent("b", { label: "two" })';
    expect(scanAgentCalls(script).length).toBe(0);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW); // known gap, not intended behavior
  });
});

describe("scanAgentCalls() — a model value the scanner cannot read", () => {
  // Documented fail-open, per the hook's FAIL-OPEN CONTRACT: hasModel stays true and the value
  // comes back empty, so the tier and effort checks skip the call rather than guessing at it.
  test("a model longer than the literal pattern allows reads as present but unnamed", () => {
    expect(scanAgentCalls('await agent("a", { model: "sonnet-with-a-very-long-suffix" })'))
      .toEqual([{ line: 1, hasModel: true, model: "", effort: "", label: "unlabelled" }]);
  });

  test("a model passed as a variable reads as present but unnamed", () => {
    expect(scanAgentCalls('await agent("a", { model: cfg.model })').map((c) => [c.hasModel, c.model]))
      .toEqual([[true, ""]]);
  });

  test("neither one is denied, so an unreadable value allows", () => {
    expect(checkWorkflow({ script: 'await agent("a", { model: cfg.model })' }, noRead)).toEqual(ALLOW);
  });
});

// ---------------------------------------------------------------------------
// Agent / Task decisions
// ---------------------------------------------------------------------------

describe("checkAgent() — a dispatch has to name a tier", () => {
  test("no model at all: denied", () => {
    const verdict = checkAgent({ prompt: "go" });
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("inherits the session model");
      expect(verdict.reason).toContain(OVERRIDE_TOKEN);
    }
  });

  test("a named tier allows", () => {
    expect(checkAgent({ prompt: "go", model: "haiku" })).toEqual(ALLOW);
  });

  test.each(VALID_TIERS.filter((t) => t !== "sonnet"))("%s is accepted as a tier", (model) => {
    expect(checkAgent({ prompt: "go", model })).toEqual(ALLOW);
  });

  test("a tier this project does not recognize is denied", () => {
    const verdict = checkAgent({ prompt: "go", model: "gpt-9" });
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain("gpt-9");
  });

  test("fork is exempt, since a fork ignores a model override by design", () => {
    expect(checkAgent({ prompt: "go", subagent_type: "fork" })).toEqual(ALLOW);
  });

  test("a reasoned override in the prompt allows", () => {
    expect(checkAgent({ prompt: `${OVERRIDE_TOKEN} one-off, matches session tier` })).toEqual(ALLOW);
  });

  // Tightened against the account-layer original, to match ISOLATION-OVERRIDE in
  // agent-worktree-gate.ts: the token alone is not a reasoned override.
  test("a bare override token with no reason text does not pass", () => {
    expect(checkAgent({ prompt: OVERRIDE_TOKEN }).action).toBe("deny");
  });

  test("a non-object tool_input allows", () => {
    expect(checkAgent(null)).toEqual(ALLOW);
    expect(checkAgent("nope")).toEqual(ALLOW);
  });
});

describe("checkAgent() — the sonnet effort mandate", () => {
  test("sonnet with no effort is denied", () => {
    const verdict = checkAgent({ prompt: "go", model: "sonnet" });
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain("xhigh");
  });

  test("sonnet at xhigh allows", () => {
    expect(checkAgent({ prompt: "go", model: "sonnet", effort: "xhigh" })).toEqual(ALLOW);
  });

  test("sonnet at any other effort is denied", () => {
    expect(checkAgent({ prompt: "go", model: "sonnet", effort: "high" }).action).toBe("deny");
  });

  test("haiku has no mandated effort", () => {
    expect(checkAgent({ prompt: "go", model: "haiku" })).toEqual(ALLOW);
  });

  test("opus has no mandated effort", () => {
    expect(checkAgent({ prompt: "go", model: "opus" })).toEqual(ALLOW);
  });

  test("an override waives the effort mandate too", () => {
    expect(checkAgent({ prompt: `${OVERRIDE_TOKEN} deliberate`, model: "sonnet" })).toEqual(ALLOW);
  });

  test("effortViolation() reports nothing for a tier with no mandate", () => {
    expect(effortViolation("haiku", "")).toBeNull();
    expect(effortViolation("opus", "low")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workflow decisions
// ---------------------------------------------------------------------------

describe("checkWorkflow() — every agent() call in the script has to name a tier", () => {
  test("a script whose calls are all tiered allows", () => {
    expect(
      checkWorkflow({ script: `await agent("a",{model:"haiku"}); await agent("b",{model:"opus"})` }, noRead),
    ).toEqual(ALLOW);
  });

  test("one bare call is enough to deny, and the reason names its line", () => {
    const verdict = checkWorkflow(
      { script: `await agent("a",{model:"haiku"});\nawait agent("b",{label:"x"})` },
      noRead,
    );
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("line 2");
      expect(verdict.reason).toContain("x");
    }
  });

  test("a reasoned override anywhere in the script allows", () => {
    expect(
      checkWorkflow({ script: `// ${OVERRIDE_TOKEN} uniform tier is intended\nawait agent("a",{})` }, noRead),
    ).toEqual(ALLOW);
  });

  test("a script read off disk is scanned the same way", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-tier-gate-"));
    try {
      const path = join(dir, "flow.ts");
      writeFileSync(path, `await agent("a", { label: "fetch" })\n`);
      const readFile = (p: string) => (p === path ? `await agent("a", { label: "fetch" })\n` : null);
      expect(checkWorkflow({ scriptPath: path }, readFile).action).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkWorkflow() — fail-open paths", () => {
  test("a workflow invoked by name is not ours to police", () => {
    expect(checkWorkflow({ name: "some-saved-workflow" }, noRead)).toEqual(ALLOW);
  });

  test("an unreadable scriptPath allows", () => {
    expect(checkWorkflow({ scriptPath: "/nonexistent/flow.ts" }, noRead)).toEqual(ALLOW);
  });

  test("a script with no agent() calls allows", () => {
    expect(checkWorkflow({ script: `log("nothing to do")` }, noRead)).toEqual(ALLOW);
  });

  test("unbalanced parens allow rather than throw", () => {
    expect(() => checkWorkflow({ script: `await agent("a", { label: "x"` }, noRead)).not.toThrow();
    expect(checkWorkflow({ script: `await agent("a", { label: "x"` }, noRead)).toEqual(ALLOW);
  });

  test("a non-object tool_input allows", () => {
    expect(checkWorkflow(null, noRead)).toEqual(ALLOW);
  });
});

describe("checkWorkflow() — a stated tier still has to be one of the accepted ones", () => {
  // checkAgent has always rejected an unrecognized tier. checkWorkflow did not, so a misspelled
  // model in a fan-out script read as a stated tier and inherited the session model anyway, which
  // is the failure the gate exists to close.
  test("a call naming a tier this project does not recognize is denied", () => {
    const verdict = checkWorkflow({ script: `await agent("a",{model:"gpt-9",label:"fetch"})` }, noRead);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("gpt-9");
      expect(verdict.reason).toContain("fetch");
    }
  });

  test("a misspelled tier is denied rather than read as a stated one", () => {
    expect(checkWorkflow({ script: `await agent("a",{model:"sonet"})` }, noRead).action).toBe("deny");
  });

  test("a script-level override waives this too, unlike checkAgent", () => {
    expect(
      checkWorkflow({ script: `// ${OVERRIDE_TOKEN} deliberate\nawait agent("a",{model:"gpt-9"})` }, noRead),
    ).toEqual(ALLOW);
  });
});

describe("checkWorkflow() — the sonnet effort mandate applies per call site", () => {
  test("a sonnet call with no effort is denied", () => {
    expect(checkWorkflow({ script: `await agent("a",{model:"sonnet"})` }, noRead).action).toBe("deny");
  });

  test("a sonnet call at xhigh allows", () => {
    expect(checkWorkflow({ script: `await agent("a",{model:"sonnet",effort:"xhigh"})` }, noRead)).toEqual(ALLOW);
  });

  test("mixing haiku and sonnet-at-xhigh allows", () => {
    expect(
      checkWorkflow(
        { script: `await agent("a",{model:"haiku"}); await agent("b",{model:"sonnet",effort:"xhigh"})` },
        noRead,
      ),
    ).toEqual(ALLOW);
  });
});

// ---------------------------------------------------------------------------
// Payload routing
// ---------------------------------------------------------------------------

describe("decide() — which tools this gate judges", () => {
  test("Agent routes to the dispatch check", () => {
    expect(decide({ tool_name: "Agent", tool_input: { prompt: "go" } }).action).toBe("deny");
  });

  test("Task routes to the same check, being the older name for the same dispatch", () => {
    expect(decide({ tool_name: "Task", tool_input: { prompt: "go" } }).action).toBe("deny");
  });

  // Inferred tool name, never confirmed against a captured payload. See the hook's MATCHER NOTE:
  // if the real name differs this branch is inert, not wrong.
  test("Workflow routes to the script check", () => {
    expect(decide({ tool_name: "Workflow", tool_input: { script: `await agent("a",{})` } }).action)
      .toBe("deny");
  });

  test("an unrelated tool allows", () => {
    expect(decide({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual(ALLOW);
  });

  test("a non-object payload allows", () => {
    expect(decide(null)).toEqual(ALLOW);
    expect(decide("nope")).toEqual(ALLOW);
  });

  test("the default reader makes a scriptPath unreadable, so it allows", () => {
    expect(decide({ tool_name: "Workflow", tool_input: { scriptPath: "/nonexistent/flow.ts" } }))
      .toEqual(ALLOW);
  });
});

// ---------------------------------------------------------------------------
// Spawned process. See the header for why these are load-bearing.
// ---------------------------------------------------------------------------

const HOOK = join(import.meta.dir, "..", "core", "claude", "hooks", "model-tier-gate.ts");

/** Runs the hook as a real process with `stdinText` on stdin. Never goes through a shell. */
function runHook(stdinText: string) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, HOOK],
    stdin: new TextEncoder().encode(stdinText),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("spawned process — the deny path is observable", () => {
  test("an Agent payload with no model exits 2 and puts a reason on stderr", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Agent",
        tool_input: { description: "d", prompt: "do a thing" },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
    expect(result.stderr).toContain("does not state a model tier");
  });

  test("the same payload naming haiku exits 0 and says nothing", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Agent",
        tool_input: { description: "d", prompt: "do a thing", model: "haiku" },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("sonnet without effort xhigh exits 2", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Agent",
        tool_input: { description: "d", prompt: "do a thing", model: "sonnet" },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("xhigh");
  });

  test("a Workflow payload with a bare agent() call exits 2 and names the call site", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Workflow",
        tool_input: { script: `await agent("a", { label: "fetch logs" })` },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("fetch logs");
  });
});

describe("spawned process — the fail-open paths stay open", () => {
  test("an unrelated tool exits 0 and says nothing", () => {
    const result = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  // Deliberately not valid JSON, so it cannot be built with JSON.stringify. It is still passed as
  // stdin bytes rather than through a shell.
  test("malformed JSON exits 0, emits no deny, and leaves a diagnostic rather than vanishing", () => {
    const result = runHook("{not json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("BLOCKED");
    expect(result.stderr).toContain("model-tier-gate: hook error");
  });

  test("empty stdin exits 0 and says nothing", () => {
    const result = runHook("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("a valid payload for a tiered dispatch exits 0 even when a workflow script is unreadable", () => {
    const result = runHook(
      JSON.stringify({ tool_name: "Workflow", tool_input: { scriptPath: "/nonexistent/flow.ts" } }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
