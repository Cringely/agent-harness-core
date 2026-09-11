# Chained State-Change Gate

## A merge that goes through on red because the shell said yes

An agent driving the `gh` CLI writes one Bash call to do two things: check a pull request, then
merge it. `gh pr checks 42 && gh pr merge 42` reads as safe. The `&&` only runs the merge when the
step before it exits zero, and that is a weaker guarantee than it looks once other shell constructs
join the line. Pipe the check through `tail` to trim its output and the pipeline's exit status is
`tail`'s, which is zero whether or not the checks were red. Join two commands with `;` or a bare `&`
and the second runs regardless of the first. Put the merge upstream instead, with a branch deletion
chained after it, and a merge that fails on conflicts can still be followed by the deletion, which
closes the pull request unmerged.

Each of those is a state change whose precondition the caller never saw. In two of the three
recorded recurrences the command that should have stopped the chain exited nonzero and the chain ran
on anyway, the code replaced before it reached anything that would have acted on it. The third is
recorded with two candidate mechanisms and no verdict between them. Nothing in the transcript looks
wrong afterwards in any of the three: one Bash call, one result line, and the state change already
made.

A prose rule against this exists and does not hold. "Never chain a state-changing `gh` command
behind another command; check each step's result before the next" is short and clear, and in the
project that built the gate it was re-injected at the top of every session. It was slid past three
times, in three different shapes. [`forcing-functions.md`](forcing-functions.md) lays out the
hierarchy of what to do when a written rule keeps failing; this doc is one worked instance of its
second tier, the gate on the trigger.

This shape comes from one project so far, and the record of the three recurrences, with dates and
pull request numbers, lives in that project's guardrails catalog and in the hook's own header rather
than here.

## Judge the position, and keep the verb list short

The hook is a `PreToolUse` hook matched on `Bash`. It reads the command string, blanks out quoted
spans so a `&&` inside a `--body "..."` string cannot count as a chain, splits what remains on the
shell's chaining operators, and asks one question: does a state-changing `gh` verb appear in any
segment after the first? Two patterns carry the whole decision.

```ts
const STATE_CHANGE_VERB = /\bgh\s+(?:pr\s+(?:merge|close)|repo\s+delete)\b/;
const CHAIN_SPLIT = /&&|\|\||[;\n|&]/;
```

The verb list is narrow on purpose, three commands matched at word boundaries so a future
`gh pr mergequeue` would not trip it. The split tries `&&` and `||` before the single-character class
so a `||` is consumed as one operator rather than two pipes. A match writes a hard deny whose reason
names the fix. No match writes nothing at all.

Position is the whole check. A state-changer that is the sole command, or the first one, passes,
because its own exit code is the next thing the caller sees and nothing upstream existed to mask it.
What gets denied is a state change sitting downstream of an operator, the one shape where an earlier
failure can be swallowed before the state change runs. So the fix in the deny message is always the
same sentence: run the state-changing command as its own Bash call, after reading the result of the
step before it. Whether the chain would have been safe is never evaluated; the check is only
whether the caller kept sight of the exit code.

A caller who wants the chain anyway writes `GH-CHAIN-OVERRIDE: <reason>` in an unquoted `#`
comment on the command, and the reason text is required. That check runs against the quote-masked
string too, so a token inside a `--body` string is inert and only a real shell comment counts.
Without an in-band override the only way past the gate is to mute it in settings, and a muted gate
protects nothing, so the token exists to put the override and its reason in the transcript instead.

## It fails open, and the reason is where it sits

A hook matched on `Bash` runs before every Bash call the agent makes. A copy that breaks, on
malformed stdin or a missing field or a bug of its own, cannot be allowed to block the tool, or every
command in the session dies with it and the hook is deleted within the day. So a payload that fails
to parse logs the error to stderr and exits zero, and a payload that parses but lacks the fields the
hook expects exits zero without a word. Neither writes stdout, which the platform reads as no
opinion; only a well-formed deny emits JSON. The hook reads stdin and writes stdout, and that is its
whole footprint. The decision is an exported pure function, so a test suite exercises it offline
against fixture strings, and a few spawn tests pin the stdin-to-stdout contract, including the
fail-open exit.

