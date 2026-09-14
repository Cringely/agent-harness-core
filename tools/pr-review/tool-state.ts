// Where the reviewer is running from. Every review body records the revision it ran from, and a
// posting run refuses when the checkout has uncommitted changes (pipeline.ts), so a posted review
// can be traced to the exact code that computed it.

import { join } from "node:path";
import { SHA_RE } from "./types";

export const REPO_ROOT = join(import.meta.dir, "..", "..");

// git ls-files -v tags every entry with a letter: uppercase for the normal states (H cached, S
// skip-worktree, M unmerged, R removed, C changed, K to-be-killed), lowercase for the
// assume-unchanged twin of whichever tag would otherwise apply. So any lowercase letter, or the
// uppercase S that has no assume-unchanged twin of its own, means the index is hiding a working-tree
// difference status --porcelain will never report (A8.5).
const HIDDEN_INDEX_TAG_RE = /^[a-zS]/;

// A git error fails closed on both fields: an unreadable revision throws, and a status or ls-files
// read that cannot be read counts as dirty.
// `root` is a test seam; cli.ts and the acceptance harness never pass it.
export function toolState(root: string = REPO_ROOT): { revision: string; dirty: boolean } {
  const rev = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const revision = rev.stdout.toString().trim();
  if (rev.exitCode !== 0 || !SHA_RE.test(revision)) throw new Error("the reviewer must run from a git checkout");

  // The whole working tree, untracked files included, not only tools/pr-review: a checkout carrying
  // anyone's uncommitted edits cannot post (coordinator ruling, 2026-09-11). --untracked-files=all
  // and --ignore-submodules=none override a repo or global status.showUntrackedFiles=no or a
  // submodule.*.ignore setting that would otherwise hide a real change from this check (A8.5).
  const status = Bun.spawnSync(
    ["git", "-C", root, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const statusDirty = status.exitCode !== 0 || status.stdout.toString().trim() !== "";

  // status --porcelain says nothing about a tracked file the index itself marks assume-unchanged or
  // skip-worktree: git treats those as unchanged by definition, so a real edit underneath one is
  // invisible to the check above (A8.5).
  const lsFiles = Bun.spawnSync(["git", "-C", root, "ls-files", "-v"], { stdout: "pipe", stderr: "pipe" });
  const hiddenIndexBits =
    lsFiles.exitCode !== 0 || lsFiles.stdout.toString().split(/\r?\n/).some((line) => HIDDEN_INDEX_TAG_RE.test(line));

  return { revision, dirty: statusDirty || hiddenIndexBits };
}
