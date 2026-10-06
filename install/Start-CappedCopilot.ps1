<#
.SYNOPSIS
    Launches GitHub Copilot CLI with a per-session AI credit cap and a usage file.

.DESCRIPTION
    Starts `copilot` with `--max-ai-credits` set, so no session runs uncapped by default, and with
    `--usage-output-file` pointed at a per-user directory outside any repository. Every argument
    the wrapper does not own goes to `copilot` in order, as PowerShell binds it (see NOTES).

    The cap is a launch default, not enforcement. Copilot's in-session `/limits set
    max-ai-credits` command can override it, and so can raise it.

    What the cap does, per GitHub's documentation and changelog (issue #249, investigation 5):

    - The minimum is 30, and the cap is soft. A response already running when the cap is reached
      completes.
    - It applies across the conversation and resets on `/clear`.
    - Subagents count toward it according to the changelog only. The how-to page is silent, and
      says subagents run in their own session. Whether `/fleet` workers count, and whether caps
      aggregate across separate `copilot -p` processes, are unverified. Treat the cap as one cap
      per process.

    The usage file is the CLI's own JSON, with per-agent metrics since 1.0.81. Its schema is not
    yet documented, which is why the wrapper only collects it. The wrapper asks `copilot --help`
    whether each flag exists. A CLI without `--max-ai-credits` is refused rather than launched
    uncapped. A CLI without `--usage-output-file` launches capped, with a warning.

    The cap belongs here and not in an agent brief: agents are never told their budget.

    The wrapper never reads, sets or prints a token. Authentication is whatever the `copilot`
    process finds for itself.

.PARAMETER MaxAiCredits
    The session cap. A whole number, 30 or more. Defaults to 500, a starting value rather than a
    measured one, until the usage files show what a typical session costs.

.PARAMETER UsageDir
    Where usage files go, one per launch. Defaults to `agent-harness/copilot-usage` under the
    per-user local application data folder. Refused when it sits inside a git work tree, or when git is on PATH but cannot
    rule that out. Without git on PATH the wrapper resolves every junction and symlink in the path itself,
    walks the resolved path, and refuses when a component cannot be resolved.

.PARAMETER CopilotPath
    The CLI to launch. Defaults to `copilot` on PATH.

.NOTES
    Wrapper options are matched by exact name (case-insensitive) and everything else is passed
    through. The script deliberately declares no param block: PowerShell's binder would take a
    Copilot flag such as `-m` as a prefix of a wrapper parameter, or bind a bare value
    positionally. Passing `--max-ai-credits` or `--usage-output-file` through is refused, since
    the CLI would receive two values and which one wins is undocumented.

    Arguments reach `copilot` as PowerShell binds them, which is not always verbatim. Launched
    with `&` from PowerShell, a bare `--` is consumed by the caller's parser, and `-x:y` arrives
    split in two. Launched with `pwsh -File` from bash, `--model:gpt` arrives split in two and a
    bare `--%` is dropped.

.EXAMPLE
    pwsh -NoProfile -File install/Start-CappedCopilot.ps1 -MaxAiCredits 200 --model claude-sonnet-5
#>

$ErrorActionPreference = 'Stop'
$MinimumCap = 30

function Stop-Wrapper([string]$Message) {
    [Console]::Error.WriteLine("Start-CappedCopilot: $Message")
    exit 2
}

$capText = '500'
$usageDir = $null
$copilotPath = 'copilot'
$passThrough = [System.Collections.Generic.List[string]]::new()

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    $owned = switch ($arg) {
        '-MaxAiCredits' { 'cap' }
        '-UsageDir' { 'dir' }
        '-CopilotPath' { 'path' }
        default { $null }
    }
    if ($owned) {
        if ($i + 1 -ge $args.Count) { Stop-Wrapper "$arg needs a value." }
        $i++
        $value = [string]$args[$i]
        switch ($owned) {
            'cap' { $capText = $value }
            'dir' { $usageDir = $value }
            'path' { $copilotPath = $value }
        }
        continue
    }
    if ($arg -match '^--(max-ai-credits|usage-output-file)(=|$)') {
        Stop-Wrapper "pass $arg through -MaxAiCredits or -UsageDir instead. The wrapper sets it."
    }
    $passThrough.Add($arg)
}

# Digits only, so a sign, a decimal point or an empty value is refused before conversion.
$cap = 0
if ($capText -notmatch '^\d+$' -or -not [int]::TryParse($capText, [ref]$cap)) {
    Stop-Wrapper "-MaxAiCredits must be a whole number, got '$capText'."
}
if ($cap -lt $MinimumCap) {
    Stop-Wrapper "-MaxAiCredits $cap is below the CLI's documented minimum. The minimum is $MinimumCap."
}

$copilot = Get-Command $copilotPath -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $copilot) { Stop-Wrapper "'$copilotPath' was not found." }
$copilotExe = if ($copilot.Source) { $copilot.Source } else { $copilot.Name }

$help = (& $copilotExe --help 2>&1 | Out-String)
if ($help -notmatch '--max-ai-credits\b') {
    Stop-Wrapper "this copilot has no --max-ai-credits option, so it would run uncapped. Update it."
}

$launchArgs = [System.Collections.Generic.List[string]]::new()
$launchArgs.Add('--max-ai-credits')
$launchArgs.Add("$cap")

if ($help -match '--usage-output-file\b') {
    if (-not $usageDir) {
        # LOCALAPPDATA first: on Windows GetFolderPath ignores the variable, so a test cannot redirect it.
        $base = $env:LOCALAPPDATA
        if (-not $base) { $base = [Environment]::GetFolderPath('LocalApplicationData') }
        if (-not $base) { $base = $HOME }
        $usageDir = Join-Path (Join-Path $base 'agent-harness') 'copilot-usage'
    }
    $usageDir = [System.IO.Path]::GetFullPath($usageDir)

    # Refuse any work tree, not only the one launched from: the file is per-user telemetry.
    for ($dir = $usageDir; $dir; $dir = Split-Path -Parent $dir) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) {
            Stop-Wrapper "usage directory '$usageDir' is inside the git work tree at '$dir'. Pick a directory outside any repository."
        }
    }
    New-Item -ItemType Directory -Force -Path $usageDir | Out-Null

    # The walk above compares path text, so a junction or symlink into a repository, or a work tree
    # whose git dir lives elsewhere, passes it. Ask git, which resolves both, and fail closed: allow
    # only "not a git repository" or a clean "false". Any other git failure (dubious ownership,
    # safe.directory, permissions, broken config) means git could not say, so refuse.
    if (Get-Command git -ErrorAction SilentlyContinue) {
        # Git translates its messages (gettext, LANG/LC_ALL, the Windows display language), so the
        # "not a git repository" match below only holds in the C locale. Pin it for this one call.
        # The GIT_* variables redirect repository discovery (a caller's GIT_DIR makes git answer
        # for another repository), so clear them for the call too. The caller's values go back after.
        $gitVars = 'LC_ALL', 'LANGUAGE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'
        $saved = @{}
        foreach ($n in $gitVars) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
        try {
            foreach ($n in $gitVars) { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue }
            $env:LC_ALL = 'C'
            $env:LANGUAGE = ''
            # Cross mount points: without this git stops at one and says "not a git repository (or any
            # parent up to mount point ...)", which says nothing about the directory being outside.
            $env:GIT_DISCOVERY_ACROSS_FILESYSTEM = '1'
            $gitOut = (& git -C $usageDir rev-parse --is-inside-work-tree 2>&1 | Out-String).Trim()
            $gitExit = $LASTEXITCODE
        } finally {
            foreach ($n in $gitVars) { if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath "Env:$n" -Value $saved[$n] } }
        }
        $outside = ($gitExit -eq 0 -and $gitOut -eq 'false') -or ($gitExit -ne 0 -and $gitOut -match 'not a git repository' -and $gitOut -notmatch 'filesystem boundary|mount point')
        if (-not $outside) {
            Stop-Wrapper "usage directory '$usageDir' is inside a git work tree, or git could not rule it out (link, separate git dir, or git error: $gitOut). Pick a directory outside any repository."
        }
    } else {
        # No git to resolve links, so resolve them here one component at a time and walk the result.
        # A link target is re-split and re-resolved, because its own ancestors can be links. A
        # component that cannot be read or resolved means the check cannot decide, so refuse.
        try {
            $seps = [char[]]@('/', [System.IO.Path]::DirectorySeparatorChar)
            $cur = [System.IO.Path]::GetPathRoot($usageDir)
            $queue = [System.Collections.Generic.Queue[string]]::new()
            foreach ($p in $usageDir.Substring($cur.Length).Split($seps, [System.StringSplitOptions]::RemoveEmptyEntries)) { $queue.Enqueue($p) }
            $hops = 0
            while ($queue.Count -gt 0) {
                $name = $queue.Dequeue()
                if ($name -eq '.') { continue }
                if ($name -eq '..') {
                    $up = Split-Path -Parent $cur
                    if ($up) { $cur = $up }
                    continue
                }
                $item = Get-Item -LiteralPath (Join-Path $cur $name) -Force
                if ($item.LinkTarget) {
                    if (++$hops -gt 40) { throw 'too many links' }
                    # Raw target, unnormalised: the OS follows a link before applying "..", so each ".."
                    # must act on the already-resolved location, not on the text.
                    $target = [string]$item.LinkTarget -replace '^[\\?]{4}(?=[A-Za-z]:)', ''
                    $rest = @($queue)
                    $queue.Clear()
                    if ([System.IO.Path]::IsPathRooted($target)) {
                        $cur = [System.IO.Path]::GetPathRoot($target)
                        $target = $target.Substring($cur.Length)
                    }
                    foreach ($p in $target.Split($seps, [System.StringSplitOptions]::RemoveEmptyEntries)) { $queue.Enqueue($p) }
                    foreach ($p in $rest) { $queue.Enqueue($p) }
                } else {
                    $cur = $item.FullName
                }
            }
        } catch {
            Stop-Wrapper "usage directory '$usageDir' could not be resolved without git ($($_.Exception.Message)), so it cannot be shown to be outside a repository."
        }
        for ($dir = $cur; $dir; $dir = Split-Path -Parent $dir) {
            if (Test-Path -LiteralPath (Join-Path $dir '.git')) {
                Stop-Wrapper "usage directory '$usageDir' resolves to '$cur', inside the git work tree at '$dir'. Pick a directory outside any repository."
            }
        }
    }

    $stamp = (Get-Date -AsUTC).ToString('yyyyMMddTHHmmssZ', [System.Globalization.CultureInfo]::InvariantCulture)
    $usageFile = Join-Path $usageDir "copilot-usage-$stamp-$PID.json"
    $launchArgs.Add('--usage-output-file')
    $launchArgs.Add($usageFile)
    [Console]::Error.WriteLine("Start-CappedCopilot: cap $cap AI credits, usage file $usageFile")
} else {
    [Console]::Error.WriteLine("Start-CappedCopilot: cap $cap AI credits. This copilot has no --usage-output-file option, so no usage file is written.")
}

$launchArgs.AddRange($passThrough)
$global:LASTEXITCODE = 0
& $copilotExe @launchArgs
exit $LASTEXITCODE
