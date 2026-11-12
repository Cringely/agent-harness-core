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
#     winget, apt and npm, each pinned to an exact version. No download-and-execute form exists.

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
    foreach ($e in $entries) {
        if ($e -isnot [System.Collections.IDictionary]) { throw "deps manifest: every entry must be an object." }
        $n = $e['name']
        if ($n -isnot [string] -or $n -notmatch '^[A-Za-z0-9][A-Za-z0-9._@-]*$') { throw "deps manifest: entry name '$n' is missing or malformed." }
        if ($names.Contains($n)) { throw "deps manifest: duplicate name '$n'. One entry per tool." }
        $names[$n] = $true
    }

    foreach ($e in $entries) {
        $n = $e['name']
        $kind = 'tool'
        if ($e.Contains('kind')) { $kind = $e['kind'] }
        if ($kind -ne 'tool') { throw "deps manifest: '$n' has unknown kind '$kind'." }

        $sev = $e['severity']
        if ($sev -isnot [System.Collections.IDictionary] -or $sev.Count -eq 0) { throw "deps manifest: '$n' needs a severity map." }
        foreach ($layer in @($sev.Keys)) {
            if ($script:DepsLayerNames -notcontains $layer) { throw "deps manifest: '$n' names unknown layer '$layer'." }
            if (@('hard', 'optional') -notcontains $sev[$layer]) { throw "deps manifest: '$n' has unknown severity '$($sev[$layer])' for $layer." }
        }
        if ($e['failMode'] -isnot [string] -or -not $e['failMode'].Trim()) { throw "deps manifest: '$n' needs a failMode sentence." }

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
                $sources = @($spec.Keys | Where-Object { $_ -ne 'version' })
                if ($sources.Count -ne 1 -or $allowed -notcontains $sources[0]) {
                    throw "deps manifest: '$n' install.$plat must name exactly one of $($allowed -join ', ') and a version."
                }
                $src = $sources[0]
                if ($spec[$src] -isnot [string] -or $spec[$src] -cnotmatch $script:DepsNameGrammar[$src]) {
                    throw "deps manifest: '$n' install.$plat $src package '$($spec[$src])' is malformed."
                }
                if (-not (Test-DepsVersionString -Source $src -Version $spec['version'])) {
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
        return , ([string[]]@('sudo', 'apt-get', 'install', '-y', "$($spec['apt'])=$v"))
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
        [scriptblock]$ShouldInstall
    )

    $gitExe = (Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
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

    $required = @(Get-RequiredDeps -Manifest $Manifest -Layers $Layers -IsWindows $OnWindows)
    $problems = [System.Collections.Generic.List[object]]::new()
    foreach ($req in $required) {
        $dep = $req.Dep
        if ($dep.Contains('onlyWhenAbsent') -and (& $probe $dep['onlyWhenAbsent']).Present) { continue }
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
                    # A dry run is not a failure: nothing ran, so there is nothing to verify.
                    Write-Host "WhatIf: would run $display"
                    continue
                }
                $null = & $Runner $cmd $script:DepsInstallTimeout $null
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

    foreach ($prob in @($remaining | Where-Object { $_.Req.Severity -eq 'optional' })) {
        Write-Warning "missing optional dependency $($prob.Text)"
    }
    $hard = @($remaining | Where-Object { $_.Req.Severity -eq 'hard' })
    if ($hard.Count -gt 0) {
        $lines = @($hard | ForEach-Object { "  $($_.Text)" })
        $how = if ($InstallDeps) { 'Install each one below by hand and re-run.' } else { 'Install each one below and re-run, or re-run with -InstallDeps to run the pinned commands.' }
        throw "missing hard dependency: nothing was written. $how`n$($lines -join "`n")"
    }
}
