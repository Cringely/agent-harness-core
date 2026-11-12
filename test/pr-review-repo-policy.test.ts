// Tests for tools/pr-review/repo-policy.ts (#318): the per-repository required checks and CI
// workflow path come from a built-in entry for this repository or from an operator-only policy
// file, and anything the file does not configure exactly refuses. Placeholder repositories only.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORE_POLICY,
  MAX_POLICY_FILE_BYTES,
  loadPolicyFile,
  parsePolicyFile,
  resolvePolicy,
  workflowPathProblem,
  type PolicyLoad,
} from "../tools/pr-review/repo-policy";
import { REPO_ROOT } from "../tools/pr-review/tool-state";
import { RefusalError } from "../tools/pr-review/types";

const TMP = mkdtempSync(join(tmpdir(), "pr-review-policy-"));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const entry = (overrides: Record<string, unknown> = {}) => ({
  repo: "owner/example",
  ciWorkflowPath: ".github/workflows/ci.yml",
  requiredChecks: [{ name: "build", appSlug: "github-actions" }],
  ...overrides,
});

const coreEntry = () => ({
  repo: CORE_POLICY.repo,
  ciWorkflowPath: CORE_POLICY.ciWorkflowPath,
  requiredChecks: CORE_POLICY.requiredChecks.map((c) => ({ name: c.name, appSlug: c.appSlug })),
});

const file = (repos: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, repos, ...extra });

const reasonOf = (load: PolicyLoad): string => (load.ok ? "" : load.reason);

let counter = 0;
function writePolicy(content: string, dir = TMP): string {
  counter++;
  const path = join(dir, `policy-${counter}.json`);
  writeFileSync(path, content);
  return path;
}

describe("CORE_POLICY", () => {
  // Literal pin: a change to this repository's own checks must be a deliberate edit here too.
  test("is this repository's four required jobs, its workflow, and Pester coverage on", () => {
    expect(CORE_POLICY.repo).toBe("Cringely/agent-harness-core");
    expect(CORE_POLICY.ciWorkflowPath).toBe(".github/workflows/test.yml");
    expect(CORE_POLICY.requiredChecks).toEqual([
      { name: "bun test (TypeScript hook suite)", appSlug: "github-actions" },
      { name: "Pester (fixture-built installer suites)", appSlug: "github-actions" },
      { name: "Pester (fixture-built installer suites, Linux)", appSlug: "github-actions" },
      { name: "secret scan (Gitleaks)", appSlug: "github-actions" },
    ]);
    expect(CORE_POLICY.pesterCoverage).toBe(true);
  });

  test("is frozen, checks included", () => {
    expect(Object.isFrozen(CORE_POLICY)).toBe(true);
    expect(Object.isFrozen(CORE_POLICY.requiredChecks)).toBe(true);
    expect(CORE_POLICY.requiredChecks.every((c) => Object.isFrozen(c))).toBe(true);
  });
});

describe("workflowPathProblem()", () => {
  test.each([".github/workflows/test.yml", ".github/workflows/ci.yaml"])("accepts %p", (path) => {
    expect(workflowPathProblem(path)).toBeNull();
  });

  const nul = String.fromCharCode(0);
  const lf = String.fromCharCode(10);
  test.each([
    ["undefined", undefined],
    ["a number", 7],
    ["empty", ""],
    ["a leading slash", "/.github/workflows/ci.yml"],
    ["a trailing slash", ".github/workflows/"],
    ["an empty segment", ".github//workflows/ci.yml"],
    ["a dot segment", ".github/workflows/./ci.yml"],
    ["a dot-dot segment", ".github/workflows/../../ci.yml"],
    ["a backslash", ".github/workflows/x" + String.fromCharCode(92) + "ci.yml"],
    ["a NUL", `.github/workflows/c${nul}i.yml`],
    ["a newline", `.github/workflows/c${lf}i.yml`],
    ["outside .github/workflows", ".circleci/config.yml"],
    ["a nested directory", ".github/workflows/sub/ci.yml"],
    ["a non-YAML suffix", ".github/workflows/ci.json"],
    ["over 200 characters", `.github/workflows/${"a".repeat(200)}.yml`],
  ])("rejects %s", (_label, path) => {
    expect(workflowPathProblem(path)).not.toBeNull();
  });
});

