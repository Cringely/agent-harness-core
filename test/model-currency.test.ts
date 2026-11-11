// Tests for tools/model-currency/check.ts. Lines holding test model IDs carry the ignore marker so
// the tool does not report its own fixtures when it scans this repository. Nothing here calls the
// real claude CLI or the network: the runner and fetch are injected stubs.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXCLUDES,
  classify,
  claudeChildEnv,
  compareModelIds,
  fetchLatestFromApi,
  latestByFamily,
  parseModelId,
  resolveAlias,
  run,
  scanText,
  type ClaudeRunner,
  type Finding,
  type LatestTable,
  type RunDeps,
} from "../tools/model-currency/check";

const temps: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "model-currency-test-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, text: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

describe("parseModelId", () => {
  test("reads the current and older id shapes", () => {
    expect(parseModelId("claude-opus-5-5")).toMatchObject({ family: "opus", major: 5, minor: 5, date: null }); // model-currency: ignore
    expect(parseModelId("claude-sonnet-4-20250514")).toMatchObject({ family: "sonnet", major: 4, minor: 0, date: "20250514" }); // model-currency: ignore
    expect(parseModelId("claude-sonnet-5")).toMatchObject({ family: "sonnet", major: 5, minor: 0 }); // model-currency: ignore
    expect(parseModelId("claude-3-5-sonnet-20241022")).toMatchObject({ family: "sonnet", major: 3, minor: 5 }); // model-currency: ignore
    expect(parseModelId("sonnet")).toBeNull();
  });
});

describe("compareModelIds and latestByFamily", () => {
  test("orders by major then minor and ignores dates", () => {
    const a = parseModelId("claude-sonnet-5-20250101")!; // model-currency: ignore
    const b = parseModelId("claude-sonnet-5-20260101")!; // model-currency: ignore
    const c = parseModelId("claude-sonnet-5-5")!; // model-currency: ignore
    expect(compareModelIds(a, b)).toBe(0);
    expect(compareModelIds(a, c)).toBeLessThan(0);
    expect(compareModelIds(c, a)).toBeGreaterThan(0);
  });
  test("picks the highest id per family", () => {
    expect(latestByFamily(["claude-opus-5", "claude-opus-5-5", "claude-haiku-5-5"])).toEqual({ // model-currency: ignore
      opus: "claude-opus-5-5", // model-currency: ignore
      haiku: "claude-haiku-5-5", // model-currency: ignore
    });
  });
});

describe("scanText", () => {
  test("finds a pin with its 1-based line", () => {
    const f = scanText("a.sh", "echo hi\nclaude --model claude-sonnet-5 -p x\n"); // model-currency: ignore
    expect(f).toEqual([{ file: "a.sh", line: 2, value: "claude-sonnet-5", kind: "pin" }]); // model-currency: ignore
  });
  test("finds a dated pin and an older-shape pin whole", () => {
    const f = scanText("a.md", "x claude-sonnet-4-20250514 y\nz claude-3-5-sonnet-20241022\n"); // model-currency: ignore
    expect(f.map((x) => x.value)).toEqual(["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022"]); // model-currency: ignore
  });
  test("finds aliases in frontmatter, JSON and --model", () => {
    const text = ["---", "model: sonnet", "---", '{ "model": "opus" }', "claude --model haiku", ""].join("\n"); // model-currency: ignore
    const f: Finding[] = scanText("b.md", text);
    expect(f).toEqual([
      { file: "b.md", line: 2, value: "sonnet", kind: "alias" },
      { file: "b.md", line: 4, value: "opus", kind: "alias" },
      { file: "b.md", line: 5, value: "haiku", kind: "alias" },
    ]);
  });
  test("handles CRLF text", () => {
    const f = scanText("c.md", "---\r\nmodel: sonnet\r\n---\r\n");
    expect(f).toEqual([{ file: "c.md", line: 2, value: "sonnet", kind: "alias" }]);
  });
  test("ignores prose, and a line carrying the marker", () => {
    expect(scanText("p.md", "Opus 5 is the model. Use sonnet for this.\n")).toEqual([]);
    expect(scanText("p.md", "model: sonnet # model-currency: ignore\nclaude-opus-5 model-currency: ignore\n")).toEqual([]); // model-currency: ignore
  });
});

