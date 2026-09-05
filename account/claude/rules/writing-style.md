<!-- vale off -->
<!-- This file enumerates the vocabulary it bans, so it cannot be linted by the style it
     defines. The directive above exempts the whole file and travels with the bytes, which
     a path glob in ~/.claude/tools/prose-lint/.vale.ini did not. Keep it, and never write
     a matching "vale on" directive anywhere below. -->

# Writing Style: Avoid AI Tropes

## Principle

Write like a senior engineer talking to peers. Direct, specific, confident. Person-written, not system-generated. Optimize for being understood quickly, not for appearing thorough.

## Surface Routing

One register per surface, five surfaces. Binding whether or not any plugin cooperates.

| Surface | Authority | Register |
|---|---|---|
| Docs, policies, reports, emails, essays, any file-based prose deliverable | beautiful_prose skill + Vale (`/prose-lint`) | full prose |
| Code comments, agent briefs and subagent messages, commit subjects and bullets | compressed (see below) | compressed |
| User-facing chat responses and summaries | this file | normal prose |
| PR descriptions, review summaries, status artifacts read against a diff | Scannable Structure below | structured |
| Internal agent traffic: memory notes, handoffs, council transcripts, scratch and report files, the Obsidian mirror | exempt (see below) | none |

Compressed register, stated here so it holds without a plugin: drop articles, filler, and
pleasantries; fragments are fine; keep every technical term, path, command, identifier, and error
string verbatim; never invent abbreviations. `subagent-prompting.md` carries the full version for
briefs.

Commit messages split. Subject and bullets compressed. Rationale required by
`change-management.md` (why the change was needed, what was rejected, trade-offs) stays normal
prose; compression costs clarity in reasoning.

Auto-clarity overrides compression everywhere: security warnings, destructive-action
confirmations, and any multi-step sequence where dropped conjunctions could invert the order get
normal prose regardless of surface.

Row 5 is an exemption, not a register. Internal agent traffic is written for the next agent or the
next session, never for a reader, so no prose contract binds it. The mechanism is the skip list in
`~/.claude/hooks/Lint-DocumentProse.ps1`, which matches `/memory/`, `/handoffs/`, `/scratchpad/`,
`/.scratch/`, `/council-transcripts/`, `/.claude/` and `/obsidian vault/claude code/` against the
path of the file just written, then exits before Vale ever starts. That vault token is the sync
target, not the vault: the hand-authored notes sitting elsewhere under `Obsidian Vault` are the
operator's own prose and keep linting. The same list drops `/node_modules/`, `/.git/` and
`/.obsidian/`, which is housekeeping rather than contract.

Two more mechanisms carry the exemption into any project that installs the core hooks,
`core/claude/hooks/lint-doc-prose.ts` on write and `core/claude/hooks/pre-commit` on commit. Their
list differs on purpose: the same six agent-traffic segments, no vault token at all because the
vault is this machine's rather than a project's, and `docs/assets/` on top in the write hook.
Naming all three mechanisms here keeps the contract and the tools from drifting apart quietly: a
change to one is a change to the others.

Reading row 2 to cover these files does not work. Row 2 covers messages, and `agent-usage.md` makes
a scratch file the return channel out of a subagent precisely because a report is a file rather
than a message. Row 1 does not catch them either: a report is not a deliverable in row 1's sense,
whatever its extension. So this is a knowing departure from "banned vocabulary binds every surface"
below, taken by the operator on 2026-08-14 after a count found over two thousand markdown files
under this machine's session scratchpads, all of them subagent reports. Recorded as a decision
rather than left as a quiet disagreement between the table and the hook.

A worktree checkout is not internal traffic. What gets written there is a deliverable on its way to
master, so it keeps linting, and both write hooks are built to say so. `Lint-DocumentProse.ps1`
rebases a path at the worktree root before it matches the skip list; `lint-doc-prose.ts` excludes
`.claude/worktrees/` from its `.claude/` rule. Without those two lines the `.claude/` that merely
hosts a checkout swallows the whole thing, which is what both hooks used to do. A `memory/` note or
a nested `.claude/` inside the worktree stays exempt on its own token.

