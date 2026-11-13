import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseManifest,
  sourceDeclaresTest,
  parseJunit,
  judgeDefect,
  runNet,
  testFilterPattern,
  type Defect,
  type Outcome,
} from "./regression/net";

// Unit tests for the regression net's own logic (issue #96). They never run the corpus: the
// corpus is `bun run regression`, and running it from inside `bun test` would recurse. The one
// exception is the static check at the bottom, which reads the real manifest and every file it
// names without executing a single mapped test.

const defect = (over: Partial<Defect> = {}): Defect => ({
  id: "d1",
  defect: "one line",
  fixedBy: "abc1234",
  tests: [{ file: "test/a.test.ts", name: "does the thing" }],
  ...over,
});

const junit = (cases: string) =>
  `<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
const passed = (name: string) => `<testcase name="${name}" classname="s" />`;
const skipped = (name: string) => `<testcase name="${name}" classname="s"><skipped /></testcase>`;
const failed = (name: string) =>
  `<testcase name="${name}" classname="s"><failure type="AssertionError" /></testcase>`;

describe("parseManifest", () => {
  test("accepts a well-formed entry", () => {
    expect(parseManifest(JSON.stringify([defect()]))).toHaveLength(1);
  });

  test.each([
    ["not JSON", "{"],
    ["not an array", "{}"],
    ["an empty array", "[]"],
  ])("refuses %s", (_label, text) => {
    expect(() => parseManifest(text)).toThrow();
  });

  test("refuses an entry with no pinning test", () => {
    expect(() => parseManifest(JSON.stringify([defect({ tests: [] })]))).toThrow(/no pinning test/);
  });

  test("refuses a duplicate id", () => {
    expect(() => parseManifest(JSON.stringify([defect(), defect()]))).toThrow(/duplicate id/);
  });

  test.each(["id", "defect", "fixedBy"] as const)("refuses a blank %s", (key) => {
    expect(() => parseManifest(JSON.stringify([defect({ [key]: "  " })]))).toThrow(new RegExp(key));
  });

  test("refuses a multi-line description", () => {
    expect(() => parseManifest(JSON.stringify([defect({ defect: "a\nb" })]))).toThrow(/one line/);
  });

  test("refuses a test entry missing its file or name", () => {
    expect(() =>
      parseManifest(JSON.stringify([defect({ tests: [{ file: "", name: "x" }] })])),
    ).toThrow(/file/);
    expect(() =>
      parseManifest(JSON.stringify([defect({ tests: [{ file: "a.ts", name: "" }] })])),
    ).toThrow(/name/);
  });
});

describe("sourceDeclaresTest", () => {
  test("finds a name opening a test() call, in any quote style", () => {
    expect(sourceDeclaresTest(`test("does the thing", () => {})`, "does the thing")).toBe(true);
    expect(sourceDeclaresTest(`  it('does the thing', () => {})`, "does the thing")).toBe(true);
    expect(sourceDeclaresTest("test(`does the thing`, () => {})", "does the thing")).toBe(true);
  });

  test("finds a name on the line after the open paren, and behind a modifier", () => {
    expect(
      sourceDeclaresTest(`test.skipIf(!x)(\n  "does the thing",\n () => {})`, "does the thing"),
    ).toBe(true);
    expect(sourceDeclaresTest(`test.only("does the thing", () => {})`, "does the thing")).toBe(true);
  });

  test("a name that only appears in a comment or an assertion is not a declared test", () => {
    expect(sourceDeclaresTest(`// "does the thing"`, "does the thing")).toBe(false);
    expect(sourceDeclaresTest(`expect(x).toBe("does the thing")`, "does the thing")).toBe(false);
  });

  test("a longer name does not stand in for a shorter one", () => {
    expect(sourceDeclaresTest(`test("does the thing twice", () => {})`, "does the thing")).toBe(false);
  });

  test("regex metacharacters in the name are literal", () => {
    expect(sourceDeclaresTest(`test("a (b) [c] d.*", () => {})`, "a (b) [c] d.*")).toBe(true);
    expect(sourceDeclaresTest(`test("a (b) [c] dXX", () => {})`, "a (b) [c] d.*")).toBe(false);
  });
});

describe("testFilterPattern", () => {
  test("anchors each name to the end and escapes it, so bun -t selects only that test", () => {
    const re = new RegExp(testFilterPattern(["a.b", "c (d)"]));
    expect(re.test("describe a.b")).toBe(true);
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
    expect(re.test("c (d)")).toBe(true);
    expect(re.test("a.b and more")).toBe(false);
  });
});

describe("parseJunit", () => {
  test("classifies pass, skip and fail, decoding entities in names", () => {
    const m = parseJunit(
      junit(passed("ok &amp; fine") + skipped("sk") + failed("bad &quot;one&quot;")),
    );
    expect(m.get("ok & fine")).toEqual(["pass"]);
    expect(m.get("sk")).toEqual(["skip"]);
    expect(m.get('bad "one"')).toEqual(["fail"]);
  });

  test("keeps every outcome when a name repeats", () => {
    expect(parseJunit(junit(passed("x") + failed("x"))).get("x")).toEqual(["pass", "fail"]);
  });

  test("an errored case is a fail", () => {
    expect(parseJunit(junit(`<testcase name="e"><error /></testcase>`)).get("e")).toEqual(["fail"]);
  });
});