const API_LATEST: LatestTable = { source: "api", models: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } }; // model-currency: ignore

describe("classify", () => {
  const f = (value: string, kind: "pin" | "alias"): Finding => ({ file: "x", line: 1, value, kind });
  test("against a real latest table", () => {
    const rows = classify(
      [f("claude-sonnet-5", "pin"), f("claude-opus-5-5", "pin"), f("sonnet", "alias"), f("opus", "alias"), f("claude-haiku-5", "pin")], // model-currency: ignore
      API_LATEST,
      { sonnet: "claude-sonnet-5", opus: null }, // model-currency: ignore
    );
    expect(rows.map((r) => r.status)).toEqual(["behind", "current", "stale-alias", "unknown", "unknown"]);
    expect(rows[0]!.latest).toBe("claude-sonnet-5-5"); // model-currency: ignore
    expect(rows[4]!.latest).toBeNull();
  });
  test("an alias resolved to the latest is current", () => {
    const rows = classify([f("sonnet", "alias")], API_LATEST, { sonnet: "claude-sonnet-5-5" }); // model-currency: ignore
    expect(rows[0]!.status).toBe("current");
  });
  test("under an alias-derived latest, aliases are unknown and an equal pin is unknown", () => {
    const latest: LatestTable = { source: "alias", models: { sonnet: "claude-sonnet-5-5" } }; // model-currency: ignore
    const rows = classify(
      [f("sonnet", "alias"), f("claude-sonnet-5", "pin"), f("claude-sonnet-5-5", "pin")], // model-currency: ignore
      latest,
      { sonnet: "claude-sonnet-5-5" }, // model-currency: ignore
    );
    expect(rows.map((r) => r.status)).toEqual(["unknown", "behind", "unknown"]);
  });
  test("with no latest table everything is unknown", () => {
    const rows = classify([f("claude-sonnet-5", "pin"), f("sonnet", "alias")], null, {}); // model-currency: ignore
    expect(rows.map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("resolveAlias", () => {
  const out = (code: number, stdout: string): ClaudeRunner => () => ({ code, stdout });
  test("reads the model for the asked family from modelUsage", () => {
    const stdout = '{"modelUsage":{"claude-sonnet-5-5":{},"claude-haiku-5-5":{}}}'; // model-currency: ignore
    expect(resolveAlias("sonnet", out(0, stdout))).toBe("claude-sonnet-5-5"); // model-currency: ignore
  });
  test("passes the alias and json output to the runner", () => {
    let seen: string[] = [];
    resolveAlias("opus", (args) => ((seen = args), { code: 1, stdout: "" }));
    expect(seen).toEqual(["-p", "--model", "opus", "--output-format", "json", "Reply with the single word OK."]);
  });
  test("a non-zero code, bad json, or no matching family is null", () => {
    expect(resolveAlias("sonnet", out(1, '{"modelUsage":{"claude-sonnet-5":{}}}'))).toBeNull(); // model-currency: ignore
    expect(resolveAlias("sonnet", out(0, "not json"))).toBeNull();
    expect(resolveAlias("sonnet", out(0, '{"modelUsage":{"claude-haiku-5":{}}}'))).toBeNull(); // model-currency: ignore
    expect(resolveAlias("sonnet", out(0, "{}"))).toBeNull();
  });
  test("a runner that throws is null", () => {
    expect(resolveAlias("sonnet", () => { throw new Error("spawn failed"); })).toBeNull();
  });
});

describe("claudeChildEnv", () => {
  test("drops CLAUDE_PROJECT_DIR and keeps the rest", () => {
    const e = claudeChildEnv({ CLAUDE_PROJECT_DIR: "x", PATH: "p", FOO: undefined });
    expect("CLAUDE_PROJECT_DIR" in e).toBe(false);
    expect(e.PATH).toBe("p");
    expect("FOO" in e).toBe(false);
  });
});

describe("fetchLatestFromApi", () => {
  test("no key means no call", async () => {
    let called = 0;
    const spy = (async () => { called++; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await fetchLatestFromApi(undefined, spy)).toBeNull();
    expect(called).toBe(0);
  });
  test("reads the newest id per family and sends the key", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    const stub = (async (u: string, init: { headers: Record<string, string> }) => {
      url = u;
      headers = init.headers;
      return new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }, { id: "claude-opus-5-5" }] })); // model-currency: ignore
    }) as unknown as typeof fetch;
    expect(await fetchLatestFromApi("k", stub)).toEqual({ source: "api", models: { opus: "claude-opus-5-5" } }); // model-currency: ignore
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
  test("a throw, an error status, or no usable ids is null", async () => {
    const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await fetchLatestFromApi("k", boom)).toBeNull();
    const bad = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await fetchLatestFromApi("k", bad)).toBeNull();
    const empty = (async () => new Response('{"data":[{"id":"other"}]}')) as unknown as typeof fetch;
    expect(await fetchLatestFromApi("k", empty)).toBeNull();
  });
});

