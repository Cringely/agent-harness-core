// Pins the CI secret scan (#251): the "secret scan (Gitleaks)" job in .github/workflows/test.yml
// and the repo's .gitleaks.toml.
//
// The invariant: a pull request's commit range is either scanned or the job fails. Never "scanned
// nothing, passed". Two ways to get there were found while building the job, and the second
// group below pins both. gitleaks exits 0 when its own `git log` fails on a bad range, and a
// `for c in $(git rev-list ...)` over an unresolvable range is an empty loop that exits 0. Both
// read as a clean scan.
//
// The first group is static: the binary is pinned by hash, no third-party action, the config
// carries the one allowlist entry it is documented to carry. The second group runs the workflow's
// own `run:` blocks under bash against a scratch repository, with a stub standing in for the
// gitleaks binary (the real one is exercised by the job's own canary step on every run). The live
// proof that the real job fails on a planted secret is a throwaway pull request, which a
// unit test cannot be.
//
// CRLF-tolerant: the YAML and TOML are read through parsers, not line splits.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posixBash } from "./posix-sh";

const REPO_ROOT = join(import.meta.dir, "..");
const JOB = "secret-scan";

type Step = { name?: string; uses?: string; run?: string };
type Job = { name?: string; if?: string; env?: Record<string, string>; steps: Step[] };

function loadJob(): Job {
  const wf = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8")) as {
    jobs: Record<string, Job>;
  };
  const job = wf.jobs[JOB];
  if (!job) throw new Error(`no ${JOB} job in test.yml`);
  return job;
}

function runOf(job: Job, name: string): string {
  const step = job.steps.find((s) => s.name === name);
  if (!step?.run) throw new Error(`no run step named "${name}" in the ${JOB} job`);
  return step.run;
}