Everything below targets row 3, chat and summaries, which is what "everyday output" means for the
rest of this file. Banned vocabulary binds every surface except row 5. Structural and tone rules
(sentence variety, hedge stacking, transitions, formatting) do not bind the compressed row.

## Scannable Structure

Row 4 covers anything a reader skims while holding another artifact open: a PR description read
beside the diff, a review summary, a status report checked against a board. The reader arrives
knowing what they are looking for. Structure beats prose there, and this row is the one place the
"no converting prose into bullets" rule below does not apply.

Group by artifact or subsystem, in the order the reader walks the thing. Grouping by defect class,
theme, or severity organises the work around the author's mental model, which the reader does not
have.

Label groups with a bold label on its own line, not a `##` header. Lighter weight, no anchor
clutter, and the whole page scans as one list.

Under each label goes a real bulleted list, one to three items, each carrying one or two sentences.
Two is the ceiling, not the target. The list markers are the point. A bold label followed by a paragraph is a wall of text
with a label on it, and it fails this row exactly the way unbroken prose does; the reader gets no
indentation, no per-claim boundary, and nothing to skip forward to. Bullets chunk; they do not
compress. Resist the table: a table forces every claim to the width of its cell, and claims that
need a clause of context die there. Use one only when the content is genuinely tabular.

Open with a sentence or two naming what the change is and which part matters most, before detail.
Never close with a summary of the summary. "These changes collectively improve clarity, accuracy,
and maintainability" is filler in any surface.

Deep-link every claim to its evidence. On GitHub the diff anchor is `sha256(utf8(repo-relative
path))` in lowercase hex, suffixed `L<before>-R<after>` (or `R<n>-R<m>` for pure additions), giving
`[[1]](diffhunk://#diff-<anchor>L57-R74)`. Verified against a live link 2026-08-11. A description
that links its claims becomes an index into the artifact rather than a retelling of it.

Keep the sections the artifact cannot supply. Testing evidence and known gaps stay, because a
reader can reconstruct what changed from the diff and cannot reconstruct what is still broken or
how you know it works.

Shortening prose does not satisfy this row, and neither does labelling it. A tightened block of
paragraphs is still a block of paragraphs, and so is a labelled one; the complaint is shape, not
length. Read the draft back as rendered markdown and check for actual indentation. If every line
starts at the left margin, the row is not satisfied.

## Wrap-Up Length

Chat wrap-ups after a run, task, or investigation cap at roughly 400 words. Cap covers the report,
not the work, and not file-based deliverables, which keep their own register and length.

Lead with the number or verdict, first line. Two caveats inline at most, one line each; rest goes
to the artifact, note, or commit message, read on demand instead of every time. Never recap a
design the operator was already briefed on. Bookkeeping (artifact republished, memory updated,
index bumped) in one clause, not a paragraph. No pre-answering unasked questions. No defending a
simplification at greater length than the simplification.

Three length sources to cut: restating method before results, arguing caveats inline instead of
recording them, narrating what was updated.

`detail` or `more` from the operator lifts the cap for that response. A direct request for a
walkthrough, a report, or per-phase notes is not verbosity and is not capped. Auto-clarity still
overrides.

## Layering

beautiful_prose skill is canonical for the banned-vocabulary list; this file mirrors it. Long-form
deliverables use the skill. Layer differences:

- Em dashes: skill bans absolutely (`—` and `--`); this file keeps the rare-exception allowance
  for everyday output.
- Structural entropy and registers: skill-only; everyday output just avoids monotony (see
  Monotonous prose below).
- Second-pass self-critique and lint checklist: skill-only workflow steps.

Vocabulary changes land in the skill first; this file and the Cringely Vale style
(`~/.claude/tools/prose-lint/Build-CringelyStyle.ps1`) update from it in the same change.

