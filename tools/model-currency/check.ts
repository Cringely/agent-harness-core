#!/usr/bin/env bun
// Model currency check (#310). Finds every exact model ID ("pins") and tier alias under the roots
// given and reports which are behind the latest models. Run by hand from a core clone. Nothing
// installs it.
//
//   bun tools/model-currency/check.ts [--root <dir-or-file>]... [--exclude <name>]...
//                                     [--latest <file.json>] [--no-resolve]
//
// Latest-model source, first that answers: the Models API (needs ANTHROPIC_API_KEY), the --latest
// JSON file (family name to one model id or a list of them), then the live resolution of each tier
// alias through `claude -p`. The alias source is unverified, because an alias can itself resolve to
// an older model, so it can prove a pin is behind but never that anything is current.
//
// "current" means the exact id was confirmed to exist in the source's list and is the newest in its
// family. The api and file sources keep every id they list. A pin, or a resolved alias, is:
//   behind (stale-alias for an alias)  its version is below the family's latest. Whether its exact
//                                      build is listed does not matter, it is out of date either way.
//   current                            its version is the latest and the id is listed.
//   unknown                            its version is above every listed one, or it is at the latest
//                                      version but not listed (a date that matches no build), or the
//                                      family has no latest. The run is then inconclusive (exit 2).
// Matching against the list: dotted and hyphenated spellings are the same version. A dated id
// matches only a listed build with the same date. An undated id, the alias-style form such as
// claude-opus-5-5, matches any listed build of that version, dated or not.
//
// Output: a first line naming the source, then one row per finding:
//   <status>\t<file>:<line>\t<value>\t<latest or ->
// where <file> is relative to the --root it was found under, led by that root's basename, so an
// absolute path (and the user name in it) never reaches the output.
// then a last line "scanned N files, skipped M, excluded K".
//
// The invariant: exit 0 means every file in scope was read. Anything in scope that was not read is
// an unknown row, so the run exits 2, and M counts those entries. They are a file or directory that
// cannot be read (with the error class), a symlink or other non-regular entry (not followed), a file
// over 2 MB, and a file with a NUL byte and no UTF-16 byte order mark. UTF-16 files with a mark are
// decoded and scanned.
//
// Deliberately out of scope, and counted in K so they are never presented as covered: .jsonl files,
// backup names (a name ending in .bak or carrying a .bak.<suffix> segment), and every directory named
// in DEFAULT_EXCLUDES or by --exclude, at any depth. Each excluded directory counts once, whatever
// it holds. A root that is a file is read whatever its name.
//
// What is detected. Pins: claude-<family>-<major>[-|.]<minor>[-<date>] and the older
// claude-<major>[-|.]<minor>-<family>. Aliases (fable, opus, sonnet, haiku), only in these forms:
// "model: <alias>" alone on a line (optionally quoted, with a [suffix] or a trailing comment), a
// quoted alias under a model key in JSON, YAML or a JS or TS object, and "--model <alias>". An alias
// in any other position, such as one built from a variable, is not seen.
// Exit 1 when any row is behind or stale-alias. Otherwise 2 when any row is unknown, the source is
// the alias source, there is no source, or no file was scanned. Otherwise 0.
//
// A line holding the text "model-currency: ignore" is never reported. The alias resolution step
// reads only the model names under modelUsage in the claude CLI's JSON, and nothing else from it
// is printed or kept, because that output can carry account identity.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
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

const NEW_SHAPE = /^claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:[-.](\d{1,2}))?(?:-(\d{8}))?$/;
const OLD_SHAPE = /^claude-(\d)(?:[-.](\d))?-(opus|sonnet|haiku)(?:-(\d{8}))?$/;

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
  /claude-(?:fable|opus|sonnet|haiku)-\d{1,2}(?:[-.]\d{1,2})?(?:-\d{8})?\b/g,
  /claude-\d(?:[-.]\d)?-(?:opus|sonnet|haiku)(?:-\d{8})?\b/g,
];
const SUFFIX = "(?:\\[[^\\]]*\\])?";
const ALIAS_PATTERNS = [
  // YAML frontmatter: an unquoted alias, an optional bracket suffix and an optional trailing comment.
  new RegExp(`^\\s*model:\\s*(${ALIAS})${SUFFIX}\\s*(?:#.*)?$`, "g"),
  // A quoted alias under a model key: JSON, quoted YAML, and JS or TS object keys (quoted or not).
  new RegExp(`(?<![\\w-])["']?model["']?\\s*:\\s*["'](${ALIAS})${SUFFIX}["']`, "g"),
  new RegExp(`--model[ =]["']?(${ALIAS})${SUFFIX}(?![\\w-])`, "g"),
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
  // Every id the source listed (api and file). When absent, the ids in `models` are the list.
  ids?: string[];
}

