# Agent Usage Guidance

## Principle

Two resources to protect, not one. Main context window: an agent absorbing a long search in a sandbox and handing back a summary beats the raw tool results landing in the main window. Premium model quota: a coordinator turn on Opus or Fable costs far more per token than a Haiku agent doing the same fetch. Rest of this file assumes session limits bind hardest on the expensive model — operator's read of how the quota behaves, not a published figure. Treat as premise; if wrong, the routing below aims at the wrong target.

Coordinator is an interpreter, not an operator: reads agent reports, decides what they mean, instructs the next move. Its tokens buy judgment — deciding, arbitrating, planning, reviewing — not transcribing build output or paging through directory listings.

## What delegation actually costs

A subagent is not free. Every spawn pays a full system prompt on the agent's model, the brief costs coordinator output tokens, and the agent's report still lands in coordinator context when read back off disk. For output that is already small — `ls` on a normal directory, one `ping`, a grep for a string you can already name — the brief is longer than the command it replaces, so delegating spends *more* premium tokens than running it inline, plus spawn latency.

Delegation pays when the agent absorbs volume the coordinator would otherwise read. Route on output volume and call count, never on whether the task looks like "a command."

**Delegate when any of these holds:**

- Output would run past roughly 50 lines in the main window — build and test runs, `docker logs`, recursive listings, full-file reads, log tails, dependency trees
- Answering takes 2 or more tool calls
- The task writes anything (implementation, refactor, config edit); plan execution and review are already unconditional above
- The output needs filtering or judgment before the coordinator can use it

**Run inline only when all three hold:** one call, output comfortably under ~50 lines, and the coordinator needs that raw text verbatim to decide the next move. One carve-out: a single-line trivial edit with no logic in it — typo, version bump, comment — stays inline. Matches the review exemption below, and follows from the cost argument: a brief describing a one-line change is longer than the change.

Two provenance notes, so the rule stays revisable instead of hardening into doctrine. The 2-call threshold is an operator judgment call, not a number any Anthropic documentation supports; the research this file was reconciled against says nothing about call-count thresholds. It also sits in tension with the Opus 5 guidance in `subagent-prompting.md`, which says that model already over-delegates by default and recommends capping delegation on cost-sensitive workloads. Where the dispatch lands on a premium model rather than a cheap pinned one, hold nearer the old 4-call bar and let the model's own delegation instinct do the work.

## Pin cheap models on mechanical agents

