# Account Layer Portability: Design

Date: 2026-09-03. Status: accepted.

## Problem

Claude Code on this workstation runs against a heavily customised account layer at
`C:\Users\user\.claude\`: eleven rules files, eight agent definitions, sixteen skills, a Vale
prose-lint kit, eight hook scripts, two statusline scripts, and a `settings.json` wiring them
together. None of it exists anywhere else. A second Windows box or a Linux/WSL box starts from a
bare `~/.claude/`: the guards, the review discipline and the prose linter all stay behind.

The strongest case for this work is a guard that already existed and enforced nothing. An
account-scope `Guard-ModelTier.ts` (17,171 bytes, now `.bak.20260903-122041`) sat unregistered
for three weeks because registering it was a manual step nobody took. Its file mtime,
2026-08-11 12:37, is the only evidence for that start date; git holds nothing for it. Its
successor, `core/claude/hooks/model-tier-gate.ts`, first landed as `8577ae4` on 2026-08-15 (#44),
and that commit is the evidence for the core date. Today a byte-identical copy of the core file
was placed at `~/.claude/hooks/model-tier-gate.ts` and wired as a new `PreToolUse` group at
position 0, matcher `Agent|Task|Workflow`. Verified live: it blocks a model-less `Agent` dispatch
and a `Workflow` whose `agent()` call omits `model`, both exit 2, and its 127-case unit suite
passes. Unproven: that Claude Code sends `tool_name: "Workflow"`; the test payload asserted that
name. A guard that needs hand-registration on every machine will sit unregistered somewhere, and
no distribution path for the account layer is why this one did.

The project installer does not close the gap. `install/Install-Harness.ps1` ships `core/claude/`
into `<target>/.claude/`, and its whole contract hangs off a project root: git `core.hooksPath`
wiring, `guardrails.md`, ceremony gates, a drift manifest keyed to one repo. The account layer has
none of those. `install/Restore-ClaudeProject.ps1` comes closer, and this design borrows three of
its functions (`Convert-HookCommand`, `Test-ResidualWindowsPath`, `Get-ProjectSlug`), but it is a
one-shot mover. It is bundle-shaped, requires `-RepoPath`, refuses a
non-empty destination unless `-Force` (L251-252), and never overwrites an existing
`settings.json`. A tool that runs after every `git pull` needs the opposite on all four counts.

## What is on disk today

Measured 2026-09-03, after the gate was wired. `rules/` holds 11 authored files, `agents/` 8,
`skills/` 16 directories (about 1.3 MB, nine authored, seven vendored from microsoft/hve-core).
`tools/prose-lint/` carries `.vale.ini`, `Build-CringelyStyle.ps1`, `README.md`, `fixtures/`,
`styles/Cringely/` (authored) and `styles/ai-tells/` (vendored). `hooks/` has four `.ps1`, three
`.ts`, one `.sh`, and `Guard-ModelTier.HANDOFF.md`, whose registration snippet names a script
renamed to `.bak.*` today. Dozens of stale `.bak.*` files sit beside them, 32 at review and 33 by
the end of it, since `change-management.md`'s back-up-before-editing rule mints one per edit. Two
statusline scripts sit at the root, referenced by nothing; `statusLine.command` points at
ccstatusline. There is no `commands/`, `keybindings.json`, root `CLAUDE.md` or `.mcp.json`;
`secrets/` is empty. `~/.claude/` totals 2.56 GB, of which `projects/` alone is 1.9 GB across
5,900 files.

`settings.json` cannot travel as it stands. Every hook command is absolute, in three quoting
forms: `& 'C:\Users\user\.claude\hooks\Scan-MemorySecrets.ps1'` for the four `.ps1` hooks, each
with `"shell": "powershell"`; `bun "C:\Users\user\.claude\hooks\model-tier-gate.ts"` and the
matching `bash "..."` form for the `.ts` and `.sh` hooks; and unquoted
`node C:/Users/user/AppData/Roaming/npm/node_modules/ccstatusline/dist/ccstatusline.js` in
`statusLine.command` and two hook entries. The file also carries `permissions.defaultMode: "auto"`,
`skipDangerousModePermissionPrompt: true`, and `env.CLAUDE_CODE_USE_POWERSHELL_TOOL: "1"`. Claude
Code writes it itself, too: `/plugin` flips `enabledPlugins`, and `effortLevel`,
`alwaysThinkingEnabled` and `teammateMode` change from the UI.

MCP servers are not under `~/.claude/` at all. They live under `mcpServers` in `~/.claude.json`,
a 135 KB file that is otherwise 46 project entries, `userID`, `anonymousId`, statsig caches and
onboarding flags. Only `garmin` is portable (`uvx` plus a git URL). `1password` runs
`C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe`,
a Store path with an embedded version that the next 1Password update breaks here too.
`code-context` runs `wsl -e /home/prior/code-context-mcp.sh`, a Windows-only launcher into a WSL
user's home. All three `env` blocks are empty.

Three consumers resolve the Vale kit independently and all fail open when it is missing:
`~/.claude/hooks/Lint-DocumentProse.ps1` line 71, `core/claude/hooks/lint-doc-prose.ts`
(`resolveValeConfig`) and `core/claude/hooks/pre-commit` line 73. Vale here is 3.15.1.
`.vale.ini` uses `StylesPath = styles`, relative, so it needs no rewriting.

## Decisions

Each of these was argued out with the operator and is settled.

1. **This workstation is canonical.** Config is authored in `~/.claude/` here, exported into the
   repo, and consumed elsewhere. One direction. Receiving boxes are consumers, and a divergence
   on a receiver is a bug rather than a fork to preserve.
2. **Scope is everything:** rules, settings, hooks, tools, skills, agents, plugins, and MCP
   server config. Vendored skills ship too. The goal is reproducing this box, and a local copy
   pins a known-good version where a marketplace fetch would not.
3. **Targets are Windows and Linux/WSL.** No macOS requirement.
4. **Update path is `git pull` then re-run the installer.** Symlinks were rejected on operator
   preference and because Windows symlinks need Developer Mode. Scheduled sync was rejected
   because config would change under a running session.
5. **No manifest or drift machinery in v1.** Install overwrites. `settings.local.json` is the
   per-machine escape hatch. Revisit if a receiver ever needs to diverge on a non-settings file.
6. **Memory notes are out of scope.** `~/.claude/projects/` is 1.9 GB, and its folder names are
   slugged from each repo's absolute path, so a note only lands correctly when the repo sits at
   the same path. The Obsidian vault, written by `Sync-MemoryToObsidian.ps1`, is memory's
   cross-machine channel; `Restore-ClaudeProject.ps1` still covers a deliberate per-project move.
7. **No `-Scope Account` on `Install-Harness.ps1`.** The two share only a copy loop. Everything
   else in that script assumes a project root.
8. **`permissions.defaultMode: "auto"` and `skipDangerousModePermissionPrompt: true` ship.**
   Excluding them was recommended and the operator overruled it, which is the operator's call.
   The cost, recorded once: a receiver has the dangerous-operation confirmation disabled from
   first launch, and a bad pull propagates that to every box at once.
9. **Skills with machine paths get fixed in this pass**, not shipped known-broken. All three fail
   quietly rather than loudly, which is the worst failure shape for a skill.

## Payload

A new `account/claude/` tree mirrors `~/.claude/`:

```
account/claude/
  rules/                  11 .md; harness-core.md carries {{CORE_REPO}}
  agents/                  8 .md, verbatim
  skills/                 16 dirs; four carry placeholders (Bugs 7 and 8)
  tools/prose-lint/       .vale.ini, styles/{Cringely,ai-tells}/, fixtures/,
                          Build-CringelyStyle.ps1, README.md
  hooks/                  4 .ps1, 2 .ts, 1 .sh; the .sh carries {{CORE_REPO}}
                          (model-tier-gate.ts is sourced from core/ at install)
  statusline-command.ps1  unreferenced today; the npm-absent branch points at them
  statusline-command.sh
  settings.account.json   templated: {{CLAUDE_HOME}}, {{NPM_GLOBAL}}
  mcp-servers.json        fragment merged into ~/.claude.json