describe("parsePolicyFile()", () => {
  test("parses a valid file, and every file entry carries pesterCoverage false explicitly", () => {
    const load = parsePolicyFile(file([entry(), entry({ repo: "owner/second", ciWorkflowPath: ".github/workflows/build.yaml" })]));
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.entries).toEqual([
      { repo: "owner/example", ciWorkflowPath: ".github/workflows/ci.yml", requiredChecks: [{ name: "build", appSlug: "github-actions" }], pesterCoverage: false },
      { repo: "owner/second", ciWorkflowPath: ".github/workflows/build.yaml", requiredChecks: [{ name: "build", appSlug: "github-actions" }], pesterCoverage: false },
    ]);
    expect(Object.isFrozen(load.entries[0])).toBe(true);
    expect(Object.isFrozen(load.entries[0]!.requiredChecks)).toBe(true);
  });

  test("accepts a core entry identical to CORE_POLICY", () => {
    expect(parsePolicyFile(file([coreEntry(), entry()])).ok).toBe(true);
  });

  const cases: Array<[string, string]> = [
    ["malformed JSON", "{"],
    ["a top-level array", JSON.stringify([entry()])],
    ["an unknown top-level key", file([entry()], { extra: true })],
    ["an unknown entry key", file([entry({ extra: true })])],
    ["the deferred key livingDocs", file([entry({ livingDocs: ["README.md"] })])],
    ["an unknown check key", file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions", extra: 1 }] })])],
    ["version 2", JSON.stringify({ version: 2, repos: [entry()] })],
    ["a missing version", JSON.stringify({ repos: [entry()] })],
    ["empty repos", file([])],
    ["repos not an array", JSON.stringify({ version: 1, repos: entry() })],
    ["an entry that is not an object", file(["owner/example"])],
    ["a missing repo", file([{ ciWorkflowPath: ".github/workflows/ci.yml", requiredChecks: [{ name: "build", appSlug: "github-actions" }] }])],
    ["a malformed repo", file([entry({ repo: "owner" })])],
    ["a non-string repo", file([entry({ repo: 5 })])],
    ["an empty requiredChecks", file([entry({ requiredChecks: [] })])],
    ["requiredChecks not an array", file([entry({ requiredChecks: { name: "build", appSlug: "github-actions" } })])],
    ["a missing name", file([entry({ requiredChecks: [{ appSlug: "github-actions" }] })])],
    ["an empty name", file([entry({ requiredChecks: [{ name: "", appSlug: "github-actions" }] })])],
    ["a non-string name", file([entry({ requiredChecks: [{ name: 1, appSlug: "github-actions" }] })])],
    ["a name with surrounding whitespace", file([entry({ requiredChecks: [{ name: " build", appSlug: "github-actions" }] })])],
    ["a name with a newline", file([entry({ requiredChecks: [{ name: `bu${String.fromCharCode(10)}ild`, appSlug: "github-actions" }] })])],
    ["a name over 100 characters", file([entry({ requiredChecks: [{ name: "b".repeat(101), appSlug: "github-actions" }] })])],
    ["a missing appSlug", file([entry({ requiredChecks: [{ name: "build" }] })])],
    ["an empty appSlug", file([entry({ requiredChecks: [{ name: "build", appSlug: "" }] })])],
    ["an appSlug other than github-actions", file([entry({ requiredChecks: [{ name: "build", appSlug: "circleci-checks" }] })])],
    ["an uppercase appSlug", file([entry({ requiredChecks: [{ name: "build", appSlug: "GitHub-Actions" }] })])],
    ["a missing ciWorkflowPath", file([{ repo: "owner/example", requiredChecks: [{ name: "build", appSlug: "github-actions" }] }])],
    ["an empty ciWorkflowPath", file([entry({ ciWorkflowPath: "" })])],
    ["a non-string ciWorkflowPath", file([entry({ ciWorkflowPath: 3 })])],
    ["a ciWorkflowPath outside .github/workflows", file([entry({ ciWorkflowPath: ".circleci/config.yml" })])],
    ["a duplicate repo", file([entry(), entry()])],
    ["a duplicate repo differing only in case", file([entry(), entry({ repo: "Owner/Example" })])],
    [
      "a duplicate check pair",
      file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions" }, { name: "build", appSlug: "github-actions" }] })]),
    ],
    ["a duplicate JSON key", '{"version": 1, "version": 1, "repos": [{"repo": "owner/example", "ciWorkflowPath": ".github/workflows/ci.yml", "requiredChecks": [{"name": "build", "appSlug": "github-actions"}]}]}'],
    ["a duplicate JSON key inside an entry", '{"version": 1, "repos": [{"repo": "owner/other", "repo": "owner/example", "ciWorkflowPath": ".github/workflows/ci.yml", "requiredChecks": [{"name": "build", "appSlug": "github-actions"}]}]}'],
    ["a core entry with a different workflow path", file([{ ...coreEntry(), ciWorkflowPath: ".github/workflows/other.yml" }])],
    ["a core entry with fewer checks", file([{ ...coreEntry(), requiredChecks: coreEntry().requiredChecks.slice(1) }])],
    ["a core entry with its checks reordered", file([{ ...coreEntry(), requiredChecks: [...coreEntry().requiredChecks].reverse() }])],
    ["a core entry whose repo differs only in case", file([{ ...coreEntry(), repo: CORE_POLICY.repo.toLowerCase() }])],
  ];

  test.each(cases)("refuses %s", (_label, raw) => {
    const load = parsePolicyFile(raw);
    expect(load.ok).toBe(false);
    expect(reasonOf(load).length).toBeGreaterThan(0);
  });

  test("names a deferred key as unsupported by this reviewer version", () => {
    expect(reasonOf(parsePolicyFile(file([entry({ livingDocs: [] })])))).toContain('key "livingDocs" is not supported by this reviewer version');
  });

  test("a refusal names the key path, never a check list or another repository", () => {
    const raw = file([entry({ repo: "owner/other" }), entry({ requiredChecks: [{ name: "secret-check-name", appSlug: "nope" }] })]);
    const reason = reasonOf(parsePolicyFile(raw));
    expect(reason).toContain("repos[1].requiredChecks[0].appSlug");
    expect(reason).not.toContain("owner/other");
    expect(reason).not.toContain("owner/example");
    expect(reason).not.toContain("secret-check-name");
  });
});

