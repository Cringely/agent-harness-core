// Tests for the opt-in memory-note transition counter
// (core/claude/hooks/memory-transition-log.ts).
//
// Two halves, matching test/model-tier-gate.test.ts's rationale for the same split. The pure half
// imports the exported inMemoryDir/extractStatus/hasRevisitSection/detectTransitions and runs
// offline — this closes #77 ("memory-transition-log.ts has zero test coverage"), which the spawn
// half alone (added under #104 for #78) did not reach: line coverage on detectTransitions() cannot
// see whether the entrypoint ever calls it, so the two halves check different things and neither
// substitutes for the other.
//
// The spawn half exists because this hook's failure mode is a silent no-op that reads exactly like
// "nothing happened": it is fail-open by design (see the file's own header), it never writes to
// stdout, and its one side effect (an appended JSONL line under
// ~/.claude/state/memory-transitions.jsonl) is easy to miss if the entrypoint stops parsing stdin,
// stops resolving paths, or starts throwing past its own try/catch. Pure-function tests cannot tell
// a working hook from a deleted `import.meta.main` block; only a real spawned process with a real
// state file on disk can.
//
// STATE_PATH is `join(homedir(), ".claude", "state", "memory-transitions.jsonl")`, fixed at module
// load. Every spawn test that cares about the written file overrides HOME and USERPROFILE to a
// fresh temp directory so state from one test can never leak into another, and so the suite never
// touches the real operator home directory. Confirmed empirically (not assumed) that Bun on this
// Windows host resolves os.homedir() from USERPROFILE when it is overridden in a child env.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectTransitions,
  extractStatus,
  hasRevisitSection,
  inMemoryDir,
} from "../core/claude/hooks/memory-transition-log";

const CWD = "/home/runner/project";

// ---------------------------------------------------------------------------
// inMemoryDir() — path classification, both separators
// ---------------------------------------------------------------------------

describe("inMemoryDir() — in scope", () => {
  test.each([
    "/home/runner/project/memory/note.md",
    "C:\\Users\\fixture\\project\\memory\\note.md",
    // Case-insensitive segment match: real Windows checkouts and case-preserving
    // filesystems both produce a directory literally named "Memory" or "MEMORY".
    "/home/runner/project/Memory/note.md",
    "C:\\Users\\fixture\\project\\MEMORY\\note.md",
    // Nested a level deeper than the direct child.
    "/home/runner/project/.claude/projects/x/memory/decisions/note.md",
    // Relative, resolved against cwd.
    "memory/note.md",
  ])("in scope: %s", (p) => {
    expect(inMemoryDir(p, CWD)).toBe(true);
  });
});