```

`Guard-ModelTier.HANDOFF.md` is not in the payload: it is internal agent traffic, and its
registration snippet names a file that no longer exists under that name. `model-tier-gate.ts` is
not in it either, and an implementer reading the tree should not add it. Core is authoritative
for that file; two copies in one repo would drift the moment either was edited, and a single
upstream is the point of this design. The exporter skips it, and `Install-Account.ps1` copies it
from `core/claude/hooks/model-tier-gate.ts` in the same clone it is running out of. That gives
the account layer a dependency on `core/`, which is fine inside one repo and would stop being
fine if the two were ever split.

`styles/ai-tells/` ships as files. `.vale.ini` still declares
`Packages = https://github.com/tbhb/vale-ai-tells/releases/download/v1.21.2/ai-tells.zip`, but
nothing runs `vale sync` at install: no network dependency, and the rule set is pinned by content
rather than by a release tag that can be moved or deleted.

Placeholders, and where each expands from: `{{CLAUDE_HOME}}` is the receiver's `~/.claude`;
`{{NPM_GLOBAL}}` is `npm root -g`; `{{CORE_REPO}}` is the running clone's own location;
`{{OBSIDIAN_VAULT}}` is `$env:CLAUDE_OBSIDIAN_VAULT` or the fallback named under Bug 2; and
`{{HOME_SLUG}}` is the receiver's home directory slugged the way Claude Code slugs project paths:
`Get-ProjectSlug` (Restore L151-170), `-creplace '[^A-Za-z0-9]', '-'`, extracted from the
claude-code bundle per its header at L140-150, so `C:\Users\user` becomes `C--Users-user` and
`/home/u` becomes `-home-u`. The same function cuts a slug over 200 characters and appends a
base-36 hash of the untruncated path; `~/.claude/projects/` already holds one such directory,
left by an earlier session's `slugprobe`, and no home directory comes near the bound. The last
two placeholders are this spec's addition, forced by Bug 8. All five expand in forward-slash form
on every platform; PowerShell on Windows accepts `& 'C:/...'`, and Linux accepts nothing else.

