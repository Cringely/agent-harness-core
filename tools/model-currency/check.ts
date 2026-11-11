#!/usr/bin/env bun
// Model currency check (#310). Finds every exact model ID ("pins") and tier alias under the roots
// given and reports which are behind the latest models. Run by hand from a core clone. Nothing
// installs it.
//
//   bun tools/model-currency/check.ts [--root <dir-or-file>]... [--exclude <name>]...
//                                     [--latest <file.json>] [--no-resolve]
//
// Latest-model source, first that answers: the Models API (needs ANTHROPIC_API_KEY), the --latest
// JSON file (family name to model id), then the live resolution of each tier alias through
// `claude -p`. The alias source is unverified, because an alias can itself resolve to an older
// model, so it can prove a pin is behind but never that anything is current.
//
// Output: a first line naming the source, then one row per finding:
//   <status>\t<file>:<line>\t<value>\t<latest or ->
// Exit 1 when any row is behind or stale-alias. Otherwise 2 when any row is unknown, the source is
// the alias source, or there is no source. Otherwise 0.
//
// A line holding the text "model-currency: ignore" is never reported. The alias resolution step
// reads only the model names under modelUsage in the claude CLI's JSON, and nothing else from it
// is printed or kept, because that output can carry account identity.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Family = "fable" | "opus" | "sonnet" | "haiku";
const FAMILIES: readonly Family[] = ["fable", "opus", "sonnet", "haiku"];

export interface ModelId {
  family: Family;
  major: number;
  minor: number;
  date: string | null;
  raw: string;
}

const NEW_SHAPE = /^claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?$/;
const OLD_SHAPE = /^claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)(?:-(\d{8}))?$/;

export function parseModelId(id: string): ModelId | null {
  const n = NEW_SHAPE.exec(id);
  if (n) return { family: n[1] as Family, major: Number(n[2]), minor: n[3] === undefined ? 0 : Number(n[3]), date: n[4] ?? null, raw: id };
  const o = OLD_SHAPE.exec(id);
  if (o) return { family: o[3] as Family, major: Number(o[1]), minor: o[2] === undefined ? 0 : Number(o[2]), date: o[4] ?? null, raw: id };
  return null;
}

// Major, then minor. Dates are ignored: two builds of one version are the same version.
export function compareModelIds(a: ModelId, b: ModelId): number {
  return a.major - b.major || a.minor - b.minor;
}

export function latestByFamily(ids: string[]): Partial<Record<Family, string>> {
  const best: Partial<Record<Family, ModelId>> = {};
  for (const id of ids) {
    const p = parseModelId(id);
    if (p === null) continue;
    const cur = best[p.family];
    if (cur === undefined || compareModelIds(p, cur) > 0) best[p.family] = p;
  }
  const out: Partial<Record<Family, string>> = {};
  for (const f of FAMILIES) if (best[f] !== undefined) out[f] = best[f]!.raw;
  return out;
}

export interface Finding {
  file: string;
  line: number;
  value: string;
  kind: "pin" | "alias";
}

const IGNORE_MARKER = "model-currency: ignore";
const ALIAS = "fable|opus|sonnet|haiku";
const PIN_PATTERNS = [
  /claude-(?:fable|opus|sonnet|haiku)-\d{1,2}(?:-\d{1,2})?(?:-\d{8})?\b/g,
  /claude-\d(?:-\d)?-(?:opus|sonnet|haiku)(?:-\d{8})?\b/g,
];
const ALIAS_PATTERNS = [
  new RegExp(`^\\s*model:\\s*(${ALIAS})\\s*$`, "g"),
  new RegExp(`"model"\\s*:\\s*"(${ALIAS})"`, "g"),
  new RegExp(`--model[ =](${ALIAS})\\b`, "g"),
];

export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    if (lineText.includes(IGNORE_MARKER)) return;
    const here: Array<Finding & { col: number }> = [];
    for (const re of PIN_PATTERNS) {
      for (const m of lineText.matchAll(re)) here.push({ file, line: i + 1, value: m[0], kind: "pin", col: m.index ?? 0 });
    }
    for (const re of ALIAS_PATTERNS) {
      for (const m of lineText.matchAll(re)) here.push({ file, line: i + 1, value: m[1]!, kind: "alias", col: m.index ?? 0 });
    }
    here.sort((a, b) => a.col - b.col);
    for (const { col: _col, ...f } of here) out.push(f);
  });
  return out;
}

