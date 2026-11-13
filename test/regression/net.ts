// Regression net (issue #96): the logic behind `bun run regression`.
//
// The manifest maps each real past defect of this repository to the existing bun tests that pin
// its fix. This module validates the manifest, checks that every pinned file and test name still
// exists, runs the pinned tests, and judges each defect caught or not caught. It measures only
// defects that already happened. A green result says nothing about failure classes nobody has
// met yet (see test/regression/README.md).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PinnedTest {
  file: string;
  name: string;
}

export interface Defect {
  id: string;
  defect: string;
  fixedBy: string;
  /** "ablated" when the fix was reverted and the pinned test shown to fail, else "assumed: <reason>". */
  verified: string;
  tests: PinnedTest[];
}

export type Outcome = "pass" | "skip" | "fail";

export interface Verdict {
  id: string;
  defect: string;
  fixedBy: string;
  verified: string;
  caught: boolean;
  reasons: string[];
}

function fail(message: string): never {
  throw new Error(`regression manifest: ${message}`);
}

function text(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value.trim() === "") fail(`${where}: ${key} must be a non-empty string`);
  return value;
}

export function parseManifest(source: string): Defect[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    fail("not valid JSON");
  }
  if (!Array.isArray(raw) || raw.length === 0) fail("must be a non-empty array of defects");
  const seen = new Set<string>();
  return raw.map((item, index): Defect => {
    if (typeof item !== "object" || item === null) fail(`entry ${index} is not an object`);
    const entry = item as Record<string, unknown>;
    const id = text(entry, "id", `entry ${index}`);
    const where = `entry "${id}"`;
    if (seen.has(id)) fail(`duplicate id "${id}"`);
    seen.add(id);
    const defect = text(entry, "defect", where);
    if (/[\r\n]/.test(defect)) fail(`${where}: defect must be one line`);
    const fixedBy = text(entry, "fixedBy", where);
    const verified = text(entry, "verified", where);
    if (!/^(?:ablated|assumed: \S.*)$/.test(verified)) fail(`${where}: verified must be "ablated" or "assumed: <reason>"`);
    const tests = entry.tests;
    if (!Array.isArray(tests) || tests.length === 0) fail(`${where} has no pinning test`);
    return {
      id,
      defect,
      fixedBy,
      verified,
      tests: tests.map((t): PinnedTest => {
        if (typeof t !== "object" || t === null) fail(`${where}: a test entry is not an object`);
        const pinned = t as Record<string, unknown>;
        return { file: text(pinned, "file", where), name: text(pinned, "name", where) };
      }),
    };
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The scan behind `stripComments` and `sourceDeclaresTest`. `code` is `source` with every line and
 * block comment blanked. `masked` is `code` with each string, template and regex literal blanked to
 * spaces of the same length, so a bracket or a call inside a literal is invisible and positions line
 * up with `code`. `literals` holds the range of each literal in `code`. Strings, template literals and
 * regex literals are skipped whole, so a `//` inside a URL string does not start a comment. */
function scanSource(source: string): { code: string; masked: string; literals: { start: number; end: number }[] } {
  let out = "";
  let masked = "";
  const literals: { start: number; end: number }[] = [];
  let i = 0;
  let lastCode = "";
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      masked += " ";
    } else if (c === '"' || c === "'" || c === "`" || (c === "/" && /^[(,=:[!&|?{};]?$/.test(lastCode))) {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      const literal = source.slice(i, j + 1);
      literals.push({ start: out.length, end: out.length + literal.length });
      out += literal;
      masked += " ".repeat(literal.length);
      i = j + 1;
      lastCode = c;
    } else {
      out += c;
      masked += c;
      i++;
      if (!/\s/.test(c)) lastCode = c;
    }
  }
  return { code: out, masked, literals };
}

/** `source` with every line and block comment blanked, so a commented-out test() call is not seen. */
export function stripComments(source: string): string {
  return scanSource(source).code;
}

/** The callee text of the call whose opening parenthesis sits at `open` in `masked`: the identifier
 * and dot chain before it, with any bracketed groups (`.skipIf(x)`, `.each([..])`) folded in and all
 * whitespace removed. `test` for `test(`, `test.skipIf(x)` for `test.skipIf(x)(`. */
function calleeBefore(masked: string, open: number): string {
  let k = open - 1;
  while (k >= 0) {
    const c = masked[k];
    if (/[\w$.]/.test(c)) {
      k--;
    } else if (c === ")" || c === "]") {
      let depth = 0;
      let m = k;
      for (; m >= 0; m--) {
        if (masked[m] === ")" || masked[m] === "]") depth++;
        else if (masked[m] === "(" || masked[m] === "[") depth--;
        if (depth === 0) break;
      }
      if (m < 0) break;
      k = m - 1;
    } else if (/\s/.test(c)) {
      // A break inside a chain (`.skipIf(x)\n(`, `test\n.failing(`) stays in the callee. A break
      // before a fresh statement does not, so `expect(x)\ntest(` is not read as one expression.
      let p = k;
      while (p >= 0 && /\s/.test(masked[p])) p--;
      let q = k + 1;
      while (q < masked.length && /\s/.test(masked[q])) q++;
      if (p >= 0 && (masked[q] === "." || masked[q] === "(") && /[\w$)\]]/.test(masked[p])) k = p;
      else break;
    } else break;
  }
  return masked.slice(k + 1, open).replace(/\s+/g, "");
}

