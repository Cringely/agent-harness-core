---
name: subagent-prompting
description: Use when writing a brief for a subagent or authoring an agent definition. Covers brief anatomy, context provisioning, output and delivery contracts, model selection and effort settings, agent-def frontmatter gotchas, and per-model prompting temperament for Fable 5.2, Opus 5.5, Sonnet 5.5, and Haiku 5.5. agent-usage.md decides WHEN to delegate; this decides HOW to write the brief.
---

# Subagent Prompting

Codified from Anthropic's prompting best practices (platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) and the per-model pages for Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 (with the Fable 5.0, Opus 5.0 and Sonnet 5.0 pages as the 5.0 baselines), plus the context-engineering guidance at claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models. Refetched and reconciled 2026-11-11. The Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.2 prompting pages, the effort page and the thinking-troubleshooting page were read in full, all under platform.claude.com/docs/en. The best-practices page and the migration guides were only keyword-searched and the context-engineering post was not refetched, so claims resting on those keep their 2026-07-28 date. Earlier passes were 2026-07-28 and 2026-07-16 (against Opus 4.8). A claim in this file that those pages do not confirm is labelled "measured on 5.0, unverified on 5.x". `agent-usage.md` decides when to delegate; this file governs how to write the brief once you do. When sources disagree on a model fact, the live per-model doc page wins over both this file and the claude-api skill.

## Core rule: one well-specified turn

A subagent gets no second chances to ask. Front-load the full task specification in the first (usually only) message: task, intent, constraints, context, and what "done" looks like. This one is house practice rather than vendor guidance: the 2026-07-28 reconciliation found the Anthropic docs silent on anything subagent-specific here, offering only the general test that a colleague with no context should not be confused by the prompt. The 2026-11-11 refetch did not change that for the brief itself. The Fable 5.2 page does say a subagent tool's description should "tell the model how to brief a subagent that it starts". It has held up in use, so it stays, labelled for what it is. Ambiguous prompts drip-fed across turns reduce both token efficiency and output quality. The golden rule: if a colleague with no context on the task would be confused by the brief, the agent will be too.

## Brief anatomy

Every non-trivial agent brief carries these parts, in roughly this order:

1. **Role** (one sentence). "You are reviewing a Traefik config change for security regressions."
2. **Intent framing.** Give the reason, not just the request: `I'm working on [larger task] for [who/what it serves]. They need [what the output enables]. With that in mind: [request].` Models connect the task to relevant information instead of guessing intent.
3. **Context block** (see Context provisioning below).
4. **Task with done-criteria.** Explicit verbs ("change", "fix", "produce a table of X") not suggestions ("can you look at"). State scope explicitly when an instruction applies broadly: current models follow instructions literally and will not silently generalize "format the first section" to all sections. For a "fix X" task, ask for premise verification before any fix: state which sub-claims the evidence supports or refutes, with citations, before writing code. A refutation is a complete, successful outcome, not a failed task. Four of six issues in one recorded session had their stated cause overturned this way, and the technique caught a wrong claim inside the memory note that first argued for it.
5. **Boundaries.** What the agent must NOT do (files off-limits, no commits, no pushes, no merges, including any follow-up PR it opens, report-only). Merge/accept is a separate authority from finish-and-open-a-PR, and a brief that stops at "open the PR" reads as permission to merge it: five of six PRs in one wave self-merged when the briefs never said who merges. State it even when the project's own workflow docs already assign merge to a role. A rule that lives only in a wiki page is a convention, not a control, until the brief repeats it. For read-only investigation: "The deliverable is your assessment. Report findings and stop; do not apply fixes."
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
| Fable 5.2 | Adaptive only, always on. `thinking: disabled` returns 400. A prompt line asking it to answer directly does not stop it thinking at `medium` and above | `high` default. `xhigh` for the hardest long-running coding and agentic work where a gain is measured. `low` suits well-specified tasks and high-volume subagents. At `low` and `medium` agentic work stops early more often, so add the page's "finish the whole task" text | Delegation depends on the harness and the prompt wording. At `xhigh` and `max` it has used subagents to review its own work. Subagents can be a large part of session cost, so check which model they run on. It treats an instruction containing "never" as absolute and follows style rules closely, so a hard limit can make its prose choppy |
| Opus 5.5 | Adaptive only, always on. `thinking: disabled` returns 400 at every effort | `medium` default (Opus 5.0 was `high`). In Anthropic's testing `medium` matches or exceeds Opus 5.0 `high` on coding and knowledge-work evals. It thinks more per turn at the same level, most at `xhigh` and `max`. Lower the effort first to cut thinking | Sustains multihour work with parallel subagents and little oversight. Responds to elapsed-time signals in multiagent setups. The page does not restate the Opus 5.0 delegation cap |
| Sonnet 5.5 | Adaptive on by default. `disabled` returns 400, send `between_tools` instead (works at `high` or below) | `high` default. Levels are recalibrated against Sonnet 5.0, so re-sweep. For agentic coding start at `medium` for well-specified tasks and `high` for harder ones | At `xhigh` and `max` it can start its own review rounds, sometimes with subagents. At `low` it can skip verifying a change, and at `low` and `medium` it sometimes checks in before the work is done. Forced `tool_choice` returns 400 |
| Haiku 5.5 | Adaptive on by default. `disabled` is accepted at `high` or below and returns 400 at `xhigh` and `max` | `medium` default. First Haiku with effort levels. In long agent prompts at `low` it is more likely to skip a search, stop early or skip a check. `high` for strict instruction following | Built for "classification, routing, extraction, and subagent tasks". At `low` and `medium` it sometimes reports a code change done without running a check |

