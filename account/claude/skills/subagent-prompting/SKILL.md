---
name: subagent-prompting
description: Use when writing a brief for a subagent or authoring an agent definition. Covers brief anatomy, context provisioning, output and delivery contracts, model selection and effort settings, agent-def frontmatter gotchas, and per-model prompting temperament for Fable 5, Opus 5, Sonnet 5, and Haiku 4.5. agent-usage.md decides WHEN to delegate; this decides HOW to write the brief.
---

# Subagent Prompting

Codified from Anthropic's prompting best practices (platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) and the per-model pages for Fable 5, Sonnet 5, and Opus 5, plus the context-engineering guidance at claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models. Refetched and reconciled 2026-07-28; the prior pass was 2026-07-16 against Opus 4.8. `agent-usage.md` decides when to delegate; this file governs how to write the brief once you do. When sources disagree on a model fact, the live per-model doc page wins over both this file and the claude-api skill.

## Core rule: one well-specified turn

A subagent gets no second chances to ask. Front-load the full task specification in the first (usually only) message: task, intent, constraints, context, and what "done" looks like. This one is house practice rather than vendor guidance: the 2026-07-28 reconciliation found the Anthropic docs silent on anything subagent-specific here, offering only the general test that a colleague with no context should not be confused by the prompt. It has held up in use, so it stays, labelled for what it is. Ambiguous prompts drip-fed across turns reduce both token efficiency and output quality. The golden rule: if a colleague with no context on the task would be confused by the brief, the agent will be too.

## Brief anatomy

Every non-trivial agent brief carries these parts, in roughly this order:

1. **Role** (one sentence). "You are reviewing a Traefik config change for security regressions."
2. **Intent framing.** Give the reason, not just the request: `I'm working on [larger task] for [who/what it serves]. They need [what the output enables]. With that in mind: [request].` Models connect the task to relevant information instead of guessing intent.
3. **Context block** (see Context provisioning below).
4. **Task with done-criteria.** Explicit verbs ("change", "fix", "produce a table of X") not suggestions ("can you look at"). State scope explicitly when an instruction applies broadly: current models follow instructions literally and will not silently generalize "format the first section" to all sections.
5. **Boundaries.** What the agent must NOT do (files off-limits, no commits, no pushes, report-only). For read-only investigation: "The deliverable is your assessment. Report findings and stop; do not apply fixes."
6. **Output contract.** Exact shape of the report: format, length, what to include and omit. What the agent writes is data for the dispatcher to act on, so say so: "Your report is raw data for me, not user-facing prose."

7. **Delivery mechanism.** Say how the finished work reaches you, not just what shape it takes. A background or teammate agent's plain text output is invisible to the dispatcher, so a brief saying "report in your final message" specifies a report nobody receives. The channel that delivers is a file: name an absolute path under the session scratchpad and tell the agent to write there, quoting the block below. Per the operator directive of 2026-08-02 recorded in `agent-usage.md`, agent to dispatcher is scratch file always, regardless of size, and `SendMessage` is a dispatcher-to-agent channel only, never a return path.

```
Write your report to:
  <scratchpad>/<task>-report.md
Nothing else is read. Your final message does not reach me.
```

Bitten three times when this section was first written, twice in one session on 2026-07-27: reviewers completed real work, went idle, and delivered nothing, because the brief specified the output format and never the transport. `agent-usage.md` puts the current count at five silent agents. An output contract without a delivery line is a report written into a drawer, and an idle notification means "go read the file", not a finished handoff. See [[reviewer-agent-delivery]] for the original incident, and read its Apply section as history: it predates the 2026-08-02 directive and still prescribes a `SendMessage` back.

Check the type's tool grant before naming a path. `appsec-sme`, `governance-sme`, `Explore`, and `Plan` hold no Write tool, so telling one to write a report file is an impossible instruction; the well-behaved failure is a BLOCKED ON DELIVERY report handing the body back for the dispatcher to save. Pick a type that holds Write (`task-reviewer`, `adversarial-reviewer`, `general-purpose`, `senior-developer`) or accept the handback and save the file yourself. Never add `memory:` to an advisory def to buy it a Write tool, for the reason given under Model selection and effort below.

Structure long or mixed briefs with XML tags (`<context>`, `<task>`, `<constraints>`, `<output>`); wrap examples in `<example>` tags. For long inputs (20k+ tokens) put the data at the top and the task at the bottom (queries after long documents improve quality by up to 30%), and ask the agent to quote relevant passages before acting on them.

## Caveman instruction passing

Agent briefs are written caveman-compressed: drop articles, filler, pleasantries, and hedging. Compression targets style, never substance. Quoted snippets and templates (the intent-framing template above, everything in the snippet library) stay verbatim; compression applies only to the surrounding brief text. Also keep verbatim and uncompressed:

