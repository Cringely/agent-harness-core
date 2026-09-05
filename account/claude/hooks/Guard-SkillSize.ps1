# PreToolUse:Skill guard - blocks a skill invocation only when its payload would overflow the
# context window as it stands right now.
#
# Why: invoking a skill injects its ENTIRE directory tree, not just the entry file, and not scoped
# by the args passed. On 2026-07-24 a `claude-api` invocation injected ~226k tokens in one message,
# tripped auto-compaction twice, and cost ~$5.62 in cache writes. See memory note
# `skill-invocation-context-cost`. A window cap is a trailing control; this is the leading one.
#
# Adaptive, not a fixed budget: a heavy skill in a fresh window is affordable, and a fixed ceiling
# would make that skill permanently unloadable. The guard measures live context from the session
# transcript and blocks only when this injection would cross $UsableFraction of the window.
# There is deliberately no absolute ceiling - a skill larger than the whole window fails at load,
# which is a broken skill, not a job for the fuse.
#
# REQUIRES $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW. Without a known window there is no headroom to
# compare against, so the guard goes inert (allows everything) rather than guess. Guessing a
# smaller window than the real one is what produces false blocks, and a false block on a skill is
# worse than the cost it would have saved.
#
# Escape hatch: $env:CLAUDE_SKILL_TOKEN_BUDGET=<n> pins a fixed threshold and skips the adaptive
# path entirely.
#
# Exit 0 = allow. Exit 2 = block, stderr goes back to the model as the reason.

param(
    [switch]$SelfTest,
    [string]$InputJson   # test seam; production reads stdin
)

# Leave room for the model's own reply plus the tool result that follows the injection.
$UsableFraction = 0.92

# $env:USERPROFILE is undefined on Linux, where the interpolated form collapsed to
# "\.claude\skills", resolved to nothing, and left Get-SkillDirectory returning $null. The
# hook path below then hits `if (-not $dir) { exit 0 }` and allows every skill: a guard that
# has quietly stopped guarding. $HOME is defined on both platforms.
#
# $env:LOCALAPPDATA is undefined there too, and unlike the old string interpolation a
# Join-Path with an empty first argument throws rather than producing a harmless dud, so the
# bundled root is added only when the variable holds something. Get-SkillDirectory already
# skips a root that fails Test-Path, so dropping it costs nothing on Linux.
function Get-SkillRoot {
    $roots = @(
        (Join-Path (Join-Path $HOME '.claude') 'skills')
        (Join-Path (Join-Path $HOME '.claude') 'plugins')
    )
    if ($env:LOCALAPPDATA) {
        $roots += (Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'Temp') 'claude') 'bundled-skills')
    }
    return @($roots)
}

$SkillRoots = @(Get-SkillRoot)

# Env vars are hand-typed and arrive as strings. A bare [int] cast on "400k" throws, and the
# throw is non-terminating inside a function, so execution used to fall through to a default and
# silently substitute a window half the real size - which then blocked a skill that fit fine.
# Anything not a positive integer reads as unset.
function ConvertTo-PositiveInt {
    param([string]$Value)
    $n = 0
    if ([int]::TryParse($Value, [ref]$n) -and $n -gt 0) { return $n }
    return $null
}

function Get-SkillDirectory {
    param([string]$SkillName)

    # Plugin skills arrive as "plugin:skill"; the directory is named for the skill half.
    $leaf = ($SkillName -split ':')[-1]
    if ([string]::IsNullOrWhiteSpace($leaf)) { return $null }

    # Several roots can hold a directory of the same name, and some are empty stubs.
    # Take the heaviest match - that is the one that would actually cost us. Presence of a
    # SKILL.md would be a cleaner filter but is not usable: all 24 directories that match
    # `claude-api` across the bundled-skills root lack one.
    $best = $null; $bestSize = -1
    foreach ($root in $SkillRoots) {
        if (-not (Test-Path $root)) { continue }
        $hits = Get-ChildItem -LiteralPath $root -Recurse -Directory -Filter $leaf -ErrorAction SilentlyContinue
        foreach ($h in $hits) {
            $size = Measure-SkillTokens -Path $h.FullName
            if ($size -gt $bestSize) { $bestSize = $size; $best = $h.FullName }
        }
    }
    return $best
}

# Media and archive payloads are not injected as prose, so counting their bytes as tokens
# produces false blocks. Measured case: wiring-diagram is 677 KB on disk but only 27 KB of text -
# two PNGs and two SVGs account for the rest, and a naive byte count would have blocked a skill
# that costs ~6.8k tokens to load.
$BinaryExtensions = @(
    '.png','.jpg','.jpeg','.gif','.bmp','.ico','.webp','.svg','.pdf',
    '.zip','.tar','.gz','.7z','.rar','.woff','.woff2','.ttf','.otf','.eot',
    '.mp3','.mp4','.wav','.mov','.avi','.exe','.dll','.so','.dylib','.pyc','.wasm'
)

