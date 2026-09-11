# Vendored Prose Exemption

## A finding on text nobody here will edit

A project copies a third party's documentation into `docs/` verbatim, to be cited rather than
maintained. Its own rule says the copy is checked before any assumption and is never edited; the
copy is authoritative because it matches upstream byte for byte. Then the write-triggered prose
linter fires on it. The hook's allowlist admits anything under `docs/`, the file is markdown, and
the findings come back like any other: a filler phrase here, an overused adjective there, each with
the standing suggestion to apply the style contract's edit mode to the flagged passage.

Nothing about the finding is wrong. An upstream author may well have written `leverage` and
`robust`, and a linter that flags them is doing its job. What goes wrong is the next step. The
natural response to a finding is to fix the prose, and fixing a verbatim copy destroys the one
property that made it worth vendoring. Afterwards the file still reads well, better by the linter's
lights, and it no longer matches upstream. Nothing compares the two. The corruption cannot be seen
from inside the project, and it stays unseen until a decision made on the edited copy turns out to
rest on a sentence upstream never wrote.

That is a different failure from a false positive. The hook's own advisory text already handles
false positives: quoted text, code identifiers and API names trigger findings that are not tells,
and the writer names those in the pull request body instead of "fixing" them. A vendored finding
can be a true positive and still must not be acted on, because the project does not author the
text. The constraint the exemption rests on fits in a sentence: a write-triggered prose linter must
not lint content the project does not author. That covers vendored docs, third-party
specifications, upstream API references, a skill copied in from another author, and anything else
brought in to be cited rather than maintained.

The existing skip lists exempt the opposite case. Memory notes, handoffs, scratch, council
transcripts and the project's own `.claude/` tree are content the project authors and no reader
consumes, written in a compressed register the reader-facing rules flag wholesale. Vendored content
is read by everyone and authored by no one here. The mechanism is the same list, the reason is the
reverse, and the reason belongs next to the entry because it decides what a finding means. A
finding on internal traffic is noise. A finding on vendored text is a trap.

This shape comes from one downstream project so far, whose fork of the write hook carries the
entry, and from a per-tree section in the account-level lint kit that this repo's hooks read.

## Three places an exemption can live

Which one fits depends on who owns the bytes and how many consumers have to agree.

The first is the hook skip list. `core/claude/hooks/lint-doc-prose.ts` carries `SKIP_PATHS`, a
list of separator-anchored regexes tested against the changed file's path before Vale is spawned,
and `core/claude/hooks/pre-commit` carries the matching set as `case` globs in
`is_internal_traffic()`. The write hook's header already names vendored upstream reference docs as
the case a project extends the list for. An entry here is keyed on the repo-relative path, silences
every rule for the tree, and costs nothing at lint time because the hook exits before it would have
spawned Vale. What it covers is exactly the hooks that carry it, so a manual run of the prose-lint
skill, or Vale invoked from any other tool, still lints the tree in full. The entry also has to be
present in both hooks, and
for a reason beyond the drift contract: the write hook lints only a `README.md` or a file under
`docs/`, while the commit hook lints every staged markdown file, so a vendored tree outside `docs/`
never reaches the write hook and reaches the commit hook every time. Two costs come with it. A
project whose tests pin the skip list's segment set, the way `test/lint-doc-prose.test.ts` does
here, declares the new segment there or the suite reddens. And the entry is an edit to an installed
file, which the installer's audit reports as drift until the project pins the fork as an accepted
overlay. This place fits a vendored tree that the project's own hooks see and nothing else lints.

The second is a per-tree section in the Vale config. A path section such as
`[**/skills/not-ai/**]` with an empty `BasedOnStyles =` zeroes the style set for every path the
glob matches, in every consumer of that config: both hooks, the manual skill, a CI runner pointed
at the same file. The config can be the project's own vendored kit under
`.claude/tools/prose-lint/.vale.ini`, which both hooks prefer when it exists, or the account kit
under `~/.claude/tools/prose-lint/.vale.ini`. It is keyed on the path as handed to Vale on the
command line, which is the first footgun below. The account kit uses one for a vendored skill that
exists twice on disk, as an account copy and as a repo payload copy, and one section reaches both.
This place fits a tree that several consumers, or several checkouts, lint through one config.

