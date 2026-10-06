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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

// The default config's global [allowlist] paths skip images, svg, lockfiles, node_modules and vendor
// in git mode, so a key committed to one scanned clean (verified live on gitleaks 8.30.1: a fake
// ghp_ token in assets/logo.svg, node_modules/x/config.js and go.sum was reported only in a .txt).
// `extend.useDefault` cannot drop that list, because extend() appends allowlists and no flag
// disables it, so the default rules are vendored without the path list. The vendored version must
// track the pinned binary, or the rules drift from the engine that reads them.
describe(".gitleaks.toml", () => {
  type Cfg = {
    extend?: unknown;
    allowlist?: { paths?: unknown; regexes?: string[] };
    allowlists?: unknown;
    rules?: Array<{ id: string; allowlists?: Array<{ paths?: string[] }> }>;
  };
  const raw = () => readFileSync(join(REPO_ROOT, ".gitleaks.toml"), "utf8");
  const cfg = () => Bun.TOML.parse(raw()) as Cfg;

  test("vendors the default rules rather than extending them, with no global path allowlist", () => {
    const c = cfg();
    expect(c.extend).toBeUndefined();
    expect(c.allowlists).toBeUndefined();
    expect(c.allowlist?.paths).toBeUndefined();
    expect((c.rules ?? []).length).toBeGreaterThan(100);
    const ids = (c.rules ?? []).map((r) => r.id);
    for (const id of ["generic-api-key", "github-pat", "aws-access-token"]) expect(ids).toContain(id);
  });

  test("keeps AWS's documented example key as the repo's one added allowlist regex", () => {
    const c = cfg();
    expect((c.allowlist?.regexes ?? []).filter((r) => r.includes("AKIA"))).toEqual(["AKIAIOSFODNN7EXAMPLE"]);
    // The repo's one added path allowlist stops the bedrock rule matching its own definition. Other
    // rules carry upstream path allowlists of their own, which are per rule and stay.
    const bedrock = (c.rules ?? []).find((r) => r.id === "aws-amazon-bedrock-api-key-short-lived");
    expect(bedrock?.allowlists?.flatMap((a) => a.paths ?? [])).toEqual(["^\\.gitleaks\\.toml$"]);
  });

  test("the vendored version equals the version the workflow pins", () => {
    const m = raw().match(/Vendored from gitleaks v(\d+\.\d+\.\d+) /);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(loadJob().env?.GITLEAKS_VERSION);
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
      env: { ...process.env, PATH: `${rt}${delimiter}${process.env.PATH}`, RUNNER_TEMP: fwd(rt), BASE_SHA: baseSha, HEAD_SHA: headSha },
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

// gitleaks and git read more than the config from the checkout, which is the pull request merge
// ref: .gitleaksignore (suppresses a finding by fingerprint), .gitattributes (a binary marking
// blanks a diff) and any relative [extend] path. The scans read commits, not the tree, so the tree
// is detached to the base commit. Confirmed live against gitleaks 8.30.1: a head-added
// .gitleaksignore turns the scan exit 1 into exit 0, and --ignore-gitleaks-allow defeats an
// inline gitleaks:allow comment.
describe("secret-scan cannot be steered by files in the checkout", () => {
  const DETACH = "Detach the working tree to the base commit";

  test("the working tree is detached to the base commit before anything runs the scanner", () => {
    const job = loadJob();
    const names = job.steps.map((s) => s.name);
    expect(names).toContain(DETACH);
    expect(runOf(job, DETACH)).toMatch(/checkout -q --detach "\$\{BASE_SHA\}"/);
    const at = names.indexOf(DETACH);
    job.steps.forEach((s, i) => {
      if (s.run?.includes('/gitleaks" ')) expect(i).toBeGreaterThan(at);
    });
  });

  test("the detach step leaves a head-only .gitleaksignore out of the tree", () => {
    const s = scratch(0);
    const repo = join(s.dir, "repo");
    try {
      writeFileSync(join(repo, ".gitleaksignore"), "fake:rule:1\n");
      const g = (...a: string[]) => {
        const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
        if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
        return new TextDecoder().decode(r.stdout).trim();
      };
      g("add", ".gitleaksignore");
      g("commit", "-q", "-m", "head adds an ignore file");
      expect(existsSync(join(repo, ".gitleaksignore"))).toBe(true);
      expect(s.run(runOf(loadJob(), DETACH), s.head, g("rev-parse", "HEAD"))).toBe(0);
      expect(existsSync(join(repo, ".gitleaksignore"))).toBe(false);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("every gitleaks call carries --ignore-gitleaks-allow and --config, counted per call not per step", () => {
    const calls = loadJob().steps.filter((st) => st.run?.includes('/gitleaks" '));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const st of calls) {
      const n = (st.run!.match(/\/gitleaks" /g) ?? []).length;
      expect((st.run!.match(/--ignore-gitleaks-allow/g) ?? []).length).toBe(n);
      expect((st.run!.match(/--config "\$RUNNER_TEMP\/gitleaks\.toml"/g) ?? []).length).toBe(n);
    }
  });
});
// Two fail-open reads of the scanner's exit code, both confirmed live against gitleaks 8.30.1
// (#251 review, round 3). `gitleaks git` exits 0 when its own `git log` fails and says so only as
// an ERR line on stderr. Any fatal error, such as an unparseable config, exits 1 with no report,
// which the canary read as a detection. The stubs below reproduce each shape.
describe("secret-scan does not read a scanner failure as a result", () => {
  const SCAN = "Scan the pull request's commits";
  const CANARY = "Scanner canary";

  // A stub that writes `report` to whatever --report-path it is given, then exits `code`.
  function stubbed(code: number, opts: { report?: string; stderr?: string }) {
    const s = scratch(0);
    const lines = [
      "#!/bin/sh",
      'while [ $# -gt 0 ]; do [ "$1" = --report-path ] && rp=$2; shift; done',
      opts.report !== undefined ? `printf '%s' '${opts.report}' > "$rp"` : "",
      opts.stderr ? `printf '%b\n' '${opts.stderr}' >&2` : "",
      `exit ${code}`,
    ];
    writeFileSync(join(s.dir, "rt", "gitleaks"), lines.join("\n") + "\n");
    // CI has jq. A workstation may not, so give the step a minimal stand-in for `jq -e 'length > 0'`.
    if (!Bun.spawnSync([posixBash(), "-c", "command -v jq"], { stdout: "ignore", stderr: "ignore" }).success) {
      writeFileSync(
        join(s.dir, "rt", "jq"),
        `#!/bin/sh\nexec bun -e 'let ok=false;try{const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));ok=Array.isArray(a)&&a.length>0}catch{}process.exit(ok?0:1)' "$3"\n`,
      );
      chmodSync(join(s.dir, "rt", "jq"), 0o755);
    }
    return s;
  }
  // A shell function rather than a PATH entry: Windows has no exec bit, so a bare script named jq is not found.
  const withRt = (s: ReturnType<typeof scratch>) => (script: string) =>
    s.run(`jq() { if [ -f "$RUNNER_TEMP/jq" ]; then sh "$RUNNER_TEMP/jq" "$@"; else command jq "$@"; fi; }\n${script}`, s.base, s.head);

  test("a scan that exits 0 but logs ERR fails, a silent exit 0 passes", () => {
    const script = runOf(loadJob(), SCAN);
    const bad = stubbed(0, { stderr: "10:47PM ERR [git] fatal: Invalid revision range" });
    const good = stubbed(0, {});
    try {
      expect(withRt(bad)(script)).not.toBe(0);
      expect(withRt(good)(script)).toBe(0);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
      rmSync(good.dir, { recursive: true, force: true });
    }
  });

  test("the canary needs exit 1 and a finding: a fatal error or an empty report fails", () => {
    const script = runOf(loadJob(), CANARY);
    const cases: Array<[ReturnType<typeof stubbed>, "pass" | "fail"]> = [
      [stubbed(1, { report: '[{"RuleID":"generic-api-key"}]' }), "pass"],
      [stubbed(1, { stderr: "FTL unable to load gitleaks config" }), "fail"],
      [stubbed(1, { report: "[]" }), "fail"],
      [stubbed(0, { report: '[{"RuleID":"generic-api-key"}]' }), "fail"],
    ];
    try {
      for (const [s, outcome] of cases) {
        const rc = withRt(s)(script);
        if (outcome === "pass") expect(rc).toBe(0);
        else expect(rc).not.toBe(0);
      }
    } finally {
      for (const [s] of cases) rmSync(s.dir, { recursive: true, force: true });
    }
  });

  // Verified live against gitleaks 8.30.1: a redirected log carries ESC[31mERRESC[0m, which
  // `grep -qw ERR` does not match because the "m" before it is a word character. The stub writes
  // that exact form, so the test fails when the escape strip is removed.
  test("a scan that exits 0 but logs a coloured ERR fails", () => {
    const script = runOf(loadJob(), SCAN);
    const bad = stubbed(0, { stderr: "7:18AM \\033[31mERR\\033[0m \\033[1m[git] fatal: Invalid revision range\\033[0m" });
    try {
      expect(withRt(bad)(script)).not.toBe(0);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }
  });

  test("the job asks gitleaks for plain output", () => {
    expect(loadJob().env?.NO_COLOR).toBe("1");
  });
});

// `gitleaks git` reads `git log -p`, where a blob with a NUL byte in its first 8000 bytes prints as
// "Binary files differ" and carries no content, so a secret inside one was never scanned and the job
// passed (verified live on gitleaks 8.30.1: git mode exit 0, stdin mode exit 1 on the same blob).
// The binary step pipes each such blob through gitleaks stdin. Failing on any binary is rejected: a
// legitimate image must pass a clean scan.
describe("secret-scan reads binary blobs the diff scan skips", () => {
  const STEP = "Scan binary files the diff scan skips";

  // A stub that records stdin to `seen`, writes a finding when asked, and exits `code`.
  function withBinaryCommit(code: number, files: Record<string, string | Buffer>) {
    const s = scratch(0);
    const repo = join(s.dir, "repo");
    const seen = join(s.dir, "rt", "seen.bin");
    const fwd = (p: string) => p.replace(/\\/g, "/");
    writeFileSync(
      join(s.dir, "rt", "gitleaks"),
      [
        "#!/bin/sh",
        'while [ $# -gt 0 ]; do [ "$1" = --report-path ] && rp=$2; shift; done',
        `cat >> "${fwd(seen)}"`,
        `echo x >> "${fwd(seen)}.calls"`,
        code === 1 ? `printf '[{"RuleID":"generic-api-key"}]' > "$rp"` : "",
        `exit ${code}`,
      ].join("\n") + "\n",
    );
    const g = (...a: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
      return new TextDecoder().decode(r.stdout).trim();
    };
    // Git Bash ships no iconv. Where the real one is absent, a perl stand-in with the same
    // `iconv -f ENC -t UTF-8 FILE` contract, failing on a malformed or truncated sequence.
    if (!Bun.which("iconv")) {
      writeFileSync(
        join(s.dir, "rt", "iconv"),
        [
          "#!/bin/sh",
          `exec perl -MEncode -0777 -e 'binmode STDIN; binmode STDOUT; print encode("UTF-8", decode($ARGV[0], <STDIN>, Encode::FB_CROAK))' "$2" < "$5"`,
        ].join("\n") + "\n",
      );
      chmodSync(join(s.dir, "rt", "iconv"), 0o755);
    }
    for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
    g("add", "-A");
    g("commit", "-q", "-m", "add files");
    const head = g("rev-parse", "HEAD");
    const calls = () => (existsSync(seen + ".calls") ? readFileSync(seen + ".calls", "utf8").trim().split("\n").length : 0);
    return { ...s, head, seen, calls, runStep: () => s.run(runOf(loadJob(), STEP), s.base, head) };
  }
  const NUL = Buffer.from("x\0\napi_key = PLANTED\n");

  test("a NUL-containing file is handed to the scanner, a path with spaces included", () => {
    const t = withBinaryCommit(0, { "my blob.dat": NUL });
    try {
      expect(t.runStep()).toBe(0);
      expect(t.calls()).toBe(1);
      expect(readFileSync(t.seen)).toEqual(NUL);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a finding in a binary fails the step, and so does a scanner error", () => {
    for (const code of [1, 2]) {
      const t = withBinaryCommit(code, { "x.dat": NUL });
      try {
        expect(t.runStep()).not.toBe(0);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    }
  });

  test("a range with no binary file passes without invoking the scanner", () => {
    const t = withBinaryCommit(1, { "plain.txt": "hello\n" });
    try {
      expect(t.runStep()).toBe(0);
      expect(t.calls()).toBe(0);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  // UTF-16 text (Windows PowerShell 5.1 Out-File) is NUL-interleaved, so git lists it as binary and the
  // scanner's UTF-8 rules never match the raw bytes (verified live on gitleaks 8.30.1: raw exit 0,
  // transcoded exit 1). The step scans the raw blob and a UTF-8 transcoding. Bytes are built from
  // numeric code units, never from typed escape sequences.
  const PLANTED = `${["api_", "key"].join("")} = "k8Dj29xPq4Lm7Zt1Wv5Rn3Bc6Hy0Fa2SeQ9"\n`;
  function utf16(text: string, bigEndian: boolean, bom: boolean): Buffer {
    const bytes: number[] = bom ? (bigEndian ? [254, 255] : [255, 254]) : [];
    for (const ch of text) {
      const n = ch.charCodeAt(0);
      bytes.push(...(bigEndian ? [n >> 8, n & 255] : [n & 255, n >> 8]));
    }
    return Buffer.from(bytes);
  }

  for (const [label, be, bom] of [
    ["UTF-16LE with a BOM", false, true],
    ["UTF-16LE without a BOM", false, false],
    ["UTF-16BE with a BOM", true, true],
    ["UTF-16BE without a BOM", true, false],
  ] as const) {
    test(`${label} is scanned raw and as UTF-8`, () => {
      const raw = utf16(PLANTED, be, bom);
      const t = withBinaryCommit(0, { "ps.txt": raw });
      try {
        expect(t.runStep()).toBe(0);
        expect(t.calls()).toBe(2);
        const seen = readFileSync(t.seen);
        expect(seen.subarray(0, raw.length)).toEqual(raw);
        expect(seen.subarray(raw.length).toString("utf8").replace(/^﻿/, "")).toBe(PLANTED);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    });
  }

  test("UTF-16 that cannot be transcoded fails the step instead of passing unscanned", () => {
    const cut = Buffer.concat([utf16(PLANTED, false, true), Buffer.from([65])]);
    const t = withBinaryCommit(0, { "ps.txt": cut });
    try {
      expect(t.runStep()).not.toBe(0);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a NUL binary that is not UTF-16 is scanned once", () => {
    const t = withBinaryCommit(0, { "img.dat": Buffer.from([137, 80, 78, 71, 0, 0, 0, 13, 1, 2, 3, 4, 0, 0, 5, 6]) });
    try {
      expect(t.runStep()).toBe(0);
      expect(t.calls()).toBe(1);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("an unresolvable range fails the step", () => {
    const t = withBinaryCommit(0, { "x.dat": NUL });
    try {
      expect(t.run(runOf(loadJob(), STEP), BOGUS, t.head)).not.toBe(0);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("the step runs after the diff scan and is covered by the per-call flag count", () => {
    const names = loadJob().steps.map((s) => s.name);
    expect(names.indexOf(STEP)).toBeGreaterThan(names.indexOf("Scan the pull request's commits"));
    expect(names.indexOf(STEP)).toBeGreaterThan(names.indexOf("Scanner canary"));
  });
});

// `log --diff-filter=AM` drops a type change (T). A symlink replaced by a binary file prints as
// "Binary files /dev/null and b/x differ" in the diff scan and is listed by --numstat only when T is
// in the filter, so a secret inside such a file was read by neither scan (verified live on gitleaks
// 8.30.1: git mode exit 0, stdin mode exit 1 on the same blob).
describe("secret-scan reads a symlink replaced by a binary file", () => {
  const STEP = "Scan binary files the diff scan skips";

  test("the binary step's diff filter includes T", () => {
    expect(runOf(loadJob(), STEP)).toMatch(/--diff-filter=AMT\b/);
  });

  test("the replacement blob reaches the scanner", () => {
    const s = scratch(0);
    const repo = join(s.dir, "repo");
    const seen = join(s.dir, "rt", "seen.bin");
    try {
      writeFileSync(join(s.dir, "rt", "gitleaks"), `#!/bin/sh\ncat >> "${seen.replace(/\\/g, "/")}"\nexit 0\n`);
      const g = (input: string | null, ...a: string[]) => {
        const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
          cwd: repo,
          stdin: input === null ? undefined : Buffer.from(input),
          stdout: "pipe",
          stderr: "pipe",
        });
        if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
        return new TextDecoder().decode(r.stdout).trim();
      };
      // A blob in mode 120000 written straight to the index is a symlink without needing symlink privilege.
      const blob = g("target", "hash-object", "-w", "--stdin");
      g(null, "update-index", "--add", "--cacheinfo", `120000,${blob},x`);
      g(null, "commit", "-q", "-m", "add symlink");
      const base = g(null, "rev-parse", "HEAD");
      g(null, "rm", "-q", "--cached", "x");
      writeFileSync(join(repo, "x"), Buffer.from("x\0\napi_key = PLANTED\n"));
      g(null, "add", "x");
      g(null, "commit", "-q", "-m", "symlink becomes a binary file");
      const head = g(null, "rev-parse", "HEAD");
      expect(g(null, "log", "-1", "--name-status", "--format=", head)).toMatch(/^T\s+x$/);
      expect(s.run(runOf(loadJob(), STEP), base, head)).toBe(0);
      expect(readFileSync(seen).toString()).toContain("PLANTED");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
});
