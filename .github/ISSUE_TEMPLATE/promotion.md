---
name: Promotion candidate
about: Propose moving something a project built into core
title: "Promote <path> (<source project>): "
---

<!--
This form collects the case for moving an artifact a project built into core. It does not
decide the case. A reviewer weighs what you write here against CONTRIBUTING.md, and the
commit that accepts the promotion records why it was admitted.

Write something under every heading. An empty heading reads as a gap in the case rather than
a section that did not apply, so say "nothing here, because ..." instead of deleting it.
-->

## Source

<!--
Give the path in the origin project, the project it came from, and the kind of artifact it is:
hook, agent definition, template, pattern doc. Add a commit or a date so a reader can find the
same version of the file you read, and say how you came across it.

Cite the path. CONTRIBUTING.md's rule against hard-coding a measurement of a file you do not
own applies to this issue too.
-->

## Why it transfers

<!--
State the mechanism rather than the incident. What does this artifact judge, check, or produce,
and why does that hold outside the domain it came out of?

Say which kind of producer is behind it. A failure produced by a shared dependency, a CLI's exit
codes or a tool contract core already relies on, transfers on different grounds than one produced
by the origin project's own code.

Name what it depends on, and whether core already assumes that dependency. A hook needing bun
stands on ground core already stands on. One needing a CLI that no install target is known to
carry needs its no-op case described here.

Keep verified claims and borrowed ones apart. Another project's incident record stays that
project's record until someone reproduces it, so mark which is which rather than presenting
everything at one strength.
-->

## What needs genericizing

<!--
List every string that has to change before the file can live in core, and where each one sits:
a comment, a deny message an operator will read, a path, a default value. Issue numbers, incident
dates, and review-round bookkeeping all count, and all of them go.

"Nothing" is a real answer. It has to come from reading the whole file, though, not from a search
for the origin project's name.

Where an example needs a domain, CONTRIBUTING.md asks for a placeholder such as orders or jobs in
place of the real one.
-->

## Occurrences

<!--
List each occurrence on its own: what happened, which project it happened in, and when. For each
one, say whether you observed it or read it in someone else's record.

CONTRIBUTING.md's findings flow puts the bar at two occurrences across different projects. What
satisfies that bar is unsettled, and several open promotions rest on evidence of a different
shape. So this section gathers the evidence and stops there.

Report the count you actually have. Do not assert that the bar is met; that reading belongs to
the reviewer and to the accepting commit.

Filing on a single occurrence is normal. Say so plainly and argue for admitting it anyway. An
argument labelled as an argument survives review. A count stretched to look like two does not.
-->

## Process or domain

<!--
This question is orthogonal to genericizing, and it is the one a well-written submission most often
fails. Core files carry process, meaning how to work: review independently, verify before claiming
something works, reconcile docs after a merge. They do not carry a technology, a tool, or a field.

Cadence decides it, not quality. Core reaches a project only when that project re-runs the
installer. Content tracking a release cycle of its own drifts between those runs and nothing
reports the gap. Name what this artifact's content tracks, and what goes wrong once the thing it
tracks moves.

CONTRIBUTING.md works `docker-expert` through as the example: stripped of every project name,
stating a real checklist, reusable by any Docker project, and out of core anyway, because it aged
on Docker's release cycle instead of the installer's. Clearing every clause above is not an answer
to this one.
-->
