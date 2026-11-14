// A scripted Runner for the tools/publish suites (#274). Not a test file itself (bun test only
// collects *.test.ts). Each responder sees one call's argv and returns a result, or undefined to
// pass. An unanswered call fails with exit 1, so a test never reaches a real gh, git or key.

import type { PipedResult, PipeSpec, RunOptions, RunResult, Runner } from "../tools/publish/exec";

export type Responder = (argv: readonly string[], options: RunOptions) => Partial<RunResult> | undefined;

export const REPO = "fixture-owner/fixture-repo";
export const HEAD = "a".repeat(40);
export const BASE_HEAD = "b".repeat(40);

// Answers any call whose argv starts with the given prefix.
export function on(prefix: readonly string[], result: Partial<RunResult>): Responder {
  return (argv) => (prefix.every((part, i) => argv[i] === part) ? result : undefined);
}

export const NOT_FOUND: Partial<RunResult> = { code: 1, stderr: "gh: Not Found (HTTP 404)" };

export class FakeRunner implements Runner {
  readonly calls: { argv: string[]; options: RunOptions }[] = [];
  readonly piped: { producer: PipeSpec; consumer: PipeSpec & { timeoutMs: number } }[] = [];

  constructor(
    private readonly responders: Responder[],
    // What runPiped answers: the key command's exit code and the reviewer's result. Tests set it.
    public pipedResult: PipedResult = {
      producerCode: 0,
      producerSpawnError: false,
      consumer: { code: 1, stdout: "", stderr: "", spawnError: false, timedOut: false },
    },
  ) {}

  run(argv: readonly string[], options: RunOptions = {}): RunResult {
    this.calls.push({ argv: [...argv], options });
    for (const responder of this.responders) {
      const hit = responder(argv, options);
      if (hit !== undefined) return { code: 0, stdout: "", stderr: "", spawnError: false, timedOut: false, ...hit };
    }
    return { code: 1, stdout: "", stderr: "unscripted call", spawnError: false, timedOut: false };
  }

  async runPiped(producer: PipeSpec, consumer: PipeSpec & { timeoutMs: number }): Promise<PipedResult> {
    this.piped.push({ producer, consumer });
    return this.pipedResult;
  }

  // gh calls that publish or change something on GitHub.
  publishing(): string[][] {
    return this.calls
      .map((call) => call.argv)
      .filter((argv) => argv[0] === "gh" && (argv[1] === "issue" || argv[1] === "pr") && ["create", "edit", "merge", "comment"].includes(argv[2] ?? ""));
  }
}

// The read-side gh answers a healthy repository gives: a token, a default branch "main", both
// branches present, and no templates anywhere.
export function healthyRepo(): Responder[] {
  return [
    on(["gh", "auth", "token", "-u", "fixture-owner"], { stdout: "fake-token\n" }),
    on(["gh", "api", `repos/${REPO}`, "--jq", ".default_branch"], { stdout: "main\n" }),
    on(["gh", "api", `repos/${REPO}/branches/main`], { stdout: `${BASE_HEAD}\n` }),
    on(["gh", "api", `repos/${REPO}/branches/feat/x`], { stdout: `${HEAD}\n` }),
    (argv) => (argv[0] === "gh" && argv[1] === "api" && String(argv[2] ?? "").startsWith(`repos/${REPO}/contents`) ? NOT_FOUND : undefined),
    (argv) =>
      argv[0] === "gh" && argv[1] === "api" && argv[2] === "-H" && String(argv[4] ?? "").startsWith(`repos/${REPO}/contents`) ? NOT_FOUND : undefined,
  ];
}