describe("loadPolicyFile()", () => {
  test("loads a valid file outside every checkout", () => {
    const load = loadPolicyFile(writePolicy(file([entry()])));
    expect(load.ok).toBe(true);
  });

  test("refuses a relative path", () => {
    expect(loadPolicyFile("policy.json").ok).toBe(false);
  });

  test("refuses a missing file", () => {
    expect(loadPolicyFile(join(TMP, "no-such-policy.json")).ok).toBe(false);
  });

  test("refuses a directory", () => {
    const dir = join(TMP, "a-directory.json");
    mkdirSync(dir);
    expect(loadPolicyFile(dir).ok).toBe(false);
  });

  test(`refuses a file over ${MAX_POLICY_FILE_BYTES} bytes`, () => {
    const padded = JSON.stringify({ version: 1, repos: [entry()] }, null, 1) + " ".repeat(MAX_POLICY_FILE_BYTES);
    const load = loadPolicyFile(writePolicy(padded));
    expect(load.ok).toBe(false);
  });

  test("refuses a symbolic link (lstat, never followed)", () => {
    const target = writePolicy(file([entry()]));
    const fakeFs = {
      lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => false, size: 10 }),
    };
    expect(loadPolicyFile(target, fakeFs).ok).toBe(false);
  });

  test("refuses a file inside the reviewer's own checkout", () => {
    // Not written to disk: the checkout's own .git is found on the way up from the realpath of an
    // existing file in the checkout, so an existing tracked file stands in.
    expect(loadPolicyFile(join(REPO_ROOT, "README.md")).ok).toBe(false);
  });

  // Critique item 4: a worktree's REPO_ROOT is not the main clone, so a file at the main clone's
  // root sat outside REPO_ROOT and passed. Any .git entry on any ancestor refuses, file or directory.
  test.each(["directory", "file"] as const)("refuses a file anywhere under a parent checkout whose .git is a %s", (kind) => {
    const checkout = mkdtempSync(join(TMP, `checkout-${kind}-`));
    if (kind === "directory") mkdirSync(join(checkout, ".git"));
    else writeFileSync(join(checkout, ".git"), "gitdir: elsewhere\n");
    const nested = join(checkout, "deeper", "still");
    mkdirSync(nested, { recursive: true });
    const load = loadPolicyFile(writePolicy(file([entry()]), nested));
    expect(load.ok).toBe(false);
    expect(reasonOf(load)).toContain("checkout");
  });

  test("a refusal never carries the policy file's path", () => {
    const dir = mkdtempSync(join(TMP, "path-marker-"));
    const paths = [
      writePolicy("{", dir),
      join(dir, "missing.json"),
      writePolicy(file([entry({ extra: 1 })]), dir),
    ];
    for (const path of paths) {
      const reason = reasonOf(loadPolicyFile(path));
      expect(reason.length).toBeGreaterThan(0);
      expect(reason).not.toContain("path-marker");
      expect(reason).not.toContain(TMP);
    }
  });
});

