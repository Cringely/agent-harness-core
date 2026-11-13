// Regression net runner (issue #96): `bun run regression`.
//
//   bun test/regression/run.ts            run every pinned test, report each defect caught or not
//   bun test/regression/run.ts --static   only check that every pinned file and test name resolves, runs no test
//   bun test/regression/run.ts --only ID  restrict to the named defect ids (repeatable)
//
// Exit 0 when every defect is caught (--static: every pin resolves). Exit 1 when any is not, or a
// pinned file or test name no longer exists. Exit 2 for a manifest that cannot be read or an unknown
// option or id.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, renderReport, runNet, sourceDeclaresTest, testFilterPattern, type Defect, type Verdict } from "./net";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TIMEOUT_MS = 10 * 60 * 1000;

function usage(message: string): never {
  console.error(`regression: ${message}`);
  process.exit(2);
}

/** Runs one bun process for the pinned tests of one file and returns its JUnit report. */
async function bunFile(file: string, names: string[]): Promise<string | null> {
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
    return { id: d.id, defect: d.defect, fixedBy: d.fixedBy, verified: d.verified, caught: reasons.length === 0, reasons };
  });
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

  const verdicts = staticOnly ? staticVerdicts(manifest) : await runNet({ manifest, root: ROOT, runBun: bunFile });
  const { text, code } = renderReport(verdicts, staticOnly ? "static" : "run");
  console.log(text);
  return code;
}

process.exit(await main());