- File paths, hostnames, commands, API names, error strings, identifiers
- Acceptance criteria and done-conditions
- Multi-step sequences where order matters (number them; keep conjunctions)
- Anything whose compression creates ambiguity (caveman Auto-Clarity rule applies to briefs)

Positive instructions compress better and steer better than negative ones ("write flowing prose paragraphs" beats "do not use markdown"). Request compressed output back: instruct the agent to return findings in terse, table-or-fragment form unless the deliverable is prose. The cavecrew agents already do this; general-purpose agents need it stated in the brief.

## Context provisioning

Agents (except forks) start with an empty context window. Every brief supplies context one of two ways:

- **Inline** (preferred for small, load-bearing facts): paste the relevant MEMORY.md excerpt, non-sensitive host details, decision constraints, or prior findings directly into the `<context>` block. Never make an agent rediscover something the session already knows.
- **By pointer** (for large or optional context): name the files to read first and say why. Standing pointers: `~/.claude/projects/{{HOME_SLUG}}/memory/MEMORY.md` (index; follow links to individual notes), the latest handoff at `{{OBSIDIAN_VAULT}}/Handoffs/handoff-latest.md`, and the binding rules in `~/.claude/rules/` when the task touches security, change management, or SSH. Be prescriptive: "Read X and Y before starting; they contain the constraints that apply."

Rule of thumb: inline anything under ~20 lines; point at anything larger. An agent that reads two files itself costs less than a wrong answer from a starved one. Never inline secrets; point at the secrets path instead.

Ground the agent against hallucination: "Never speculate about code you have not opened. If a file is referenced, read it before answering."

## Model selection and effort

Model choice applies on all surfaces (Agent tool `model` param, agent definition frontmatter, API code). The effort column applies only where effort is settable: API code (`output_config.effort`) and agent definitions that expose it. Which tier a dispatch gets is `agent-usage.md`'s call; for prose deliverables, see its "Pin Fable on prose deliverables" section.

Two agent-def frontmatter facts, both verified against code.claude.com/docs/en/sub-agents on 2026-07-27, both of which fail silently when you get them wrong:

- The effort key is **`effort`**, not `reasoning_effort`. Confirmed against the frontmatter table, which lists `effort` and no `reasoning_effort` anywhere. What the docs do *not* state is that an unrecognized key is silently ignored rather than rejected; that part is inferred from observed behavior, since six local agent-defs carried `reasoning_effort` for months, loaded without complaint, and every one ran at inherited session effort. Treat the key name as documented and the silent-ignore as observed-but-undocumented.
- Setting **`memory:`** (values `user`, `project`, `local`) automatically enables Read, Write, and Edit "so the subagent can manage its memory files." The docs state no path scoping, so treat the write grant as unrestricted. The grant is stated unconditionally and separately from `tools:`, so it functionally overrides an allowlist that omits them. An advisory or review agent that must stay read-only therefore cannot have `memory:` at all. Pick one: cross-session memory, or a genuinely read-only agent. Caveat added 2026-07-28: `memory:` has no effect at all when auto memory is off, via the `autoMemoryEnabled` setting or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`.

When a def omits `memory:` deliberately, leave a one-line comment saying why, or the next pass adds it back as an obvious improvement.

| Model | Thinking default | Effort guidance | Subagent/tool temperament |
|---|---|---|---|
| Fable 5 | Adaptive only; no manual budgets, summarized-only thinking output | `high` default; `xhigh` for capability-sensitive work; `low`/`medium` liberally for routine work, where they "often exceed `xhigh` performance on prior models" | Dispatches parallel subagents more readily than prior models; long-lived subagents that keep context across subtasks save time and cost |
| Opus 5 | On by default, changed from 4.8. Disabling thinking caps effort at `high` or below | `high` default; use `low`/`medium` liberally as the primary control for cost and latency wherever quality holds; `xhigh` for demanding coding and agentic work | Delegates readily; coordinates subagent teams well, writer-verifier patterns hold, few overwrite collisions. Cap delegation explicitly on cost-sensitive workloads — it over-delegates by default |
| Sonnet 5 | Adaptive on by default; disable with `thinking: {type: "disabled"}` | `high` default. Sonnet 5 `medium` ≈ Sonnet 4.6 `high`; Sonnet 5 `high` ≈ Sonnet 4.6 `max` | More agentic than 4.6, reaches for tools and runs self-verification loops readily; less tool-eager with thinking disabled |
| Haiku 4.5 | Off; no adaptive support | No `effort` support | Mechanical, high-volume, low-stakes subtasks only |

Haiku 4.5 has no prompting page among the three per-model docs; its row is carried forward unverified from the 2026-07-16 pass. Opus 4.8 is dropped as superseded. `budget_tokens` returns 400 on Claude 4.7 and later, so manual thinking budgets are gone; adaptive thinking plus `effort` replaces them. Prefilled assistant responses also 400 from Claude 4.6 onward. Sonnet 5 rejects non-default `temperature`, `top_p`, and `top_k` with a 400, and its tokenizer emits roughly 30% more tokens for the same text than Sonnet 4.6, so any `max_tokens` tuned against 4.6 is now short.

## Stop telling agents to verify

Opus 5 verifies its own work well without being asked. Verification instructions carried over from prompts tuned for earlier models cause over-verification, and the documented guidance is to remove them rather than soften them. Audit agent briefs for "double-check," "verify before claiming," "make sure you confirm" and delete rather than reword.

The scope here is agent briefs, and only agent briefs. It does not reach any operational or safety check, and the distinction is worth stating precisely because a later editing pass acting on this literally could strip something load-bearing. Untouched: the Verification Gates and backup-confirmation steps in `change-management.md`, the Pre-Work Security Check in `security.md`, the evidence discipline in `no-overclaim.md`, and the `superpowers:verification-before-completion` skill. Those check whether the world is in the state you believe it is, which no amount of model self-verification substitutes for. What this rule removes is the instruction telling a model to re-examine its own reasoning, which it now does unprompted.

Two related Opus 5 behaviors to prompt around. Effort controls thinking volume, not response length, so conciseness needs its own explicit instruction and will not come from lowering effort. And the model narrates intent before tool calls and narrates its own self-corrections more than needed; ask for the conclusion, not the running commentary.

With thinking disabled, Opus 5 can emit a tool call as visible text without firing it, and can leak internal XML tags into output. Keep thinking on and drop to `low` effort instead of disabling.

Cross-model constants: verbosity self-calibrates to task complexity, so drop "summarize every N tool calls" scaffolding; the models report progress natively. Code review harnesses that say "only report high-severity" get faithful literal compliance and lower measured recall, so ask for coverage and filter downstream.

Two model-specific caveats on that. Literal instruction-following is documented for Sonnet 5 in particular, and most sharply at low effort: a scoped instruction stays scoped, and it will not silently generalize "format the first section" to the whole document. Fable 5 runs the opposite risk, over-elaborating at high effort by surveying options it did not pursue and explaining root causes at length, which needs an explicit brevity instruction rather than a lower effort setting.

Context awareness is now a general behavior rather than a Fable 5 quirk. That generalization is inferred: the platform-wide prompting doc states the self-stop risk without scoping it to a model, and it has not been reconfirmed against each per-model page. These models track their own remaining token budget and may wrap up early as they approach it, ending a task with a summary instead of finishing the work. Never surface remaining-context counts or token budgets to an agent. When a long task genuinely runs near the limit, tell the agent that compaction or memory will carry the context forward, so it keeps working instead of self-summarizing.

Prompts written for older models are often too prescriptive for current ones and reduce quality. These models are more responsive to the system prompt than their predecessors and can now overtrigger on emphatic language, so "CRITICAL: You MUST use this tool when..." becomes "Use this tool when...". Delete "if in doubt, use X" defaults. Replace step-by-step reasoning plans with "think thoroughly", because Claude's reasoning frequently exceeds what a human would prescribe.

One new failure mode to prompt against: Opus 4.5 and 4.6 are documented as tending to overengineer, creating extra files, adding abstractions nobody asked for, and building in unrequested flexibility. The Opus 5 page does not repeat this, so treat it as unconfirmed for Opus 5 rather than resolved either way. Naming the scope boundary explicitly in implementation briefs costs one sentence and is worth it regardless of which model runs them.

## Snippet library

Full library of Anthropic-tested brief inserts lives in `~/.claude/snippets/agent-briefs.md`; read it when composing a brief. The three highest-frequency snippets, inline:

**Autonomy (any agent running unattended):**
> You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task. For reversible actions that follow from the original request, proceed without asking. Before ending your turn, check your last paragraph. If it is a plan, a question, or a promise about work you have not done, do that work now with tool calls. End your turn only when the task is complete or you are blocked on input only the user can provide.

**Assessment-only boundary (investigation/review agents):**
> The deliverable is your assessment. Report your findings and stop. Don't apply a fix until asked. Before any command that changes system state, check the evidence actually supports that specific action.

**Review coverage (reviewer agents; pair with downstream filtering):**
> Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage. For each finding, include your confidence level and an estimated severity so a downstream filter can rank them.

## Fable 5 orchestrator notes

When this session itself runs on Fable 5 and is the one dispatching:

- Delegate independent subtasks and keep working while they run, provided each agent clears agent-usage.md's thresholds. Prefer async (background) agents over blocking, and reuse a running agent via SendMessage instead of respawning; a long-lived agent keeps its context and cache.
- Never ask an agent to transcribe or explain its internal reasoning in output text; that triggers `reasoning_extraction` refusals. Ask for conclusions and evidence instead.
- Do not surface remaining-context counts to agents; it induces premature wrap-up.
