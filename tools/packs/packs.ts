// Pack generator (#254). One source file, packs.json at the repo root, is the only place a pack's
// identity lives. Everything under packs/ and the marketplace manifest are generated from it plus the
// member files it names, so the two harnesses cannot see two different packs.
//
// Invariant: every generated manifest and component tree is a pure function of packs.json and the
// member sources. `checkTree` compares that function's output with the disk and reports any
// divergence, and `writePlan` materialises the same plan, so check and write cannot disagree about
// what the output should be.
//
// What it emits per pack, and nothing else:
//   packs/<id>/.claude-plugin/plugin.json   name, version, description, optional author, license,
//                                           homepage, repository, keywords
//   packs/<id>/skills/<name>/...            copied from a member skill directory
//   packs/<id>/agents/<name>.md             copied from a member agent file
//   packs/<id>/hooks/...                    copied from a member hook bundle (hooks.json plus scripts)
//   .claude-plugin/marketplace.json         one entry per pack, name and version from the same source
//
// The shape is the minimal set measured live in both Claude Code 2.1.287 and Copilot CLI 1.0.89 (#254).
// Components sit at their default paths and the manifest carries no skills, agents or hooks field, so
// each trap in that measurement is unreachable by construction instead of guarded one at a time:
//   - Only .claude-plugin/plugin.json is written. A root plugin.json is invisible to Claude and
//     preferred by Copilot, so a second manifest would give the pack two identities. Any such file
//     under packs/ reads as drift.
//   - `agents` as a directory string drops the whole plugin in Claude, and a `hooks` array is rejected
//     by Copilot. Neither field is ever emitted.
//   - Copilot-native hooks are silently ignored by Claude. A hook bundle must be Claude format and
//     is refused otherwise.
//   - Two plugins with one name resolve differently in each CLI, so duplicate ids are refused.
//   - A skill whose frontmatter name differs from its directory is shown differently by the two CLIs,
//     so the two must match.
//
// Members are read from what the index tracks, never from whatever sits in the working tree. An
// untracked or ignored file inside a member directory (a scratch note, a plugin-synced copy under a
// nested synced/ directory) would otherwise be copied into packs/, which is committed and published.
// Outside a work tree the generator refuses rather than guessing what is tracked.
//
// A member never carries a link, a dot entry, a .local.md overlay or a path under skills/synced.
// packs/ is committed output, so anything copied into it is published.
//
// Not emitted, deliberately: `dependsOn`. It is validated here (target exists, no cycle) and kept in
// packs.json for the install order a later step needs, but neither CLI's handling of a dependency
// field was measured, and an unknown manifest key is ignored by both. `tier` is likewise source-only
// and decides what may live in this public repo: a `private` pack is refused outright, since client
// packs belong in a private overlay and never here.
//
// packs/ is generated, never hand-edited. packs.json is the one file to change, then run
// `bun tools/packs/cli.ts` to regenerate. `bun test` runs the drift check, so CI fails on a stale tree.

import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, posix, sep } from "node:path";
import { findIdentityHits, type IdentityDecl } from "../pr-review/identity";

export const SOURCE_FILE = "packs.json";
export const PACKS_DIR = "packs";
export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
const MANIFEST_PATH = ".claude-plugin/plugin.json";

/** A source or output problem. The CLI exits 2 on one and writes nothing. */
export class PackError extends Error {}

export type Tier = "core" | "domain";

export interface PackDef {
  id: string;
  version: string;
  description: string;
  tier: Tier;
  dependsOn: string[];
  skills: string[];
  agents: string[];
  hooks: string | null;
  author: string | null;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  keywords: string[] | null;
}

export interface PackSource {
  marketplace: { name: string; owner: string; description: string };
  packs: PackDef[];
}

/** Repo-relative POSIX path to the exact bytes the generator wants there. */
export type Plan = Map<string, Buffer>;

export interface Drift {
  kind: "missing" | "changed" | "extra";
  path: string;
}

function fail(message: string): never {
  throw new PackError(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// An unknown key is refused rather than ignored. A misspelt `dependsOn` or `skill` would otherwise
// load as a pack that quietly lacks what the author meant (the same silent-typo failure as an
// unrecognised agent frontmatter key).
function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}" (allowed: ${allowed.join(", ")})`);
  }
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") fail(`${where}: "${key}" must be a non-empty string`);
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string, where: string): string | null {
  return obj[key] === undefined ? null : requireString(obj, key, where);
}

