// Renders the public review body. Everything a model wrote, every changed-file path and every
// verification reason goes through fenced(), because the body is posted under the App's name and
// that text was shaped by whoever opened the pull request. Inside a fence GitHub renders no links,
// images, HTML, mentions or issue references. What renders outside a fence is template text plus
// values this file checks itself: event names, validated enums, counts, SHAs and plain identifiers.

import { CONFIDENCE_SET, LOAD_BEARING_SET, SEVERITY_SET, SHA_RE, type Finding, type ReviewEvent, type ReviewerOutput, type Verification } from "./types";

export const MAX_FIELD_CHARS = 1_500;
export const MAX_RENDERED_FINDINGS = 25;
// GitHub caps a review body at 65,536 characters; the margin absorbs template text.
export const MAX_BODY_CHARS = 60_000;

// #120's plan D5 list (docs/superpowers/plans/2026-09-11-pr-review-app.md) exactly: C0 controls
// other than tab and newline, DEL, the Arabic letter mark, zero-width and directional marks, line
// and paragraph separators, the bidirectional overrides and isolates, invisible operators, and the
// byte-order mark. Not every character that can make displayed text differ from its bytes: other
// confusables (soft hyphen, Mongolian vowel separator, variation selectors, tag characters) are a
// known gap the plan does not close here, tracked outside this task rather than widened on sight.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
const IDENTIFIER_RE = /^[A-Za-z0-9._\-\[\]]+$/;
// The three literals ReviewEvent allows (types.ts:34) and the three Verification.state allows
// (types.ts:37), restated at runtime because a type annotation enforces nothing once bun skips
// type-checking (global constraints: "A type annotation enforces nothing").
const REVIEW_EVENTS: ReadonlySet<string> = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
const VERIFICATION_STATES: ReadonlySet<string> = new Set(["passed", "failed", "incomplete"]);
// Every character a basis string from computeEvent (verdict.ts) actually uses: lowercase letters,
// digits, space, comma, apostrophe, and the parentheses around "finding(s)". Excludes backtick,
// @, #, <, [ and newline, so basis stays safe to render outside a fence unescaped.
const BASIS_RE = /^[a-z0-9 (),']*$/;

export interface RenderInput {
  event: ReviewEvent;
  computedEvent: ReviewEvent;
  basis: string;
  eventNote: string | null;
  output: ReviewerOutput | null;
  reviewerFailure: string | null;
  verification: Verification;
  headSha: string;
  reviewerModel: string;
  reviewerTools: readonly string[];
  toolRevision: string;
  toolDirty: boolean;
  changedFiles: readonly string[];
}

export function sanitize(text: string, maxChars: number = MAX_FIELD_CHARS): string {
  const cleaned = text.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "");
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}\n[truncated]` : cleaned;
}

// The fence is one backtick longer than the longest run in the content, so no content line can
// close it.
export function fenced(text: string): string {
  const clean = sanitize(text);
  const longest = (clean.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${clean}\n${fence}`;
}

// Severity and confidence are validated once, for every finding, in renderReviewBody before any
// section slices its list (Minor 1). Re-checking here too left the top-level check's confidence
// half unpinned: either copy alone still caught the position-1 test case (re-review, New Breakage
// 1), so this function trusts its caller rather than re-attacking the same finding twice.
function findingBlock(index: number, finding: Finding, changed: ReadonlySet<string>): string {
  const pathLine =
    finding.path === ""
      ? ""
      : changed.has(finding.path)
        ? `path: ${finding.path}\n`
        : `path (not among the changed files): ${finding.path}\n`;
  return [
    `**${index}. ${finding.severity}** (confidence: ${finding.confidence})`,
    "",
    fenced(`${pathLine}${finding.title}\n\n${finding.detail}`),
  ].join("\n");
}

function findingsSection(heading: string, findings: readonly Finding[], changed: ReadonlySet<string>): string {
  const lines = [`#### ${heading} (${findings.length})`];
  if (findings.length === 0) lines.push("", "None.");
  findings.slice(0, MAX_RENDERED_FINDINGS).forEach((finding, i) => lines.push("", findingBlock(i + 1, finding, changed)));
  if (findings.length > MAX_RENDERED_FINDINGS) {
    lines.push("", `${findings.length - MAX_RENDERED_FINDINGS} more omitted from this body.`);
  }
  return lines.join("\n");
}

