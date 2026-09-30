---
name: engineering-method
description: One operator's engineering method for agent-driven work, covering how to plan, delegate, fix, verify, review and close a change. Load at the start of any non-trivial engineering task, and again when planning, delegating, reviewing, or deciding whether work is done.
---

# Engineering method

A working method for any setup with a coordinating agent and a way to delegate. "You" is whoever holds the coordinating seat: a CLI session, a squad lead role, or a planning agent.

## The loop

Every non-trivial task runs the same cycle.

1. Plan. Name the invariant the work restores, in one sentence, before touching anything. Write the plan down when there is more than one step.
2. Delegate. Hand implementation and bulk reading to subagents. The coordinator reads results and decides.
3. Verify. Run the check that would fail if the change were wrong.
4. Review once. A separate agent reviews. A second round only for a load-bearing finding.
5. Close on the invariant. Done means it holds and a test pins it, not that no finding is open.

## The coordinating seat

The coordinator is an interpreter, not an operator. Its effort goes on judgment.

The seat is required to challenge. Before executing a request, state any part that looks low-value, redundant or harmful, with the reason and the cost, then proceed as directed or propose the smaller alternative. Name specifics. One clear challenge, then commit, and do not re-litigate after the human decides. Weak subagent findings get the same treatment. Agreement is earned by the idea, never granted by the role.

## Delegation

Delegation pays when the agent absorbs volume the coordinator would otherwise read. Delegate when output would run past roughly fifty lines, when answering takes two or more tool calls, when the task writes anything, or when the output needs filtering first. Run inline only when all three hold: one call, small output, and the raw text needed verbatim to decide the next move. A single-line edit with no logic in it, a typo or a version bump, stays inline too.

Every dispatch, or the role definition it lands on, names its model tier. Mechanical fetch-and-report work (listings, greps, builds, log tails) goes to a cheaper model. Judgment work (review, architecture, arbitration, synthesis) goes to a premium model, and search is judgment. Parallel agents multiply cost, so each must clear the thresholds on its own.

## Plan, then execute through subagents

A change that fits in one sentence and touches one subsystem needs no spec. Its plan is the commit message and the test that pins it. Anything more than one step, any change crossing subsystems, and anything security-bearing starts with a written spec and a written plan, both existing before implementation begins. Security-bearing work needs the spec whatever its size. The failure to watch for is real work classified as trivial to skip the spec. A spec lists its acceptance criteria as Given/When/Then or EARS lines in plain markdown (EARS: "When [trigger], the [system] shall [response]"), each naming the test or command that checks it, and it ends with one end-to-end verification step. No Cucumber bindings. Each criterion then has a check that can be removed and watched to fail. A plan's correctness lives in exact paths, signatures that match across tasks, assertions that can fail, and commands that run verbatim.

Plan execution is always subagent-driven, a fresh subagent per task with review between tasks. The coordinator never executes plan tasks inline and never offers that as an option.

## Fix the producer, not the consumer

Before writing a fix, name the violated invariant in one sentence: X should hold Y, established at Z. Name where the bad state is produced and where it is consumed. Patch the producer by default. Guarding the consumer at the crash site is a last resort for when no writable seam exists at the source, and the commit must say why. A fix that cannot state its invariant is limited to a minimal local workaround, never a structural change.

Prove the premise before replacing a mechanism: reproduce the failure with only that mechanism at fault. When two defects co-occur, fix one, confirm the second still reproduces, then fix it. Never ship entangled fixes as a bundle. Tag each fix verified (the test fails with it removed) or assumed, with the reason.

Complexity needs a receipt. Every new primitive (a lock, a threshold, a cache, a fallback path) carries a one-line justification naming the simpler cause-site alternative that was rejected. A failure that reproduces only under local configuration is a local patch, not an upstream submission.

## Evidence before assertion

A claim of success must be backed by data or a checkable source. Capability is not behavior: shipped code, a passing offline test or a merged change proves a capability exists, not that the outcome changed. Never say fixed, solved, done or proven for an outcome until live evidence shows it. "Wired and tested offline" is honest.