[`fail-contract.md`](fail-contract.md) argues for writing the floor sentence before choosing either
branch. Here the floor is short: this gate must never be the reason a Bash call cannot run. Every
fail path derives from that, and the derivation has a cost worth saying out loud. A gate that fails
open on its own errors is a gate whose absence looks like a pass. The same doc records the case
neither branch reaches, a runtime missing from `PATH`, and it applies here unchanged: a session
where the hook never started produces the same transcript as a session where nobody chained
anything.

## The ceiling

This is a string matcher over shell operators rather than a shell parser, and it catches the class
it was built for: a state-changer that ended up downstream of an operator in a one-liner nobody
meant to chain past a failure. Its blind spot is the quoted span. The masking that keeps a `--body`
string inert blanks every quoted region before the split, so
`echo "$(gh pr checks 42 | tail -3 && gh pr merge 42)"` passes, with the whole chain inside the
quotes. An unquoted substitution after an operator is caught, since the split still sees the
operator and the verb: `gh pr checks 42 && echo $(gh pr merge 42)` is denied, and so is the backtick
form. A substitution in the first segment, `echo $(gh pr merge 42)`, passes on the sole-or-first
rule even though `echo` has replaced the merge's exit code, so that rule's promise holds only for a
state-changer that is a command in its own right. Obfuscation is out of scope: `$(echo gh) pr merge`
and an upper-case verb both pass, because the gate was built to catch a slip and makes no claim
against intent. One evasion the hook's own header lists, `g''h pr merge`, is closed by the same
masking, which reassembles it to `gh pr merge` before the verb check runs. Each of those verdicts
was run against the hook's exported `decide()`.

The verb list is a second ceiling. Only `gh` state-changers are gated. A `git` branch deletion
chained after a `gh pr merge` that failed is a destructive follow-up the gate never examines, and it
is one of the three recorded shapes. Widening to arbitrary destructive commands after any operator
would need a denylist, and a denylist wide enough to matter produces false denies until someone
mutes it, so the gate stays narrow.

## What a project weighs before installing it

Registered as a `PreToolUse` hook on `Bash`, the gate starts a process before every Bash call in
every session of the project that carries it, whether or not the call mentions `gh`. With a warm
runtime that is roughly tens of milliseconds per call, from one measurement on one workstation, and
Bash is the hottest tool an agent has. A hook on it is a tax on every command, paid to
close a gap that opens only on the few commands that merge, close, or delete. This repo made the
opposite call for its own prose linter, which could have been a Bash-matched hook and went to a git
`pre-commit` hook instead, where it runs once per commit rather than once per command. The same
question applies here, and it has no default answer.

Three questions settle it for a project. Does the agent drive `gh` at all, and does it merge,
close, or delete through it rather than leaving those to a person? If not, the gate is a silent no-op
with a process start attached. Is there a cheaper control that closes the same gap? A required status
check on the target branch refuses a merge on red server-side and costs nothing per call, so it is
the first thing to try; it says nothing about a close that follows a failed merge, and an admin
bypass walks straight through it. Has the prose rule already failed? One slip is a note, and the
hierarchy in [`forcing-functions.md`](forcing-functions.md) puts the gate at the second. The project
that built this one installed it after a third, against a rule re-injected every session.

## The reference copy

The gate lives in the project that built it, `spacemolt-harness`, at
<https://github.com/Cringely/spacemolt-harness> under `.claude/hooks/gh-chain-merge-gate.ts`,
registered in that project's `.claude/settings.json` as a `PreToolUse` hook matched on `Bash` and
invoked through bun. Its test file, `test/gh-chain-merge-gate.test.ts`, keeps the recorded chain
strings as regression fixtures and pins the deny payload, the silent allow, and the fail-open exit.
The hook depends on bun and nothing else; a project without bun on `PATH` gets the missing-runtime
case above instead of a gate.

The file's comments carry that project's issue numbers and review-round notes, and its deny
message cites two of that project's pull requests by number. A copy taken into another project
should replace those with the mechanism and keep the pipe-through-`tail` example.

## Related

[`forcing-functions.md`](forcing-functions.md): the hierarchy this gate sits in, at the tier where a
rule prose could not hold becomes a check on the call it judges.
[`fail-contract.md`](fail-contract.md): the floor sentence a gate's fail paths derive from, and the
missing-runtime case that neither branch of a fail-open hook reaches.
[`always-on-context-budget.md`](always-on-context-budget.md): the same question about what runs
unconditionally, asked of context rather than of process starts.
