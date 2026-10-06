// Tests for the pack generator (tools/packs/, #254).
//
// The invariant: every generated manifest and component tree is a pure function of packs.json and
// the member sources, and `--check` reports any divergence. Three groups pin it. The shape group
// asserts what is emitted, the drift group asserts that each way the disk can diverge is reported,
// and the refusal group asserts that a source which breaks a rule from the #254 contract is refused
// before anything is written.
//
// Fixtures are throwaway repositories under the OS temp directory, built per test. The one test that
// reads the real repository is the drift gate itself: the committed packs/ tree must match what
// packs.json plus its members generate, and `bun test` is how CI runs that check.
//
// Why a drift test can fail at all, and not just pass: each case in the drift group mutates a tree
// that was verified clean one line earlier, so a checker that returned an empty list unconditionally
// would fail every one of them.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../tools/packs/cli";
import type { IdentityLoad } from "../tools/pr-review/identity";
import { buildPlan, checkTree, frontmatterName, PackError, writePlan } from "../tools/packs/packs";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI = join(REPO_ROOT, "tools", "packs", "cli.ts");

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: A skill.\n---\n\nBody.\n`;
const agentMd = (name: string): string => `---\nname: ${name}\ndescription: An agent.\n---\n\nBody.\n`;
const hooksOk = JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"' }] }] },
});

const DEMO = {
  id: "demo",
  version: "1.2.3",
  tier: "domain",
  description: "Demo pack.",
  members: { skills: ["lib/skills/alpha"], agents: ["lib/agents/reviewer.md"], hooks: "lib/hooks" },
};

function sourceOf(packs: unknown[]): string {
  return JSON.stringify({
    schema: 1,
    marketplace: { name: "fixture-market", owner: "Fixture", description: "Fixture marketplace." },
    packs,
  });
}

// Members are read from the index, so a fixture is a repository and put() stages what it writes.
// putUntracked() writes without staging, which is what a scratch or ignored file looks like.
function putUntracked(root: string, rel: string, data: string | Buffer): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

function put(root: string, rel: string, data: string | Buffer): void {
  putUntracked(root, rel, data);
  if (spawnSync("git", ["-C", root, "add", "-f", "--", rel]).status !== 0) throw new Error("fixture add failed");
}

/** A fixture repository holding one skill, one agent and one hook bundle, and a packs.json over them. */
function makeRoot(packs: unknown[] = [DEMO]): string {
  const root = mkdtempSync(join(tmpdir(), "packs-"));
  made.push(root);
  if (spawnSync("git", ["-C", root, "init", "-q"]).status !== 0) throw new Error("fixture init failed");
  put(root, "packs.json", sourceOf(packs));
  put(root, "lib/skills/alpha/SKILL.md", skillMd("alpha"));
  put(root, "lib/skills/alpha/references/notes.md", "notes\n");
  put(root, "lib/agents/reviewer.md", agentMd("reviewer"));
  put(root, "lib/hooks/hooks.json", hooksOk);
  put(root, "lib/hooks/run.sh", "#!/bin/sh\nexit 0\n");
  return root;
}

/** Writes the generated tree and proves it is clean before a test mutates it. */
function generated(packs: unknown[] = [DEMO]): string {
  const root = makeRoot(packs);
  writePlan(root, buildPlan(root));
  expect(checkTree(root, buildPlan(root))).toEqual([]);
  return root;
}

function listAll(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (rel === "" && e.name === ".git") continue; // the fixture's own repository, not generated output
    const child = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listAll(dir, child));
    else out.push(child);
  }
  return out.sort();
}

function tryLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

// Probed once. A junction on Windows and a directory symlink elsewhere need no elevation in CI, but
// a locked-down workstation can refuse, and the link tests below skip rather than pass vacuously.
const CAN_LINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "packs-link-probe-"));
  made.push(dir);
  mkdirSync(join(dir, "target"));
  return tryLink(join(dir, "target"), join(dir, "link"));
})();

const readJson = (plan: Map<string, Buffer>, path: string): Record<string, unknown> =>
  JSON.parse(plan.get(path)!.toString("utf8"));

describe("generated shape", () => {
  test("a pack gets one plugin.json carrying name, version and description and no component field", () => {
    const plan = buildPlan(makeRoot());
    const manifest = readJson(plan, "packs/demo/.claude-plugin/plugin.json");
    expect(Object.keys(manifest)).toEqual(["name", "version", "description"]);
    expect(manifest).toEqual({ name: "demo", version: "1.2.3", description: "Demo pack." });
  });

  test("author, license, homepage, repository and keywords pass through when the source has them", () => {
    const full = {
      ...DEMO,
      author: { name: "Fixture" },
      license: "MIT",
      homepage: "https://example.invalid/home",
      repository: "https://example.invalid/repo",
      keywords: ["a", "b"],
    };
    const manifest = readJson(buildPlan(makeRoot([full])), "packs/demo/.claude-plugin/plugin.json");
    expect(Object.keys(manifest)).toEqual([
      "name",
      "version",
      "description",
      "author",
      "license",
      "homepage",
      "repository",
      "keywords",
    ]);
    expect(manifest.author).toEqual({ name: "Fixture" });
  });

  test("components land at the default paths both CLIs discover", () => {
    const keys = [...buildPlan(makeRoot()).keys()].sort();
    expect(keys).toEqual([
      ".claude-plugin/marketplace.json",
      "packs/demo/.claude-plugin/plugin.json",
      "packs/demo/agents/reviewer.md",
      "packs/demo/hooks/hooks.json",
      "packs/demo/hooks/run.sh",
      "packs/demo/skills/alpha/SKILL.md",
      "packs/demo/skills/alpha/references/notes.md",
    ]);
  });

  // A root plugin.json is invisible to Claude and preferred by Copilot, so a second one would give
  // the pack two identities. The only manifest written is the .claude-plugin one.
  test("no second manifest is emitted anywhere", () => {
    const manifests = [...buildPlan(makeRoot()).keys()].filter((k) => /(^|\/)plugin\.json$/.test(k));
    expect(manifests).toEqual(["packs/demo/.claude-plugin/plugin.json"]);
  });

  test("the marketplace entry for every pack carries the name and version of that pack's plugin.json", () => {
    const second = { ...DEMO, id: "second", version: "0.0.7", members: { skills: ["lib/skills/alpha"] } };
    const plan = buildPlan(makeRoot([DEMO, second]));
    const market = readJson(plan, ".claude-plugin/marketplace.json") as {
      name: string;
      owner: { name: string };
      metadata: { description: string };
      plugins: { name: string; version: string; source: string }[];
    };
    expect(market.name).toBe("fixture-market");
    expect(market.owner).toEqual({ name: "Fixture" });
    expect(market.metadata.description).toBe("Fixture marketplace.");
    expect(market.plugins.map((p) => p.name)).toEqual(["demo", "second"]);
    for (const entry of market.plugins) {
      const manifest = readJson(plan, `packs/${entry.name}/.claude-plugin/plugin.json`);
      expect({ name: entry.name, version: entry.version }).toEqual({ name: manifest.name, version: manifest.version });
      expect(entry.source).toBe(`./packs/${entry.name}`);
    }
  });

  test("dependsOn is validated but never reaches a manifest", () => {
    const base = { ...DEMO, id: "base", members: { skills: ["lib/skills/alpha"] } };
    const top = { ...DEMO, id: "top", dependsOn: ["base"], members: { skills: ["lib/skills/alpha"] } };
    const plan = buildPlan(makeRoot([base, top]));
    expect(plan.get("packs/top/.claude-plugin/plugin.json")!.toString("utf8")).not.toContain("dependsOn");
    expect(plan.get(".claude-plugin/marketplace.json")!.toString("utf8")).not.toContain("dependsOn");
  });

  test("two builds from the same sources are byte-identical", () => {
    const root = makeRoot();
    const a = buildPlan(root);
    const b = buildPlan(root);
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [k, v] of a) expect(v.equals(b.get(k)!)).toBe(true);
  });

  test("dot entries and __pycache__ in a member tree are not copied", () => {
    const root = makeRoot();
    put(root, "lib/skills/alpha/.DS_Store", "junk");
    put(root, "lib/skills/alpha/__pycache__/x.pyc", "junk");
    put(root, "lib/skills/alpha/.hidden/y.md", "junk");
    expect([...buildPlan(root).keys()].filter((k) => k.includes("skills/alpha/"))).toEqual([
      "packs/demo/skills/alpha/SKILL.md",
      "packs/demo/skills/alpha/references/notes.md",
    ]);
  });

  test("an untracked file in a member directory is not copied, nor is a nested synced directory", () => {
    const root = makeRoot();
    putUntracked(root, "lib/skills/alpha/scratch.md", "not committed");
    putUntracked(root, "lib/skills/alpha/synced/third-party/SKILL.md", "proprietary");
    putUntracked(root, "lib/hooks/untracked.sh", "not committed");
    expect([...buildPlan(root).keys()].filter((k) => /scratch|synced|untracked/.test(k))).toEqual([]);
  });

  test("a member file that is not tracked is refused, and so is a root that is not a work tree", () => {
    const root = makeRoot();
    putUntracked(root, "lib/agents/loose.md", agentMd("loose"));
    put(root, "packs.json", sourceOf([{ ...DEMO, members: { ...DEMO.members, agents: ["lib/agents/loose.md"] } }]));
    expect(() => buildPlan(root)).toThrow("is not tracked");
    const bare = mkdtempSync(join(tmpdir(), "packs-bare-"));
    made.push(bare);
    // Member files exist here, so resolveMember passes and only the work-tree refusal can fire.
    putUntracked(bare, "packs.json", sourceOf([DEMO]));
    putUntracked(bare, "lib/skills/alpha/SKILL.md", skillMd("alpha"));
    putUntracked(bare, "lib/agents/reviewer.md", agentMd("reviewer"));
    putUntracked(bare, "lib/hooks/hooks.json", hooksOk);
    expect(() => buildPlan(bare)).toThrow("the root is not a work tree");
  });

  test("a NUL-free member that is not valid UTF-8 is refused", () => {
    const root = makeRoot();
    // Short deflate-style bytes: no NUL, but 0xff and 0x8b can never appear in UTF-8.
    put(root, "lib/skills/alpha/blob.dat", Buffer.from([0x78, 0x9c, 0xff, 0x8b, 0xc3, 0x28]));
    expect(() => buildPlan(root)).toThrow(/binary file/);
  });

  test("a .local.md overlay beside a member is not copied", () => {
    const root = makeRoot();
    put(root, "lib/skills/alpha/notes.local.md", "one machine's particulars");
    expect([...buildPlan(root).keys()].some((k) => k.endsWith(".local.md"))).toBe(false);
  });

  test("a binary member file is refused, since the identity gate cannot read it", () => {
    const root = makeRoot();
    // A UTF-16 BOM then NUL-interleaved text: a string inside it would pass a UTF-8 scan.
    put(root, "lib/skills/alpha/note.txt", Buffer.from([0xff, 0xfe, 0x73, 0x00, 0x65, 0x00]));
    expect(() => buildPlan(root)).toThrow(/binary file/);
  });

  test("a CRLF source writes LF output, and a CRLF checkout of the output is not drift", () => {
    const root = makeRoot();
    put(root, "lib/skills/alpha/SKILL.md", skillMd("alpha").replace(/\n/g, "\r\n"));
    const plan = buildPlan(root);
    expect(plan.get("packs/demo/skills/alpha/SKILL.md")!.includes(0x0d)).toBe(false);
    writePlan(root, plan);
    // What a Windows checkout with core.autocrlf does to every text file in the tree.
    for (const rel of listAll(root).filter((p) => p.startsWith("packs/") || p.startsWith(".claude-plugin/"))) {
      const text = readFileSync(join(root, rel), "utf8");
      writeFileSync(join(root, rel), text.replace(/\r?\n/g, "\r\n"));
    }
    expect(checkTree(root, buildPlan(root))).toEqual([]);
  });

  test("frontmatterName reads a quoted name and ignores a name key that is not at column 0", () => {
    expect(frontmatterName('---\nname: "quoted"\n---\n')).toBe("quoted");
    expect(frontmatterName("---\r\nname: crlf\r\n---\r\n")).toBe("crlf");
    expect(frontmatterName("---\ndescription: x\n  name: nested\n---\n")).toBeNull();
    expect(frontmatterName("no frontmatter here")).toBeNull();
  });
});

describe("drift check", () => {
  test("a tree written by the generator is clean", () => {
    generated();
  });

  test("a tree that was never generated reports every file missing", () => {
    const root = makeRoot();
    const drift = checkTree(root, buildPlan(root));
    expect(drift.length).toBe(buildPlan(root).size);
    expect(new Set(drift.map((d) => d.kind))).toEqual(new Set(["missing"]));
  });

  test("a hand edit to a generated file is reported as changed", () => {
    const root = generated();
    put(root, "packs/demo/.claude-plugin/plugin.json", '{"name":"demo","version":"9.9.9","description":"x"}\n');
    expect(checkTree(root, buildPlan(root))).toEqual([{ kind: "changed", path: "packs/demo/.claude-plugin/plugin.json" }]);
  });

  test("a deleted generated file is reported as missing", () => {
    const root = generated();
    rmSync(join(root, "packs/demo/agents/reviewer.md"));
    expect(checkTree(root, buildPlan(root))).toEqual([{ kind: "missing", path: "packs/demo/agents/reviewer.md" }]);
  });

  test("a source edit that was not regenerated is reported", () => {
    const root = generated();
    put(root, "lib/skills/alpha/references/notes.md", "edited upstream\n");
    expect(checkTree(root, buildPlan(root))).toEqual([{ kind: "changed", path: "packs/demo/skills/alpha/references/notes.md" }]);
  });

  test("a version bump in packs.json that was not regenerated changes the manifest and the marketplace", () => {
    const root = generated();
    put(root, "packs.json", sourceOf([{ ...DEMO, version: "1.2.4" }]));
    expect(checkTree(root, buildPlan(root)).map((d) => d.path)).toEqual([
      ".claude-plugin/marketplace.json",
      "packs/demo/.claude-plugin/plugin.json",
    ]);
  });

  test("a second manifest added under a pack reads as extra, so a pack cannot gain two identities", () => {
    const root = generated();
    put(root, "packs/demo/plugin.json", '{"name":"other","version":"1.0.0"}\n');
    put(root, "packs/demo/.plugin/plugin.json", "{}\n");
    expect(checkTree(root, buildPlan(root))).toEqual([
      { kind: "extra", path: "packs/demo/.plugin/plugin.json" },
      { kind: "extra", path: "packs/demo/plugin.json" },
    ]);
  });

  test("a pack directory whose pack left packs.json is reported as extra, and writing removes it", () => {
    const second = { ...DEMO, id: "second", members: { skills: ["lib/skills/alpha"] } };
    const root = generated([DEMO, second]);
    put(root, "packs.json", sourceOf([DEMO]));
    const drift = checkTree(root, buildPlan(root));
    expect(drift.filter((d) => d.kind === "extra").map((d) => d.path)).toEqual([
      "packs/second/.claude-plugin/plugin.json",
      "packs/second/skills/alpha/SKILL.md",
      "packs/second/skills/alpha/references/notes.md",
    ]);
    expect(drift.some((d) => d.path === ".claude-plugin/marketplace.json")).toBe(true);
    writePlan(root, buildPlan(root));
    expect(checkTree(root, buildPlan(root))).toEqual([]);
    expect(listAll(root).some((p) => p.startsWith("packs/second/"))).toBe(false);
  });

  test("an edited marketplace manifest is reported as changed", () => {
    const root = generated();
    put(root, ".claude-plugin/marketplace.json", "{}\n");
    expect(checkTree(root, buildPlan(root))).toEqual([{ kind: "changed", path: ".claude-plugin/marketplace.json" }]);
  });

  test("an empty pack list generates only the marketplace, and a stray pack directory is then extra", () => {
    const root = generated([]);
    expect([...buildPlan(root).keys()]).toEqual([".claude-plugin/marketplace.json"]);
    expect(readJson(buildPlan(root), ".claude-plugin/marketplace.json").plugins).toEqual([]);
    put(root, "packs/stale/.claude-plugin/plugin.json", "{}\n");
    expect(checkTree(root, buildPlan(root))).toEqual([{ kind: "extra", path: "packs/stale/.claude-plugin/plugin.json" }]);
  });

  test.skipIf(!CAN_LINK)("a directory symlink standing in for a generated directory is drift", () => {
    const root = generated();
    rmSync(join(root, "packs/demo/hooks"), { recursive: true });
    expect(tryLink(join(root, "lib/hooks"), join(root, "packs/demo/hooks"))).toBe(true);
    expect(checkTree(root, buildPlan(root)).map((d) => d.path)).toEqual([
      "packs/demo/hooks",
      "packs/demo/hooks/hooks.json",
      "packs/demo/hooks/run.sh",
    ]);
  });
});

describe("the real repository", () => {
  // The CI drift gate. A change to packs.json or to any member of a pack that does not carry the
  // regenerated tree fails here, and the CLI line below is the command that fixes it.
  test("committed packs/ and .claude-plugin/marketplace.json match what packs.json generates", () => {
    expect(checkTree(REPO_ROOT, buildPlan(REPO_ROOT))).toEqual([]);
  });
});

// Each case breaks one rule from the #254 contract (or one rule that keeps a source honest). A
// refusal must name its cause and must leave an existing generated tree exactly as it was.
describe("refusals", () => {
  const cases: [string, (root: string) => void, RegExp][] = [
    ["duplicate pack id", (r) => put(r, "packs.json", sourceOf([DEMO, DEMO])), /duplicate pack name "demo"/],
    ["skill name differs from its directory", (r) => put(r, "lib/skills/alpha/SKILL.md", skillMd("beta")), /must equal its directory "alpha"/],
    ["skill directory without SKILL.md", (r) => rmSync(join(r, "lib/skills/alpha/SKILL.md")), /no SKILL\.md/],
    ["agent name differs from its file", (r) => put(r, "lib/agents/reviewer.md", agentMd("other")), /must equal the file name "reviewer"/],
    [
      "agent member that is not a .md file",
      (r) => {
        put(r, "lib/agents/notes.txt", "x");
        put(r, "packs.json", sourceOf([{ ...DEMO, members: { agents: ["lib/agents/notes.txt"] } }]));
      },
      /must be a \.md file/,
    ],
    ["hooks.json whose hooks is an array", (r) => put(r, "lib/hooks/hooks.json", '{"hooks":[]}'), /"hooks" is an object/],
    [
      "Copilot-native hooks.json",
      (r) =>
        put(r, "lib/hooks/hooks.json", JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: "echo" }] } })),
      /Copilot-native/,
    ],
    [
      "camelCase hook event",
      (r) => put(r, "lib/hooks/hooks.json", JSON.stringify({ hooks: { sessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } })),
      /not PascalCase/,
    ],
    [
      "hook entry carrying a bash command",
      (r) =>
        put(r, "lib/hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x", bash: "y" }] }] } })),
      /only \{"type": "command"/,
    ],
    ["hook bundle without hooks.json", (r) => rmSync(join(r, "lib/hooks/hooks.json")), /no hooks\.json/],
    ["hooks.json that is not JSON", (r) => put(r, "lib/hooks/hooks.json", "{"), /not valid JSON/],
    ["private tier", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, tier: "private" }])), /private overlay/],
    ["unknown tier", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, tier: "extra" }])), /tier must be/],
    ["misspelt pack key", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, dependson: [] }])), /unknown key "dependson"/],
    ["unknown members key", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skill: ["x"] } }])), /unknown key "skill"/],
    ["id with a space", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, id: "my pack" }])), /lowercase kebab-case/],
    ["id with an uppercase letter", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, id: "Demo" }])), /lowercase kebab-case/],
    ["version that is not MAJOR.MINOR.PATCH", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, version: "1.2" }])), /MAJOR\.MINOR\.PATCH/],
    ["pack with no members", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: {} }])), /no members/],
    ["empty skills list", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: [] } }])), /non-empty array/],
    ["skill listed twice", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["lib/skills/alpha", "lib/skills/alpha"] } }])), /twice/],
    ["traversal in a member path", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["../outside/alpha"] } }])), /plain repo-relative path/],
    ["absolute member path", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["/etc/alpha"] } }])), /plain repo-relative path/],
    ["drive-letter member path", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["C:/x/alpha"] } }])), /plain repo-relative path/],
    ["backslash member path", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["lib\\skills\\alpha"] } }])), /plain repo-relative path/],
    ["dot segment in a member path", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: [".claude/skills/alpha"] } }])), /plain repo-relative path/],
    ["member under packs/", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["packs/demo/skills/alpha"] } }])), /generated output/],
    [
      "member naming a synced third-party skill",
      (r) => {
        put(r, "account/claude/skills/synced/doc/SKILL.md", skillMd("doc"));
        put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["account/claude/skills/synced/doc"] } }]));
      },
      /names a synced skill/,
    ],
    ["member that does not exist", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["lib/skills/nope"] } }])), /does not exist/],
    ["dependsOn naming no pack", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, dependsOn: ["ghost"] }])), /not a pack here/],
    ["dependsOn naming itself", (r) => put(r, "packs.json", sourceOf([{ ...DEMO, dependsOn: ["demo"] }])), /lists the pack itself/],
    [
      "dependsOn cycle",
      (r) => {
        const a = { ...DEMO, id: "aa", dependsOn: ["bb"], members: { skills: ["lib/skills/alpha"] } };
        const b = { ...DEMO, id: "bb", dependsOn: ["aa"], members: { skills: ["lib/skills/alpha"] } };
        put(r, "packs.json", sourceOf([a, b]));
      },
      /cycle: aa -> bb -> aa/,
    ],
    [
      "two member skills with one directory name",
      (r) => {
        put(r, "lib2/skills/alpha/SKILL.md", skillMd("alpha"));
        put(r, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["lib/skills/alpha", "lib2/skills/alpha"] } }]));
      },
      /two members write packs\/demo\/skills\/alpha\/SKILL\.md/,
    ],
    ["schema other than 1", (r) => put(r, "packs.json", JSON.stringify({ schema: 2, marketplace: {}, packs: [] })), /"schema" must be 1/],
    ["packs.json that is not JSON", (r) => put(r, "packs.json", "{"), /not valid JSON/],
    ["packs.json missing", (r) => rmSync(join(r, "packs.json")), /not found/],
    [
      "unknown top-level key",
      (r) => put(r, "packs.json", JSON.stringify({ ...JSON.parse(sourceOf([DEMO])), pack: [] })),
      /unknown key "pack"/,
    ],
    [
      "marketplace without a description",
      (r) => put(r, "packs.json", JSON.stringify({ schema: 1, marketplace: { name: "m", owner: "o" }, packs: [] })),
      /"description" must be a non-empty string/,
    ],
  ];

  test.each(cases)("%s is refused with its cause named", (_label, mutate, message) => {
    const root = makeRoot();
    mutate(root);
    let thrown: unknown;
    try {
      buildPlan(root);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PackError);
    expect((thrown as Error).message).toMatch(message);
  });

  // A link inside a member would let a pack carry bytes from outside its own tree. Skipped where the
  // platform will not create one, since a refusal test that cannot build its input proves nothing.
  test.skipIf(!CAN_LINK)("a symlink inside a member tree is refused", () => {
    const root = makeRoot();
    put(root, "lib/other/leak.md", "outside the skill");
    expect(tryLink(join(root, "lib/other"), join(root, "lib/skills/alpha/linked"))).toBe(true);
    expect(() => buildPlan(root)).toThrow(/linked is a symbolic link/);
  });

  test.skipIf(!CAN_LINK)("a member path that is itself a symlink is refused", () => {
    const root = makeRoot();
    expect(tryLink(join(root, "lib/skills/alpha"), join(root, "lib/skills/linked"))).toBe(true);
    put(root, "packs.json", sourceOf([{ ...DEMO, members: { skills: ["lib/skills/linked"] } }]));
    expect(() => buildPlan(root)).toThrow(/lib\/skills\/linked is a symbolic link/);
  });

  // The positive control for the table above: the unmutated fixture builds, so a refusal comes from
  // the mutation and not from a fixture that was never valid.
  test("the unmutated fixture builds without a refusal", () => {
    expect(() => buildPlan(makeRoot())).not.toThrow();
  });

  test("a refused write leaves the existing generated tree exactly as it was", () => {
    const root = generated();
    const before = listAll(root).map((p) => [p, readFileSync(join(root, p), "utf8")]);
    put(root, "lib/skills/alpha/SKILL.md", skillMd("renamed"));
    expect(main([], root)).toBe(2);
    expect(listAll(root).map((p) => [p, readFileSync(join(root, p), "utf8")])).toEqual(
      before.map(([p, text]) => [p, p === "lib/skills/alpha/SKILL.md" ? skillMd("renamed") : text]),
    );
  });
});

describe("identity gate", () => {
  // Synthetic identity. The marker is built from parts so the whole string is not in this file's text.
  const MARK = ["zq", "fixture", "person"].join("");
  const loader = (declared = true): (() => IdentityLoad) => () => ({
    ok: true,
    declared,
    accountEmail: false,
    decl: { names: [MARK], emails: [], username: "fixture-user-x", hostname: "fixture-host-x" },
  });
  const quiet = (fn: () => number): { code: number; err: string } => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      return { code: fn(), err: errs.join("\n") };
    } finally {
      console.error = orig;
    }
  };

  test("an identifying string in a member file refuses in write and --check, names the class, and prints no value", () => {
    const root = makeRoot();
    put(root, "lib/skills/alpha/references/notes.md", `written by ${MARK} on a laptop\n`);
    for (const args of [["--root", root], ["--check", "--root", root]]) {
      const r = quiet(() => main(args, root, loader()));
      expect(r.code).toBe(2);
      expect(r.err).toContain("declared name #1");
      expect(r.err.toLowerCase()).not.toContain(MARK);
    }
    expect(listAll(root).some((p) => p.startsWith("packs/"))).toBe(false);
  });

  test("an identifying string in a planned path refuses without printing that path", () => {
    const root = makeRoot();
    put(root, `lib/skills/alpha/${MARK}.md`, "clean body\n");
    const r = quiet(() => main(["--root", root], root, loader()));
    expect(r.code).toBe(2);
    expect(r.err.toLowerCase()).not.toContain(MARK);
  });

  test("a clean tree passes, and an identity load that fails refuses", () => {
    const root = makeRoot();
    expect(quiet(() => main(["--root", root], root, loader())).code).toBe(0);
    const bad = quiet(() => main(["--check", "--root", root], root, () => ({ ok: false, reason: "unusable identity file" })));
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unusable identity file");
  });
});

describe("command line", () => {
  function run(args: string[]) {
    const proc = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  }

  test("--check exits 1 with the divergence listed when the tree is stale", () => {
    const root = makeRoot();
    const r = run(["--check", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing: packs/demo/.claude-plugin/plugin.json");
    expect(r.err).toContain("bun tools/packs/cli.ts");
  });

  test("a plain run writes the tree and --check then exits 0", () => {
    const root = makeRoot();
    expect(run(["--root", root]).code).toBe(0);
    expect(run(["--check", "--root", root]).code).toBe(0);
    expect(listAll(root)).toContain("packs/demo/skills/alpha/SKILL.md");
  });

  test("--check writes nothing", () => {
    const root = makeRoot();
    const before = listAll(root);
    run(["--check", "--root", root]);
    expect(listAll(root)).toEqual(before);
  });

  test("a refused source exits 2 and names the cause on stderr", () => {
    const root = makeRoot([DEMO, DEMO]);
    const r = run(["--check", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("refused: duplicate pack name");
  });

  test("an unknown flag exits 2 with the usage line", () => {
    const r = run(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
  });
});
