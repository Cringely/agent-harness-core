# Contributing

This repo grows from real projects, not from designing ahead of need. Anything added here should already have proven itself somewhere else first.

## Findings flow

There are two channels for something a project learns while using this harness.

The cheap one is capture: any finding worth remembering, a fix that worked, a failure mode worth avoiding, becomes a memory note per the memory-system skill, tagged with the project it came from. This costs almost nothing and most findings stop here. Most one-off fixes belong to one project and should stay there.

The second channel is graduation. When the same failure class, or the same useful pattern, shows up a second time in a different project, it gets promoted into this repo as a commit: a new or edited pattern doc, an agent definition, a hook, or a template. Once something graduates, the memory notes that described it shrink down to a pointer at the core doc instead of repeating the detail.

One occurrence is a note. Two occurrences across different projects make it a candidate for core.

## What belongs in core

A change belongs here if it states a testable constraint or provides machinery a second project can actually reuse, not a fix for one project's specific bug. It should be language-agnostic, or clearly labeled with which language or stack it assumes. And it has to be genericized, stripped of the project name and domain-specific nouns from whatever system it was pulled out of. If a pattern doc needs an example, use a placeholder domain like "orders" or "jobs" instead of the real one.

## What stays project-level

Domain logic stays where the domain lives. So do thresholds tuned to one system's traffic or scale, and language-specific versions of a pattern described here. If a project builds a core pattern in a different language, that code lives in the project, not here. Only the pattern doc that describes the shape of the solution belongs in core.

## Change process

Make changes on a branch. Run whatever checks the repo has before committing. Write the commit message so it explains why the change was needed and what alternative was considered and rejected, not just what changed. Merge once it's ready.

Projects pick up core changes by re-running the installer. The installer is manifest-tracked: it never silently overwrites a file a project has modified since install. See `install/Install-Harness.ps1` for the exact overwrite behavior.