function Measure-SkillTokens {
    param([string]$Path)
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $BinaryExtensions -notcontains $_.Extension.ToLower() } |
            Measure-Object -Property Length -Sum).Sum
    if (-not $sum) { return 0 }
    return [int]($sum / 4)   # bytes/4 is the standard rough token approximation
}

# Current context size = the last main-thread usage record in the transcript. input_tokens counts
# only the uncached tail, so the three fields must be summed to get real occupancy. Sidechain
# (subagent) records carry their own separate context and would understate ours.
# Returns 0 when unknown, which makes the guard permissive rather than blocking blind.
function Get-CurrentContextTokens {
    param([string]$TranscriptPath)
    if (-not $TranscriptPath -or -not (Test-Path -LiteralPath $TranscriptPath)) { return 0 }
    try {
        # Whole file, not -Tail N. A fixed tail silently missed the last usage record whenever
        # that many trailing lines carried none (a burst of parallel subagent entries does it),
        # and the miss read as "context unknown" - permissive, so a 198k skill sailed through at
        # 350k occupancy. @() matters too: a single-line file returns a bare string, and indexing
        # a string yields one character.
        $lines = @(Get-Content -LiteralPath $TranscriptPath -ErrorAction Stop)
    } catch { return 0 }

    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        if ($lines[$i] -notmatch '"usage"') { continue }
        try { $entry = $lines[$i] | ConvertFrom-Json } catch { continue }
        if ($entry.isSidechain -eq $true) { continue }
        $u = $entry.message.usage
        if (-not $u) { continue }
        $total = [int]$u.input_tokens + [int]$u.cache_read_input_tokens + [int]$u.cache_creation_input_tokens
        # Keep scanning past a zero total on purpose: a partial or placeholder record can carry a
        # usage object with only output_tokens set, and stopping there would report an empty
        # window. A genuinely zero context and an unknown one are the same answer here anyway.
        if ($total -gt 0) { return $total }
    }
    return 0
}

if ($SelfTest) {
    $failures = 0
    function Assert-Equal {
        param($Expected, $Actual, [string]$Label)
        if ($Expected -ne $Actual) { Write-Host "FAIL: $Label - expected $Expected, got $Actual"; $script:failures++ }
        else { Write-Host "pass: $Label" }
    }

    # Env parsing: the two casts that used to throw.
    Assert-Equal 400000 (ConvertTo-PositiveInt '400000') 'parses a plain integer'
    Assert-Equal $null (ConvertTo-PositiveInt '400k') 'rejects 400k instead of throwing'
    Assert-Equal $null (ConvertTo-PositiveInt 'not-a-number') 'rejects non-numeric'
    Assert-Equal $null (ConvertTo-PositiveInt '-5') 'rejects negative'
    Assert-Equal $null (ConvertTo-PositiveInt '') 'rejects empty'

    # Binary assets must not count: wiring-diagram is 677 KB on disk but ~6.8k tokens of text.
    $mediaHeavy = Get-SkillDirectory -SkillName 'wiring-diagram'
    if ($mediaHeavy) {
        $t = Measure-SkillTokens -Path $mediaHeavy
        if ($t -gt 20000) { Write-Host "FAIL: wiring-diagram measured $t tok, expected < 20000 (binary assets must not count)"; $failures++ }
        else { Write-Host "pass: wiring-diagram $t tok (binary assets excluded)" }
    } else {
        Write-Host "skip: wiring-diagram not found"
    }

    if (Get-SkillDirectory -SkillName 'no-such-skill-xyzzy') { Write-Host "FAIL: unknown skill resolved"; $failures++ }
    else { Write-Host "pass: unknown skill resolves to null (fails open)" }

    # Context reader: sums three fields, ignores sidechain records, takes the last main-thread one.
    $tmp = Join-Path $env:TEMP "guard-skillsize-selftest.jsonl"
    @(
        '{"isSidechain":false,"message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}}'
        '{"isSidechain":false,"message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":98,"cache_read_input_tokens":300000}}}'
        '{"isSidechain":true,"message":{"usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":5}}}'
    ) | Set-Content -LiteralPath $tmp -Encoding utf8
    Assert-Equal 300100 (Get-CurrentContextTokens -TranscriptPath $tmp) 'reads last main-thread record, skips sidechain'
    Assert-Equal 0 (Get-CurrentContextTokens -TranscriptPath "$tmp.missing") 'missing transcript returns 0 (fails open)'

    # Single-line transcript: Get-Content returns a bare string there, and indexing a string gave
    # one character, which read as "context unknown" and disabled the guard.
    $one = Join-Path $env:TEMP "guard-skillsize-selftest-1line.jsonl"
    '{"isSidechain":false,"message":{"usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":4000}}}' |
        Set-Content -LiteralPath $one -Encoding utf8
    Assert-Equal 4003 (Get-CurrentContextTokens -TranscriptPath $one) 'single-line transcript reads'
    Remove-Item -LiteralPath $one -ErrorAction SilentlyContinue

    # Deep tail: the real usage record buried under more usage-less lines than any fixed tail
    # bound would cover. A -Tail 200 scan reported 0 here and allowed a 198k skill at 350k.
    $deep = Join-Path $env:TEMP "guard-skillsize-selftest-deep.jsonl"
    $deepLines = New-Object System.Collections.Generic.List[string]
    $deepLines.Add('{"isSidechain":false,"message":{"usage":{"input_tokens":0,"cache_creation_input_tokens":100,"cache_read_input_tokens":350000}}}')
    1..400 | ForEach-Object { $deepLines.Add('{"isSidechain":true,"type":"tool_result","content":"subagent chatter"}') }
    $deepLines | Set-Content -LiteralPath $deep -Encoding utf8
    Assert-Equal 350100 (Get-CurrentContextTokens -TranscriptPath $deep) 'finds usage record buried under 400 usage-less lines'
    Remove-Item -LiteralPath $deep -ErrorAction SilentlyContinue

    # End to end: same skill blocked in a nearly-full window, allowed in a fresh one.
    $heavy = Get-SkillDirectory -SkillName 'claude-api'
    if ($heavy) {
        $heavyTokens = Measure-SkillTokens -Path $heavy
        $window = ConvertTo-PositiveInt $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW
        if (-not $window) {
            Write-Host "skip: CLAUDE_CODE_AUTO_COMPACT_WINDOW unset, guard is inert on this machine"
        } else {
            $headroomFull = [int]($window * $UsableFraction) - 300100
            $headroomFresh = [int]($window * $UsableFraction)
            if ($heavyTokens -le $headroomFull) { Write-Host "FAIL: claude-api ($heavyTokens tok) fits $headroomFull headroom at 300k context, expected block"; $failures++ }
            else { Write-Host "pass: claude-api $heavyTokens tok blocked against $headroomFull headroom at 300k context" }
            if ($heavyTokens -gt $headroomFresh) { Write-Host "FAIL: claude-api ($heavyTokens tok) blocked even in a fresh window ($headroomFresh) - no skill should be permanently unloadable"; $failures++ }
            else { Write-Host "pass: claude-api allowed in a fresh window ($headroomFresh headroom)" }
        }
    } else {
        Write-Host "skip: claude-api not installed on this machine"
    }

    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue

    if ($failures) { Write-Host "SELFTEST FAILED ($failures)"; exit 1 }
    Write-Host "SELFTEST OK"; exit 0
}