The third is an in-file directive. A `vale off` comment on the file's first line travels with the
bytes, matches under any path spelling, and closes the stray-file hole harder than a glob can, since
a different file carrying the same name lints wherever it sits. The prose-lint skill recommends it
first for a project's own documents, and it is the right answer for a style contract that quotes
its own banned words. It does not fit vendored content, because it edits the vendored file, and
the rule this whole doc rests on is that nobody does that. One caution attaches to writing about
it, because the directive travels by quotation. The kit measured a 13-finding document going to 0
when the comment was quoted in a blockquote, and staying at 13 when it was quoted in a fenced block.
Any
document that spells it out in running prose, a bullet, a table cell or a blockquote silences itself
from that line down and reads as clean. Spell it out only inside a fence:

```markdown
<!-- vale off -->
```

## One section per tree

The tempting shortcut is one glob over every vendored tree, or a directory-name convention baked
into the hook, `vendor/`, `third_party/`, `*-reference/`. Both were considered for this repo and
both are rejected, for the same reason approached from two sides. A name convention protects only
the projects that happened to pick that name; one that vendors into `docs/<upstream>-reference/`
gets nothing. A glob wide enough to catch every vendored tree at once also catches every future tree
that lands under it, reviewed by nobody. Zero findings reads as a clean document. An exemption that
is too wide produces that on every file it should not have covered, and the output does not
distinguish clean from never linted.

So the exemption goes per tree: one section or one entry per vendored directory, each under a
comment naming the tree, where it came from, and the measurement that showed the exemption holding.
This was settled on 2026-09-10, when the account kit gained its section for a vendored third-party
skill. The kit already carried a per-tree section for a style contract that quotes its own banned
words, and the new one landed beside it as a second section with its own comment, rather than as a
widened glob over both. Adding a tree is then a reviewed act with a diff a reader can see. Removing
one when the tree stops being vendored is a deletion, with nothing shared to re-check.

## Two footguns, both measured

The first is the path anchor. Vale matches a section glob against the path as typed on the command
line, never against a resolved absolute path. `[**/skills/not-ai/**]` exempts the tree when the
caller passes an absolute path and does nothing when the caller changes into the directory and
passes a bare filename. The kit measured it on 2026-08-14 against the style-contract section, 75
findings from inside the directory against 0 by absolute path, and re-measured for this doc on
2026-09-10 with the kit's own dirty fixture copied to a probe file: 25 findings under a neutral path,
0 under `skills/not-ai/` by absolute path, and 25 again for the same bytes invoked as `probe.md`
from inside `skills/not-ai/`. The failure is quiet in both directions. An exemption that stops
matching produces findings that look like findings, and a glob that never matched leaves rules
firing that look like the linter working. Both hooks pass absolute paths. The commit hook's path is
a blob extracted to a scratch directory, `$scratch_dir/$f` with `$f` repo-relative, so the
repository's own name is gone from it: a section anchored on the repo name never matches under the
commit gate, while one anchored on a segment inside the repo does. The anchor has to be a path
segment, never a bare filename, or the section exempts any stray file of that name anywhere on
disk. Choose a segment that survives every path a consumer hands Vale, and pass absolute paths from
any consumer you write.

The second is the level-assignment leak. Emptying `BasedOnStyles` in a section does not silence a
rule that was given an explicit level in `[*.md]`. In the kit,
`ai-tells.AnthropomorphicJustification = suggestion` in the base section kept firing inside the
exempted tree until the section named it again as `= NO`. A rule set to `NO` in the base does not
leak; only a level assignment does. So every per-tree section repeats each `<rule> = <level>` line
from the base as `= NO`, and every level line added to the base later has to be repeated in
every section, or the rule reappears in each tree with nothing to say why.

## Proving the exemption covers exactly the tree

