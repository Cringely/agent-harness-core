# Pattern Index

Each doc below explains one design decision behind the roles, hooks, and templates in `core/`,
independent of any one codebase or language.

| Doc | Problem it solves |
|---|---|
| [`registry-as-ssot.md`](registry-as-ssot.md) | An action's name, parameters, and validation get hand-copied into a prompt, a schema, a dispatcher, and a docs page, and the copies drift apart. |
| [`plan-then-execute.md`](plan-then-execute.md) | Calling a model on every tick of a running agent is slow and expensive when most ticks need no judgment at all. |
| [`replan-guards.md`](replan-guards.md) | A wake condition that seemed rare in design can fire on nearly every tick once a planner starts failing, looping, or stalling in the real world. |
| [`event-sourced-state.md`](event-sourced-state.md) | A dashboard feed, a cost ledger, crash recovery, and a rate check each want their own private copy of agent history, and private copies disagree. |
| [`forcing-functions.md`](forcing-functions.md) | A rule written down once gets missed again anyway, because prose alone doesn't stop anyone from forgetting it under load. |
| [`abstaining-evals.md`](abstaining-evals.md) | Scoring an LLM's planning or decision quality offline forces every verdict into pass or fail, even on a case with too little data to judge fairly. |
| [`fleet-config.md`](fleet-config.md) | Several independently configured agents need a config format that fails loudly on a bad value instead of quietly misbehaving for hours. |
| [`parallel-review-orchestration.md`](parallel-review-orchestration.md) | Splitting one review across several agents returns the same finding three times, in three severities, with three verdicts, and hands the author a reconciliation job instead of a review. |
| [`memory-provisioning.md`](memory-provisioning.md) | A dispatched subagent reasons soundly from general knowledge and walks into a wall the project already hit, because nothing in its brief says the memory corpus exists. |
| [`agent-def-shape.md`](agent-def-shape.md) | An agent definition can inline its full role prompt or point at a versioned charter file, and picking the wrong shape either buries process changes in full-file rewrites or adds indirection to a file that never changes. |
| [`always-on-context-budget.md`](always-on-context-budget.md) | Adding an agent role feels like it costs context, and its body mostly doesn't; a rules file, a skill description, an agent def's own name and description, or a hook's output loads on every turn whether or not the turn needs it, and that's the budget actually worth guarding. |
| [`ablation-verification.md`](ablation-verification.md) | A test that passes after a fix is written proves the test doesn't currently fail, not that the fix is what's holding it up. |
| [`fail-contract.md`](fail-contract.md) | A gate's fail-open and fail-closed paths get chosen one failure mode at a time, so there's no floor to check a new case against and no way to spot the case that neither path reaches. |
| [`state-based-safety-predicates.md`](state-based-safety-predicates.md) | A stall detector keyed off a counter of refused attempts goes silent for exactly the subject that correctly stopped attempting, so no recovery path behind it ever runs, including a config switch that reads as a live control. |
| [`test-falsifiability.md`](test-falsifiability.md) | A test can be structurally unable to fail, through a matcher blind to the defect, a fixture set that never reaches the guarded case, a measurement whose result cannot separate the claim from its opposite, or an async test that fails by hanging instead of reporting, and none of the four shows up in a run as a failure. |
| [`compaction-durable-ledger.md`](compaction-durable-ledger.md) | A long session's context gets compacted, and which subagents are outstanding is exactly the bookkeeping a summarizer drops first, so the orchestrator re-dispatches work that already finished or waits on an agent that already reported. |