# --- hook path ---
# Everything below fails open. A broken guard must never block real work, so the whole body is
# wrapped: an earlier version guarded only the JSON parse, and a cast failure past that point
# blocked every skill regardless of size.
try {
    $raw = if ($InputJson) { $InputJson } else { [Console]::In.ReadToEnd() }
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $payload = $raw | ConvertFrom-Json

    $skillName = $payload.tool_input.skill
    if (-not $skillName) { $skillName = $payload.tool_input.name }
    if (-not $skillName) { exit 0 }

    $dir = Get-SkillDirectory -SkillName $skillName
    if (-not $dir) { exit 0 }

    $tokens = Measure-SkillTokens -Path $dir

    $pinned = ConvertTo-PositiveInt $env:CLAUDE_SKILL_TOKEN_BUDGET
    if ($pinned) {
        $limit = $pinned
        $reason = "pinned budget $pinned"
    }
    else {
        $window = ConvertTo-PositiveInt $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW
        if (-not $window) {
            # No known window, no honest comparison, so allow. Say so on stderr: this path is
            # invisible otherwise, and a guard that has quietly stopped guarding is worse than one
            # that is loudly absent. Stderr on exit 0 reaches hook debug output, not the model.
            [Console]::Error.WriteLine("Guard-SkillSize inert: CLAUDE_CODE_AUTO_COMPACT_WINDOW is unset or not a positive integer (got '$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW'), so skill payload size is not being checked.")
            exit 0
        }
        $current = Get-CurrentContextTokens -TranscriptPath $payload.transcript_path
        $limit = [int]($window * $UsableFraction) - $current
        $reason = "$current tok already in a $window window leaves $limit"
    }

    if ($tokens -le $limit) { exit 0 }

    $largest = Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
               Sort-Object Length -Descending | Select-Object -First 3

    $lines = @(
        "BLOCKED: skill '$skillName' would inject about $tokens tokens; $reason."
        "Invoking a skill loads its whole directory, not just the entry file, and args do not scope it."
        "Path: $dir"
        "Largest files:"
    )
    foreach ($f in $largest) { $lines += ("  {0} KB  {1}" -f [int]($f.Length / 1KB), $f.FullName.Substring($dir.Length).TrimStart('\')) }
    $lines += "Read the specific file you need instead, or compact first. To override for one session: `$env:CLAUDE_SKILL_TOKEN_BUDGET=$($tokens + 1)"

    [Console]::Error.WriteLine(($lines -join "`n"))
    exit 2
}
catch { exit 0 }