const PIN_FILE = "claude --model claude-sonnet-5 -p x\n"; // model-currency: ignore
const noFetch = (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch;
function deps(resolves: Partial<Record<string, string | null>>, env: Record<string, string | undefined> = {}): RunDeps {
  return {
    env,
    fetchImpl: noFetch,
    runClaude: (args) => {
      const alias = args[args.indexOf("--model") + 1]!;
      const id = resolves[alias] ?? null;
      return id === null ? { code: 1, stdout: "" } : { code: 0, stdout: JSON.stringify({ modelUsage: { [id]: {} } }) };
    },
  };
}
const ALL_FOUR = { fable: "claude-fable-5", opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-5" }; // model-currency: ignore
const rowsOf = (output: string, status: string): string[] => output.split("\n").filter((l) => l.startsWith(`${status}\t`));

describe("walker", () => {
  test("skips every default exclude, and an --exclude name", async () => {
    const root = tempRoot();
    const pin = "claude-sonnet-5\n"; // model-currency: ignore
    put(root, ".claude/worktrees/x/a.md", pin);
    put(root, "projects/t.jsonl", pin);
    put(root, "docs/superpowers/p.md", pin);
    put(root, "extra/e.md", pin);
    put(root, "kept.md", pin);
    for (const name of DEFAULT_EXCLUDES) put(root, `deep/${name}/f.md`, pin);
    put(root, "deep/notes.bak.1", pin);
    put(root, "deep/log.jsonl", pin);
    const r1 = await run(["--root", root, "--no-resolve"], deps({}));
    const rows1 = rowsOf(r1.output, "unknown");
    expect(rows1.length).toBe(2);
    expect(rows1.some((l) => l.includes("kept.md"))).toBe(true);
    expect(rows1.some((l) => l.includes("extra"))).toBe(true);
    const r2 = await run(["--root", root, "--no-resolve", "--exclude", "extra"], deps({}));
    expect(rowsOf(r2.output, "unknown").length).toBe(1);
  });
  test("skips a file with a NUL byte and a file over 2 MB, and a root may be a file", async () => {
    const root = tempRoot();
    put(root, "bin.dat", "claude-sonnet-5\0\n"); // model-currency: ignore
    put(root, "big.txt", "claude-sonnet-5\n" + "x".repeat(2 * 1024 * 1024)); // model-currency: ignore
    put(root, "ok.txt", PIN_FILE);
    const r = await run(["--root", root, "--no-resolve"], deps({}));
    expect(rowsOf(r.output, "unknown").length).toBe(1);
    const single = await run(["--root", join(root, "ok.txt"), "--no-resolve"], deps({}));
    expect(rowsOf(single.output, "unknown").length).toBe(1);
  });
});

describe("run", () => {
  test("alias-derived latest equal to the pin is unknown, never current (exit 2)", async () => {
    const root = tempRoot();
    put(root, "a.sh", PIN_FILE);
    const r = await run(["--root", root], deps(ALL_FOUR));
    expect(r.output.split("\n")[0]).toBe("latest source: alias (unverified: an alias can itself resolve to an older model)");
    expect(rowsOf(r.output, "unknown").length).toBe(1);
    expect(r.output.split("\n").some((l) => l.startsWith("current"))).toBe(false);
    expect(r.exitCode).toBe(2);
  });
  test("alias-derived latest above a stale pin is behind (exit 1)", async () => {
    const root = tempRoot();
    put(root, "a.sh", PIN_FILE);
    const r = await run(["--root", root], deps({ ...ALL_FOUR, sonnet: "claude-sonnet-5-5" })); // model-currency: ignore
    expect(rowsOf(r.output, "behind").length).toBe(1);
    expect(r.exitCode).toBe(1);
  });
  test("--no-resolve with no other source is latest unknown (exit 2)", async () => {
    const root = tempRoot();
    put(root, "a.sh", PIN_FILE);
    const r = await run(["--root", root, "--no-resolve"], deps(ALL_FOUR));
    expect(r.output.split("\n")[0]).toBe("latest source: none (latest unknown)");
    expect(r.exitCode).toBe(2);
  });
  test("all four aliases failing to resolve is no source", async () => {
    const root = tempRoot();
    put(root, "a.sh", PIN_FILE);
    const r = await run(["--root", root], deps({}));
    expect(r.output.split("\n")[0]).toBe("latest source: none (latest unknown)");
    expect(r.exitCode).toBe(2);
  });
  test("--latest file marks a stale pin behind (exit 1)", async () => {
    const root = tempRoot();
    put(root, "a.sh", PIN_FILE);
    const latest = join(tempRoot(), "latest.json");
    writeFileSync(latest, '{"sonnet":"claude-sonnet-5-5"}'); // model-currency: ignore
    const r = await run(["--root", root, "--latest", latest], deps({}));
    expect(r.output.split("\n")[0]).toBe("latest source: file");
    expect(rowsOf(r.output, "behind").length).toBe(1);
    expect(r.exitCode).toBe(1);
  });
  test("every pin current under source file is exit 0", async () => {
    const root = tempRoot();
    put(root, "a.sh", "claude --model claude-sonnet-5-5 -p x\n"); // model-currency: ignore
    const latest = join(tempRoot(), "latest.json");
    writeFileSync(latest, '{"sonnet":"claude-sonnet-5-5"}'); // model-currency: ignore
    const r = await run(["--root", root, "--latest", latest], deps({}));
    expect(rowsOf(r.output, "current").length).toBe(1);
    expect(r.exitCode).toBe(0);
  });
  test("the Models API outranks --latest, and found aliases are resolved against it", async () => {
    const root = tempRoot();
    put(root, "agent.md", "---\nmodel: sonnet\n---\n");
    const latest = join(tempRoot(), "latest.json");
    writeFileSync(latest, '{"sonnet":"claude-sonnet-4"}'); // model-currency: ignore
    const api = (async () => new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5-5" }] }))) as unknown as typeof fetch; // model-currency: ignore
    const d = { ...deps({ sonnet: "claude-sonnet-5" }, { ANTHROPIC_API_KEY: "k" }), fetchImpl: api }; // model-currency: ignore
    const r = await run(["--root", root, "--latest", latest], d);
    expect(r.output.split("\n")[0]).toBe("latest source: api");
    expect(rowsOf(r.output, "stale-alias").length).toBe(1);
    expect(r.exitCode).toBe(1);
  });
  test("a bad option, an unreadable --latest file or a missing root is exit 2", async () => {
    expect((await run(["--nope"], deps({}))).exitCode).toBe(2);
    const root = tempRoot();
    expect((await run(["--root", root, "--latest", join(root, "missing.json")], deps({}))).exitCode).toBe(2);
    expect((await run(["--root", join(root, "missing-dir")], deps({}))).exitCode).toBe(2);
  });
  test("output never carries raw runner output", async () => {
    const root = tempRoot();
    put(root, "a.sh", PIN_FILE);
    const d = deps({});
    d.runClaude = () => ({ code: 0, stdout: '{"account":"someone@example.invalid","modelUsage":{"claude-sonnet-5":{}}}' }); // model-currency: ignore
    const r = await run(["--root", root], d);
    expect(r.output).not.toContain("example.invalid");
  });
});