## Export-Account.ps1

Runs on this workstation only. `-ClaudeHome` redirects the account home (the parameter Restore
documents at L46-50 and declares at L84, for real runs and not only tests); `-ClaudeJson` does the
same for `~/.claude.json`; `-OutputRoot` overrides the destination, which defaults to the running
clone's `account/claude/`.

The rest are test seams, each with a real default. `-CoreRepo` (the main checkout, from
`git rev-parse --git-common-dir`), `-NpmGlobal` (`npm root -g`), `-VaultPath`
(`$env:CLAUDE_OBSIDIAN_VAULT`, then the Documents path), `-HomeSlug` (`Get-ProjectSlug $HOME`),
and the `-SkipSettings` and `-SkipMcp` switches. Without them a test would have to shell out to
`git` and `npm` and read the operator's live vault to reach a branch, and a child `pwsh` takes
`$HOME` from `USERPROFILE` rather than `$env:HOME`, so a stand-in home cannot be steered from
outside. `Restore-ClaudeProject.ps1:88-95` is the precedent: it added `-TargetIsWindows` for the
same reason and records that the branch was otherwise unreachable from any test on a Windows host.

The copy works from an allowlist, never a denylist. The allowlist is the tree above and nothing
else under `~/.claude/` is looked at, so a new runtime directory appearing there is excluded by
default rather than swept into the repo. Export mirrors rather than overlays: each allowlisted
directory is deleted and recopied, so a file removed from `~/.claude/` leaves the repo on the next
export instead of accreting there forever. Within allowed directories every `*.bak.*` is dropped.
`settings.local.json`, `.credentials.json`, `projects/`, `plugins/cache/` and every state
directory never enter the allowlist.

Two rewrites happen on the way out, both the settings mechanism rather than source fixes.
`settings.json` becomes `settings.account.json` by replacing `<home>\.claude` with
`{{CLAUDE_HOME}}` and the npm global root with `{{NPM_GLOBAL}}`, across all three quoting forms;
order is immaterial, since the npm path is not under `.claude`. The whole rewritten path is
normalised to forward slashes, not only the prefix, or a Linux receiver ends up with
`/home/u/.claude\hooks\x.ps1`. The same pass re-templates the six model-read files that carry
machine paths (Bugs 5 through 8), which is what makes the installer safe to run on the canonical
box: install expands, the next export folds the literals back, and the round trip is a no-op.
For that to hold, every fold matches both separator spellings, because install writes
forward-slash form and this box's originals are backslashed. Each fold has a source: the
`-ClaudeHome` value for `{{CLAUDE_HOME}}`; `npm root -g` for `{{NPM_GLOBAL}}`; `$HOME` for
`{{HOME_SLUG}}` and for the `{{OBSIDIAN_VAULT}}` fallback; and for `{{CORE_REPO}}` the main
checkout, resolved through `git rev-parse --git-common-dir`, so an export run from a worktree
under `.claude/worktrees/` folds the real path rather than the worktree's. The exporter reuses
only the `$homePattern` idiom from `Convert-HookCommand` (Restore L192, both spellings of one
prefix). Calling that function whole at export is wrong in both directions: its Linux branch
welds the `pwsh -NoProfile -File` rewrite in at L245-247, which would ship Linux commands to
Windows receivers, and its Windows branch (L195-197) does not slash the tail. The installer may
call it whole, with `$OldHome` set to `{{CLAUDE_HOME}}`.

