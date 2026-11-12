# Coordinator Output: One Self-Contained Close

Operator directive, 2026-10-12. Mid-run text scrolls away unread while work continues. The
coordinator then says something like "still waiting on your decision" with no context, and the
operator has to dig back through the console to find out what the decision was. Text nobody reads
is waste, and a reference to text nobody read is worse.

## Mid-run cadence

How much to say between tool calls, and on any turn opened by an agent or workflow completion notification, is the project's `statusCadence` setting in `.claude/rules/harness/project-settings.md`. Where a folder has no project settings, emit no text in either case and hold explanatory insights for the close.

Whatever the cadence, a completion notification means read the report file, update the queue below, and continue.

## Stop and ask before a risky step

Whatever the cadence, ask before any action on the `change-management.md` confirmation list (Risky Operations Requiring Confirmation), reversible or not, any other irreversible action, and any step that would introduce a known security weakness (`security.md`, Default Posture: flag before proceeding). Ask immediately, and make the question complete under the restating rule below.

## Decisions: default, log, continue

When the work needs an operator input, both options are reversible, neither is on the
confirmation list, and neither introduces a known security weakness, take the recommended option, keep working, and log the item. Otherwise stop and
ask, as above.

An item enters Needs you only if one of its answers changes code, config or policy. A shipped default with no plausible flip goes in Done. A check not yet run goes in Unproven. (Operator, 2026-10-28, in another project, on a padded list: "This isn't a decision".)

Log each item to `<scratchpad>/needs-you.md` as it arises, not from memory at the end. Compaction
drops an instruction that has not been acted on, and a queued decision is exactly that.

## Never point at a decision without restating it

Every mention of a pending input carries all of it, in this shape:

```
1. <The question, one sentence.>
   - Where this came from: <what the thing is, how it arose, why it surfaced now>.
   - Default taken: A. Why A over B: <the one deciding factor>.
   - A means: <what happens, what it costs, how hard to undo>.
   - B means: <same three, for B>.
   - Flips if: <the fact that would make B the right call>.
   - Blocks: <what waits on this, or "nothing, work continued on A">.
```

"Where this came from" is written for a reader who saw nothing earlier in the session: name the
thing in plain terms (what a setting does, not just its key), how it came to be in play, and why it
surfaced now. A coordinator that cannot fill that line does not understand its own question yet. It
investigates first and asks after, never the reverse.

For an ask under the mid-run exception, the first line is "Recommend: A" because no default was taken.

A ramification is concrete: what breaks, what it costs, who notices, how long to undo. "Riskier"
and "cleaner" are not ramifications. The recommendation names the single factor that decides it,
not a pros-and-cons list, so the operator can check that one factor against what they know. "Flips
if" is the most useful line, because it names the knowledge the operator may hold and the
coordinator lacks. Three options at most. A fourth means the question is not framed yet.

Never write "still waiting on your decision", "see above", "as noted earlier", or a bare issue
number standing in for the question. If nothing changed since the last close, say nothing.

## The close

The close is the turn where no agent or workflow is outstanding, or where everything left is
blocked on the operator. It stands alone. A reader who saw nothing earlier in the session can act
on it.

1. Verdict, first line.
2. **Needs you**, numbered, each item complete under the rule above. Omit the section when empty.
3. **Done**, with the evidence for each claim (`no-overclaim.md`).
4. **Unproven**, and the signal that would settle each item.
5. **Insights** held from the run.

The wrap-up cap in `writing-style.md` applies to everything except Needs you. An item is never cut
short to fit the cap.

## Push notification at the close

When the close carries Needs-you items, or the run went longer than about ten minutes, send one
`PushNotification` leading with what to act on: "2 decisions need you: deny-rule scope, PR footer".
The tool skips sending when the operator is at the terminal, so no presence check is needed. Never
notify mid-run except for a confirmation under the mid-run exception.
