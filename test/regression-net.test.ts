import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseManifest,
  sourceDeclaresTest,
  parseJunit,
  judgeDefect,
  renderReport,
  runNet,
  testFilterPattern,
  type Defect,
  type JunitCase,
  type Outcome,
  type Verdict,
} from "./regression/net";

// Unit tests for the regression net's own logic (issue #96). They never run the corpus: the
// corpus is `bun run regression`, and running it from inside `bun test` would recurse. The one
// exception is the static check at the bottom, which reads the real manifest and every file it
// names without executing a single mapped test.

const defect = (over: Partial<Defect> = {}): Defect => ({
  id: "d1",
  defect: "one line",
  fixedBy: "abc1234",
  verified: "ablated",
  tests: [{ file: "test/a.test.ts", name: "does the thing" }],
  ...over,
});

const junit = (cases: string) =>
  `<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
const passed = (name: string, cls = "s") => `<testcase name="${name}" classname="${cls}" />`;
const skipped = (name: string, cls = "s") => `<testcase name="${name}" classname="${cls}"><skipped /></testcase>`;
const failed = (name: string, cls = "s") =>
  `<testcase name="${name}" classname="${cls}"><failure type="AssertionError" /></testcase>`;

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

  test.each([["missing", undefined], ["blank", " "], ["a bare assumed", "assumed"], ["an unknown word", "checked"]])(
    "refuses a verified field that is %s",
    (_label, value) => {
      const entry = { ...defect(), verified: value };
      expect(() => parseManifest(JSON.stringify([entry]))).toThrow(/verified/);
    },
  );

  test("accepts an assumed entry that gives its reason", () => {
    expect(parseManifest(JSON.stringify([defect({ verified: "assumed: the fix is not revertable" })]))).toHaveLength(1);
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

  test("finds a name on the line after the open paren", () => {
    expect(sourceDeclaresTest(`test(\n  "does the thing",\n () => {})`, "does the thing")).toBe(true);
  });

  // Each modifier can leave a pinned test passing or unrun without checking its fix. `.failing`
  // reports a test whose body throws as passing, so a regression parked there would read CAUGHT.
  test.each(["failing", "skip", "todo", "only", "skipIf(!x)", "if(x)", "todoIf(x)", "each([1])"])(
    "a pin behind the .%s modifier is not a declared test",
    (modifier) => {
      expect(sourceDeclaresTest(`test.${modifier}("does the thing", () => {})`, "does the thing")).toBe(false);
    },
  );

  test("a name that only appears in a comment or an assertion is not a declared test", () => {
    expect(sourceDeclaresTest(`// "does the thing"`, "does the thing")).toBe(false);
    expect(sourceDeclaresTest(`expect(x).toBe("does the thing")`, "does the thing")).toBe(false);
  });

  test("a test() call inside a line or block comment is not a declared test", () => {
    expect(sourceDeclaresTest(`// test("does the thing", () => {})`, "does the thing")).toBe(false);
    expect(sourceDeclaresTest(`/* test("does the thing", () => {}) */`, "does the thing")).toBe(false);
    expect(sourceDeclaresTest(`/*\n  test("does the thing", () => {})\n*/`, "does the thing")).toBe(false);
  });

  test("a comment marker inside a string or regex does not hide the real test after it", () => {
    const url = `const u = "https://x.test/a"; test("does the thing", () => {})`;
    expect(sourceDeclaresTest(url, "does the thing")).toBe(true);
    const re = `const r = /a"\\/\/b/; test("does the thing", () => {})`;
    expect(sourceDeclaresTest(re, "does the thing")).toBe(true);
    expect(sourceDeclaresTest(`/* c */ test("does the thing", () => {}) // tail`, "does the thing")).toBe(true);
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
    expect(m.map((c) => [c.name, c.outcome])).toEqual([
      ["ok & fine", "pass"],
      ["sk", "skip"],
      ['bad "one"', "fail"],
    ]);
  });

  test("keeps every case when a title repeats, each with its describe path", () => {
    const m = parseJunit(junit(passed("x", "first &amp; one") + failed("x", "second")));
    expect(m).toEqual([
      { classname: "first & one", name: "x", outcome: "pass" },
      { classname: "second", name: "x", outcome: "fail" },
    ]);
  });

  test("an errored case is a fail", () => {
    expect(parseJunit(junit(`<testcase name="e"><error /></testcase>`))).toEqual([
      { classname: "", name: "e", outcome: "fail" },
    ]);
  });
});