export interface LatestTable {
  source: "api" | "file" | "alias";
  models: Partial<Record<Family, string>>;
}

export interface Row {
  status: "current" | "behind" | "stale-alias" | "unknown";
  file: string;
  line: number;
  value: string;
  latest: string | null;
}

export function classify(
  findings: Finding[],
  latest: LatestTable | null,
  resolved: Partial<Record<Family, string | null>>,
): Row[] {
  return findings.map((f): Row => {
    const base = { file: f.file, line: f.line, value: f.value };
    if (f.kind === "pin") {
      const pin = parseModelId(f.value);
      const latestId = pin === null || latest === null ? undefined : latest.models[pin.family];
      const latestParsed = latestId === undefined ? null : parseModelId(latestId);
      if (pin === null || latest === null || latestId === undefined || latestParsed === null) {
        return { ...base, status: "unknown", latest: latestId ?? null };
      }
      if (compareModelIds(pin, latestParsed) < 0) return { ...base, status: "behind", latest: latestId };
      // An alias-derived latest is unverified, so a pin at or above it is not shown to be current.
      return { ...base, status: latest.source === "alias" ? "unknown" : "current", latest: latestId };
    }
    const family = f.value as Family;
    const latestId = latest === null ? undefined : latest.models[family];
    const latestParsed = latestId === undefined ? null : parseModelId(latestId);
    const resolvedId = resolved[family] ?? null;
    const resolvedParsed = resolvedId === null ? null : parseModelId(resolvedId);
    if (latest === null || latest.source === "alias" || latestParsed === null || resolvedParsed === null) {
      return { ...base, status: "unknown", latest: latestId ?? null };
    }
    return { ...base, status: compareModelIds(resolvedParsed, latestParsed) < 0 ? "stale-alias" : "current", latest: latestId! };
  });
}

export async function fetchLatestFromApi(apiKey: string | undefined, fetchImpl: typeof fetch): Promise<LatestTable | null> {
  if (apiKey === undefined || apiKey === "") return null;
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1000", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    const ids = body.data.map((d) => (d as { id?: unknown } | null)?.id).filter((x): x is string => typeof x === "string");
    const models = latestByFamily(ids);
    return Object.keys(models).length === 0 ? null : { source: "api", models };
  } catch {
    return null;
  }
}

export type ClaudeRunner = (args: string[]) => { code: number; stdout: string };

// Reads only the model names under modelUsage. Nothing else in the CLI's output is looked at,
// returned or logged.
export function resolveAlias(alias: Family, runClaude: ClaudeRunner): string | null {
  try {
    const r = runClaude(["-p", "--model", alias, "--output-format", "json", "Reply with the single word OK."]);
    if (r.code !== 0) return null;
    const usage = (JSON.parse(r.stdout) as { modelUsage?: unknown }).modelUsage;
    if (typeof usage !== "object" || usage === null) return null;
    const ids = Object.keys(usage).map((k) => k.replace(/\[[^\]]*\]$/, ""));
    return latestByFamily(ids.filter((id) => parseModelId(id)?.family === alias))[alias] ?? null;
  } catch {
    return null;
  }
}

// The child is not told which project it runs for, so a SessionStart hook in it cannot act on one.
export function claudeChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "CLAUDE_PROJECT_DIR") out[k] = v;
  return out;
}

export const defaultClaudeRunner: ClaudeRunner = (args) => {
  const claude = Bun.which("claude");
  if (claude === null) return { code: 127, stdout: "" };
  // A fresh empty directory, so the child loads no project settings, hooks or memory.
  const dir = mkdtempSync(join(tmpdir(), "model-currency-"));
  try {
    const p = Bun.spawnSync([claude, ...args], {
      cwd: dir,
      env: claudeChildEnv(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 120_000,
    });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const DEFAULT_EXCLUDES = [
  ".git", "node_modules", "runs", "worktrees", "projects", "file-history", "plugins", "debug", "backups", "superpowers",
];
const MAX_BYTES = 2 * 1024 * 1024;

interface FoundFile {
  abs: string;
  shown: string;
}

function skipFile(name: string): boolean {
  return name.endsWith(".jsonl") || name.includes(".bak");
}

function walk(abs: string, shown: string, excludes: Set<string>, out: FoundFile[]): void {
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const childAbs = join(abs, e.name);
    const childShown = `${shown.replace(/[\\/]$/, "")}/${e.name}`;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!excludes.has(e.name)) walk(childAbs, childShown, excludes, out);
    } else if (e.isFile() && !skipFile(e.name)) {
      out.push({ abs: childAbs, shown: childShown });
    }
  }
}

