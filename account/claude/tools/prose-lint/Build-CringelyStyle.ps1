#Requires -Version 7
# Generates styles/Cringely/Vocabulary.yml from (a) the canonical banned-word list
# and (b) the slop-forensics frequency-derived list (top 100, minus exclusions).
# One-way rule: vocabulary lives in writing-style.md, not here. This script derives, never defines.
$ErrorActionPreference = 'Stop'

# (a) Canonical list — mirrors writing-style.md's banned vocabulary (single words only;
# multi-word phrases are covered by ai-tells FillerPhrases or writing-style.md's prompt rules).
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
message: "Banned vocabulary (AI tell): '%s'. See writing-style.md."
level: warning
ignorecase: true
tokens:
"@
$words | ForEach-Object { $yml += "`n  - $_" }
Set-Content -Path (Join-Path $styleDir 'Vocabulary.yml') -Value $yml -Encoding utf8NoBOM
Write-Host "Wrote $($words.Count) tokens to styles/Cringely/Vocabulary.yml"

# (c) US spelling substitutions -> styles/Cringely/UsSpelling.yml.
# One-way rule again: the pairs live in writing-style.md's "US English" section, and this
# derives the Vale swap map from them. Explicit stems and fixed pairs, never a blanket "-ise"
# pattern, because a pattern would flag exercise, premise, promise, otherwise and the other
# words that are -ise in American English too. Vale 3.15.1 masks inline code spans and fenced
# blocks, so a quoted identifier such as Map.CellCentre does not fire. A quoted directive in
# running prose takes an inline <!-- vale Cringely.UsSpelling = NO --> comment.
$swap = [ordered]@{}

# Stems that take -ise/-ises/-ised/-ising/-isation(s)/-iser(s) in British spelling.
$izeStems = @(
  'organ','normal','renormal','recogn','penal','summar','priorit','minim','maxim','initial',
  'serial','synchron','author','custom','categor','standard','util','final','general','special',
  'optim','real','visual','apolog','capital','critic','central','local','material','stabil',
  'harmon','formal','familiar','mobil','neutral','virtual','container','parameter','modular',
  'random','token','sanit','memor','legal','emphas','sensit','digit','civil','legitim','item'
)
$izeSuffixes = [ordered]@{ ise='ize'; ises='izes'; ised='ized'; ising='izing'; isation='ization'; isations='izations'; iser='izer'; isers='izers' }
foreach ($stem in $izeStems) {
  foreach ($k in $izeSuffixes.Keys) { $swap["$stem$k"] = "$stem$($izeSuffixes[$k])" }
}

# Fixed pairs. "analyses" is deliberately absent, it is also the plural of "analysis".
$fixed = [ordered]@{
  analyse='analyze'; analysed='analyzed'; analysing='analyzing'; analyser='analyzer'
  paralyse='paralyze'; paralysed='paralyzed'
  behaviour='behavior'; behaviours='behaviors'; behavioural='behavioral'
  colour='color'; colours='colors'; coloured='colored'; colouring='coloring'; colourful='colorful'
  favour='favor'; favours='favors'; favoured='favored'; favouring='favoring'; favourite='favorite'; favourites='favorites'
  honour='honor'; honours='honors'; honoured='honored'; honouring='honoring'
  neighbour='neighbor'; neighbours='neighbors'; neighbouring='neighboring'
  labour='labor'; flavour='flavor'; flavours='flavors'; humour='humor'; rumour='rumor'; rumours='rumors'
  centre='center'; centres='centers'; centred='centered'; centring='centering'
  metre='meter'; metres='meters'; fibre='fiber'; fibres='fibers'; theatre='theater'
  licence='license'; licences='licenses'; defence='defense'; offence='offense'; pretence='pretense'
  judgement='judgment'; judgements='judgments'; acknowledgement='acknowledgment'
  catalogue='catalog'; catalogues='catalogs'; catalogued='cataloged'; cataloguing='cataloging'
  programme='program'; programmes='programs'; artefact='artifact'; artefacts='artifacts'
  grey='gray'; sceptic='skeptic'; sceptical='skeptical'; ageing='aging'; mould='mold'; tyre='tire'
  practise='practice'; practised='practiced'; practising='practicing'
  labelled='labeled'; labelling='labeling'; cancelled='canceled'; cancelling='canceling'
  modelled='modeled'; modelling='modeling'; travelled='traveled'; travelling='traveling'; traveller='traveler'
  signalled='signaled'; signalling='signaling'; fuelled='fueled'; fuelling='fueling'
  levelled='leveled'; levelling='leveling'; channelled='channeled'; channelling='channeling'
  counselled='counseled'; totalled='totaled'; totalling='totaling'; enrolment='enrollment'
  fulfil='fulfill'; instalment='installment'; skilful='skillful'; wilful='willful'
}
foreach ($k in $fixed.Keys) { $swap[$k] = $fixed[$k] }

$us = @"
extends: substitution
message: "Use US spelling: '%s' instead of '%s'. See the US English section of writing-style.md."
level: warning
ignorecase: true
swap:
"@
foreach ($k in ($swap.Keys | Sort-Object)) { $us += "`n  ${k}: $($swap[$k])" }
Set-Content -Path (Join-Path $styleDir 'UsSpelling.yml') -Value $us -Encoding utf8NoBOM
Write-Host "Wrote $($swap.Count) swaps to styles/Cringely/UsSpelling.yml"