describe("judgeDefect", () => {
  const declares = () => true;
  const fileExists = () => true;
  const outcomes = (entries: [string, Outcome[]][]) => new Map<string, Outcome[]>(entries);

  test("caught when every pinned test ran and passed", () => {
    const v = judgeDefect(defect(), { fileExists, declares, outcomes: outcomes([["does the thing", ["pass"]]]) });
    expect(v.caught).toBe(true);
  });

  test("not caught when the mapped file is gone", () => {
    const v = judgeDefect(defect(), { fileExists: () => false, declares, outcomes: outcomes([]) });
    expect(v.caught).toBe(false);
    expect(v.reasons.join("\n")).toMatch(/file not found: test\/a\.test\.ts/);
  });

  test("not caught when the mapped name is gone", () => {
    const v = judgeDefect(defect(), { fileExists, declares: () => false, outcomes: outcomes([]) });
    expect(v.caught).toBe(false);
    expect(v.reasons.join("\n")).toMatch(/no test named "does the thing"/);
  });

  test("not caught when the test is skipped, failing, or never ran", () => {
    for (const o of [
      outcomes([["does the thing", ["skip"]]]),
      outcomes([["does the thing", ["fail"]]]),
      outcomes([["does the thing", ["pass", "fail"]]]),
      outcomes([]),
    ]) {
      expect(judgeDefect(defect(), { fileExists, declares, outcomes: o }).caught).toBe(false);
    }
  });

  test("one uncaught test among several uncatches the defect", () => {
    const d = defect({ tests: [{ file: "a", name: "one" }, { file: "a", name: "two" }] });
    const v = judgeDefect(d, {
      fileExists,
      declares,
      outcomes: outcomes([["one", ["pass"]], ["two", ["fail"]]]),
    });
    expect(v.caught).toBe(false);
    expect(v.reasons).toHaveLength(1);
  });
});

describe("runNet", () => {
  function fixtureRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "regression-net-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  }
  const src = `test("does the thing", () => {})`;

  test("runs each file once with its pinned names and reports caught", async () => {
    const root = fixtureRoot({ "test/a.test.ts": src });
    const calls: [string, string[]][] = [];
    const out = await runNet({
      manifest: [defect(), defect({ id: "d2" })],
      root,
      runBun: async (file, names) => {
        calls.push([file, names]);
        return junit(passed("does the thing"));
      },
    });
    expect(out.map((v) => v.caught)).toEqual([true, true]);
    expect(calls).toEqual([["test/a.test.ts", ["does the thing"]]]);
  });

  test("runs one file at a time, so slow pinned tests are never starved by a sibling bun process", async () => {
    const root = fixtureRoot({ "test/a.test.ts": src, "test/b.test.ts": src, "test/c.test.ts": src });
    let active = 0;
    let peak = 0;
    const out = await runNet({
      manifest: ["a", "b", "c"].map((x) => defect({ id: x, tests: [{ file: `test/${x}.test.ts`, name: "does the thing" }] })),
      root,
      runBun: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((done) => setTimeout(done, 20));
        active--;
        return junit(passed("does the thing"));
      },
    });
    expect(out.map((v) => v.caught)).toEqual([true, true, true]);
    expect(peak).toBe(1);
  });

  test("a bun run that produced no report leaves its tests not caught", async () => {
    const root = fixtureRoot({ "test/a.test.ts": src });
    const out = await runNet({ manifest: [defect()], root, runBun: async () => null });
    expect(out[0].caught).toBe(false);
  });

  test("never runs a test whose file or name is missing", async () => {
    const root = fixtureRoot({ "test/a.test.ts": `test("other", () => {})` });
    let ran = false;
    const out = await runNet({
      manifest: [defect(), defect({ id: "d2", tests: [{ file: "test/gone.test.ts", name: "x" }] })],
      root,
      runBun: async () => {
        ran = true;
        return "";
      },
    });
    expect(ran).toBe(false);
    expect(out.map((v) => v.caught)).toEqual([false, false]);
  });
});

describe("the committed manifest", () => {
  // Static only: every pinned file exists and declares every pinned name, without running them.
  // A rename that orphans a pin fails the ordinary suite here, long before anyone runs the net.
  const root = resolve(import.meta.dir, "..");
  const manifest = parseManifest(readFileSync(join(root, "test/regression/manifest.json"), "utf8"));

  test("holds at least fifteen defects", () => {
    expect(manifest.length).toBeGreaterThanOrEqual(15);
  });

  test("every pinned file exists and declares every pinned test name", () => {
    const problems: string[] = [];
    for (const d of manifest) {
      for (const t of d.tests) {
        const p = join(root, t.file);
        if (!existsSync(p)) {
          problems.push(`${d.id}: file not found: ${t.file}`);
        } else if (!sourceDeclaresTest(readFileSync(p, "utf8"), t.name)) {
          problems.push(`${d.id}: no test named "${t.name}" in ${t.file}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("pins no test behind a skip modifier, since a skipped pin catches nothing", () => {
    const guarded: string[] = [];
    for (const d of manifest) {
      for (const t of d.tests) {
        const src = readFileSync(join(root, t.file), "utf8");
        const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const modified = new RegExp(`\\.(?:skip|todo|skipIf)\\((?:[^()]*\\)\\()?\\s*["'\`]${esc}["'\`]`);
        if (modified.test(src)) {
          guarded.push(`${d.id}: ${t.name}`);
        }
      }
    }
    expect(guarded).toEqual([]);
  });
});