Both halves of the measurement have to come out the right way. The zero on the vendored files shows
the section matched; a probe's count staying put outside the tree shows it matched on the anchor and
not on something wider. A section that zeroes both is a glob that is too wide, and from the vendored
files alone it looks identical to a correct one. [`test-falsifiability.md`](test-falsifiability.md)
is about measurements that cannot separate a claim from its opposite, and a probe with no outside
file is one of them.

Count findings on the vendored files by absolute path before the section exists; the kit's record
for its vendored skill is 12 across 6 files. Take a file known to raise findings, the kit ships
`fixtures/sloppy.md` as its own smoke test, and copy it to three places: under the tree's anchor
(`skills/not-ai/probe.md`), under a sibling path that shares the leaf name and lacks the anchor
segment (`not-ai/probe.md`), and under a neutral path. Add the section and re-run everything by
absolute path. The vendored files and the probe under the anchor go to 0; the probe under the
sibling and under the neutral path keep their full count. The kit's record from 2026-09-10 is 12 to
0 on the vendored files, a 13-finding probe to 0 under `skills/not-ai/` and 13 under bare
`not-ai/`; the re-run for this doc gave 25, 0 and 25. Then run the probe under the anchor once more
by bare filename from inside its directory, and expect the full count back. That last run is there
to show which consumer can defeat the section, and it is the reason the prose-lint skill insists on
absolute paths.

For the hook skip list the same shape runs offline against the exported `shouldLint()`: one path
inside the tree asserted false, and one path that carries the tree's name as a substring but not as
a separator-anchored segment asserted true. `test/lint-doc-prose.test.ts` carries that pair for the
entries it owns, `docs/memory-system.md` lints while `memory/` does not, and a project that
extends the list adds the pair for its entry.

## What a project weighs before exempting a tree

Is the content actually unauthored? A tree copied in and then patched locally is authored from the
first patch onward, and an exemption over it hides drift in text the project owns. The exemption
and the never-edit rule stand or fall together: when the project starts editing the tree, the
exemption goes, and the tree becomes a deliverable that lints like any other. Is it read? The
internal-traffic exemptions rest on nobody reading the text. This one rests on nobody here writing
it, and a vendored tree that is neither read nor cited is a tree to delete. And which consumers lint
it? One hook in one project takes a skip-list entry. A tree installed into several checkouts and
linted by a manual skill as well takes a config section, with the anchor chosen against every path
those consumers pass.

The cost is a comment per tree and a measurement per tree, and the comment is where the reason
lives. An entry reading `docs/<upstream>-reference/` with nothing beside it is indistinguishable, a
year on, from a generated-file skip somebody forgot to remove, and the next person to find a real
tell in that tree has nothing telling them the finding is the trap described above.

## The reference copies

The account-level lint kit at `~/.claude/tools/prose-lint/.vale.ini` carries its per-tree sections
at the end of the file, each under a comment block holding its measurements; the vendored-skill
section is `[**/skills/not-ai/**]`, and the style-contract section above it is where both footguns
were first measured. The write hook at `core/claude/hooks/lint-doc-prose.ts` and the commit hook at
`core/claude/hooks/pre-commit` carry the skip lists a project extends, and `test/lint-doc-prose.test.ts`
pins the set each one carries. The downstream project's fork of the write hook adds one line to
`SKIP_PATHS` for its vendored reference directory, shaped like the `docs/assets/` entry above it,
with a comment reading "vendored upstream docs (verbatim)". The in-file directive is exercised by
the account layer's own style rules file, which carries one on its first line for the same reason a
style contract needs one: it quotes what it bans.

## Related

[`forcing-functions.md`](forcing-functions.md): its list of what never promotes includes a path
tuned to one system, and that is the split here, with the entry staying in the downstream hook and
only the reason travelling.
[`fail-contract.md`](fail-contract.md): an exemption that is too wide fails open without a trace,
and zero findings is what a linter's fail-open looks like.
[`test-falsifiability.md`](test-falsifiability.md): the probe outside the tree is what lets the
measurement come out two ways.