function stringList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.length === 0) fail(`${where} must be a non-empty array of strings`);
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string" || item.trim() === "") fail(`${where} must hold non-empty strings only`);
    if (seen.has(item)) fail(`${where} lists ${JSON.stringify(item)} twice`);
    seen.add(item);
  }
  return v as string[];
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const PACK_KEYS = [
  "id",
  "version",
  "description",
  "tier",
  "dependsOn",
  "members",
  "author",
  "license",
  "homepage",
  "repository",
  "keywords",
] as const;
const MEMBER_KEYS = ["skills", "agents", "hooks"] as const;

function checkId(id: string, where: string): void {
  if (!ID_RE.test(id) || id.length > 64) {
    fail(`${where}: id ${JSON.stringify(id)} must be lowercase kebab-case, 64 characters at most (Claude rejects names with spaces)`);
  }
}

function parsePack(raw: unknown, index: number): PackDef {
  const where = `packs[${index}]`;
  if (!isRecord(raw)) fail(`${where} must be an object`);
  onlyKeys(raw, PACK_KEYS, where);
  const id = requireString(raw, "id", where);
  checkId(id, where);
  const at = `pack ${id}`;
  const version = requireString(raw, "version", at);
  if (!SEMVER_RE.test(version)) fail(`${at}: version ${JSON.stringify(version)} must be MAJOR.MINOR.PATCH`);
  const tier = requireString(raw, "tier", at);
  if (tier === "private") {
    fail(`${at}: tier "private" is refused here. Client packs belong in a private overlay repository, never this public one`);
  }
  if (tier !== "core" && tier !== "domain") fail(`${at}: tier must be "core" or "domain"`);

  const members = raw.members;
  if (!isRecord(members)) fail(`${at}: "members" must be an object`);
  onlyKeys(members, MEMBER_KEYS, `${at} members`);
  const skills = members.skills === undefined ? [] : stringList(members.skills, `${at} members.skills`);
  const agents = members.agents === undefined ? [] : stringList(members.agents, `${at} members.agents`);
  const hooks = optionalString(members, "hooks", `${at} members`);
  if (skills.length + agents.length === 0 && hooks === null) {
    fail(`${at}: a pack with no members installs nothing, so it is refused`);
  }

  let author: string | null = null;
  if (raw.author !== undefined) {
    if (!isRecord(raw.author)) fail(`${at}: "author" must be an object with a "name"`);
    onlyKeys(raw.author, ["name"], `${at} author`);
    author = requireString(raw.author, "name", `${at} author`);
  }

  return {
    id,
    version,
    description: requireString(raw, "description", at),
    tier,
    dependsOn: raw.dependsOn === undefined ? [] : stringList(raw.dependsOn, `${at} dependsOn`),
    skills,
    agents,
    hooks,
    author,
    license: optionalString(raw, "license", at),
    homepage: optionalString(raw, "homepage", at),
    repository: optionalString(raw, "repository", at),
    keywords: raw.keywords === undefined ? null : stringList(raw.keywords, `${at} keywords`),
  };
}

function checkDependencies(packs: readonly PackDef[]): void {
  const byId = new Map(packs.map((p) => [p.id, p]));
  for (const pack of packs) {
    for (const dep of pack.dependsOn) {
      if (dep === pack.id) fail(`pack ${pack.id}: dependsOn lists the pack itself`);
      if (!byId.has(dep)) fail(`pack ${pack.id}: dependsOn names ${JSON.stringify(dep)}, which is not a pack here`);
    }
  }
  // Depth-first with a path set. A node reached again while still on the path is a cycle.
  const done = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (path.includes(id)) fail(`dependsOn cycle: ${[...path, id].join(" -> ")}`);
    if (done.has(id)) return;
    for (const dep of byId.get(id)!.dependsOn) visit(dep, [...path, id]);
    done.add(id);
  };
  for (const pack of packs) visit(pack.id, []);
}