Evidence tiers, strongest first: live capture or reproduced result, offline test or passing gate, documented spec, assumption. State which tier backs a claim. In any status, separate what is known from what is unproven, and name the signal that would confirm it. A verified result is stated plainly, without hedging.

An instrument that cannot come out two ways measures nothing. Before building a rig, write down what each hypothesis predicts for the run you will make. Identical predictions mean the rig is decoration. Ask first whether the producer of the behavior can simply be read.

## Tests and gates

A test that passes after a fix proves only that it does not currently fail. Remove the fix and watch it fail. Then delete the new assertion and remove the fix again. A suite that still fails was being caught by something else, and the new assertion pins nothing. A test can be structurally unable to fail, through a matcher blind to the defect or a fixture that never reaches the guarded case. Before a suite's green is first cited as merge-gate evidence, and again after the suite's shape changes, run a mutation pass: make one small change to the code under test at a time, rerun, and read each surviving mutant as a finding about the suite, not as a score. The pass is per suite, not per pull request. The method and its cost are in `patterns/test-falsifiability.md` at github.com/Cringely/agent-harness-core.

A gate that cannot evaluate must fail closed, and a scope filter that resolves empty must fail closed rather than widen to the full population. Never run a state-changing command (merge, push, deploy) downstream of a pipe that can swallow the exit code of the step meant to stop it.

## Change safely

Prefer small steps: one change at a time, verified before the next. Know how to undo before starting. Back up a config before editing it and check its syntax before applying it. After each change, confirm it works and the logs are clean.

Ask before anything destructive or hard to reverse: deleting data, dropping tables, force-pushing, pruning, removing a service, or touching production and security-relevant configuration.

A commit message records why the change was needed, what was rejected, and the trade-offs. A consequential architecture, security or process choice gets a written decision record, which an agent proposes and never marks accepted. A conflict with an accepted decision is flagged to the human, never overridden.

## Review

Never review your own work. Every review goes to a separate agent with a fresh context, because the authoring context re-reads its own assumptions as facts. A trivial change with no logic in it skips review entirely rather than getting a self-review.

The verdict is joint. A change passes only when it restores the named invariant and is the smallest change that does so. The reviewer either produces a smaller patch for the same root cause or certifies none exists. Correct but larger is revise. Do not add simplicity as a separate checkbox, since a separate gate is a separate objective the author games. Reviewers report everything. The next section filters.

## Work has to be able to end

Adversarial review always finds something, so done defined as no open finding is unreachable.

Close on the invariant. When it holds and a test pins it, the work is done. A finding outside it is someone's next task.

Put a severity floor on what gets acted on. Correctness, security and anything that fails open get fixed in the round that found them. Naming, comment wording, stale citations and coverage gaps stay in the review comment. One exception: a change that leaves a living doc describing something it moved is a correctness finding, fixed in the same round.

One review round per artifact. A second round happens for a load-bearing finding and for nothing else.

Discovery is not commitment. A finding in a review comment is recorded. It becomes a tracked issue only when it is a correctness or security gap outside the change under review, or a decision that belongs to the human, who is told each time. An agent doing the work never opens an issue of its own. Report a burn-down by its net change in open issues, never by closes alone.

## Guardrails: where a rule lives

An agent is not made reliable by better instructions. A rule written down and missed anyway is a gap in the setup, not a willpower failure. Prefer the earliest tier that fits.

1. Automate it away. The system does it and nothing has to be remembered.
2. Gate the trigger. A hook or check fires at the exact action and reminds, or in rare cases blocks.
3. Re-inject just in time. Surface the rule when its trigger fires, not at session start where it scrolls away.
4. Prose and convention. Enforced by review only. The weakest tier.

A failure class appearing a second time is the signal to promote it from a note to a mechanism, written as a constraint something could check. "Be careful with X" is not one. A one-time migration step, a value tuned to one system, or a bug already fixed upstream never promotes. A hook that fires wrong gets muted and then protects nothing, so try a cheaper tier first.
