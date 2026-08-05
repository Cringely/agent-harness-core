# Core Backlog

Ordered work queue for `agent-harness-core`. Items are promotion candidates,
patterns to extract, or unresolved decisions surfaced during real sessions.
`soc-monitor` and `doc-steward` treat this file as the canonical backlog.

---

## 1. Promote agent-usage delegation stance into core (or a pattern doc)

**Status:** proposed. Promote on second recurrence, per `harness-core.md` findings flow.
**Surfaced:** 2026-08-04, TrueNAS HAOS zvol forensics session.

### What happened

Global `~/.claude/rules/agent-usage.md` carried two rules pulling in opposite
directions:

- **Reduce Noise** (delegate any 2+ call investigation sequence to a cheap agent).
- **SSH / Remote Work Note**, whose earlier wording said "prefer direct commands for
  remote host work," read as a blanket license to run long SSH forensic sweeps
  inline.

In a live session the second reading won by default and ~20 inline
`ssh … docker exec … | grep` / python probes ran in the main context instead of
being delegated. The operator flagged it: "I see you combing through ssh commands
yourself."

### Fix already applied (global only)

Reconciling edits to `~/.claude/rules/agent-usage.md`:

1. **Reduce Noise** extended to name remote/SSH sweeps explicitly. Log greps,
   `zfs`/`zpool` history, bundle extraction, and snapshot walks are the
   wall-of-output case. Added a self-check: if a `haiku` agent could run the exact
   command with no session-specific state, and output is bulky or it's call 2+ of a
   chain, it is not inline.
2. **SSH note** narrowed so inline remote applies only when the work depends on
   session-specific state the agent won't inherit (interactive login, env var,
   shell/cwd state). Self-contained remote investigation goes to a cheap agent.
   Explicitly records that the old "prefer direct commands" reading contradicted
   Reduce Noise and lost on the merits.

### Backlog decision

The rules files are not core-managed today (they live only in global
`~/.claude/rules/`; core references them via `guardrails.template.md` placeholders).
Decide whether this reconciliation should:

- (a) stay global-only, or
- (b) be captured in core as a delegation pattern doc under `patterns/`, or
- (c) be baked into `guardrails.template.md` so every installed project inherits the
  session-state-vs-delegate boundary.

An advisory Stop hook, `dispatch-audit.ts`, was since written to mechanize this rule; it installs
opt-in (not wired by `settings.hooks.json`; see its header for the registration snippet), which
partly answers (b)/(c) and narrows what's actually open to whether the installer should wire it in
by default, not whether a mechanism belongs in core at all.

Promote when a second project or session hits the same "inline remote sweep that
should have been delegated" failure class. First documented occurrence is this note.

---

## 2. Installer bun preflight check

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 adversarial review of `dispatch-audit.ts`.

`settings.hooks.json` invokes bare `bun` for every TypeScript hook. If `bun` is absent from PATH,
the hook command exits 127, which Claude Code treats as non-blocking, so dispatches proceed
ungated with no enforcement. This is a documented, reasoned fail-open contract (`README.md:29`,
`agent-worktree-gate.ts` header lines 44-49) and the failure is loud, a stderr hook-error notice
fires per dispatch, so a `Get-Command bun` warning in `install/Install-Harness.ps1` (about 3
lines) at install time is the proportional fix. Not a shim that hard-blocks; a preflight warning
only.

## 3. Two templates are never installed, and never referenced

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 adversarial review.

`core/claude/templates/agent-def-authoring.template.md`, `reviewer-lockout-protocol.template.md`,
and `untrusted-content-boundary.template.md` are copied by no installer path;
`install/Install-Harness.ps1` copies templates by explicit name only (`guardrails`,
`scratch.gitignore`, `ceremony-ledger`, `settings.hooks.json`). Open question: wire the three into
the installer, or move them out of `core/claude/templates/` since that path implies installation.
Harmless today, needs a decision.

