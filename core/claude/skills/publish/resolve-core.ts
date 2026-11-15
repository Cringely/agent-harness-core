#!/usr/bin/env bun
// Publish skill helper: prints the absolute path of tools/publish/cli.ts in the core checkout
// this project was installed from, or refuses. Run it before every publish command:
//
//   bun --cwd <home>/.claude-publish/work <project>/.claude/skills/publish/resolve-core.ts <project>
//
// SECURITY: coreRepo comes from .claude/.harness-manifest.local.json, which a project can write
// (a force-added sidecar, or a tracked manifest the installer carries forward). Running cli.ts
// from whatever it names would run project-chosen code in a session that holds the gh login. So
// the checkout must be on the per-user allowlist in the profile, outside every repo, the same
// list session-start-drift-check.sh requires and Install-Harness.ps1 appends to. The check lives
// here and not in cli.ts, because a check inside the checkout being vetted is skipped by any
// checkout that leaves it out.
//
// Fails closed: an unreadable sidecar or allowlist, a relative or missing coreRepo, one inside
// this project, or one without tools/publish/cli.ts prints a reason on stderr, nothing on
// stdout, and exits 1. No imports beyond node builtins, so it runs from any project tree.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export type Resolved = { ok: true; cli: string } | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

export function allowlistPath(env: Env): string | null {
  if (env.HARNESS_CORE_ALLOWLIST) return env.HARNESS_CORE_ALLOWLIST;
  const home = env.USERPROFILE || env.HOME;
  return home ? join(home, ".claude", "harness-core-checkouts") : null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function resolveCore(projectRoot: string, env: Env): Resolved {
  const sidecar = join(projectRoot, ".claude", ".harness-manifest.local.json");
  let coreRepo: unknown;
  try {
    coreRepo = (JSON.parse(readFileSync(sidecar, "utf8")) as { coreRepo?: unknown }).coreRepo;
  } catch {
    return { ok: false, reason: "the sidecar .claude/.harness-manifest.local.json is missing or unreadable" };
  }
  if (typeof coreRepo !== "string" || coreRepo === "") return { ok: false, reason: "the sidecar names no coreRepo" };
  if (!isAbsolute(coreRepo)) return { ok: false, reason: "coreRepo is not an absolute path" };
  const core = resolve(coreRepo);
  if (!isDir(core)) return { ok: false, reason: "coreRepo is not a directory" };

  // Case-folded, as in session-start-drift-check.sh: on Windows a case variant of the project
  // root resolves, and an exact compare would miss a path that is genuinely inside it.
  const root = resolve(projectRoot);
  const fold = (p: string) => (p.endsWith(sep) ? p : p + sep).toLowerCase();
  if (fold(core).startsWith(fold(root))) return { ok: false, reason: "coreRepo is inside this project" };

  const list = allowlistPath(env);
  if (!list) return { ok: false, reason: "no checkout allowlist location (HARNESS_CORE_ALLOWLIST, USERPROFILE and HOME are all unset)" };
  let text: string;
  try {
    text = readFileSync(list, "utf8");
  } catch {
    return { ok: false, reason: "the checkout allowlist cannot be read" };
  }
  // Exact compare after the same normalization on both sides, no case fold: the installer wrote
  // the sidecar and the allowlist entry from one string, and a miss fails closed.
  const listed = text
    .split(/\r?\n/)
    .filter((l) => l !== "" && isAbsolute(l))
    .some((l) => resolve(l) === core);
  if (!listed) return { ok: false, reason: "coreRepo is not on the checkout allowlist (re-run install/Install-Harness.ps1 from your core checkout)" };

  const cli = join(core, "tools", "publish", "cli.ts");
  if (!existsSync(cli)) return { ok: false, reason: "coreRepo holds no tools/publish/cli.ts" };
  return { ok: true, cli };
}

if (import.meta.main) {
  const project = process.argv[2];
  const r: Resolved = project ? resolveCore(project, process.env) : { ok: false, reason: "usage: resolve-core.ts <project root>" };
  if (r.ok) {
    process.stdout.write(`${r.cli}\n`);
  } else {
    process.stderr.write(`resolve-core: ${r.reason}. Stop and ask the operator.\n`);
    process.exit(1);
  }
}
