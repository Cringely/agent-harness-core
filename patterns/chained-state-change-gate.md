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

Each of those is a state change whose precondition the caller never saw. The command that should
have stopped the chain did exit nonzero. Something between it and the state-changer replaced the
exit code, or the operator never consulted it. And nothing in the transcript looks wrong afterwards:
one Bash call, one result line, a merged pull request.

A prose rule against this exists and does not hold. "Never chain a state-changing `gh` command
behind another command; check each step's result before the next" is short and clear, and in the
project that produced this doc it was re-injected at the top of every session. It was slid past three
times, each at a different shell construct. That is the point where a rule stops being a sentence
and becomes a gate. [`forcing-functions.md`](forcing-functions.md) lays out the hierarchy; this doc
is one worked instance of its second tier.

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
step before it. The gate never decides whether the chain would have been safe. It notices
that the caller gave up the ability to know.

A caller who wants the chain anyway writes `GH-CHAIN-OVERRIDE: <reason>` in an unquoted `#`
comment on the command, and the reason text is required. That check runs against the quote-masked
string too, so a token inside a `--body` string is inert and only a real shell comment counts.
Without an in-band override the only way past the gate is to mute it in settings, and a muted gate
protects nothing. The token makes the override written, reasoned, and visible in the transcript.

## It fails open, and the reason is where it sits

A hook matched on `Bash` runs before every Bash call the agent makes. A copy that throws, on
malformed stdin or a missing field or a bug of its own, cannot be allowed to block the tool, or every
command in the session dies with it and the hook is deleted within the hour. So every error path
logs to stderr and exits zero with nothing on stdout, which the platform reads as no opinion. Only a
well-formed deny emits JSON. It reads stdin and writes stdout, and that is its whole footprint. The
decision is an exported pure function, so a test suite exercises it offline against fixture strings, and a
few spawn tests pin the stdin-to-stdout contract, including the fail-open exit.

[`fail-contract.md`](fail-contract.md) argues for writing the floor sentence before choosing either
branch. Here the floor is short: this gate must never be the reason a Bash call cannot run. Every
fail path derives from that, and the derivation has a cost worth saying out loud. A gate that fails
open on its own errors is a gate whose absence looks like a pass. The same doc records the case
neither branch reaches, a runtime missing from `PATH`, and it applies here unchanged: a session
where the hook never started produces the same transcript as a session where nobody chained
anything.

## The ceiling

This is a string matcher over shell operators. It is not a shell parser and should not be read as
one. It catches the class it was built for, a state-changer that ended up downstream of an operator
in a one-liner nobody meant to chain past a failure. It does not catch command substitution,
`$(gh pr merge 42)` or the backtick form. It does not catch obfuscation: `$(echo gh) pr merge`, case
variation, `g''h pr merge`. Those take a real parser or a caller trying to get past the gate, and a
gate built for a slip has no business claiming to stop intent.

The verb list is a second ceiling. Only `gh` state-changers are gated. A `git` branch deletion
chained after a `gh pr merge` that failed is a destructive follow-up the gate never examines, and it
is one of the three recorded shapes. Widening to arbitrary destructive commands after any operator
would need a denylist, and a denylist wide enough to matter produces false denies until someone
mutes it. The accepted trade is a narrow gate that stays switched on.

## What a project weighs before installing it

The cost is not the code. Registered as a `PreToolUse` hook on `Bash`, the gate starts a process
before every Bash call in every session of the project that carries it, whether or not the call
mentions `gh`. Bash is the hottest tool an agent has. A hook on it is a tax on every command, paid to
close a gap that opens only on the few commands that merge, close, or delete. This repo made the
opposite call for its own prose linter, which could have been a Bash-matched hook and went to a git
`pre-commit` hook instead, where it runs once per commit rather than once per command. The same
question applies here, and it has no default answer.

Three questions settle it for a project. Does the agent drive `gh` at all, and does it merge,
close, or delete through it rather than leaving those to a person? If not, the gate is a silent no-op
with a process start attached. Is there a cheaper control that closes the same gap? A required status
check on the target branch refuses a merge on red server-side and costs nothing per call, so it is
the first thing to try; it says nothing about a close that follows a failed merge, and an admin
bypass walks straight through it. Has the prose rule already failed? One slip is a note. The project
that built this gate installed it after the third, against a rule re-injected every session, and
that is the order the hierarchy asks for. The gate earns its per-call cost once the sentence has
demonstrably stopped working, and it does not earn it before.

## The reference copy

The gate lives in the project that built it, spacemolt-harness, at
`.claude/hooks/gh-chain-merge-gate.ts`, registered in that project's `.claude/settings.json` as a
`PreToolUse` hook matched on `Bash` and invoked through bun. Its test file,
`test/gh-chain-merge-gate.test.ts`, keeps the recorded chain strings as regression fixtures and pins
the deny payload, the silent allow, and the fail-open exit. The hook depends on bun and nothing
else; a project without bun on `PATH` gets the missing-runtime case above instead of a gate.

The file's comments carry that project's issue numbers and review-round notes, and its deny
message cites two of that project's pull requests by number. A copy taken into another project
should replace those with the mechanism, keeping the pipe-through-`tail` example, since that is
the part that teaches.

## Related

[`forcing-functions.md`](forcing-functions.md): the hierarchy this gate sits in, at the tier where a
rule prose could not hold becomes a check on the call it judges.
[`fail-contract.md`](fail-contract.md): the floor sentence a gate's fail paths derive from, and the
missing-runtime case that neither branch of a fail-open hook reaches.
[`always-on-context-budget.md`](always-on-context-budget.md): the same question about what runs
unconditionally, asked of context rather than of process starts.
