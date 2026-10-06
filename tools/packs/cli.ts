#!/usr/bin/env bun
// Pack generator command line (#254). The rules and the output shape live in packs.ts.
//
//   bun tools/packs/cli.ts            write packs/ and .claude-plugin/marketplace.json from packs.json
//   bun tools/packs/cli.ts --check    write nothing, list every divergence, exit 1 if there is one
//
// --root <dir> points either mode at another checkout. The tests use it on fixture repositories.
// Without it the root is the checkout this script lives in.
//
// Exit codes: 0 in sync or written, 1 drift found by --check, 2 refused or bad usage with nothing
// written. A refusal means packs.json or a member file broke a rule, and the message names which.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildPlan, checkTree, PackError, writePlan } from "./packs";

const USAGE = "usage: bun tools/packs/cli.ts [--check] [--root <dir>]";

export function main(argv: string[], defaultRoot: string): number {
  let check: boolean;
  let root: string;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { check: { type: "boolean" }, root: { type: "string" } },
      allowPositionals: false,
    });
    check = values.check === true;
    root = values.root ?? defaultRoot;
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  try {
    const plan = buildPlan(root);
    if (check) {
      const drift = checkTree(root, plan);
      if (drift.length === 0) {
        console.log(`packs in sync (${plan.size} generated files)`);
        return 0;
      }
      for (const d of drift) console.log(`${d.kind}: ${d.path}`);
      console.error("packs/ and the marketplace manifest are generated from packs.json. Run: bun tools/packs/cli.ts");
      return 1;
    }
    writePlan(root, plan);
    console.log(`wrote ${plan.size} files`);
    return 0;
  } catch (e) {
    if (!(e instanceof PackError)) throw e;
    console.error(`refused: ${e.message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), join(import.meta.dir, "..", "..")));
}