function scanFile(f: FoundFile): Finding[] {
  try {
    if (statSync(f.abs).size > MAX_BYTES) return [];
    const buf = readFileSync(f.abs);
    if (buf.includes(0)) return [];
    return scanText(f.shown, buf.toString("utf8"));
  } catch {
    return [];
  }
}

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  runClaude: ClaudeRunner;
}

const USAGE = "usage: bun tools/model-currency/check.ts [--root <dir-or-file>]... [--exclude <name>]... [--latest <file.json>] [--no-resolve]";

function readLatestFile(path: string): LatestTable | null {
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const ids: string[] = [];
    for (const f of FAMILIES) {
      const v = obj[f];
      if (typeof v === "string" && parseModelId(v)?.family === f) ids.push(v);
    }
    const models = latestByFamily(ids);
    return Object.keys(models).length === 0 ? null : { source: "file", models };
  } catch {
    return null;
  }
}

export async function run(argv: string[], deps: RunDeps): Promise<{ exitCode: 0 | 1 | 2; output: string }> {
  const fail = (msg: string) => ({ exitCode: 2 as const, output: `${msg}\n${USAGE}` });
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string", multiple: true },
        exclude: { type: "string", multiple: true },
        latest: { type: "string" },
        "no-resolve": { type: "boolean" },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return fail((e as Error).message);
  }

  const excludes = new Set([...DEFAULT_EXCLUDES, ...(values.exclude ?? [])]);
  const files: FoundFile[] = [];
  for (const root of values.root ?? ["."]) {
    try {
      if (statSync(root).isDirectory()) walk(root, root, excludes, files);
      else files.push({ abs: root, shown: root });
    } catch {
      return fail(`cannot read root: ${root}`);
    }
  }
  const findings = files.flatMap(scanFile);

  const noResolve = values["no-resolve"] === true;
  const resolved: Partial<Record<Family, string | null>> = {};
  const resolve = (f: Family) => {
    if (!(f in resolved)) resolved[f] = resolveAlias(f, deps.runClaude);
  };

  let latest = await fetchLatestFromApi(deps.env.ANTHROPIC_API_KEY, deps.fetchImpl);
  if (latest === null && values.latest !== undefined) {
    latest = readLatestFile(values.latest);
    if (latest === null) return fail(`cannot use --latest file: ${values.latest}`);
  }
  if (!noResolve) {
    if (latest === null) {
      for (const f of FAMILIES) resolve(f);
      const models: Partial<Record<Family, string>> = {};
      for (const f of FAMILIES) if (resolved[f]) models[f] = resolved[f]!;
      if (Object.keys(models).length > 0) latest = { source: "alias", models };
    } else {
      for (const f of findings) if (f.kind === "alias") resolve(f.value as Family);
    }
  }

  const rows = classify(findings, latest, resolved);
  const head =
    latest === null
      ? "latest source: none (latest unknown)"
      : latest.source === "alias"
        ? "latest source: alias (unverified: an alias can itself resolve to an older model)"
        : `latest source: ${latest.source}`;
  const lines = [head, ...rows.map((r) => `${r.status}\t${r.file}:${r.line}\t${r.value}\t${r.latest ?? "-"}`)];

  const exitCode =
    rows.some((r) => r.status === "behind" || r.status === "stale-alias")
      ? 1
      : rows.some((r) => r.status === "unknown") || latest === null || latest.source === "alias"
        ? 2
        : 0;
  return { exitCode, output: lines.join("\n") };
}

if (import.meta.main) {
  const { exitCode, output } = await run(process.argv.slice(2), {
    env: process.env,
    fetchImpl: fetch,
    runClaude: defaultClaudeRunner,
  });
  console.log(output);
  process.exit(exitCode);
}