export interface Row {
  status: "current" | "behind" | "stale-alias" | "unknown";
  file: string;
  line: number;
  value: string;
  latest: string | null;
}

// How an id is matched against the source's list. Dotted and hyphenated spellings are the same
// version. A dated id matches only a listed build of the same version with the same date. An
// undated id (the alias-style form) matches any listed build of that version, dated or not.
function isListed(id: ModelId, listed: ModelId[]): boolean {
  return listed.some(
    (l) => l.family === id.family && l.major === id.major && l.minor === id.minor && (id.date === null || id.date === l.date),
  );
}

type Verdict = "older" | "same" | "unknown";

// older: the version is below the family's latest, whether or not that exact build is listed.
// same: the version is the latest and the exact id is listed. unknown: above the latest, a date
// or version the source does not list, or no usable latest for the family.
function judge(id: ModelId | null, latest: LatestTable | null): Verdict {
  if (id === null || latest === null) return "unknown";
  const latestId = latest.models[id.family];
  const latestParsed = latestId === undefined ? null : parseModelId(latestId);
  if (latestParsed === null) return "unknown";
  const cmp = compareModelIds(id, latestParsed);
  if (cmp < 0) return "older";
  if (cmp > 0) return "unknown";
  const listed = (latest.ids ?? Object.values(latest.models) as string[]).map(parseModelId).filter((m): m is ModelId => m !== null);
  return isListed(id, listed) ? "same" : "unknown";
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
      const latestId = pin === null || latest === null ? null : (latest.models[pin.family] ?? null);
      const v = judge(pin, latest);
      if (v === "older") return { ...base, status: "behind", latest: latestId };
      // An alias-derived latest is unverified, so a pin at it is not shown to be current.
      return { ...base, status: v === "same" && latest!.source !== "alias" ? "current" : "unknown", latest: latestId };
    }
    const family = f.value as Family;
    const latestId = latest === null ? null : (latest.models[family] ?? null);
    if (latest === null || latest.source === "alias") return { ...base, status: "unknown", latest: latestId };
    const resolvedId = resolved[family] ?? null;
    const v = judge(resolvedId === null ? null : parseModelId(resolvedId), latest);
    return { ...base, status: v === "older" ? "stale-alias" : v === "same" ? "current" : "unknown", latest: latestId };
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
    return Object.keys(models).length === 0 ? null : { source: "api", models, ids: ids.filter((i) => parseModelId(i) !== null) };
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
    // Exactly one model must be reported, and it must be the alias's family. Several models (a
    // fallback, or a background call on another tier) leave the alias's own model undetermined.
    const ids = Object.keys(usage).map((k) => k.replace(/\[[^\]]*\]$/, ""));
    if (ids.length !== 1) return null;
    return parseModelId(ids[0]!)?.family === alias ? ids[0]! : null;
  } catch {
    return null;
  }
}

// The child is not told which project it runs for, so a SessionStart hook in it cannot act on one.
// It also gets no API key, auth token or endpoint override, so it authenticates as the logged-in
// account the operator dispatches with rather than as whatever account a key in this shell names.
const CHILD_ENV_DROPPED = new Set(["CLAUDE_PROJECT_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
export function claudeChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !CHILD_ENV_DROPPED.has(k)) out[k] = v;
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
  ".git", "node_modules", "runs", "worktrees", "projects", "file-history", "plugins", "debug", "backups", "superpowers", ".superpowers",
];
const MAX_BYTES = 2 * 1024 * 1024;

interface FoundFile {
  abs: string;
  shown: string;
}

// What the walk and scan covered. An unreadable file or directory is never dropped silently: it
// becomes an unknown row naming the path and the error class (never contents), so the exit code
// reflects it.
interface Coverage {
  scanned: number;
  skipped: number; // entries not read, each with an unknown row
  excluded: number; // deliberate exclusions: .jsonl, backup names, default and --exclude directories
  unread: Row[];
}

// Deliberately excluded files: JSON-lines logs, and backup names (ending in .bak, or carrying a
// .bak.<suffix> segment). A name that merely contains the letters, such as deploy.bake.json, is not one.
function excludedFile(name: string): boolean {
  return name.endsWith(".jsonl") || /\.bak(?:\.|$)/.test(name);
}

