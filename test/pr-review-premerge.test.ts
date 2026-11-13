// Tests for tools/pr-review/premerge.ts and the premerge subcommand in cli.ts (#174): the
// merge-hygiene checks on the channels a pull request's diff does not carry. Every term below is a
// placeholder. Nothing here calls real GitHub: the gh runner and the fact source are injected.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REPO, UsageError, main, parseCliArgs } from "../tools/pr-review/cli";
import {
  PremergeReadError,
  containsTerm,
  evaluatePremerge,
  formatPremerge,
  ghPremergeSource,
  loadTerms,
  type GhRunner,
  type PremergeCommit,
  type PremergeExpect,
  type PremergeFacts,
} from "../tools/pr-review/premerge";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const TERMS = ["placeholder-project", "Example Person"];
const ID = { name: "fixture-handle", email: "fixture-handle@users.noreply.github.com" };

const ROOT = mkdtempSync(join(tmpdir(), "pr-review-premerge-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function writeTerms(name: string, content: string): string {
  const path = join(ROOT, name);
  writeFileSync(path, content);
  return path;
}

function commit(overrides: Partial<PremergeCommit> = {}): PremergeCommit {
  return {
    sha: HEAD,
    authorName: ID.name,
    authorEmail: ID.email,
    committerName: ID.name,
    committerEmail: ID.email,
    message: "feat: add the widget (#7)\n\nWhy the widget was needed.",
    ...overrides,
  };
}

function facts(overrides: Partial<PremergeFacts> = {}): PremergeFacts {
  return {
    state: "OPEN",
    headSha: HEAD,
    title: "feat: add the widget",
    body: "Adds the widget.\n\nCloses #7",
    closingIssues: [7],
    checks: [{ bucket: "pass" }, { bucket: "pass" }, { bucket: "skipping" }],
    commits: [commit()],
    commitCount: 1,
    ...overrides,
  };
}

const EXPECT: PremergeExpect = { closes: [7], identity: ID, expectHead: null };

function failed(results: ReturnType<typeof evaluatePremerge>): string[] {
  return results.filter((r) => !r.ok).map((r) => r.channel);
}

describe("evaluatePremerge(): a clean pull request", () => {
  test("passes every channel", () => {
    const results = evaluatePremerge(facts(), EXPECT, TERMS);
    expect(failed(results)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(8);
  });
});

describe("evaluatePremerge(): pull request state and head", () => {
  test("a merged or closed pull request fails", () => {
    expect(failed(evaluatePremerge(facts({ state: "MERGED" }), EXPECT, TERMS))).toEqual(["pull request state"]);
  });

  test("a head that is not a full SHA fails", () => {
    expect(failed(evaluatePremerge(facts({ headSha: "" }), EXPECT, TERMS))).toContain("pull request state");
  });

  test("an --expect-head that differs from the head fails", () => {
    expect(failed(evaluatePremerge(facts(), { ...EXPECT, expectHead: OTHER }, TERMS))).toEqual(["pull request state"]);
  });

  test("an --expect-head that matches passes", () => {
    expect(failed(evaluatePremerge(facts(), { ...EXPECT, expectHead: HEAD }, TERMS))).toEqual([]);
  });
});

describe("evaluatePremerge(): checks", () => {
  test("no checks at all fails", () => {
    expect(failed(evaluatePremerge(facts({ checks: [] }), EXPECT, TERMS))).toEqual(["checks"]);
  });

  test("a failing check fails", () => {
    expect(failed(evaluatePremerge(facts({ checks: [{ bucket: "pass" }, { bucket: "fail" }] }), EXPECT, TERMS))).toEqual(["checks"]);
  });

  test("a pending check fails", () => {
    expect(failed(evaluatePremerge(facts({ checks: [{ bucket: "pending" }] }), EXPECT, TERMS))).toEqual(["checks"]);
  });

  test("only skipped checks fails, since nothing passed", () => {
    expect(failed(evaluatePremerge(facts({ checks: [{ bucket: "skipping" }] }), EXPECT, TERMS))).toEqual(["checks"]);
  });
});

describe("evaluatePremerge(): closing references", () => {
  test("an extra closing reference fails", () => {
    expect(failed(evaluatePremerge(facts({ closingIssues: [7, 8] }), EXPECT, TERMS))).toEqual(["closing references"]);
  });

  test("a missing closing reference fails", () => {
    expect(failed(evaluatePremerge(facts({ closingIssues: [] }), EXPECT, TERMS))).toEqual(["closing references"]);
  });

  test("expecting none and finding none passes", () => {
    const f = facts({ closingIssues: [], body: "Adds the widget." });
    expect(failed(evaluatePremerge(f, { ...EXPECT, closes: [] }, TERMS))).toEqual([]);
  });

  test("order does not matter", () => {
    expect(failed(evaluatePremerge(facts({ closingIssues: [9, 7] }), { ...EXPECT, closes: [7, 9] }, TERMS))).toEqual([]);
  });
});

describe("evaluatePremerge(): commit list", () => {
  test("fewer commits read than the pull request has fails", () => {
    expect(failed(evaluatePremerge(facts({ commitCount: 2 }), EXPECT, TERMS))).toEqual(["commit list"]);
  });

  test("a list whose last commit is not the head fails", () => {
    expect(failed(evaluatePremerge(facts({ commits: [commit({ sha: OTHER })] }), EXPECT, TERMS))).toEqual(["commit list"]);
  });

  test("no commits fails, and the message scan cannot pass on nothing", () => {
    const result = failed(evaluatePremerge(facts({ commits: [], commitCount: 0 }), EXPECT, TERMS));
    expect(result).toContain("commit list");
    expect(result).toContain("personal terms in commit messages");
  });
});

describe("evaluatePremerge(): closing keywords in commit messages", () => {
  for (const message of [
    "chore: tidy\n\nThis closed #120 by accident.",
    "fix: thing\n\nFixes #3",
    "fix: thing\n\nresolves: #3",
    "fix: thing\n\nCloses owner/repo#3",
    "fix: thing\n\nFixed https://github.com/owner/repo/issues/3",
  ]) {
    test(`refuses ${JSON.stringify(message.split("\n").pop())}`, () => {
      expect(failed(evaluatePremerge(facts({ commits: [commit({ message })] }), EXPECT, TERMS))).toEqual([
        "closing keywords in commit messages",
      ]);
    });
  }

  test("an issue referenced in parentheses passes", () => {
    expect(failed(evaluatePremerge(facts({ commits: [commit({ message: "fix(pr-review): thing (#3)" })] }), EXPECT, TERMS))).toEqual([]);
  });
});

describe("evaluatePremerge(): commit identity", () => {
  for (const field of ["authorName", "authorEmail", "committerName", "committerEmail"] as const) {
    test(`a different ${field} fails`, () => {
      const f = facts({ commits: [commit({ [field]: "someone-else" })] });
      expect(failed(evaluatePremerge(f, EXPECT, TERMS))).toEqual(["commit identity"]);
    });
  }

  test("a mismatch on an earlier commit fails even when the head commit is clean", () => {
    const f = facts({ commits: [commit({ sha: OTHER, committerEmail: "noreply@github.com" }), commit()], commitCount: 2 });
    expect(failed(evaluatePremerge(f, EXPECT, TERMS))).toEqual(["commit identity"]);
  });

  test("case differences alone pass", () => {
    const f = facts({ commits: [commit({ authorEmail: ID.email.toUpperCase() })] });
    expect(failed(evaluatePremerge(f, EXPECT, TERMS))).toEqual([]);
  });
});

describe("evaluatePremerge(): personal terms", () => {
  test("a term in the PR body fails that channel only", () => {
    const f = facts({ body: "Built for the Placeholder-Project rollout.\n\nCloses #7" });
    expect(failed(evaluatePremerge(f, EXPECT, TERMS))).toEqual(["personal terms in PR title and body"]);
  });

  test("a term in the PR title fails", () => {
    expect(failed(evaluatePremerge(facts({ title: "feat: example person tweak" }), EXPECT, TERMS))).toEqual(["personal terms in PR title and body"]);
  });

  test("a term in a commit message fails that channel only", () => {
    const f = facts({ commits: [commit({ message: "feat: widget\n\nAsked for by Example Person." })] });
    expect(failed(evaluatePremerge(f, EXPECT, TERMS))).toEqual(["personal terms in commit messages"]);
  });

  test("a term split by a zero-width character still matches", () => {
    const f = facts({ body: "Built for placeholder-​project.\n\nCloses #7" });
    expect(failed(evaluatePremerge(f, EXPECT, TERMS))).toEqual(["personal terms in PR title and body"]);
  });

  test("an empty term list fails both term channels", () => {
    expect(failed(evaluatePremerge(facts(), EXPECT, []))).toEqual(["personal terms in commit messages", "personal terms in PR title and body"]);
  });

  test("a matcher that throws fails the channel rather than passing it", () => {
    const throwing = () => {
      throw new Error("matcher crashed");
    };
    expect(failed(evaluatePremerge(facts(), EXPECT, TERMS, throwing))).toEqual([
      "personal terms in commit messages",
      "personal terms in PR title and body",
    ]);
  });

  test("a matcher that returns a non-boolean fails", () => {
    const odd = (() => undefined) as unknown as (text: string, term: string) => boolean;
    expect(failed(evaluatePremerge(facts(), EXPECT, TERMS, odd))).toEqual([
      "personal terms in commit messages",
      "personal terms in PR title and body",
    ]);
  });

  test("a matcher that never matches fails on the canary taken from the scanned text", () => {
    const blind = () => false;
    const results = evaluatePremerge(facts(), EXPECT, TERMS, blind);
    expect(failed(results)).toEqual(["personal terms in commit messages", "personal terms in PR title and body"]);
    expect(results.find((r) => r.channel === "personal terms in PR title and body")?.detail).toContain("canary");
  });

  test("a matcher that cannot find a listed term in the term itself fails", () => {
    // Finds the canary (the scanned text's own first line) but nothing else.
    const partial = (text: string, term: string) => term.startsWith("feat");
    const results = evaluatePremerge(facts(), EXPECT, TERMS, partial);
    expect(failed(results)).toEqual(["personal terms in commit messages", "personal terms in PR title and body"]);
  });

  test("an empty PR title fails, since the canary has nothing to pin on", () => {
    expect(failed(evaluatePremerge(facts({ title: "" }), EXPECT, TERMS))).toEqual(["personal terms in PR title and body"]);
  });
});

describe("containsTerm()", () => {
  test("is case-insensitive and literal", () => {
    expect(containsTerm("An EXAMPLE PERSON wrote it", "example person")).toBe(true);
    expect(containsTerm("a.b", "a*b")).toBe(false);
    expect(containsTerm("a*b", "a*b")).toBe(true);
  });
});

describe("formatPremerge(): output never carries matched values", () => {
  test("a hit is reported by channel and count, not by term or text", () => {
    const f = facts({ body: "Built for placeholder-project.\n\nCloses #7", commits: [commit({ authorName: "Example Person" })] });
    const out = formatPremerge(12, f.headSha, evaluatePremerge(f, EXPECT, TERMS));
    expect(out).toContain("PREMERGE BLOCKED");
    expect(out).toContain("personal terms in PR title and body: FAIL");
    expect(out).toContain("commit identity: FAIL");
    expect(out.toLowerCase()).not.toContain("placeholder-project");
    expect(out.toLowerCase()).not.toContain("example person");
  });

  test("a clean run says OK with the head", () => {
    expect(formatPremerge(12, HEAD, evaluatePremerge(facts(), EXPECT, TERMS))).toContain(`PREMERGE OK  #12  head=${HEAD}`);
  });
});

describe("loadTerms()", () => {
  test("reads the terms array and ignores other keys", () => {
    const path = writeTerms("ok.json", JSON.stringify({ terms: [" placeholder-project ", "Example Person"], excludeMcpServers: ["x"] }));
    expect(loadTerms(path)).toEqual({ ok: true, terms: ["placeholder-project", "Example Person"] });
  });

  const refusals: Array<[string, string]> = [
    ["an empty array", JSON.stringify({ terms: [] })],
    ["no terms key", JSON.stringify({ names: ["placeholder-project"] })],
    ["a blank term", JSON.stringify({ terms: ["placeholder-project", "  "] })],
    ["a non-string term", JSON.stringify({ terms: ["placeholder-project", 3] })],
    ["a term made only of invisible characters", JSON.stringify({ terms: ["​"] })],
    ["malformed JSON", "{ terms: "],
    ["an empty file", ""],
    ["a top-level array", JSON.stringify(["placeholder-project"])],
  ];
  for (const [label, content] of refusals) {
    test(`refuses ${label}`, () => {
      const result = loadTerms(writeTerms(`bad-${label.replace(/\W+/g, "-")}.json`, content));
      expect(result.ok).toBe(false);
    });
  }

  test("refuses a missing file", () => {
    expect(loadTerms(join(ROOT, "absent.json")).ok).toBe(false);
  });

  test("refuses a relative path", () => {
    expect(loadTerms("terms.json").ok).toBe(false);
  });

  test("refuses a file inside a git checkout, so the list is never one add away from a commit", () => {
    const checkout = join(ROOT, "checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    mkdirSync(join(checkout, "sub"), { recursive: true });
    const path = join(checkout, "sub", "terms.json");
    writeFileSync(path, JSON.stringify({ terms: ["placeholder-project"] }));
    const result = loadTerms(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("checkout");
  });

  test("no refusal names the path or a term", () => {
    const path = writeTerms("blank-term.json", JSON.stringify({ terms: ["placeholder-project", ""] }));
    const result = loadTerms(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain(ROOT);
      expect(result.reason).not.toContain("placeholder-project");
    }
  });
});

describe("ghPremergeSource()", () => {
  const view = { state: "OPEN", headRefOid: HEAD, title: "t", body: "b", closingIssuesReferences: [{ number: 7 }] };
  const checks = [{ name: "test", bucket: "pass" }];
  const restCommit = (sha: string) => ({
    sha,
    commit: { author: { name: ID.name, email: ID.email }, committer: { name: ID.name, email: ID.email }, message: "m" },
  });
  const pull = { commits: 2, head: { sha: HEAD } };

  function fakeGh(overrides: Partial<Record<"view" | "checks" | "commits" | "pull", { exitCode: number; stdout: string }>> = {}): GhRunner {
    const answers = {
      view: { exitCode: 0, stdout: JSON.stringify(view) },
      checks: { exitCode: 0, stdout: JSON.stringify(checks) },
      commits: { exitCode: 0, stdout: JSON.stringify([[restCommit(OTHER)], [restCommit(HEAD)]]) },
      pull: { exitCode: 0, stdout: JSON.stringify(pull) },
      ...overrides,
    };
    return (args) => {
      if (args[0] === "pr" && args[1] === "view") return answers.view;
      if (args[0] === "pr" && args[1] === "checks") return answers.checks;
      if (args[0] === "api" && args.some((a) => a.includes("/commits"))) return answers.commits;
      if (args[0] === "api") return answers.pull;
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
  }

  test("assembles the facts, flattening paginated commits", () => {
    const f = ghPremergeSource(DEFAULT_REPO, 12, fakeGh()).read();
    expect(f.state).toBe("OPEN");
    expect(f.headSha).toBe(HEAD);
    expect(f.closingIssues).toEqual([7]);
    expect(f.checks).toEqual([{ bucket: "pass" }]);
    expect(f.commits.map((c) => c.sha)).toEqual([OTHER, HEAD]);
    expect(f.commitCount).toBe(2);
  });

  test("names the repository on every call", () => {
    const calls: string[][] = [];
    const gh = fakeGh();
    ghPremergeSource("owner/repo", 12, (args) => {
      calls.push(args);
      return gh(args);
    }).read();
    for (const args of calls) expect(args.join(" ")).toContain("owner/repo");
  });

  test("a failing check run still reads, so the checks channel can report it", () => {
    const f = ghPremergeSource(DEFAULT_REPO, 12, fakeGh({ checks: { exitCode: 1, stdout: JSON.stringify([{ bucket: "fail" }]) } })).read();
    expect(f.checks).toEqual([{ bucket: "fail" }]);
  });

  const broken: Array<[string, Parameters<typeof fakeGh>[0]]> = [
    ["gh pr view exiting non-zero", { view: { exitCode: 1, stdout: JSON.stringify(view) } }],
    ["gh pr view printing non-JSON", { view: { exitCode: 0, stdout: "oops" } }],
    ["gh pr checks printing nothing", { checks: { exitCode: 1, stdout: "" } }],
    ["gh pr checks crashing", { checks: { exitCode: 134, stdout: JSON.stringify(checks) } }],
    ["the commit listing exiting non-zero", { commits: { exitCode: 1, stdout: "[]" } }],
    ["a commit missing its committer", { commits: { exitCode: 0, stdout: JSON.stringify([[{ sha: HEAD, commit: { author: { name: "n", email: "e" }, message: "m" } }]]) } }],
    ["the pull request read exiting non-zero", { pull: { exitCode: 1, stdout: JSON.stringify(pull) } }],
    ["the head moving between reads", { pull: { exitCode: 0, stdout: JSON.stringify({ commits: 2, head: { sha: OTHER } }) } }],
  ];
  for (const [label, override] of broken) {
    test(`throws PremergeReadError on ${label}`, () => {
      expect(() => ghPremergeSource(DEFAULT_REPO, 12, fakeGh(override)).read()).toThrow(PremergeReadError);
    });
  }
});

describe("parseCliArgs(): premerge", () => {
  const terms = join(ROOT, "terms.json");

  test("parses a full command", () => {
    expect(
      parseCliArgs(["premerge", "--pr", "12", "--closes", "7,3", "--terms", terms, "--repo", "owner/repo", "--identity", "Some Name <some@example.invalid>", "--expect-head", HEAD]),
    ).toEqual({
      command: "premerge",
      repo: "owner/repo",
      pr: 12,
      closes: [3, 7],
      termsPath: terms,
      identity: { name: "Some Name", email: "some@example.invalid" },
      expectHead: HEAD,
    });
  });

  test("derives the identity from the repository owner's noreply address by default", () => {
    const parsed = parseCliArgs(["premerge", "--pr", "12", "--closes", "none", "--terms", terms, "--repo", "owner/repo"]);
    expect(parsed).toMatchObject({ closes: [], identity: { name: "owner", email: "owner@users.noreply.github.com" }, expectHead: null });
  });

  const usage: Array<[string, string[]]> = [
    ["no --closes", ["--pr", "12", "--terms", terms]],
    ["an empty --closes", ["--pr", "12", "--closes", "", "--terms", terms]],
    ["a non-numeric --closes", ["--pr", "12", "--closes", "7,x", "--terms", terms]],
    ["no --terms", ["--pr", "12", "--closes", "7"]],
    ["a relative --terms", ["--pr", "12", "--closes", "7", "--terms", "terms.json"]],
    ["no --pr", ["--closes", "7", "--terms", terms]],
    ["a malformed --identity", ["--pr", "12", "--closes", "7", "--terms", terms, "--identity", "no-brackets"]],
    ["a malformed --expect-head", ["--pr", "12", "--closes", "7", "--terms", terms, "--expect-head", "abc"]],
    ["a malformed --repo", ["--pr", "12", "--closes", "7", "--terms", terms, "--repo", "nope"]],
    ["a review-only flag", ["--pr", "12", "--closes", "7", "--terms", terms, "--post"]],
  ];
  for (const [label, args] of usage) {
    test(`refuses ${label}`, () => {
      expect(() => parseCliArgs(["premerge", ...args])).toThrow(UsageError);
    });
  }
});

describe("main(): premerge", () => {
  const neutral = mkdtempSync(join(tmpdir(), "pr-review-premerge-cwd-"));
  afterAll(() => {
    rmSync(neutral, { recursive: true, force: true });
  });
  const termsPath = writeTerms("main-terms.json", JSON.stringify({ terms: TERMS }));
  const io = (f: PremergeFacts | (() => PremergeFacts)) => ({
    cwd: () => neutral,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
    stdin: { isTTY: false, read: async () => "" },
    buildPremergeSource: () => ({ read: typeof f === "function" ? f : () => f }),
  });
  const argv = (extra: string[] = []) => ["premerge", "--pr", "12", "--closes", "7", "--terms", termsPath, "--repo", "owner/repo", "--identity", `${ID.name} <${ID.email}>`, ...extra];

  test("exits 0 on a clean pull request", async () => {
    expect(await main(argv(), io(facts()))).toBe(0);
  });

  test("exits 2 when any channel fails", async () => {
    expect(await main(argv(), io(facts({ title: "feat: placeholder-project" })))).toBe(2);
  });

  test("exits 2, before reading GitHub, when the term list is empty", async () => {
    let read = false;
    const empty = writeTerms("main-empty.json", JSON.stringify({ terms: [] }));
    const args = ["premerge", "--pr", "12", "--closes", "7", "--terms", empty, "--repo", "owner/repo"];
    expect(
      await main(
        args,
        io(() => {
          read = true;
          return facts();
        }),
      ),
    ).toBe(2);
    expect(read).toBe(false);
  });

  test("exits 2 when GitHub cannot be read", async () => {
    expect(
      await main(
        argv(),
        io(() => {
          throw new PremergeReadError("could not read the pull request");
        }),
      ),
    ).toBe(2);
  });

  test("refuses from a working directory holding a .env file", async () => {
    const dirty = join(ROOT, "dirty-cwd");
    mkdirSync(dirty, { recursive: true });
    writeFileSync(join(dirty, ".env"), "");
    await expect(main(argv(), { ...io(facts()), cwd: () => dirty })).rejects.toThrow("refusing to run");
  });
});
