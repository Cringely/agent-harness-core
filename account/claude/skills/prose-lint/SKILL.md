---
name: prose-lint
description: Run the deterministic Vale prose linter (ai-tells + Cringely styles) against a markdown or text file and report AI-tell findings. Use when the user invokes /prose-lint, asks to "lint this doc for AI tells", or wants a mechanical style check on written prose before delivery.
---

# Prose Lint

Run Vale with the personal lint kit against the file the user names.

## Steps

1. Resolve the target file path from the user's request, to an absolute path. If no file is given, ask for one. The path must be absolute. Vale matches a `.vale.ini` section glob against the path exactly as typed on the command line, not against a resolved one, so passing a bare filename from inside a directory silently bypasses every path-scoped section in the config. Measured 2026-08-14, and the failure is invisible in both directions, since an exemption that stops applying just produces findings and a glob that never matches just leaves rules firing.
2. Run:
   `vale --config "{{CLAUDE_HOME}}/tools/prose-lint/.vale.ini" --output=line "<target-file>"`
3. Report findings grouped by rule, with line numbers, ordered by count. Zero findings: say the file passes and stop.
4. Offer exactly one follow-up: rewrite the flagged passages using the beautiful_prose skill's Edit mode. Only proceed if the user accepts.

## Notes

- The linter is advisory, not a gate. Quoted text, code identifiers, and API names legitimately trigger false positives; call those out instead of "fixing" them.
- If a rule fires repeatedly on legitimate prose, name the rule and reach for the narrowest exception that covers it. Never delete a rule from the package.

## Scoping an exception

Vendor vocabulary is the usual cause. A document about a third-party system has to quote that system's own nouns, and a rule policing generic overuse cannot tell a quoted enum value from a tic. Measured case: `ai-tells.ShipOveruse` produced 37 findings on one file tracking GitHub's roadmap board, whose lifecycle field has a status literally named "Shipped" — 48% of that corpus's false positives from one rule firing on a defined term.

Three tiers, narrowest first:

1. **In-file comment.** `<!-- vale ai-tells.ShipOveruse = NO -->` disables that one rule for the rest of the file; every other rule keeps firing. `<!-- vale off -->` / `<!-- vale on -->` brackets a passage. Verified live 2026-07-29 against the pinned kit. Prefer this: the exception sits next to the reason for it, and nothing outside the file changes.
2. **Project-local `.vale.ini`.** `lint-doc-prose.ts` prefers `<project>/.claude/tools/prose-lint/.vale.ini` over the machine-global kit when present. Use for a standing exception across a whole project. Costs a config file the project then maintains.
3. **Global `.vale.ini` disabled-rules block.** Machine-wide. Only when the rule is wrong everywhere, not just here.
- If `vale` is missing, tell the user to re-run Task 1 of the prose-system plan; do not install anything without asking.
