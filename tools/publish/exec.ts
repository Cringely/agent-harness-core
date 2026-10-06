// The one place tools/publish starts another process (#274). Everything else goes through the
// Runner interface, so tests replace it with a scripted fake and never touch gh, git or a key.
//
// A child never inherits a GitHub token from this process's environment: childEnv drops every
// variable gh or git would read one from, and the caller adds back the token it chose for the
// configured account. That is what keeps the active gh account (a different identity on the
// operator's workstation) out of every call.
//
// runPiped moves the key command's stdout straight into the reviewer's stdin. The key passes
// through this process as a byte stream Bun forwards, and is never held in a variable here.

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  // The executable could not be started at all (not on PATH). Callers treat it as a missing
  // dependency and refuse.
  spawnError: boolean;
  // Killed for overrunning timeoutMs (runPiped: killed by any signal).
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface PipeSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface PipedResult {
  producerCode: number | null;
  producerSpawnError: boolean;
  consumer: RunResult;
}

export interface Runner {
  run(argv: readonly string[], options?: RunOptions): RunResult;
  runPiped(producer: PipeSpec, consumer: PipeSpec & { timeoutMs: number }): Promise<PipedResult>;
}

const TOKEN_VARS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

export function childEnv(base: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || TOKEN_VARS.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

const NOT_STARTED: RunResult = { code: null, stdout: "", stderr: "", spawnError: true, timedOut: false };

export const realRunner: Runner = {
  run(argv, options = {}) {
    try {
      const result = Bun.spawnSync([...argv], {
        cwd: options.cwd,
        env: options.env ?? childEnv(process.env),
        stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeoutMs,
      });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        spawnError: false,
        timedOut: result.exitedDueToTimeout === true,
      };
    } catch {
      // Bun throws "Executable not found in $PATH" rather than returning a code (measured on
      // Bun 1.3.14).
      return { ...NOT_STARTED };
    }
  },

  async runPiped(producer, consumer) {
    let producerProc: ReturnType<typeof Bun.spawn>;
    try {
      producerProc = Bun.spawn(producer.argv, { cwd: producer.cwd, env: producer.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    } catch {
      return { producerCode: null, producerSpawnError: true, consumer: { ...NOT_STARTED } };
    }
    let consumerProc: ReturnType<typeof Bun.spawn>;
    try {
      consumerProc = Bun.spawn(consumer.argv, {
        cwd: consumer.cwd,
        env: consumer.env,
        stdin: producerProc.stdout as ReadableStream<Uint8Array>,
        stdout: "pipe",
        stderr: "pipe",
        timeout: consumer.timeoutMs,
      });
    } catch {
      producerProc.kill();
      return { producerCode: await producerProc.exited, producerSpawnError: false, consumer: { ...NOT_STARTED } };
    }
    const [stdout, stderr, consumerCode] = await Promise.all([
      new Response(consumerProc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(consumerProc.stderr as ReadableStream<Uint8Array>).text(),
      consumerProc.exited,
    ]);
    // The consumer has exited or been killed at its timeout. A producer still running now, such as a
    // key command stalled on an authorization prompt, would hold this await open with no bound, so
    // it is killed here. One that already exited keeps its own exit code.
    producerProc.kill();
    const producerCode = await producerProc.exited;
    return {
      producerCode,
      producerSpawnError: false,
      consumer: { code: consumerCode, stdout, stderr, spawnError: false, timedOut: consumerProc.signalCode !== null },
    };
  },
};
