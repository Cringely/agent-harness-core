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
