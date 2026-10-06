// Install-Harness.ps1 registers the checkout it runs from in a per-user allowlist
// (~/.claude/harness-core-checkouts, issue #265). Several suites run the real installer, so
// without this every `bun test` would append the checkout path to the operator's real
// profile. Pointing the override at a throwaway file keeps the suite off the profile.
// Suites that assert on the allowlist set their own path per case.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_CORE_ALLOWLIST = join(
  mkdtempSync(join(tmpdir(), "harness-allowlist-")),
  "harness-core-checkouts",
);
