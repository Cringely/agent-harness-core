# Scans memory and council transcript writes for accidental secret leaks.
# Called by PreToolUse hook on Write|Edit targeting memory or transcript paths.
# Outputs a blocking message if secrets are detected; empty output = allow.
#
# FAILS OPEN for most uncertain paths, and the direction is deliberate: malformed stdin,
# an absent content or file_path field, and any error at all exit 0 and let the write
# through, because $ErrorActionPreference is SilentlyContinue. A scanner that blocks
# writes when it cannot parse its own input would brick every write on the first
# payload-shape change upstream. The cost of that choice is that a silent failure looks
# exactly like a clean scan, so this hook is a backstop and never the only control: Lint
# step 6 re-scans the corpus, and ~/.claude/rules/security.md governs what may be written
# in the first place.
#
# One deliberate exception: an unresolvable $HOME cannot build the roots this hook needs,
# but a write that already looks like a memory or council write by path shape alone still
# gets scanned rather than passing unscanned. Everything else still exits 0, uncertain or
# not; see the guard below for exactly what counts as looking in scope.
#
# Second blind spot, same direction: the roots below are derived from $HOME. A
# memory directory outside the user's own ~/.claude is not scanned, and exits 0 at
# the root check rather than reporting that it declined to look.

$ErrorActionPreference = 'SilentlyContinue'

$j = [Console]::In.ReadToEnd() | ConvertFrom-Json
$content = $j.tool_input.content
if (-not $content) { $content = $j.tool_input.new_string }
if (-not $content) { exit 0 }

$path = $j.tool_input.file_path
if (-not $path) { exit 0 }

$np = $path -replace '/', '\'

# $HOME empty or whitespace leaves Join-Path unable to build a root at all. Under
# SilentlyContinue the assignment below would abort, both roots would stay $null,
# StartsWith($null) would throw and get swallowed too, and the hook would exit 0 having
# scanned nothing. That is a fail-open regression the hardcoded literals this replaced never
# had, since a string literal cannot resolve empty. The path's own shape needs no $HOME, so
# it is the fallback scope test: out of shape exits 0 same as always, in shape falls through
# to the same content scan below instead of blocking outright. The scan needs no roots
# either, only $content, so this narrows what gets scanned rather than refusing every
# in-scope write regardless of content: a clean note still saves, only one carrying a
# secret blocks. Blocking outright here would brick every memory write on the exact
# Linux/container/CI population that has no other reason to hit an unresolvable $HOME.
if ([string]::IsNullOrWhiteSpace($HOME)) {
    $looksInScope = ($np -match '\\\.claude\\projects\\.*\\memory\\') -or ($np -match '\\council-transcripts\\')
    if (-not $looksInScope) { exit 0 }
}
else {
    # Roots are derived from $HOME. Each Join-Path result is normalised to backslashes
    # after the join, not before it: Join-Path inserts the platform's own separator
    # (forward slash on Linux, backslash on Windows), so normalising $claudeHome once and
    # joining again would only put that separator back inside the result, leaving it a
    # non-match for $np's backslashes. Nested two-argument Join-Path throughout, not the
    # multi-segment form: this hook may run under Windows PowerShell 5.1, where a third
    # positional argument is a binding error.
    $claudeHome = Join-Path $HOME '.claude'
    $memRoot = ((Join-Path $claudeHome 'projects') -replace '/', '\') + '\'
    $councilRoot = ((Join-Path $claudeHome 'council-transcripts') -replace '/', '\') + '\'
    $isMemory = $np.StartsWith($memRoot) -and $np -match '\\memory\\'
    $isCouncil = $np.StartsWith($councilRoot)
    if (-not $isMemory -and -not $isCouncil) { exit 0 }
}

$findings = [System.Collections.Generic.List[string]]::new()

$patterns = @(
    @{ Name = 'API token (tk_/sk_/ak_)';    Regex = '(?<![a-zA-Z0-9_])(tk_|sk_|ak_)[a-zA-Z0-9]{10,}' }
    @{ Name = 'Bearer token';                Regex = 'Bearer\s+[a-zA-Z0-9\-_.]{20,}' }
    @{ Name = 'Generic secret assignment';   Regex = '(?i)(password|secret|token|api[_-]?key)\s*[=:]\s*[''"]?[^\s''"]{8,}' }
    @{ Name = 'Base64-encoded long secret';  Regex = '(?<![a-zA-Z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![a-zA-Z0-9+/=])' }
    @{ Name = 'Private key block';           Regex = '-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----' }
    @{ Name = 'AWS-style key';               Regex = 'AKIA[0-9A-Z]{16}' }
    @{ Name = 'Hex token (32+ chars)';       Regex = '(?<![a-zA-Z0-9])[0-9a-f]{32,}(?![a-zA-Z0-9])' }
)

foreach ($p in $patterns) {
    if ($content -match $p.Regex) {
        $match = $Matches[0]
        $preview = if ($match.Length -gt 20) { $match.Substring(0, 12) + '...' + $match.Substring($match.Length - 4) } else { $match }
        $findings.Add("  - $($p.Name): ``$preview``")
    }
}

if ($findings.Count -gt 0) {
    $msg = "BLOCKED: Possible secrets detected in memory/transcript write to $($np | Split-Path -Leaf):`n"
    $msg += ($findings -join "`n")
    $msg += "`n`nRemove the sensitive values before writing. Use placeholders like ``<redacted>`` or ``(in secrets/...)``. To override, ask the user to confirm."
    Write-Output $msg
    exit 2
}

exit 0
