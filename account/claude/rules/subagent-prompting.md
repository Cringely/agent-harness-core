# Subagent Prompting

Full guidance lives in the `subagent-prompting` skill. Invoke it before writing any non-trivial agent brief or authoring an agent definition. It carries brief anatomy, context provisioning, the snippet library pointer, per-model effort tables, and the reconciliation notes against Anthropic's per-model docs (last refetched 2026-07-28).

`agent-usage.md` decides when to delegate. The skill decides how to write the brief once you do.

## Resident facts

These stay here because each one fails silently, and a skill that does not get invoked cannot warn you.

- The agent-def frontmatter key is `effort`, not `reasoning_effort`. An unrecognized key is ignored without error, so a typo runs the agent at inherited session effort forever. Six local defs carried the wrong key for months.
- Setting `memory:` in an agent def automatically grants Read, Write, and Edit, overriding a `tools:` allowlist that omits them. An agent that must stay read-only cannot have `memory:` at all.
- A background or teammate agent's plain text output never reaches the dispatcher, so a brief that says "report in your final message" produces an agent that does real work and delivers nothing. The delivery path is an absolute scratch-file path the brief tells the agent to write to, never a `SendMessage` back, which `agent-usage.md` rules out in that direction. Counted three times when this rule was written, five in `agent-usage.md`'s current tally. That file also carries which agent types hold no Write tool and therefore cannot be given a path at all.
- Never surface remaining-context counts or token budgets to an agent. It induces premature self-summarizing instead of finishing the task.
- On Opus 5, delete verification instructions from briefs rather than rewording them. Scope is briefs only; the operational gates in `change-management.md`, `security.md`, and `no-overclaim.md` are untouched.
