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
// Residual: this file and the SKILL.md that runs it ship inside the project, so a project that rewrites them skips the check.
//
// The allowlist is ~/.claude/harness-core-checkouts under USERPROFILE, or HOME when that is unset.
// HARNESS_CORE_ALLOWLIST does not move it, because the session that runs this helper is the one a
// project would set that variable in. USERPROFILE and HOME do move it, and a session able to set
// those can already register hooks, so following them widens nothing.
// Every path is compared by its real path, so a symlink or junction cannot alias a checkout into
// the allowlist or a project directory out of the project.
//
// Fails closed: an unreadable sidecar or allowlist, a relative, UNC or unresolvable coreRepo, one
// whose real path is strictly inside this project, a coreRepo equal to the project without a
// usable pinned clone, or one without tools/publish/cli.ts prints a reason on
// stderr, nothing on stdout, and exits 1. No imports beyond node builtins, so it runs from any
// project tree.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export type Resolved = { ok: true; cli: string } | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

// A leading pair of slashes, in either direction, is a UNC share or a Windows device path
// (\\?\, \\.\). Either can reach a network host or bypass normal path parsing, so neither is
// accepted for coreRepo or the allowlist location.
function isUnc(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

function real(p: string): string | null {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return null;
  }
}

export function allowlistPath(env: Env): string | null {
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

// A self-install (Install-Harness.ps1 -Target . in agent-harness-core) records the project root as
// coreRepo. That checkout's cli.ts is whatever branch is checked out, so it is never run. The
// helper resolves to the pinned tool clone review-merge already runs from, <home>/.claude-publish/tool,
// and only when that clone's real path is outside the project and holds tools/publish/cli.ts.
const PINNED = "<home>/.claude-publish/tool";

function pinnedClone(root: string, env: Env, fold: (p: string) => string): Resolved {
  const home = env.USERPROFILE || env.HOME;
  if (!home || isUnc(home) || !isAbsolute(home)) {
    return { ok: false, reason: `coreRepo is this project, and the pinned clone ${PINNED} cannot be located (USERPROFILE and HOME are unset, relative or UNC)` };
  }
  const clone = real(join(home, ".claude-publish", "tool"));
  if (!clone || isUnc(clone) || !isDir(clone)) return { ok: false, reason: `coreRepo is this project, and the pinned clone ${PINNED} does not exist` };
  if (fold(clone).startsWith(fold(root))) return { ok: false, reason: `coreRepo is this project, and the pinned clone ${PINNED} is inside this project` };
  const cli = join(clone, "tools", "publish", "cli.ts");
  if (!existsSync(cli)) return { ok: false, reason: `coreRepo is this project, and the pinned clone ${PINNED} holds no tools/publish/cli.ts` };
  return { ok: true, cli };
}

// `allowlistOverride` is a test seam: the command entry point below never passes it.
export function resolveCore(projectRoot: string, env: Env, allowlistOverride?: string): Resolved {
  const sidecar = join(projectRoot, ".claude", ".harness-manifest.local.json");
  let coreRepo: unknown;
  try {
    coreRepo = (JSON.parse(readFileSync(sidecar, "utf8")) as { coreRepo?: unknown }).coreRepo;
  } catch {
    return { ok: false, reason: "the sidecar .claude/.harness-manifest.local.json is missing or unreadable" };
  }
  if (typeof coreRepo !== "string" || coreRepo === "") return { ok: false, reason: "the sidecar names no coreRepo" };
  if (isUnc(coreRepo)) return { ok: false, reason: "coreRepo is a UNC or device path" };
  if (!isAbsolute(coreRepo)) return { ok: false, reason: "coreRepo is not an absolute path" };
  const core = real(coreRepo);
  if (!core || isUnc(core)) return { ok: false, reason: "coreRepo does not resolve to a local real path" };
  if (!isDir(core)) return { ok: false, reason: "coreRepo is not a directory" };

  // Case-folded, as in session-start-drift-check.sh: on Windows a case variant of the project
  // root resolves, and an exact compare would miss a path that is genuinely inside it.
  const root = real(projectRoot);
  if (!root) return { ok: false, reason: "the project root does not resolve to a real path" };
  const fold = (p: string) => (p.endsWith(sep) ? p : p + sep).toLowerCase();
  if (fold(core) === fold(root)) return pinnedClone(root, env, fold);
  if (fold(core).startsWith(fold(root))) return { ok: false, reason: "coreRepo is inside this project" };

  // Check the raw home before join(): on POSIX, join() collapses a leading // and hides a UNC form.
  const home = allowlistOverride ?? (env.USERPROFILE || env.HOME);
  const list = allowlistOverride ?? allowlistPath(env);
  if (!home || !list) return { ok: false, reason: "no checkout allowlist location (USERPROFILE and HOME are both unset)" };
  if (isUnc(home) || !isAbsolute(home)) return { ok: false, reason: "the checkout allowlist location is relative or a UNC path" };
  let text: string;
  try {
    text = readFileSync(list, "utf8");
  } catch {
    return { ok: false, reason: "the checkout allowlist cannot be read" };
  }
  // Exact compare of real paths on both sides, no case fold. The native real path already
  // carries the on-disk case, and a miss fails closed.
  const listed = text
    .split(/\r?\n/)
    .filter((l) => l !== "" && isAbsolute(l) && !isUnc(l))
    .some((l) => real(l) === core);
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