describe("judgeDefect", () => {
  const declares = () => true;
  const fileExists = () => true;
  const outcomes = (entries: [string, Outcome][]): JunitCase[] =>
    entries.map(([name, outcome]) => ({ classname: "s", name, outcome }));

  test("caught when every pinned test ran and passed", () => {
    const v = judgeDefect(defect(), { fileExists, declares, outcomes: outcomes([["does the thing", "pass"]]) });
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
      outcomes([["does the thing", "skip"]]),
      outcomes([["does the thing", "fail"]]),
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
      outcomes: outcomes([["one", "pass"], ["two", "fail"]]),
    });
    expect(v.caught).toBe(false);
    expect(v.reasons).toHaveLength(1);
  });

  // The pin names a title, not a describe path. A same-titled twin elsewhere in the file must not
  // be able to speak for the pinned test, whichever way the twin went.
  test("not caught when two describes share the title, one passing and one failing", () => {
    const xml = junit(passed("does the thing", "first describe") + failed("does the thing", "second describe"));
    const v = judgeDefect(defect(), { fileExists, declares, outcomes: parseJunit(xml) });
    expect(v.caught).toBe(false);
    expect(v.reasons.join("\n")).toContain("first describe > does the thing");
    expect(v.reasons.join("\n")).toContain("second describe > does the thing");
  });

  test("not caught when a passing twin hides a skipped pinned test", () => {
    const xml = junit(passed("does the thing", "first describe") + skipped("does the thing", "second describe"));
    expect(judgeDefect(defect(), { fileExists, declares, outcomes: parseJunit(xml) }).caught).toBe(false);
  });

  test("a longer title ending in the pinned one does not stand in for it", () => {
    const xml = junit(passed("it also does the thing", "s"));
    expect(judgeDefect(defect(), { fileExists, declares, outcomes: parseJunit(xml) }).caught).toBe(false);
  });
});

describe("renderReport", () => {
  const verdict = (over: Partial<Verdict> = {}): Verdict => ({
    id: "d1",
    defect: "one line",
    fixedBy: "abc1234",
    verified: "ablated",
    caught: true,
    reasons: [],
    ...over,
  });

  test("a static report never says a defect is caught, and does not claim they stay caught", () => {
    const { text, code } = renderReport([verdict(), verdict({ id: "d2" })], "static");
    expect(text).not.toMatch(/caught|stay/i);
    expect(text).toContain("RESOLVES");
    expect(text).toContain("No test ran");
    expect(code).toBe(0);
  });

  test("a static report names a pin that does not resolve and exits 1", () => {
    const { text, code } = renderReport([verdict({ id: "gone", caught: false, reasons: ["file not found: x"] })], "static");
    expect(text).toContain("UNRESOLVED");
    expect(text).toContain("UNRESOLVED: gone");
    expect(code).toBe(1);
  });

  test("a full report tags an assumed catch apart from an ablated one and counts both", () => {
    const { text, code } = renderReport(
      [verdict(), verdict({ id: "d2", verified: "assumed: not reverted" })],
      "run",
    );
    expect(text).toMatch(/CAUGHT\s+\[ablated\]\s+d1/);
    expect(text).toMatch(/CAUGHT\s+\[assumed\]\s+d2/);
    expect(text).toContain("2 of 2 known defects caught (every pinned test run): 1 ablated, 1 assumed.");
    expect(code).toBe(0);
  });

  test("a full report prints no verified tag on a defect that was not caught", () => {
    const { text, code } = renderReport([verdict({ caught: false, reasons: ["failed: x"] })], "run");
    expect(text).toMatch(/NOT CAUGHT\s+d1/);
    expect(text).not.toContain("[ablated]");
    expect(code).toBe(1);
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