// The error's code (EACCES, EPERM, ...) when it is a plain upper-case token, else a generic word.
// Message text is never used, because it can carry a path or contents.
function errorClass(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code) ? code : "error";
}

function unreadableRow(shown: string, e: unknown): Row {
  return { status: "unknown", file: shown, line: 0, value: `unreadable: ${errorClass(e)}`, latest: null };
}

function notReadRow(shown: string, why: string): Row {
  return { status: "unknown", file: shown, line: 0, value: `not read: ${why}`, latest: null };
}

function walk(abs: string, shown: string, excludes: Set<string>, out: FoundFile[], cov: Coverage): void {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    cov.unread.push(unreadableRow(shown, e));
    return;
  }
  for (const e of entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const childAbs = join(abs, e.name);
    const childShown = `${shown.replace(/[\\/]$/, "")}/${e.name}`;
    if (e.isSymbolicLink() || !(e.isDirectory() || e.isFile())) {
      // Not followed, so not read. Counted, and an unknown row so the run cannot read as clean.
      cov.skipped++;
      cov.unread.push(notReadRow(childShown, e.isSymbolicLink() ? "symlink" : "special file"));
      continue;
    }
    if (e.isDirectory()) {
      if (excludes.has(e.name)) cov.excluded++;
      else walk(childAbs, childShown, excludes, out, cov);
    } else if (e.isFile()) {
      if (excludedFile(e.name)) cov.excluded++;
      else out.push({ abs: childAbs, shown: childShown });
    }
  }
}

// Windows tools save UTF-16 with a byte order mark, which is full of NUL bytes but is text that can
// hold a pin. Returns null for anything without that mark.
function decodeUtf16(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
    return swapped.toString("utf16le");
  }
  return null;
}

function scanFile(f: FoundFile, readFile: (path: string) => Buffer, cov: Coverage): Finding[] {
  try {
    if (statSync(f.abs).size > MAX_BYTES) {
      cov.skipped++;
      cov.unread.push(notReadRow(f.shown, "over 2 MB"));
      return [];
    }
    const buf = readFile(f.abs);
    const text = decodeUtf16(buf);
    if (text === null && buf.includes(0)) {
      cov.skipped++;
      cov.unread.push(notReadRow(f.shown, "NUL byte"));
      return [];
    }
    cov.scanned++;
    return scanText(f.shown, text ?? buf.toString("utf8"));
  } catch (e) {
    cov.unread.push(unreadableRow(f.shown, e));
    return [];
  }
}

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  runClaude: ClaudeRunner;
  // Test seam for file reads. Defaults to readFileSync.
  readFile?: (path: string) => Buffer;
}

const USAGE = "usage: bun tools/model-currency/check.ts [--root <dir-or-file>]... [--exclude <name>]... [--latest <file.json>] [--no-resolve]";

function readLatestFile(path: string): LatestTable | null {
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const ids: string[] = [];
    for (const f of FAMILIES) {
      const v = obj[f];
      for (const id of Array.isArray(v) ? v : [v]) {
        if (typeof id === "string" && parseModelId(id)?.family === f) ids.push(id);
      }
    }
    const models = latestByFamily(ids);
    return Object.keys(models).length === 0 ? null : { source: "file", models, ids };
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
  const cov: Coverage = { scanned: 0, skipped: 0, excluded: 0, unread: [] };
  for (const root of values.root ?? ["."]) {
    try {
      if (statSync(root).isDirectory()) walk(root, basename(resolvePath(root)), excludes, files, cov);
      else files.push({ abs: root, shown: basename(resolvePath(root)) });
    } catch {
      return fail(`cannot read root: ${root}`);
    }
  }
  const findings = files.flatMap((f) => scanFile(f, deps.readFile ?? readFileSync, cov));

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

  const rows = [...classify(findings, latest, resolved), ...cov.unread];
  const head =
    latest === null
      ? "latest source: none (latest unknown)"
      : latest.source === "alias"
        ? "latest source: alias (unverified: an alias can itself resolve to an older model)"
        : `latest source: ${latest.source}`;
  const lines = [
    head,
    ...rows.map((r) => `${r.status}\t${r.file}:${r.line}\t${r.value}\t${r.latest ?? "-"}`),
    `scanned ${cov.scanned} files, skipped ${cov.skipped}, excluded ${cov.excluded}`,
  ];

  // Nothing scanned means a mistyped or fully excluded root, which must not read as a clean pass.
  const exitCode =
    rows.some((r) => r.status === "behind" || r.status === "stale-alias")
      ? 1
      : rows.some((r) => r.status === "unknown") || latest === null || latest.source === "alias" || cov.scanned === 0
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
