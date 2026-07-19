# Durable Bidirectional Loop: Design

Date: 2026-07-19. Status: approved.

## Problem

The core-to-project improvement loop closed its first cycle with one consumer (spacemolt) and
only because a bespoke ceremony and a hand-run installer lined up. Audit output flags
legitimately forked files forever (alarm fatigue), equipped projects get no signal when core
updates, and the harvest trigger lives in spacemolt's ceremony ledger, which other projects
will not have.

## Decisions (with rejected alternatives)

- Trigger lives per-project, planted by the installer. Rejected: central scheduled sweep
  (needs a project inventory kept current, runs without session context) and a hybrid of both
  (most moving parts, justified only once dormant projects demonstrably rot).
- Legitimate forks are pinned, not ignored and not left noisy. An accepted-overlay entry
  records the fork's hash; audit stays silent while the hash holds and re-flags when the fork
  changes again. Rejected: plain ignore list (a later edit never resurfaces), leave-noisy
  (nine permanent warnings train readers to skim).
- The generic harvest is an auto-audit on session start that prints only when something needs
  attention. Rejected: staleness nudge (timestamp bookkeeping, nags without drift) and porting
  the full ceremony to every project (assumes ceremony machinery most projects will not run).
- Absorption into core stays a human-coordinated session. Rejected: auto-PRs from projects,
  which would skip the verify-the-claim step.

## Components

### 1. Manifest v2

Current manifest is a flat file-to-hash map. New shape:

```json
{
  "coreRepo": "E:\\projects\\agent-harness-core",
  "coreCommit": "23e529b",
  "files": { "agents/security-auditor.md": "2266..." },
  "accepted": { "hooks/lint-doc-prose.ts": "<project-fork-hash>" }
}
```

`coreRepo` lets hooks locate core without env vars. `coreCommit` records provenance at install
time. `files` carries what v1 carried. `accepted` maps a relative path to the hash of the
project's fork at the moment it was pinned. The installer migrates a v1 flat map to v2 on first
touch, preserving all hashes under `files`.

### 2. Installer additions (`install/Install-Harness.ps1`)

- `-Accept <relpath>`: pins the current project file's hash into `accepted`. Re-running it on
  an already-accepted file re-pins to the current hash (the post-review path for
  `overlay (changed)`). Fails loudly if the file does not exist or is tracked in `files`.
- `-Quiet` (audit only): print nothing when every file is in sync or an accepted overlay;
  print only attention lines otherwise. For hook consumption.
- Audit gains two statuses: `overlay (accepted)` (silent, excluded from the attention count)
  and `overlay (changed)` (attention: the fork moved since pinning, re-review it).
- Skip-modified warnings append a hint naming `-Accept` as the way to make a permanent
  overlay quiet.
- Pester coverage: `-Accept` happy path and error paths, v1-to-v2 migration, `-Quiet` output,
  both overlay statuses.

### 3. Drift-check SessionStart hook (the generic harvest)

New hook in core, installed into every equipped project. On session start:

1. Read `.claude/.harness-manifest.json`. Missing manifest: exit silent (the global
   unequipped-project reminder already covers that case).
2. Resolve `coreRepo`. Missing or unmounted (NAS down): exit silent. Never block or warn on
   an unreachable core.
3. Run the audit compare. Attention count zero: exit silent.
4. Otherwise print one summary line covering every attention status:
   `harness drift: N project-modified (promote?), M core-updated (re-run installer),
   K overlay-changed (re-review, re-pin with -Accept)`. Zero-count segments are omitted.

Spacemolt keeps its richer `core_harvest` ceremony alongside this; the ceremony also mines
decisions.md, which a hash compare cannot.

### 4. Promotion channel

- `.github/ISSUE_TEMPLATE/promotion.md` on the core repo with the sections the first four
  promotion issues already proved out: Source, Why it transfers, What needs genericizing.
- One new row in the guardrails template: when audit flags project-modified, file a promotion
  issue on core; never blind-edit installed copies.

### 5. Absorption flow (documentation only)

CONTRIBUTING.md documents the flow that worked on the first cycle: verify the issue's claims
against the actual files, genericize, commit to core, close issues with the commit hash,
re-run the installer in the consumer.

## Error handling

Every hook path degrades to silence: missing manifest, unreachable core repo, malformed
manifest JSON. A drift check must never break a session start. Installer actions that would
lose information (`-Accept` on a tracked file, migration over an unparseable manifest) fail
loudly instead.

## Rollout

1. Land manifest v2 + installer additions + hook + templates in core; Pester green.
2. Re-run installer on spacemolt; `-Accept` its nine known overlay files; confirm a session
   start there is silent.
3. Other projects pick the layer up through the existing unequipped-project reminder.

## Deliberately out of scope

Central sweep, CRLF-tolerant hashing (add only if a false project-modified actually bites),
cadence or timestamp bookkeeping, automating absorption.