export function loadSource(root: string): PackSource {
  let text: string;
  try {
    text = readFileSync(join(root, SOURCE_FILE), "utf8");
  } catch {
    return fail(`${SOURCE_FILE} not found at the repo root`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return fail(`${SOURCE_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(doc)) fail(`${SOURCE_FILE} must hold a JSON object`);
  onlyKeys(doc, ["schema", "marketplace", "packs"], SOURCE_FILE);
  if (doc.schema !== 1) fail(`${SOURCE_FILE}: "schema" must be 1`);
  const mk = doc.marketplace;
  if (!isRecord(mk)) fail(`${SOURCE_FILE}: "marketplace" must be an object`);
  onlyKeys(mk, ["name", "owner", "description"], "marketplace");
  const mkName = requireString(mk, "name", "marketplace");
  checkId(mkName, "marketplace");
  const owner = requireString(mk, "owner", "marketplace");
  const mkDescription = requireString(mk, "description", "marketplace");
  if (!Array.isArray(doc.packs)) fail(`${SOURCE_FILE}: "packs" must be an array`);
  const packs = doc.packs.map((p, i) => parsePack(p, i));
  const ids = new Set<string>();
  for (const pack of packs) {
    if (ids.has(pack.id)) fail(`duplicate pack name ${JSON.stringify(pack.id)} (Copilot skips the second, Claude loads both with mixed precedence)`);
    ids.add(pack.id);
  }
  checkDependencies(packs);
  return { marketplace: { name: mkName, owner, description: mkDescription }, packs };
}

// A member path is repo-relative, forward-slashed, and plain. A dot segment covers .., .git, the
// gitignored installed copy under .claude/ and skills/.trash alike, and none of them is content a
// second checkout would have. packs/ is the generator's own output.
function checkSourcePath(rel: string, where: string): void {
  const parts = rel.split("/");
  if (
    rel.includes("\\") ||
    isAbsolute(rel) ||
    /^[A-Za-z]:/.test(rel) ||
    parts.some((s) => s === "" || s.startsWith(".") || s === "node_modules")
  ) {
    fail(`${where}: ${JSON.stringify(rel)} must be a plain repo-relative path with forward slashes and no dot or node_modules segment`);
  }
  if (parts[0] === PACKS_DIR) fail(`${where}: ${JSON.stringify(rel)} is under ${PACKS_DIR}/, which is generated output`);
  // Plugin-synced third-party skills are gitignored under account/claude/skills/synced and some are
  // proprietary (#252). packs/ is not ignored, so a copy generated from one would be committed.
  if (parts.includes("synced")) fail(`${where}: ${JSON.stringify(rel)} names a synced skill, which is third-party and never published`);
}

/** Repo-relative POSIX paths of every file in the index under root. Refuses outside a work tree. */
function trackedFiles(root: string): Set<string> {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached"], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error !== undefined || r.status !== 0) {
    return fail("cannot list tracked files: the root is not a work tree, and members are read from the index only");
  }
  return new Set(r.stdout.toString("utf8").split("\0").filter((p) => p !== ""));
}

function resolveMember(root: string, rel: string, kind: "dir" | "file", where: string): string {
  checkSourcePath(rel, where);
  const abs = join(root, ...rel.split("/"));
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (st === undefined) return fail(`${where}: ${rel} does not exist`);
  if (st.isSymbolicLink()) fail(`${where}: ${rel} is a symbolic link`);
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) fail(`${where}: ${rel} must be a ${kind === "dir" ? "directory" : "file"}`);
  // A symlinked ancestor can still lead out of the checkout while the leaf looks plain.
  if (!realpathSync(abs).startsWith(realpathSync(root) + sep)) fail(`${where}: ${rel} resolves outside the repository`);
  return abs;
}

// Files under a member directory in a stable order. Dot entries and __pycache__ are skipped so an
// editor or interpreter leaving junk in a working tree cannot change the output. A .local.md file
// is one machine's overlay, which the exporter and .gitignore both keep out of the repository, so
// it is skipped here too. A link would let a member copy bytes from outside the tree, so one is
// refused instead of followed.
function listFiles(abs: string, rel: string, where: string, tracked: Set<string>, base: string, out: string[] = []): string[] {
  const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "__pycache__" || e.name.endsWith(".local.md")) continue;
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink()) fail(`${where}: ${childRel} is a symbolic link`);
    if (e.isDirectory()) listFiles(join(abs, e.name), childRel, where, tracked, base, out);
    else if (e.isFile()) {
      if (tracked.has(`${base}/${childRel}`)) out.push(childRel);
    }
    else fail(`${where}: ${childRel} is not a regular file`);
  }
  return out;
}

/** Top-level `name:` of a frontmatter block. Same column-0 line match the agent frontmatter test uses. */
export function frontmatterName(text: string): string | null {
  const fm = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (fm === undefined) return null;
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^name\s*:\s*(.*?)\s*$/);
    if (m) return m[1]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return null;
}

// A text file reads the same in a CRLF working tree and an LF index, so both sides of every
// comparison and every write go through here. A file holding a NUL byte is binary and untouched.
export function normalizeEol(data: Buffer): Buffer {
  if (data.includes(0)) return data;
  const out = Buffer.allocUnsafe(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0d && data[i + 1] === 0x0a) continue;
    out[n++] = data[i]!;
  }
  return out.subarray(0, n);
}

// Claude format only. The hook array and the Copilot-native shape both load silently wrong in one
// CLI (#254), and only the command form was measured, so anything else is refused.
function checkHooksJson(text: string, where: string): void {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return fail(`${where}: hooks.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(doc) || !isRecord(doc.hooks)) {
    fail(`${where}: hooks.json must be an object whose "hooks" is an object (Copilot rejects an array)`);
  }
  if ("version" in doc) fail(`${where}: hooks.json carries "version", the Copilot-native format, which Claude ignores silently`);
  for (const [event, groups] of Object.entries(doc.hooks)) {
    if (!/^[A-Z]/.test(event)) fail(`${where}: hook event ${JSON.stringify(event)} is not PascalCase, the Claude format`);
    if (!Array.isArray(groups)) fail(`${where}: hook event ${event} must hold an array of groups`);
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) fail(`${where}: hook event ${event} holds a group without a "hooks" array`);
      for (const h of group.hooks) {
        if (!isRecord(h) || h.type !== "command" || typeof h.command !== "string" || "bash" in h || "powershell" in h) {
          fail(`${where}: hook event ${event} must hold only {"type": "command", "command": "..."} entries`);
        }
      }
    }
  }
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function manifestOf(pack: PackDef): Record<string, unknown> {
  const m: Record<string, unknown> = { name: pack.id, version: pack.version, description: pack.description };
  if (pack.author !== null) m.author = { name: pack.author };
  if (pack.license !== null) m.license = pack.license;
  if (pack.homepage !== null) m.homepage = pack.homepage;
  if (pack.repository !== null) m.repository = pack.repository;
  if (pack.keywords !== null) m.keywords = pack.keywords;
  return m;
}

/** Everything the generator would write, validated. Throws PackError before any file is touched. */
export function buildPlan(root: string): Plan {
  const source = loadSource(root);
  const plan: Plan = new Map();
  const tracked = trackedFiles(root);
  const needTracked = (rel: string, where: string): void => {
    if (!tracked.has(rel)) fail(`${where}: ${rel} is not tracked`);
  };
  const put = (path: string, data: Buffer): void => {
    if (plan.has(path)) fail(`two members write ${path}`);
    plan.set(path, normalizeEol(data));
  };

  for (const pack of source.packs) {
    const base = `${PACKS_DIR}/${pack.id}`;
    put(`${base}/${MANIFEST_PATH}`, json(manifestOf(pack)));

    for (const rel of pack.skills) {
      const where = `pack ${pack.id}: skill ${rel}`;
      const dir = resolveMember(root, rel, "dir", where);
      const name = posix.basename(rel);
      needTracked(`${rel}/SKILL.md`, where);
      const skillMd = join(dir, "SKILL.md");
      if (!lstatSync(skillMd, { throwIfNoEntry: false })?.isFile()) fail(`${where}: no SKILL.md`);
      const declared = frontmatterName(readFileSync(skillMd, "utf8"));
      if (declared !== name) {
        fail(`${where}: SKILL.md name ${JSON.stringify(declared)} must equal its directory ${JSON.stringify(name)}`);
      }
      for (const f of listFiles(dir, "", where, tracked, rel)) put(`${base}/skills/${name}/${f}`, readFileSync(join(dir, ...f.split("/"))));
    }

    for (const rel of pack.agents) {
      const where = `pack ${pack.id}: agent ${rel}`;
      const file = resolveMember(root, rel, "file", where);
      needTracked(rel, where);
      const fileName = posix.basename(rel);
      if (!fileName.endsWith(".md")) fail(`${where}: an agent member must be a .md file`);
      const name = fileName.slice(0, -3);
      const declared = frontmatterName(readFileSync(file, "utf8"));
      if (declared !== name) {
        fail(`${where}: frontmatter name ${JSON.stringify(declared)} must equal the file name ${JSON.stringify(name)}`);
      }
      put(`${base}/agents/${fileName}`, readFileSync(file));
    }

    if (pack.hooks !== null) {
      const where = `pack ${pack.id}: hooks ${pack.hooks}`;
      const dir = resolveMember(root, pack.hooks, "dir", where);
      needTracked(`${pack.hooks}/hooks.json`, where);
      const hooksJson = join(dir, "hooks.json");
      if (!lstatSync(hooksJson, { throwIfNoEntry: false })?.isFile()) fail(`${where}: no hooks.json`);
      checkHooksJson(readFileSync(hooksJson, "utf8"), where);
      for (const f of listFiles(dir, "", where, tracked, pack.hooks)) put(`${base}/hooks/${f}`, readFileSync(join(dir, ...f.split("/"))));
    }
  }

  put(
    MARKETPLACE_PATH,
    json({
      name: source.marketplace.name,
      owner: { name: source.marketplace.owner },
      metadata: { description: source.marketplace.description },
      plugins: source.packs.map((p) => ({
        name: p.id,
        source: `./${PACKS_DIR}/${p.id}`,
        description: p.description,
        version: p.version,
      })),
    }),
  );
  return plan;
}

/**
 * Identity gate for the public payload (security.md: a generator of public payloads refuses
 * identifying strings itself). Scans every planned path and every planned buffer with the matcher
 * the PR reviewer uses (tools/pr-review/identity.ts). Returns the classes that hit and the paths
 * whose content hit. A path that itself hits is counted but never listed.
 */
export function scanPlan(plan: Plan, decl: IdentityDecl): { classes: string[]; paths: string[] } {
  const classes = new Set<string>();
  const paths: string[] = [];
  for (const [path, data] of plan) {
    const pathHits = findIdentityHits(path, decl);
    const bodyHits = findIdentityHits(data.toString("utf8"), decl);
    pathHits.forEach((c) => classes.add(c));
    bodyHits.forEach((c) => classes.add(c));
    if (pathHits.length > 0) paths.push("(a path that itself carries one)");
    else if (bodyHits.length > 0) paths.push(path);
  }
  return { classes: [...classes].sort(), paths };
}

// Every file under packs/ as found, plus the marketplace manifest. null marks something that is not
// a regular file (a link or a device), which can never match the plan.
function readDisk(root: string): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else out.set(childRel, e.isFile() ? readFileSync(join(abs, e.name)) : null);
    }
  };
  const packs = lstatSync(join(root, PACKS_DIR), { throwIfNoEntry: false });
  if (packs !== undefined) {
    if (packs.isDirectory()) walk(join(root, PACKS_DIR), PACKS_DIR);
    else out.set(PACKS_DIR, null);
  }
  const mk = lstatSync(join(root, ...MARKETPLACE_PATH.split("/")), { throwIfNoEntry: false });
  if (mk !== undefined) out.set(MARKETPLACE_PATH, mk.isFile() ? readFileSync(join(root, ...MARKETPLACE_PATH.split("/"))) : null);
  return out;
}