describe("inMemoryDir() — out of scope", () => {
  test.each([
    "/home/runner/project/src/index.ts",
    // A segment that CONTAINS "memory" as a substring is not a segment equal to it.
    "/home/runner/project/notes-memory/note.md",
    // A file merely NAMED memory.md is not a memory/ directory.
    "/home/runner/project/memory.md",
    // Traversal out of a memory/ dir resolves away from it, same shape as
    // agent-write-scope.test.ts's inScratch() traversal case.
    "/home/runner/project/memory/../src/index.ts",
  ])("out of scope: %s", (p) => {
    expect(inMemoryDir(p, CWD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractStatus() — the regex requires leading indentation, matching the real
// `metadata:\n  status: proposed` shape from the memory-system skill's frontmatter
// schema, not a bare top-level `status:` line.
// ---------------------------------------------------------------------------

describe("extractStatus()", () => {
  test("indented status line (real frontmatter shape) is extracted", () => {
    const text = ["---", "name: example-note", "metadata:", "  type: decision", "  status: proposed", "---"].join(
      "\n",
    );
    expect(extractStatus(text)).toBe("proposed");
  });

  // Subtle: `/^[ \t]+status:.../m` requires at least one leading space or tab. A
  // status line with none — malformed frontmatter, or a body paragraph that
  // happens to start a line with the word "status:" — does not count.
  test("a status line with no leading indentation is not matched", () => {
    expect(extractStatus("status: proposed\n")).toBeNull();
  });

  test("no status field at all: null", () => {
    expect(extractStatus("---\nname: x\n---\nBody text.\n")).toBeNull();
  });

  // .match() with no /g flag returns only the first hit — relevant because a note
  // body can legitimately quote another note's frontmatter (e.g. in a decision's
  // rationale), and only the real frontmatter value should win.
  test("first status: line wins when more than one is present", () => {
    const text = "  status: proposed\nSome body text.\n  status: accepted\n";
    expect(extractStatus(text)).toBe("proposed");
  });

  // Edit's old_string/new_string on a Windows checkout (core.autocrlf=true) can
  // carry CRLF line endings verbatim. \S+ stops before \r on its own, but this
  // proves it rather than assuming it.
  test("a CRLF-terminated status line still extracts a clean value with no trailing \\r", () => {
    const text = "---\r\nmetadata:\r\n  status: proposed\r\n---\r\n";
    expect(extractStatus(text)).toBe("proposed");
  });
});

// ---------------------------------------------------------------------------
// hasRevisitSection()
// ---------------------------------------------------------------------------

describe("hasRevisitSection()", () => {
  test("present, with trailing annotation text after the heading words", () => {
    expect(hasRevisitSection("## Revisit when  — event/metric/date conditions\n\nSome text.\n")).toBe(true);
  });

  test("absent: false", () => {
    expect(hasRevisitSection("## Outcome\n\nSome text.\n")).toBe(false);
  });

  // Subtle: the heading is anchored on exactly "##" plus whitespace. A deeper
  // heading level sharing the same words is a different section, not this one.
  test("a deeper heading level with the same words does not match", () => {
    expect(hasRevisitSection("### Revisit when\n\nSome text.\n")).toBe(false);
  });

  test("the phrase appearing in prose, not as a heading, does not match", () => {
    expect(hasRevisitSection("We should revisit when the metric crosses 10%.\n")).toBe(false);
  });

  test("CRLF line endings still detect the heading", () => {
    expect(hasRevisitSection("Intro.\r\n## Revisit when\r\n\r\nBody.\r\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectTransitions() — pure diff over old/new text spans
// ---------------------------------------------------------------------------

function withStatus(status: string | null, extra = ""): string {
  const lines = ["---", "name: example-note", "metadata:", "  type: decision"];
  if (status !== null) lines.push(`  status: ${status}`);
  lines.push("---", extra);
  return lines.join("\n");
}

describe("detectTransitions() — status-changed", () => {
  test("both present and different: fires with old and new values", () => {
    const result = detectTransitions(withStatus("proposed"), withStatus("accepted"));
    expect(result).toContainEqual({ kind: "status-changed", old: "proposed", new: "accepted" });
  });

  test.each([
    ["unchanged status", withStatus("proposed"), withStatus("proposed")],
    ["new status removed entirely (documented gap: null newStatus never fires status-changed)", withStatus("proposed"), withStatus(null)],
    ["old status was absent", withStatus(null), withStatus("accepted")],
  ])("%s: no status-changed transition", (_label, oldText, newText) => {
    const kinds = detectTransitions(oldText, newText).map((t) => t.kind);
    expect(kinds).not.toContain("status-changed");
  });
});

describe("detectTransitions() — revisit-removed", () => {
  test("heading present in old, gone from new: fires", () => {
    const oldText = "## Revisit when\n\nCondition text.\n";
    const newText = "Condition resolved, no longer tracked.\n";
    expect(detectTransitions(oldText, newText)).toContainEqual({ kind: "revisit-removed" });
  });

  test.each([
    ["heading persists unchanged", "## Revisit when\n\nX.\n", "## Revisit when\n\nY.\n"],
    ["heading never present in either", "Body.\n", "Body, edited.\n"],
  ])("%s: no revisit-removed transition", (_label, oldText, newText) => {
    const kinds = detectTransitions(oldText, newText).map((t) => t.kind);
    expect(kinds).not.toContain("revisit-removed");
  });
});

describe("detectTransitions() — status-rejected-appeared", () => {
  test("new is rejected, old was a different status: fires and carries the prior value", () => {
    const result = detectTransitions(withStatus("proposed"), withStatus("rejected"));
    expect(result).toContainEqual({ kind: "status-rejected-appeared", old: "proposed" });
  });

  test("new is rejected, old had no status field: fires with old: null", () => {
    const result = detectTransitions(withStatus(null), withStatus("rejected"));
    expect(result).toContainEqual({ kind: "status-rejected-appeared", old: null });
  });

  test("already rejected in both: does not fire again", () => {
    const kinds = detectTransitions(withStatus("rejected"), withStatus("rejected")).map((t) => t.kind);
    expect(kinds).not.toContain("status-rejected-appeared");
  });
});

describe("detectTransitions() — Write case and combinations", () => {
  test("oldText undefined (Write, no prior text): always empty, regardless of newText content", () => {
    expect(detectTransitions(undefined, withStatus("rejected"))).toEqual([]);
  });

  // accepted -> rejected satisfies both status-changed AND status-rejected-appeared
  // in the same call: the two checks are independent ifs, not an if/else chain.
  test("a single edit can fire more than one transition kind at once", () => {
    const result = detectTransitions(withStatus("accepted"), withStatus("rejected"));
    const kinds = result.map((t) => t.kind).sort();
    expect(kinds).toEqual(["status-changed", "status-rejected-appeared"]);
  });
});

// ---------------------------------------------------------------------------
// Spawned process. See the header for why these are load-bearing: this hook's
// only observable side effect is a file it writes, and the only way to prove
// the CLI wrapper still calls into the pure functions and still writes that
// file is to run it as a real process with real stdin.
// ---------------------------------------------------------------------------

const HOOK = join(import.meta.dir, "..", "core", "claude", "hooks", "memory-transition-log.ts");

/** Runs the hook as a real process with `stdinText` on stdin, and `env` overriding the runner's
 * own — used to redirect STATE_PATH (`~/.claude/state/memory-transitions.jsonl`) away from the
 * real home directory, the same HOME/USERPROFILE-override convention test/identity-gate.test.ts
 * uses to isolate its own real-file-I/O tests. Never goes through a shell. */
function runHook(stdinText: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, HOOK],
    stdin: new TextEncoder().encode(stdinText),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const fakeHome = mkdtempSync(join(tmpdir(), "memory-transition-log-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "memory-transition-log-project-"));
mkdirSync(join(projectDir, "memory"), { recursive: true });
const statePath = join(fakeHome, ".claude", "state", "memory-transitions.jsonl");
const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("spawned process — a real transition lands on disk", () => {
  test("a status: proposed -> accepted Edit under memory/: exit 0, one JSONL line written", () => {
    const result = runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "memory/note.md",
          old_string: "  status: proposed",
          new_string: "  status: accepted",
        },
        cwd: projectDir,
        session_id: "spawn-test-session",
      }),
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    // No stdout contract to check, per the header above — the only observable effect is the disk
    // write, so that is what an ablated entrypoint (which performs no I/O at all) fails to produce.
    const written = readFileSync(statePath, "utf8").trim();
    expect(written.length).toBeGreaterThan(0);
    const line = JSON.parse(written.split("\n")[0]);
    expect(line.transition).toBe("status-changed");
    expect(line.old).toBe("proposed");
    expect(line.new).toBe("accepted");
    expect(line.tool).toBe("Edit");
    expect(line.sessionId).toBe("spawn-test-session");
    expect(line.notePath.replace(/\\/g, "/")).toContain("memory/note.md");
  });
});

describe("spawned process — the fail-open path stays open and says why", () => {
  test("malformed JSON exits 0, no stdout, and leaves a diagnostic instead of vanishing", () => {
    const result = runHook("{not json", env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("memory-transition-log: hook error, skipping:");
  });

  test("a Write/Edit outside memory/ counts nothing: exit 0, no stdout, no stderr, no new line", () => {
    // This hook has no stdout contract at all (file header above), so exit/stdout/stderr alone
    // cannot tell a correct no-op from one that wrongly counted: appendFileSync touches neither.
    // The one channel that discriminates is the state file itself. Under the full suite the test
    // above this one has already run and appended a line, so the baseline is captured fresh here
    // rather than asserted absent — this is "same content as immediately before this test's own
    // run", not "empty file". Run in isolation (e.g. `bun test -t "counts nothing"`) the file
    // never gets created, so existsSync() falls back to "" rather than ENOENT-ing on a read of a
    // file the positive test didn't get a chance to write. The payload below is a real status:
    // proposed -> accepted transition, same shape the positive test counts; only the
    // out-of-memory/ path should stop it, so a broken or removed inMemoryDir() gate is exactly
    // what turns `before` and `after` unequal either way.
    const before = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
    const result = runHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "src/index.ts", old_string: "  status: proposed", new_string: "  status: accepted" },
        cwd: projectDir,
      }),
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const after = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Spawned process, isolated-per-call variant. Covers gating branches, stdin
// edge cases, every transition kind's on-disk shape, and filesystem edge
// cases the two shared-home tests above don't reach. Each call gets its own
// fresh $HOME so these never depend on run order or on what the tests above
// already wrote to the shared statePath.
// ---------------------------------------------------------------------------

const spawnTempDirs: string[] = [];
afterAll(() => {
  for (const d of spawnTempDirs) rmSync(d, { recursive: true, force: true });
});

/** Fresh isolated $HOME/$USERPROFILE so STATE_PATH never touches the real one. */
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mtl-home-"));
  spawnTempDirs.push(dir);
  return dir;
}

function freshStatePath(home: string): string {
  return join(home, ".claude", "state", "memory-transitions.jsonl");
}

/** Runs the hook as a real process with `stdinText` on stdin, against a fresh $HOME unless one is
 * given. Never goes through a shell. */
function spawnHook(stdinText: string, home = freshHome()) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, HOOK],
    stdin: new TextEncoder().encode(stdinText),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    home,
  };
}

function readLines(home: string): unknown[] {
  const raw = readFileSync(freshStatePath(home), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// Mirrors the hook's own `resolve(...).replace(/\\/g, "/")`. The `resolve` half is
// legitimate rather than circular: a POSIX-style path like "/home/runner/..." is
// drive-relative on Windows, so the only portable way to know what absolute path it
// resolves to on THIS host is to ask the same stdlib function the hook uses.
//
// The `.replace` half is a different matter and the distinction is worth stating,
// because it is not the same on both platforms. That normalization exists for
// Windows: on POSIX `resolve` never emits a backslash, so both the hook and this
// helper are no-ops there and a hook that dropped the replace entirely would still
// match. It is the Windows-separator test below that proves the normalization fires,
// and that test is Windows-guarded, so on a POSIX runner the replace has no
// falsifying test here. That is honest rather than a gap to paper over: on POSIX it
// has no behaviour to falsify. Do not manufacture a POSIX case for it by feeding a
// filename with a literal backslash -- that is a legal POSIX filename the hook would
// mangle into a separator, so such a test would pin a latent bug as intended
// behaviour rather than cover this one.
function notePathFor(filePath: string): string {
  return resolve(filePath).replace(/\\/g, "/");
}

const EDIT_PAYLOAD = (filePath: string, oldText: string, newText: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: oldText, new_string: newText },
    ...extra,
  });

describe("spawned process — gating branches that decide whether it acts at all", () => {
  test.each([
    ["unrelated tool_name", { tool_name: "Read", tool_input: {} }],
    ["tool_name absent entirely", { tool_input: { file_path: "/x/memory/note.md" } }],
  ])("%s: exits 0, no state file written", (_label, payload) => {
    const result = spawnHook(JSON.stringify(payload));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(() => readLines(result.home)).toThrow();
  });

  test("tool_input absent entirely does not throw past the optional chaining", () => {
    const result = spawnHook(JSON.stringify({ tool_name: "Edit" }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(() => readLines(result.home)).toThrow();
  });

  test("file_path absent: exits 0, no state file", () => {
    const result = spawnHook(JSON.stringify({ tool_name: "Edit", tool_input: { old_string: "a", new_string: "b" } }));
    expect(result.exitCode).toBe(0);
    expect(() => readLines(result.home)).toThrow();
  });

  test("file_path outside memory/: no write, even though the text change would otherwise qualify", () => {
    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/src/README.md", withStatus("proposed"), withStatus("accepted")));
    expect(result.exitCode).toBe(0);
    expect(() => readLines(result.home)).toThrow();
  });

  test("Write inside memory/ never yields a detection (no prior text to diff)", () => {
    const result = spawnHook(
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/home/runner/project/memory/note.md", content: withStatus("rejected") },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(() => readLines(result.home)).toThrow();
  });

  test("Edit inside memory/ but nothing qualifies as a transition: no state file, no state dir created", () => {
    const sameText = withStatus("proposed");
    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", sameText, sameText));
    expect(result.exitCode).toBe(0);
    expect(() => readLines(result.home)).toThrow();
    // The second half of this test's name, which until now it did not check. What
    // makes "no directory" true is an ordering: the hook's zero-transition exit
    // sits ahead of its mkdirSync, so nothing is created on this path. That is
    // exactly why the claim needs its own assertion -- move the mkdirSync above
    // the exit and the state directory appears, while readLines still throws
    // because no file was ever written, so the assertion above stays green and
    // the regression goes unseen.
    expect(existsSync(join(result.home, ".claude", "state"))).toBe(false);
  });
});

describe("spawned process — malformed and absent stdin", () => {
  test("malformed JSON: exits 0, one stderr diagnostic, no state file", () => {
    const result = spawnHook("{not json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("memory-transition-log: hook error, skipping:");
    expect(() => readLines(result.home)).toThrow();
  });

  test("empty stdin: JSON.parse('') throws, caught the same way, exits 0", () => {
    const result = spawnHook("");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("memory-transition-log: hook error, skipping:");
    expect(() => readLines(result.home)).toThrow();
  });

  // Valid JSON `null` reaches `payload.tool_name` unguarded and throws a
  // TypeError, caught by the same outer try/catch as a parse failure. Externally
  // indistinguishable from the malformed-JSON case (exit 0, no file), which is
  // why this is filed as an observation rather than a defect in the report.
  test("literal JSON null payload: still fails open via the catch, not a guard", () => {
    const result = spawnHook("null");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("memory-transition-log: hook error, skipping:");
    expect(() => readLines(result.home)).toThrow();
  });
});

describe("spawned process — happy path writes, one per transition kind", () => {
  test("status-changed: state file line carries old/new/notePath/tool/ts", () => {
    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", withStatus("proposed"), withStatus("accepted")));
    expect(result.exitCode).toBe(0);
    const lines = readLines(result.home) as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      transition: "status-changed",
      old: "proposed",
      new: "accepted",
      notePath: notePathFor("/home/runner/project/memory/note.md"),
      tool: "Edit",
    });
    expect(typeof lines[0].ts).toBe("string");
    expect(new Date(lines[0].ts as string).toString()).not.toBe("Invalid Date");
  });

  test("revisit-removed: correct kind, no old/new fields", () => {
    const oldText = "## Revisit when\n\nCondition.\n";
    const newText = "Condition resolved.\n";
    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", oldText, newText));
    const lines = readLines(result.home) as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0].transition).toBe("revisit-removed");
    expect(lines[0]).not.toHaveProperty("old");
    expect(lines[0]).not.toHaveProperty("new");
  });

  test("status-rejected-appeared: carries the prior status as old", () => {
    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", withStatus("proposed"), withStatus("rejected")));
    const lines = readLines(result.home) as Record<string, unknown>[];
    const rejected = lines.find((l) => l.transition === "status-rejected-appeared");
    expect(rejected).toMatchObject({ old: "proposed" });
  });

  test("a single edit firing two transition kinds writes two JSONL lines", () => {
    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", withStatus("accepted"), withStatus("rejected")));
    const lines = readLines(result.home) as Record<string, unknown>[];
    const kinds = lines.map((l) => l.transition).sort();
    expect(kinds).toEqual(["status-changed", "status-rejected-appeared"]);
  });

  test.each([
    ["present in payload", { session_id: "sess-fixture-1" }, true],
    ["absent from payload", {}, false],
  ])("sessionId %s on the written line", (_label, extra, present) => {
    const result = spawnHook(
      EDIT_PAYLOAD("/home/runner/project/memory/note.md", withStatus("proposed"), withStatus("accepted"), extra),
    );
    const [line] = readLines(result.home) as Record<string, unknown>[];
    expect("sessionId" in line).toBe(present);
    if (present) expect(line.sessionId).toBe("sess-fixture-1");
  });

  // Windows-style absolute path end to end: inMemoryDir's backslash split has to
  // find the segment, and the written notePath has to come out forward-slashed.
  //
  // Windows-only, and the guard is load-bearing rather than defensive. On POSIX
  // `isAbsolute("C:\\Users\\...")` is FALSE, so the hook takes its `resolve(cwd, ...)`
  // branch and prefixes the runner's own working directory, making the expected
  // string unsatisfiable in principle rather than merely wrong -- the payload
  // supplies no cwd, so there is no constant that could stand in for it. CI runs
  // `bun test` unfiltered on ubuntu-24.04, so without this guard the commit reds
  // the pipeline. Same convention as test/identity-gate.test.ts and
  // test/pre-commit.test.ts, and the same platform assumption
  // .github/workflows/test.yml already names as one that broke the Pester tier.
  test.skipIf(process.platform !== "win32")(
    "Windows-separator absolute file_path resolves and normalizes notePath to forward slashes",
    () => {
      const result = spawnHook(
        EDIT_PAYLOAD("C:\\Users\\fixture\\project\\memory\\note.md", withStatus("proposed"), withStatus("accepted")),
      );
      expect(result.exitCode).toBe(0);
      const [line] = readLines(result.home) as Record<string, unknown>[];
      expect(line.notePath).toBe("C:/Users/fixture/project/memory/note.md");
    },
  );

  // Relative file_path resolved against the payload's own cwd field, not
  // process.cwd() — the same convention agent-write-scope.ts uses.
  test("relative file_path resolves against payload.cwd", () => {
    const cwd = "/home/runner/other-project";
    const result = spawnHook(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "memory/note.md", old_string: withStatus("proposed"), new_string: withStatus("accepted") },
        cwd,
      }),
    );
    const [line] = readLines(result.home) as Record<string, unknown>[];
    expect(line.notePath).toBe(resolve(cwd, "memory/note.md").replace(/\\/g, "/"));
  });

  test("a second qualifying edit appends a second line rather than overwriting the first", () => {
    const home = freshHome();
    spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", withStatus("proposed"), withStatus("accepted")), home);
    spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/other.md", withStatus("accepted"), withStatus("superseded")), home);
    const lines = readLines(home) as Record<string, unknown>[];
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.notePath)).toEqual([
      notePathFor("/home/runner/project/memory/note.md"),
      notePathFor("/home/runner/project/memory/other.md"),
    ]);
  });
});

describe("spawned process — filesystem edge cases", () => {
  test("neither .claude nor .claude/state exists yet: both get created and the file is written", () => {
    const home = freshHome(); // freshHome() only mkdtemp's the top dir; .claude never exists under it
    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", withStatus("proposed"), withStatus("accepted")), home);
    expect(result.exitCode).toBe(0);
    expect(readLines(home)).toHaveLength(1);
  });

  // The parent directory the hook expects (.claude/state) is pre-occupied by a
  // plain file instead of a directory — a stale artifact from some other
  // process, say. mkdirSync is skipped (existsSync sees something there) and
  // appendFileSync then fails trying to create a path inside a file. Confirmed
  // empirically on this host that this throws (ENOENT on Windows); the hook
  // must still fail open rather than let the throw escape.
  test("write blocked by a pre-existing file where the state directory should be: fails open, leaves the file untouched", () => {
    const home = freshHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir);
    writeFileSync(join(claudeDir, "state"), "stale, not a directory");

    const result = spawnHook(EDIT_PAYLOAD("/home/runner/project/memory/note.md", withStatus("proposed"), withStatus("accepted")), home);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("memory-transition-log: hook error, skipping:");
    expect(readFileSync(join(claudeDir, "state"), "utf8")).toBe("stale, not a directory");
  });
});