The `mcpServers` key is lifted out of `~/.claude.json` into `mcp-servers.json` under the same
rewrite. Every string in it runs through the regex table at `Scan-MemorySecrets.ps1:37-45`, and
the export fails closed on a match; server entries reach secrets through 1Password or an
environment variable, never inline. `garmin` ships as-is and works anywhere. `1password` and
`code-context` ship as-is and do not: no placeholder can express a Store path with an embedded
version or a WSL user's home, so a placeholder would be pretending. The receiver-side residual
report names them instead.

A second export with nothing changed produces no diff, which makes `git status` after an export a
usable review of what changed in the account layer.

## Install-Account.ps1

Runs on any workstation from a clone, as `pwsh -NoProfile -File install/Install-Account.ps1`,
with `-ClaudeHome` and a `[bool]` `-TargetIsWindows` defaulted from `$IsWindows` as Restore L95
does. Alongside those: `-ClaudeJson`, `-PayloadRoot`, `-CoreRepo`, `-NpmGlobal`, `-VaultPath`,
`-HomeSlug` and the `-SkipPreflight` switch, on the same test-seam reasoning as the exporter's.
`-VaultPath` and `-HomeSlug` are not optional extras: expansion of `{{OBSIDIAN_VAULT}}` and
`{{HOME_SLUG}}` has no other source, and derived internally they would take the runner's real
`$HOME`, which makes the export-install-export round trip untestable. Both scripts declare
`[CmdletBinding(PositionalBinding=$false)]`; Restore L71-95 records that a new parameter
otherwise turns positional without warning. Content directories are copied
over the top of `~/.claude/`. The copy cannot do four things on its own.

**Placeholder expansion.** The five placeholders expand as listed under Payload. If `npm` is
absent the installer warns, drops the two ccstatusline hook entries, and points
`statusLine.command` at the shipped script for the platform (`statusline-command.ps1` on
Windows, `statusline-command.sh` elsewhere) rather than writing a command that cannot run. That
branch is the only thing that references the two scripts, and whether they still run on a
receiver is untested (Still unresolved, below).

**Linux rewrite.** On a non-Windows target, every hook entry of the form `& 'x.ps1'` with
`"shell": "powershell"` becomes `pwsh -NoProfile -File 'x.ps1'` with the `shell` key removed;
otherwise the command string is handed to `/bin/sh` and never runs. `Convert-HookCommand` (Restore
L189-248) already does the prefix and the `&` rewrite and never touches the `shell` key, so that
removal is new code. The four `.ps1` files in `hooks/` are the same four entries carrying
`"shell": "powershell"`, so the rewrite covers the whole PowerShell surface, though it keys on the
invocation form rather than the count. The same branch drops `env.CLAUDE_CODE_USE_POWERSHELL_TOOL`,
as Restore L435-437 does.

**Settings merge.** The payload is deep-merged into any existing `settings.json` rather than
replacing it, because Claude Code writes that file: an overwrite would revert every `/plugin`
toggle and UI setting on the receiver each time the operator pulled. The merge covers `env`,
`permissions.allow`, `enabledPlugins`, `extraKnownMarketplaces`, `skillOverrides`, `hooks`,
`statusLine`, and top-level scalars. Objects merge recursively, payload winning on a shared key
and receiver-only keys kept; `permissions.allow` is an ordered set union; a hook entry's identity
is its event, matcher and expanded command, so a present entry is replaced in place, a missing one
appended, a receiver-only one left alone; `statusLine` is replaced whole. Re-running is idempotent.
`Install-Harness.ps1`'s merge (L808-866) keys on the command string alone and is not reusable.
`mcpServers` is the one key where the receiver wins: entries merge into `~/.claude.json` as
add-if-missing, and an existing entry is left alone. Payload-wins there would loop with shipping
`1password` and `code-context` as-is: the receiver hand-fixes the two entries, the next pull
reverts them, and `settings.local.json` cannot reach `~/.claude.json` to hold the fix. Nothing
else in that file is touched. Every collection that gets indexed, counted or serialised is
wrapped in `@()`, per `install/Install-Harness.ps1:826`.