## Four Alerts the Linter Gets Backwards

The Vale kit flags `in order to`, `the fact that` and `tends to` through
`ai-tells.FillerPhrases`, and `as a result of` through `ai-tells.FormalTransitions`. All four
land at error. Overrule them. The linter is wrong about these four, and obeying it makes the
prose worse rather than better.

All four sit on Wikipedia's WikiProject AI Cleanup list of wording that appears more often in
human-written articles than in LLM output. Be precise about how strong that is, because it is
the reason to overrule a rule rather than obey it. The list is an editors' compilation, not a
study of these four words. The page cites Geng and Trotta on lexical and syntactic differences
in LLM writing and Reinhart et al. on register variation, and those are real corpus work, but
of the four only `tends to` carries a citation directly. So the tier here is editorial
consensus resting on corpus findings, not a measurement of these four phrases. That is still
enough, because the claim being made is narrow: no evidence supports stripping them on sight,
and doing so moves a document toward the model distribution rather than away from it. Keep them
where they read naturally. Cut one only when it pads the sentence it sits in.

The long forms are a different matter and stay banned. `due to the fact that`, `given the fact
that`, `owing to the fact that` and `despite the fact that` are padding by any account, one of
them already sits in the Filler phrases list below, and deleting them costs nothing.

No mechanical guard backs this up, by decision rather than by oversight. A Cringely rule that
annotated the four at `suggestion` with a "keep it" message was written, measured and removed on
2026-08-14. Vale 3.15.1 has no per-token severity, so the annotation arrived as a second alert on
the same span saying the opposite thing, and no consumer prints the severity that would rank the
pair: the PostToolUse hook, the repo pre-commit gate and the `/prose-lint` skill all run
`vale --output=line`. Every finding that rule ever produced on the measured corpus was one half of
a contradiction, so there was no non-contradictory behaviour left to keep. The full rejection with
its measurements is recorded in `~/.claude/tools/prose-lint/.vale.ini`. This section is the guard:
a writer who reads it overrules the alert, and nothing in the toolchain will do that for them.

## Banned Words and Phrases

Never use these in technical, policy, or engineering communications:

Single words (use plain alternatives):
- delve, dive into -> examine, look at
- leverage -> use
- utilize -> use
- robust -> strong, reliable, or omit
- holistic -> complete, full, end-to-end
- seamless -> smooth, or omit
- comprehensive -> thorough, complete, or omit
- pivotal / crucial / vital / essential -> important, or just state the reason
- innovative / cutting-edge / state-of-the-art -> omit or be specific
- unprecedented -> new, or be specific
- transformative / revolutionary / game-changer -> omit entirely
- streamline -> simplify, reduce, or be specific
- empower -> let, allow, enable
- foster -> build, grow, encourage
- harness -> use, apply
- underscore / highlight -> show, or just state the point
- paradigm -> model, pattern, approach
- synergy -> working together, or be specific
- tapestry / landscape / ecosystem -> omit or be specific
- realm -> area, domain, or omit
- nuanced -> specific, or just be specific
- facilitate -> help, run, coordinate
- operationalize -> set up, put in place, implement

Filler phrases (delete entirely):
- "It's important to note that..."
- "It's worth mentioning/noting that..."
- "It goes without saying..."
- "Needless to say..."
- "As mentioned above..." / "As previously stated..."
- "At its core..."
- "In the ever-evolving landscape of..."
- "Given the fact that..."
- "Bearing in mind that..."
- "A testament to..."
- "Navigate the complexities of..."
- "Pave the way for..." / "Unlock the potential of..."
- "Embark on a journey..."
- "Bridging the gap between..."
- "Foster a culture of..."
- "Harnessing the power of..."
- "In terms of..." (restructure)

## Structural Patterns to Avoid

Sycophantic openers: never open with "Great question!", "Certainly!", "That's a really good point", "Happy to help", or any praise of the user's input. Start the answer.

