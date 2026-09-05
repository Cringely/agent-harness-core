# Core Backlog

Ordered work queue for `agent-harness-core`. Items are promotion candidates,
patterns to extract, or unresolved decisions surfaced during real sessions.
`soc-monitor` and `doc-steward` treat this file as the canonical backlog.

---

## 1. Promote agent-usage delegation stance into core (or a pattern doc)

**Status:** proposed. Promote on second recurrence, per `harness-core.md` findings flow.
**Surfaced:** 2026-08-04, TrueNAS HAOS zvol forensics session.
**Premises corrected 2026-09-05.** Two statements below went false with `7b1497e`. Core does now
keep a canonical copy of the account rules: `account/claude/rules/` holds all eleven as tracked
content, `agent-usage.md` among them. And `install/` does have an exporter,
`install/Export-Account.ps1`, registered at `README.md:116-125`; the "assembled by hand" claim is
now true only of the three-directory bundle `Restore-ClaudeProject.ps1` consumes, a different
artifact. This opens a fourth option the item does not list: put the reconciliation in the payload,
which `Install-Account.ps1` already distributes. The item's own recurrence bar is unaffected.

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

One premise in that framing is wrong, and it has been re-derived more than once. Core does have an
account-scope write path. In its global-config step, `install/Restore-ClaudeProject.ps1` copies
`claude-global/rules`, `agents`, `skills`, `plugins`, and `tools` out of an export bundle into
`<ClaudeHome>/<dir>`, and the step after it writes `<ClaudeHome>/settings.json`. Only the `hooks`
entry and the settings rewrite sit behind `-IncludeHooks`; the rules copy runs on a bare
invocation, against the real `~/.claude` unless `-ClaudeHome` redirects it. The step before it
moves sessions and memory notes into `<ClaudeHome>/projects/<slug>`, also on a bare invocation.
`install/Restore-ClaudeProject.Tests.ps1` now asserts the rules copy, in the case named "restores
account-layer rules into ClaudeHome even without -IncludeHooks". It is a test rather than a fourth
prose citation because an assertion keeps tracking the behavior through a refactor that moves the
code, and a line number stops being true at that moment without saying so.

What that path does not do is make core the owner of the rules files. It moves an account layer
between machines, from a bundle the operator exported, and core keeps no canonical copy of its
own. `Install-Harness.ps1` reads the account layer in three places, recording detected plugins,
output styles, and MCP servers into the manifest's `stackDetected`, and writes nothing to it. The
other half of the move is manual too: `install/` holds the restore script and no exporter, so the
bundle it reads gets assembled by hand. So (a), (b), and (c) all stay open. What changes is which
argument is available against them. "Core cannot reach the account layer" is false and should not
be used again. Ownership and update cadence are the real grounds.

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

**Status:** closed 2026-09-05. The class-to-action mapping this item asks for is at
`Install-Harness.ps1:602-609`, added by `8577ae4`, printed in the audit output and commented
against `CONTRIBUTING.md`'s drift gate. Two premises below are false as written. `-Audit` is
invoked, by `core/claude/hooks/session-start-drift-check.sh:114`, which is wired on `SessionStart`
in `core/claude/templates/settings.hooks.json`. And it is named outside the script, at
`CONTRIBUTING.md:45`.
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

**Status:** half closed 2026-09-05. The deny payload already carries the corrected dispatch, at
`core/claude/hooks/agent-worktree-gate.ts:224`, including the auto-clean note and the `remote`
alternative, and has since before the account-layer work. So the first sentence below is false as
written. What stays open is deleting the compensating line from the rules file, now at
`~/.claude/rules/harness-core.md:19` and also committed into the payload at
`account/claude/rules/harness-core.md:19`. That second copy is new, so closing this item now means
editing the live tree and re-exporting rather than a one-line deletion.
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

---

## 12. Failures that do not propagate: pipefail, and the installer's unchecked git write

**Status:** partially fixed. Both PowerShell sites are closed; the shell hooks remain open. The
diagnosis below is a record of what the audit found, written in past tense; the current state is at
the end of the item.
**File list corrected 2026-09-05.** The item names two shell hooks. There is a third:
`core/claude/hooks/session-start-drift-check.sh:29` sets the same `set -eu` without `-o pipefail`,
and it carries the repo's only real shell pipeline, at `:124`. The item's "no live instance"
verdict survives, because that pipeline is terminal and nothing chains off it, but the file list
does not.
**Surfaced:** 2026-08-04, wave-2 review. Audit of `install/` and the shell hooks run while writing
`patterns/ablation-verification.md`'s empty-check section.

A gate that cannot fail is worse than no gate, because it reports success. Two mechanisms produce
this, one per language in the repo. The audit found the shell side clean and the PowerShell side
carrying two live instances, one of which took a second pass to spot.

**Shell: no live instance, one latent gap.** A pipeline's exit status is its last command's, so
`suite | tail && next-action` runs `next-action` whatever the suite did. Verified directly:
`false | tail -3 && echo PROCEEDED` prints PROCEEDED, and the same line under `set -o pipefail`
does not. No script in this repo currently chains a command through a pipeline into a subsequent
action. The only shell pipelines in the hooks sit inside `--jq` argument strings, where the pipe
belongs to jq rather than the shell. Pipe characters themselves are common, since `||` appears
throughout `pre-commit`, `wave-close-handoff.sh`, and `session-start-guardrails.sh`; none of those
is a pipeline. What is missing is the guard for later: both
`session-start-guardrails.sh` and `wave-close-handoff.sh` set `-eu` without `-o pipefail`, and
`set -e` does not catch a pipeline whose last command succeeds. Adding `-o pipefail` to both costs
one word each and closes the gap before a pipeline exists to fall through it. `pre-commit` is
outside this: it declines to gate on purpose, says so in its header, and its `exit 0` is the
documented decision rather than an accident.

