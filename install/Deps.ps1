# install/Deps.ps1
#
# The layer dependency preflight, dot-sourced by Install-Harness.ps1 and Install-Account.ps1.
# Defines functions only. core/claude/deps.json declares every tool a layer relies on, how
# strictly each layer needs it, how to probe it, and the one pinned command that installs it.
#
# The rules this file holds, so neither installer re-derives them:
#   - A missing or too-old hard dependency refuses the install before its first write. A missing
#     optional one warns. Both name the pinned command.
#   - Nothing is installed without -InstallDeps. With it, each pinned command goes through the
#     caller's ShouldProcess first, so -WhatIf prints the argv and runs nothing.
#   - Every external command goes through one runner, `& $Runner $argv $timeoutSeconds $cwd`,
#     returning ExitCode, Output and TimedOut. The tests replace it, so no suite probes or
#     installs a real tool.
#   - A probe that cannot answer (not on PATH, non-zero exit, timeout, no version in its output)
#     is absent. That is the fail-closed reading: an unanswered probe never counts as present.
#   - Install commands are argv arrays built from validated fields, never strings, and only from
#     winget, apt and npm, each pinned to an exact version, except one named exception: an apt spec
#     may carry `unpinned` (a reason sentence) instead of `version`, used for git on Linux (#310).
#     No download-and-execute form exists.

$script:DepsLayerNames = @('kernel', 'code', 'documents', 'physical')
$script:DepsProbeTimeout = 10
$script:DepsInstallTimeout = 900

# Version grammars, one per source. A range, a tag such as `latest`, or an empty string fails all
# three, which is the point: an install that resolves at run time is not a pin.
$script:DepsVersionGrammar = @{
    winget = '^\d+(\.\d+){1,3}$'
    npm    = '^\d+\.\d+\.\d+$'
    apt    = '^(\d+:)?[0-9][A-Za-z0-9.+~-]*$'
}
# Package names are argv elements, so a name that starts with a dash would be read as a flag.
$script:DepsNameGrammar = @{
    winget = '^[A-Za-z0-9][A-Za-z0-9.+_-]*$'
    npm    = '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$'
    apt    = '^[a-z0-9][a-z0-9.+-]+$'
}

function Get-DepsPlatform {
    param([Alias('IsWindows')][bool]$OnWindows)
    if ($OnWindows) { return 'windows' }
    return 'linux'
}

function Test-DepsVersionString {
    param([string]$Source, $Version)
    if ($Version -isnot [string] -or -not $Version) { return $false }
    if ($Version -match '[\s*<>=^]') { return $false }
    return $Version -match $script:DepsVersionGrammar[$Source]
}

# Reads and validates deps.json. Every refusal is a throw, and both installers call this before
# their first write, so a malformed manifest stops the run with nothing changed.
function Get-DepsManifest {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "deps manifest not found: $Path"
    }
    try {
        $m = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    }
    catch {
        throw "deps manifest does not parse as JSON: $Path"
    }
    if ($m -isnot [System.Collections.IDictionary]) { throw "deps manifest must be an object: $Path" }
    if ($m['schemaVersion'] -ne 1) { throw "deps manifest schemaVersion must be 1: $Path" }
    if ($m['deps'] -isnot [System.Collections.IList]) { throw "deps manifest 'deps' must be a list: $Path" }

    $entries = @($m['deps'] | Where-Object { $null -ne $_ })
    $names = @{}
    $allNames = @{}
    foreach ($e in $entries) {
        if ($e -isnot [System.Collections.IDictionary]) { throw "deps manifest: every entry must be an object." }
        $n = $e['name']
        if ($n -isnot [string] -or $n -notmatch '^[A-Za-z0-9][A-Za-z0-9._@-]*$') { throw "deps manifest: entry name '$n' is missing or malformed." }
        if ($allNames.Contains($n)) { throw "deps manifest: duplicate name '$n'. One entry per tool." }
        $allNames[$n] = $true
        # needs and onlyWhenAbsent are probed as tools, so only a tool name can satisfy them.
        if ($e['kind'] -ne 'plugin') { $names[$n] = $true }
    }

    foreach ($e in $entries) {
        $n = $e['name']
        $kind = 'tool'
        if ($e.Contains('kind')) { $kind = $e['kind'] }
        if (@('tool', 'plugin') -notcontains $kind) { throw "deps manifest: '$n' has unknown kind '$kind'." }

        $sev = $e['severity']
        if ($sev -isnot [System.Collections.IDictionary] -or $sev.Count -eq 0) { throw "deps manifest: '$n' needs a severity map." }
        foreach ($layer in @($sev.Keys)) {
            if ($script:DepsLayerNames -notcontains $layer) { throw "deps manifest: '$n' names unknown layer '$layer'." }
            if (@('hard', 'optional') -notcontains $sev[$layer]) { throw "deps manifest: '$n' has unknown severity '$($sev[$layer])' for $layer." }
        }
        if ($e['failMode'] -isnot [string] -or -not $e['failMode'].Trim()) { throw "deps manifest: '$n' needs a failMode sentence." }
        if ($kind -eq 'plugin') {
            Assert-DepsPluginEntry -Entry $e
            continue
        }

        if ($e.Contains('platforms')) {
            $p = $e['platforms']
            if ($p -isnot [System.Collections.IList] -or $p.Count -eq 0) { throw "deps manifest: '$n' platforms must be a non-empty list." }
            foreach ($x in $p) { if (@('windows', 'linux') -notcontains $x) { throw "deps manifest: '$n' names unknown platform '$x'." } }
        }
        if ($e.Contains('onlyWhenAbsent')) {
            $o = $e['onlyWhenAbsent']
            if ($o -isnot [string] -or -not $names.Contains($o) -or $o -eq $n) { throw "deps manifest: '$n' onlyWhenAbsent names unknown dependency '$o'." }
        }
        if ($e.Contains('resolve') -and $e['resolve'] -ne 'git-bash') { throw "deps manifest: '$n' has unknown resolve '$($e['resolve'])'." }
        if ($e.Contains('needs')) {
            $needs = $e['needs']
            if ($needs -isnot [System.Collections.IList]) { throw "deps manifest: '$n' needs must be a list." }
            foreach ($x in $needs) { if ($x -isnot [string] -or -not $names.Contains($x) -or $x -eq $n) { throw "deps manifest: '$n' needs unknown dependency '$x'." } }
        }

        $probe = $e['probe']
        if ($probe -isnot [System.Collections.IList] -or $probe.Count -eq 0) { throw "deps manifest: '$n' has an empty probe." }
        foreach ($x in $probe) { if ($x -isnot [string] -or -not $x) { throw "deps manifest: '$n' has an empty probe element." } }

        $min = $e['minVersion']
        $parsed = $null
        if ($min -isnot [string] -or $min -notmatch '^\d+(\.\d+){1,3}$' -or -not [version]::TryParse($min, [ref]$parsed)) {
            throw "deps manifest: '$n' minVersion '$min' is not a dotted version."
        }
        if ($e.Contains('versionPattern')) {
            try { $null = [regex]::new([string]$e['versionPattern']) }
            catch { throw "deps manifest: '$n' versionPattern does not compile." }
        }

        if ($e.Contains('install')) {
            $inst = $e['install']
            if ($inst -isnot [System.Collections.IDictionary]) { throw "deps manifest: '$n' install must be an object." }
            foreach ($plat in @($inst.Keys)) {
                $spec = $inst[$plat]
                if ($spec -isnot [System.Collections.IDictionary]) { throw "deps manifest: '$n' install.$plat must be an object." }
                $allowed = if ($plat -eq 'windows') { @('winget') } elseif ($plat -eq 'linux') { @('apt', 'npm') } else { throw "deps manifest: '$n' install names unknown platform '$plat'." }
                # `unpinned` is the one named exception to the exact-version rule (#310): an apt
                # install with a one-sentence reason in place of `version`. Everything else needs a pin.
                $isUnpinned = $spec.Contains('unpinned')
                $sources = @($spec.Keys | Where-Object { $_ -ne 'version' -and $_ -ne 'unpinned' })
                if ($isUnpinned) {
                    if ($plat -ne 'linux' -or $sources.Count -ne 1 -or $sources[0] -ne 'apt') {
                        throw "deps manifest: '$n' install.$plat unpinned is allowed only on an apt install."
                    }
                    if ($spec.Contains('version')) {
                        throw "deps manifest: '$n' install.$plat names both version and unpinned. Choose one."
                    }
                    if ($spec['unpinned'] -isnot [string] -or -not $spec['unpinned'].Trim()) {
                        throw "deps manifest: '$n' install.$plat unpinned needs a non-empty reason sentence."
                    }
                }
                elseif ($sources.Count -ne 1 -or $allowed -notcontains $sources[0]) {
                    throw "deps manifest: '$n' install.$plat must name exactly one of $($allowed -join ', ') and a version."
                }
                $src = $sources[0]
                if ($spec[$src] -isnot [string] -or $spec[$src] -cnotmatch $script:DepsNameGrammar[$src]) {
                    throw "deps manifest: '$n' install.$plat $src package '$($spec[$src])' is malformed."
                }
                if (-not $isUnpinned -and -not (Test-DepsVersionString -Source $src -Version $spec['version'])) {
                    throw "deps manifest: '$n' install.$plat version '$($spec['version'])' is not an exact $src version. A range or a tag is not a pin."
                }
            }
        }
    }
    return $m
}