/** True when `source` declares a test whose title is exactly `name` through a plain, unmodified
 * test()/it() call, and through no other form. The title must be the whole first argument: one
 * string literal in code followed directly by the comma, so `"name" + x` or `"name".concat(x)` does
 * not declare "name". A match inside a comment, a string or template literal, or a regex does
 * not count, and neither does a method named test (`re.test("x")`). If the same title also appears
 * behind any modifier (`test.failing`, `.skip`, `.todo`, `.if`, `.skipIf`, `.todoIf`, `.only`,
 * `.each`, or any other `test.x` / `it.x` form), the pin is refused even when a plain declaration
 * exists: bun reports a `.failing` test as passing when its body throws, and the report pairs cases
 * by title, so the plain twin would vouch for a test that checks nothing. A longer title that merely
 * begins with the name does not count. Both the run path and the static check call this. */
export function sourceDeclaresTest(source: string, name: string): boolean {
  const { code, masked, literals } = scanSource(source);
  let plain = false;
  for (const { start, end } of literals) {
    const raw = code.slice(start, end);
    const quote = raw[0];
    if ((quote !== '"' && quote !== "'" && quote !== "`") || raw.length < 2 || raw[raw.length - 1] !== quote) continue;
    if (raw.slice(1, -1) !== name) continue;
    let open = start - 1;
    while (open >= 0 && /\s/.test(masked[open])) open--;
    if (open < 0 || masked[open] !== "(") continue;
    const callee = calleeBefore(masked, open);
    if (/^(?:test|it)\./.test(callee)) return false;
    if (callee !== "test" && callee !== "it") continue;
    // The literal must be the whole first argument: only whitespace may sit between it and the comma.
    let after = end;
    while (after < masked.length && /\s/.test(masked[after])) after++;
    if (masked[after] === ",") plain = true;
  }
  return plain;
}

/** The `bun test -t` regex selecting exactly these titles. Bun matches it against the describe
 * path joined to the title with spaces, so each title is anchored at the end and at a word start. */
export function testFilterPattern(names: string[]): string {
  return `(?:${names.map((n) => `(?:^|\\s)${escapeRegex(n)}$`).join("|")})`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

/** One test case of a bun JUnit report. `classname` is the describe path the case sits under. */
export interface JunitCase {
  classname: string;
  name: string;
  outcome: Outcome;
}

/** The full test path as the report gives it: the describe path, then the title. */
export function fullName(c: JunitCase): string {
  return c.classname === "" ? c.name : `${c.classname} > ${c.name}`;
}

/** Every case of a bun JUnit report, each with its describe path, so two tests sharing a title in
 * different describes stay two cases. A case with no child element passed. A filtered out or skipped
 * case carries <skipped>, a failing one <failure> or <error>. */
export function parseJunit(xml: string): JunitCase[] {
  const out: JunitCase[] = [];
  const cases = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(cases)) {
    const name = /\bname="([^"]*)"/.exec(match[1])?.[1];
    if (name === undefined) continue;
    const body = match[2] ?? "";
    const outcome: Outcome = /<(?:failure|error)\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass";
    const classname = /\bclassname="([^"]*)"/.exec(match[1])?.[1] ?? "";
    out.push({ classname: decode(classname), name: decode(name), outcome });
  }
  return out;
}

export interface Evidence {
  fileExists: (file: string) => boolean;
  declares: (file: string, name: string) => boolean;
  outcomes: JunitCase[];
}

export function judgeDefect(defect: Defect, evidence: Evidence): Verdict {
  const reasons: string[] = [];
  for (const { file, name } of defect.tests) {
    if (!evidence.fileExists(file)) {
      reasons.push(`file not found: ${file}`);
    } else if (!evidence.declares(file, name)) {
      reasons.push(`no test named "${name}" in ${file}`);
    } else {
      // The pin names a title, not a describe path, so the title must pick out exactly one case.
      // Two cases sharing it (another describe, a describe loop) cannot be told apart, and letting
      // either one speak would let a passing twin mask the pinned test.
      const matches = evidence.outcomes.filter((c) => c.name === name);
      if (matches.length === 0) reasons.push(`did not run: "${name}"`);
      else if (matches.length > 1) {
        reasons.push(`ambiguous, ${matches.length} tests share the title "${name}": ${matches.map(fullName).join(" | ")}`);
      } else if (matches[0].outcome === "fail") reasons.push(`failed: "${name}"`);
      else if (matches[0].outcome === "skip") reasons.push(`skipped, so it pins nothing: "${name}"`);
    }
  }
  return { id: defect.id, defect: defect.defect, fixedBy: defect.fixedBy, verified: defect.verified, caught: reasons.length === 0, reasons };
}