**PowerShell: what the audit found.** `$ErrorActionPreference = 'Stop'` does not stop on a native
command's non-zero exit, which is the trap that looks most like the shell one and is easier to miss
because the script reads as if it were guarded. Verified: a native call exiting 3 under
`'Stop'` left `$LASTEXITCODE` at 3 and execution continued to the next statement.
`install/Install-Harness.ps1` already knew this in two places and checked `$LASTEXITCODE` after its
`rev-parse` and `config --get` probes. The `git config core.hooksPath` write in the hooks-wiring
block had no such check, and the statement immediately after it recorded `git:core.hooksPath` with
an action of "set to ..." into the results table the installer prints, so a failing write was
reported to the operator as a completed one. That is the same class as a commit made behind a test
gate that could not fail, and it was the item's actual defect rather than its motivating analogy.

**The full sweep, so the coverage is legible.** `install/Install-Harness.ps1` makes four native
command invocations and no others. `rev-parse --git-dir` and `config --get core.hooksPath` check
`$LASTEXITCODE` on the line after the call. `config core.hooksPath` now does too. The fourth is
`& chmod +x` on the copied `pre-commit` hook, guarded by a non-Windows check and a `Test-Path`,
and it is now checked as well. Its failure mode was the quietest of the four: the hook file landed,
the results table said `installed` and nothing further, and git declines to run a hook without the
executable bit, so the operator got a pre-commit hook that existed and never fired. That table now
prints a `chmod:hooks/pre-commit` FAILED row next to the `installed` one whenever the chmod fails.

The "low likelihood" reasoning an earlier draft of this item used for that site was wrong.
Filesystems without POSIX permission bits are the real trigger and they are ordinary on this
operator's machines: CIFS and SMB shares, exFAT volumes, and WSL DrvFs mounted without `metadata`.
A checkout owned by a different uid does it as well. The installer having just written the file does
not help, because on those mounts no process can set the bit. A reviewer demonstrated it rather than
reasoning about it, shimming a failing `chmod` onto PATH and getting `INSTALLER_EXIT=0`, a
`hooks/pre-commit  installed` row, and a `-rw-r--r--` file.

**Current state.** Both PowerShell sites are fixed. `git config core.hooksPath` checks
`$LASTEXITCODE` and prints `FAILED (git exit N) - hook not wired` instead of `set to ...`. The
`chmod` call checks it too and adds a `chmod:hooks/pre-commit` failure row. Four tests cover the
pair in `install/Install-Harness.Tests.ps1`: the two failure paths, a success-path check that the
reported `core.hooksPath` row agrees with what git actually stores, and an assertion that the
installed hook carries the owner execute bit. That last one exists because the failure tests alone
passed with the `chmod` retargeted at the hooks directory instead of the hook file, a mutation that
leaves the file at 0644 and reports nothing wrong. All four were ablated.

Remaining: `-o pipefail` in `session-start-guardrails.sh` and `wave-close-handoff.sh`.

Worth pairing with item 9. Both are cases where the check written to enforce a rule cannot enforce
it, and neither would be caught by reading the surrounding prose, which describes the intended
behavior accurately in both cases.

---

## 13. Account rules against the installed set: the coverage table

**Status:** proposed. The table is the deliverable issue #21 asked for; what to do about the rows
is the open part.
**Surfaced:** 2026-08-12, answering the final section of issue #21, which asked for a full
comparison of the account-level process rules against what the installer copies, to establish
whether the two gaps that issue found were unusual or ordinary.

They are ordinary, and one structural fact explains more of the table than a separate omission per
row would: the installed set is smaller than core. Every account rule carrying a real process claim
is at least partly present in an installed project; most are partly present rather than fully, and
only one is absent outright.

`install/Install-Harness.ps1` copies `core/claude/agents/*` and `core/claude/hooks/*` (minus the
two ceremony-gated files), the guardrails template as `.claude/guardrails.md`, the scratch drop
box's `.gitignore`, optionally `ceremony-ledger.json`, and merges `settings.hooks.json` into the
project's `settings.json`. It copies `patterns/` nowhere; the string does not appear in the
installer at all. That matters because `patterns/` is where core keeps its process reasoning. A
pattern doc answers a gap for whoever opens this repository and answers nothing for a project that
only ran the installer. Issue #21 read "in core" and "installed" as one question, so its two gaps
looked like two omissions instead of one boundary.

Rows below name the account file at `~/.claude/rules/`. "Installed" means reachable from a project
that ran the installer and nothing else.