describe("resolvePolicy()", () => {
  const loaded = (entries: unknown[]) => () => parsePolicyFile(file(entries));

  test("no file: the core repository resolves to CORE_POLICY itself", () => {
    expect(resolvePolicy(CORE_POLICY.repo, null)).toBe(CORE_POLICY);
  });

  test("no file: any other repository refuses, with a message naming --policy", () => {
    expect(() => resolvePolicy("owner/example", null)).toThrow(RefusalError);
    expect(() => resolvePolicy("owner/example", null)).toThrow("--policy");
  });

  test("a listed repository resolves to its entry", () => {
    const policy = resolvePolicy("owner/example", "/abs/policy.json", loaded([entry()]));
    expect(policy.repo).toBe("owner/example");
    expect(policy.ciWorkflowPath).toBe(".github/workflows/ci.yml");
    expect(policy.pesterCoverage).toBe(false);
  });

  // Critique item 2: the file's copy of the core entry cannot carry pesterCoverage, so returning it
  // would drop this repository's Pester coverage. The frozen built-in object is returned instead.
  test("a file listing an identical core entry still resolves the core repository to CORE_POLICY itself", () => {
    const policy = resolvePolicy(CORE_POLICY.repo, "/abs/policy.json", loaded([coreEntry(), entry()]));
    expect(policy).toBe(CORE_POLICY);
    expect(policy.pesterCoverage).toBe(true);
  });

  test("an unknown repository refuses, naming no check and no other repository from the file", () => {
    const attempt = () => resolvePolicy("owner/unlisted", "/abs/policy.json", loaded([entry({ repo: "owner/other" })]));
    expect(attempt).toThrow(RefusalError);
    let message = "";
    try {
      attempt();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("owner/other");
    expect(message).not.toContain("build");
    for (const check of CORE_POLICY.requiredChecks) expect(message).not.toContain(check.name);
  });

  test("lookup is exact: a case-only mismatch refuses", () => {
    expect(() => resolvePolicy("Owner/Example", "/abs/policy.json", loaded([entry()]))).toThrow(RefusalError);
    expect(() => resolvePolicy(CORE_POLICY.repo.toLowerCase(), null)).toThrow(RefusalError);
  });

  test("an invalid file refuses even for the core repository", () => {
    const bad = () => ({ ok: false as const, reason: "repos: must be a non-empty array" });
    expect(() => resolvePolicy(CORE_POLICY.repo, "/abs/policy.json", bad)).toThrow(RefusalError);
  });

  test("a real file on disk: listed resolves, unlisted refuses without the path", () => {
    const path = writePolicy(file([entry()]));
    expect(resolvePolicy("owner/example", path).repo).toBe("owner/example");
    try {
      resolvePolicy("owner/unlisted", path);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(RefusalError);
      expect((error as Error).message).not.toContain(TMP);
    }
  });
});
