# Contributing

This repo grows from real projects, not from designing ahead of need. Anything added here should already have proven itself somewhere else first.

## Findings flow

There are two channels for something a project learns while using this harness.

The cheap one is capture: any finding worth remembering, a fix that worked, a failure mode worth avoiding, becomes a memory note per the memory-system skill, tagged with the project it came from. This costs almost nothing and most findings stop here. Most one-off fixes belong to one project and should stay there.

The second channel is graduation. When the same failure class, or the same useful pattern, shows up a second time in a different project, it gets promoted into this repo as a commit: a new or edited pattern doc, an agent definition, a hook, or a template. Once something graduates, the memory notes that described it shrink down to a pointer at the core doc instead of repeating the detail.

One occurrence is a note. Two occurrences across different projects make it a candidate for core.

## What belongs in core

A change belongs here if it states a testable constraint or provides machinery a second project can actually reuse, not a fix for one project's specific bug. It should be language-agnostic, or clearly labeled with which language or stack it assumes. And it has to be genericized, stripped of the project name and domain-specific nouns from whatever system it was pulled out of. If a pattern doc needs an example, use a placeholder domain like "orders" or "jobs" instead of the real one.

That's a scrubbing rule: how an example should read. A separate, orthogonal question decides what kind of knowledge a core file is allowed to carry at all: process versus domain. Core agent definitions hold process, how to work, review independently, verify before claiming something works, reconcile docs after a merge, and never a technology, a tool, or a field. The reason is cadence, not quality. Core only updates when a project reruns the installer; a domain moves on its own schedule regardless. A def can pass every clause above, genericized, testable, reusable by any project in that domain, and still fail this one. `docker-expert` did: stripped of any project name, stating a real checklist, reusable by any Docker project, and still going stale on Docker's release cycle rather than the installer's, which is exactly why it doesn't live here anymore.

## What stays project-level

Domain logic stays where the domain lives. So do thresholds tuned to one system's traffic or scale, and language-specific versions of a pattern described here. If a project builds a core pattern in a different language, that code lives in the project, not here. Only the pattern doc that describes the shape of the solution belongs in core.

A domain agent def follows the same rule even when it's well-written and reusable across several projects. It lives in the account layer or in the project that needs it, never in core, because reuse doesn't offset staleness.

## Change process

Make changes on a branch. Run both suites before committing. Write the commit message so it explains why the change was needed and what alternative was considered and rejected, not just what changed. Merge once it's ready.

The TypeScript hook tests run under `bun test` from the repo root. The installer tests are Pester, and the invocation matters more than it looks: run them as `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`, which exits non-zero when a test fails. The obvious alternative, `pwsh -Command 'Invoke-Pester install/Install-Harness.Tests.ps1'`, prints `Failed: 1` and still exits 0, so anything chaining off it proceeds on a red run while showing you the failure on screen. Measured on a tree with one deliberately failing test: the `-File` form gave exit 1, the bare `Invoke-Pester` form gave exit 0, and building a configuration with `$c.Run.Exit = $true` gave exit 1.

Projects pick up core changes by re-running the installer. The installer is manifest-tracked: it never silently overwrites a file a project has modified since install. See `install/Install-Harness.ps1` for the exact overwrite behavior.

### What a change has to carry

Each one is a gate. A change that fails one is incomplete, and the review says so.

**A new executable artifact carries its registration in the same commit.** A hook, a template, a script, anything this repo runs or copies, is not finished when the file exists. It is finished when something invokes it. A hook needs its `settings.hooks.json` entry; a template needs a copy path in the installer. Either one arriving without the other leaves a file that reads as installed and never runs, and nothing in the tree reports the gap. This failed twice in one wave, once for a hook and once for a set of templates, both times because the artifact and its wiring were split across authors and neither author held both. A change may still land an artifact deliberately unwired, but then the file's own header says it is unwired and carries the registration snippet, and a tracker item (a backlog entry or an issue) names who wires it.

**Nobody hard-codes a measurement of a file they don't own.** Line counts, character counts, file counts, any number read off a file, belong with the file that carries them or in a doc whose author controls that file. A number cited from somewhere else bakes in a value that goes stale the moment the other file is edited, and neither author finds out. Cite the path and let the reader look. Where a number helps a reader, round it, say in the same sentence that it is rounded, and check the rounded claim against a real count taken at the time of writing. Rounding buys tolerance for later drift, never permission to be wrong today. "Under a thousand characters" holds only if it is true of the count you just took, and a figure nobody measured fails this rule whether or not it wears the label. That last sentence is here because the first draft of this clause omitted it, and a labeled "roughly 650" passed review as compliant while the real count sat nearer 800. Concurrent editing makes all of this fail within the hour; ownership alone makes it fail eventually, so the constraint holds either way.

**A hook lands with a test that asserts a denial.** A gate whose refusal path has never been observed is not known to refuse anything. Anything added under `core/claude/hooks/` needs a matching file under `test/` whose cases include a boundary-crossing input asserted to DENY, not only permitted inputs asserted to pass. Cases that pass prove the gate lets work through. Only a case that is denied by design proves there is a gate at all. This is a different check from the one in [`patterns/ablation-verification.md`](patterns/ablation-verification.md): ablation proves a fix is what holds the test up at the moment it is written, and a standing denial case keeps proving it through every later refactor of the same file.

**Drift detection gets read at a fixed point in the process, and every class it reports has a standing answer.** `Install-Harness.ps1 -Audit` writes nothing, and nothing invokes it, so it counts as a control only when a person runs it and acts on the output. Run it against a consumer project before promoting a change into core, and again after that project re-runs the installer. Each class the audit can report needs a response recorded next to the class list it annotates: which classes a re-run repairs safely, which must never be repaired automatically because doing so would discard a project's own edits, and which need an owner instead of an action. A report whose rows map to no response is decoration.
