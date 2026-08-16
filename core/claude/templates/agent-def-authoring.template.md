<!--
Structural source: `microsoft/hve-core`, `.github/skills/rpi/rpi-research/SKILL.md` and its RPI
siblings (license: MIT). HVE's RPI skills all share a nine-part contract (Goal, Flow, Inputs,
Success Criteria, Constraints, Conversation guidance, Stop Rules, Handoff, Final Response), built
for a multi-turn, user-facing planning/research/implementation skill. This template borrows that
shape, not the text, and drops or merges the parts that don't fit a single-shot subagent dispatch.
See the "What changed from RPI" section at the bottom for the specific calls made and why.
-->

# Agent definition authoring template

Copy this file to `core/claude/agents/<name>.md`, fill every `{{...}}` slot, delete this comment
block and the "What changed from RPI" section, delete any part below marked optional that doesn't
apply, and delete this line.

## Frontmatter

This is the actual shape this repo's agent defs use. Read one before deviating from it
(`core/claude/agents/task-reviewer.md` is a good baseline).

```yaml
---
name: {{kebab-case-name, matches the filename without .md}}
description: {{one sentence, third person, states what the agent is for and when to reach for it}}
model: {{haiku | sonnet | inherit}}
effort: {{low | medium | high | xhigh}}
tools: {{comma-separated tool list; omit the field entirely only if the agent needs every tool}}
---
```

The `effort` key is not `reasoning_effort`. That typo is silently ignored, not rejected, so a
misspelled key runs the agent at whatever effort the dispatching session inherited, forever, with
no error to catch it. Six agent defs in this account carried the wrong key for months before
anyone noticed the effort tier was never actually changing.

Do not add `memory:` unless the agent actually needs to read and write persistent memory notes.
Setting it grants Read, Write, and Edit outright, overriding a narrower `tools:` allowlist. An
agent that must stay read-only cannot carry `memory:` at all. `core/claude/agents/research-scout.md`
documents this trap in its own frontmatter comment; point at it rather than re-explaining it here.

**The description line is the one sentence that matters most in this file.** It is what the
dispatching model routes on when deciding whether this agent fits a task, and unlike the body
below, it loads into context every session, not just when the agent is dispatched. A vague
description ("helps with reviews") gets skipped by a dispatcher that can't tell whether it fits;
an overlong one taxes every session whether or not this agent ever runs. State the job and the
trigger condition in one line, third person, plain and specific.

## {{Agent Name}}

Optional one-paragraph identity/goal statement, the RPI Goal part, kept because it earns its
place. A subagent with no sense of what it's for defaults to generic behavior on the first
ambiguous instruction. State the role and its purpose in a sentence or two, the way
`task-reviewer.md` opens with "You review one task or change diff at a time, with a context that
did not author it and did not watch it get written." Skip a numbered Flow section unless the
agent's job is actually a fixed sequence; most roles in this repo read as prose method sections
instead (see `## Method` in `task-reviewer.md`) because the actual judgment calls don't reduce to
a checklist.

## Inputs

What this agent needs handed to it at dispatch time: files, paths, a diff, a work order. If the
dispatcher may hand over a scratch-file path instead of pasting material inline, say so, and say
how the agent treats what it finds there (see "Working files" in `task-reviewer.md`).

## Constraints: what this agent must NOT do

The NOT-list. Every sibling role this agent could be confused with, and every action that would
quietly break the division of labor this agent exists inside, goes here by name:

- Never {{action reserved for a specific other agent, name it}}. That's `{{sibling-agent-name}}`'s job.
- Never {{write outside its granted scope / make live calls / edit the code it's reviewing / etc.}}.
- {{Add every boundary this repo has already learned the hard way. A NOT-list with only one entry
  usually means the second and third boundary weren't written down yet, not that they don't exist.}}

## Stop Rules

Name every condition under which this agent should stop and report back rather than push forward
on a guess:

- Stop and report when {{a precondition is violated, e.g. reviewing its own authored work}}.
- Stop and report when {{a required input is missing or unreadable}}.
- Stop and report when {{the task falls outside this agent's granted tools or scope}}.

A Stop Rule with no report path is a dead end, not a safeguard. Pair each one with what the agent
should say when it stops: a specific verdict token, a specific escalation, a specific "ask the
user" trigger.

## Output Contract

What comes back, in what shape, and where it goes. Cover:

- **Return channel.** A message back to the dispatcher, a written scratch file with a pointer
  message, or both. Per `~/.claude/rules/agent-usage.md`: a scratch file only for bulk the
  dispatcher wants a pointer to, never for something that would have fit in the final message.
- **Delivery path for background/teammate dispatches.** If this agent can run detached, its final
  message never reaches the dispatcher on its own. The def must name `SendMessage` to `main` as
  the explicit delivery path, or the result is silently lost (bitten three times per
  `~/.claude/rules/subagent-prompting.md`).
- **Shape.** Verdict token, severity counts, one line per finding, a table, whatever this
  agent's consumers actually parse. Say it precisely enough that a downstream agent or hook could
  depend on the shape.
- **Evidence tier.** If this agent makes claims of success, completion, or verification, it tags
  each as verified (with the check that verified it) or assumed (with the reason verification was
  skipped), per `~/.claude/rules/no-overclaim.md`. An untagged claim is itself a defect in the
  output.

---

## What changed from RPI, and why

HVE's RPI skills are long-running, multi-turn, user-facing chat skills with their own artifact
files and a live `vscode_askQuestions` checkpoint loop. An agent def here is a single-shot
subagent dispatch: one brief in, one report out. There's no end user to check in with mid-task,
and that changes how several of the nine RPI parts have to map over:

- **Conversation guidance, dropped entirely.** RPI's Conversation guidance governs when to
  message the user mid-task and how to phrase a live checkpoint question. A dispatched subagent
  here has no user to check in with mid-task; its only conversational partner is the dispatcher,
  and that exchange is exactly the Output Contract below, not a separate live protocol.
- **Handoff and Final Response, merged into one Output Contract.** RPI splits what a durable
  artifact carries forward (Handoff) from what the chat response says at the end (Final Response),
  because RPI artifacts persist across skill invocations and phases. An agent def's single dispatch
  has no second phase to hand off to and no separate chat surface from its report. Both parts
  answer the same question here, "what does the dispatcher get back", so one section covers it.
- **Success Criteria, folded into Output Contract and Stop Rules rather than kept standalone.**
  RPI states success criteria separately because a long research or planning cycle needs an
  explicit definition of "done enough to hand off." A single-shot agent's success criteria are
  just "the Output Contract was met and no Stop Rule fired," so a standalone section would restate
  the other two.
- **Flow, loosened from a numbered sequence to prose Method, agent's choice.** RPI's Flow is a
  strict ten-step numbered sequence because RPI cycles (wave after wave, cycle after cycle) really
  are sequential. Most agent defs in this repo are one-shot judgment calls (review a diff, triage
  a backlog) where the actual work is "read carefully, apply the same handful of checks in
  whatever order the material demands," not a fixed pipeline. A forced numbered Flow would read
  as false precision here. An agent whose job really is a sequence (a multi-phase runbook) should
  still number it.

Inputs, Constraints, and Stop Rules carried over close to as-is. They answer the same question for
a subagent as they do for a chat skill, and the parts didn't need reshaping.
