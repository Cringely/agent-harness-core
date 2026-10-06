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
// An identifying string anywhere in the planned output (path or bytes) is a refusal in both modes,
// reported by class only. The sources are the PR reviewer's: the identity file, the claude CLI's
// account email, the workstation username and the hostname.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadIdentity, type IdentityLoad } from "../pr-review/identity";
import { buildPlan, checkTree, PackError, scanPlan, writePlan } from "./packs";

const USAGE = "usage: bun tools/packs/cli.ts [--check] [--root <dir>]";

export function main(argv: string[], defaultRoot: string, identityLoader: () => IdentityLoad = loadIdentity): number {
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
    const identity = identityLoader();
    if (!identity.ok) {
      console.error(`refused: ${identity.reason}`);
      return 2;
    }
    if (!identity.declared) {
      console.error("warning: ~/.claude-account-identity.json is absent, so only the username, the hostname and the claude CLI's account email are checked");
    }
    const found = scanPlan(plan, identity.decl);
    if (found.classes.length > 0) {
      console.error(
        `refused: identity gate: the generated payload carries identifying strings (${found.classes.join(", ")}). Matched values are not printed. Files: ${found.paths.join(", ")}`,
      );
      return 2;
    }
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