**Preflight and residual report.** Before copying, the installer warns when `vale`, `bun`,
`pwsh` 7, `node`, `bash` (Git Bash on Windows) or `uvx` is missing; `jq` joins the list on Linux
when the npm-absent branch points at `statusline-command.sh`, which calls it three times. Every consumer fails open,
so without the warning the kit goes silently dead on a fresh box. After expansion, every hook,
`statusLine` and `mcpServers` command is tested for "carries an absolute path that does not exist
on this machine", and each hit is printed. `Test-ResidualWindowsPath` (Restore L183-187, matching
`[A-Za-z]:[\\/]` or `USERPROFILE`) is kept as the classifier printed beside each hit, telling the
operator whether a dead path is Windows-shaped, and not as the filter. It cannot be the filter and
still meet the criterion below: on a Windows receiver every correctly expanded command carries a
drive letter, so it names all of them, and it never fires on `code-context`'s
`wsl -e /home/prior/code-context-mcp.sh`, which has neither a drive letter nor `USERPROFILE`. The
report names `1password` and `code-context` by design; anything else it names is an exporter bug.
The install still completes.

## Bugs fixed in transit

The account layer carries more machine-specific paths than the five this design started with;
review found nine further sites across four hooks and three skills, and the first is the headline.
They divide by fix mechanism. Executed hooks are fixed at the source in `~/.claude/`, since a hook
can derive its paths at run time. Model-read text (rules, skills, the `.sh` heredoc) cannot be,
because a placeholder in the live file is read literally on this box; those get the export-time
rewrite, mirrored by install-time expansion.

1. `hooks/Scan-MemorySecrets.ps1:29-33`. This is the `PreToolUse` secret scanner, and its roots
   are absolute literals, `$memRoot = 'C:\Users\user\.claude\projects\'` and
   `$councilRoot = 'C:\Users\user\.claude\council-transcripts\'`. Line 33 exits 0 when neither
   matches, and the header at L14-16 admits it. On any receiver neither branch ever matches, so
   the scanner exits 0 for every write. The control works here and scans nothing everywhere
   else. `change-management.md` already names the family, a scope filter that resolves empty
   must fail closed, and this one fails open. Fix: derive both roots from `$HOME`, and push them
   through the same normalisation the incoming path gets. L28 does `$np = $path -replace '/', '\'`
   before the `StartsWith`, so a root built as `Join-Path (Join-Path $HOME '.claude') 'projects'`
   comes out forward-slashed on Linux, never matches, and leaves the hook exiting 0 exactly as
   today. The smallest form is
   `$memRoot = ((Join-Path (Join-Path $HOME '.claude') 'projects') -replace '/', '\') + '\'`,
   trailing separator kept, and the same for the council root. Nested two-argument calls, never a
   three-argument one: Windows PowerShell 5.1 rejects the third positional argument with "A
   positional parameter cannot be found that accepts argument", measured on 5.1.26100.9278.
2. `hooks/Sync-MemoryToObsidian.ps1`, six sites, not one. L14 hardcodes the vault, L17 the
   council root, L56 the memory root, L47 a regex anchored on `^C:\\Users\\user\\\.claude\\`,
   and L39 and L49 the slug literal `'C--Users-user'`. An environment variable for the vault
   reaches one of six and leaves the hook a no-op on every receiver. Fix: derive `$claudeHome`
   from `$HOME` with the same `-replace '/', '\'` and trailing separator as bug 1, since L13
   normalises the incoming path the same way, and build L47's regex source from that normalised
   root, escaped; derive the slug with the `-creplace` from `Get-ProjectSlug`, inlined; read the
   vault from `$env:CLAUDE_OBSIDIAN_VAULT`, falling back to
   `Join-Path (Join-Path (Join-Path $HOME 'Documents') 'Obsidian Vault') 'Claude Code'`, the
   current path here, so another box never mints a foreign username's directory tree.
