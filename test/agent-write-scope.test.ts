// Offline tests for the scratch-scope PreToolUse gate
// (core/claude/hooks/agent-write-scope.ts). The decision logic is in the
// exported pure inScratch()/decide(), so these run with no spawn, no
// filesystem, and no agent definitions on disk.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  WRITE_SCOPE_GATE_VERSION,
  claudeConfigRoots,
  decide,
  inScratch,
  readSessionCwd,
  readWriteScope,
} from "../core/claude/hooks/agent-write-scope";
import { parseWriteScope } from "../core/claude/hooks/write-scope-parse";

const HOOK = join(import.meta.dir, "..", "core", "claude", "hooks", "agent-write-scope.ts");

/**
 * Runs the hook as a real process with `stdinText` on stdin. Never goes through a shell. `env`
 * overlays the inherited environment, so a case can set CLAUDE_PROJECT_DIR.
 */
function runHook(stdinText: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, HOOK],
    stdin: new TextEncoder().encode(stdinText),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const CWD = "/home/runner/project";
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

// A backslash separates path segments only on Windows. On POSIX it is an ordinary file-name
// character, so a Windows-style literal there names ONE file in the working directory. Fixtures
// that mean "an absolute path on this host" are therefore spelled per platform, and the tests that
// pin the literal's meaning on each platform say so explicitly.
const WIN = process.platform === "win32";
const hostPath = (win: string, posix: string): string => (WIN ? win : posix);

describe("inScratch() — path classification", () => {
  test.each([
    "/tmp/claude/proj/sess/scratchpad/report.md",
    hostPath(
      "C:\\Users\\me\\AppData\\Local\\Temp\\claude\\proj\\sess\\scratchpad\\findings.md",
      "/Users/me/AppData/Local/Temp/claude/proj/sess/scratchpad/findings.md",
    ),
    "/tmp/SCRATCHPAD/case-insensitive.md",
  ])("in scope: %s", (p) => {
    expect(inScratch(p, CWD, CWD)).toBe(true);
  });

  test.each([
    "/home/runner/project/src/index.ts",
    hostPath("C:\\Users\\me\\.claude\\rules\\agent-usage.md", "/Users/me/.claude/rules/agent-usage.md"),
    "docs/STATE.md",
    "/etc/hosts",
    // Traversal out of a scratch dir resolves away from it, so it must not pass.
    "/tmp/scratchpad/../../etc/passwd",
    // A file merely NAMED scratchpad is not a scratch directory.
    "/home/runner/project/scratchpad.md",
    // Inside the project only `.claude/scratch` is scratch. Every other scratch-named folder is a
    // tracked folder the main session may load from, `.claude/skills/scratch/SKILL.md` among them.
    "/home/runner/project/.scratch/notes.md",
    "/home/runner/project/scratchpad/relative.md",
    "scratchpad/relative.md",
    "/home/runner/project/.claude/skills/scratch/SKILL.md",
    "/home/runner/project/.claude/commands/scratch/x.md",
    "/home/runner/project/.claude/rules/scratch/x.md",
    "/home/runner/project/scratch/CLAUDE.md",
    "/home/runner/project/src/scratch/a.ts",
  ])("out of scope: %s", (p) => {
    expect(inScratch(p, CWD, CWD)).toBe(false);
  });

  // The installer creates a scratch drop box at `.claude/scratch/` (see
  // install/Install-Harness.ps1). A gate that does not recognise that name denies
  // the one scratch directory the harness ships.
  test("the installer-created .claude/scratch/ is in scope", () => {
    expect(inScratch("/home/runner/project/.claude/scratch/report.md", CWD, CWD)).toBe(true);
    expect(inScratch(hostPath("C:\\repo\\.claude\\scratch\\report.md", "/repo/.claude/scratch/report.md"), CWD, CWD)).toBe(true);
  });

  // The same literal means different things per platform, and the gate must follow the host. On
  // Windows the backslashes separate segments and the path is a scratch folder outside the project.
  // On POSIX it is one file name created in the working directory, which is the project, so it is
  // not scratch. Splitting on backslashes on POSIX would call it scratch.
  test("a Windows-style literal is read with the host's separator rules", () => {
    expect(inScratch("C:\\repo\\.claude\\scratch\\report.md", CWD, CWD)).toBe(WIN);
  });

  // A backslash that is not a separator must not let a name pose as a traversal or as a scratch
  // directory on POSIX. Each of these is one file name there, in a directory that is not scratch.
  test.each([
    ["a dot-dot spelled with backslashes after a scratch name", "/home/runner/project/.claude/scratch\\..\\x.md"],
    ["a scratch name glued to a file name with a backslash", "/tmp/scratchpad\\..\\x.md"],
  ])("%s is not scratch on any host", (_label, p) => {
    expect(inScratch(p, CWD, CWD)).toBe(false);
  });

  // Widening the segment set to accept `scratch` must not drag the rest of
  // `.claude` in with it.
  test("a sibling directory under .claude stays out of scope", () => {
    expect(inScratch("/home/runner/project/.claude/agents/task-reviewer.md", CWD, CWD)).toBe(false);
  });

  test("relative paths resolve against cwd, not the filesystem root", () => {
    expect(inScratch("../../scratchpad/x.md", "/home/runner/project/sub", CWD)).toBe(true);
    expect(inScratch("../.claude/scratch/x.md", "/home/runner/project/sub", CWD)).toBe(true);
    expect(inScratch("../.scratch/x.md", "/home/runner/project/sub", CWD)).toBe(false);
    expect(inScratch("../src/x.ts", "/home/runner/project/sub", CWD)).toBe(false);
  });
});

