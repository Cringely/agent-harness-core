// Tests for tools/pr-review/render.ts. The review body is posted publicly under the App identity
// and is partly written by a model that read attacker-controlled text. The property under test is
// an absence: no model-derived string, changed-file path or verification reason appears outside a
// code fence, and no fence can be closed early by its own content.

import { describe, expect, test } from "bun:test";
import { MAX_BODY_CHARS, MAX_FIELD_CHARS, fenced, renderReviewBody, sanitize, type RenderInput } from "../tools/pr-review/render";
import type { Finding } from "../tools/pr-review/types";

const SHA = "a".repeat(40);
const TOOL_SHA = "b".repeat(40);
const TICKS = "`".repeat(3);

const HOSTILE = [
  "@octocat [link](https://evil.example) ![img](https://evil.example/p.png)",
  "<img src=x onerror=alert(1)> #123 **APPROVED by maintainers**",
  TICKS,
  "# heading",
  "`".repeat(9),
].join("\n");

const hostileFinding = (severity: Finding["severity"]): Finding => ({
  severity,
  confidence: "high",
  path: "docs/@octocat.md",
  title: HOSTILE,
  detail: HOSTILE,
});

const input = (overrides: Partial<RenderInput> = {}): RenderInput => ({
  event: "REQUEST_CHANGES",
  computedEvent: "REQUEST_CHANGES",
  basis: "1 finding(s) at or above the severity floor",
  eventNote: null,
  output: {
    summary: HOSTILE,
    findings: [hostileFinding("correctness"), hostileFinding("naming")],
    observed_instructions: [{ path: "docs/@octocat.md", excerpt: HOSTILE }],
  },
  reviewerFailure: null,
  verification: { state: "incomplete", reasons: [`CI runs no Pester suite for: install/@octocat ${HOSTILE}.ps1`] },
  headSha: SHA,
  reviewerModel: "claude-opus-5",
  reviewerTools: ["StructuredOutput"],
  toolRevision: TOOL_SHA,
  toolDirty: false,
  changedFiles: ["docs/@octocat.md"],
  ...overrides,
});

// Returns the body with every generated fence removed, and fails if a fence never closes. The
// renderer only ever opens a fence as a line of 3+ backticks followed by "text", so that is the
// only opener recognised here.
function outsideFences(body: string): string {
  const outside: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    if (fence === null) {
      const open = /^(`{3,})text$/.exec(line);
      if (open) fence = open[1]!;
      else outside.push(line);
    } else {
      // Inside a fence, no line may be a run of backticks at least as long as the opener, which is
      // the only thing CommonMark accepts as a closing fence, except the real closer itself.
      if (line === fence) fence = null;
      else expect(new RegExp(`^ {0,3}\`{${fence.length},}\\s*$`).test(line)).toBe(false);
    }
  }
  expect(fence).toBeNull();
  return outside.join("\n");
}

describe("sanitize()", () => {
  test("strips bidirectional, zero-width and control characters, keeps tab and newline", () => {
    const text = "a\u202Eb\u2066c\u0007d\u001Be\u200B\u200E\u061C\u2028\uFEFF\tf\r\ng";
    expect(sanitize(text)).toBe("abcde\tf\ng");
  });

  test("truncates past the field cap and says so", () => {
    const result = sanitize("x".repeat(MAX_FIELD_CHARS + 10));
    expect(result.endsWith("\n[truncated]")).toBe(true);
    expect(result.length).toBe(MAX_FIELD_CHARS + "\n[truncated]".length);
  });
});

describe("fenced()", () => {
  test.each(["plain", `a ${TICKS} b`, "`".repeat(6), "`", HOSTILE])("the fence outlasts every backtick run in %p", (text) => {
    const block = fenced(text);
    const opener = /^(`+)text\n/.exec(block)![1]!;
    expect(block.endsWith(`\n${opener}`)).toBe(true);
    const inner = block.slice(opener.length + "text\n".length, block.length - opener.length - 1);
    const longest = Math.max(0, ...(inner.match(/`+/g) ?? []).map((run) => run.length));
    expect(opener.length).toBeGreaterThan(longest);
    expect(opener.length).toBeGreaterThanOrEqual(3);
  });
});