3. `hooks/Lint-DocumentProse.ps1:71` builds the kit path as
   `Join-Path $HOME '.claude\tools\prose-lint\.vale.ini'`. Backslashes are not separators on
   Linux, so the path never resolves and the kit never loads. Fix: nested two-argument
   `Join-Path`, one segment per call. Not the three-argument form: this file declares
   `#Requires -Version 5.1` at line 1, and 5.1 rejects a third positional argument (measured on
   5.1.26100.9278).
4. `hooks/Guard-SkillSize.ps1:34-35` reads `$env:USERPROFILE` twice, undefined on Linux, and
   L218's `if (-not $dir) { exit 0 }` fails open when no root resolves. Fix: nested two-argument
   `Join-Path` from `$HOME`, same 5.1 constraint as bug 3 (`"$HOME\.claude\skills"` would repeat
   bug 3). L36's `$env:LOCALAPPDATA` is also undefined there. In the interpolated form that line
   is cosmetic, because `Get-SkillDirectory` skips a root that fails `Test-Path`. Converted to
   `Join-Path` it stops being cosmetic: an empty first argument throws rather than producing a
   path that fails `Test-Path`, so the bundled root goes inside `if ($env:LOCALAPPDATA)`.
5. `hooks/harness-core-reminder.sh:18` hardcodes `E:\projects\agent-harness-core` twice in its
   heredoc. Export-time `{{CORE_REPO}}`.
6. `rules/harness-core.md:3,10`, the same literal. Export-time `{{CORE_REPO}}`.
7. `skills/prose-lint/SKILL.md:14` hardcodes `C:\Users\user\.claude\tools\prose-lint\.vale.ini`
   in the command the model is told to run. A `$HOME`-relative form is wrong here, because Git
   Bash `$HOME` on this box is `/c/Users/user/Documents` (`change-management.md:122`), so that
   fix breaks the skill here the moment the model runs `vale` through the Bash tool. Export-time
   `{{CLAUDE_HOME}}`.
8. `skills/handoff/SKILL.md:21,70` hardcode the vault's `Handoffs` path;
   `skills/council/SKILL.md:195-198` map `C:\Users\user` to `C--Users-user`;
   `skills/subagent-prompting/SKILL.md:55` carries both the slug and the vault path. On a
   receiver `/handoff` writes to a path that does not exist and nothing says so. Export-time
   `{{OBSIDIAN_VAULT}}` and `{{HOME_SLUG}}`.

`rules/ssh.md:27` names `C:\Users\user\.ssh\config`, and `rules/change-management.md:122`
records the Git Bash `$HOME` trap by its literal path. Both describe this machine on purpose and
stay as they are; backlog item 13 already calls `ssh.md` account-only by construction.

## Excluded, and what v1 does not do

`settings.local.json` stays on each machine; it is the escape hatch. `.credentials.json` is a
credential. `projects/` is decision 6. `plugins/cache/` is excluded on the expectation that a
receiver repopulates it from the `enabledPlugins` and `extraKnownMarketplaces` entries it
receives, so that plugins travel as settings rather than as files. That expectation is unverified.
`plugins/` also holds `installed_plugins.json`, `known_marketplaces.json`, `blocklist.json` and
`marketplaces/`, none of which ship, and the `extraKnownMarketplaces` entries (`ponytail`,
`caveman`) are arbitrary GitHub repos rather than the official marketplace, the least likely case
to auto-fetch. The clean-`~/.claude` install test settles it. Everything else under `~/.claude/`
is runtime state.

Two limits follow from decision 5 and are not defects. Removal does not propagate to receivers: a
hook entry or file deleted on the canonical box stays there, because the copy overwrites and the
merge adds (the repo side mirrors and does not share this). And nothing detects a receiver that
edited an installed file; the next install reverts it without comment. Both are the intended
behaviour of a one-way consumer; the manifest machinery that would change them is what decision 5
declines to build.

## Still unresolved

- Which host runs `"shell": "powershell"` on a Windows receiver. `Lint-DocumentProse.ps1:1`
  says `#Requires -Version 5.1`, but `Sync-MemoryToObsidian.ps1:24,41,49,67` use three- and
  five-argument `Join-Path`, which is pwsh 7 only. If the host is Windows PowerShell 5.1, that
  hook fails on every Windows receiver without pwsh on PATH.

  This work narrows the question without answering it. Every path build it writes uses nested
  two-argument `Join-Path`, valid on both hosts, so nothing added here depends on the answer.
  Those four sites in `Sync-MemoryToObsidian.ps1` are pre-existing and sit outside the six sites
  bug 2 touches; they keep the question open and are not this work's to close.
