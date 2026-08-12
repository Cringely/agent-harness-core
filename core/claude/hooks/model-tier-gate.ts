// PreToolUse hook (matcher: Agent|Task|Workflow) — the model-tier gate.
//
// Delegation rules have said for a long time that mechanical fetch-and-report work belongs on the
// cheap tier and that premium tiers are for judgment. The rule is prose, so it gets skipped
// silently rather than loudly. The failure this closes is not picking the wrong tier. It is not
// picking at all: a dispatch with no `model` inherits the session model, and an inherited default
// is indistinguishable from a decision once the run starts. Nothing in the transcript says "this
// agent is on the premium tier"; it just is.
//
// So this gate does NOT try to decide the right tier. That is judgment, and a guard that
// misclassifies a prompt produces false blocks, which is how a guard gets muted. It denies only
// the dispatch that names no tier at all. Naming one costs a single word and converts a wrong tier
// into a visible choice someone can argue with in review.
//
// Three checks:
//   1. An Agent/Task dispatch with no `model` denies. `subagent_type: "fork"` is exempt, because a
//      fork inherits the parent model by design and ignores a model override, so demanding the
//      field would be asking for a value with no effect.
//   2. A Workflow whose script contains `agent()` calls with no `model`, or with a model that is
//      not one of the accepted tiers, denies and names the offending call sites by line and label.
//      This check under-reports on one script shape, so read a clean verdict on a workflow as
//      "nothing found" rather than "nothing there". The scanner leaves template-literal mode at
//      `${` and never re-enters it, which makes the template's closing backtick read as an opening
//      quote. A call whose prompt is an interpolated template is invisible, and so is every call
//      after it up to the next backtick or the end of the file. Fan-out scripts that build prompts
//      by interpolation are where that bites. Both shapes are pinned by cases in
//      test/model-tier-gate.test.ts as a known gap, so a later change to the walk cannot widen it
//      unnoticed.
//   3. Any agent on `sonnet` without `effort: "xhigh"` denies. Sonnet gets chosen for work that
//      needs real reasoning at a lower price, and inherited effort throws away the reason it was
//      chosen. The other tiers set effort by judgment; sonnet does not get a choice.
//
// MATCHER NOTE, and the part of it that is not verified. "Agent" and "Task" are observed tool
// names: agent-worktree-gate.ts in this same directory registers on `Agent|Task`, and Task is the
// older name for the same dispatch. "Workflow" is INFERRED from prose in the tool description, and
// no hook payload with `tool_name: "Workflow"` has ever been captured here to confirm it. If the
// real tool name differs, the Workflow branch below is inert rather than wrong: an unrecognised
// tool falls through to allow, so nothing breaks and nothing is protected. Treat that branch as
// untested against a live payload, not as precedent for a name anyone has seen.
//
// ESCAPE HATCH. `MODEL-OVERRIDE: <reason>` in the agent prompt, or anywhere in a workflow script,
// allows unconditionally. The reason text is required to be non-empty but is not judged, matching
// `ISOLATION-OVERRIDE:` in agent-worktree-gate.ts: the safeguard is that the override is written
// down and visible in the transcript, not that a regex can grade it. A gate with no in-band bypass
// gets muted in settings.json instead, silently, the first time it is wrong.
//
// WIRE CONTRACT, and where it differs from its siblings. A deny prints its reason on stderr and
// exits 2, which Claude Code reads as "block and hand the reason back to the model".
// agent-worktree-gate.ts and review-gate.ts instead exit 0 and emit a `hookSpecificOutput` deny on
// stdout. Both forms block; this one is kept because it is the form that was verified live against
// this gate's own payloads before promotion, and because it is the form test/model-tier-gate.test.ts
// asserts on. The code shape is otherwise the siblings': a pure exported `decide()` returning a
// `GateDecision`, with the process entrypoint behind `import.meta.main` so tests can import the
// decision logic without spawning anything.
//
// FAIL-OPEN CONTRACT. Malformed stdin, an unreadable `scriptPath`, unbalanced script source, an
// unrecognised tool name, and a script with zero `agent()` calls all allow. So does a scanned
// `model:` whose value the scanner cannot read as a plain short literal, a variable reference or a
// string past twenty characters being the usual causes: the call still counts as having named a
// tier, and the tier and effort checks are skipped for it rather than guessed at. A broken gate must
// never block real work. The error path logs one line to stderr and exits 0, which Claude Code
// reads as no opinion, so a gate that has stopped working is visible to an operator rather than
// invisibly absent.