// A project checked out under a scratch-named directory used to put every file in scope, because
// any segment matched. The rule now: a scratch-named segment counts only when it does not contain
// the project root.
describe("inScratch(): a scratch-named ancestor of the project is not scratch", () => {
  const PROJ = "/home/x/scratch/myrepo";

  test("a file inside a project that sits under a scratch directory is not scratch", () => {
    expect(inScratch(`${PROJ}/src/index.ts`, PROJ, PROJ)).toBe(false);
  });

  test("a sibling of the project under the same scratch ancestor is not scratch", () => {
    expect(inScratch("/home/x/scratch/other/f.md", PROJ, PROJ)).toBe(false);
  });

  test("inside the project only .claude/scratch counts", () => {
    expect(inScratch(`${PROJ}/.claude/scratch/r.md`, PROJ, PROJ)).toBe(true);
    expect(inScratch(`${PROJ}/scratchpad/r.md`, PROJ, PROJ)).toBe(false);
    expect(inScratch(`${PROJ}/.scratch/r.md`, PROJ, PROJ)).toBe(false);
  });

  test("a scratch directory unrelated to the project still counts", () => {
    expect(inScratch("/tmp/claude/s/scratchpad/r.md", PROJ, PROJ)).toBe(true);
  });

  test("the ancestor comparison ignores case, so a differently cased spelling is not scratch", () => {
    expect(
      inScratch("/home/x/scratch/myrepo/src/a.ts", "/home/x/Scratch/myrepo", "/home/x/Scratch/myrepo"),
    ).toBe(false);
  });

  test("a project path that merely shares a name prefix with the scratch dir does not count as contained", () => {
    // /home/x/scratch-old is not inside /home/x/scratch: segment comparison, not string prefix.
    expect(inScratch("/home/x/scratch/f.md", "/home/x/scratch-old", "/home/x/scratch-old")).toBe(true);
  });

  // Aliased spellings of a project file do not match the project's own segments, so without a
  // blanket refusal the scratch ancestor would count again and the write would be allowed.
  const tail = ["home", "x", "scratch", "myrepo", "src", "a.ts"];
  test.each([
    ["long-path prefix", BS + BS + "?" + BS + "C:" + BS + tail.join(BS)],
    ["UNC share", BS + BS + "localhost" + BS + "C$" + BS + tail.join(BS)],
    ["forward-slash UNC", "//localhost/C$/" + tail.join("/")],
    ["long-path to a scratch folder", BS + BS + "?" + BS + "C:" + BS + "tmp" + BS + "scratchpad" + BS + "r.md"],
  ])("%s is never scratch", (_label, p) => {
    expect(inScratch(p, PROJ, PROJ)).toBe(false);
    expect(decide("scratch", p, PROJ, PROJ).action).toBe("deny");
  });

  test("decide() denies a scoped write inside such a project", () => {
    expect(decide("scratch", `${PROJ}/src/index.ts`, PROJ, PROJ).action).toBe("deny");
  });
});

describe("decide() — scratch-named folders inside the project instruction paths are refused", () => {
  test.each([
    ".claude/skills/scratch/SKILL.md",
    ".claude/commands/scratch/x.md",
    ".claude/rules/scratch/x.md",
    "scratch/CLAUDE.md",
  ])("a relative write to %s is denied", (rel) => {
    const verdict = decide("scratch", rel, CWD, CWD);
    expect(verdict.action).toBe("deny");
  });

  test("the drop box under .claude/scratch is still allowed", () => {
    expect(decide("scratch", ".claude/scratch/r.md", CWD, CWD)).toEqual({ action: "allow" });
  });
});

// Real directories: the gate canonicalises the project root and the target, so a link or short-name
// alias into the project is seen for what it is. Each case would be allowed by a textual comparison.
const realTmp = realpathSync.native(tmpdir());
const linkRoot = mkdtempSync(join(realTmp, "write-scope-link-"));
afterAll(() => {
  rmSync(linkRoot, { recursive: true, force: true });
});