# One record per dependency that applies to this platform and to at least one of the layers, with
# the strictest severity across them. The kernel always applies, whether or not it is listed.
function Get-RequiredDeps {
    param($Manifest, [string[]]$Layers, [Alias('IsWindows')][bool]$OnWindows)
    $plat = Get-DepsPlatform -IsWindows $OnWindows
    $active = @(@('kernel') + @($Layers | Where-Object { $_ }) | Select-Object -Unique)
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($e in @($Manifest['deps'] | Where-Object { $null -ne $_ })) {
        if ($e.Contains('platforms') -and @($e['platforms']) -notcontains $plat) { continue }
        $sev = $null
        foreach ($layer in $active) {
            if (-not $e['severity'].Contains($layer)) { continue }
            if ($e['severity'][$layer] -eq 'hard') { $sev = 'hard' }
            elseif (-not $sev) { $sev = 'optional' }
        }
        if (-not $sev) { continue }
        $out.Add([pscustomobject]@{ Name = $e['name']; Severity = $sev; Dep = $e })
    }
    # Unrolled on purpose: callers wrap the call in @(), and a unary comma here would hand them a
    # one-element array holding the whole list.
    return $out.ToArray()
}

function Get-DepsOutputText {
    param($Output)
    if ($null -eq $Output) { return '' }
    return (@($Output) | ForEach-Object { [string]$_ }) -join "`n"
}

# Git Bash is never taken from PATH: on Windows a bare `bash` can be the WSL launcher in System32
# or a WindowsApps alias, and either answers --version with a GNU bash banner that is not the
# shell Claude Code runs .sh hooks through. The Git root comes from `git --exec-path`
# (<root>/mingw64/libexec/git-core), else from -GitExe (<root>/cmd/git.exe).
function Resolve-GitBashPath {
    param([scriptblock]$Runner, [Alias('IsWindows')][bool]$OnWindows, [string]$GitExe)
    if (-not $OnWindows) { return $null }

    $roots = [System.Collections.Generic.List[string]]::new()
    $r = & $Runner @('git', '--exec-path') $script:DepsProbeTimeout $null
    if ($r -and -not $r.TimedOut -and $r.ExitCode -eq 0) {
        $line = @((Get-DepsOutputText $r.Output) -split '\r?\n' | Where-Object { $_.Trim() })
        if ($line.Count -gt 0) {
            $p = $line[0].Trim()
            $up = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $p))
            if ($up) { $roots.Add($up) }
        }
    }
    if ($GitExe) {
        $up = Split-Path -Parent (Split-Path -Parent $GitExe)
        if ($up) { $roots.Add($up) }
    }

    foreach ($root in $roots) {
        foreach ($rel in @('usr/bin/bash.exe', 'bin/bash.exe')) {
            $cand = Join-Path $root $rel
            if (-not (Test-Path -LiteralPath $cand -PathType Leaf)) { continue }
            $segments = @($cand -split '[\\/]')
            if (@($segments | Where-Object { $_ -eq 'System32' -or $_ -eq 'WindowsApps' }).Count -gt 0) { continue }
            return [System.IO.Path]::GetFullPath($cand)
        }
    }
    return $null
}

function New-DepResult {
    param([string]$Name, [bool]$Present, $Version, [bool]$MeetsMin, [string]$Reason)
    [pscustomobject]@{ Name = $Name; Present = $Present; Version = $Version; MeetsMin = $MeetsMin; Reason = $Reason }
}

function Test-Dep {
    param($Dep, [scriptblock]$Runner, [string]$GitExe, [Alias('IsWindows')][bool]$OnWindows)
    $name = $Dep['name']
    $argv = [string[]]@($Dep['probe'])
    if ($Dep['resolve'] -eq 'git-bash') {
        $bash = Resolve-GitBashPath -Runner $Runner -IsWindows $OnWindows -GitExe $GitExe
        if (-not $bash) { return New-DepResult $name $false $null $false 'Git Bash was not found under a Git for Windows install' }
        $argv = [string[]](@($bash) + @($argv | Select-Object -Skip 1))
    }

    $r = & $Runner $argv $script:DepsProbeTimeout $null
    if (-not $r) { return New-DepResult $name $false $null $false 'the probe returned nothing' }
    if ($r.TimedOut) { return New-DepResult $name $false $null $false 'the probe timed out' }
    if ($r.ExitCode -ne 0) { return New-DepResult $name $false $null $false "the probe exited $($r.ExitCode)" }

    # Non-capturing, so a custom versionPattern's first group is the only group this reads.
    $pattern = '\d+(?:\.\d+)+'
    if ($Dep.Contains('versionPattern')) { $pattern = [string]$Dep['versionPattern'] }
    $match = [regex]::Match((Get-DepsOutputText $r.Output), $pattern)
    if (-not $match.Success) { return New-DepResult $name $false $null $false 'the probe printed no version' }
    $text = $match.Value
    if ($match.Groups.Count -gt 1 -and $match.Groups[1].Success) { $text = $match.Groups[1].Value }
    $parts = @(([regex]::Match($text, '\d+(\.\d+)*').Value -split '\.') | Select-Object -First 4)
    if ($parts.Count -lt 2) { $parts = @($parts) + @('0') }
    $version = [version]($parts -join '.')
    $min = [version]$Dep['minVersion']
    if ($version -lt $min) {
        return New-DepResult $name $false $version $false "version $version is below minVersion $min"
    }
    return New-DepResult $name $true $version $true ''
}