export interface NetOptions {
  manifest: Defect[];
  root: string;
  /** Runs the named tests of one file and returns bun's JUnit report, or null when none came back. */
  runBun: (file: string, names: string[]) => Promise<string | null>;
}

export async function runNet({ manifest, root, runBun }: NetOptions): Promise<Verdict[]> {
  const sources = new Map<string, string | null>();
  const sourceOf = (file: string): string | null => {
    if (!sources.has(file)) {
      const path = join(root, file);
      sources.set(file, existsSync(path) ? readFileSync(path, "utf8") : null);
    }
    return sources.get(file) ?? null;
  };
  const declares = (file: string, name: string) => {
    const source = sourceOf(file);
    return source !== null && sourceDeclaresTest(source, name);
  };

  // Only tests that exist are run, one bun process per file, files in series. Several pinned tests
  // build git repositories and take 15 to 20 s alone against bun's 30 s per-test limit, so a
  // sibling bun process pushes them over it and the result changes from run to run.
  const toRun = new Map<string, Set<string>>();
  for (const defect of manifest) {
    for (const { file, name } of defect.tests) {
      if (declares(file, name)) toRun.set(file, (toRun.get(file) ?? new Set()).add(name));
    }
  }
  const reports = new Map<string, JunitCase[]>();
  for (const [file, names] of toRun) {
    const xml = await runBun(file, [...names]);
    reports.set(file, xml === null ? [] : parseJunit(xml));
  }

  return manifest.map((defect) => {
    // A defect's tests can sit in several files, so judge each test against its own file's report.
    const reasons: string[] = [];
    for (const test of defect.tests) {
      const verdict = judgeDefect(
        { ...defect, tests: [test] },
        {
          fileExists: (file) => sourceOf(file) !== null,
          declares,
          outcomes: reports.get(test.file) ?? [],
        },
      );
      reasons.push(...verdict.reasons);
    }
    return { id: defect.id, defect: defect.defect, fixedBy: defect.fixedBy, verified: defect.verified, caught: reasons.length === 0, reasons };
  });
}

/** The printed report and exit code. A static run runs no test, so it never says CAUGHT: its
 * labels and summary say only that pins resolve. A full run tags each CAUGHT with how far the pin
 * was verified, so an assumed entry never reads the same as an ablated one. */
export function renderReport(verdicts: Verdict[], mode: "static" | "run"): { text: string; code: number } {
  const lines: string[] = [];
  const isStatic = mode === "static";
  for (const v of verdicts) {
    const label = isStatic ? (v.caught ? "RESOLVES  " : "UNRESOLVED") : v.caught ? "CAUGHT    " : "NOT CAUGHT";
    const tag = isStatic || !v.caught ? "" : `  [${v.verified.startsWith("ablated") ? "ablated" : "assumed"}]`;
    lines.push(`${label}${tag}  ${v.id}  (${v.fixedBy})  ${v.defect}`);
    for (const reason of v.reasons) lines.push(`            - ${reason}`);
  }
  const missed = verdicts.filter((v) => !v.caught);
  const ok = verdicts.length - missed.length;
  lines.push("");
  if (isStatic) {
    lines.push(`${ok} of ${verdicts.length} pins resolve to a declared test. No test ran.`);
    if (missed.length > 0) lines.push(`UNRESOLVED: ${missed.map((v) => v.id).join(", ")}`);
  } else {
    const ablated = verdicts.filter((v) => v.caught && v.verified.startsWith("ablated")).length;
    lines.push(`${ok} of ${verdicts.length} known defects caught (every pinned test run): ${ablated} ablated, ${ok - ablated} assumed.`);
    lines.push("An assumed entry's test passed, but was not shown to fail when its defect returns.");
    if (missed.length > 0) {
      lines.push(`NOT CAUGHT: ${missed.map((v) => v.id).join(", ")}`);
      lines.push("A harness change stopped catching a defect it used to catch, or a pinned test was renamed or removed.");
    }
    lines.push("Green means these known defects stay caught. It does not mean the harness is sound.");
  }
  return { text: lines.join("\n"), code: missed.length === 0 ? 0 : 1 };
}