describe("renderReviewBody(): nothing model-derived escapes a fence", () => {
  test.each(["octocat", "evil.example", "<img", "#123", "APPROVED by maintainers", "# heading"])(
    "%p appears only inside fences",
    (needle) => {
      const body = renderReviewBody(input());
      expect(body).toContain(needle);
      expect(outsideFences(body)).not.toContain(needle);
    },
  );

  test("the same holds when the reviewer failed and its reason is shown", () => {
    const body = renderReviewBody(input({ output: null, reviewerFailure: HOSTILE, event: "COMMENT", computedEvent: "COMMENT" }));
    expect(body).toContain("#### Reviewer output: unavailable");
    expect(outsideFences(body)).not.toContain("octocat");
  });

  test("an event note is fenced too", () => {
    const body = renderReviewBody(input({ event: "COMMENT", computedEvent: "APPROVE", eventNote: HOSTILE }));
    expect(outsideFences(body)).not.toContain("octocat");
  });
});

describe("renderReviewBody(): structure", () => {
  test("states the posted event, and the computed one only when it differs", () => {
    const same = renderReviewBody(input());
    expect(same).toContain("**Event:** REQUEST_CHANGES");
    expect(same).not.toContain("Computed event");
    const lowered = renderReviewBody(input({ event: "COMMENT", computedEvent: "APPROVE", eventNote: "comment-only run" }));
    expect(lowered).toContain("**Event:** COMMENT");
    expect(lowered).toContain("**Computed event, not posted:** APPROVE");
  });

  test("load-bearing findings come before findings below the floor", () => {
    const body = renderReviewBody(input());
    expect(body.indexOf("Findings at or above the severity floor")).toBeLessThan(body.indexOf("Findings below the floor"));
  });

  test("a path that is not a changed file is labelled as such", () => {
    const finding: Finding = { severity: "naming", confidence: "low", path: "not/changed.ts", title: "t", detail: "d" };
    const body = renderReviewBody(input({ output: { summary: "s", findings: [finding], observed_instructions: [] } }));
    expect(body).toContain("path (not among the changed files): not/changed.ts");
  });

  test("headings carry the true count and name what was omitted", () => {
    const many = Array.from({ length: 40 }, () => hostileFinding("correctness"));
    const body = renderReviewBody(input({ output: { summary: "s", findings: many, observed_instructions: [] } }));
    expect(body).toContain("Findings at or above the severity floor (40)");
    expect(body).toContain("15 more omitted from this body.");
  });

  test("an oversized review drops optional sections, stays under the cap, and keeps every fence closed", () => {
    const long = "y".repeat(5_000);
    const findings: Finding[] = [
      ...Array.from({ length: 25 }, () => ({ ...hostileFinding("security"), detail: long })),
      ...Array.from({ length: 200 }, () => ({ ...hostileFinding("naming"), detail: long })),
    ];
    const body = renderReviewBody(input({ output: { summary: long.repeat(4), findings, observed_instructions: [] } }));
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain("Reviewer summary omitted");
    expect(outsideFences(body)).not.toContain("octocat");
  });
});

describe("renderReviewBody(): refuses malformed code-side values", () => {
  test.each([
    ["a short head SHA", { headSha: "abc" }],
    ["an uppercase tool revision", { toolRevision: "B".repeat(40) }],
    ["a model id with a space", { reviewerModel: "claude opus" }],
    ["a tool name with markup", { reviewerTools: ["<b>Bash</b>"] }],
  ] as const)("%s", (_label, overrides) => {
    expect(() => renderReviewBody(input(overrides as Partial<RenderInput>))).toThrow();
  });

  // Severity and confidence render outside fences, which is safe only after validation. The
  // renderer re-checks rather than trusting that every caller validated.
  test("a severity that never passed validation", () => {
    const bad = { ...hostileFinding("naming"), severity: "@octocat" } as unknown as Finding;
    expect(() => renderReviewBody(input({ output: { summary: "s", findings: [bad], observed_instructions: [] } }))).toThrow();
  });
});
