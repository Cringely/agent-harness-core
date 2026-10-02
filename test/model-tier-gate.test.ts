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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  agentDefDirs,
  checkAgent,
  checkWorkflow,
  decide,
  type DefSource,
  OVERRIDE_TOKEN,
  parseTierMap,
  pinnedModel,
  scanAgentCalls,
  TIER_MAP_FILE,
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

describe("scanAgentCalls() — interpolated templates, the gap this scanner was rewritten to close", () => {
  // These two used to assert the opposite: the walk left template mode at `${` and never re-entered
  // it, so the closing backtick read as an opening quote and swallowed everything up to the next
  // backtick or the end of the file. They were pinned as a known gap and are now inverted. Measured
  // over the 51 real workflow scripts on the authoring machine, that gap hid 168 of 194 call sites
  // and flipped 25 files from deny to allow, including the fan-out shape the gate exists for.
  test("a call whose prompt is an interpolated template is seen, and so is the one after it", () => {
    const script = 'await agent(`ssh ${h} uptime`, { label: "one" });\nawait agent("b", { label: "two" })';
    expect(scanAgentCalls(script).map((c) => [c.line, c.label, c.hasModel]))
      .toEqual([[1, "one", false], [2, "two", false]]);
    const verdict = checkWorkflow({ script }, noRead);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("one");
      expect(verdict.reason).toContain("two");
    }
  });

  test("an unrelated interpolated template no longer hides the bare calls after it", () => {
    const script = 'const msg = `x ${y} z`;\nawait agent("b", { label: "two" })';
    expect(scanAgentCalls(script).map((c) => c.line)).toEqual([2]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });

  // The incident that motivated building the gate: one call site, fanned out at runtime. The report
  // says 1 of 1, not 30 — the scanner counts sites, not dispatches.
  test("a fan-out that interpolates both the prompt and the label is one visible call site", () => {
    const script = 'parallel(hosts.map((h) => () => agent(`ssh ${h} uptime`, {label:`probe ${h}`})))';
    expect(scanAgentCalls(script).map((c) => c.hasModel)).toEqual([false]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });

  test("template prose that merely mentions agent() is not a call site", () => {
    const script = 'const q = `how many contain agent() calls whose prompt is a template`;\nlog(q)';
    expect(scanAgentCalls(script).length).toBe(0);
  });

  // Misattribution, the third consequence of the old walk and the one that is not merely a missed
  // call. The bracket matcher desynced along with the walk, so a call's span ran past its own
  // closing paren and swallowed later text. Here it picked up `model:"haiku"` out of prose: the old
  // scanner returned a single call with hasModel true and model "haiku", so a bare fan-out ALLOWED
  // on a tier nobody wrote. The same mechanism invents call sites out of `agent()` inside prose,
  // which is a false block rather than a false allow.
  test("a model written in template prose does not attach itself to a bare call", () => {
    const script = [
      'await agent(`ssh ${h} uptime`, { label: "real" });',
      'const brief = `use {model:"haiku"} on cheap ones ) here`;',
      'await agent("b", { label: "two" });',
    ].join("\n");
    expect(scanAgentCalls(script).map((c) => [c.line, c.label, c.hasModel, c.model]))
      .toEqual([[1, "real", false, ""], [3, "two", false, ""]]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });
});

describe("scanAgentCalls() — template nesting", () => {
  test("a template nested inside an interpolation resumes the outer template on close", () => {
    const script = 'const s = `a ${ `b ${c} d` } e`;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).map((c) => [c.line, c.hasModel])).toEqual([[2, false]]);
  });

  // The test above names the right property and cannot actually discriminate it. Putting the call
  // after the whole statement lets the stack converge by accident: pop one too many at the nested
  // template's closing backtick and `[T,I,T]` becomes `[T]`, then the outer backtick over-pops
  // `[T]` to `[]`, so the end state coincides and a broken walk still passes. An ablation pass
  // confirmed it — double-popping at the template-closing backtick left the suite green. Moving the
  // call inside the interpolation is what discriminates: under that break the walk is sitting in
  // outer-template text when it reaches `agent(`, so the call reads as prose and the workflow
  // allows. That is the false-allow class this gate exists to close, so it gets its own assertion.
  test("a call in an interpolation after a nested template closes is still code", () => {
    const script = 'const p = `x ${ `inner` + agent("a", { label: "q" }) } y`;';
    expect(scanAgentCalls(script).map((c) => [c.line, c.label, c.hasModel])).toEqual([[1, "q", false]]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });

  test("the same nested template works as a prompt", () => {
    expect(scanAgentCalls('await agent(`a ${ `b ${c} d` } e`, { label: "n" })').map((c) => c.hasModel))
      .toEqual([false]);
  });

  // A bare "next } wins" rule fails here: the `}` of `{a:1}` must not end the interpolation. That
  // is what forces a per-frame brace counter rather than a boolean.
  test("an object literal inside an interpolation does not end the interpolation early", () => {
    const script = 'const s = `x ${ f({a:1}) } y`;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).map((c) => [c.line, c.hasModel])).toEqual([[2, false]]);
  });

  test("the same shape works as a prompt", () => {
    expect(scanAgentCalls('await agent(`x ${ f({a:1}) } y`, { label: "n" })').length).toBe(1);
  });

  // Inside `${ }` we are in code, so a quote opens an ordinary string and a backtick within it is
  // data. Getting this wrong closes the template on the wrong byte.
  test("a backtick inside a double-quoted string inside an interpolation is data", () => {
    const script = 'const s = `x ${ q("`") } y`;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).map((c) => [c.line, c.hasModel])).toEqual([[2, false]]);
  });

  test("the same with single quotes", () => {
    const script = "const s = `x ${ q('`') } y`;\nawait agent(\"z\", { label: \"after\" })";
    expect(scanAgentCalls(script).map((c) => c.line)).toEqual([2]);
  });

  test("a nested call inside an interpolation and a bare call after it are both counted", () => {
    const script = 'const p = `${ agent("x", {label:"inner"}) }`;\nawait agent("y", {label:"after"})';
    expect(scanAgentCalls(script).map((c) => [c.line, c.label])).toEqual([[1, "inner"], [2, "after"]]);
  });

  test("a tiered call inside an interpolation keeps its tier", () => {
    expect(scanAgentCalls('const p = `${ agent("x", {model:"haiku"}) }`').map((c) => [c.hasModel, c.model]))
      .toEqual([[true, "haiku"]]);
  });

  test("newlines inside template text and inside interpolations both count", () => {
    const script = 'const s = `a\nb ${\nc\n} d`;\nawait agent("z", {})';
    expect(scanAgentCalls(script).map((c) => c.line)).toEqual([5]);
  });
});

describe("scanAgentCalls() — the opts object is read as code, not as bytes", () => {
  // Same defect as the template walk, one layer down. An earlier draft found the call site with the
  // lexer and then ran plain regexes over the raw bytes of its extent, so a `model:` anywhere in
  // those bytes counted. Two of the three shapes below are false allows and one is a false block.
  test("a model commented out with a block comment does not count as stated", () => {
    const script = 'await agent("x", { label: "a" /* model: "haiku" */ });';
    expect(scanAgentCalls(script).map((c) => [c.hasModel, c.model])).toEqual([[false, ""]]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });

  // Commenting the model out is the single most likely way a live script acquires a bare call.
  test("a model commented out with a line comment does not count either", () => {
    const script = 'await agent("x", {\n  label: "a",\n  // model: "haiku",\n});';
    expect(scanAgentCalls(script).map((c) => c.hasModel)).toEqual([false]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });

  // The false-block half, and the one that matters most: a correctly tiered call denied because its
  // prompt talks about tiers. Three corpus scripts carry `model:` or `effort:` in prompt prose.
  test("model named in the prompt's prose does not override the real opts", () => {
    const script = 'await agent(`verify model: "sonnet" is used`, { label: "v", model: "haiku" });';
    expect(scanAgentCalls(script).map((c) => [c.model, c.label])).toEqual([["haiku", "v"]]);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW);
  });

  test("effort named in the prompt's prose does not override the real opts", () => {
    const script = 'await agent(`set effort: "low" never`, { label: "x", model: "sonnet", effort: "xhigh" });';
    expect(scanAgentCalls(script).map((c) => [c.model, c.effort])).toEqual([["sonnet", "xhigh"]]);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW);
  });

  test("a model in an ordinary string is prose too", () => {
    const script = 'await agent("use model: \\"haiku\\" here", { label: "s" })';
    expect(scanAgentCalls(script).map((c) => c.hasModel)).toEqual([false]);
  });

  // A nested call is its own dispatch with its own tier. Donating it to the enclosing call lets a
  // bare outer call ride in on the inner one's model.
  test("a nested call's model belongs to the nested call, not the one containing it", () => {
    const script = 'await agent("outer", { label: "o", then: agent("in", { model: "haiku", label: "i" }) })';
    expect(scanAgentCalls(script).map((c) => [c.label, c.hasModel, c.model]))
      .toEqual([["o", false, ""], ["i", true, "haiku"]]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });

  test("a model one object deeper is not this call's model", () => {
    expect(scanAgentCalls('await agent("x", { label: "n", cfg: { model: "haiku" } })').map((c) => c.hasModel))
      .toEqual([false]);
  });

  // The three below pin the three halves of "directly in this call's argument list" separately.
  // An ablation pass showed each one alone can be relaxed without any other test noticing, and two
  // of the three relax into a false allow.
  test("a sibling argument's object literal is not the opts object", () => {
    expect(scanAgentCalls('await agent("x", { label: "a" }, opt({ model: "haiku" }))').map((c) => c.hasModel))
      .toEqual([false]);
  });

  test("an object literal inside the prompt's own interpolation is not the opts object", () => {
    expect(scanAgentCalls('await agent(`${ {model:"haiku"} } go`, { label: "x" })').map((c) => c.hasModel))
      .toEqual([false]);
  });

  // The false-deny half of the same rule, and the realistic one: a call inside any block whose
  // prompt is an interpolated template. The `}` that ends an interpolation has no `{` of its own,
  // so counting it as a code brace desyncs the depth for the rest of the call and loses the model.
  test("an interpolated prompt inside a block does not lose the call's model", () => {
    const script = 'if (ok) {\n  await agent(`${x}`, { model: "haiku", label: "h" });\n}';
    expect(scanAgentCalls(script).map((c) => [c.line, c.hasModel, c.model])).toEqual([[2, true, "haiku"]]);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW);
  });

  test("a quoted key still reads as a stated tier", () => {
    const script = 'await agent("x", { "model": "haiku", "label": "qk" })';
    expect(scanAgentCalls(script).map((c) => [c.hasModel, c.model, c.label])).toEqual([[true, "haiku", "qk"]]);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW);
  });
});

describe("scanAgentCalls() — the name and its paren need not be adjacent", () => {
  // All three are valid JS and all three used to scan to zero calls, which allows. Cheap to close
  // once the walk reads identifiers as tokens rather than matching the literal string "agent(".
  test("whitespace between agent and its paren still reads as a call", () => {
    expect(scanAgentCalls('agent ("x", { label: "sp" })').map((c) => [c.line, c.label])).toEqual([[1, "sp"]]);
  });

  test("a newline between them does too, and the line reported is the name's", () => {
    expect(scanAgentCalls('agent\n("x", { label: "nl" })').map((c) => [c.line, c.label])).toEqual([[1, "nl"]]);
  });

  test("a comment between them does too", () => {
    expect(scanAgentCalls('agent/*c*/("x", { label: "cm" })').map((c) => c.label)).toEqual(["cm"]);
  });

  test("a longer identifier starting with agent is still not a call", () => {
    expect(scanAgentCalls('agentic ("x", {}); agent_two("y", {})').length).toBe(0);
  });
});

describe("scanAgentCalls() — an optional call is still a call", () => {
  // Same class as the trivia hop above, one construct over: `agent?.("x", {})` is valid JS and a
  // genuine bare dispatch, and it used to scan to zero calls, which allows silently. Zero incidence
  // across the real scripts, but a false ALLOW is the exact hole this gate exists to close.
  test("agent?.( reads as a call and its opts are read", () => {
    expect(scanAgentCalls('agent?.("x", { label: "oc" })').map((c) => [c.line, c.label, c.hasModel]))
      .toEqual([[1, "oc", false]]);
  });

  test("an optional call that names a tier is satisfied like any other", () => {
    expect(scanAgentCalls('await agent?.("x", { model: "haiku" })').map((c) => [c.hasModel, c.model]))
      .toEqual([[true, "haiku"]]);
  });

  test("whitespace and comments around the ?. are stepped over too", () => {
    expect(scanAgentCalls('agent /*k*/ ?.\n("x", { label: "spaced" })').map((c) => [c.line, c.label]))
      .toEqual([[1, "spaced"]]);
  });

  test("an optional call on a different callee is still not this call", () => {
    expect(scanAgentCalls('obj?.agent("x", {}); agent?.run("y", {})').length).toBe(0);
  });

  test("a ternary on a variable named agent is not a call", () => {
    expect(scanAgentCalls('const k = agent ? ("a") : ("b")').length).toBe(0);
  });
});

describe("scanAgentCalls() — a definition named agent is not a dispatch", () => {
  // The false DENY, and the worse of the two defects: none of these spawns anything, and blocking a
  // construct the operator did nothing wrong to write is how a gate gets muted in settings.json.
  // The rule is parameter list versus argument list — see the DEFINITION LIMIT note in the hook.
  test("a function declaration is not a call", () => {
    expect(scanAgentCalls('function agent(prompt, opts) {}').length).toBe(0);
  });

  test("async, generator and export forms are not calls either", () => {
    expect(scanAgentCalls('async function agent(p) {}').length).toBe(0);
    expect(scanAgentCalls('function* agent(p) {}').length).toBe(0);
    expect(scanAgentCalls('async function* agent(p) {}').length).toBe(0);
    expect(scanAgentCalls('export function agent(p) {}').length).toBe(0);
  });

  test("a getter or setter is not a call", () => {
    expect(scanAgentCalls('class A { get agent() {} }').length).toBe(0);
    expect(scanAgentCalls('class A { set agent(v) {} }').length).toBe(0);
    expect(scanAgentCalls('const o = { get agent() { return 1 } }').length).toBe(0);
  });

  test("shorthand methods in an object literal and a class body are not calls", () => {
    expect(scanAgentCalls('const o = { agent(p, q) {} }').length).toBe(0);
    expect(scanAgentCalls('class A { agent(p) {} }').length).toBe(0);
    expect(scanAgentCalls('class A { static agent() {} }').length).toBe(0);
    expect(scanAgentCalls('class A { async agent() {} }').length).toBe(0);
  });

  test("the body may start on the next line", () => {
    expect(scanAgentCalls('function agent(p, o)\n{\n  return p\n}').length).toBe(0);
  });

  test("a script that defines agent and then calls it reports only the call", () => {
    const script = 'function agent(p, o) { return o }\nawait agent("x", { label: "real" })';
    expect(scanAgentCalls(script).map((c) => [c.line, c.label])).toEqual([[2, "real"]]);
  });

  test("a call inside a definition's parameter defaults is still a call", () => {
    expect(scanAgentCalls('function agent(p = agent("d", { label: "inner" })) {}').map((c) => c.label))
      .toEqual(["inner"]);
  });

  // DEFINITION LIMIT residue 1, a false allow: a call statement followed by a bare block statement
  // puts a `{` after the `)` and so reads as a definition. Legal JS, never written. Pinned so the
  // limit stays visible and any later attempt to tell the two apart has to move a test on purpose.
  test("a call followed by a bare block statement is misread as a definition", () => {
    expect(scanAgentCalls('agent("x", { label: "a" })\n{\n  const y = 1\n}').length).toBe(0);
  });

  // DEFINITION LIMIT residue 2, a false deny that cannot occur in the `.js` scripts this scanner
  // reads: a TypeScript overload signature has no body, so nothing distinguishes it from a call.
  test("a bodyless TypeScript-style signature still reads as a call", () => {
    expect(scanAgentCalls('function agent(p: string): void;').length).toBe(1);
  });

  // The definition rule is the one change that could plausibly break call-site recognition, so the
  // preserved shapes are pinned against it together rather than only in isolation above.
  test("the preserved shapes survive alongside a definition", () => {
    const script = [
      'function agent(p, o) {}',
      'subagent("a", {})',
      'thing.agent("b", {})',
      'agent ("c", { label: "sp" })',
      'agent',
      '("d", { label: "nl" })',
      'agent/*k*/("e", { label: "cm" })',
    ].join("\n");
    expect(scanAgentCalls(script).map((c) => [c.line, c.label]))
      .toEqual([[4, "sp"], [5, "nl"], [7, "cm"]]);
  });
});

describe("scanAgentCalls() — comments against templates", () => {
  test("a template inside a comment is never entered", () => {
    expect(scanAgentCalls('// const s = `x ${y}`\nawait agent("z", { label: "after" })').map((c) => c.line))
      .toEqual([2]);
  });

  test("comment markers inside template text are data, not comments", () => {
    const script = 'const s = `see // not a comment ${x} /* nor this */`;\nawait agent("z", {})';
    expect(scanAgentCalls(script).map((c) => [c.line, c.hasModel])).toEqual([[2, false]]);
  });

  test("a comment inside an interpolation is a real comment, so agent( in it is ignored", () => {
    const script = 'const s = `x ${ /* agent("nope",{}) */ y } z`;\nawait agent("q", { label: "real" })';
    expect(scanAgentCalls(script).map((c) => [c.line, c.label])).toEqual([[2, "real"]]);
  });
});

describe("scanAgentCalls() — escapes inside templates", () => {
  test("an escaped backtick does not close the template", () => {
    const script = 'const s = `a \\` b`;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).map((c) => c.line)).toEqual([2]);
  });

  test("an escaped dollar opens no interpolation, so its brace pops nothing", () => {
    const script = 'const s = `a \\${b} c`;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).map((c) => c.line)).toEqual([2]);
  });

  test("an escaped backslash lets the next backtick close the template", () => {
    const script = 'const s = `a \\\\`;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).map((c) => c.line)).toEqual([2]);
  });
});

describe("scanAgentCalls() — the regex-literal limit, pinned deliberately", () => {
  // The scanner does not lex regex literals, and the header says why: telling a regex opener from a
  // division sign needs preceding-token context, and a wrong guess swallows a region. Over the 51
  // real workflow scripts measured, regex handling changes the call count on zero of them. These
  // two pin the cost of that choice so it stays a stated limit rather than a surprise.
  test("division is not mistaken for a regex", () => {
    const script = 'const r = a / b; const s = "it\'s"; const t = c / d;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).map((c) => c.line)).toEqual([2]);
    expect(checkWorkflow({ script }, noRead).action).toBe("deny");
  });

  test("a regex containing a backtick opens a template that was never there, so the file allows", () => {
    const script = 'const re = /`/;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).length).toBe(0);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW); // stated limit, not intended behavior
  });

  test("a regex containing a quote does the same", () => {
    const script = 'const re = /[\'"]/;\nawait agent("z", { label: "after" })';
    expect(scanAgentCalls(script).length).toBe(0);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW); // stated limit, not intended behavior
  });

  // The two shapes an earlier draft of the header missed. Neither contains a quote or a backtick,
  // and both are worse than the two above, because what they open is a comment: the escaped slash
  // pairs with the next character and swallows a region rather than a delimiter-bounded span.
  test("an escaped slash before a star opens a block comment that eats the rest of the file", () => {
    const script = 'const re = /a\\/*b/;\nawait agent("x", { label: "r1" });\nawait agent("y", { label: "r2" });';
    expect(scanAgentCalls(script).length).toBe(0);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW); // stated limit, not intended behavior
  });

  // `/^https?:\/\//` is the commonest regex there is, and the trailing `\/` `/` reads as a line
  // comment, so a call on the same line after it disappears. A call on the next line survives.
  test("a URL regex hides a call on its own line but not the line after", () => {
    const same = 'const re = /^https?:\\/\\//; await agent("x", { label: "r3" });';
    expect(scanAgentCalls(same).length).toBe(0);
    expect(checkWorkflow({ script: same }, noRead)).toEqual(ALLOW); // stated limit, not intended
    const next = 'const re = /^https?:\\/\\//;\nawait agent("x", { label: "r4" });';
    expect(scanAgentCalls(next).map((c) => c.label)).toEqual(["r4"]);
    expect(checkWorkflow({ script: next }, noRead).action).toBe("deny");
  });
});