describe("inScratch(): an aliased spelling of a project path is never scratch", () => {
  // The project sits under a scratch-named ancestor, so its real spelling is denied by containment.
  // A link standing in for an ancestor BEFORE that segment (the Documents and Settings junction to
  // Users is the Windows case, /tmp to /private/tmp the macOS one) keeps the scratch segment in the
  // path but changes the text before it. A textual comparison sees an unrelated scratch folder.
  const real = join(linkRoot, "real");
  const proj = join(real, "scratch", "repo");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, ".claude", "scratch"), { recursive: true });

  const viaLink = join(linkRoot, "via-link");
  let linked = true;
  try {
    symlinkSync(real, viaLink, "junction");
  } catch {
    linked = false;
  }

  test("the real spelling of a source file is denied", () => {
    expect(inScratch(join(proj, "src", "a.ts"), proj, proj)).toBe(false);
  });

  test.skipIf(!linked)("the same file through a link standing in for an ancestor is denied", () => {
    expect(inScratch(join(viaLink, "scratch", "repo", "src", "a.ts"), proj, proj)).toBe(false);
  });

  test.skipIf(!linked)("a project root given through the link is canonicalised, so its real files are still denied", () => {
    const linkedProj = join(viaLink, "scratch", "repo");
    expect(inScratch(join(proj, "src", "a.ts"), linkedProj, linkedProj)).toBe(false);
  });

  test.skipIf(!linked)("a link carrying a scratch-named segment into the project is not scratch", () => {
    const scratchLink = join(linkRoot, "scratchpad");
    symlinkSync(join(proj, "src"), scratchLink, "junction");
    expect(inScratch(join(scratchLink, "new.ts"), proj, proj)).toBe(false);
  });

  // Outside the project the resolved path decides, whatever the spelling. A session scratchpad under
  // a linked temp directory (macOS /var to /private/var) must keep working.
  test.skipIf(!linked)("a scratchpad under a linked temp directory is scratch by either spelling", () => {
    const tmpReal = join(linkRoot, "tmp-real");
    const pad = join("claude", "sess", "scratchpad");
    mkdirSync(join(tmpReal, pad), { recursive: true });
    const tmpLink = join(linkRoot, "tmp-link");
    symlinkSync(tmpReal, tmpLink, "junction");
    expect(inScratch(join(tmpReal, pad, "r.md"), proj, proj)).toBe(true);
    expect(inScratch(join(tmpLink, pad, "r.md"), proj, proj)).toBe(true);
    expect(inScratch(join(tmpLink, pad, "new-dir", "r.md"), proj, proj)).toBe(true);
  });

  test.skipIf(!linked)("a scratch-named link to a folder that is not scratch is not scratch", () => {
    const plain = join(linkRoot, "plain-target");
    mkdirSync(plain, { recursive: true });
    const named = join(linkRoot, "tmp-named", "scratchpad");
    mkdirSync(dirname(named), { recursive: true });
    symlinkSync(plain, named, "junction");
    expect(inScratch(join(named, "f.md"), proj, proj)).toBe(false);
  });

  test.skipIf(!linked)("a project given by its link spelling allows its own .claude/scratch under that spelling", () => {
    const linkedProj = join(viaLink, "scratch", "repo");
    expect(inScratch(join(linkedProj, ".claude", "scratch", "r.md"), linkedProj, linkedProj)).toBe(true);
    expect(inScratch(join(linkedProj, "src", "a.ts"), linkedProj, linkedProj)).toBe(false);
  });

  test.skipIf(!linked)("the project's .claude/scratch is allowed by its real spelling and denied through a link spelling", () => {
    expect(inScratch(join(proj, ".claude", "scratch", "r.md"), proj, proj)).toBe(true);
    expect(inScratch(join(viaLink, "scratch", "repo", ".claude", "scratch", "r.md"), proj, proj)).toBe(false);
  });

  test("a file that exists is canonicalised the same way as one that does not yet", () => {
    writeFileSync(join(proj, ".claude", "scratch", "exists.md"), "x");
    expect(inScratch(join(proj, ".claude", "scratch", "exists.md"), proj, proj)).toBe(true);
    expect(inScratch(join(proj, ".claude", "scratch", "sub", "new.md"), proj, proj)).toBe(true);
  });

  // An 8.3 short name aliases a long one. Only a Windows volume with short names enabled has one,
  // and the lookup is the same call the OS makes.
  function shortPathOf(dir: string): string | null {
    if (process.platform !== "win32") return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { dlopen, ptr } = require("bun:ffi");
      const k = dlopen("kernel32.dll", { GetShortPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" } });
      const input = Buffer.from(dir + String.fromCharCode(0), "utf16le");
      const out = Buffer.alloc(2048);
      const n = k.symbols.GetShortPathNameW(ptr(input), ptr(out), 1024) as number;
      const short = n > 0 ? out.toString("utf16le", 0, n * 2) : null;
      return short !== null && short.toLowerCase() !== dir.toLowerCase() ? short : null;
    } catch {
      return null;
    }
  }
  const longProject = join(linkRoot, "scratch", "a-long-project-name-for-short-alias");
  mkdirSync(join(longProject, "src"), { recursive: true });
  const shortProject = shortPathOf(longProject);

  test.skipIf(shortProject === null)("an 8.3 short-name spelling of a project file is not scratch", () => {
    expect(inScratch(join(longProject, "src", "a.ts"), longProject, longProject)).toBe(false);
    expect(inScratch(join(shortProject!, "src", "a.ts"), longProject, longProject)).toBe(false);
  });

  test.skipIf(shortProject === null)("an 8.3 spelling of the scratch ancestor itself is not scratch", () => {
    const shortRoot = shortPathOf(join(linkRoot, "scratch"));
    expect(shortRoot).not.toBeNull();
    expect(inScratch(join(shortRoot!, "a-long-project-name-for-short-alias", "src", "a.ts"), longProject, longProject)).toBe(false);
  });

  // An embedded NUL makes realpath throw something other than "absent". Each target is one the
  // outside-the-project rule would accept if canonicalisation were skipped or its failure ignored,
  // and each has a control with a resolvable twin that is accepted, so a pass here can only come
  // from the failure being treated as "not scratch".
  const NUL = String.fromCharCode(0);
  test("a target the filesystem cannot canonicalise is not scratch", () => {
    const outside = mkdtempSync(join(realTmp, "write-scope-nul-"));
    try {
      mkdirSync(join(outside, "scratchpad"));
      expect(inScratch(join(outside, "scratchpad", "ok.md"), linkRoot, linkRoot)).toBe(true);
      expect(inScratch(join(outside, "scratchpad", "bad" + NUL + ".md"), linkRoot, linkRoot)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a project root the filesystem cannot canonicalise makes every target not scratch", () => {
    const outside = mkdtempSync(join(realTmp, "write-scope-nul-"));
    try {
      mkdirSync(join(outside, "scratchpad"));
      const target = join(outside, "scratchpad", "ok.md");
      expect(inScratch(target, linkRoot, linkRoot)).toBe(true);
      expect(inScratch(target, linkRoot, linkRoot + NUL)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a dangling link in the path is not scratch, since where a write lands is unknown", () => {
    const outside = mkdtempSync(join(realTmp, "write-scope-dangle-"));
    try {
      mkdirSync(join(outside, "scratchpad"));
      let dangling = true;
      try {
        symlinkSync(join(outside, "nowhere"), join(outside, "scratchpad", "gap"), "junction");
      } catch {
        dangling = false;
      }
      if (dangling) {
        expect(inScratch(join(outside, "scratchpad", "gap", "f.md"), linkRoot, linkRoot)).toBe(false);
      }
      expect(inScratch(join(outside, "scratchpad", "plain.md"), linkRoot, linkRoot)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// A project whose root is a filesystem root splits into a path with an empty last segment unless the
// producer drops it, and then no target is "inside" the project. Every instruction path below would
// fall to the outside rule, where any scratch-named segment counts. The Windows spelling is built from
// character codes: drive C, a colon and a backslash.
describe("inScratch(): a project at a filesystem root still restricts scratch to .claude/scratch", () => {
  const driveRoot = String.fromCharCode(67, 58, 92);
  const roots: Array<[string, string]> = [["/", "/"]];
  if (process.platform === "win32") roots.push(["C:" + BS, driveRoot]);
  else roots.push(["the host root again", "/"]);

  test.each(roots)("project root %p: instruction paths are not scratch", (_label, root) => {
    for (const rel of [
      ["scratch", "CLAUDE.md"],
      [".claude", "skills", "scratch", "SKILL.md"],
      [".claude", "commands", "scratch", "x.md"],
      ["src", "scratchpad", "a.ts"],
      [".scratch", "n.md"],
    ]) {
      const target = join(root, ...rel);
      expect(inScratch(target, root, root)).toBe(false);
      expect(decide("scratch", target, root, root).action).toBe("deny");
    }
  });

  test.each(roots)("project root %p: .claude/scratch is still the drop box", (_label, root) => {
    const target = join(root, ".claude", "scratch", "r.md");
    expect(inScratch(target, root, root)).toBe(true);
    expect(decide("scratch", target, root, root)).toEqual({ action: "allow" });
  });

  test.each(roots)("project root %p: a relative write resolves against the cwd", (_label, root) => {
    expect(inScratch(join("scratch", "CLAUDE.md"), root, root)).toBe(false);
    expect(inScratch(join(".claude", "scratch", "r.md"), root, root)).toBe(true);
  });
});

// The account Claude folder (the user's ~/.claude, or CLAUDE_CONFIG_DIR) holds rules, skills,
// agent definitions and hooks that every session loads. A scratch-named folder there is still that
// tree, so a scoped agent is denied it whatever the segment says. Most cases also run with no config
// roots, to show the same path would otherwise be scratch and the deny comes from this rule.
const homeRoot = mkdtempSync(join(realTmp, "write-scope-home-"));
afterAll(() => {
  rmSync(homeRoot, { recursive: true, force: true });
});

describe("inScratch(): nothing at or under the account Claude folder is scratch", () => {
  const home = join(homeRoot, "home");
  const claudeDir = join(home, ".claude");
  const proj = join(homeRoot, "work", "repo");
  mkdirSync(join(claudeDir, "skills"), { recursive: true });
  mkdirSync(join(claudeDir, "scratch"), { recursive: true });
  mkdirSync(join(proj, ".claude", "scratch"), { recursive: true });
  const roots = claudeConfigRoots({}, home);

  test.each([
    [["scratch", "r.md"]],
    [["scratchpad", "r.md"]],
    [[".scratch", "r.md"]],
    [["skills", "scratch", "SKILL.md"]],
    [["projects", "p", "memory", "scratchpad", "n.md"]],
  ])("a scratch-named folder under it is denied: %p", (rel) => {
    const target = join(claudeDir, ...rel);
    expect(inScratch(target, proj, proj, [])).toBe(true);
    expect(inScratch(target, proj, proj, roots)).toBe(false);
  });

  test("the folder itself is denied when it is scratch-named", () => {
    const cfg = join(homeRoot, "cfg", "scratch");
    const cfgRoots = claudeConfigRoots({ CLAUDE_CONFIG_DIR: cfg }, home);
    expect(inScratch(join(cfg, "r.md"), proj, proj, [])).toBe(true);
    expect(inScratch(join(cfg, "r.md"), proj, proj, cfgRoots)).toBe(false);
    expect(inScratch(cfg, proj, proj, cfgRoots)).toBe(false);
  });

  test("a different case is denied", () => {
    const target = join(home, ".CLAUDE", "Scratch", "r.md");
    expect(inScratch(target, proj, proj, [])).toBe(true);
    expect(inScratch(target, proj, proj, roots)).toBe(false);
  });

  test("forward-slash and mixed separators are denied", () => {
    const slashed = claudeDir.split(BS).join("/");
    const targets = [`${slashed}/scratch/r.md`];
    if (WIN) targets.push(`${slashed}/scratch${BS}r.md`, `${claudeDir}/scratch/r.md`);
    for (const target of targets) {
      expect(inScratch(target, proj, proj, [])).toBe(true);
      expect(inScratch(target, proj, proj, roots)).toBe(false);
    }
  });

  test("dot-dot segments that land inside it are denied", () => {
    for (const target of [
      [home, "other", "..", ".claude", "scratch", "r.md"].join(sep),
      [homeRoot, "pad", "scratchpad", "..", "..", "home", ".claude", "scratch", "r.md"].join(sep),
    ]) {
      expect(inScratch(target, proj, proj, [])).toBe(true);
      expect(inScratch(target, proj, proj, roots)).toBe(false);
    }
  });

  test("a relative path resolved from a cwd inside it is denied", () => {
    const rel = join(".claude", "scratch", "r.md");
    expect(inScratch(rel, home, proj, [])).toBe(true);
    expect(inScratch(rel, home, proj, roots)).toBe(false);
  });

  let linked = true;
  const viaLink = join(homeRoot, "out", "via");
  const namedLink = join(homeRoot, "out2", "scratchpad");
  try {
    mkdirSync(dirname(viaLink), { recursive: true });
    mkdirSync(dirname(namedLink), { recursive: true });
    symlinkSync(claudeDir, viaLink, "junction");
    symlinkSync(join(claudeDir, "scratch"), namedLink, "junction");
  } catch {
    linked = false;
  }

  test.skipIf(!linked)("a link into it is judged by where it resolves", () => {
    for (const target of [join(viaLink, "scratch", "r.md"), join(namedLink, "r.md")]) {
      expect(inScratch(target, proj, proj, [])).toBe(true);
      expect(inScratch(target, proj, proj, roots)).toBe(false);
    }
  });

  // A subfolder linked out of the tree (skills kept in a dotfiles repo) resolves outside every
  // canonical root, so the spelling the write was given has to decide as well.
  let linkedOut = true;
  const dotfiles = join(homeRoot, "dotfiles");
  const homeB = join(homeRoot, "home-b");
  const claudeB = join(homeB, ".claude");
  const homeC = join(homeRoot, "home-c");
  const claudeC = join(homeC, ".claude");
  try {
    mkdirSync(join(dotfiles, "skills-b"), { recursive: true });
    mkdirSync(join(dotfiles, "claude-c"), { recursive: true });
    mkdirSync(join(dotfiles, "skills-c"), { recursive: true });
    mkdirSync(claudeB, { recursive: true });
    mkdirSync(homeC, { recursive: true });
    symlinkSync(join(dotfiles, "skills-b"), join(claudeB, "skills"), "junction");
    symlinkSync(join(dotfiles, "claude-c"), claudeC, "junction");
    symlinkSync(join(dotfiles, "skills-c"), join(dotfiles, "claude-c", "skills"), "junction");
  } catch {
    linkedOut = false;
  }

  test.skipIf(!linkedOut)("a subfolder junctioned out of it is denied by the path as given", () => {
    const target = join(claudeB, "skills", "scratch", "SKILL.md");
    expect(inScratch(target, proj, proj, [])).toBe(true);
    expect(inScratch(target, proj, proj, claudeConfigRoots({}, homeB))).toBe(false);
  });

  test.skipIf(!linkedOut)("a linked account folder is a root under the spelling it was given", () => {
    const target = join(claudeC, "skills", "scratch", "SKILL.md");
    expect(inScratch(target, proj, proj, [])).toBe(true);
    expect(inScratch(target, proj, proj, claudeConfigRoots({}, homeC))).toBe(false);
  });

  test.skipIf(!linkedOut)("the link target's own spelling is not denied (stated residual)", () => {
    const target = join(dotfiles, "skills-b", "scratch", "SKILL.md");
    expect(inScratch(target, proj, proj, claudeConfigRoots({}, homeB))).toBe(true);
  });

  test.skipIf(!linked)("a config root given through a link is canonicalised", () => {
    const linkRoots = claudeConfigRoots({ CLAUDE_CONFIG_DIR: viaLink }, join(homeRoot, "elsewhere"));
    expect(inScratch(join(claudeDir, "scratch", "r.md"), proj, proj, linkRoots)).toBe(false);
  });

  test("CLAUDE_CONFIG_DIR is a root of its own", () => {
    const cfg = join(homeRoot, "cfg-dir");
    const cfgRoots = claudeConfigRoots({ CLAUDE_CONFIG_DIR: cfg }, home);
    expect(inScratch(join(cfg, "scratchpad", "r.md"), proj, proj, roots)).toBe(true);
    expect(inScratch(join(cfg, "scratchpad", "r.md"), proj, proj, cfgRoots)).toBe(false);
    expect(inScratch(join(claudeDir, "scratch", "r.md"), proj, proj, cfgRoots)).toBe(false);
  });

  test("an empty CLAUDE_CONFIG_DIR adds no root", () => {
    expect(claudeConfigRoots({ CLAUDE_CONFIG_DIR: "" }, home)).toEqual(claudeConfigRoots({}, home));
  });

  test("an empty or relative home adds no root", () => {
    expect(claudeConfigRoots({}, "")).toEqual([]);
    expect(claudeConfigRoots({}, "relative-home")).toEqual([]);
  });

  test("ordinary scratch folders stay scratch", () => {
    for (const target of [
      join(homeRoot, "tmp", "claude", "sess", "scratchpad", "r.md"),
      join(home, "scratch", "r.md"),
      join(home, ".claude-other", "scratch", "r.md"),
      join(home, ".claudex", "scratchpad", "r.md"),
    ]) {
      expect(inScratch(target, proj, proj, roots)).toBe(true);
    }
    expect(inScratch(join(proj, ".claude", "scratch", "r.md"), proj, proj, roots)).toBe(true);
  });

  test("a project at the home folder loses its drop box, since that is the account folder", () => {
    expect(inScratch(join(claudeDir, "scratch", "r.md"), home, home, [])).toBe(true);
    expect(inScratch(join(claudeDir, "scratch", "r.md"), home, home, roots)).toBe(false);
  });

  test("decide() applies it with the real home folder by default", () => {
    const target = join(homedir(), ".claude", "scratch", "r.md");
    expect(decide("scratch", target, proj, proj).action).toBe("deny");
    expect(decide("scratch", join(homeRoot, "tmp", "scratchpad", "r.md"), proj, proj)).toEqual({ action: "allow" });
  });

  test("the gate version marks this change", () => {
    expect(WRITE_SCOPE_GATE_VERSION).toBe(3);
  });
});

describe("decide() — only scratch-scoped agents are gated", () => {
  test("scoped agent writing outside scratch is denied", () => {
    const verdict = decide("scratch", "/home/runner/project/src/index.ts", CWD, CWD);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("writeScope: scratch");
    }
  });

  test("scoped agent writing inside scratch is allowed", () => {
    expect(decide("scratch", "/tmp/claude/s/scratchpad/r.md", CWD, CWD)).toEqual({
      action: "allow",
    });
  });

  test("scoped agent writing to the installer-created scratch dir is allowed", () => {
    expect(decide("scratch", "/home/runner/project/.claude/scratch/report.md", CWD, CWD)).toEqual({
      action: "allow",
    });
  });

  // The deny counterpart to the case above: accepting `.claude/scratch/` must not
  // open the rest of `.claude`.
  test("scoped agent writing elsewhere under .claude is denied", () => {
    const verdict = decide("scratch", "/home/runner/project/.claude/agents/x.md", CWD, CWD);
    expect(verdict.action).toBe("deny");
  });

  // Absence of a declaration means the hook has no opinion. This is what keeps
  // installing the gate from changing behaviour for existing agents.
  test.each([null, "repo", ""])("unscoped agent is untouched: %p", (scope) => {
    expect(decide(scope, "/home/runner/project/src/index.ts", CWD, CWD)).toEqual({
      action: "allow",
    });
  });

  test("main session (no agent_type, so no scope) is untouched", () => {
    expect(decide(null, "/anywhere/at/all.md", CWD, CWD)).toEqual({ action: "allow" });
  });

  test("missing file_path allows rather than crashing — fail open", () => {
    expect(decide("scratch", undefined, CWD, CWD)).toEqual({ action: "allow" });
  });
});

// --- readWriteScope() — item 38: agent_type is payload text, not a path fragment ---------------
//
// The hook interpolates agent_type straight into `.claude/agents/<type>.md`. These run against a
// real fixture tree because the escape only shows up against real files: every planted definition
// below declares `writeScope: scratch`, so an unguarded read RESOLVES it and returns "scratch",
// while a guarded one returns null — the same answer a missing definition gives, which is the
// behaviour this fix must not regress.

const scopeRoot = mkdtempSync(join(tmpdir(), "write-scope-agent-type-"));
const scopeProjectDir = join(scopeRoot, "project");
const scopeAgentsDir = join(scopeProjectDir, ".claude", "agents");
mkdirSync(join(scopeAgentsDir, "sub"), { recursive: true });
mkdirSync(join(scopeRoot, "outside"), { recursive: true });

function writeScopeDef(absPath: string) {
  writeFileSync(absPath, ["---", "name: planted", "writeScope: scratch", "---", "", "Body."].join("\n"));
}

writeScopeDef(join(scopeAgentsDir, "valid-agent.md"));
// This hook takes agent_type without lowercasing it (unlike agent-worktree-gate, which trims and
// lowercases first), so a mixed-case type has to survive the allowlist and reach the read. Planted
// and requested under the same name, so the assertion is about the guard and not about whether
// this filesystem happens to be case-sensitive.
writeScopeDef(join(scopeAgentsDir, "Mixed-Case-Agent.md"));
// The file an empty agent_type resolves to once `<type>.md` is interpolated.
writeScopeDef(join(scopeAgentsDir, ".md"));
// Reached by a separator-bearing name, and by an absolute one: node's join() folds a leading
// separator instead of restarting from the filesystem root, so `/sub/nested` lands here too.
writeScopeDef(join(scopeAgentsDir, "sub", "nested.md"));
// Outside the agents directory entirely — only a traversal reaches this one.
writeScopeDef(join(scopeRoot, "outside", "escaped.md"));
writeFileSync(
  join(scopeAgentsDir, "bom-agent.md"),
  String.fromCharCode(0xfeff) + ["---", "name: bom-agent", "writeScope: scratch", "---", "", "Body."].join(NL),
);
// Two keys: the first wins, as the shared parser defines it.
writeFileSync(
  join(scopeAgentsDir, "dup-key.md"),
  ["---", "name: dup-key", "writeScope: repo", "writeScope: scratch", "---", "", "Body."].join("\n"),
);

afterAll(() => {
  rmSync(scopeRoot, { recursive: true, force: true });
});

// `cwd` is the OTHER payload field that reaches the same path construction: it becomes projectDir
// when CLAUDE_PROJECT_DIR is unset, and it is the base inScratch() resolves a relative write
// against. It is a directory by design, so the agent-name allowlist is the wrong shape for it —
// see the header note on why the two fields are treated differently. What it does need is to be a
// string: `join(42, …)` and `resolve({}, …)` throw, and the throw is caught by the hook's
// outermost handler, so a malformed cwd used to silence a deny the gate would otherwise have made.
describe("readSessionCwd() — a non-string cwd falls back instead of throwing", () => {
  test("a real cwd string is used as given", () => {
    expect(readSessionCwd({ cwd: "/home/runner/project" })).toBe("/home/runner/project");
  });

  test.each([
    ["empty string", { cwd: "" }],
    ["a number", { cwd: 42 }],
    ["an object", { cwd: {} }],
    ["null", { cwd: null }],
    ["field absent", {}],
    ["payload not an object", null],
  ])("%s falls back to process.cwd()", (_label, payload) => {
    expect(readSessionCwd(payload)).toBe(process.cwd());
  });

  // Returning a string rather than undefined is the point: both consumers take it straight into
  // path resolution. The deny below uses an absolute path with no scratch segment so the outcome
  // does not depend on where this checkout happens to live.
  test("the fallback value still drives a real decision instead of throwing", () => {
    const cwd = readSessionCwd({ cwd: 42 });
    expect(() => inScratch("report.md", cwd, cwd)).not.toThrow();
    expect(decide("scratch", "/home/runner/project/src/index.ts", cwd, cwd).action).toBe("deny");
  });
});

describe("parseWriteScope() — frontmatter only, first key wins", () => {
  test("a leading byte order mark does not hide the declaration", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseWriteScope(bom + "---" + NL + "writeScope: scratch" + NL + "---" + NL)).toBe("scratch");
  });

  test("reads the value from frontmatter", () => {
    expect(parseWriteScope("---\nwriteScope: scratch\n---\n")).toBe("scratch");
  });

  test("CRLF frontmatter gives the same answer", () => {
    expect(parseWriteScope("---\r\nname: x\r\nwriteScope: scratch\r\n---\r\nBody\r\n")).toBe("scratch");
  });

  test("a writeScope line in the body, after the closing delimiter, is ignored", () => {
    expect(parseWriteScope("---\nname: x\n---\nwriteScope: scratch\n")).toBeNull();
  });

  test("the first of two keys wins", () => {
    expect(parseWriteScope("---\nwriteScope: repo\nwriteScope: scratch\n---\n")).toBe("repo");
  });

  test("a key past 4096 characters of frontmatter is still found", () => {
    const filler = "description: " + "x".repeat(5000);
    expect(parseWriteScope(["---", filler, "writeScope: scratch", "---", ""].join("\n"))).toBe("scratch");
  });

  test("no frontmatter gives null", () => {
    expect(parseWriteScope("# Title\nwriteScope: scratch\n")).toBeNull();
  });

  test("an unterminated frontmatter block gives null", () => {
    expect(parseWriteScope("---\nwriteScope: scratch\n")).toBeNull();
  });
});

describe("parseWriteScope() — a fence is dashes plus ASCII spaces and tabs only", () => {
  const NBSP = String.fromCharCode(0xa0);
  const ZWNBSP = String.fromCharCode(0xfeff);
  const N = String.fromCharCode(10);
  const body = (open: string, close: string) => [open, "writeScope: scratch", close, "Body."].join(N);

  test("trailing spaces and tabs are still a fence", () => {
    expect(parseWriteScope(body("--- ", "---\t "))).toBe("scratch");
  });

  test.each([
    ["a no-break space", NBSP],
    ["a U+FEFF", ZWNBSP],
  ])("%s after the opening fence is not a fence, so there is no frontmatter", (_label, ch) => {
    expect(parseWriteScope(body("---" + ch, "---"))).toBeNull();
  });

  test.each([
    ["a no-break space", NBSP],
    ["a U+FEFF", ZWNBSP],
  ])("%s after the closing fence is not a fence, so the block never closes", (_label, ch) => {
    expect(parseWriteScope(body("---", "---" + ch))).toBeNull();
  });
});

// The confinement side must over-detect. When the strict frontmatter parser cannot read the block
// with confidence it returns null, and treating that as "undeclared" would lift the confinement the
// definition asked for. readWriteScope falls back to a loose scan of the whole file for a writeScope
// line (case-insensitive key, any position) and uses that value. The strict reading stays first.
describe("readWriteScope() — an unreadable block that declares a scope is still confined", () => {
  const NBSP = String.fromCharCode(0xa0);
  const ZWNBSP = String.fromCharCode(0xfeff);
  const N = String.fromCharCode(10);
  const looseRoot = mkdtempSync(join(tmpdir(), "write-scope-loose-"));
  const looseAgents = join(looseRoot, ".claude", "agents");
  mkdirSync(looseAgents, { recursive: true });
  afterAll(() => {
    rmSync(looseRoot, { recursive: true, force: true });
  });
  function def(name: string, text: string) {
    writeFileSync(join(looseAgents, name + ".md"), text);
  }
  def("nbsp-open", ["---" + NBSP, "name: x", "writeScope: scratch", "---", "Body."].join(N));
  def("nbsp-close", ["---", "name: x", "writeScope: scratch", "---" + NBSP, "Body."].join(N));
  def("zwnbsp-close", ["---", "name: x", "writeScope: scratch", "---" + ZWNBSP, "Body."].join(N));
  def("unclosed", ["---", "name: x", "writeScope: scratch", "Body with no closing fence."].join(N));
  def("bom-nbsp", ZWNBSP + ["---" + NBSP, "name: x", "writeScope: scratch", "---", "Body."].join(N));
  def("loose-key-case", ["---", "name: x", "WriteScope: Scratch", "Body, no close."].join(N));
  def("in-body", ["Just a body, no frontmatter.", "writeScope: scratch"].join(N));
  def("late-in-file", ["---" + NBSP, "name: x", "x".repeat(5000), "writeScope: scratch", "---"].join(N));
  // The strict reading wins whenever it finds a declaration.
  def("strict-first", ["---", "writeScope: repo", "---", "writeScope: scratch"].join(N));
  def("strict-repo-then-loose-scratch", ["---", "name: x", "writeScope: repo", "---", "Body.", "writeScope: scratch"].join(N));
  // No declaration anywhere: stays undeclared, however broken the block is.
  def("none-clean", ["---", "name: x", "tools: Read", "---", "Body."].join(N));
  def("none-broken", ["---" + NBSP, "name: x", "tools: Read", "Body with no close."].join(N));
  def("none-mentions-word", ["---", "name: x", "description: about write scope handling", "---", "Body."].join(N));

  test.each([
    ["nbsp-open", "an NBSP after the opening fence"],
    ["nbsp-close", "an NBSP after the closing fence"],
    ["zwnbsp-close", "a U+FEFF after the closing fence"],
    ["unclosed", "no closing fence"],
    ["bom-nbsp", "a BOM plus an NBSP-fenced opening"],
    ["in-body", "a declaration with no frontmatter at all"],
    ["late-in-file", "a declaration beyond the first 4096 characters"],
  ])("%s (%s): confined as scratch", (name) => {
    expect(readWriteScope(name, looseRoot)).toBe("scratch");
  });

  test("the key is matched case-insensitively and the value lowercased, so the gate's exact comparison still confines", () => {
    expect(readWriteScope("loose-key-case", looseRoot)).toBe("scratch");
    expect(decide(readWriteScope("loose-key-case", looseRoot), "/home/runner/project/src/a.ts", CWD, CWD).action).toBe("deny");
  });

  test("the strict reading stays first", () => {
    expect(readWriteScope("strict-first", looseRoot)).toBe("repo");
    expect(readWriteScope("strict-repo-then-loose-scratch", looseRoot)).toBe("repo");
  });

  test.each(["none-clean", "none-broken", "none-mentions-word"])("%s: no writeScope anywhere stays undeclared", (name) => {
    expect(readWriteScope(name, looseRoot)).toBeNull();
  });

  test("an unreadable-block definition declaring scratch is denied a write outside scratch, end to end", () => {
    const scope = readWriteScope("nbsp-open", looseRoot);
    expect(decide(scope, join(looseRoot, "src", "a.ts"), looseRoot, looseRoot).action).toBe("deny");
  });
});

describe("readWriteScope() — item 38: only a filename-safe agent name resolves a definition", () => {
  test("a normal agent name still resolves its definition", () => {
    expect(readWriteScope("valid-agent", scopeProjectDir)).toBe("scratch");
  });

  test("a mixed-case agent name resolves its definition, since this hook does not lowercase", () => {
    expect(readWriteScope("Mixed-Case-Agent", scopeProjectDir)).toBe("scratch");
  });

  test("a definition saved with a byte order mark still resolves its scope", () => {
    expect(readWriteScope("bom-agent", scopeProjectDir)).toBe("scratch");
  });

  test("a definition with duplicate keys resolves to the first", () => {
    expect(readWriteScope("dup-key", scopeProjectDir)).toBe("repo");
  });

  test.each([
    ["traversal", "../../../outside/escaped"],
    ["absolute path", "/sub/nested"],
    ["path separator", "sub/nested"],
    ["empty string", ""],
  ])("%s in agent_type reads nothing: %p", (_label, agentType) => {
    expect(readWriteScope(agentType, scopeProjectDir)).toBeNull();
  });
});

// --- #78: the import.meta.main stdin/stdout entrypoint itself, spawned for real ------------------
//
// Every test above calls decide()/readWriteScope() directly, which proves the policy is correct
// but not that the entrypoint reads stdin, calls that policy, and serializes its answer the way
// Claude Code expects. Deleting the `if (import.meta.main)` block leaves this hook doing nothing at
// all: no stdin read, no stdout, exit 0 — indistinguishable from the allow path on any assertion
// that only checks "exit 0, empty output". The deny case below is the one that is NOT
// indistinguishable: a genuine deny needs the entrypoint to have read stdin, called decide(), and
// printed its JSON, none of which an ablated entrypoint does, so this is what actually catches it.

const spawnScopeRoot = mkdtempSync(join(tmpdir(), "write-scope-spawn-"));
const spawnAgentsDir = join(spawnScopeRoot, ".claude", "agents");
mkdirSync(spawnAgentsDir, { recursive: true });
writeFileSync(
  join(spawnAgentsDir, "scratch-spawn-agent.md"),
  ["---", "name: scratch-spawn-agent", "writeScope: scratch", "---", "", "Body."].join("\n"),
);

afterAll(() => {
  rmSync(spawnScopeRoot, { recursive: true, force: true });
});

describe("spawned process — the deny path is observable", () => {
  test("a scratch-scoped agent writing outside scratch: exit 0, deny JSON on stdout", () => {
    const filePath = join(spawnScopeRoot, "src", "index.ts");
    const result = runHook(
      JSON.stringify({
        agent_type: "scratch-spawn-agent",
        cwd: spawnScopeRoot,
        tool_input: { file_path: filePath },
      }),
    );
    // The exact reason text is decide()'s own policy, already covered above; recomputing it here
    // rather than hand-duplicating the string keeps this assertion about the ENTRYPOINT's wiring,
    // not a second copy of decide()'s wording that could drift from it.
    const expectedReason = (decide("scratch", filePath, spawnScopeRoot, spawnScopeRoot) as { reason: string }).reason;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expectedReason,
        },
      }) + "\n",
    );
  });

  test("the same agent writing inside scratch: exit 0, silent (no opinion)", () => {
    const result = runHook(
      JSON.stringify({
        agent_type: "scratch-spawn-agent",
        cwd: spawnScopeRoot,
        tool_input: { file_path: join(spawnScopeRoot, ".claude", "scratch", "report.md") },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("spawned process — scratch-named ancestor and NotebookEdit", () => {
  test("a scoped agent in a project under a scratch directory is denied for a normal write", () => {
    const root = mkdtempSync(join(tmpdir(), "write-scope-anc-"));
    try {
      const proj = join(root, "scratch", "proj");
      mkdirSync(join(proj, ".claude", "agents"), { recursive: true });
      writeFileSync(
        join(proj, ".claude", "agents", "scoped.md"),
        ["---", "name: scoped", "writeScope: scratch", "---", "", "Body."].join("\n"),
      );
      const result = runHook(
        JSON.stringify({
          agent_type: "scoped",
          cwd: proj,
          tool_input: { file_path: join(proj, "src", "x.ts") },
        }),
        { CLAUDE_PROJECT_DIR: proj },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`"permissionDecision":"deny"`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a NotebookEdit notebook_path outside scratch is denied", () => {
    const nb = join(spawnScopeRoot, "src", "analysis.ipynb");
    const result = runHook(
      JSON.stringify({
        agent_type: "scratch-spawn-agent",
        cwd: spawnScopeRoot,
        tool_input: { notebook_path: nb },
      }),
      { CLAUDE_PROJECT_DIR: spawnScopeRoot },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`"permissionDecision":"deny"`);
  });

  test("a NotebookEdit notebook_path inside scratch is silent", () => {
    const result = runHook(
      JSON.stringify({
        agent_type: "scratch-spawn-agent",
        cwd: spawnScopeRoot,
        tool_input: { notebook_path: join(spawnScopeRoot, ".claude", "scratch", "n.ipynb") },
      }),
      { CLAUDE_PROJECT_DIR: spawnScopeRoot },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("spawned process — the fail-open path stays open and says why", () => {
  test("malformed JSON exits 0, no stdout, and leaves a diagnostic instead of vanishing", () => {
    const result = runHook("{not json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("agent-write-scope:");
  });

  test("an unscoped agent (no agent_type) is untouched: exit 0, silent", () => {
    const result = runHook(
      JSON.stringify({ cwd: spawnScopeRoot, tool_input: { file_path: "/anywhere/at/all.md" } }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("spawned process — the account Claude folder", () => {
  test("a scratch folder under CLAUDE_CONFIG_DIR is denied, a plain scratchpad is not", () => {
    const root = mkdtempSync(join(tmpdir(), "write-scope-cfg-"));
    try {
      const cfg = join(root, "cfg");
      const payload = (filePath: string) =>
        JSON.stringify({ agent_type: "scratch-spawn-agent", cwd: spawnScopeRoot, tool_input: { file_path: filePath } });
      const env = { CLAUDE_PROJECT_DIR: spawnScopeRoot, CLAUDE_CONFIG_DIR: cfg };
      const denied = runHook(payload(join(cfg, "scratchpad", "r.md")), env);
      expect(denied.exitCode).toBe(0);
      expect(denied.stdout).toContain(`"permissionDecision":"deny"`);
      const allowed = runHook(payload(join(root, "sess", "scratchpad", "r.md")), env);
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