Delegation defeats itself if the agent runs premium. Any fetch-and-report job — listing, tailing, grepping, running a build, checking a service, collecting a diff — gets `model: haiku` (Agent tool `model` parameter, or `model:` in the agent definition's frontmatter). Reserve Opus for judgment work: review, architecture, arbitration, synthesis across several agents' findings. Fable is the prose tier (below).

`Explore` looks like it belongs in the pinned group and doesn't. Choosing search breadth, deciding which naming conventions to try, knowing when a sweep is done — judgment, not fetching. A cheap model doing it badly costs more in missed results than it saves in tokens.

The mechanism is the same in all three places: the Agent tool's `model` parameter, `model:` in an agent definition's frontmatter, and `opts.model` on a Workflow `agent()` call. A workflow script is where this gets missed, because omitting `model` there silently inherits the coordinator's tier for every agent in the fan-out, and the Workflow tool's own guidance says to default to omitting it. That guidance loses to this rule. Set the tier per `agent()` call, not per workflow: a five-lens fan-out usually mixes tiers, since the lens that reads code semantics and the lens that downloads an artifact and sums a column are not the same kind of work. Adversarial verify and final synthesis stay premium. (Operator directive 2026-08-22, after a workflow ran every agent on Opus because the rule named only the first two mechanisms.)

## Pin Fable on prose deliverables

Any subagent whose deliverable is prose a person will read gets `model: fable` on the dispatch. That covers docs, policy and runbook sections, memos, reports, deck narrative, README and wiki text, and PR and commit bodies an agent writes. Decide by the deliverable, not the task label: a doc-drift survey is mechanical and stays cheap, but a doc-drift rewrite produces sentences a person reads, so it runs Fable. Analysis, findings, verdicts, transcripts, and the scratch-file report an agent hands back are data for another agent to act on; they keep their tier under the rules above.

The coordinator never drafts a prose deliverable inline. It briefs, judges, and selects; the writing goes to a Fable agent like any other delegated production work. Prose review runs Fable too, an exception to Opus-for-review above: the judgment is about prose. Correctness review (code, security, compliance) does not move.

The reason is quality, and economy now bounds it. Fable's prose baseline is materially better than the other tiers', so drafting at a lower tier and polishing afterward spends two passes to land below what Fable writes in one. (Operator directive, restated 2026-07-17 through 2026-08-11; promoted to a rule 2026-08-20 after a session in another project searched the rules files, found nothing tying a model tier to prose, and shipped Sonnet-written client prose.)

Two limits on the paragraph above, both operator directives of 2026-09-04.

Plans, specs-as-contracts, and any artifact an agent team executes against do not go to Fable.
They go to Opus or Sonnet. A plan looks like a document and is not one: its correctness lives in
exact paths, signatures that must match across tasks nobody reads together, test assertions that
can actually fail, and commands that run verbatim. The prose is a header and a framing sentence
per task. Judge the deliverable by what makes it wrong, not by whether a person reads it, and a
plan goes wrong through a renamed function, not a clumsy sentence. Where a spec is mostly argued
rationale it stays prose; where it is mostly contract it moves. That boundary is not settled and
should be drawn from a case rather than in advance.

Fable is also expensive and rate-limited, which the "quality, not economy" line above used to deny
outright. Cost is a real constraint on it, so spend Fable where prose quality is the deliverable
and not merely present. A rules-file edit encoding a directive verbatim, a commit body, a backlog
entry: the coordinator writes those inline rather than paying a Fable dispatch to phrase what is
already decided.

## Effort on Sonnet Is Not Optional

Any agent dispatched on `sonnet` must set `effort: "xhigh"`. The key is `effort` — same spelling in agent-def frontmatter, on the Agent tool call, and on a Workflow `agent()` call — never `reasoning_effort`, which is ignored without error and leaves the agent at inherited session effort forever. Sonnet gets picked for work needing real reasoning below Opus prices, and an unset effort throws away the reason it was picked. Haiku and Opus still set effort by judgment; whether haiku should carry the same mandate is open, not settled here. (Operator directive, 2026-08-11.)

## Return channel: scratch file always

The channel is directional, and getting the direction wrong either way is the common failure. Operator directive, 2026-08-02: "You can use sendmessage, our agents should not be communicating back to you." Replaces the older "message by default, scratch file for bulk" split.

| direction | channel |
|---|---|
| dispatcher -> agent (dispatch, redirect, follow-up, correction) | SendMessage, fine, unrestricted |
| agent -> dispatcher (reports, verdicts, results, questions) | scratch file, always, regardless of size |

Every brief expecting a result names an absolute path under the session scratchpad and tells the agent to write there. Do not tell it to SendMessage back. Do not tell it to "report in your final message" either — plain agent output does not reach the dispatcher, and that omission has now caused a silent agent five times.

```
Write your report to:
  <scratchpad>/<task>-report.md
Nothing else is read. Your final message does not reach me.
```

Idle notification means "go read the file", not completed handoff. A file survives the agent going idle without speaking, survives the dispatcher being mid-turn, and is re-readable instead of consuming context once on arrival. Silence is still not approval: confirm a real verdict exists before merging. Dispatcher relays what matters to the user; the file is not shown to them.

Read-only agent types cannot use this channel. `appsec-sme` and `governance-sme` are declared `Read, Grep, Glob, WebFetch, WebSearch, Skill` — advisory by charter, no Write. `Explore` and `Plan` the same. Briefing one to "write your report to `<path>`" is an impossible instruction; the well-behaved failure is reporting BLOCKED ON DELIVERY and handing the full body back for the dispatcher to save — correct behavior, not a defect. Check the type's tool grant before naming a path: pick a type that holds Write (`task-reviewer`, `adversarial-reviewer`, `general-purpose`, `senior-developer` all do), or accept the handback and write the file yourself.

Never add `memory:` to an advisory def as a workaround. Per `subagent-prompting.md`, `memory:` in a def silently grants Read, Write, and Edit over a `tools:` allowlist — removes more protection than it buys.

## Review Is Always Delegated

Never review your own work. Every review — code, spec, design doc, config, prose — goes to a separate agent (code-reviewer, appsec-sme, governance-sme, a fresh general-purpose subagent, or a fork). A fresh context catches what the authoring context is blind to.

Overrides any skill or workflow step that says "self-review" or "review your own": dispatch an agent instead. Match agent to artifact (security work → appsec-sme, compliance/policy → governance-sme, implementation → senior-developer/code-reviewer, prose → a fresh general-purpose subagent dispatched with an explicit `model: fable`). Any type can reach Fable: the per-invocation `model` parameter outranks the definition's frontmatter, so a dispatch carrying `model: fable` puts `appsec-sme` or `governance-sme` on Fable despite their pinned `model: sonnet`. Two limits are real. A fork inherits the parent's model and ignores a `model` override by design, and the read-only types hold no Write tool, so per the return-channel section above they cannot deliver a report file — which is why a prose review needing a delivered report goes to a Write-holding type such as general-purpose, even when the document's substance went to `governance-sme`.

Only thing that skips review: a trivial change with no logic to review (typo, version bump) — no review at all, not a self-review.

## Plan Execution Is Always Subagent-Driven

Executing a written implementation plan (superpowers or otherwise): always subagent-driven execution (superpowers:subagent-driven-development), fresh subagent per task, review between tasks. Never execute plan tasks inline in the main context, never offer inline execution as an option. Main context orchestrates, reviews, decides; subagents implement. (User standing rule, 2026-07-12.)

## Skill vs Agent (for overlapping domains)

Docker, PowerShell, and Bash each have a **skill** (knowledge injection, cheap) and an **agent** (full subprocess, expensive). Default to the skill for knowledge: when the question is how something works, the skill answers it and no dispatch is warranted. The call-count threshold above still governs execution, so an investigation that runs past two calls goes to the agent whether or not it looks complex. Escalate on complexity as well when the task needs autonomous multi-step tool use — debugging a failing Docker build, chasing a complex cross-file bash issue, analyzing a PowerShell module structure.

## Code Search: code-context Before Grep-Crawling

`code-context` MCP server (tools: `search`, `sql`, `reindex`) gives hybrid keyword+semantic search over the current repo. When available:

- Reach for `mcp__code-context__search` first for any code question in an indexed repo, including one where the exact string is already known. Operator directive 2026-07-19 withdrew the older carve-out that allowed plain Grep for exact known strings and one-shot matches in code. Hits are authoritative enough to cite without re-opening files.
- Use `sql` for aggregation questions ("how many callers of X", "which files mention Y most").
- Surviving carve-outs are narrow. Grep still owns non-code text: docs, configs, logs. Glob still owns find-a-file-by-name. Absent-tools fallback is below.
- First query on a repo auto-indexes (keyword results in seconds; semantic backfills ~2 min). A "partial index" flag in results means absence is not proof.
- Dispatching search-heavy subagents whose tool access includes MCP (`tools: *` agents): mention code-context in the brief. Restricted-tool agents (Explore, cavecrew) don't have it — brief them normally.

Backend runs in WSL (setup note: memory `code-context-mcp-wsl`). If its tools are absent from a session, fall back to Grep/Glob without comment.

## When to Use Agents

Use agents when the task **individually** clears these thresholds:

| Agent | Use when... |
|-------|-------------|
| **Explore** | Understanding something would take 2+ search/read rounds, or the territory is unfamiliar |
| **cheap mechanical agent** (`model: haiku`) | Anything that runs a command and reports what it said: builds, test runs, log tails, service checks, recursive listings, collecting a diff |
| **prose agent** (`model: fable`) | Any deliverable that is prose a person will read: docs, policy and runbook sections, memos, reports, README and wiki text, PR and commit bodies. Decide by the deliverable, not the task label — a doc-drift survey stays cheap, a doc-drift rewrite runs Fable |
| **code-reviewer** | Any change with logic in it, any security-relevant config (Traefik, Authentik, firewall, secrets), anything altering service-to-service communication. Review runs on a premium model by design, so this is the one widened trigger that costs premium quota rather than saving it; that is a deliberate trade, not an oversight |
| **code-architect** | A feature spans multiple services or compose files and needs design before implementation |
| **code-explorer** | Need to trace an execution path or understand how an existing feature works across multiple layers |
| **Plan** | Task has multiple valid approaches and needs architectural comparison before committing |
| **docker/powershell/bash expert agents** | The skill alone wasn't enough — task needs the agent to autonomously read files, run commands, and iterate |

## When NOT to Use Agents

Narrow list, each narrow for a reason.

- Answering from what is already in the context window. Re-fetching an established fact is waste twice over.
- A single call whose output is small AND whose raw text the coordinator needs verbatim to decide the next move. All three, not any one. Reading a specific file before editing it is the common case.
- Remote SSH work depending on session state or environment context the agent won't inherit.
- A task where writing the brief takes longer than doing the thing, and the thing produces almost no output.

What moved: a single-file edit with real logic in it goes to an agent now, because writes are delegated; a one-line trivial change does not, per the carve-out above. A three-grep lookup goes to an agent, because two calls already clears the bar.

## Parallel Agent Gate

N agents in parallel multiplies cost by N. Each must **independently** clear the thresholds above. Don't parallelize for convenience — only genuinely independent tasks, each substantial enough to warrant its own agent.

## Reduce Noise: Delegate Investigation Sequences

A debugging or investigation sequence of 2 or more Bash calls goes to a cheap agent, which writes what it concluded to its scratch file. Main conversation carries decisions and outcomes, never a wall of `ssh ... docker exec ... | grep` and its output.

When a single call is still right, chain related commands with `&&` rather than spending three turns on three of them.

## SSH / Remote Work Note

Most homelab work happens over SSH to remote hosts. Agents can use Bash (and therefore SSH) but don't inherit session context, so direct tool use in the main context is often more practical for remote exploration. Agents for local codebase analysis; direct commands for remote host work.