import { readFileSync } from "node:fs";

/** Tiers this project accepts as an answer to "which model". */
export const VALID_TIERS = ["haiku", "sonnet", "opus", "fable"];

/**
 * Tiers whose effort is not a judgment call. One entry today, so it stays a lookup rather than a
 * policy engine or a templated config file; if per-tier policy grows past a couple of rows it wants
 * to become data the installer can template per project.
 */
const MANDATED_EFFORT: Record<string, string> = { sonnet: "xhigh" };

/** Conscious in-band bypass. See the header's ESCAPE HATCH note. */
export const OVERRIDE_TOKEN = "MODEL-OVERRIDE:";
const OVERRIDE_RE = /MODEL-OVERRIDE:[ \t]*\S/;

const RULE = [
  "Tiering rule: any fetch-and-report job (listing, tailing, grepping, running a build or a test,",
  'checking a service, collecting a diff, querying an API) gets model: "haiku". Reserve the premium',
  "tiers for judgment work: review, architecture, arbitration, synthesis across several agents.",
  "A search agent is judgment despite looking mechanical, because choosing search breadth is not",
  "fetching.",
  "",
  'A sonnet agent always runs effort: "xhigh". Sonnet gets picked for work that needs real reasoning',
  "at a lower price, and running it at inherited effort throws away the reason it was picked. The",
  "other tiers set effort by judgment; sonnet does not get a choice.",
  "",
  "See the model-tier row in the rule catalog in guardrails.md.",
].join("\n");

export type GateDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

const ALLOW: GateDecision = { action: "allow" };

function hasOverride(text: unknown): boolean {
  return typeof text === "string" && OVERRIDE_RE.test(text);
}

/** The effort complaint for a tier whose effort is mandated, or null when there is none. */
export function effortViolation(model: string, effort: string): string | null {
  const required = MANDATED_EFFORT[model];
  if (!required) return null;
  if (effort === required) return null;
  return effort
    ? `model "${model}" must run effort: "${required}", not "${effort}"`
    : `model "${model}" must state effort: "${required}" (omitted, so it inherits session effort)`;
}

// ---------------------------------------------------------------------------
// Scanning a workflow script for agent() calls that never name a tier.
//
// Regex alone is wrong here. `agent(` appears inside string literals and comments in these scripts,
// and this file's own block message would trip a naive matcher. So walk the source once, tracking
// quote and comment state, and bracket-match each call to get its true extent.
// ---------------------------------------------------------------------------

export interface AgentCall {
  line: number;
  hasModel: boolean;
  model: string;
  effort: string;
  label: string;
}

export function scanAgentCalls(src: string): AgentCall[] {
  const calls: AgentCall[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  // Walk with explicit state rather than a tokenizer. Only four states matter for finding a call
  // site: plain code, a quoted string in three flavours, and the two comment forms.
  while (i < n) {
    const c = src[i];

    if (c === "\n") { line++; i++; continue; }

    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const { next, lines } = skipString(src, i, c);
      i = next; line += lines;
      continue;
    }

    // Identifier boundary check: `subagent(` and `x.agent(` must not match a bare `agent(` call.
    if (src.startsWith("agent(", i)) {
      const prev = i > 0 ? src[i - 1] : " ";
      if (!/[\w$.]/.test(prev)) {
        const span = extractCall(src, i + "agent(".length - 1);
        if (span) {
          const body = src.slice(span.start, span.end);
          calls.push({
            line,
            hasModel: /\bmodel\s*:/.test(body),
            model: extractKey(body, "model"),
            effort: extractKey(body, "effort"),
            label: extractLabel(body),
          });
          // Do NOT skip past the span: agent() calls nest inside parallel(...) arguments, and
          // jumping to span.end would swallow the inner ones. Advance one char and let the walk
          // find them. Nested calls are counted once each because each has its own `agent(` site.
        }
      }
    }
    i++;
  }
  return calls;
}

