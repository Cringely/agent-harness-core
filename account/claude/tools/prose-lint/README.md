# Vale Prose Lint Kit

This kit provides prose style linting for Markdown documents using Vale and the `vale-ai-tells` package, pinned to v1.21.2.

## Installation

Vale is installed via winget. Installed version: **3.15.1**

The Vale configuration at `.vale.ini` references the `vale-ai-tells` package version **1.21.2** pinned by URL in the `Packages` directive.

## Usage

Run Vale on a Markdown file:

```powershell
vale --config "$HOME\.claude\tools\prose-lint\.vale.ini" <file.md>
```

Or shorter, from this directory:

```powershell
Set-Location "$HOME\.claude\tools\prose-lint"
vale <file.md>
```

## Package Updates

To update to a newer `vale-ai-tells` release:

1. Edit `.vale.ini` and bump the version in the URL: `Packages = https://github.com/tbhb/vale-ai-tells/releases/download/v<NEW_VERSION>/ai-tells.zip`
2. Run `vale sync` to download and extract the updated package
3. Re-run both fixtures to confirm no new false positives: `vale fixtures/sloppy.md` and `vale fixtures/clean.md`
4. Update the version number in this README

## Rules and Disabling

### Vocabulary (One-Way)

`ai-tells` is the third-party `tbhb/vale-ai-tells` upstream package, used as-is and never hand-edited. It is not derived from this kit's own contract. The personal vocabulary list lives in the Cringely style, generated from the `beautiful_prose` skill (see below).

### Cringely Style (Generated Vocabulary)

`styles/Cringely/Vocabulary.yml` is a second, local vocabulary style layered on top of `ai-tells` (`BasedOnStyles = ai-tells, Cringely` in `.vale.ini`). It exists to catch the exact banned words from the `beautiful_prose` skill's canonical list as a plain word-existence check, independent of `ai-tells`' own (broader, inflection-aware) vocabulary rules.

**One-way rule**: the canonical word list lives in the `beautiful_prose` skill. `Vocabulary.yml` is generated from it by `Build-CringelyStyle.ps1` and must never be hand-edited. To update it, edit the `$canonical` array in the script (to match the skill) and re-run:

```powershell
pwsh -NoProfile -File "$HOME\.claude\tools\prose-lint\Build-CringelyStyle.ps1"
```

**slop-forensics outcome (2026-07-10)**: the script originally also merged in the top-100 words from `sam-paech/slop-forensics`' `data/slop_list.json`, intending to add corporate AI-tell vocabulary beyond the canonical list. That data is derived from the repo's default creative-writing benchmark corpus and is dominated by fantasy character names (`adira`, `aethelgard`, `azazel`) and dialogue verbs (`barked`, `bellowed`, `blared`) — fiction-domain slop, not technical/business AI-tell vocabulary, and a false-positive risk against real infra/security prose. Neither `sam-paech/slop-forensics` nor `sam-paech/slop-score` ships a non-fiction/business/general-prose variant of this list; producing one requires re-running the profiling pipeline against a different corpus, which is out of scope for this generator. The script now ships **canonical-only** (`$slopWords = @()`, with the reasoning recorded inline). Revisit if/when an upstream non-fiction slop list appears.

### Disabling Rules

Two escape hatches exist:

**Per-rule in `.vale.ini`** (applies to all files):

```ini
[*.md]
BasedOnStyles = ai-tells
ai-tells.RuleName = NO
```

Add a one-line comment naming why the rule conflicts with the local contract.

**Inline in Markdown** (applies to a single passage):

```markdown
<!-- vale RuleName = NO -->
Text that would otherwise trigger the rule.
<!-- vale RuleName = YES -->
```

Rule names are shown in the vale output (e.g., `ai-tells.EmDashUsage`).

## Fixtures

Two fixture files are used for verification:

- `fixtures/sloppy.md` — triggers multiple findings (EmDashUsage, ContrastiveFormulas, OverusedVocabulary, HedgingPhrases)
- `fixtures/clean.md` — passes cleanly with zero errors/warnings

These fixtures are reused by the prose-lint skill and skillgrade grader test (Task 4).
