# Fix Quality: Locus and Cost

Born from a public PR postmortem (2026-07-04): every diagnosis was correct, yet the
maintainer reimplemented each fix smaller by fixing causes instead of guarding symptoms. These
rules govern fix selection after root-causing, in any codebase.

## Fix the producer, not the consumer

Before writing a fix, name the violated invariant in one sentence: "field/condition X should
hold Y, established at Z." Then name where the bad state is produced and where it is consumed.
Patch the producer by default. Guarding the consumer (null checks, wrappers, transpilers at the
crash site) is a last resort used only when no writable seam exists at the source, and the
candidate file or commit must say why. A fix that cannot state its invariant is limited to a
minimal local workaround, never a structural change.

## Prove the premise before replacing a mechanism

To replace an existing mechanism, reproduce the failure with only that mechanism at fault.
When two defects co-occur at one crash site: fix one, re-confirm the second still reproduces
against the patched build, and only then write code for it. Never ship entangled fixes as a
bundle. Tag every shipped fix load-bearing: verified (ablated) or assumed (with the reason the
ablation was skipped) — "assumed" is a flag, not a footnote.

## Complexity needs a receipt

Every new primitive (concurrency type, ThreadStatic, tunable constant, threshold, dedup
structure, fallback path) carries a one-line justification naming the simpler cause-site
alternative that was tried and rejected. New synchronization requires an actual call-path trace
to a real off-main-thread caller in the code being shipped; without one, the fix is a
main-thread-only assertion comment, not a lock. Trigger receipts by construct kind, not diff
size — line-count thresholds are gameable. A diff much larger than the code it fixes is a smell
prompting a restart from the cause, not an automatic reject.

## A dirty cache is only as complete as its enumerated inputs

Before shipping any memoization/dirty-flag/fingerprint, enumerate EVERY input the cached output
depends on — including dynamic ones that don't look like state (current keybindings, live
collections, external singletons) — and show each is captured by the key or provably immutable.
An uncaptured input is a silent staleness bug (bitten twice: BetterInfoCards value bands,
DebugButton rebindable hotkey). When inputs expose no change signal and hand-rolled equality
would sprawl, a cadence throttle is usually the smaller, safer win than a dirty key.

## Review with a joint verdict, not a separate simplicity gate

Review passes (ADVANCE) only when both hold: the diff restores the named invariant, AND it is
the smallest change that does so. The reviewer — a fresh context given the finished diagnosis,
a constrained task far easier than the original diagnose-and-fix — must either produce a
smaller patch fixing the same root cause or certify none exists. Correct-but-larger is REVISE.
Do not add simplicity as a separate stage or checkbox; a separate gate is a separate objective
the authoring context games.

## Pin the correctness baseline

State whose environment defines correct before hardening anything. An issue that reproduces
only under this machine's mods/config/data is a local patch, never an upstream submission.
Upstream cannot justify defending against callers that exist only in third-party extensions.

## Set the right target

When contributing to someone else's codebase, the achievable bar is a correct, minimal patch
plus a clean diagnosis the owner can accept or reimplement in minutes — not matching the
owner's intent model, which no amount of reading their code fully yields. Surfacing a real,
verified defect with a minimal fix is the win condition.

## Work has to be able to end

Operator challenge, 2026-09-05: "you tend to find new work in every work stream I ask you to do.
how can we limit that so you don't derive an infinite amount of work that never gets completed?"

The session that prompted it had a backlog that shrank, roughly fourteen items closed against five
filed. The growth was not in the backlog. It was in the review loop, which has no terminating
condition: adversarial review always finds something, so "done" defined as "no reviewer has an open
finding" cannot be reached. Reviewers were correctly told to report everything including
low-confidence items, with the promise that filtering happened downstream. The filtering never
happened. Unfiltered review output got treated as a work queue, and each round of fixes earned a
round of review that produced the next queue.

Four rules, and the first is the one the other three follow from.

**Close on the invariant, not on the absence of findings.** `fix-quality.md` already requires naming
the violated invariant before writing a fix. Name it before starting the work as well, and let it
define done: the invariant is restored and a test pins it. A finding outside that invariant is
someone's next task, not this one's blocker.

**Put a severity floor on what gets acted on.** Correctness, security, and anything that fails open
get fixed in the round that found them. Comment accuracy, stale citations, naming, and coverage gaps
get filed. The distinction is not how true the finding is. All of them were true in the session that
produced this rule, and two full rounds went to corrections of what a comment claimed about itself.

**One review round per artifact.** A second round happens for a load-bearing finding and for nothing
else. That bar is real and it does get cleared: the round that earned its place here found a
security gate failing open, and the round after it found that the fix had introduced a regression on
the path it did not cover. Neither would have been caught by stopping earlier. The two rounds spent
on comment wording would have been.

**Discovery is not commitment.** Finding something files it. Filing is cheap, complete in itself, and
leaves the decision to spend effort with the person whose effort it is.

The failure this prevents is not zeal. It is the quiet substitution of an unreachable finish line for
a reachable one, which reads as diligence right up until someone asks when it ends.