| Account rule | Carried by the installed set | Verdict |
|---|---|---|
| `agent-usage.md` | `hooks/model-tier-gate.ts`, wired, plus `guardrails.md`'s model-tier and independent-review rows; `hooks/agent-worktree-gate.ts` and `hooks/agent-write-scope.ts`, both wired; `hooks/dispatch-audit.ts` and `hooks/review-gate.ts`, installed opt-in | partial, item 1 owns the rest |
| `challenge-mandate.md` | `guardrails.md` worked row, prose plus adversarial-reviewer as its mechanical twin | covered |
| `change-management.md` | nothing installed; invariant promotion lives in `patterns/forcing-functions.md` | gap (#21 Gap 1) |
| `fix-quality.md` | `agents/task-reviewer.md` carries producer-side and invariant language | partial, no action proposed |
| `harness-core.md` | not applicable, it points at this repository | account-only by construction |
| `no-overclaim.md` | `agents/task-reviewer.md`; the argument sits in `patterns/ablation-verification.md` | partial, no mechanism |
| `obsidian.md` | not applicable, names a machine's sync hook and vault path | account-only by construction |
| `security.md` | untrusted-content boundary block, inlined in the installed agent defs | partial by design |
| `ssh.md` | not applicable, machine and host configuration | account-only by construction |
| `subagent-prompting.md` | the sonnet effort mandate, through `model-tier-gate.ts` and `guardrails.md`; brief anatomy, nothing | partial, gap on brief anatomy |
| `writing-style.md` | `hooks/lint-doc-prose.ts` and `hooks/pre-commit`, both installed and wired | covered, with a caveat |

Four rows need a clause the table cannot hold.

**`agent-usage.md`.** Most of what this file says about a single dispatch installs, and what it
says about how a session is run does not. Model-tier discipline arrives as a gate:
`model-tier-gate.ts` is copied like every other hook, wired by `settings.hooks.json` on
`Agent|Task|Workflow`, and denies both a dispatch that names no tier and a `sonnet` dispatch
missing `effort: "xhigh"`. The guardrails template carries the same rule as prose in its worked-row
table, so the project gets the reasoning next to the gate. Review-is-delegated arrives twice over,
as another worked row and as `review-gate.ts`, which installs but stays unwired by its own header's
decision. Write-is-delegated arrives as `dispatch-audit.ts`, opt-in on the same terms. The scratch
return channel arrives as infrastructure rather than as a rule: the installer creates the drop box
and `agent-write-scope.ts` confines a `writeScope: scratch` agent to it, but nothing requires a
brief to name a return path. What reaches an installed project through nothing at all is the
call-count threshold that decides whether to delegate in the first place. That is the piece item 1
already owns, and it is a stance about a whole session rather than a property of one dispatch a
`PreToolUse` hook can read.

**`change-management.md`.** Its invariant-promotion half is written up in
`patterns/forcing-functions.md`, so #21's Gap 1 is answered for a reader of this repository and
still open for an installed project. The rest of that file, risky-operation confirmations, backup
gates, commit identity, is homelab operations, and `CONTRIBUTING.md`'s process-versus-domain test
excludes it from core on purpose.

**`subagent-prompting.md`.** One of its resident traps installs and the rest does not. The effort
mandate is enforced by `model-tier-gate.ts` and stated in the guardrails row beside it, so a
project that ran the installer cannot dispatch a sonnet agent at inherited effort without being
told. The other half of that trap, that the frontmatter key is `effort` and a misspelling is
ignored without error, is checked by `test/agent-frontmatter-keys.test.ts`, which guards this
repository's own defs and installs nowhere. Brief anatomy is the real gap:
`patterns/agent-def-shape.md` covers part of it and does not install, and
`core/claude/templates/agent-def-authoring.template.md` covers more of it and is copied by no
installer path, which is item 3.

**`writing-style.md`.** The best-covered rule, and the caveat is worth reading before treating it
as a model. Both hooks resolve a Vale configuration, the project's own
`.claude/tools/prose-lint/.vale.ini` first and then the kit under the user's home;
`lint-doc-prose.ts` also honors an explicit `PROSE_LINT_VALE_CONFIG` ahead of both, which
`pre-commit` deliberately does not. The installer copies no `tools/prose-lint`. On a machine without the
account-layer kit, both hooks find no configuration and skip, advisory by design and easy to miss.
The mechanism installs; the data it needs does not.

### The requirement issue #21 called Gap 2

Spec-and-plan-before-development is absent from the table because it is absent from the account
rules too, so it is not a portability gap. It is an unwritten requirement everywhere. State it as a
claim about artifacts and it survives any later change to the tooling:

> Development work begins with a brainstorm, produces a written spec, and proceeds from a written
> plan. The spec and the plan exist as artifacts before implementation starts.

Written that way it holds on a machine with no plugins at all, where the same two artifacts get
written by hand. Where the superpowers plugin is present, its `brainstorming` and `writing-plans`
skills are the vehicle for the first two steps and `subagent-driven-development` for executing the
result. `guardrails.template.md` already lists superpowers under its assumed stack and warns that
an assumed skill may simply be absent, so a project must not read the vehicle as the requirement.
The nearest existing rule, `agent-usage.md`'s "Plan Execution Is Always Subagent-Driven", governs
how a plan gets executed and never requires one to exist.

### What is open

The table is a finding, not a decision. Three questions follow from it, and none should be answered
by adding prose:

- Does `patterns/` become installable, or does core accept that its process reasoning is
  repository-only and stop citing pattern docs as though a project could read them?
- Do the two clear gaps, `change-management.md`'s promotion lifecycle and
  `subagent-prompting.md`'s brief anatomy, graduate on this evidence, or wait for the second
  project named in `CONTRIBUTING.md`? That question is already blocked behind the graduation-bar
  decision note.
- Does the spec-and-plan requirement belong in `guardrails.template.md`, which every installed
  project receives, or does it stay an account-layer convention that this table has now shown to
  be the same shape as the gaps it was filed alongside?

---

## 14. NotebookLM as a corpus-bounded knowledge agent

**Status:** assessed 2026-09-05. **Recommendation: none of the four candidates gets wired to the
operator's Google account.** The assessment ran the six questions below against all four unpacked
tarballs, statically, nothing executed. Report at
`.superpowers/sdd/2026-09-03-account-layer-portability/nb-mcp-assessment.md`.

Every candidate authenticates by driving a browser through a human Google login and keeping the
resulting account-level session cookies (`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`,
`__Secure-1PSID`). None uses OAuth. None produces a grant scoped to the product or revocable
without signing the operator's Google account out everywhere. That is the condition this item named
in advance as disqualifying, and it is met by all four. `@roomi-fields/notebooklm-mcp` also stores
the account password and TOTP seed for unattended re-login.

Three of the four also carry a local-file read path into the same home directory that holds
`~/.claude`. `notebooklm-mcp-server` resolves any caller-supplied path and uploads `.md` content to
Google, which reaches every rules file, agent definition and memory note in one tool call.
`@pan-sec/notebooklm-mcp` defaults its allowlist to `os.homedir()` and omits `.claude` from its
denied segments. So a prompt injection in an ingested source would have both a credential worth
stealing and material worth stealing, on one machine.

**Correction to this item's own preliminary result.** The paragraph below stating that none of the
five declares a `preinstall` or `postinstall` script is false, and it was relayed to the reviewer as
settled rather than re-measured. Verified against each `package.json`: four declare `prepare`, which
does not run for a published registry tarball and is inert; `notebooklm-mcp-server@4.0.2` declares
`"postinstall": "npx playwright install chromium"`, which runs on every install and is both
install-time code execution and install-time egress. Nothing executed during the assessment, because
the fetch used `npm pack` and never `npm install`. The safety came from the procedure, not from
the premise.

**If the capability is still wanted,** one shape is defensible: a Google account used for nothing
else with the notebook shared to it, `@charlie.act7/gemini-notebook-mcp` pinned to `2.3.11` and
never `@latest`, stdio transport only, a data directory outside `%APPDATA%`, project-scoped rather
than user-scoped, and every answer treated as untrusted input. Charlie is the pick on containment
and provenance (the only candidate with SLSA provenance and OIDC publishing, no local-file read
path, and an HTTP transport that refuses an unauthenticated off-localhost bind), not on
authentication, where it is no better than the rest. Rehearse the revocation first, because there is
no per-app revoke and there will not be one. Three of the four, charlie included, depend on
`patchright`, an anti-bot-detection Playwright fork from a pseudonymous maintainer, which is a terms
question on top of a security one.

**Surfaced:** 2026-09-03, operator request during the account-layer portability session.

### The idea

Use a NotebookLM notebook as a narrow, high-trust oracle for one knowledge domain at a time: load
a curated corpus, then interrogate it from a session instead of searching the open web or building
a retrieval layer. The property worth having is that answers stay inside the corpus and cite the
passage they came from, which places them at the vendored-reference tier of `no-overclaim.md`'s
evidence hierarchy rather than the assumption tier where an unsourced model answer sits.

### What already exists here

A `notebooklm` MCP server is configured at the `C:/Users/user` project scope in `~/.claude.json`:
`npx notebooklm-mcp@latest` over stdio, empty `env`. It is not active in this repository's
sessions, and nothing in this repo references it.

It is also broken. Google renamed the product to Gemini Notebook, and the configured package has
not been republished since. Measured against the npm registry on 2026-09-03: `notebooklm-mcp` is
at 2.0.0, last modified 2026-05-01, repository `PleasePrompto/notebooklm-mcp`. Because the entry
resolves `@latest` rather than a pin, the breakage arrived without a config change, which is the
failure mode `security.md`'s pinning rule exists to prevent.

### Replacement candidates, measured not endorsed

Four packages published after the rename. None has been run, and the table records provenance
only.

| Package | Version | Published | Repository |
|---|---|---|---|
| `@charlie.act7/gemini-notebook-mcp` | 2.3.11 | 2026-08-20 | `CharlieCardenasToledo/gemini-notebook-mcp` |
| `@pan-sec/notebooklm-mcp` | 2026.5.0 | 2026-08-29 | `Pantheon-Security/notebooklm-mcp-secure` |
| `notebooklm-mcp-server` | 4.0.2 | 2026-08-22 | `moodRobotics/notebooklm-mcp-server` |
| `@roomi-fields/notebooklm-mcp` | 3.1.2 | 2026-08-21 | `roomi-fields/notebooklm-mcp` |

The first is the closest match by description, which reads almost word for word like the
configured package's and names the rename directly, so it is probably a fork. Its repository owner
differs from `PleasePrompto`, so it is a fork or a reimplementation rather than a maintainer
handover, and that distinction matters when the package holds a Google session.

Every one of them is MIT, single-maintainer, published under a personal email address, and
unofficial. Swapping one for another fixes the breakage and leaves the shape unchanged: an
unreviewed dependency brokering an authenticated Google account. `security.md`'s supply-chain
section rules against exactly this, so the replacement gets a security review and a version pin
before it is wired anywhere, and the review decides the choice rather than the version number
deciding it. `appsec-sme` is the right reviewer.

### What the assessment has to cover

An assessment with no stated criteria gets rubber-stamped, so these are the questions, and the
first one governs the rest.

- **Authentication.** OAuth with a scoped grant, or a full Google session cookie lifted from a
  browser profile, or a headless browser driving the product interface. This decides whether the
  access can be scoped and revoked independently of the operator's whole Google account.
- **Credential storage.** Where on disk, under what permissions, in plaintext or not, and whether
  a second account is kept beside the first. `@roomi-fields/notebooklm-mcp` is the one to read
  first here: it ships `setup-auth`, `de-auth` and `accounts` CLI entry points, so it clearly
  stores credentials and manages more than one.
- **Network egress.** Any endpoint that is not Google's, reached at any point including start-up
  telemetry.
- **Dependency provenance.** Direct counts are small, 4 to 9 across the four candidates, so the
  transitive tree is worth walking rather than sampling.
- **Publisher signals.** npm two-factor, provenance attestation, repository activity, whether
  anyone answers an issue.
- **Containment.** Whether it runs without broad host filesystem access, and what the revocation
  path is once it holds a credential.

One preliminary result, measured 2026-09-03: none of the five packages, the configured one
included, declares a `preinstall` or `postinstall` script. That clears the usual supply-chain
vector and says nothing about the six questions above.

The assessment has to be able to come out against all four. If the only authentication any of
them offers is a harvested full-account session cookie, then the finding is that none gets wired,
and a curated notebook stays something the operator queries by hand. An assessment that can only
return a ranking is not measuring anything.

### What the investigation has to answer

Adoption turns on three questions, in this order, and the first two can kill it on their own.

The access question comes first. NotebookLM has no official public API, so an MCP server for it is
presumably driving the product's own interface with a user's credentials. That needs to be
established rather than assumed, because it decides whether this is a supported integration or a
dependency that breaks whenever Google changes the product. `@latest` on an unofficial package holding
a Google session is the least pinned, highest privilege component that would exist in this stack,
and `security.md` requires a pinned version and a scoped grant before any real use.

The value question comes second. The stack already answers domain questions three ways:
`code-context` for this repository's code, Context7 for library documentation, and web search for
everything else. A notebook is worth adding only where a curated corpus beats all three, which
means a bounded body of source material that changes slowly and that the open web indexes badly.
Name one such domain and test against it rather than reasoning about the category.

The routing question comes last, and only if the first two clear. Adoption would mean a new row in
`agent-usage.md` saying when a domain question goes to a notebook instead of to search, alongside
the cost of maintaining a corpus that goes stale silently.

### Promotion

This is an account-layer tool question, not a core process one, so it does not sit behind
`CONTRIBUTING.md`'s two-occurrences bar. It enters core only if it produces a routing rule, and a
routing rule is exactly the kind of finding that bar governs.

---

## 15. The model-tier gate's sonnet branch is unsatisfiable on the Agent tool

**Status:** proposed. Found in use, 2026-09-03, on the first two real dispatches after the gate
was wired at account scope.
**Surfaced:** 2026-09-03, account-layer portability session.

### What happened

`model-tier-gate.ts` was registered in `~/.claude/settings.json` as a `PreToolUse` hook on
`Agent|Task|Workflow`. It worked immediately: the first dispatch omitted `model` and was denied,
correctly, because a dispatch that names no tier inherits the session model.

The second dispatch passed `model: "sonnet"` and was denied again, this time for omitting
`effort: "xhigh"`. That denial cannot be satisfied. The Agent tool on this surface accepts
`description`, `isolation`, `mode`, `model`, `name`, `prompt`, `subagent_type` and `team_name`.
There is no `effort` parameter, so no sonnet dispatch through this tool can ever carry the field
the gate demands.

The agent in question was `senior-developer`, whose definition already carries `effort: xhigh`
beside `model: sonnet`. It would have run at the mandated effort. The gate denied it because the
gate reads the dispatch and cannot see the definition.

### Why this matters more than it looks

The gate ships a documented escape hatch, `MODEL-OVERRIDE: <reason>`, and its header argues that
the safeguard is the override being written down and visible rather than a regex grading it. That
reasoning holds for an override used occasionally. It does not hold when one branch of the gate
can only ever be passed by overriding it. Every sonnet dispatch on this surface now requires the
operator to write an override, which trains the reflex the gate exists to prevent, and an override
written reflexively is a muted gate that still looks armed.

### What to decide

Three candidate responses, and the first two are the real ones.

- Resolve `subagent_type` to its definition and read `effort` and `model` from the frontmatter
  before denying. This is the accurate fix: the gate's premise is that an unstated tier is an
  inherited tier, and that premise is false when a definition states it.
- Deny only on a stated tier that is wrong, rather than on an absent field that the caller has no
  way to supply. Narrower, and it gives up catching a definition that omits `effort`.
- Leave it and document the override as the expected path for sonnet. Cheapest, and it accepts the
  reflex problem above.

Worth checking whether the same shape affects the `Workflow` branch, where `agent()` calls do take
an `opts.effort`, so the field is suppliable there and the branch is probably sound.

### Evidence

Both denials were live, on real dispatches, with the gate's own stderr. The first is the gate
working as designed. The second is this item.

---

## 16. Export-Account and Install-Account ship unwired until Task 13

**Status:** closed 2026-09-04. Both scripts are registered in `README.md` and `~/.claude/rules/harness-core.md`, and both header notices are gone.
**Surfaced:** 2026-09-03, account layer portability work.

Both scripts carry the Gate 1 header notice. Neither is named by `README.md` or by
`~/.claude/rules/harness-core.md`, so nothing tells an operator they exist. Task 13 adds both
registrations and removes both notices; this item is the tracker Gate 1 asks for in the meantime.

Owner: whoever executes Task 13 of that plan. If the plan is abandoned before Task 13, the two
scripts and their test files come out rather than staying as unwired files that read as installed.

## 17. Prose-lint skip list misses `.superpowers/sdd/`

`writing-style.md` row 5 exempts internal agent traffic from the prose contract, and the mechanism
is the skip list matching `/memory/`, `/handoffs/`, `/scratchpad/`, `/.scratch/`,
`/council-transcripts/` and `/.claude/` against the written path. The superpowers
subagent-driven-development skill writes every brief, report and review under
`<repo>/.superpowers/sdd/<plan>/`, which no segment matches, so the hook lints subagent reports that
the rule already exempts.

Observed 2026-09-04 during account-layer execution: a reviewer's report file drew ai-tells findings
on quoted Pester output and code identifiers. The reviewer correctly overruled them and said why.

Both mechanisms need the same segment added, per the "naming all three mechanisms keeps them from
drifting" note in `writing-style.md`: `core/claude/hooks/lint-doc-prose.ts` on write, and
`~/.claude/hooks/Lint-DocumentProse.ps1`. Check `core/claude/hooks/pre-commit` too, though
`.superpowers/` is git-ignored scratch so a commit hook may never see it.

## 18. The mcpServers gate and the mcpServers fold cover different property sets

`install/Export-Account.ps1` scans every string reachable under an MCP server entry before writing
`account/claude/mcp-servers.json`, but the placeholder fold still walks only `command`, `args` and
`env`. The two came from different rounds of the same task and the asymmetry was left in
deliberately.

Nothing leaks today. All three live servers are `type: stdio` with exactly `[type, command, args,
env]`, so every property the writer serialises is also a property the fold visits. Add an `http` or
`sse` server, though, and a machine path sitting in its `url` or in a `headers` value gets committed
unfolded, because the fold never looks there.

The reason this is a backlog item rather than a fix in the task that found it: extending the fold
means a mutating walk that rewrites values in place, which is a good deal more code than the
read-only collector the gate uses, and Task 14's payload-wide residual machine-path scan is a hard
gate that catches an unfolded machine path wherever it sits. So there is a net under this already.
The work here is closing the gap at its own level rather than relying on the net.

Take it when someone adds a non-stdio MCP server, or sooner if the Task 14 scan turns out to be
narrower than it reads. The fix is to derive both the gate's input and the fold's targets from one
traversal of the entry, so the two cannot drift again.

## 19. The account-layer containment guards do not resolve reparse points

`Install-Account.ps1` refuses a `-PayloadRoot` equal to or nested inside `-ClaudeHome`, and
`Export-Account.ps1` refuses an `-OutputRoot` equal to or nested inside `-ClaudeHome`. Both compare
canonical absolute paths, and both can be walked past the same three ways.

A review of the installer's guard measured all three. NTFS junctions are the one that matters: a
junction pointing from the payload root into the target reproduces exactly the containment the
guard exists to refuse, and it grows without bound. Four consecutive runs produced 10, then 21,
then 32, then 43, then 54 files, gaining one more `rules\nested\` level each time. 8.3 short names
and a `\?\` path prefix also get past it, though neither compounds the way the junction does.

Fifteen other spellings held: equality, nesting in both directions, case differences, forward and
backward slashes, `..` segments, trailing separators, and relative versus absolute pairs. The
prefix case that has bitten this repo before is handled correctly, since `.claude` against
`.claude-backup` is accepted in both orderings.

The fix belongs in `AccountShared.ps1` as one containment helper both scripts call, resolving
reparse points before comparing. Doing it in either script alone leaves the other wrong, and the
two guards already exist for the same reason against the same failure. Whoever takes this should
also decide whether a junction inside the tree being copied is worth refusing outright rather than
resolving, which is simpler and probably right for a tool with one operator.

Not urgent. It takes a deliberately constructed junction to reach, both scripts print what they
are about to do, and the destructive one now reports a mixed state on partial failure.

## 20. `-ClaudeJson` sits outside the containment guard, and the mixed-state warning has gone stale

Two small gaps left open by the `mcpServers` merge, both raised in review and both deliberately
deferred.

`Install-Account.ps1` compares only `-ClaudeHome` and `-PayloadRoot` when it checks containment. A
`-ClaudeJson` pointing inside `-PayloadRoot` would have the merge write into the payload tree. No
realistic caller does this, and the copy has already finished by the time the merge runs, so
nothing is corrupted today.

The mixed-state warning names only `$ClaudeHome`, but the mcp block now also writes `-ClaudeJson`.
A code comment at the write says so; the warning text does not. In practice the `Set-Content` is
the last fallible statement in the `try`, so a failure after it is not reachable.

Take both together with item 19, since the containment half wants the same helper.

## 21. `Convert-HookCommand` and `Expand-AccountToken` both expand `{{CLAUDE_HOME}}`

The account installer reuses `Convert-HookCommand`, a function written for project restore, inside
the account-layer install path. Both it and `Expand-AccountToken` handle `{{CLAUDE_HOME}}`, so
either one alone is enough to produce a correct hook command.

The review that found it reads the overlap as accidental, a side effect of the reuse rather than
defence in depth, and nothing documents it as intentional. The cost is a test blind spot rather
than a bug: an assertion on the expanded hook command cannot be reddened by disabling either
function alone, only both at once, so a regression confined to one of them passes unnoticed.

Closing it means deciding which function owns the token on the account path and removing the other
handler, not adding a test that pins which one did the work. That would assert an implementation
detail rather than the outcome.

## 22. The prose-lint skip lists do not match `.superpowers/`

**Status:** closed 2026-09-05 as a duplicate of item 17. Same defect, same two files, same fix.
Item 17 survives because it carries the observation date, the symptom someone actually saw, and the
instruction to check `pre-commit` as well. This item was written during the account-layer review
without checking whether the finding already existed, which is the same failure as the stale
citations in items 26 through 31: acting on a list without first reading it. Left in place rather
than deleted, because items are referenced by number.

`Lint-DocumentProse.ps1` and `core/claude/hooks/lint-doc-prose.ts` both skip `/memory/`,
`/handoffs/`, `/scratchpad/`, `/.scratch/`, `/council-transcripts/` and `/.claude/`, which is
`writing-style.md`'s row 5 exemption for internal agent traffic.

Neither matches `/.superpowers/`. That directory holds the subagent-driven-development workspace:
ledgers, task briefs, implementer reports, review reports. It is the same kind of traffic by every
test the row applies, written for the next agent rather than for a reader, and it lints today.

Add the segment to both lists in one change, the way the row's other three mechanisms are already
kept in step.

## 23. The WSL-home gate is narrower than its name in two directions

`Export-Account.ps1` folds a WSL home path to `{{WSL_HOME}}` and then refuses to write
`mcp-servers.json` if any post-fold string still carries a bare `/home/<user>` segment. The gate
did its job on the export it was written for, but its guarantee is smaller than it reads, in two
ways a future export could walk into.

The check keys on a `/home/` prefix. A WSL root account lives at `/root`, a Linux distribution
image can put a user under `/Users/<name>`, and a WSL path reaching back into Windows is
`/mnt/c/Users/<name>`. The last one is the awkward case: it carries the Windows username, and it
escapes both the WSL gate, which does not recognise the prefix, and the Windows folds, which match
on backslashes. A two-valued test over a path shape that is not enumerated cannot decide the
question it is being asked, which is the same failure the scope-filter invariant in
`change-management.md` already records.

Separately, the gate runs over `mcpServers` strings only. The same literal can reach the payload
through a settings hook command, through a copied rules file, or through any templated file that
reports folding one of one and is counted as clean. Today's payload was verified free of it by
direct scan across all 218 files, so neither half blocked the branch. Closing this means
deciding the set of home-path shapes the fold owns and applying the gate at the point every file
passes through, rather than at the one file that happened to carry the literal first.

## 24. The `-WslHome` default-resolution block cannot be reddened

Ablating the block that resolves `-WslHome` when the caller supplies no value leaves the
Export-Account suite fully green. No assertion names the behaviour, so a regression in it would
ship green too. Verifiable without an ablation: the block is `Export-Account.ps1:132-137`, and
every test touching the parameter passes it explicitly, a populated path at
`Export-Account.Tests.ps1:1074` and an empty string at `:1108`. No case omits it.

The baseline this item first quoted, 56 passing, was already a commit out of date when it was
written, and the correction sweep across items 26 through 31 missed this one because it swept the
items it was thinking about rather than every item carrying a count. Suite figures are deliberately
left out above for that reason; the citation is what stays true.

This is the fifth instance on this branch of a test that could not fail, and the fourth found by
ablation rather than by reading. The pattern is consistent enough to be worth stating as a habit
rather than a series of incidents: an assertion is not evidence until the code it names has been
broken underneath it.

The fix is a case that exercises the default path with the parameter omitted, not an assertion on
the resolved value from a call that passes one.

## 25. Licence marking inside the vendored security skills is uneven

Seven skill trees under `account/claude/skills/` come from `microsoft/hve-core`: the six OWASP
knowledge bases and `secure-by-design`. Each tree's `SKILL.md` carries an SPDX `license:` field,
and 52 of the 85 files carry a licence marker in the file itself. The 33 reference files under
`owasp-cicd/`, `owasp-infrastructure/` and `owasp-mcp/` carry none, while the matching files under
the other three OWASP trees all do.

The repository `NOTICE` covers all 85 and says so explicitly, so attribution accompanies the
distribution. This item is about closing the gap at its source rather than about the notice.

The repair does not belong in the payload. These files are copied verbatim from `~/.claude/` by
the exporter, so a hand edit under `account/claude/` is reverted by the next export. Fix the live
tree, or take the gap upstream to `microsoft/hve-core`, then re-export.

## 26. Three unpinned guards and one assertion that passes on an empty output

The whole-branch review ablated twelve production lines and found four more gaps that no test
notices: three correct production lines with nothing behind them, and one assertion satisfied by an
empty string.

Line numbers below are at `0911ab0`. Suite baselines are Export-Account 58 pass, 0 fail and
Install-Account 96 pass, 0 fail.

`Export-Account.ps1:164` anchors the containment comparison with
`$sep = [System.IO.Path]::DirectorySeparatorChar`, so a sibling that shares a name prefix is not
mistaken for a nested path. Setting `$sep = ""` leaves the suite at 58 pass, 0 fail, and exporting
to `.claude-payload` beside `.claude` is then refused with a message that is false.
`Install-Account.Tests.ps1:284` and `:298` already pin this on the installer's identical guard, in
both directions. Port the pair across.

`Export-Account.ps1:549` filters the server list with `| Where-Object { $_ }`. Dropping it leaves
58 pass, 0 fail, and `"mcpServers": {}` then reports one server and proceeds on a phantom entry,
because `.PSObject.Properties.Name` on an empty object is `$null` and `@($null)` holds one element.
`change-management.md` records that trap as having bitten four times.

`Install-Account.ps1:373` de-duplicates residual tokens with `| Select-Object -Unique`. Dropping it
leaves 96 pass, 0 fail, and a file carrying one token twice reports it twice. Cosmetic, but stated
behaviour with nothing behind it.

`Install-Account.Tests.ps1:494` asserts only that the output does not match `\bjq\b`. Its sibling
at `:531` asserts the same negative but guards it with a positive control first. Making
`Test-Prerequisite` return an empty list reddens eight tests including that sibling, while `:494`
stays green: an empty string satisfies it, so it cannot tell whether the npm probe found anything,
which is the only thing it claims to prove. Add the same `Should -Match '\bvale\b'` control.

## 27. Two ablations that cannot discriminate

Distinct from item 26. These two tests do redden, and neither reddening means what it appears to.

`AccountShared.ps1:21` throws when the AST lift finds no function, converting a rename in
`Restore-ClaudeProject.ps1` into a loud failure. Replacing the throw with `if ($false)` leaves 58
pass, 0 fail. That is the correct outcome rather than a defect, because the failure the guard
exists for needs the rename and not the guard's removal. `FIXTURE-ONLY-MARKER` proves the lift happens;
nothing proves it fails loudly. An honest test renames a function in a fixture copy and asserts the
throw.

`Export-Account.Tests.ps1:1083` asserts that `args` contains `{{WSL_HOME}}/code-context-mcp.sh`
and `:1086` that it does not contain the raw `/home/wsluser/` form. The fixture's `args` has two
elements, so the second assertion cannot fail unless the first already has. Deleting the
`{{WSL_HOME}}` fold row does redden the Context, but through its `BeforeAll`: the fail-closed gate
throws before the file is written, so neither `It` body runs. Neither assertion has been observed to
discriminate anything.

That matters because item 23 proposes changing that gate. Any change that stops it throwing on this
fixture turns both assertions live for the first time, with no evidence they work.

## 28. Add a `.gitattributes` rule normalising the payload to LF

`account/claude/` is written LF by the exporter and checked out CRLF under `core.autocrlf=true`, so
a fresh clone can show 212 of the 218 payload files as modified with no content difference.
`git ls-files --eol account/claude` measures the split directly: 212 files are `i/lf w/crlf`, 4 are
`i/lf w/lf` (the `.sh` files the current rules already cover) and 2 are binary.
The current `.gitattributes` covers `*.sh` and `core/claude/hooks/pre-commit` only.

`7b1497e`'s commit message describes the symptom at length, which means the knowledge exists but
lives in a commit body rather than anywhere a future reader would look.

One caution carried from `change-management.md`: adding `text eol=lf` renormalises every existing
clone, so this is worth doing for the payload's real ergonomics and never as a way to repair a
failing test. A matcher that breaks on line endings gets fixed in the matcher.

## 29. Make the exporter's zero-fold report fatal where a fold is required

`Export-Account.ps1:439` prints `folded $substituted of N token(s)` as a plain `Write-Host`, and
`:435` warns per token. A file that folds zero of its tokens is reported in the same register as one
that folds all of them.

For the two files where a fold is required rather than incidental, a zero count means the fold table
and the source text have drifted apart, which is the failure the report exists to catch. Make that
case throw. Ruled during execution and recorded in the ledger; it did not reach this file at the
time.

## 30. A `{{HOME}}` fold token needs longest-literal-first ordering

`Get-AccountFoldTable` states a precondition that no fold literal is a substring of another.
`$HOME` breaks it: it is a literal prefix of both the `.claude` path and the vault path, so folding
it first swallows their tails and produces `{{HOME}}/.claude` where `{{CLAUDE_HOME}}` belongs.

Adding the token means ordering the table longest-literal-first in `ConvertTo-TemplatedText`, not
just appending a row. Worth doing only alongside a reason to add `{{HOME}}`; recorded here so the
ordering constraint is not rediscovered by whoever does.

## 31. The residual-path report reads pre-install state under `-WhatIf`

Item F4 of the branch review covered the status lines that claim work `-WhatIf` did not do, and
those are fixed. The installer's residual-path report is a different shape and was deliberately left
alone rather than folded into that fix.

It reads on-disk state. Under `-WhatIf` nothing has been written, so on a first-time install the
state it reads is the state before the install, and the report under-counts the residual paths a
real run would produce. The two known non-portable entries, `1password` and `code-context`, would
not appear.

The report is otherwise the best-designed diagnostic in either script, and it ends with the line
that makes it falsifiable: "Anything else on this list is an exporter bug." A dry run that quietly
returns a shorter list weakens exactly that claim. Fixing it means reporting against what the
install would write rather than against what is on disk, which is a larger change than the status
lines needed and is why it is here rather than in that commit.

## 32. Two leftovers from the fix round that closed items F1 through F6

Neither blocks anything. Both were found by the re-review of the fix itself and left deliberately,
rather than widening a commit whose message promised a narrow change.

The residual-token exemption list is global. `$script:AccountResidualExemptLiterals` filters all
three `Get-ResidualToken` call sites: the templated-file loop, the `settings.json` check and the
`mcpServers` check. Only the first needs it. A real `{{PROJECT}}` appearing in a hook command or
a server argument would now be dropped without a warning, which is the same class of silence the
exemption was added to prevent, just moved. No such token exists in the payload today. The narrower
fix passes the list as a parameter and supplies it at the one call site.

The new Export containment test closes with two `Test-Path` assertions on installed files. Under
the ablation the test targets, the marker guard fails closed and the fixture never changes, so both
assertions pass while the test fails on its message. They are entailed by the `-ExpectedMessage`
assertion and have never discriminated anything. They were copied from the pre-existing sibling
test rather than written for this one, so the sibling carries the same pair. Worth knowing before
anyone cites either as coverage; item 27 is the same shape.

## 33. `NOTICE` hard-codes eleven measurements of a generated directory

`NOTICE` states 218, 153, 85, 72, 13, 52, 33, 63, 2, 3 and 65 as file counts. Every one measures
`account/claude/`, which `Export-Account.ps1` regenerates from `~/.claude/`. All eleven are correct
as of `3b698b7`, and `360e2e3` is the record of four of them having been wrong once already.

`CONTRIBUTING.md:41` forbids this directly: file counts "belong with the file that carries them or
in a doc whose author controls that file." Nobody controls `account/claude/`; the exporter writes
it. The rule's escape hatch is to round the figure and label it as rounded, which the first draft of
this notice did and the correction removed in favour of exact counts.

Nothing re-checks them. Not `test/`, not the Pester suites, not the export procedure at
`README.md:116-125`, and there is no CI. The next export that adds or drops one skill falsifies a
licence attribution silently, which is worse than the same drift in prose.

The repo-idiomatic close is a test rather than a rounding: assert each count against `git ls-files`
so an export that moves a number fails a gate instead of shipping. That also closes the drift
exposure permanently, where rounding only widens the tolerance. Sequence it with item 36, which is
about nothing running any test at all.

## 34. Two vendored trees ship without stated permission, recorded as prose and not as a decision

`NOTICE` discloses that `account/claude/skills/beautiful_prose/` (2 files, upstream states no
licence) and `account/claude/skills/filesystem-context/` (3 files, an author line and nothing else)
are redistributed with attribution but without stated permission, and offers removal on request.
That disclosure is honest and it is not a decision.

The operator ruled to ship both, applying one precedent across two identical cases. Nothing tracks
the alternative, which is one `$script:AccountSkipDirs` entry each: that table exists at
`AccountShared.ps1:45` and already carries a policy exclusion of exactly this kind for
`skills/appsec-kpi-deck`. `filesystem-context` is the closer call of the two, since
`settings.account.json` shows it disabled locally, so the payload carries a skill the operator has
switched off.

This belongs as a decision note under `change-management.md`'s security-tradeoff category, where the
reasoning survives independently of the notice text. A ruling recorded only inside the artifact it
authorises cannot be found by anyone asking whether it was ever made.

**Status:** closed 2026-09-05. Note written as `ship-unlicensed-vendored-trees` under the
`E--projects-agent-harness-core` memory scope, indexed in that scope's `MEMORY.md` Decisions group,
`status: proposed` pending the operator's ratification. It records both directories, the rejected
`$script:AccountSkipDirs` alternative, and an explicit non-extension clause: a third unlicensed tree
triggers a standing policy rather than an amendment to this note.

## 35. Nothing verifies that the committed payload matches a fresh export

`README.md:112-114` and `account/claude/rules/harness-core.md` both state the one-direction rule and
"never hand-edited" as prose. `README.md:123-124` names the procedure: re-export, then read
`git status account/claude`. Every one of those is prose; the enforcement is a person remembering.

Item 25 already leans on the invariant as though it were enforced, saying a hand edit under
`account/claude/` is reverted by the next export. That is true only if someone re-exports.

This is the shape the repo's own findings flow calls a forcing function authored but not registered:
a rule with no mechanism. Note the check is not free, because `core.autocrlf=true` makes
`git status` the wrong instrument, per item 28. A real check compares blob hashes through git's
filters, which is what the branch's final review did by hand and nothing does automatically.

## 36. The repository has no automated test run

`.github/` holds `ISSUE_TEMPLATE/promotion.md` and nothing else. Five Pester suites and `bun test`
exist, 647 tests between them, and all six run only when a person remembers to run them.

Four items in this file (24, 26, 27, 32) are about individual tests that cannot fail. The gap above
all four is that nothing runs any of them unless invoked by hand, on a repository whose stated
subject is gates that cannot silently pass.

Whether that is deliberate for a process-layer repo is worth asking rather than assuming: the suites
need `pwsh`, `bun` and a populated `~/.claude` to exercise anything, and a CI runner has none of the
third. Worth a decision note recording the answer either way, since the current state reads
as an oversight and may not be one.