/** What differs between the plan and the disk, sorted by path. Empty means in sync. */
export function checkTree(root: string, plan: Plan): Drift[] {
  const disk = readDisk(root);
  const drift: Drift[] = [];
  for (const [path, want] of plan) {
    const have = disk.get(path);
    if (have === undefined) drift.push({ kind: "missing", path });
    else if (have === null || !normalizeEol(have).equals(want)) drift.push({ kind: "changed", path });
  }
  for (const path of disk.keys()) if (!plan.has(path)) drift.push({ kind: "extra", path });
  return drift.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Replaces packs/ and the marketplace manifest with the plan. packs/ is owned wholly by the generator. */
export function writePlan(root: string, plan: Plan): void {
  const packs = join(root, PACKS_DIR);
  const st = lstatSync(packs, { throwIfNoEntry: false });
  if (st !== undefined && !st.isDirectory()) fail(`${PACKS_DIR} exists and is not a plain directory`);
  const mk = lstatSync(join(root, ...MARKETPLACE_PATH.split("/")), { throwIfNoEntry: false });
  if (mk !== undefined && !mk.isFile()) fail(`${MARKETPLACE_PATH} exists and is not a regular file`);
  if (st !== undefined) rmSync(packs, { recursive: true, force: true });
  for (const [path, data] of plan) {
    const abs = join(root, ...path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  }
}
