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
  extraWorkflowPaths,
  loadPolicyFile,
  parsePolicyFile,
  resolvePolicy,
  workflowPathProblem,
  type PolicyLoad,
} from "../tools/pr-review/repo-policy";
import { REPO_ROOT } from "../tools/pr-review/tool-state";
import { CODE_SCANNING_APP_SLUG, RefusalError } from "../tools/pr-review/types";

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

// A whole-file refusal's reason, or every invalid entry's reason joined.
const reasonOf = (load: PolicyLoad): string => (load.ok ? load.invalidEntries.map((invalid) => invalid.reason).join("\n") : load.reason);

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

  // Problems no single entry owns: the whole file is invalid and every repository refuses.
  const fileCases: Array<[string, string]> = [
    ["malformed JSON", "{"],
    ["a top-level array", JSON.stringify([entry()])],
    ["an unknown top-level key", file([entry()], { extra: true })],
    ["version 2", JSON.stringify({ version: 2, repos: [entry()] })],
    ["a missing version", JSON.stringify({ repos: [entry()] })],
    ["empty repos", file([])],
    ["repos not an array", JSON.stringify({ version: 1, repos: entry() })],
    ["an entry that is not an object", file(["owner/example"])],
    ["a missing repo", file([{ ciWorkflowPath: ".github/workflows/ci.yml", requiredChecks: [{ name: "build", appSlug: "github-actions" }] }])],
    ["a malformed repo", file([entry({ repo: "owner" })])],
    ["a non-string repo", file([entry({ repo: 5 })])],
    ["a duplicate repo", file([entry(), entry()])],
    ["a duplicate repo differing only in case", file([entry(), entry({ repo: "Owner/Example" })])],
    ["a duplicate JSON key", '{"version": 1, "version": 1, "repos": [{"repo": "owner/example", "ciWorkflowPath": ".github/workflows/ci.yml", "requiredChecks": [{"name": "build", "appSlug": "github-actions"}]}]}'],
    ["a duplicate JSON key inside an entry", '{"version": 1, "repos": [{"repo": "owner/other", "repo": "owner/example", "ciWorkflowPath": ".github/workflows/ci.yml", "requiredChecks": [{"name": "build", "appSlug": "github-actions"}]}]}'],
  ];

  test.each(fileCases)("refuses the whole file on %s", (_label, raw) => {
    const load = parsePolicyFile(raw);
    expect(load.ok).toBe(false);
    expect(reasonOf(load).length).toBeGreaterThan(0);
  });

  // Problems inside one entry whose repo is readable: that repository refuses, and every other
  // repository in the same file still resolves (#349).
  const cases: Array<[string, string]> = [
    ["an unknown entry key", file([entry({ extra: true })])],
    ["the deferred key livingDocs", file([entry({ livingDocs: ["README.md"] })])],
    ["an unknown check key", file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions", extra: 1 }] })])],
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
    [
      "a duplicate check pair",
      file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions" }, { name: "build", appSlug: "github-actions" }] })]),
    ],
    [
      "a duplicate check pair whose workflow paths differ",
      file([
        entry({
          requiredChecks: [
            { name: "build", appSlug: "github-actions" },
            { name: "build", appSlug: "github-actions", workflowPath: ".github/workflows/other.yml" },
          ],
        }),
      ]),
    ],
    ["a check workflowPath with a dot-dot segment", file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions", workflowPath: ".github/workflows/../x.yml" }] })])],
    ["a check workflowPath outside .github/workflows", file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions", workflowPath: "ci/build.yml" }] })])],
    ["a non-string check workflowPath", file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions", workflowPath: 1 }] })])],
    [
      "a code-scanning check that names a workflow",
      file([
        entry({
          requiredChecks: [
            { name: "build", appSlug: "github-actions" },
            { name: "CodeQL", appSlug: "github-advanced-security", workflowPath: ".github/workflows/codeql.yml" },
          ],
        }),
      ]),
    ],
    ["only code-scanning checks", file([entry({ requiredChecks: [{ name: "CodeQL", appSlug: "github-advanced-security" }] })])],
    ["a cannotVouchAdd that is not an array", file([entry({ cannotVouchAdd: "scripts/" })])],
    ["an empty cannotVouchAdd", file([entry({ cannotVouchAdd: [] })])],
    ["a non-string cannotVouchAdd item", file([entry({ cannotVouchAdd: [3] })])],
    ["an empty cannotVouchAdd item", file([entry({ cannotVouchAdd: [""] })])],
    ["a cannotVouchAdd item of only a slash", file([entry({ cannotVouchAdd: ["/"] })])],
    ["an absolute cannotVouchAdd item", file([entry({ cannotVouchAdd: ["/etc/passwd"] })])],
    ["a dot-dot cannotVouchAdd item", file([entry({ cannotVouchAdd: ["src/../x"] })])],
    ["a leading dot-dot cannotVouchAdd item", file([entry({ cannotVouchAdd: ["../x/"] })])],
    ["a dot cannotVouchAdd item", file([entry({ cannotVouchAdd: ["./scripts/"] })])],
    ["an empty-segment cannotVouchAdd item", file([entry({ cannotVouchAdd: ["src//x"] })])],
    ["a backslash cannotVouchAdd item", file([entry({ cannotVouchAdd: ["src" + String.fromCharCode(92) + "x"] })])],
    ["a control character in a cannotVouchAdd item", file([entry({ cannotVouchAdd: [`sr${String.fromCharCode(9)}c/`] })])],
    ["a cannotVouchAdd item over 200 characters", file([entry({ cannotVouchAdd: ["a".repeat(201)] })])],
    ["a core entry with a different workflow path", file([{ ...coreEntry(), ciWorkflowPath: ".github/workflows/other.yml" }])],
    ["a core entry with fewer checks", file([{ ...coreEntry(), requiredChecks: coreEntry().requiredChecks.slice(1) }])],
    ["a core entry with its checks reordered", file([{ ...coreEntry(), requiredChecks: [...coreEntry().requiredChecks].reverse() }])],
    ["a core entry whose repo differs only in case", file([{ ...coreEntry(), repo: CORE_POLICY.repo.toLowerCase() }])],
    ["a core entry carrying cannotVouchAdd", file([{ ...coreEntry(), cannotVouchAdd: ["scripts/"] }])],
    [
      "a core entry whose check names its own workflow",
      file([{ ...coreEntry(), requiredChecks: coreEntry().requiredChecks.map((c) => ({ ...c, workflowPath: CORE_POLICY.ciWorkflowPath })) }]),
    ],
  ];

  test.each(cases)("refuses the entry with %s", (_label, raw) => {
    const load = parsePolicyFile(raw);
    expect(reasonOf(load).length).toBeGreaterThan(0);
    const repo = (JSON.parse(raw) as { repos: Array<{ repo: string }> }).repos[0]!.repo;
    expect(() => resolvePolicy(repo, "/abs/policy.json", () => load)).toThrow(RefusalError);
    if (repo.toLowerCase() === CORE_POLICY.repo.toLowerCase()) {
      expect(() => resolvePolicy(CORE_POLICY.repo, "/abs/policy.json", () => load)).toThrow(RefusalError);
    }
  });

  // #349: one repository's bad entry must not stop another repository's reviews.
  test.each(cases)("with %s, a valid sibling entry still resolves", (_label, raw) => {
    const parsed = JSON.parse(raw) as { version: number; repos: unknown[] };
    const load = parsePolicyFile(JSON.stringify({ ...parsed, repos: [...parsed.repos, entry({ repo: "owner/sibling" })] }));
    expect(load.ok).toBe(true);
    expect(resolvePolicy("owner/sibling", "/abs/policy.json", () => load).repo).toBe("owner/sibling");
  });

  // An operator-authored key can itself be a private name, so a refusal names
  // only where the unsupported key sits, never the key.
  test("a deferred key refuses as unsupported without echoing its name", () => {
    const reason = reasonOf(parsePolicyFile(file([entry({ livingDocs: [] })])));
    expect(reason).toContain("entry 0: an unsupported key");
    expect(reason).not.toContain("livingDocs");
  });

  test.each([
    ["the top level", (key: string) => file([entry()], { [key]: 1 }), "the top level: an unsupported key"],
    ["an entry", (key: string) => file([entry(), entry({ repo: "owner/second", [key]: 1 })]), "entry 1: an unsupported key"],
    [
      "a check",
      (key: string) => file([entry({ requiredChecks: [{ name: "build", appSlug: "github-actions", [key]: 1 }] })]),
      "entry 0, check 0: an unsupported key",
    ],
  ] as const)("an arbitrary unknown key at %s never appears in the reason", (_label, build, location) => {
    for (const key of ["privateRepoName", "acme-internal-tool", "x"]) {
      const reason = reasonOf(parsePolicyFile(build(key)));
      expect(reason).toContain(location);
      expect(reason).not.toContain(key);
    }
  });

  // Deep nesting can overflow the stack in JSON.parse or in the key count. Any
  // error must still come back as an invalid-file reason, so --json prints the structured refusal.
  test("deeply nested arrays under an extra key refuse as invalid rather than throwing", () => {
    const depth = 200_000;
    const raw = `{"version": 1, "repos": [], "extra": ${"[".repeat(depth)}${"]".repeat(depth)}}`;
    let load: PolicyLoad | undefined;
    expect(() => {
      load = parsePolicyFile(raw);
    }).not.toThrow();
    expect(load!.ok).toBe(false);
    expect(reasonOf(load!).length).toBeGreaterThan(0);
  });

  test("a refusal names the key path, never a check list or another repository", () => {
    const raw = file([entry({ repo: "owner/other" }), entry({ requiredChecks: [{ name: "secret-check-name", appSlug: "nope" }] })]);
    const reason = reasonOf(parsePolicyFile(raw));
    expect(reason).toContain("repos[1].requiredChecks[0].appSlug");
    expect(reason).not.toContain("owner/other");
    expect(reason).not.toContain("owner/example");
    expect(reason).not.toContain("secret-check-name");
  });

  test("the refusal for an invalid entry names its key path, never another repository or a check name", () => {
    const raw = file([entry({ repo: "owner/other" }), entry({ requiredChecks: [{ name: "secret-check-name", appSlug: "nope" }] })]);
    let message = "";
    try {
      resolvePolicy("owner/example", "/abs/policy.json", () => parsePolicyFile(raw));
    } catch (error) {
      expect(error).toBeInstanceOf(RefusalError);
      message = (error as Error).message;
    }
    expect(message).toContain("repos[1].requiredChecks[0].appSlug");
    expect(message).not.toContain("owner/other");
    expect(message).not.toContain("secret-check-name");
  });

  test("an invalid entry also refuses a request that differs from its repo only in case", () => {
    const load = parsePolicyFile(file([entry({ extra: true })]));
    expect(() => resolvePolicy("Owner/Example", "/abs/policy.json", () => load)).toThrow(RefusalError);
  });

  test("an invalid core entry refuses the core repository but not another one", () => {
    const load = parsePolicyFile(file([{ ...coreEntry(), ciWorkflowPath: ".github/workflows/other.yml" }, entry()]));
    expect(() => resolvePolicy(CORE_POLICY.repo, "/abs/policy.json", () => load)).toThrow(RefusalError);
    expect(resolvePolicy("owner/example", "/abs/policy.json", () => load).repo).toBe("owner/example");
  });

  test("a load that does not list its invalid entries refuses every repository", () => {
    const load = () => ({ ok: true, entries: [] }) as unknown as PolicyLoad;
    expect(() => resolvePolicy(CORE_POLICY.repo, "/abs/policy.json", load)).toThrow(RefusalError);
    expect(() => resolvePolicy("owner/example", "/abs/policy.json", load)).toThrow(RefusalError);
  });

  test("another entry's problem leaves the core repository resolving to CORE_POLICY", () => {
    const load = parsePolicyFile(file([coreEntry(), entry({ extra: true })]));
    expect(resolvePolicy(CORE_POLICY.repo, "/abs/policy.json", () => load)).toBe(CORE_POLICY);
  });
});

describe("per-check workflows, code-scanning checks and cannotVouchAdd (#349)", () => {
  const MULTI = entry({
    requiredChecks: [
      { name: "test", appSlug: "github-actions" },
      { name: "doc-size", appSlug: "github-actions", workflowPath: ".github/workflows/docs-gate.yml" },
      { name: "gitleaks", appSlug: "github-actions", workflowPath: ".github/workflows/security.yml" },
      { name: "also-ci", appSlug: "github-actions", workflowPath: ".github/workflows/ci.yml" },
      { name: "CodeQL", appSlug: "github-advanced-security" },
    ],
    cannotVouchAdd: [".githooks/", "scripts/", "Dockerfile"],
  });

  test("an entry with per-check workflows, a code-scanning check and cannotVouchAdd parses, frozen", () => {
    const load = parsePolicyFile(file([MULTI]));
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.invalidEntries).toEqual([]);
    const policy = load.entries[0]!;
    expect(policy.requiredChecks).toEqual([
      { name: "test", appSlug: "github-actions" },
      { name: "doc-size", appSlug: "github-actions", workflowPath: ".github/workflows/docs-gate.yml" },
      { name: "gitleaks", appSlug: "github-actions", workflowPath: ".github/workflows/security.yml" },
      { name: "also-ci", appSlug: "github-actions", workflowPath: ".github/workflows/ci.yml" },
      { name: "CodeQL", appSlug: "github-advanced-security" },
    ]);
    expect(policy.cannotVouchAdd).toEqual([".githooks/", "scripts/", "Dockerfile"]);
    expect(Object.isFrozen(policy.cannotVouchAdd)).toBe(true);
    expect(policy.pesterCoverage).toBe(false);
  });

  test("an entry without the optional keys carries neither", () => {
    const load = parsePolicyFile(file([entry()]));
    if (!load.ok) throw new Error("expected a valid file");
    expect("cannotVouchAdd" in load.entries[0]!).toBe(false);
    expect("workflowPath" in load.entries[0]!.requiredChecks[0]!).toBe(false);
  });

  test("the code-scanning app slug is the one GitHub reports for a default-setup CodeQL check", () => {
    expect(CODE_SCANNING_APP_SLUG).toBe("github-advanced-security");
  });

  test("extraWorkflowPaths lists each distinct per-check workflow other than ciWorkflowPath, once", () => {
    const load = parsePolicyFile(file([MULTI]));
    if (!load.ok) throw new Error("expected a valid file");
    expect(extraWorkflowPaths(load.entries[0]!)).toEqual([".github/workflows/docs-gate.yml", ".github/workflows/security.yml"]);
    expect(extraWorkflowPaths(CORE_POLICY)).toEqual([]);
    const shared = parsePolicyFile(
      file([
        entry({
          requiredChecks: [
            { name: "build", appSlug: "github-actions" },
            { name: "a", appSlug: "github-actions", workflowPath: ".github/workflows/x.yml" },
            { name: "b", appSlug: "github-actions", workflowPath: ".github/workflows/x.yml" },
          ],
        }),
      ]),
    );
    if (!shared.ok) throw new Error("expected a valid file");
    expect(extraWorkflowPaths(shared.entries[0]!)).toEqual([".github/workflows/x.yml"]);
  });

  test.each([
    ["", "must not be empty"],
    ["/etc/x", "must be relative to the repository root"],
    ["a/../b", "must not contain an empty, . or .. segment"],
  ])("a cannotVouchAdd item %p refuses with its own rule", (item, rule) => {
    expect(reasonOf(parsePolicyFile(file([entry({ cannotVouchAdd: [item] })])))).toBe(`repos[0].cannotVouchAdd[0]: ${rule}`);
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