Measured on the 5.0 releases (the Haiku 4.5 row is carried from the 2026-07-16 pass). The 5.5 and 5.2 pages do not restate these claims. For two rows they say something different: the Sonnet 5.5 page says its effort levels are recalibrated against Sonnet 5.0, and the Fable 5.2 page says how much it delegates depends on the harness and tasks. Treat the table as history rather than current guidance.

| Model | Claim |
|---|---|
| Fable 5.0 | `low` and `medium` "often exceed `xhigh` performance on prior models". Dispatches parallel subagents more readily than prior models. Long-lived subagents that keep context across subtasks save time and cost |
| Opus 5.0 | Disabling thinking caps effort at `high` or below. Delegates readily, coordinates subagent teams well, writer-verifier patterns hold, few overwrite collisions. Cap delegation explicitly on cost-sensitive workloads because it over-delegates by default |
| Sonnet 5.0 | `medium` is about Sonnet 4.6 `high` and `high` is about Sonnet 4.6 `max`. More agentic than 4.6, runs self-verification loops readily, less tool-eager with thinking disabled |
| Haiku 4.5 | Used a `budget_tokens` thinking budget and had no `effort` (the page for Haiku 5.5 says so). The earlier note "thinking off, no adaptive support" is unverified. Mechanical, high-volume, low-stakes subtasks only (carried forward unverified). The models overview lists no Haiku 5.0 |

Haiku 5.5 is the first Haiku with effort levels, and its prompting page says effort "replaces the thinking budget (`budget_tokens`) that Claude Haiku 4.5 used". Opus 4.8 is dropped as superseded. `budget_tokens` returns 400 on Claude 4.7 and later, so manual thinking budgets are gone and adaptive thinking plus `effort` replaces them. To get less thinking on Sonnet 5.5, Haiku 5.5 and Fable 5.2, lower the effort level. The docs say a prompt line asking for less thinking does not reliably reduce it on those three. Prefilled assistant responses also 400 from Claude 4.6 onward. Measured on Sonnet 5.0, it rejects non-default `temperature`, `top_p` and `top_k` with a 400, and its tokenizer emits roughly 30% more tokens for the same text than Sonnet 4.6, so any `max_tokens` tuned against 4.6 is short.

## Verification instructions depend on the model

Opus 5.0 (the Opus 5.5 page is silent) verifies its own work well without being asked. Verification instructions carried over from prompts tuned for earlier models cause over-verification, and the documented guidance is to remove them rather than soften them. For an Opus agent, audit briefs for "double-check," "verify before claiming," "make sure you confirm" and delete rather than reword.

Haiku 5.5 and Sonnet 5.5 can skip the check instead. The Haiku 5.5 page says "At `low` and `medium` effort, Claude Haiku 5.5 sometimes reports a code change as done without running a check". The Sonnet 5.5 page says it "generally checks its work before it reports a change as done" but at `low` effort "sometimes reports a change as done without running a check that exercises it". Both pages say to add a paragraph to the system prompt if you see the behavior, and it opens "When you change code that can be run, built, or type-checked, run a real check that exercises the change before reporting it done". A code-changing brief for either model at `low` effort (and at `medium` for Haiku 5.5) carries a check-before-done line and names the check (the tests, the type-checker, the build or the changed command). Copy the full paragraph from the Haiku 5.5 prompting page. The effect is reported per model. For Haiku 5.5 the model checked its changes more often and its performance improved, at the cost of more tokens. For Sonnet 5.5 at `low` effort skipped or superficial checks become rare, with no measurable change in task quality and only a slightly higher cost per task.

Two more current-model facts. Sonnet 5.5 at `xhigh` and `max` can start its own review rounds, sometimes with subagents. Its page gives a stop-and-report snippet that cut cost by about a third in Anthropic's testing at `max`. Fable 5.2 at `xhigh` and `max` has used subagents to review its own work. For Fable 5.0 (the 5.2 page does not say whether it still applies) the page recommends fresh-context verifier subagents over self-critique on long runs, the opposite of the Opus 5.0 advice, and the pages do not reconcile the two (inferred).

The scope here is agent briefs, and only agent briefs. It does not reach any operational or safety check, and the distinction is worth stating precisely because a later editing pass acting on this literally could strip something load-bearing. Untouched: the Verification Gates and backup-confirmation steps in `change-management.md`, the Pre-Work Security Check in `security.md`, the evidence discipline in `no-overclaim.md`, the `superpowers:verification-before-completion` skill, and an explicit premise-verification instruction ("confirm the claimed defect is real, with citations, before fixing it") — that checks whether the world matches the claim, not the model re-examining its own reasoning, so it survives an edit pass run under this rule. Those check whether the world is in the state you believe it is, which no amount of model self-verification substitutes for. What this rule removes is the instruction telling a model to re-examine its own reasoning, which it now does unprompted.

