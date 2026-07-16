# Abstaining Evals

## The problem it solves

An agent that plans or decides through an LLM needs its judgment checked against more than "did it
compile." Running that check against the live system every time is slow and, if the system does
anything real, unsafe: the eval has to run offline, against recorded situations, calling no
external service and mutating nothing. The harder problem is scoring: a naive checker forces every
verdict into pass or fail, and on a case that's simply missing the data one check needs, that
forces a guess. A guessed verdict is worse than no verdict, because it looks exactly like a
real one in the summary numbers.

## Cases are recordings

A case is the exact context object the decision-maker was shown at a real moment: the object
itself, not a rendered prompt string, and recorded from a live run rather than written up as a
scenario after the fact. That object doubles as
ground truth for most checks: whatever facts exist about the world at that moment, which options
were available, what state things were in, are already inside it, because it's the same object the
decision-maker saw. A case can also carry the actual output produced at that moment, letting the
suite be run with zero calls to any model, and a small set of facts the recorded object itself
can't answer (the complete set of valid targets in that world, say) as separate, optional ground
truth, set only when it's actually known.

## Zero-token replay

Scoring a candidate output against a case is deterministic code that just compares structured
data, with no network call and no model behind it. This makes the whole suite runnable in a normal
test run, and that same run doubles as the check that the scorers themselves still work, proving
each one still fires on a known-bad recorded output. A live run swaps in a real decision-maker behind the same interface the
production system uses, so putting a new candidate model or provider on the scoreboard is a
one-line config change, not new code.

## Three verdicts, not two

Every check returns pass, fail, or abstain, and abstain is not a lesser form of pass. A check whose
required input is absent from a case (no ground truth for it, a field the recording didn't
capture) must abstain rather than manufacture a verdict from data it doesn't have. Abstaining on
a thin case and failing on a thin case look identical from inside the check, but they mean opposite
things downstream: a false pass hides a real defect that a fuller case would have caught, and a
false fail on missing data trains whoever reads the report to stop trusting the number, because the
check appears to cry wolf on cases that were never wrong to begin with. Either failure mode poisons
a trend line the same way, by turning a real signal into noise that looks like signal, which is
worse than an honest gap because nobody notices when the checks start missing actual defects. The
score reported is decided checks only, pass plus fail, with abstentions excluded from both the
numerator and the denominator, so a check nobody could evaluate never counts as a failure and never
counts as a free pass.

## Scorer signature

```
type Verdict = "pass" | "fail" | "abstain"

function scorer(candidate: CandidateOutput, testCase: Case): { verdict: Verdict, reason: string }
```

Each scorer checks one class of defect and returns a reason string either way, a short explanation
of the offending part on a fail, or of what data was missing on an abstain. A scorer is only worth
writing if it names a defect that actually happened once in production; a checklist built from
imagined failure modes mostly tests the author's assumptions rather than the system.

## Harvesting new cases from production

A case doesn't have to be written by hand. If the running system already logs the context it
handed the decision-maker as one event among others, a harvester reads recent events of that type
back off the log and turns each one directly into a case, attaching whatever the system actually
produced at that moment so it replays for free. New cases then accumulate from real operation
instead of needing someone to invent scenarios, and a situation a hand-written suite would never
think to cover is exactly the one the running system already hit. A fact the recording simply
can't supply, the complete set of valid values at that instant, say, stays unset on a harvested
case; the check that needs it abstains there rather than fail a plan for a fact nobody captured.

## When not to use it

A decision-maker with a couple of fixed branches and no real judgment in it doesn't need this: the
scorers, the case format, the harvester, are all overhead a hand check covers just as well. The
pattern earns its cost once a model's judgment is doing enough real work that comparing two
versions, or two providers, by reading transcripts stops being reliable, and a team needs a number
it can trust across many runs instead.