- The Linux location of bundled skills for `Guard-SkillSize.ps1:36`.
- Whether plugins repopulate from settings alone (above).
- Whether Claude Code sends `tool_name: "Workflow"` to the model-tier gate (Problem, above).
- Whether `statusline-command.ps1` and `.sh` run on a receiver at all; nothing has pointed at
  them since ccstatusline took over, and the npm-absent branch is the first thing that will.

## Tests

`install/Export-Account.Tests.ps1` and `install/Install-Account.Tests.ps1`, Pester, invoked as
`pwsh -NoProfile -File`; `CONTRIBUTING.md` measured that bare `Invoke-Pester` exits 0 on a red run.
Every fixture is a planted stand-in tree; no test asserts a count against the live `~/.claude/`,
which moves under any session that edits it. The cases that carry weight:

- The Linux rewrite, through `-TargetIsWindows:$false` on a Windows host: the
  `pwsh -NoProfile -File` form, the absent `shell` key, the dropped
  `CLAUDE_CODE_USE_POWERSHELL_TOOL`.
- Merge-not-clobber, against a stand-in `settings.json` holding keys the payload does not carry,
  which must survive, and a hook entry already present, which must not duplicate on a second run.
- The allowlist, by planting an unexpected file under a stand-in `~/.claude/` and confirming the
  export leaves it behind; `.bak.*` exclusion; and mirror semantics, by deleting a fixture file
  and confirming the next export removes it from `-OutputRoot`.
- `@()` wrapping: a one-element hooks array must serialise as an array.
- Placeholder round trip: export from a stand-in, install into an empty stand-in, hook commands
  resolve to real files, all five placeholders expand in the files that carry them, and install
  followed by export yields no diff.
- The `mcpServers` lift through `-ClaudeJson`, the secret gate refusing a planted token, the merge
  leaving every other key of a stand-in `~/.claude.json` untouched, a hand-edited `1password`
  entry surviving a second install, and the residual report naming the two non-portable entries.
- `model-tier-gate.ts` absent from `-OutputRoot` after export and present under the stand-in
  `~/.claude/hooks/` after install, byte-identical to `core/claude/hooks/model-tier-gate.ts`.
- The npm-absent branch drops the statusline entries and warns.
- A clean-`~/.claude` install on a real second machine, recorded as the evidence for the plugins
  claim.

## Prerequisites

On a receiver: pwsh 7 (the installer itself is PowerShell) and git. For the full experience,
`vale`, `bun`, `node` with a global `ccstatusline`, Git Bash on Windows for the `.sh` hook, and
`uvx` for the `garmin` server, and `jq` on a Linux box that falls back to
`statusline-command.sh`; each is optional only in the sense that its consumer fails open, which
is what the preflight makes visible. `CLAUDE_OBSIDIAN_VAULT` is set only on a box whose
vault sits somewhere other than `Documents/Obsidian Vault/Claude Code` under the user's home.

## Relationship to the backlog and to CONTRIBUTING

This partly closes `docs/backlog.md` item 1, which asks whether the rules files stay global-only,
move into `patterns/`, or get baked into the guardrails template. The answer here is that core
becomes the distributor of the account layer without becoming its owner. Rules are still authored
in `~/.claude/rules/` and exported from there; the repo's copy is downstream. Item 1 also records
that "core cannot reach the account layer" is a false premise re-derived more than once. This
design settles the ownership question, workstation owns and core distributes, and it should stop
being re-litigated.

Item 13 is adjacent and out of scope. It compares `~/.claude/rules/` coverage against what an
installed project receives and notes that `patterns/` is installed by nothing. That is the project
layer. This work touches only the account layer, and item 13's questions are unchanged by it.

CONTRIBUTING's Gate 1 applies: each script ships in the same commit as its registration, which for
an operator-invoked installer means the README and `harness-core.md` text naming the command, plus
its test file. The two-occurrences bar at CONTRIBUTING line 13 does not govern this work; it
decides when a finding graduates from a project into core, and nothing here is graduating. This is
a new distribution path for content core never claimed to own, so the missing second-project
citation is not an oversight.