describe("secret-scan job pins", () => {
  test("gitleaks is a hash-pinned binary, never a third-party action", () => {
    const job = loadJob();
    expect(job.env?.GITLEAKS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(job.env?.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(runOf(job, "Install Gitleaks")).toContain("sha256sum -c");
    for (const s of job.steps) {
      if (s.uses) expect(s.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}( |$)/);
      expect(s.uses ?? "").not.toContain("gitleaks");
    }
  });

  test("runs on pull requests, with the check name the ruleset will require", () => {
    const job = loadJob();
    expect(job.name).toBe("secret scan (Gitleaks)");
    expect(job.if).toContain("pull_request");
  });

  test("the canary and the range check run before either scan", () => {
    const names = loadJob().steps.map((s) => s.name);
    const at = (n: string) => names.indexOf(n);
    for (const scan of ["Scan the pull request's commits", "Scan commit messages and paths"]) {
      expect(at("Scanner canary")).toBeGreaterThan(-1);
      expect(at("Scanner canary")).toBeLessThan(at(scan));
      expect(at("Resolve the commit range")).toBeGreaterThan(-1);
      expect(at("Resolve the commit range")).toBeLessThan(at(scan));
    }
  });
});

// A merge commit carries no diff of its own unless git is told which parent to compare against, so
// a secret added only in a conflict resolution or an evil merge was counted as scanned and never
// read. Verified against gitleaks 8.30.1: without the flag a 3-commit range reported 2 scanned and
// exit 0, with it 3 scanned and exit 1. The flag must be on both scans.
describe("secret-scan reads merge commits", () => {
  test("both scans pass --diff-merges=first-parent", () => {
    const job = loadJob();
    expect(runOf(job, "Scan the pull request's commits")).toMatch(/--log-opts "--diff-merges=first-parent \$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}"/);
    expect(runOf(job, "Scan commit messages and paths")).toContain("git log -1 --diff-merges=first-parent --name-only");
  });

  test("the message scan feeds a merge-only path to the scanner", () => {
    const s = scratch(0);
    try {
      const seen = join(s.dir, "rt", "seen.txt");
      // Stub records its stdin so the test can see which paths the message step handed over.
      writeFileSync(join(s.dir, "rt", "gitleaks"), `#!/bin/sh\ncat >> "${seen.replace(/\\/g, "/")}"\nexit 0\n`);
      const g = (...a: string[]) => {
        const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
          cwd: join(s.dir, "repo"),
          stdout: "pipe",
          stderr: "pipe",
        });
        if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
      };
      const repo = join(s.dir, "repo");
      g("checkout", "-q", "-b", "side", s.base);
      writeFileSync(join(repo, "side.txt"), "s\n");
      g("add", "side.txt");
      g("commit", "-q", "-m", "side");
      g("checkout", "-q", "-");
      g("merge", "-q", "--no-ff", "--no-commit", "side");
      writeFileSync(join(repo, "only-in-merge.txt"), "m\n");
      g("add", "only-in-merge.txt");
      g("commit", "-q", "-m", "merge side");
      const mergeHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout.toString().trim();
      expect(s.run(runOf(loadJob(), "Scan commit messages and paths"), s.base, mergeHead)).toBe(0);
      expect(readFileSync(seen, "utf8")).toContain("only-in-merge.txt");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
});

describe(".gitleaks.toml", () => {
  test("extends the default rules and allowlists only AWS's documented example key", () => {
    const cfg = Bun.TOML.parse(readFileSync(join(REPO_ROOT, ".gitleaks.toml"), "utf8")) as {
      extend?: { useDefault?: boolean };
      allowlist?: Record<string, unknown>;
      rules?: unknown;
    };
    expect(cfg.extend?.useDefault).toBe(true);
    expect(cfg.rules).toBeUndefined();
    const { description: _description, ...allow } = cfg.allowlist ?? {};
    expect(allow).toEqual({ regexes: ["AKIAIOSFODNN7EXAMPLE"] });
  });
});

// A scratch repository with one commit on top of a base, a stub gitleaks, and the job's own shell.
function scratch(stubExit: number) {
  const dir = mkdtempSync(join(tmpdir(), "secretscan-"));
  const fwd = (p: string) => p.replace(/\\/g, "/");
  const repo = join(dir, "repo");
  const rt = join(dir, "rt");
  mkdirSync(repo);
  mkdirSync(rt);
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git("add", "b.txt");
  git("commit", "-q", "-m", "change");
  const head = git("rev-parse", "HEAD");
  // Stand-in for the gitleaks binary: exits with the code under test, report left empty.
  writeFileSync(join(rt, "gitleaks"), `#!/bin/sh\nexit ${stubExit}\n`);
  chmodSync(join(rt, "gitleaks"), 0o755);
  writeFileSync(join(repo, ".gitleaks.toml"), "");
  const run = (script: string, baseSha: string, headSha: string) => {
    const bash = posixBash();
    const r = Bun.spawnSync([bash, "-e", "-c", script], {
      cwd: repo,
      env: { ...process.env, RUNNER_TEMP: fwd(rt), BASE_SHA: baseSha, HEAD_SHA: headSha },
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.exitCode;
  };
  return { dir, base, head, run };
}

const BOGUS = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("secret-scan range handling fails closed", () => {
  test("an unresolvable range is refused by the range check and by the message scan", () => {
    const job = loadJob();
    const s = scratch(0);
    try {
      expect(s.run(runOf(job, "Resolve the commit range"), BOGUS, s.head)).not.toBe(0);
      expect(s.run(runOf(job, "Scan commit messages and paths"), BOGUS, s.head)).not.toBe(0);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("a resolvable range passes the range check", () => {
    const s = scratch(0);
    try {
      expect(s.run(runOf(loadJob(), "Resolve the commit range"), s.base, s.head)).toBe(0);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("the message scan passes on exit 0 and fails on a finding (1) or a scanner error (2)", () => {
    const script = runOf(loadJob(), "Scan commit messages and paths");
    const expected: Array<[number, "pass" | "fail"]> = [
      [0, "pass"],
      [1, "fail"],
      [2, "fail"],
    ];
    for (const [stubExit, outcome] of expected) {
      const s = scratch(stubExit);
      try {
        const rc = s.run(script, s.base, s.head);
        if (outcome === "pass") expect(rc).toBe(0);
        else expect(rc).not.toBe(0);
      } finally {
        rmSync(s.dir, { recursive: true, force: true });
      }
    }
  });
});

// A config read from the pull request head lets the pull request allowlist its own secret, and the
// scan then reports clean. The rules must come from the base commit. Invariant: the config the scan
// runs under is established at BASE_SHA, never from the checkout's working tree.
describe("secret-scan reads its config from the base commit", () => {
  const STEP = "Load the scanner config from the base commit";

  test("every gitleaks invocation uses the base-derived file, none the checkout's copy", () => {
    const job = loadJob();
    const scanning = job.steps.filter((s) => s.run?.includes('/gitleaks" '));
    expect(scanning.length).toBeGreaterThanOrEqual(3);
    for (const s of scanning) {
      expect(s.run).toContain('--config "$RUNNER_TEMP/gitleaks.toml"');
      expect(s.run).not.toMatch(/--config \.gitleaks\.toml/);
    }
    const names = job.steps.map((s) => s.name);
    expect(names.indexOf(STEP)).toBeGreaterThan(-1);
    expect(names.indexOf(STEP)).toBeLessThan(names.indexOf("Scanner canary"));
  });

  // Base holds one config, then the head commit replaces it with one that allowlists a value.
  function withConfigs(baseToml: string | null) {
    const s = scratch(0);
    const repo = join(s.dir, "repo");
    const g = (...a: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
      return new TextDecoder().decode(r.stdout).trim();
    };
    if (baseToml !== null) {
      writeFileSync(join(repo, ".gitleaks.toml"), baseToml);
      g("add", ".gitleaks.toml");
      g("commit", "-q", "-m", "base config");
    } else {
      rmSync(join(repo, ".gitleaks.toml"));
    }
    const base = g("rev-parse", "HEAD");
    writeFileSync(join(repo, ".gitleaks.toml"), '[allowlist]\nregexes = ["HEADONLY"]\n');
    g("add", ".gitleaks.toml");
    g("commit", "-q", "-m", "head config");
    return { s, base, head: g("rev-parse", "HEAD"), out: join(s.dir, "rt", "gitleaks.toml") };
  }

  test("a config the head adds or changes never reaches the scan", () => {
    const script = runOf(loadJob(), STEP);
    const baseToml = '[extend]\nuseDefault = true\n# BASEONLY\n';
    const a = withConfigs(baseToml);
    const b = withConfigs(null);
    try {
      expect(a.s.run(script, a.base, a.head)).toBe(0);
      expect(readFileSync(a.out, "utf8")).toContain("BASEONLY");
      expect(readFileSync(a.out, "utf8")).not.toContain("HEADONLY");
      // No config at base (the pull request that introduces it): built-in defaults, never the head's.
      expect(b.s.run(script, b.base, b.head)).toBe(0);
      const fallback = readFileSync(b.out, "utf8");
      expect(fallback).toContain("useDefault = true");
      expect(fallback).not.toContain("HEADONLY");
    } finally {
      rmSync(a.s.dir, { recursive: true, force: true });
      rmSync(b.s.dir, { recursive: true, force: true });
    }
  });

  test("an unreadable base tree fails the job instead of falling back", () => {
    const w = withConfigs(null);
    try {
      expect(w.s.run(runOf(loadJob(), STEP), BOGUS, w.head)).not.toBe(0);
    } finally {
      rmSync(w.s.dir, { recursive: true, force: true });
    }
  });
});
