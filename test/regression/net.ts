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
  tests: PinnedTest[];
}

export type Outcome = "pass" | "skip" | "fail";

export interface Verdict {
  id: string;
  defect: string;
  fixedBy: string;
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
    const tests = entry.tests;
    if (!Array.isArray(tests) || tests.length === 0) fail(`${where} has no pinning test`);
    return {
      id,
      defect,
      fixedBy,
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

/** True when `source` declares a test whose title is exactly `name`: a test()/it() call, with any
 * modifier chain, whose first argument is that string literal. A name in a comment or inside an
 * assertion does not count, and neither does a longer title that merely begins with it. */
export function sourceDeclaresTest(source: string, name: string): boolean {
  const call = new RegExp(
    "\\b(?:test|it)(?:\\.[A-Za-z]+(?:\\([^)]*\\))?)*\\(\\s*([\"'`])" + escapeRegex(name) + "\\1",
  );
  return call.test(source);
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

/** Outcomes per test title from a bun JUnit report. A case with no child element passed. A filtered
 * out or skipped case carries <skipped>, a failing one <failure> or <error>. */
export function parseJunit(xml: string): Map<string, Outcome[]> {
  const out = new Map<string, Outcome[]>();
  const cases = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(cases)) {
    const name = /\bname="([^"]*)"/.exec(match[1])?.[1];
    if (name === undefined) continue;
    const body = match[2] ?? "";
    const outcome: Outcome = /<(?:failure|error)\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass";
    const key = decode(name);
    out.set(key, [...(out.get(key) ?? []), outcome]);
  }
  return out;
}

export interface Evidence {
  fileExists: (file: string) => boolean;
  declares: (file: string, name: string) => boolean;
  outcomes: Map<string, Outcome[]>;
}

export function judgeDefect(defect: Defect, evidence: Evidence): Verdict {
  const reasons: string[] = [];
  for (const { file, name } of defect.tests) {
    if (!evidence.fileExists(file)) {
      reasons.push(`file not found: ${file}`);
    } else if (!evidence.declares(file, name)) {
      reasons.push(`no test named "${name}" in ${file}`);
    } else {
      const seen = evidence.outcomes.get(name);
      if (!seen || seen.length === 0) reasons.push(`did not run: "${name}"`);
      else if (seen.includes("fail")) reasons.push(`failed: "${name}"`);
      else if (!seen.includes("pass")) reasons.push(`skipped, so it pins nothing: "${name}"`);
    }
  }
  return { id: defect.id, defect: defect.defect, fixedBy: defect.fixedBy, caught: reasons.length === 0, reasons };
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

  // Only tests that exist are run, one bun process per file.
  const toRun = new Map<string, Set<string>>();
  for (const defect of manifest) {
    for (const { file, name } of defect.tests) {
      if (declares(file, name)) toRun.set(file, (toRun.get(file) ?? new Set()).add(name));
    }
  }
  const reports = new Map<string, Map<string, Outcome[]>>();
  await Promise.all(
    [...toRun].map(async ([file, names]) => {
      const xml = await runBun(file, [...names]);
      reports.set(file, xml === null ? new Map() : parseJunit(xml));
    }),
  );

  return manifest.map((defect) => {
    // A defect's tests can sit in several files, so judge each test against its own file's report.
    const reasons: string[] = [];
    for (const test of defect.tests) {
      const verdict = judgeDefect(
        { ...defect, tests: [test] },
        {
          fileExists: (file) => sourceOf(file) !== null,
          declares,
          outcomes: reports.get(test.file) ?? new Map(),
        },
      );
      reasons.push(...verdict.reasons);
    }
    return { id: defect.id, defect: defect.defect, fixedBy: defect.fixedBy, caught: reasons.length === 0, reasons };
  });
}
