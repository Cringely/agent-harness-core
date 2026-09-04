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

---

## 12. Failures that do not propagate: pipefail, and the installer's unchecked git write

**Status:** partially fixed. Both PowerShell sites are closed; the two shell hooks remain open. The
diagnosis below is a record of what the audit found, written in past tense; the current state is at
the end of the item.
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

**Status:** proposed, investigation only. No commitment to adopt.
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

`Lint-DocumentProse.ps1` and `core/claude/hooks/lint-doc-prose.ts` both skip `/memory/`,
`/handoffs/`, `/scratchpad/`, `/.scratch/`, `/council-transcripts/` and `/.claude/`, which is
`writing-style.md`'s row 5 exemption for internal agent traffic.

Neither matches `/.superpowers/`. That directory holds the subagent-driven-development workspace:
ledgers, task briefs, implementer reports, review reports. It is the same kind of traffic by every
test the row applies, written for the next agent rather than for a reader, and it lints today.

Add the segment to both lists in one change, the way the row's other three mechanisms are already
kept in step.