describe("scanAgentCalls() — cost is linear in source length", () => {
  // Not a micro-benchmark. An earlier draft re-lexed from every call site to end of file to find
  // that call's closing paren, which is quadratic: a 120KB unbalanced `agent(` storm took over 90
  // seconds and a 268KB script took 47. A hook that stalls past its timeout blocks every dispatch,
  // which is a worse failure than the scanning bug it was fixing, so termination is pinned here
  // rather than left to a reviewer noticing. The bound is ~100x the measured cost of each shape
  // (44ms, 29ms, 36ms on the authoring machine) so it fails on a return to quadratic and not on a
  // slow machine. The largest real workflow script is 45KB and scans in 0.7ms.
  const shapes: [string, string][] = [
    ["1MB unbalanced agent( storm", "agent(".repeat(175000)],
    ["nested balanced agent( to depth 80000", "agent(".repeat(80000) + '"x"' + ")".repeat(80000)],
    ["20000 interpolated fan-out call sites",
      Array.from({ length: 20000 }, (_, k) => `await agent(\`ssh \${h${k}} up\`, { label: \`p${k}\` });`).join("\n")],
  ];

  test.each(shapes)("%s scans in bounded time", (_name, src) => {
    const t0 = Date.now();
    expect(() => scanAgentCalls(src)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("scanAgentCalls() — malformed input neither throws nor hangs", () => {
  test("an unterminated template allows rather than inventing a call", () => {
    const script = 'await agent(`ssh ${h} uptime, { label: "one" });\nawait agent("b", {})';
    expect(() => scanAgentCalls(script)).not.toThrow();
    expect(scanAgentCalls(script).length).toBe(0);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW);
  });

  test("an unterminated block comment swallows the rest of the file, so it allows", () => {
    const script = '/* agent("a", {})\nawait agent("b", { label: "two" })';
    expect(scanAgentCalls(script).length).toBe(0);
    expect(checkWorkflow({ script }, noRead)).toEqual(ALLOW);
  });

  test("interpolation nested past the frame cap allows instead of running away", () => {
    const deep = "`${".repeat(5000) + 'await agent("a", {})';
    expect(() => scanAgentCalls(deep)).not.toThrow();
    expect(scanAgentCalls(deep)).toEqual([]);
    expect(checkWorkflow({ script: deep }, noRead)).toEqual(ALLOW);
  });

  test("a long run of unclosed delimiters terminates", () => {
    const junk = "`${'\"/*".repeat(20000);
    expect(() => scanAgentCalls(junk)).not.toThrow();
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

  // Written out by hand rather than derived from VALID_TIERS. A case list built by filtering the
  // constant under test deletes its own case when a value is deleted from the constant, which is
  // how a mutation audit found this suite staying green through exactly that deletion. The four
  // names below are the contract; the equality case beneath them fails if the constant and this
  // list ever disagree in either direction.
  test.each(["haiku", "sonnet", "opus", "fable"])("%s is accepted as a tier", (model) => {
    expect(checkAgent({ prompt: "go", model })).toEqual(ALLOW);
  });

  test("the accepted tiers are exactly those four", () => {
    expect(VALID_TIERS).toEqual(["haiku", "sonnet", "opus", "fable"]);
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

describe("checkAgent() — effort is not judged", () => {
  // This gate used to deny any sonnet dispatch that did not also state effort: "xhigh". The Agent
  // tool's input schema carries no `effort` parameter, so on the path this hook fires on most
  // often that denial had no legal answer: the only way past it was to escalate to a premium tier,
  // inverting the quality-per-dollar the rule was written to protect. Operator directive
  // 2026-09-05 dropped the mandate. Every effort value is now the dispatcher's call.
  test("sonnet with no effort allows", () => {
    expect(checkAgent({ prompt: "go", model: "sonnet" })).toEqual(ALLOW);
  });

  test("sonnet at xhigh allows", () => {
    expect(checkAgent({ prompt: "go", model: "sonnet", effort: "xhigh" })).toEqual(ALLOW);
  });

  test("sonnet at a lower effort allows", () => {
    expect(checkAgent({ prompt: "go", model: "sonnet", effort: "low" })).toEqual(ALLOW);
  });

  test("haiku and opus are unaffected", () => {
    expect(checkAgent({ prompt: "go", model: "haiku" })).toEqual(ALLOW);
    expect(checkAgent({ prompt: "go", model: "opus", effort: "low" })).toEqual(ALLOW);
  });

  // The half of the rule that survives, and the half that is satisfiable on every surface. Stated
  // here as well as under "a dispatch has to name a tier" because dropping one clause of a
  // two-clause rule is exactly when the other clause gets dropped by accident.
  test("stating an effort is not a substitute for stating a tier", () => {
    const verdict = checkAgent({ prompt: "go", effort: "xhigh" });
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain("inherits the session model");
  });
});

// ---------------------------------------------------------------------------
// Definition pins (#258). A dispatch with no `model` parameter is allowed when the definition it
// names pins an exact model ID that this machine's tier map lists, because Claude Code then runs it
// on that ID rather than on the session model. Everything short of that keeps the deny.
// ---------------------------------------------------------------------------

/** A definition file with the given frontmatter lines between the fences. */
function defText(...lines: string[]): string {
  return ["---", ...lines, "---", "Body text.", ""].join("\n");
}

/** A typical def: name, description, and a model line unless `model` is null. */
function def(name: string, model: string | null): string {
  return defText(`name: ${name}`, "description: d", ...(model === null ? [] : [`model: ${model}`]));
}

/** checkAgent's lookup over an in-memory map from agent name to definition text. */
function lookupFrom(defs: Record<string, string>) {
  return (name: string) => defs[name] ?? null;
}

/** The IDs the tier map on the machine behind #258 lists. */
const MAP_IDS: ReadonlySet<string> = new Set(["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"]);

/** That machine's tier map, as the file holds it. */
const MAP_TEXT = JSON.stringify({
  tiers: { sonnet: "claude-sonnet-5", opus: "claude-opus-5-5", haiku: "claude-haiku-4-5-20251001" },
});

describe("parseTierMap() — the machine-local allowlist of pinnable IDs", () => {
  test("a map lists its values", () => {
    expect(parseTierMap(MAP_TEXT)).toEqual(new Set(MAP_IDS));
  });

  test("an empty tiers object lists nothing", () => {
    expect(parseTierMap('{"tiers":{}}')).toEqual(new Set());
  });

  // Room for the billing-aware role map #249 asks for, in the same file.
  test("top-level keys other than tiers are ignored", () => {
    expect(parseTierMap('{"tiers":{"opus":"claude-opus-5"},"roles":{"coordinator":"opus"}}'))
      .toEqual(new Set(["claude-opus-5"]));
  });

  // One bad entry voids the whole map, so a typo shows up as a deny rather than as a narrower
  // allowlist nobody notices.
  test("a key that is not a tier voids the map", () => {
    expect(parseTierMap('{"tiers":{"sonnet":"claude-sonnet-5","sonet":"claude-sonnet-5"}}')).toBeNull();
  });

  test("a value that is not an exact ID voids the map", () => {
    for (const v of ['"sonnet"', '"inherit"', '""', "5", "null", '["claude-sonnet-5"]', '"claude-opus-4-8[1m]"']) {
      expect(parseTierMap(`{"tiers":{"sonnet":"claude-sonnet-5","opus":${v}}}`)).toBeNull();
    }
  });

  test("a document that is not a map with a tiers object is void", () => {
    for (const text of ["", "not json", "[]", "null", '"x"', "{}", '{"tiers":[]}', '{"tiers":null}', '{"tiers":"x"}']) {
      expect(parseTierMap(text)).toBeNull();
    }
  });

  test("the map's file name is the one the .local convention keeps out of exports", () => {
    expect(TIER_MAP_FILE).toBe("tier-map.local.json");
  });
});

describe("pinnedModel() — what counts as an exact pin", () => {
  test("an exact model ID is a pin", () => {
    expect(pinnedModel(def("w", "claude-sonnet-5"), "w")).toBe("claude-sonnet-5");
    expect(pinnedModel(def("w", "claude-opus-5"), "w")).toBe("claude-opus-5");
    expect(pinnedModel(def("w", "claude-haiku-4-5-20251001"), "w")).toBe("claude-haiku-4-5-20251001");
  });

  test("a quoted exact ID is the same pin, since YAML strips the quotes", () => {
    expect(pinnedModel(def("w", '"claude-sonnet-5"'), "w")).toBe("claude-sonnet-5");
    expect(pinnedModel(def("w", "'claude-sonnet-5'"), "w")).toBe("claude-sonnet-5");
  });

  test("CRLF line endings read the same as LF", () => {
    expect(pinnedModel(def("w", "claude-sonnet-5").replace(/\n/g, "\r\n"), "w")).toBe("claude-sonnet-5");
  });

  test("a leading byte order mark is ignored, as YAML ignores it", () => {
    expect(pinnedModel(String.fromCharCode(0xfeff) + def("w", "claude-sonnet-5"), "w")).toBe("claude-sonnet-5");
  });

  // The aliases resolve through the same table the Agent tool's parameter does, which is the table
  // #258 found stuck on the previous generation. A def naming one pins nothing.
  test.each(["sonnet", "opus", "haiku", "fable"])("the alias %s is not a pin", (alias) => {
    expect(pinnedModel(def("w", alias), "w")).toBeNull();
  });

  test("inherit is not a pin", () => {
    expect(pinnedModel(def("w", "inherit"), "w")).toBeNull();
  });

  test("an absent or empty model is not a pin", () => {
    expect(pinnedModel(def("w", null), "w")).toBeNull();
    expect(pinnedModel(def("w", ""), "w")).toBeNull();
    expect(pinnedModel(def("w", '""'), "w")).toBeNull();
  });

  test("a value outside the exact-ID shape is not a pin", () => {
    for (const v of ["Claude-Sonnet-5", "claude-", "claude--5", "claude-sonnet-5-", "gpt-5", "claude-opus-4-8[1m]",
      "claude-sonnet-5 # pinned", "claude_sonnet_5"]) {
      expect(pinnedModel(def("w", v), "w")).toBeNull();
    }
  });

  // YAML needs a space after a mapping key's colon. Without one the line is a plain scalar, not a
  // model key, and reading it as one would invent a pin the platform never sees.
  test("a key whose colon has no space after it is not a key", () => {
    expect(pinnedModel(defText("name: w", "model:claude-sonnet-5"), "w")).toBeNull();
  });

  // Claude Code identifies a def by its `name:` field, not its filename. A file found at w.md that
  // declares another name is not the def a dispatch of "w" runs.
  test("a def whose name field is not the dispatched type is not a pin", () => {
    expect(pinnedModel(def("other", "claude-sonnet-5"), "w")).toBeNull();
    expect(pinnedModel(defText("description: d", "model: claude-sonnet-5"), "w")).toBeNull();
  });

  // Ambiguous to this reader, and a YAML parser may resolve it either way, so it fails closed.
  test("a duplicated model or name key is not a pin", () => {
    expect(pinnedModel(defText("name: w", "model: claude-sonnet-5", "model: inherit"), "w")).toBeNull();
    expect(pinnedModel(defText("name: w", "name: x", "model: claude-sonnet-5"), "w")).toBeNull();
  });

  // A lone CR is a YAML line break. Splitting on LF alone would leave a second model key hidden
  // inside the description's value, so the clean model line below would read as the only one.
  test("a lone CR is a line break, so a key hidden behind one still counts", () => {
    const text = "---\nname: w\ndescription: d\rmodel: inherit\nmodel: claude-sonnet-5\n---\n";
    expect(pinnedModel(text, "w")).toBeNull();
  });

  test("malformed frontmatter is not a pin", () => {
    expect(pinnedModel("name: w\nmodel: claude-sonnet-5\n", "w")).toBeNull(); // no fences
    expect(pinnedModel("---\nname: w\nmodel: claude-sonnet-5\n", "w")).toBeNull(); // unclosed
    expect(pinnedModel("", "w")).toBeNull();
    expect(pinnedModel("\n---\nname: w\nmodel: claude-sonnet-5\n---\n", "w")).toBeNull(); // not at byte 0
  });

  test("an indented model key belongs to something nested and is not the def's model", () => {
    expect(pinnedModel(defText("name: w", "meta:", "  model: claude-sonnet-5"), "w")).toBeNull();
  });

  // pinnedModel reads shape only. Whether the account is served the ID is the tier map's question,
  // which is why checkAgent below denies this same pin when the map does not list it.
  test("an ID of the right shape reads as a pin whether or not it is served", () => {
    expect(pinnedModel(def("w", "claude-sonnet-5-5"), "w")).toBe("claude-sonnet-5-5");
  });
});

describe("checkAgent() — a definition that pins an exact model ID", () => {
  test("no model parameter, def pins an ID the map lists: allowed", () => {
    const lookup = lookupFrom({ sonnet5: def("sonnet5", "claude-sonnet-5") });
    expect(checkAgent({ prompt: "go", subagent_type: "sonnet5" }, lookup, MAP_IDS)).toEqual(ALLOW);
  });

  // The constraint from #258's review: an arbitrary exact pin must still deny. claude-sonnet-5-5 is
  // the measured case, well formed and not served to that account, where it falls back silently to
  // the parent session model. Probe an ID before pinning it.
  test("no model parameter, def pins an exact ID the map does not list: denied", () => {
    const lookup = lookupFrom({ w: def("w", "claude-sonnet-5-5") });
    const verdict = checkAgent({ prompt: "go", subagent_type: "w" }, lookup, MAP_IDS);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain(TIER_MAP_FILE);
  });

  test("no model parameter, exact-ID def, but no map: denied", () => {
    const lookup = lookupFrom({ sonnet5: def("sonnet5", "claude-sonnet-5") });
    expect(checkAgent({ prompt: "go", subagent_type: "sonnet5" }, lookup, new Set()).action).toBe("deny");
    expect(checkAgent({ prompt: "go", subagent_type: "sonnet5" }, lookup).action).toBe("deny");
  });

  test("no model parameter, alias def: denied, and the reason names the definition option", () => {
    const lookup = lookupFrom({ worker: def("worker", "sonnet") });
    const verdict = checkAgent({ prompt: "go", subagent_type: "worker" }, lookup, MAP_IDS);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("inherits the session model");
      expect(verdict.reason).toContain("exact model ID");
      expect(verdict.reason).toContain(".local.md");
    }
  });

  test("no model parameter, inherit def: denied", () => {
    const lookup = lookupFrom({ worker: def("worker", "inherit") });
    expect(checkAgent({ prompt: "go", subagent_type: "worker" }, lookup, MAP_IDS).action).toBe("deny");
  });

  test("no model parameter, no def found: denied", () => {
    expect(checkAgent({ prompt: "go", subagent_type: "nowhere" }, lookupFrom({}), MAP_IDS).action).toBe("deny");
  });

  test("no subagent_type at all: denied without a lookup", () => {
    let looked = false;
    const verdict = checkAgent(
      { prompt: "go" },
      () => { looked = true; return def("x", "claude-sonnet-5"); },
      MAP_IDS,
    );
    expect(verdict.action).toBe("deny");
    expect(looked).toBe(false);
  });

  // The exemption fails closed. A lookup that throws must leave today's deny in place, never fall
  // through to the entrypoint's fail-open catch, which would turn an unreadable def into an allow.
  test("a lookup that throws, as an unreadable file does: denied", () => {
    const verdict = checkAgent(
      { prompt: "go", subagent_type: "sonnet5" },
      () => { throw new Error("EACCES: permission denied"); },
      MAP_IDS,
    );
    expect(verdict.action).toBe("deny");
  });

  test("malformed frontmatter in the def: denied", () => {
    const lookup = lookupFrom({ sonnet5: "---\nname: sonnet5\nmodel: claude-sonnet-5\n" });
    expect(checkAgent({ prompt: "go", subagent_type: "sonnet5" }, lookup, MAP_IDS).action).toBe("deny");
  });

  // Plugin-scoped names carry a colon and resolve outside .claude/agents, and anything that is not
  // a plain name could walk out of the agents directory. Neither is ever handed to the lookup.
  test.each(["plugin:worker", "../sonnet5", "a/b", "a\\b", "-x", "", "."])(
    "the name %p is denied without a lookup",
    (name) => {
      let looked = false;
      const verdict = checkAgent(
        { prompt: "go", subagent_type: name },
        () => { looked = true; return def(name, "claude-sonnet-5"); },
        MAP_IDS,
      );
      expect(verdict.action).toBe("deny");
      expect(looked).toBe(false);
    },
  );

  // Unchanged behavior, restated beside the new path because a passed parameter outranks the def.
  test("an explicit tier still allows, whatever the def says", () => {
    const lookup = lookupFrom({ worker: def("worker", "inherit") });
    expect(checkAgent({ prompt: "go", subagent_type: "worker", model: "haiku" }, lookup, MAP_IDS)).toEqual(ALLOW);
  });

  test("an explicit non-tier is still denied, even when the map lists it", () => {
    const lookup = lookupFrom({ sonnet5: def("sonnet5", "claude-sonnet-5") });
    const verdict = checkAgent({ prompt: "go", subagent_type: "sonnet5", model: "claude-sonnet-5" }, lookup, MAP_IDS);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.reason).toContain("not a tier this project accepts");
  });

  test("fork is still exempt and is never looked up", () => {
    let looked = false;
    const verdict = checkAgent({ prompt: "go", subagent_type: "fork" }, () => { looked = true; return null; }, MAP_IDS);
    expect(verdict).toEqual(ALLOW);
    expect(looked).toBe(false);
  });

  // The escape hatch is untouched. It allows a model-less dispatch whatever its definition holds,
  // and the bare token still does not.
  test("a reasoned override still allows beside an alias def, and a bare token still does not", () => {
    const lookup = lookupFrom({ worker: def("worker", "sonnet") });
    expect(checkAgent({ prompt: `${OVERRIDE_TOKEN} probe`, subagent_type: "worker" }, lookup, MAP_IDS)).toEqual(ALLOW);
    expect(checkAgent({ prompt: OVERRIDE_TOKEN, subagent_type: "worker" }, lookup, MAP_IDS).action).toBe("deny");
  });
});

// A fake filesystem under two absolute roots. Paths are built with the same join() the gate uses,
// so the keys match on both Windows and POSIX runners.
const REPO = resolve("/fake/repo");
const HOME = resolve("/fake/home");
const MAP_PATH = join(HOME, ".claude", TIER_MAP_FILE);
const agentsIn = (dir: string, name: string) => join(dir, ".claude", "agents", `${name}.md`);
const localIn = (dir: string, name: string) => join(dir, ".claude", "agents", `${name}.local.md`);

/** In-memory files plus the tier map, unless `map` is null. */
function fakeSource(
  files: Record<string, string>,
  map: string | null = MAP_TEXT,
  markers: string[] = [join(REPO, ".git")],
): DefSource {
  const all = map === null ? files : { [MAP_PATH]: map, ...files };
  return {
    home: HOME,
    read: (p) => all[p] ?? null,
    exists: (p) => p in all || markers.includes(p),
  };
}

function agentPayload(cwd: string | undefined, tool_input: Record<string, unknown>) {
  return { tool_name: "Agent", ...(cwd === undefined ? {} : { cwd }), tool_input };
}

describe("agentDefDirs() — where a definition is looked for", () => {
  test("from the repo root: the project agents dir, then the user one", () => {
    expect(agentDefDirs(REPO, HOME, fakeSource({}).exists)).toEqual([
      join(REPO, ".claude", "agents"),
      join(HOME, ".claude", "agents"),
    ]);
  });

  // Claude Code walks up from the working directory to the repository root and the closest def wins.
  test("from a subdirectory: every level up to and including the repo root, closest first", () => {
    const cwd = join(REPO, "pkg", "sub");
    expect(agentDefDirs(cwd, HOME, fakeSource({}).exists)).toEqual([
      join(REPO, "pkg", "sub", ".claude", "agents"),
      join(REPO, "pkg", ".claude", "agents"),
      join(REPO, ".claude", "agents"),
      join(HOME, ".claude", "agents"),
    ]);
  });
});

describe("decide() — the tier map and the definition lookup", () => {
  const sonnet5 = { prompt: "go", subagent_type: "sonnet5" };

  test("a user .local.md def pinning a mapped ID allows", () => {
    const src = fakeSource({ [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5") });
    expect(decide(agentPayload(REPO, sonnet5), noRead, src)).toEqual(ALLOW);
  });

  test("a project def pinning a mapped ID allows", () => {
    const src = fakeSource({ [agentsIn(REPO, "sonnet5")]: def("sonnet5", "claude-sonnet-5") });
    expect(decide(agentPayload(REPO, sonnet5), noRead, src)).toEqual(ALLOW);
  });

  test("with no tier map, the same def denies", () => {
    const src = fakeSource({ [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5") }, null);
    expect(decide(agentPayload(REPO, sonnet5), noRead, src).action).toBe("deny");
  });

  test("with a void tier map, the same def denies", () => {
    const src = fakeSource({ [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5") }, "{not json");
    expect(decide(agentPayload(REPO, sonnet5), noRead, src).action).toBe("deny");
  });

  test("a map the reader cannot read denies rather than throwing past the gate", () => {
    const src: DefSource = {
      home: HOME,
      read: (p) => {
        if (p === MAP_PATH) throw new Error("EACCES: permission denied");
        return p === localIn(HOME, "sonnet5") ? def("sonnet5", "claude-sonnet-5") : null;
      },
      exists: (p) => p === join(REPO, ".git"),
    };
    expect(decide(agentPayload(REPO, sonnet5), noRead, src).action).toBe("deny");
  });

  test("a def pinning an ID the map does not list denies", () => {
    const src = fakeSource({ [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5-5") });
    expect(decide(agentPayload(REPO, sonnet5), noRead, src).action).toBe("deny");
  });

  // Both files would declare the same name in one directory, and which one Claude Code loads is
  // not something the files show. Ambiguous denies, whichever of the two carries the pin.
  test("a .md and a .local.md for one name in one directory deny", () => {
    const localPinned = fakeSource({
      [agentsIn(HOME, "sonnet5")]: def("sonnet5", "sonnet"),
      [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5"),
    });
    expect(decide(agentPayload(REPO, sonnet5), noRead, localPinned).action).toBe("deny");
    const sharedPinned = fakeSource({
      [agentsIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5"),
      [localIn(HOME, "sonnet5")]: def("sonnet5", "inherit"),
    });
    expect(decide(agentPayload(REPO, sonnet5), noRead, sharedPinned).action).toBe("deny");
  });

  // Shadowing, in both directions. The project def is the one Claude Code runs, so it decides.
  test("a project alias def shadows a user def pinning a mapped ID: denied", () => {
    const src = fakeSource({
      [agentsIn(REPO, "sonnet5")]: def("sonnet5", "sonnet"),
      [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5"),
    });
    expect(decide(agentPayload(REPO, sonnet5), noRead, src).action).toBe("deny");
  });

  test("a project def pinning a mapped ID shadows a user alias def: allowed", () => {
    const src = fakeSource({
      [agentsIn(REPO, "sonnet5")]: def("sonnet5", "claude-sonnet-5"),
      [agentsIn(HOME, "sonnet5")]: def("sonnet5", "inherit"),
    });
    expect(decide(agentPayload(REPO, sonnet5), noRead, src)).toEqual(ALLOW);
  });

  // The case a cwd-only lookup gets wrong in the dangerous direction: from a subdirectory it misses
  // the repo-root def Claude Code actually runs and allows on the user def behind it.
  test("from a subdirectory, a repo-root inherit def still shadows a user def pinning a mapped ID", () => {
    const src = fakeSource({
      [agentsIn(REPO, "sonnet5")]: def("sonnet5", "inherit"),
      [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5"),
    });
    expect(decide(agentPayload(join(REPO, "pkg"), sonnet5), noRead, src).action).toBe("deny");
  });

  test("a def above the repo root is outside the project search", () => {
    const src = fakeSource({ [agentsIn(resolve("/fake"), "sonnet5")]: def("sonnet5", "claude-sonnet-5") });
    expect(decide(agentPayload(REPO, sonnet5), noRead, src).action).toBe("deny");
  });

  test("no def anywhere: denied", () => {
    expect(decide(agentPayload(REPO, sonnet5), noRead, fakeSource({})).action).toBe("deny");
  });

  test("a read error on the project def denies rather than falling through to the user def", () => {
    const src: DefSource = {
      home: HOME,
      read: (p) => {
        if (p === MAP_PATH) return MAP_TEXT;
        if (p === agentsIn(REPO, "sonnet5")) throw new Error("EACCES: permission denied");
        return p === localIn(HOME, "sonnet5") ? def("sonnet5", "claude-sonnet-5") : null;
      },
      exists: (p) => p === join(REPO, ".git"),
    };
    expect(decide(agentPayload(REPO, sonnet5), noRead, src).action).toBe("deny");
  });

  // Without a working directory the project search cannot run, so whether a project def shadows
  // the user one is unknown. Unknown denies.
  test("a payload with no cwd, or a relative one, denies", () => {
    const src = fakeSource({ [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5") });
    expect(decide(agentPayload(undefined, sonnet5), noRead, src).action).toBe("deny");
    expect(decide(agentPayload("relative/dir", sonnet5), noRead, src).action).toBe("deny");
  });

  test("with no definition source supplied, decide denies a model-less dispatch as before", () => {
    expect(decide(agentPayload(REPO, sonnet5)).action).toBe("deny");
  });

  test("Task routes through the same lookup", () => {
    const src = fakeSource({ [localIn(HOME, "sonnet5")]: def("sonnet5", "claude-sonnet-5") });
    expect(decide({ tool_name: "Task", cwd: REPO, tool_input: sonnet5 }, noRead, src)).toEqual(ALLOW);
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

  test("a script that only defines a helper named agent allows", () => {
    expect(
      checkWorkflow({ script: 'function agent(prompt, opts) { return run(prompt, opts) }\nawait other()' }, noRead),
    ).toEqual(ALLOW);
  });

  test("a bare optional call denies and names its line", () => {
    const verdict = checkWorkflow({ script: 'await agent?.("a", { label: "oc" })' }, noRead);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("line 1");
      expect(verdict.reason).toContain("oc");
    }
  });

  // Claimed as covered by the characterization pass and in fact never asserted anywhere. A fan-out
  // is exactly where the list gets long, and now that interpolated prompts are visible the lists
  // got longer, so the truncation is load-bearing rather than decorative.
  test("more than twelve bare calls are truncated with a count of the rest", () => {
    const script = Array.from({ length: 15 }, (_, k) => `await agent(\`ssh \${h${k}}\`, { label: "p${k}" })`).join("\n");
    const verdict = checkWorkflow({ script }, noRead);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("15 of 15 agent() calls name no model");
      expect(verdict.reason).toContain("p11");
      expect(verdict.reason).not.toContain("p12");
      expect(verdict.reason).toContain("... and 3 more");
    }
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

describe("checkWorkflow() — effort is not judged per call site either", () => {
  // Workflow's agent() does accept an effort, unlike the Agent tool, so the dropped mandate was
  // satisfiable here and nowhere else. It goes anyway: one rule, one behaviour on both surfaces.
  test("a sonnet call with no effort allows", () => {
    expect(checkWorkflow({ script: `await agent("a",{model:"sonnet"})` }, noRead)).toEqual(ALLOW);
  });

  test("a sonnet call at a lower effort allows", () => {
    expect(checkWorkflow({ script: `await agent("a",{model:"sonnet",effort:"low"})` }, noRead)).toEqual(ALLOW);
  });

  test("mixing tiers and efforts allows", () => {
    expect(
      checkWorkflow(
        { script: `await agent("a",{model:"haiku"}); await agent("b",{model:"sonnet",effort:"xhigh"})` },
        noRead,
      ),
    ).toEqual(ALLOW);
  });

  test("a bare call beside a sonnet one still denies, and names only the bare one", () => {
    const verdict = checkWorkflow(
      { script: `await agent("a",{model:"sonnet",label:"tiered"});\nawait agent("b",{label:"bare"})` },
      noRead,
    );
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("1 of 2 agent() calls name no model");
      expect(verdict.reason).toContain("line 2");
      expect(verdict.reason).toContain("bare");
      expect(verdict.reason).not.toContain("line 1");
    }
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
function runHook(stdinText: string, env?: Record<string, string | undefined>) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, HOOK],
    stdin: new TextEncoder().encode(stdinText),
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
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

  // Was "sonnet without effort xhigh exits 2" until the mandate was dropped. Kept as a spawned
  // case rather than deleted: this gate's whole failure mode is a silent no-op, and the pure
  // checkAgent() case above cannot tell an allow from a hook that never ran.
  test("sonnet without an effort exits 0 and says nothing", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Agent",
        tool_input: { description: "d", prompt: "do a thing", model: "sonnet" },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  // The definition lookup reads real files from the payload's cwd and from the home directory, and
  // the pure cases above inject both. These run the entrypoint against a real tree, with HOME and
  // USERPROFILE pointed at a temp dir so the runner's own ~/.claude is never read. `userDefs` keys
  // are file names under the temp home's .claude/agents.
  describe("against agent definitions on disk", () => {
    function withTree(
      userDefs: Record<string, string>,
      map: string | null,
      body: (cwd: string, env: Record<string, string>) => void,
    ) {
      const root = mkdtempSync(join(tmpdir(), "model-tier-gate-defs-"));
      try {
        const home = join(root, "home");
        const project = join(root, "project");
        mkdirSync(join(home, ".claude", "agents"), { recursive: true });
        mkdirSync(join(project, ".git"), { recursive: true });
        if (map !== null) writeFileSync(join(home, ".claude", TIER_MAP_FILE), map);
        for (const [file, text] of Object.entries(userDefs)) {
          writeFileSync(join(home, ".claude", "agents", file), text);
        }
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
        env.HOME = home;
        env.USERPROFILE = home;
        body(project, env);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const dispatch = (cwd: string, subagent_type: string) =>
      JSON.stringify({ tool_name: "Agent", cwd, tool_input: { description: "d", prompt: "go", subagent_type } });

    test("a model-less dispatch of a .local.md def pinning a mapped ID exits 0 and says nothing", () => {
      withTree({ "sonnet5.local.md": def("sonnet5", "claude-sonnet-5") }, MAP_TEXT, (cwd, env) => {
        const result = runHook(dispatch(cwd, "sonnet5"), env);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      });
    });

    test("the same def with no tier map on disk exits 2", () => {
      withTree({ "sonnet5.local.md": def("sonnet5", "claude-sonnet-5") }, null, (cwd, env) => {
        const result = runHook(dispatch(cwd, "sonnet5"), env);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("does not state a model tier");
      });
    });

    test("a def pinning an exact ID the map does not list exits 2", () => {
      withTree({ "w.local.md": def("w", "claude-sonnet-5-5") }, MAP_TEXT, (cwd, env) => {
        const result = runHook(dispatch(cwd, "w"), env);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain(TIER_MAP_FILE);
      });
    });

    test("a model-less dispatch of a user def naming an alias exits 2 and names the option", () => {
      withTree({ "aliased.md": def("aliased", "sonnet") }, MAP_TEXT, (cwd, env) => {
        const result = runHook(
          JSON.stringify({ tool_name: "Agent", cwd, tool_input: { description: "d", prompt: "go", subagent_type: "aliased" } }),
          env,
        );
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("does not state a model tier");
        expect(result.stderr).toContain("exact model ID");
      });
    });
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
