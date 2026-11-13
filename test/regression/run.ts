// Regression net runner (issue #96): `bun run regression`.
//
//   bun test/regression/run.ts            run every pinned test, report each defect caught or not
//   bun test/regression/run.ts --static   only check that every pinned file and test name exists
//   bun test/regression/run.ts --only ID  restrict to the named defect ids (repeatable)
//
// Exit 0 when every defect is caught. Exit 1 when any is not caught, or a pinned file or test name
// no longer exists. Exit 2 for a manifest that cannot be read or an unknown option or id.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, runNet, sourceDeclaresTest, testFilterPattern, type Defect, type Verdict } from "./net";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CHUNK = 2;
// Several pinned tests build git repositories and take 20 s alone against bun's 30 s per-test limit,
// so wide parallelism turns contention into false "not caught" results.
const PARALLEL = Math.max(1, Number(process.env.REGRESSION_PARALLEL) || 3);
const TIMEOUT_MS = 10 * 60 * 1000;

function usage(message: string): never {
  console.error(`regression: ${message}`);
  process.exit(2);
}

/** Runs one bun process for a few pinned tests of one file and returns its JUnit report. */
async function bunChunk(file: string, names: string[]): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "regression-net-"));
  try {
    const report = join(dir, "report.xml");
    const proc = Bun.spawn(
      [process.execPath, "test", file, "-t", testFilterPattern(names), "--reporter=junit", `--reporter-outfile=${report}`],
      { cwd: ROOT, stdout: "ignore", stderr: "ignore", timeout: TIMEOUT_MS },
    );
    await proc.exited;
    return readdirSync(dir).includes("report.xml") ? readFileSync(report, "utf8") : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Splits a file's tests into small chunks run concurrently, so the slow git-building tests overlap. */
function chunkedRunner() {
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (active >= PARALLEL) await new Promise<void>((go) => waiting.push(go));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return async (file: string, names: string[]): Promise<string | null> => {
    const parts: string[][] = [];
    for (let i = 0; i < names.length; i += CHUNK) parts.push(names.slice(i, i + CHUNK));
    const xml = await Promise.all(
      parts.map(async (part) => {
        await slot();
        try {
          return await bunChunk(file, part);
        } finally {
          release();
        }
      }),
    );
    // One report per file: join the chunks' testcases. A chunk with no report contributes nothing,
    // which leaves its tests "did not run".
    const bodies = xml.filter((x): x is string => x !== null);
    return bodies.length === 0 ? null : bodies.join("\n");
  };
}

function staticVerdicts(manifest: Defect[]): Verdict[] {
  return manifest.map((d) => {
    const reasons: string[] = [];
    for (const { file, name } of d.tests) {
      let source: string;
      try {
        source = readFileSync(join(ROOT, file), "utf8");
      } catch {
        reasons.push(`file not found: ${file}`);
        continue;
      }
      if (!sourceDeclaresTest(source, name)) reasons.push(`no test named "${name}" in ${file}`);
    }
    return { id: d.id, defect: d.defect, fixedBy: d.fixedBy, caught: reasons.length === 0, reasons };
  });
}

function report(verdicts: Verdict[], mode: string): number {
  for (const v of verdicts) {
    console.log(`${v.caught ? "CAUGHT    " : "NOT CAUGHT"}  ${v.id}  (${v.fixedBy})  ${v.defect}`);
    for (const reason of v.reasons) console.log(`            - ${reason}`);
  }
  const missed = verdicts.filter((v) => !v.caught);
  console.log("");
  console.log(`${verdicts.length - missed.length} of ${verdicts.length} known defects caught (${mode}).`);
  if (missed.length > 0) {
    console.log(`NOT CAUGHT: ${missed.map((v) => v.id).join(", ")}`);
    console.log("A harness change stopped catching a defect it used to catch, or a pinned test was renamed or removed.");
  }
  console.log("Green means these known defects stay caught. It does not mean the harness is sound.");
  return missed.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let staticOnly = false;
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--static") staticOnly = true;
    else if (args[i] === "--only" && args[i + 1]) only.push(args[++i]);
    else usage(`unknown option: ${args[i]}`);
  }

  let manifest: Defect[];
  try {
    manifest = parseManifest(readFileSync(join(HERE, "manifest.json"), "utf8"));
  } catch (error) {
    return usage((error as Error).message);
  }
  for (const id of only) if (!manifest.some((d) => d.id === id)) usage(`unknown defect id: ${id}`);
  if (only.length > 0) manifest = manifest.filter((d) => only.includes(d.id));

  if (staticOnly) return report(staticVerdicts(manifest), "static check, no tests run");
  const verdicts = await runNet({ manifest, root: ROOT, runBun: chunkedRunner() });
  return report(verdicts, "every pinned test run");
}

process.exit(await main());
