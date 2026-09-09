// A POSIX sh to run a hook with, shared by pre-commit.test.ts, identity-gate.test.ts and
// session-start-drift-check.test.ts. All three run a shell hook with no exported core to
// unit test, so every case builds a real project and spawns the hook through `sh`.
//
// Not named *.test.ts on purpose: bun test's default discovery only picks up *.test.{ts,tsx,js,jsx}
// and *_test.{...}, so this file is a plain module rather than a fourth suite.
//
// Always resolved to an absolute path, never returned as the bare string "sh": some cases spawn
// the hook with a child PATH that carries none of the ambient PATH, and a bare name would then
// resolve only against whatever PATH the child happens to get. On Unix and on Git Bash it resolves
// off the ambient PATH; a PowerShell or cmd session on Windows has none there, so fall back to the
// one git ships, located from `git --exec-path` rather than a hardcoded Program Files path so it
// survives a non-default install.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let cachedSh: string | undefined;
/** Set only when sh came from git's own directory. A hook's subprocesses (sed, tr, awk, grep)
 * live beside that sh rather than on PATH, so a caller spawning the hook with a stripped-down
 * PATH needs this appended too, or the hook runs but its own subprocesses do not. */
let cachedShDir: string | undefined;

export function posixSh(): string {
  if (cachedSh) return cachedSh;
  try {
    // Bun signals a missing binary by throwing on some platforms and by returning
    // success:false on others, so check both.
    const probe = Bun.spawnSync(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    const resolved = probe.success && Bun.which("sh");
    if (resolved) return (cachedSh = resolved);
  } catch {
    // not on PATH; fall through to git's copy
  }
  const out = Bun.spawnSync(["git", "--exec-path"], { stdout: "pipe", stderr: "pipe" });
  const execPath = new TextDecoder().decode(out.stdout).trim();
  const root = execPath.replace(/[\\/](?:mingw\d*|usr|clang\d*)[\\/]libexec[\\/]git-core[\\/]?$/i, "");
  const candidate = join(root, "usr", "bin", "sh.exe");
  if (existsSync(candidate)) {
    cachedShDir = dirname(candidate);
    return (cachedSh = candidate);
  }
  throw new Error(`no POSIX sh found: not on PATH, and no sh.exe at ${candidate} (git --exec-path was "${execPath}")`);
}

/** The directory holding the fallback sh, or undefined when sh resolved off the ambient PATH.
 * Only meaningful after posixSh() has run once. */
export function posixShDir(): string | undefined {
  return cachedShDir;
}