export function renderReviewBody(input: RenderInput): string {
  if (typeof input.headSha !== "string" || !SHA_RE.test(input.headSha)) {
    throw new Error("headSha must be a 40-character lowercase hex SHA");
  }
  if (typeof input.toolRevision !== "string" || !SHA_RE.test(input.toolRevision)) {
    throw new Error("toolRevision must be a 40-character lowercase hex SHA");
  }
  if (
    typeof input.reviewerModel !== "string" ||
    !IDENTIFIER_RE.test(input.reviewerModel) ||
    !Array.isArray(input.reviewerTools) ||
    // Array.from over the array's default iterator visits every index, including a hole, as
    // undefined; every() alone would skip a hole outright (HasProperty is false there), letting a
    // sparse array pass and render as a shortened tool list.
    !Array.from(input.reviewerTools).every((tool) => typeof tool === "string" && IDENTIFIER_RE.test(tool))
  ) {
    throw new Error("the reviewer model id and tool names must be plain identifiers");
  }
  if (!REVIEW_EVENTS.has(input.event)) throw new Error("event must be one of APPROVE, REQUEST_CHANGES, COMMENT");
  if (!REVIEW_EVENTS.has(input.computedEvent)) {
    throw new Error("computedEvent must be one of APPROVE, REQUEST_CHANGES, COMMENT");
  }
  if (!VERIFICATION_STATES.has(input.verification.state)) {
    throw new Error("verification.state must be one of passed, failed, incomplete");
  }
  if (typeof input.basis !== "string" || !BASIS_RE.test(input.basis)) {
    throw new Error("basis contains a character outside computeEvent's output set");
  }
  if (input.output !== null) {
    for (const finding of input.output.findings) {
      if (!SEVERITY_SET.has(finding.severity) || !CONFIDENCE_SET.has(finding.confidence)) {
        throw new Error("a finding reached the renderer without passing validation");
      }
    }
  }
  const changed = new Set(input.changedFiles);

  const header = ["### Automated review (#120)", "", `**Event:** ${input.event}`, `**Basis:** ${input.basis}`];
  if (input.event !== input.computedEvent) {
    header.push(
      `**Computed event, not posted:** ${input.computedEvent}`,
      "",
      "**Why it was lowered:**",
      "",
      fenced(input.eventNote ?? "no reason recorded"),
    );
  }

  const verification = [`#### Verification: ${input.verification.state}`];
  if (input.verification.reasons.length > 0) verification.push("", fenced(input.verification.reasons.join("\n")));

  const required: string[] = [header.join("\n"), verification.join("\n")];
  const optional: Array<{ name: string; text: string }> = [];

  if (input.output === null) {
    required.push(["#### Reviewer output: unavailable", "", fenced(input.reviewerFailure ?? "no reason recorded")].join("\n"));
  } else {
    const { output } = input;
    required.push(findingsSection("Findings at or above the severity floor", output.findings.filter((f) => LOAD_BEARING_SET.has(f.severity)), changed));
    const observed = [`#### Instruction-shaped content the reviewer observed (${output.observed_instructions.length})`];
    output.observed_instructions.slice(0, MAX_RENDERED_FINDINGS).forEach((item) => observed.push("", fenced(`path: ${item.path}\n${item.excerpt}`)));
    optional.push(
      {
        name: "Findings below the floor",
        text: findingsSection(
          "Findings below the floor: file these, they do not withhold approval",
          output.findings.filter((f) => !LOAD_BEARING_SET.has(f.severity)),
          changed,
        ),
      },
      { name: "Observed instructions", text: observed.join("\n") },
      { name: "Reviewer summary", text: ["#### Reviewer summary", "", fenced(output.summary)].join("\n") },
    );
  }

  const footer = [
    "---",
    `The event is computed by code from finding severities and CI results on the head commit. The reviewing model ran with tools [${input.reviewerTools.join(", ")}] and cannot post, approve, or read anything outside its prompt.`,
    `Head \`${input.headSha}\`, reviewer \`${input.reviewerModel}\`, tool revision \`${input.toolRevision}\`${input.toolDirty ? " with uncommitted changes" : ""}.`,
  ].join("\n");

  const assemble = () => [...required, ...optional.map((section) => section.text), footer].join("\n\n");
  let body = assemble();
  for (let i = optional.length - 1; i >= 0 && body.length > MAX_BODY_CHARS; i--) {
    optional[i] = { name: optional[i]!.name, text: `_${optional[i]!.name} omitted: the review body reached its length cap._` };
    body = assemble();
  }
  if (body.length > MAX_BODY_CHARS) throw new Error("the review body exceeds its length cap with every optional section omitted");
  return body;
}