Two related Opus 5.0 behaviors to prompt around (unverified on 5.5). Effort controls thinking volume, not response length, so conciseness needs its own explicit instruction and will not come from lowering effort. And the model narrates intent before tool calls and narrates its own self-corrections more than needed; ask for the conclusion, not the running commentary.

With thinking disabled, Opus 5.0 can emit a tool call as visible text without firing it, and can leak internal XML tags into output. Keep thinking on and drop to `low` effort instead of disabling. Opus 5.5 cannot disable thinking at all.

Cross-model constants: verbosity self-calibrates to task complexity, so drop "summarize every N tool calls" scaffolding; the models report progress natively. Code review harnesses that say "only report high-severity" get faithful literal compliance and lower measured recall, so ask for coverage and filter downstream.

Two model-specific caveats on that. Literal instruction-following is documented for Sonnet 5.0 in particular (the Sonnet 5.5 page has no such section), and most sharply at low effort: a scoped instruction stays scoped, and it will not silently generalize "format the first section" to the whole document. Fable 5.0 runs the opposite risk, over-elaborating at high effort by surveying options it did not pursue and explaining root causes at length, which needs an explicit brevity instruction rather than a lower effort setting (unverified on 5.2). Fable 5.2 treats an instruction containing "never" as absolute and follows style rules closely (a hard limit such as "20 words or fewer" can make prose choppy), so write "ask for approval before deleting files" rather than "never delete files" when the agent should keep judgment over the action.

Context awareness is now a general behavior rather than a Fable 5.0 quirk. That generalization is inferred: the platform-wide prompting doc states the self-stop risk without scoping it to a model, and it has not been reconfirmed against each per-model page. The Fable 5.2 and Sonnet 5.5 pages do corroborate the budget half: removing a large token budget from the prompt lowered cost with equivalent performance on Fable 5.2, and on Sonnet 5.5 a harness-added token countdown can make the model treat a genuine user message as possible injection. These models track their own remaining token budget and may wrap up early as they approach it, ending a task with a summary instead of finishing the work. Never surface remaining-context counts or token budgets to an agent. When a long task genuinely runs near the limit, tell the agent that compaction or memory will carry the context forward, so it keeps working instead of self-summarizing.

Prompts written for older models are often too prescriptive for current ones and reduce quality. These models are more responsive to the system prompt than their predecessors and can now overtrigger on emphatic language, so "CRITICAL: You MUST use this tool when..." becomes "Use this tool when...". Delete "if in doubt, use X" defaults. Replace step-by-step reasoning plans with "think thoroughly", because Claude's reasoning frequently exceeds what a human would prescribe.

One new failure mode to prompt against: Opus 4.5 and 4.6 are documented as tending to overengineer, creating extra files, adding abstractions nobody asked for, and building in unrequested flexibility. The Opus 5.0 page does not repeat this (2026-07-28 pass), so treat it as unconfirmed for Opus 5.0 rather than resolved either way. The Sonnet 5.5 page documents a related behavior: the model "tends to add tests, documentation, and small supporting files that fit your repository's conventions, even when you don't ask for them", at every effort level and more at higher effort. Naming the scope boundary explicitly in implementation briefs costs one sentence and is worth it regardless of which model runs them.

## Snippet library

Full library of Anthropic-tested brief inserts lives in `~/.claude/snippets/agent-briefs.md`; read it when composing a brief. The three highest-frequency snippets, inline:

**Autonomy (any agent running unattended):**
> You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task. For reversible actions that follow from the original request, proceed without asking. Before ending your turn, check your last paragraph. If it is a plan, a question, or a promise about work you have not done, do that work now with tool calls. End your turn only when the task is complete or you are blocked on input only the user can provide.

**Assessment-only boundary (investigation/review agents):**
> The deliverable is your assessment. Report your findings and stop. Don't apply a fix until asked. Before any command that changes system state, check the evidence actually supports that specific action.

**Review coverage (reviewer agents; pair with downstream filtering):**
> Report every issue you find, including ones you are uncertain about or consider low-severity. Do not filter for importance or confidence at this stage. For each finding, include your confidence level and an estimated severity so a downstream filter can rank them.

## Fable orchestrator notes

When this session itself runs on Fable and is the one dispatching. These notes are measured on Fable 5.0. The Fable 5.2 page says how much it delegates depends on the harness and the tasks, and that subagents can account for a large part of what a session costs. Read the delegation lines below as defaults to test on 5.2, not as findings.

- Delegate independent subtasks and keep working while they run, provided each agent clears agent-usage.md's thresholds. Prefer async (background) agents over blocking, and reuse a running agent via SendMessage instead of respawning; a long-lived agent keeps its context and cache.
- Never ask an agent to transcribe or explain its internal reasoning in output text; that triggers `reasoning_extraction` refusals. Ask for conclusions and evidence instead.
- Do not surface remaining-context counts to agents; it induces premature wrap-up.
