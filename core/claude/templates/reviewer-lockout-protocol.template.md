<!--
Source: `bradygaster/squad`, `.copilot/skills/reviewer-protocol/SKILL.md` (MIT, repo-wide). That
skill states reassign-or-escalate lockout semantics for a multi-agent team with named Reviewer
roles. This doc restates the same rule for this repo's coordinator/dispatcher pattern, in its own
words, and adds the enforcement-status honesty this repo's rules require: nothing here checks the
rule mechanically today.
-->

# Reviewer-lockout protocol

Extends this repo's existing "independent review, never self-review" rule (see
`guardrails.template.md`'s worked-example table) from one hop to N. That rule stops an author from
reviewing their own work. This one stops an author from revising their own work after a reviewer
rejects it, the same failure one step later. An author who gets to fix what they were just told
was wrong defends the choice that produced the defect more often than they question it.

## The rule

When a reviewer rejects an artifact (a task diff, a plan, a design doc, a review verdict itself),
the agent that produced it is locked out of producing the revision. Not as co-author, not as
advisor, not consulted for context. The coordinator selects a different agent to revise, and
verifies before dispatching that the selected agent is not the one that got rejected.

1. **Rejection always forks to someone else.** The reviewer's rejection names a different agent
   to revise, or asks the coordinator to find one with different expertise. It never routes back
   to the original author by default.
2. **The coordinator enforces the fork mechanically, by hand, every time.** Before dispatching a
   revision, check the candidate against the identity of the rejected artifact's author. If they
   match, refuse the dispatch and pick someone else, even if the reviewer named the original
   author by mistake.
3. **Lockout is total for that artifact.** Co-authorship, advising, and pairing are all out. The
   revision has to be an independent second look, produced without input from the locked-out
   author, or the fork accomplishes nothing.
4. **Lockout is scoped to the rejected artifact, not the agent.** The original author can keep
   working on anything else; only this specific piece is off-limits to them until it's approved.
5. **Lockout persists through the revision cycle.** If the revision is also rejected, the agent
   that produced the revision is now locked out too, alongside the original author. A third agent
   takes the next attempt.
6. **Deadlock escalates to the user.** When every agent with a plausible claim to revise the
   artifact has already been locked out, the coordinator stops and asks the user rather than
   re-admitting anyone from the locked-out set. A task rejected repeatedly by a chain of different
   agents is more likely a bad task or an unclear spec than a run of bad implementers, and that's
   a call for the user, not a reason to cycle back to someone already ruled out.

## Worked example

Task-reviewer rejects a diff from `general-purpose` agent A, naming "error handling is missing,
someone else should take this." The coordinator locks out A for this diff, dispatches agent B to
revise. Task-reviewer rejects B's revision too, naming a different concern. The coordinator locks
out B as well and dispatches agent C. If C's revision is also rejected, every agent that has taken
a run at this diff is now locked out; the coordinator stops and reports the rejection history to
the user instead of sending it back to A, B, or C.

## Enforcement status: convention, not mechanism

Nothing in this repo checks this rule today. The coordinator (a human operator or an orchestrating
session) is trusted to apply it by hand, the same way "never review your own work" is trusted
today. That's weaker than the tiers `guardrails.template.md` prefers, prose enforced by review is
the bottom of that hierarchy, and it's an honest statement of where this stands, not a claim of
coverage that doesn't exist.

What would actually mechanize it: a small persistent per-artifact record (artifact ID, current
locked-out author set) that a `PreToolUse` gate on the Agent/Task dispatch tool reads and checks
the `subagent_type` or agent identity against before allowing the dispatch, denying with a reason
the way `agent-worktree-gate.ts` denies an unisolated write dispatch today. That record has to be
written somewhere the coordinator's dispatch calls actually populate (a rejection event, at
minimum: artifact ID, rejected author, timestamp), which means it needs either a reviewer role
that writes the record on REVISE, or a hook on the dispatch call that can infer authorship from
the transcript the way `dispatch-audit.ts` infers dispatch-vs-inline from the same source. Neither
exists yet; this section names the shape of the fix, not code that runs today.