The registration half of this is now a written constraint in `CONTRIBUTING.md` ("a new executable
artifact carries its registration in the same commit"), so this item is the cleanup of the instances
that predate the rule rather than an open question about whether the rule should exist.

`untrusted-content-boundary.template.md` is settled and no longer part of this item. Its rewritten
header states that the file is reference material for whoever edits the agent defs rather than an
installed artifact, and gives the reason: templates install by explicit name while agent defs install
as a directory glob, so a def pointing at this path would dangle in every installed project. The
block is inlined into the defs instead. Neither wiring nor moving it is correct, and the header is
the more specific statement. Scope this item to the other two templates.

---

## 4. Audit actuation: map each class to repair-or-report

**Status:** proposed.
**Surfaced:** 2026-08-04, SRS tenets pass (T3), from *Building Secure and Reliable Systems* ch 9.

`.harness-manifest.json` plus `Install-Harness.ps1 -Audit` is a working drift detector with a
three-way compare. The detection half is built well. The actuation half does not exist: `-Audit` is
report-only and writes nothing, and no code path invokes it, so the only mention outside the script
is in `README.md`.

Google's equivalent loop closes on repair rather than stopping at a list of deviations. The work
here: map every class the audit can report to an explicit response. Re-running the installer is a
safe repair for the classes that mean "core moved" or "never installed". The classes that mean a
project edited a tracked file must never be auto-repaired, since that discards the project's work.
The remaining classes need an owner rather than an action.

The cadence half is already in `CONTRIBUTING.md`, which now names when to run the audit. This
item is the class-to-action table, and it belongs next to the class list it annotates, inside
`Install-Harness.ps1`. Code change in a file this pass did not own.

---

## 5. Two silent-degradation sites

**Status:** proposed.
**Surfaced:** 2026-08-04, SRS tenets pass (T4).

A degraded path that emits well-formed-looking output is worse than one that errors, because nothing
downstream can tell degraded from normal. Both sites below are live:

- `core/claude/hooks/wave-close-handoff.sh`, in the best-effort block that begins after `set +e`: a
  failed `git` or `gh` query degrades to a blank section. A blank section is indistinguishable from
  "nothing to report", so a broken `gh` auth token produces a handoff that reads as a quiet week.
  Fix: emit an explicit `(query failed)` marker instead of nothing. Cheap.
- `session-start-guardrails.sh` against the 10,000-character hook-output cap: past the cap the
  platform swaps the content for a preview plus a file path, silently. Fix: have the hook measure its
  own output and print an explicit truncation line naming what it dropped, at a threshold it sets
  below the platform's.

The rule behind both now lives in `patterns/always-on-context-budget.md`, and the code changes that
would satisfy it sit in files this pass did not own.

---

## 6. Remediation in the worktree gate's deny payload

**Status:** proposed.
**Surfaced:** 2026-08-04, SRS tenets pass (T5).

The gate denies an unisolated write-agent dispatch without telling the caller how to comply. The
compensating instruction currently lives in the account-layer rules file, which spends a standing
line every session telling the operator that the denial is intended and to use isolation. That is
remediation text paying always-on rent for a message the deny payload could carry once, at the
moment it is relevant.

Put the corrected dispatch (`isolation: "worktree"`) in the deny JSON, then delete the rules line.
Unusually for this list, the change refunds standing budget rather than spending it, and it is the
clean worked example of trading a permanent rule for a just-in-time message. Code change in a file
this pass did not own, plus an edit to an account-layer file outside this repo.

---

## 7. Name the worktree gate's floor

**Status:** proposed.
**Surfaced:** 2026-08-04, SRS tenets pass (T1).

`patterns/fail-contract.md` describes the pattern: write one floor sentence, derive both fail paths
from it, and treat every case neither path reaches as a hole with an owner. The gate that motivated
the pattern has not had the pattern applied to it. Its header documents both tiers without stating
the floor they come from.

The runtime-absent case is not the gap here, and an earlier draft of this item wrongly said it was.
That case is documented in the hook header's fail-open paragraph, in `README.md` under install
prerequisites, and in item 2 above, and commit 11f9463 records the decision with its reason: a shim
that hard-blocks on a missing interpreter would invert a documented fail-open contract for a failure
that surfaces on the first dispatch. Nothing about it is open.

What is open is one sentence. Four places describe the behavior correctly and none states the
invariant they derive from, so their agreement with each other is checkable only by reading all four.
Write the floor into the hook header and the existing descriptions become consequences of it rather
than four independent assertions. Item 2 stays the installer warning and is unaffected by this one.

---

## 8. Does doc-steward's Bash grant need to be permanent

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 review.

`doc-steward` is `model: haiku` with `tools: Read, Edit, Write, Grep, Glob, Bash`. Its trailer names
commit messages, PR descriptions, and issue comments as inputs, all of which are attacker-influenced
text in any repo taking outside contributions. Adding Bash widens what a successful injection through
those inputs can reach, on the least capable model in the roster, and the mitigation today is
instruction-level only.

Deferred rather than reverted, for two reasons. The def already held Write and Edit, so the worktree
gate forces isolation on it regardless of the Bash grant, which bounds the blast radius to a
throwaway checkout. And both checklist items the grant serves are conditional, so the tool is unused
on most dispatches.

The open question is narrow: does the grant need to be permanent, or can it move behind the condition
that needs it. Revisit if doc-steward is ever dispatched somewhere the gate does not cover, or if a
non-conditional checklist item starts depending on Bash.

---

## 9. The denial-test gate is unsatisfiable for most hooks

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 review of the `CONTRIBUTING.md` constraint added in the same wave.

`CONTRIBUTING.md` now requires a test asserting a DENY on a boundary-crossing input for anything
added under `core/claude/hooks/`. Written that way the rule covers every hook, and most hooks cannot
satisfy it. Only `agent-worktree-gate.ts` and `agent-write-scope.ts` emit a `permissionDecision` of
`deny`. The rest state in their own headers that they never block, `pre-commit` most explicitly
("unconditional exit 0, advisory only"), so there is no denial for a test to assert.

Deferrable because nothing triggers it until someone adds another hook, and the two that can refuse
both have the test. Fix when triggered: scope the subject to hooks that can refuse rather than to the
directory, and carry the same escape hatch the registration constraint one paragraph above already
has, so an advisory hook satisfies the rule by saying in its header that it never denies.

This is the constraint's own author writing the correction, which is the argument for the constraint
being reviewed by someone else before it binds.

---

## 10. memory-transition-log.ts has no backlog entry naming who wires it

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 review.

The escape hatch in `CONTRIBUTING.md` lets a change land an artifact deliberately unwired on three
conditions: the header says it is unwired, the header carries the registration snippet, and a backlog
item names who wires it. `core/claude/hooks/memory-transition-log.ts` meets the first two. Its header
opens with "OPT-IN. Not referenced by settings.hooks.json or any project's settings.json; an operator
wires it deliberately", carries the exact JSON block to paste, and explains why registration belongs
at user level rather than per project.

The third condition has no entry, and this item is it. The hook is inert in every installed project
until an operator acts, which is the intended design rather than a defect. What was missing is
anything in the queue that would surface that fact to someone who never opens the file. Resolve by
deciding whether the installer should prompt for user-level registration or whether opt-in-and-silent
is the final answer, then record the decision here.

---

## 11. Restore "already owns" to the canonical untrusted-content block

**Status:** proposed.
**Surfaced:** 2026-08-04, wave-2 fix to the untrusted-input drift.

The canonical block's authority sentence ends "trusted repository configuration this project owns
(its guardrails file, its settings)". The pre-wave template read "already owns", and the word was
dropped when three sections were compressed into the single block.

The word carries the whole distinction. "Configuration this project owns" reads as including
configuration the diff in front of you proposes, so a hunk that narrows a reviewer's scope or grants
itself an exemption arrives wearing the authority the sentence just conferred. "Already owns" scopes
authority to configuration that predates the change, which leaves anything the diff introduces as
material under review.

The completed fix restores the distinction in the per-agent trailers of `task-reviewer` and
`adversarial-reviewer`, the two seats where it bites today, and leaves the shared block as it stands.
The remaining exposure is a future def that reviews configuration and relies on the block without a
trailer of its own. Three defs carry the block with no such trailer today, and none of them reviews
configuration, so nothing is currently wrong.

Deferred for a stated reason rather than an omission: the block appears byte for byte in five defs
plus the template's fenced copy, and editing it means a coordinated six-file change plus a
re-verified hash. Current value is `d253ec44cf927e5773c8ca9993879164`, confirmed identical across all
six while writing this entry.

Trigger: any new def whose job includes reviewing configuration.

One dependency. Six inlined copies with no mechanical check will drift again, and a
coordinated six-file edit is precisely the operation that breaks byte identity without anything
noticing. Sequence the drift test ahead of this item and the edit becomes safe to make; do this one
first and it is the same hand-verification that let the word go missing in the first place.