function Get-DepInstallCommand {
    param($Dep, [Alias('IsWindows')][bool]$OnWindows)
    $plat = Get-DepsPlatform -IsWindows $OnWindows
    if (-not $Dep.Contains('install') -or -not $Dep['install'].Contains($plat)) { return $null }
    $spec = $Dep['install'][$plat]
    $v = [string]$spec['version']
    if ($spec.Contains('winget')) {
        return , ([string[]]@('winget', 'install', '--id', $spec['winget'], '--version', $v, '--exact', '--source', 'winget',
                '--silent', '--accept-package-agreements', '--accept-source-agreements'))
    }
    if ($spec.Contains('apt')) {
        # An unpinned spec (git on Linux, #310) installs whatever the archive currently carries.
        $target = if ($spec.Contains('unpinned')) { [string]$spec['apt'] } else { "$($spec['apt'])=$v" }
        return , ([string[]]@('sudo', 'apt-get', 'install', '-y', $target))
    }
    if ($spec.Contains('npm')) {
        # npm checks the tarball against the registry's integrity hash on install.
        return , ([string[]]@('npm', 'install', '-g', "$($spec['npm'])@$v"))
    }
    return $null
}

function Format-DepsArgv {
    param([string[]]$Argv)
    return (@($Argv) | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

# `needs` names what an npm install requires (bun and ccstatusline on Linux), so it is consulted
# only where this platform's install entry is an npm one. bun's winget install needs no npm.
function Get-DepNeeds {
    param($Dep, [Alias('IsWindows')][bool]$OnWindows)
    # Emits names, or nothing. Callers wrap the call in @().
    if (-not $Dep.Contains('needs')) { return }
    $plat = Get-DepsPlatform -IsWindows $OnWindows
    if (-not $Dep.Contains('install') -or -not $Dep['install'].Contains($plat)) { return }
    if (-not $Dep['install'][$plat].Contains('npm')) { return }
    $Dep['needs'] | Where-Object { $_ }
}

function Get-DepGuidance {
    param($Dep, [Alias('IsWindows')][bool]$OnWindows)
    $plat = Get-DepsPlatform -IsWindows $OnWindows
    $cmd = Get-DepInstallCommand -Dep $Dep -IsWindows $OnWindows
    if ($null -eq $cmd) {
        return "no pinned install for ${plat}: install $($Dep['name']) $($Dep['minVersion']) or later from a pinned release, then re-run"
    }
    return "install with: $(Format-DepsArgv $cmd)"
}

# Appends to this process's PATH every entry of the Machine and User scopes it lacks. Appends
# only, so nothing this process already resolves changes what it resolves to.
function Update-DepsProcessPath {
    param([scriptblock]$ReadScopedPath)
    $sep = [System.IO.Path]::PathSeparator
    $current = @(([string]$env:PATH) -split [regex]::Escape([string]$sep) | Where-Object { $_ })
    $seen = @{}
    foreach ($d in $current) { $seen[$d.TrimEnd('\', '/').ToLowerInvariant()] = $true }
    $added = [System.Collections.Generic.List[string]]::new()
    foreach ($scope in 'Machine', 'User') {
        foreach ($d in @(([string](& $ReadScopedPath $scope)) -split [regex]::Escape([string]$sep) | Where-Object { $_ })) {
            $key = $d.TrimEnd('\', '/').ToLowerInvariant()
            if ($seen.Contains($key)) { continue }
            $seen[$key] = $true
            $added.Add($d)
        }
    }
    if ($added.Count -gt 0) { $env:PATH = (@($current) + @($added)) -join $sep }
}

# The real runner. Resolves argv[0] as an application, never through a shell, starts it with
# stdin closed so a tool that waits on input cannot hang the install, reads both output streams
# asynchronously so a full pipe cannot deadlock the wait, and kills the whole process tree when
# the limit expires.
function Invoke-DefaultDepsRunner {
    param([string[]]$Argv, [int]$TimeoutSeconds, [string]$WorkingDirectory)
    $cmd = Get-Command -Name $Argv[0] -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return [pscustomobject]@{ ExitCode = 127; Output = ''; TimedOut = $false } }

    $psi = [System.Diagnostics.ProcessStartInfo]::new($cmd.Source)
    foreach ($a in @($Argv | Select-Object -Skip 1)) { $psi.ArgumentList.Add([string]$a) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }

    try { $p = [System.Diagnostics.Process]::Start($psi) }
    catch { return [pscustomobject]@{ ExitCode = 127; Output = ''; TimedOut = $false } }
    try {
        $p.StandardInput.Close()
        $stdout = $p.StandardOutput.ReadToEndAsync()
        $stderr = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)) {
            try { $p.Kill($true) } catch { }
            $null = $p.WaitForExit(5000)
            return [pscustomobject]@{ ExitCode = 124; Output = ''; TimedOut = $true }
        }
        $p.WaitForExit()
        $text = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        return [pscustomobject]@{ ExitCode = $p.ExitCode; Output = $text; TimedOut = $false }
    }
    finally { $p.Dispose() }
}

# Probes every dependency the layers need, then decides once. Without -InstallDeps a missing or
# old hard dependency throws one message listing each, and an optional one warns. With it, each
# missing dependency's pinned command (prerequisites first) goes through -ShouldInstall, runs with
# the install limit, and is re-probed. Writes nothing itself.
function Invoke-DepsPreflight {
    param(
        $Manifest,
        [string[]]$Layers,
        [Alias('IsWindows')][bool]$OnWindows,
        [bool]$InstallDeps,
        [scriptblock]$Runner,
        [scriptblock]$ShouldInstall,
        # Plugins: the one scope this caller owns (project for Install-Harness, user for
        # Install-Account), the working directory its plugin commands run in, the recorded hashes
        # (updated in place), and the project manifest's allowUnpinnedPlugins entries.
        [ValidateSet('', 'project', 'user')]
        [string]$PluginScope = '',
        [string]$PluginCwd,
        [hashtable]$PluginRecords = @{},
        [object[]]$AllowUnpinned = @(),
        # Presence the caller already knows, by dependency name, used for onlyWhenAbsent in place
        # of a probe. Install-Account passes npm's, because the same value decides whether the
        # statusline is routed to the jq script, and the two must not disagree.
        [hashtable]$KnownPresence = @{},
        # Test seams for the Windows PATH refresh after a winget install. ReadScopedPath gets
        # 'Machine' or 'User' and returns that scope's PATH. ResolveGitExe returns the git.exe
        # location Git Bash is resolved from.
        [scriptblock]$ReadScopedPath = { param($Scope) [Environment]::GetEnvironmentVariable('Path', $Scope) },
        [scriptblock]$ResolveGitExe = { (Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
    )

    $gitExe = & $ResolveGitExe
    $byName = @{}
    foreach ($e in @($Manifest['deps'] | Where-Object { $null -ne $_ })) { $byName[$e['name']] = $e }
    $cache = @{}
    $probe = {
        param([string]$Name)
        if (-not $cache.Contains($Name)) {
            $cache[$Name] = Test-Dep -Dep $byName[$Name] -Runner $Runner -GitExe $gitExe -IsWindows $OnWindows
        }
        $cache[$Name]
    }

    # An opt-in that names nothing deps.json declares as unpinned third-party is a typo or a stale
    # entry, and silently ignoring it would leave the operator believing a risk was accepted.
    foreach ($opt in @($AllowUnpinned | Where-Object { $_ })) {
        $named = @($Manifest['deps'] | Where-Object { $_['kind'] -eq 'plugin' -and $_['plugin'] -eq $opt['plugin'] -and $_['pin'].Contains('unpinned') })
        if ($named.Count -eq 0) {
            throw "allowUnpinnedPlugins names '$($opt['plugin'])', which core/claude/deps.json does not declare as an unpinned third-party plugin. Remove the entry from .claude/.harness-manifest.json, or fix the name."
        }
    }

    $required = @(Get-RequiredDeps -Manifest $Manifest -Layers $Layers -IsWindows $OnWindows)
    $pluginRequired = @($required | Where-Object { $_.Dep['kind'] -eq 'plugin' })
    $required = @($required | Where-Object { $_.Dep['kind'] -ne 'plugin' })
    $problems = [System.Collections.Generic.List[object]]::new()
    foreach ($req in $required) {
        $dep = $req.Dep
        if ($dep.Contains('onlyWhenAbsent')) {
            $other = $dep['onlyWhenAbsent']
            $otherPresent = if ($KnownPresence.Contains($other)) { [bool]$KnownPresence[$other] } else { (& $probe $other).Present }
            if ($otherPresent) { continue }
        }
        $res = & $probe $req.Name
        if ($res.Present) { continue }
        $problems.Add([pscustomobject]@{ Req = $req; Reason = $res.Reason; Text = $null })
    }

    if ($InstallDeps) {
        foreach ($prob in $problems) {
            $dep = $prob.Req.Dep
            $steps = [System.Collections.Generic.List[object]]::new()
            foreach ($need in @(Get-DepNeeds -Dep $dep -IsWindows $OnWindows)) {
                if (-not (& $probe $need).Present) { $steps.Add($byName[$need]) }
            }
            $steps.Add($dep)
            foreach ($step in $steps) {
                $cmd = Get-DepInstallCommand -Dep $step -IsWindows $OnWindows
                if ($null -eq $cmd) {
                    $prob.Text = "$($dep['name']) ($($prob.Reason)). $($dep['failMode']) $(Get-DepGuidance -Dep $step -IsWindows $OnWindows)"
                    break
                }
                $display = Format-DepsArgv $cmd
                if (-not (& $ShouldInstall $display 'install')) {
                    # A dry run is not a failure: nothing ran, so there is nothing to verify. A
                    # declined prompt outside a dry run is the operator saying no, so the
                    # dependency stays missing and is reported as such, a hard one refusing.
                    if ($WhatIfPreference) {
                        Write-Host "WhatIf: would run $display"
                        continue
                    }
                    $prob.Text = "$($dep['name']) ($($prob.Reason)): the install was declined, so '$display' did not run. $($dep['failMode'])"
                    break
                }
                $null = & $Runner $cmd $script:DepsInstallTimeout $null
                # winget installers write PATH to the registry, which this process never sees,
                # so the re-probe would miss the tool it just installed. Merge in the Machine and
                # User scopes, and resolve git again, since Git Bash is found from git.exe.
                if ($OnWindows -and $cmd[0] -eq 'winget') {
                    Update-DepsProcessPath -ReadScopedPath $ReadScopedPath
                    $gitExe = & $ResolveGitExe
                    $cache.Clear()
                }
                $cache.Remove($step['name'])
                if (-not (& $probe $step['name']).Present) {
                    $prob.Text = "$($dep['name']): the install did not verify. '$display' ran, and the re-probe still finds $($step['name']) absent ($((& $probe $step['name']).Reason)). $($dep['failMode'])"
                    break
                }
            }
        }
        $remaining = @($problems | Where-Object { $_.Text })
    }
    else {
        foreach ($prob in $problems) {
            $dep = $prob.Req.Dep
            $parts = [System.Collections.Generic.List[string]]::new()
            foreach ($need in @(Get-DepNeeds -Dep $dep -IsWindows $OnWindows)) {
                $needRes = & $probe $need
                if (-not $needRes.Present) {
                    $parts.Add("it needs $need first ($($needRes.Reason)), so $(Get-DepGuidance -Dep $byName[$need] -IsWindows $OnWindows), then")
                }
            }
            $parts.Add((Get-DepGuidance -Dep $dep -IsWindows $OnWindows))
            $prob.Text = "$($dep['name']) ($($prob.Reason)). $($dep['failMode']) $($parts -join ' ')"
        }
        $remaining = @($problems)
    }

    # Plugins next. A run that is already going to refuse on a tool installs no plugin: it still
    # probes and reports them, so the one refusal lists everything.
    $pluginProblems = [System.Collections.Generic.List[object]]::new()
    $recordsChanged = $false
    if ($PluginScope) {
        $toolRefusal = @($remaining | Where-Object { $_.Req.Severity -eq 'hard' }).Count -gt 0
        $recordsChanged = Invoke-PluginDepsPreflight -Manifest $Manifest -Required $pluginRequired -Scope $PluginScope -Cwd $PluginCwd `
            -Records $PluginRecords -AllowUnpinned $AllowUnpinned -InstallDeps ($InstallDeps -and -not $toolRefusal) `
            -Runner $Runner -ShouldInstall $ShouldInstall -Problems $pluginProblems
    }
    $remaining = @($remaining) + @($pluginProblems)

    foreach ($prob in @($remaining | Where-Object { $_.Req.Severity -eq 'optional' })) {
        Write-Warning "missing optional dependency $($prob.Text)"
    }
    $hard = @($remaining | Where-Object { $_.Req.Severity -eq 'hard' })
    if ($hard.Count -gt 0) {
        $lines = @($hard | ForEach-Object { "  $($_.Text)" })
        $how = if ($InstallDeps) { 'Install each one below by hand and re-run.' } else { 'Install each one below and re-run, or re-run with -InstallDeps to run the pinned commands.' }
        throw "missing hard dependency: nothing was written. $how`n$($lines -join "`n")"
    }
    return [pscustomobject]@{ PluginRecords = $PluginRecords; PluginRecordsChanged = [bool]$recordsChanged }
}

# --- Claude Code plugins ---------------------------------------------------------------------
#
# CLI syntax, read from `claude plugin <command> --help` on Claude Code 2.1.322 (2026-11-11):
#   claude plugin list --json
#       A JSON array, one object per plugin and scope: id ("<name>@<marketplace>"), version,
#       scope (user, project, local, or synced), enabled (bool), installPath, installedAt,
#       lastUpdated, and for project scope projectPath and projectEnabled. It can carry other
#       fields (MCP server configuration, headers), so its output is parsed in memory and never
#       printed, logged or written.
#   claude plugin marketplace list --json
#       A JSON array: name, source (github, git or directory), repo for github, path for a
#       directory, and installLocation, the registered checkout or folder.
#   claude plugin marketplace add <source> [--scope user|project|local]
#       <source> is owner/repo, a git URL, or a path. The default scope is user.
#   claude plugin install <plugin>@<marketplace> --scope user|project|local
#       Installs and enables at that scope. There is no install-without-enabling form, so a
#       third-party pin is verified after the install and rolled back by uninstall on a mismatch.
#       -y would accept a marketplace-declared install command unseen. The installer never
#       passes it.
#   claude plugin update <plugin> --scope <scope>
#       Moves an installed plugin to the marketplace's current version.
#   claude plugin uninstall <plugin> --scope <scope>
#   claude plugin disable <plugin> --scope <scope>
# The installer never reads an installed commit from the CLI. It hashes installPath itself.

# Trusted without a commit pin (operator ruling, #310). Each name is tied to its source repository,
# so a marketplace that merely reuses the name is not first-party.
$script:DepsFirstPartyMarketplaces = @{
    'claude-plugins-official' = 'anthropics/claude-plugins-official'
    'anthropic-agent-skills'  = 'anthropics/skills'
}

function Assert-DepsPluginEntry {
    param($Entry)
    $n = $Entry['name']
    $id = $Entry['plugin']
    if ($id -isnot [string] -or $id -notmatch '^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9._-]*)$') {
        throw "deps manifest: '$n' plugin must be <id>@<marketplace>."
    }
    $mpPart = $Matches[2]
    $mp = $Entry['marketplace']
    if ($mp -isnot [System.Collections.IDictionary] -or $mp['name'] -ne $mpPart) {
        throw "deps manifest: '$n' marketplace.name must match the marketplace in '$id'."
    }
    $src = $mp['source']
    if ($src -isnot [System.Collections.IDictionary] -or $src.Count -ne 1) {
        throw "deps manifest: '$n' marketplace.source must name exactly one of github, git or directory."
    }
    if ($src.Contains('github')) {
        if ($src['github'] -isnot [string] -or $src['github'] -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "deps manifest: '$n' marketplace.source.github must be owner/repo." }
    }
    elseif ($src.Contains('git')) {
        if ($src['git'] -isnot [string] -or $src['git'] -notmatch '^https://\S+$') { throw "deps manifest: '$n' marketplace.source.git must be an https URL." }
    }
    elseif ($src.Contains('directory')) {
        if ($src['directory'] -ne $true) { throw "deps manifest: '$n' marketplace.source.directory must be true. A path is machine-specific." }
    }
    else { throw "deps manifest: '$n' marketplace.source must name exactly one of github, git or directory." }

    $scope = $Entry['scope']
    if (@('user', 'project') -notcontains $scope) { throw "deps manifest: '$n' scope must be user or project." }
    $isKernel = $Entry['severity'].Contains('kernel')
    if ($isKernel -and $scope -ne 'user') { throw "deps manifest: '$n' is a kernel plugin, so its scope must be user." }
    if (-not $isKernel -and $scope -ne 'project') { throw "deps manifest: '$n' is a layer plugin, so its scope must be project." }

    $pin = $Entry['pin']
    if ($pin -isnot [System.Collections.IDictionary]) { throw "deps manifest: '$n' needs a pin." }
    $hex40 = '^[0-9a-f]{40}$'
    $hash = '^sha256:[0-9a-f]{64}$'
    if ($pin.Contains('firstParty')) {
        $expectedRepo = $script:DepsFirstPartyMarketplaces[$mp['name']]
        if ($pin['firstParty'] -ne $true -or -not $expectedRepo -or $src['github'] -ne $expectedRepo) {
            throw "deps manifest: '$n' marks firstParty on marketplace '$($mp['name'])', which is not one of $(@($script:DepsFirstPartyMarketplaces.Keys | Sort-Object) -join ', ') at its own source."
        }
        foreach ($k in @($pin.Keys)) { if (@('firstParty', 'sha') -notcontains $k) { throw "deps manifest: '$n' firstParty pin takes only an optional sha." } }
        if ($pin.Contains('sha') -and $pin['sha'] -cnotmatch $hex40) { throw "deps manifest: '$n' pin.sha must be 40 lowercase hex." }
        return
    }
    if ($pin.Contains('unpinned')) {
        if ($pin['unpinned'] -ne $true -or $pin.Count -ne 1) { throw "deps manifest: '$n' unpinned takes no other pin field." }
        return
    }
    foreach ($k in @('sha', 'commit')) {
        if ($pin.Contains($k)) {
            if ($pin['contentHash'] -isnot [string] -or $pin['contentHash'] -cnotmatch $hash) { throw "deps manifest: '$n' pin.$k needs a contentHash of sha256:<64 hex>." }
            if ($pin[$k] -cnotmatch $hex40) { throw "deps manifest: '$n' pin.$k must be 40 lowercase hex." }
            if ($pin.Count -ne 2) { throw "deps manifest: '$n' pin takes $k and contentHash only." }
            return
        }
    }
    throw "deps manifest: '$n' is a third-party plugin with none of sha, commit or unpinned."
}

# sha256:<hex> over every regular file under -Path, so the same tree hashes the same on any
# machine and checkout. Files are ordered by their /-separated relative path, compared ordinally
# on its UTF-8 bytes. Each file's content is hashed after CRLF becomes LF (git's autocrlf would
# otherwise make one tree hash two ways), unless it holds a NUL byte, which marks it binary and
# hashes it raw. A .git directory is skipped. A symlink is not followed and contributes
# link:<target> in place of content. One SHA-256 over `<path>\n<file hash>\n` for every file.
function Get-PluginContentHash {
    param([string]$Path)
    $root = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "plugin directory not found: $Path" }
    $rels = [System.Collections.Generic.List[string]]::new()
    $values = [System.Collections.Generic.List[string]]::new()
    $stack = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
    $stack.Push([System.IO.DirectoryInfo]::new($root))
    $latin1 = [System.Text.Encoding]::Latin1
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($item in $dir.EnumerateFileSystemInfos()) {
            $rel = [System.IO.Path]::GetRelativePath($root, $item.FullName).Replace('\', '/')
            if ($item.LinkTarget) {
                $rels.Add($rel); $values.Add("link:$($item.LinkTarget)")
                continue
            }
            if ($item -is [System.IO.DirectoryInfo]) {
                if ($item.Name -ne '.git') { $stack.Push($item) }
                continue
            }
            $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
            if ([Array]::IndexOf($bytes, [byte]0) -lt 0) {
                # Latin-1 maps every byte to one char and back, so this is a byte-level replace.
                $bytes = $latin1.GetBytes($latin1.GetString($bytes).Replace("`r`n", "`n"))
            }
            $rels.Add($rel)
            $values.Add([Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant())
        }
    }
    # Fixed-width hex of the UTF-8 bytes sorts ordinally exactly as the bytes do.
    $keys = [string[]]@($rels | ForEach-Object { [Convert]::ToHexString([System.Text.Encoding]::UTF8.GetBytes($_)) })
    $index = [int[]](0..([Math]::Max(0, $rels.Count - 1)))
    if ($rels.Count -eq 0) { $index = [int[]]@() }
    [Array]::Sort($keys, $index, [System.StringComparer]::Ordinal)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($i in $index) { $null = $sb.Append($rels[$i]).Append("`n").Append($values[$i]).Append("`n") }
    $digest = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
    return 'sha256:' + [Convert]::ToHexString($digest).ToLowerInvariant()
}

function Test-DepsSamePath {
    param([string]$A, [string]$B)
    if (-not $A -or -not $B) { return $false }
    $norm = { param($p) [System.IO.Path]::GetFullPath($p).TrimEnd('\', '/').Replace('\', '/') }
    $cmp = if (($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    return [string]::Equals((& $norm $A), (& $norm $B), $cmp)
}

# Runs a CLI listing through the runner and parses it in memory. $null means it did not answer:
# a non-zero exit, a timeout, or output that is not JSON. The output itself is never returned in
# a message, because the plugin list can carry MCP server headers.
# Only a JSON array is an answer. Empty, whitespace and `null` output all parse to $null without
# an error, and reading that as "nothing listed" would let a silent listing pass as proof that a
# plugin is gone.
function Invoke-DepsJsonListing {
    param([scriptblock]$Runner, [string[]]$Argv, [string]$Cwd)
    $r = & $Runner $Argv $script:DepsProbeTimeout $Cwd
    if (-not $r -or $r.TimedOut -or $r.ExitCode -ne 0) { return $null }
    $text = (Get-DepsOutputText $r.Output).Trim()
    if (-not $text.StartsWith('[')) { return $null }
    try { $parsed = ConvertFrom-Json -InputObject $text -AsHashtable -NoEnumerate -ErrorAction Stop }
    catch { return $null }
    return [pscustomobject]@{ Rows = @($parsed | Where-Object { $_ -is [System.Collections.IDictionary] }) }
}

function Get-PluginMarketplaces {
    param([scriptblock]$Runner, [string]$Cwd)
    $list = Invoke-DepsJsonListing -Runner $Runner -Argv @('claude', 'plugin', 'marketplace', 'list', '--json') -Cwd $Cwd
    if ($null -eq $list) { return $null }
    # Name to where it is registered from. Repo is the owner/repo a github marketplace was added
    # from, or the URL of a git one. A name alone proves nothing: anyone can register a local
    # folder as claude-plugins-official, so first-party trust is checked against Repo.
    # Every row is kept: a name listed twice (a user registration beside a project one, say) must
    # not let the second row hide the first from the identity check. Location, Source and Repo are
    # the first row's, and Repos carries every row's.
    $map = @{}
    foreach ($row in $list.Rows) {
        if ($row['name'] -isnot [string]) { continue }
        $loc = $row['installLocation']
        if (-not $loc) { $loc = $row['path'] }
        $repo = $row['repo']
        if (-not $repo) { $repo = $row['url'] }
        if ($map.Contains($row['name'])) {
            $map[$row['name']].Repos.Add([string]$repo)
            continue
        }
        $repos = [System.Collections.Generic.List[string]]::new()
        $repos.Add([string]$repo)
        $map[$row['name']] = [pscustomobject]@{ Location = [string]$loc; Source = [string]$row['source']; Repo = [string]$repo; Repos = $repos }
    }
    return $map
}

# $null when the marketplace this first-party entry names is registered from its own repository,
# else the reason it is not. Compared case-insensitively, since GitHub owner and repo names are.
function Get-PluginMarketplaceIdentityProblem {
    param($Dep, $Marketplaces)
    $name = $Dep['marketplace']['name']
    $expected = $script:DepsFirstPartyMarketplaces[$name]
    if (-not $expected) { return "marketplace $name is not one of the first-party marketplaces" }
    if ($null -eq $Marketplaces) { return "the marketplace list did not answer, so marketplace $name cannot be confirmed as first-party" }
    if (-not $Marketplaces.Contains($name)) { return "marketplace $name is not registered here, so it cannot be confirmed as first-party" }
    # The registered values are captured CLI output and can carry a token in a URL, so they are
    # never printed. The message names the field and what it should have been.
    $repos = @($Marketplaces[$name].Repos)
    if ($repos.Count -gt 1) {
        return "SPOOF: field marketplace.repo of $name cannot be confirmed: expected $expected, and the name is registered $($repos.Count) times (values not shown). First-party trust does not apply, and nothing was installed or recorded. Remove the extra registrations with claude plugin marketplace remove $name, add it back once from $expected, then re-run"
    }
    if ([string]::Equals($repos[0], $expected, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    return "SPOOF: field marketplace.repo of $name does not match: expected $expected, and the registered value differs (not shown). First-party trust does not apply, and nothing was installed or recorded. Remove that registration with claude plugin marketplace remove $name, then re-run"
}

# Whether the listing shows this plugin at its declared scope (and, for project scope, in this
# project), enabled or not. $null when there is no listing to read.
function Test-PluginListed {
    param($List, $Dep, [string]$Cwd)
    if ($null -eq $List) { return $null }
    $rows = @($List.Rows | Where-Object { $_['id'] -eq $Dep['plugin'] -and $_['scope'] -eq $Dep['scope'] })
    if ($Dep['scope'] -eq 'project') { $rows = @($rows | Where-Object { Test-DepsSamePath ([string]$_['projectPath']) $Cwd }) }
    return $rows.Count -gt 0
}

# The sha a registered marketplace's own marketplace.json lists for this plugin, or $null.
function Get-PluginMarketplaceSha {
    param($Dep, [string]$Location)
    if (-not $Location) { return $null }
    $file = Join-Path (Join-Path $Location '.claude-plugin') 'marketplace.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try { $doc = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch { return $null }
    if ($doc -isnot [System.Collections.IDictionary]) { return $null }
    $short = ($Dep['plugin'] -split '@')[0]
    foreach ($p in @($doc['plugins'] | Where-Object { $_ -is [System.Collections.IDictionary] })) {
        if ($p['name'] -ne $short) { continue }
        $src = $p['source']
        if ($src -is [System.Collections.IDictionary] -and $src['sha'] -is [string]) { return $src['sha'] }
        return $null
    }
    return $null
}

function Get-DepsGitHead {
    param([scriptblock]$Runner, [string]$Location, [string]$Cwd)
    if (-not $Location) { return $null }
    $r = & $Runner @('git', '-C', $Location, 'rev-parse', 'HEAD') $script:DepsProbeTimeout $Cwd
    if (-not $r -or $r.TimedOut -or $r.ExitCode -ne 0) { return $null }
    $line = @((Get-DepsOutputText $r.Output) -split '\r?\n' | Where-Object { $_.Trim() })
    if ($line.Count -eq 0) { return $null }
    return $line[0].Trim()
}

# -List is the parsed plugin listing when the caller already holds one, so one preflight lists
# once rather than once per plugin. Omitted, the listing runs here.
function Test-PluginDep {
    param($Dep, [scriptblock]$Runner, [string]$Target, [string]$RecordedHash, $List)
    $res = [pscustomobject]@{
        Name = $Dep['name']; Present = $false; Version = $null; MeetsMin = $false; Reason = ''
        InstallPath = $null; Hash = $null; Changed = $false
    }
    $id = $Dep['plugin']
    $scope = $Dep['scope']
    $list = $List
    if (-not $PSBoundParameters.ContainsKey('List')) {
        $list = Invoke-DepsJsonListing -Runner $Runner -Argv @('claude', 'plugin', 'list', '--json') -Cwd $Target
    }
    if ($null -eq $list) { $res.Reason = 'the plugin list did not answer'; return $res }
    $rows = @($list.Rows | Where-Object { $_['id'] -eq $id -and $_['scope'] -eq $scope })
    if ($scope -eq 'project') { $rows = @($rows | Where-Object { Test-DepsSamePath ([string]$_['projectPath']) $Target }) }
    if ($rows.Count -eq 0) { $res.Reason = "not installed at $scope scope"; return $res }
    $row = $rows[0]
    if ($row['enabled'] -ne $true) { $res.Reason = "installed but not enabled at $scope scope"; return $res }
    $path = [string]$row['installPath']
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Container)) { $res.Reason = 'its installPath is missing'; return $res }
    $res.InstallPath = $path
    $res.Version = [string]$row['version']
    try { $res.Hash = Get-PluginContentHash -Path $path }
    catch { $res.Reason = 'its install directory could not be hashed'; return $res }
    $expected = $RecordedHash
    if ($Dep['pin'].Contains('contentHash')) { $expected = $Dep['pin']['contentHash'] }
    $res.Changed = [bool]$expected -and $res.Hash -ne $expected
    $res.Present = $true
    $res.MeetsMin = $true
    return $res
}

function Get-PluginInstallCommands {
    param($Dep, [bool]$MarketplaceKnown)
    $cmds = [System.Collections.Generic.List[string[]]]::new()
    if (-not $MarketplaceKnown) {
        $src = $Dep['marketplace']['source']
        if ($src.Contains('github')) { $cmds.Add([string[]]@('claude', 'plugin', 'marketplace', 'add', $src['github'])) }
        elseif ($src.Contains('git')) { $cmds.Add([string[]]@('claude', 'plugin', 'marketplace', 'add', $src['git'])) }
        else { return $null }
    }
    $cmds.Add([string[]]@('claude', 'plugin', 'install', $Dep['plugin'], '--scope', $Dep['scope']))
    return , $cmds.ToArray()
}

# A sidecar plugin record vouches for an installed copy only with a non-empty string hash and a
# non-empty string installPath. Anything else (hand-edited, partly written) is not a record.
function Test-PluginRecordWellFormed {
    param($Record)
    if ($Record -isnot [System.Collections.IDictionary]) { return $false }
    foreach ($key in 'hash', 'installPath') {
        $v = if ($Record.Contains($key)) { $Record[$key] } else { $null }
        if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { return $false }
    }
    return $true
}

function New-PluginRecord {
    param($Result, [string]$Sha)
    $rec = [ordered]@{ hash = $Result.Hash; installPath = $Result.InstallPath; version = $Result.Version }
    if ($Sha) { $rec['sha'] = $Sha }
    $rec['recordedAt'] = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture)
    return $rec
}

# The plugin half of the preflight. Adds a problem per plugin that is missing or fails its pin,
# and updates -Records in place. Returns whether any record changed.
function Invoke-PluginDepsPreflight {
    param($Manifest, [object[]]$Required, [string]$Scope, [string]$Cwd, $Records, [object[]]$AllowUnpinned,
        [bool]$InstallDeps, [scriptblock]$Runner, [scriptblock]$ShouldInstall, $Problems)

    $changed = $false
    # One listing of each kind per run, refreshed after anything that changes what is installed.
    $cache = @{}
    $getList = {
        if (-not $cache.Contains('list')) { $cache['list'] = Invoke-DepsJsonListing -Runner $Runner -Argv @('claude', 'plugin', 'list', '--json') -Cwd $Cwd }
        $cache['list']
    }
    $getMarketplaces = {
        if (-not $cache.Contains('mps')) { $cache['mps'] = Get-PluginMarketplaces -Runner $Runner -Cwd $Cwd }
        $cache['mps']
    }
    $runChange = {
        param([string[]]$Cmd)
        $result = & $Runner $Cmd $script:DepsInstallTimeout $Cwd
        $cache.Clear()
        $result
    }
    $probe = {
        param($Recorded)
        Test-PluginDep -Dep $dep -Runner $Runner -Target $Cwd -RecordedHash $Recorded -List (& $getList)
    }

    foreach ($e in @($Manifest['deps'] | Where-Object { $null -ne $_ -and $_['kind'] -eq 'plugin' -and $_['scope'] -ne $Scope })) {
        if ($Scope -eq 'project') { Write-Host "Skipping user-scope plugin $($e['plugin']): Install-Account owns user scope." }
        else { Write-Host "Skipping project-scope plugin $($e['plugin']): project-scope plugin $($e['plugin']) is installed per project by Install-Harness." }
    }

    foreach ($req in @($Required | Where-Object { $_.Dep['kind'] -eq 'plugin' -and $_.Dep['scope'] -eq $Scope })) {
        $dep = $req.Dep
        $id = $dep['plugin']
        $pin = $dep['pin']
        $firstParty = $pin.Contains('firstParty')
        $tracksSha = $firstParty -and $pin.Contains('sha')
        $thirdPinned = $pin.Contains('commit') -or ($pin.Contains('sha') -and -not $firstParty)
        $mpName = $dep['marketplace']['name']
        $fail = {
            param([string]$Reason)
            $Problems.Add([pscustomobject]@{ Req = $req; Reason = $Reason; Text = "plugin ${id}: $Reason. $($dep['failMode'])" })
        }
        # A spoofed first-party marketplace refuses whatever the plugin's own severity: the
        # machine is registering someone else's code under Anthropic's name.
        $failHard = {
            param([string]$Reason)
            $hardReq = [pscustomobject]@{ Name = $req.Name; Severity = 'hard'; Dep = $dep }
            $Problems.Add([pscustomobject]@{ Req = $hardReq; Reason = $Reason; Text = "plugin ${id}: $Reason." })
        }
        $checkIdentity = {
            param($Marketplaces)
            $why = Get-PluginMarketplaceIdentityProblem -Dep $dep -Marketplaces $Marketplaces
            if (-not $why) { return $true }
            if ($why.StartsWith('SPOOF: ')) { & $failHard $why.Substring(7) } else { & $fail $why }
            return $false
        }

        if ($pin.Contains('unpinned')) {
            $opt = @($AllowUnpinned | Where-Object { $_ -is [System.Collections.IDictionary] -and $_['plugin'] -eq $id })
            if ($opt.Count -eq 0) {
                & $fail 'it is an unpinned third-party plugin, and the project manifest has no allowUnpinnedPlugins entry for it'
                continue
            }
            Write-Warning "plugin $id is unpinned third-party code, allowed by this project's manifest. Recorded risk: $($opt[0]['risk'])"
        }

        # A record that cannot vouch for the installed copy counts as no record, so the first-seen
        # path below re-records it. Reading it as "unchanged" would switch drift detection off.
        $rec = $null
        $recBroken = $false
        if ($Records.Contains($id)) {
            if (Test-PluginRecordWellFormed $Records[$id]) { $rec = $Records[$id] } else { $recBroken = $true }
        }
        $recHash = if ($rec) { [string]$rec['hash'] } else { $null }
        $r = & $probe $recHash

        if ($r.Present) {
            if ($thirdPinned) {
                if ($r.Changed) { & $fail 'the installed copy does not match its pinned contentHash'; continue }
                if ($pin.Contains('commit')) {
                    $mps = & $getMarketplaces
                    $head = if ($mps -and $mps.Contains($mpName)) { Get-DepsGitHead -Runner $Runner -Location $mps[$mpName].Location -Cwd $Cwd } else { $null }
                    if ($head -ne $pin['commit']) { & $fail "its registered marketplace is not at the pinned commit $($pin['commit'])"; continue }
                }
                continue
            }

            if ($firstParty -and -not (& $checkIdentity (& $getMarketplaces))) { continue }
            $currentSha = $null
            if ($tracksSha) {
                $mps = & $getMarketplaces
                if ($mps) { $currentSha = Get-PluginMarketplaceSha -Dep $dep -Location $mps[$mpName].Location }
                $expectedSha = if ($rec -and $rec['sha']) { [string]$rec['sha'] } else { $pin['sha'] }
                if (-not $currentSha) {
                    Write-Warning "plugin ${id}: its marketplace entry's sha could not be read, so a version move cannot be checked."
                }
                elseif ($currentSha -ne $expectedSha) {
                    Write-Warning "plugin ${id}: its marketplace sha moved from $expectedSha to $currentSha. Read that diff, then re-run with -InstallDeps to install the marketplace's version and re-record it."
                    if ($InstallDeps) {
                        $cmd = [string[]]@('claude', 'plugin', 'update', $id, '--scope', $dep['scope'])
                        $display = Format-DepsArgv $cmd
                        if (& $ShouldInstall $display 'install') {
                            # A failed update leaves the old copy in place, so recording the new
                            # sha would silence the move warning for a version never installed.
                            $ran = & $runChange $cmd
                            if (-not $ran -or $ran.TimedOut -or $ran.ExitCode -ne 0) {
                                & $fail 'claude plugin update did not succeed, so its record was left unchanged'
                                continue
                            }
                            $r2 = & $probe $null
                            if ($r2.Present) { $Records[$id] = New-PluginRecord -Result $r2 -Sha $currentSha; $changed = $true }
                            else { & $fail "the update did not verify ($($r2.Reason))" }
                        }
                        elseif ($WhatIfPreference) { Write-Host "WhatIf: would run $display" }
                        else { & $fail 'the update was declined, so its record was left unchanged' }
                    }
                    continue
                }
            }
            if (-not $rec) {
                if ($recBroken) { Write-Warning "plugin ${id}: its recorded entry has no usable hash or installPath, so it could not vouch for the installed copy. Recording the current copy; review it if you did not expect this." }
                $Records[$id] = New-PluginRecord -Result $r -Sha $currentSha
                $changed = $true
                continue
            }
            if ($r.Changed) {
                Write-Warning "plugin $id changed since recorded: $($r.InstallPath) now hashes to $($r.Hash), recorded $recHash. Review the change, then re-run with -InstallDeps to re-record it."
                if ($InstallDeps) { $Records[$id] = New-PluginRecord -Result $r -Sha $currentSha; $changed = $true }
            }
            continue
        }

        # Read even without -InstallDeps, so the printed guidance leaves out a marketplace add the
        # machine does not need. Only an install has to stop when the listing does not answer.
        $mps = & $getMarketplaces
        if ($InstallDeps -and $null -eq $mps) { & $fail "$($r.Reason), and the marketplace list did not answer"; continue }
        $known = [bool]($mps -and $mps.Contains($mpName))
        if ($firstParty -and $known) {
            $why = Get-PluginMarketplaceIdentityProblem -Dep $dep -Marketplaces $mps
            if ($why -and $why.StartsWith('SPOOF: ')) { & $failHard $why.Substring(7); continue }
        }
        $cmds = Get-PluginInstallCommands -Dep $dep -MarketplaceKnown $known
        if ($null -eq $cmds) {
            & $fail "$($r.Reason), and its directory marketplace $mpName is not registered here. Add it by hand with claude plugin marketplace add <path>, then re-run"
            continue
        }
        if (-not $InstallDeps) {
            $how = @($cmds | ForEach-Object { Format-DepsArgv $_ }) -join ', then '
            & $fail "$($r.Reason). Install with: $how"
            continue
        }

        $stopped = $false
        foreach ($cmd in $cmds) {
            if ($cmd[2] -eq 'install' -and $thirdPinned) {
                $mpsNow = & $getMarketplaces
                $loc = if ($mpsNow -and $mpsNow.Contains($mpName)) { $mpsNow[$mpName].Location } else { $null }
                if ($pin.Contains('sha')) {
                    $listed = Get-PluginMarketplaceSha -Dep $dep -Location $loc
                    if ($listed -ne $pin['sha']) { & $fail "its marketplace lists sha $listed, not the pinned $($pin['sha']), so nothing was installed"; $stopped = $true; break }
                }
                else {
                    $head = Get-DepsGitHead -Runner $Runner -Location $loc -Cwd $Cwd
                    if ($head -ne $pin['commit']) { & $fail "its marketplace is at $head, not the pinned commit $($pin['commit']), so nothing was installed"; $stopped = $true; break }
                }
            }
            $display = Format-DepsArgv $cmd
            if (-not (& $ShouldInstall $display 'install')) {
                if ($WhatIfPreference) { Write-Host "WhatIf: would run $display" }
                else { & $fail "$($r.Reason), and '$display' was declined" }
                $stopped = $true
                break
            }
            $ran = & $runChange $cmd
            # A first-party marketplace that was not registered is added above from its own
            # pinned source, so the identity check before the loop covers every case but one: an
            # add that did not succeed, which leaves the name free for anything. Stop there.
            if ($cmd[3] -eq 'add' -and (-not $ran -or $ran.TimedOut -or $ran.ExitCode -ne 0)) {
                & $fail "claude plugin marketplace add did not succeed, so nothing was installed"
                $stopped = $true
                break
            }
        }
        if ($stopped) { continue }

        $r2 = & $probe $null
        # A third-party install that cannot be verified is rolled back like one that fails
        # verification: a listing that does not answer, a disabled row or an unhashable folder
        # leaves unverified code installed otherwise.
        if (-not $r2.Present -and -not $thirdPinned) { & $fail "the install did not verify ($($r2.Reason))"; continue }
        if ($thirdPinned) {
            $bad = (-not $r2.Present) -or $r2.Changed
            if (-not $bad -and $pin.Contains('commit')) {
                $mpsNow = & $getMarketplaces
                $bad = -not ($mpsNow -and $mpsNow.Contains($mpName)) -or (Get-DepsGitHead -Runner $Runner -Location $mpsNow[$mpName].Location -Cwd $Cwd) -ne $pin['commit']
            }
            if ($bad) {
                # The rollback has to be proven, not assumed: an uninstall that fails, times out
                # or is declined leaves unverified code installed, and a warning saying it was
                # removed would be the opposite of the truth. Any doubt is a hard stop.
                $un = [string[]]@('claude', 'plugin', 'uninstall', $id, '--scope', $dep['scope'])
                $display = Format-DepsArgv $un
                $why = $null
                $listed = $true
                if (& $ShouldInstall $display 'uninstall') {
                    $ur = & $Runner $un $script:DepsInstallTimeout $Cwd
                    $cache.Clear()
                    if (-not $ur) { $why = 'the uninstall returned nothing' }
                    elseif ($ur.TimedOut) { $why = 'the uninstall timed out' }
                    elseif ($ur.ExitCode -ne 0) { $why = "the uninstall exited $($ur.ExitCode)" }
                    $listed = Test-PluginListed -List (& $getList) -Dep $dep -Cwd $Cwd
                    if ($null -eq $listed -and -not $why) { $why = 'the plugin list did not answer after the uninstall' }
                    elseif ($listed -and -not $why) { $why = 'the plugin list still shows it after the uninstall' }
                }
                else { $why = 'the uninstall was declined' }
                if ($why) {
                    # The list showing it gone after a failed uninstall is not proof enough to say
                    # it was removed, so that case says it may still be installed.
                    $state = if ($listed -eq $false) { 'MAY STILL BE INSTALLED' } else { 'IS STILL INSTALLED' }
                    throw "plugin $id did not verify against its pin and $state at $($dep['scope']) scope, as unverified third-party code: $why. Remove it now, from $Cwd, with: $display"
                }
                if ($r2.Present) { & $fail 'the installed copy did not verify against its pin, so it was uninstalled again' }
                else { & $fail "the installed copy could not be verified ($($r2.Reason)), so it was uninstalled again" }
            }
            continue
        }
        $sha = $null
        if ($tracksSha) {
            $mpsNow = & $getMarketplaces
            if ($mpsNow -and $mpsNow.Contains($mpName)) { $sha = Get-PluginMarketplaceSha -Dep $dep -Location $mpsNow[$mpName].Location }
        }
        $Records[$id] = New-PluginRecord -Result $r2 -Sha $sha
        $changed = $true
    }
    return $changed
}