function skipString(src: string, start: number, quote: string): { next: number; lines: number } {
  let i = start + 1;
  let lines = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") lines++;
    // A template literal's ${...} can contain anything, including another agent() call. Bail out of
    // string mode so the main walk sees it. Over-scanning is safe; missing a call is not.
    if (quote === "`" && c === "$" && src[i + 1] === "{") return { next: i, lines };
    if (c === quote) return { next: i + 1, lines };
    i++;
  }
  return { next: i, lines };
}

/** Bracket-match from the call's opening paren to its close, ignoring parens inside strings. */
function extractCall(src: string, openParen: number): { start: number; end: number } | null {
  let depth = 0;
  let i = openParen;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i, c).next; continue; }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { start: openParen, end: i + 1 };
    }
    i++;
  }
  return null; // unbalanced source; caller treats it as unscannable
}

function extractKey(body: string, key: string): string {
  const m = body.match(new RegExp(`\\b${key}\\s*:\\s*['"\`]([a-zA-Z0-9_-]{1,20})['"\`]`));
  return m ? m[1] : "";
}

function extractLabel(body: string): string {
  const m = body.match(/\blabel\s*:\s*[`'"]([^`'"]{0,60})/);
  if (m) return m[1];
  const p = body.match(/\bphase\s*:\s*[`'"]([^`'"]{0,40})/);
  return p ? `phase ${p[1]}` : "unlabelled";
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Pure decision over an Agent/Task dispatch's `tool_input`. Unrecognizable input allows. */
export function checkAgent(input: unknown): GateDecision {
  if (typeof input !== "object" || input === null) return ALLOW;
  const t = input as Record<string, unknown>;

  // A fork inherits the parent model by design and ignores a model override, so demanding one
  // would be asking for a field with no effect.
  if (t.subagent_type === "fork") return ALLOW;

  const model = typeof t.model === "string" ? t.model.trim() : "";
  if (model) {
    if (!VALID_TIERS.includes(model)) {
      return {
        action: "deny",
        reason: [
          `BLOCKED: this dispatch names model "${model}", which is not a tier this project accepts.`,
          `Valid: ${VALID_TIERS.join(", ")}.`,
        ].join("\n"),
      };
    }
    if (hasOverride(t.prompt)) return ALLOW;
    const effort = typeof t.effort === "string" ? t.effort.trim() : "";
    const bad = effortViolation(model, effort);
    if (bad) {
      return {
        action: "deny",
        reason: [
          `BLOCKED: ${bad}.`,
          "",
          RULE,
          "",
          'Add effort: "xhigh" to the dispatch.',
        ].join("\n"),
      };
    }
    return ALLOW;
  }

  if (hasOverride(t.prompt)) return ALLOW;

  return {
    action: "deny",
    reason: [
      "BLOCKED: this dispatch does not state a model tier, so it silently inherits the session model.",
      "",
      RULE,
      "",
      'Add model: "haiku" (or sonnet/opus/fable) to the dispatch.',
      "If the session model really is the right tier, say so explicitly by passing it.",
      `To dispatch without choosing, put \`${OVERRIDE_TOKEN} <reason>\` in the prompt. The reason is required.`,
    ].join("\n"),
  };
}

/**
 * Pure decision over a Workflow's `tool_input`. `readFile` is injected so tests can exercise the
 * `scriptPath` branch without touching disk; the process entrypoint passes a real reader that
 * returns null on any failure.
 */
export function checkWorkflow(
  input: unknown,
  readFile: (p: string) => string | null,
): GateDecision {
  if (typeof input !== "object" || input === null) return ALLOW;
  const t = input as Record<string, unknown>;

  // A predefined workflow invoked by name is somebody else's script; we did not author its tiers.
  const inlineScript = typeof t.script === "string" ? t.script : null;
  const scriptPath = typeof t.scriptPath === "string" ? t.scriptPath : null;
  if (!inlineScript && !scriptPath) return ALLOW;

  const src = inlineScript ?? (scriptPath ? readFile(scriptPath) : null);
  if (!src) return ALLOW; // unreadable, so fail open

  if (hasOverride(src)) return ALLOW;

  const calls = scanAgentCalls(src);
  if (calls.length === 0) return ALLOW; // nothing to spawn, or unparsable, so fail open

  const bare = calls.filter((c) => !c.hasModel);
  const wrongEffort = calls.filter((c) => c.hasModel && effortViolation(c.model, c.effort));
  // The same tier vocabulary checkAgent enforces, applied per call site. Without this a misspelled
  // `"sonet"` in a fan-out script reads as a stated tier and inherits the session model anyway,
  // which is the failure this whole gate exists to close. A value the scanner could not read comes
  // back empty and is left alone, per the header's FAIL-OPEN CONTRACT. One deliberate difference
  // from checkAgent: a script-level override waives this check, because the override is read before
  // the script is scanned at all.
  const unknownTier = calls.filter((c) => c.hasModel && c.model && !VALID_TIERS.includes(c.model));
  if (bare.length === 0 && wrongEffort.length === 0 && unknownTier.length === 0) return ALLOW;

  const lines: string[] = ["BLOCKED: this workflow's agent tiers are not all stated and valid.", ""];

  if (bare.length > 0) {
    const shown = bare.slice(0, 12);
    lines.push(
      `${bare.length} of ${calls.length} agent() calls name no model, so they inherit the session`,
      "model. On a fan-out that is the expensive default, and it is a default rather than a decision.",
      ...shown.map((c) => `  line ${c.line}  ${c.label}`),
    );
    if (bare.length > shown.length) lines.push(`  ... and ${bare.length - shown.length} more`);
    lines.push("");
  }

  if (wrongEffort.length > 0) {
    const shown = wrongEffort.slice(0, 12);
    lines.push(
      `${wrongEffort.length} call(s) name a model whose effort is mandated and do not set it:`,
      ...shown.map((c) => `  line ${c.line}  ${c.label}: ${effortViolation(c.model, c.effort)}`),
    );
    if (wrongEffort.length > shown.length) lines.push(`  ... and ${wrongEffort.length - shown.length} more`);
    lines.push("");
  }

  if (unknownTier.length > 0) {
    const shown = unknownTier.slice(0, 12);
    lines.push(
      `${unknownTier.length} call(s) name a model that is not a tier this project accepts.`,
      `Valid: ${VALID_TIERS.join(", ")}.`,
      ...shown.map((c) => `  line ${c.line}  ${c.label}: "${c.model}"`),
    );
    if (unknownTier.length > shown.length) lines.push(`  ... and ${unknownTier.length - shown.length} more`);
    lines.push("");
  }

  lines.push(
    RULE,
    "",
    'Set both on each opts object, for example { label: "...", model: "sonnet", effort: "xhigh" }.',
    "A typical split: measurement and fetching on haiku, verification on sonnet at xhigh, synthesis",
    "on the premium tier.",
    `To run without choosing, put \`${OVERRIDE_TOKEN} <reason>\` anywhere in the script.`,
  );
  return { action: "deny", reason: lines.join("\n") };
}

/**
 * The gate's whole policy over a PreToolUse stdin payload, pure apart from the injected reader.
 * Unrecognizable input and any tool this gate does not judge both allow.
 */
export function decide(
  payload: unknown,
  readFile: (p: string) => string | null = () => null,
): GateDecision {
  if (typeof payload !== "object" || payload === null) return ALLOW;
  const p = payload as Record<string, unknown>;

  // Defense in depth: only judge the dispatch tools, whatever the matcher says. See the header's
  // MATCHER NOTE for which of these names is observed and which is inferred.
  const tool = p.tool_name;
  if (tool === "Agent" || tool === "Task") return checkAgent(p.tool_input);
  if (tool === "Workflow") return checkWorkflow(p.tool_input, readFile);
  return ALLOW;
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text();
    if (raw.trim() === "") process.exit(0);

    const readFile = (path: string): string | null => {
      try { return readFileSync(path, "utf8"); } catch { return null; }
    };

    const decision = decide(JSON.parse(raw), readFile);
    if (decision.action === "deny") {
      console.error(decision.reason);
      process.exit(2);
    }
  } catch (err) {
    // Fail open: log and allow. A broken gate must never block real work. Exit 0 with nothing on
    // stdout is Claude Code's "no opinion", so the dispatch proceeds; the stderr line keeps a
    // silently broken gate visible to an operator reading hook output.
    console.error(`model-tier-gate: hook error, allowing dispatch: ${String(err)}`);
  }
  process.exit(0);
}