Hedge stacking: no layered qualifiers. "Generally speaking, it could be argued that..." -> direct claim. If genuinely uncertain, say so once.

Fake balanced conclusions: no "Overall, [restatement]" or "In summary, [repetition]" section endings. If the content is clear, stop.

Preamble bloat: no announcing what you are about to do. "I'll now walk you through..." -> the walkthrough. "This section will cover..." -> the coverage.

Rule of three inflation: no padding lists to three items for symmetry. Two true things, list two.

Present participle stacking: no chained "-ing" clauses. "Providing X, enabling Y, and facilitating Z..." -> separate declarative sentences.

Monotonous prose: vary sentence length and structure. Three consecutive sentences on one pattern (subject-verb-object, same length, same opening word) -> rewrite at least one. A wall of uniform paragraphs reads as machine output.

## Jargon and Lexical Fatigue

Banned-words list targets empty words. This targets the opposite failure: real terms of art, used correctly, used so often they exhaust the reader.

A specialist term earns its first use, not its eleventh. House vocabulary is the usual offender: "ablate," "load-bearing," "forcing function," "invariant," "seam," "producer/consumer," "net-negative." Vary the phrasing, or say the plain thing. A steady drip across a whole document fatigues the same as three in a paragraph. On a re-read pass, if the same term appears in most sections, replace all but the one or two uses drawing a real distinction.

Prefer the plain sentence where it does the same work: "ablate the test" is a grand way of saying "delete the fix and check the test fails." Keep the term of art where it draws a distinction plain words blur, and where the reader already speaks it (agent briefs, review verdicts, code comments).

Gloss a needed specialist term in place on first use in a human-facing document. Six words in parentheses. Not a glossary, not a footnote.

Rhetorical frames fatigue a reader the same way a repeated noun does. Once is style; four times is a template.

Mechanical backstop: `Cringely.AblationOveruse` warns when a single paragraph says "ablate" three or more times. Vale counts occurrences per paragraph, so nothing catches a word recurring at a steady drip across a whole file. That call stays yours: could a competent person outside the project read it without stopping? If not, cut the jargon.

## Tone and Voice

Robotic formality: policy documents still need to sound person-written. "The owning team is notified" is fine; a paragraph where every sentence follows "The [noun] [verb]s the [noun]" is a spec sheet. Mix in natural constructions. Occasionally open with "When", "If", or "After" instead of the subject.

Functional word choice: avoid prose reading as a series of operations ("Performs X, executes Y, produces Z, surfaces W"). Prefer active subjects doing recognizable things: "MSO runs the quarterly review" over "MSO executes a quarterly review on behalf of AppSec."

Corporate therapeutic register: no feelings-language for technical decisions. "This is a supportive intervention" -> "MSO works with the team to identify blockers." State what happens, not how it is supposed to feel.

Over-qualification: if the answer is clear, give it. No preemptive defense of every statement, no multiple perspectives when one is correct.

Excessive formality in transitions: Furthermore, Moreover, Additionally, Subsequently, Accordingly, Notwithstanding -> "also," "but," "so," "then," or drop the transition entirely.

## Formatting Rules

No bold or italic for emphasis mid-sentence. Bold only for defined terms in a glossary, column headers in tables, and structural labels (e.g., "Option A" in a list of options). Never bold an adjective or verb to signal importance.

Em dashes: avoid almost entirely. Replace with a period and new sentence, a comma, or parentheses. Rare exception: a genuine aside awkward as a parenthetical; otherwise default to not using them.

Mechanical bullet points: no converting continuous prose into bullets. Three or fewer related points belong in a sentence. Bullets are for genuinely enumerable, parallel items.

Header inflation: content under ~300 words needs no section headers; prefer prose paragraphs.

## What Good Looks Like

Say what is true. Say why it matters. Stop.

Specific numbers, names, and outcomes beat adjectives. State a correct decision; name a trade-off. Vary how sentences start and how long they run. Read it back: would a person actually write this sentence this way?
