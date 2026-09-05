#Requires -Version 7
# Generates styles/Cringely/Vocabulary.yml from (a) the canonical banned-word list
# and (b) the slop-forensics frequency-derived list (top 100, minus exclusions).
# One-way rule: vocabulary lives in the beautiful_prose skill; this script derives, never defines.
$ErrorActionPreference = 'Stop'

# (a) Canonical list — mirrors the skill's banned vocabulary (single words only;
# multi-word phrases are covered by ai-tells FillerPhrases or the skill's prompt rules).
$canonical = @(
  'delve','dive into','leverage','utilize','robust','holistic','seamless','comprehensive',
  'pivotal','crucial','vital','essential','unprecedented','transformative',
  'revolutionary','game-changer','streamline','empower','foster','harness',
  'underscore','highlight','paradigm','synergy','tapestry','landscape',
  'ecosystem','realm','nuanced','facilitate','operationalize','innovative',
  'cutting-edge','state-of-the-art'
)

# (b) slop-forensics list — SANCTIONED FALLBACK: canonical-only, no external list merged.
# Checked 2026-07-10: data/slop_list.json in sam-paech/slop-forensics is derived from the
# repo's default creative-writing benchmark corpus (README: "by default we are producing
# creative writing outputs"). Confirmed by inspection: the shipped list is dominated by
# fantasy character names (adira, aethelgard, azazel) and dialogue verbs (barked, bellowed,
# blared) — fiction-domain slop, not corporate/technical AI-tell vocabulary. False-positive
# risk against real infra/security prose. The repo does not ship a non-fiction/business/
# general-prose variant; producing one requires re-running the profiling pipeline against a
# different corpus (README: "change the dataset and prompts in slop_forensics/config.py"),
# which is out of scope for this generator. slop-score (sam-paech/slop-score) was also
# checked and only ships prompts.json + a general wordfreq corpus (Google Books Ngrams,
# Wikipedia, OpenSubtitles, etc.) — no curated non-fiction AI-tell list either.
# Decision: ship canonical-only. Do not merge $slopWords until a fit list exists upstream.
$slopWords = @()

# Exclusions: technical terms that appear in real infra/security prose.
$exclude = @('docker','container','token','repository','pipeline','endpoint','runtime')

$words = ($canonical + $slopWords) |
  ForEach-Object { $_.ToString().ToLowerInvariant().Trim() } |
  Where-Object { $_ -and $_.Length -ge 4 -and $exclude -notcontains $_ } |
  Sort-Object -Unique

$styleDir = Join-Path $PSScriptRoot 'styles\Cringely'
New-Item -ItemType Directory -Force $styleDir | Out-Null

$yml = @"
extends: existence
message: "Banned vocabulary (AI tell): '%s'. See beautiful_prose contract."
level: warning
ignorecase: true
tokens:
"@
$words | ForEach-Object { $yml += "`n  - $_" }
Set-Content -Path (Join-Path $styleDir 'Vocabulary.yml') -Value $yml -Encoding utf8NoBOM
Write-Host "Wrote $($words.Count) tokens to styles/Cringely/Vocabulary.yml"
