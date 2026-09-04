# Account Layer Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workstation's `~/.claude/` account layer reproducible on a second Windows or Linux/WSL machine, by fixing the hooks that only work here and adding an exporter and installer that move the layer through this repo.

**Architecture:** This workstation is canonical. `install/Export-Account.ps1` mirrors an allowlisted subset of `~/.claude/` into `account/claude/` in the repo, folding this machine's absolute paths into five placeholder tokens. `install/Install-Account.ps1` runs on a receiver from a clone, copies the payload over `~/.claude/`, expands the tokens, deep-merges `settings.json` instead of replacing it, and adds missing `mcpServers` entries to `~/.claude.json`. Executed hooks are fixed at their source in `~/.claude/` since a hook can derive its own paths at run time; model-read text (rules, skills, the `.sh` heredoc) cannot, so it gets the export-time fold and the install-time expansion.

**Tech Stack:** PowerShell 7 (`pwsh`), Pester 5, git 2.31+ (for `rev-parse --path-format=absolute`). Bun and TypeScript only insofar as the existing `bun test` suite must stay green.

**Spec:** `docs/superpowers/specs/2026-09-03-account-layer-portability-design.md`

## Global Constraints

- `bun test` from the repo root is 395 pass, 0 fail as of `1d2ed54` (measured 2026-09-03). Every task must leave it at 395 pass, 0 fail. This is CONTRIBUTING's commit gate together with the Pester suites.
- Pester suites are invoked as `pwsh -NoProfile -File install/<Name>.Tests.ps1`. Never `Invoke-Pester` as a gate: CONTRIBUTING measured that the bare form prints `Failed: 1` and still exits 0, so anything chaining off it proceeds on a red run.
- Both new scripts declare `[CmdletBinding(PositionalBinding=$false)]`. `Restore-ClaudeProject.ps1:71-95` records why: PowerShell auto-assigns a position to every non-switch parameter that lacks one, so a later-added test seam silently becomes positional and a stray extra argument sets it without a binding error.
- Every collection that gets indexed, counted or serialised is wrapped in `@()`, including pipeline output and not only pipeline input. `Install-Harness.ps1:822-826` records the failure: a single-match `Where-Object` result unwraps to a bare scalar and serialises `"hooks": {...}` instead of `"hooks": [...]`, which Claude Code cannot load.
- Tasks 1, 2, 3 and 13 edit files under `C:\Users\user\.claude\`, which is the operator's live running configuration, not a repo copy. Every such task backs the file up first per `~/.claude/rules/change-management.md`: `Copy-Item -LiteralPath <file> -Destination "<file>.bak.$(Get-Date -AsUTC -Format 'yyyyMMdd-HHmmss')"`. The exporter drops `*.bak.*` from the payload, so these backups never reach the repo.
- Multi-segment `Join-Path` is PowerShell 7 only. Measured on this box: `powershell.exe 5.1.26100.9278` rejects `Join-Path "C:\a" "b" "c"` with "A positional parameter cannot be found that accepts argument 'c'." The spec prescribes "multi-segment `Join-Path`" for bugs 3 and 4, and `Lint-DocumentProse.ps1:1` declares `#Requires -Version 5.1`; the spec's own Still-unresolved list says the host for `"shell": "powershell"` may be 5.1. Every path build in this plan therefore uses **nested two-argument** `Join-Path`, which is correct on 5.1 and on 7, on both platforms.
- The five placeholder tokens are exactly `{{CLAUDE_HOME}}`, `{{NPM_GLOBAL}}`, `{{CORE_REPO}}`, `{{OBSIDIAN_VAULT}}`, `{{HOME_SLUG}}`. All expand in forward-slash form on every platform. PowerShell on Windows accepts `& 'C:/...'`; Linux accepts nothing else.
- No em dashes in any file this plan creates or edits. Avoid leverage, robust, comprehensive, seamless, crucial, streamline, facilitate.
- Any regex matched against a repo file's text uses `\r?$` and `\r?\n`, never a bare `$` or `\n`. With `core.autocrlf=true` and no `.gitattributes` rule, the index holds LF and the working tree holds CRLF.

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `install/AccountShared.ps1` | Dot-sourced by both new scripts. AST-lifts `Get-ProjectSlug`, `Test-ResidualWindowsPath` and `Convert-HookCommand` out of `Restore-ClaudeProject.ps1` so there is one definition of each, and defines the shared payload tables (`$AccountTreeDirs`, `$AccountRootFiles`, `$AccountSkipFiles`, `$AccountTemplatedFiles`). |
| `install/Export-Account.ps1` | Runs on this workstation. Mirrors the allowlist into `account/claude/`, writes `settings.account.json` and `mcp-servers.json`, folds literals into tokens. |
| `install/Export-Account.Tests.ps1` | Pester suite for the exporter. |
| `install/Install-Account.ps1` | Runs on any workstation from a clone. Copies the payload into `~/.claude/`, expands tokens, merges settings and `mcpServers`, reports residuals. |
| `install/Install-Account.Tests.ps1` | Pester suite for the installer, plus the round-trip and clean-machine cases. |
| `install/Account-Hooks.Tests.ps1` | Pester suite for the four fixed hooks. Runs the same assertions against both the live `~/.claude/hooks/` and the exported `account/claude/hooks/` when each is present. |
| `account/claude/**` | The payload. Generated in Task 14 by running the finished exporter; never hand-edited. |

**Modify:**

| Path | Change |
|---|---|
| `C:\Users\user\.claude\hooks\Scan-MemorySecrets.ps1` | Bug 1. Derive both roots from `$HOME` with the incoming path's normalisation. |
| `C:\Users\user\.claude\hooks\Sync-MemoryToObsidian.ps1` | Bug 2, six sites. Derive `$claudeHome`, the slug and the vault. |
| `C:\Users\user\.claude\hooks\Lint-DocumentProse.ps1` | Bug 3. `Get-ValeConfigPath` built from nested `Join-Path`. |
| `C:\Users\user\.claude\hooks\Guard-SkillSize.ps1` | Bug 4. `Get-SkillRoot` built from `$HOME`, `$env:LOCALAPPDATA` guarded. |
| `README.md` | Registration for both scripts (CONTRIBUTING Gate 1). |
| `C:\Users\user\.claude\rules\harness-core.md` | Registration for both scripts, and the file whose `{{CORE_REPO}}` fold Task 6 tests. |

**Not created, deliberately:** `account/claude/hooks/model-tier-gate.ts`. Core is authoritative for that file at `core/claude/hooks/model-tier-gate.ts`. The exporter skips it and the installer copies it from core in the same clone it is running out of. Two copies in one repo would drift the moment either was edited.

**No source-fix task exists for spec bugs 5 through 8.** Those four sites (`hooks/harness-core-reminder.sh:18`, `rules/harness-core.md:3,10`, `skills/prose-lint/SKILL.md:14`, and the `skills/handoff`, `skills/council`, `skills/subagent-prompting` sites) are model-read text. A placeholder written into the live file is read literally by the model on this box, so the spec routes them through the export-time fold instead. They are implemented and tested in Task 6.

---

### Task 1: Account hook test harness, and Scan-MemorySecrets root derivation

Spec bug 1, the headline. `Scan-MemorySecrets.ps1` is the `PreToolUse` secret scanner. Its two roots are absolute literals naming this workstation, so on any receiver neither branch matches and line 33 exits 0 for every write: the control works here and scans nothing everywhere else. This task also builds the harness the next two tasks reuse.

**Files:**
- Create: `install/Account-Hooks.Tests.ps1`
- Modify: `C:\Users\user\.claude\hooks\Scan-MemorySecrets.ps1` (header comment at lines 14-16; the root block at lines 28-30)

**Interfaces:**
- Consumes: nothing.
- Produces, all defined in the `BeforeAll` of `install/Account-Hooks.Tests.ps1` and used by Tasks 2, 3 and 14:
  - `$script:hookRoots` -> `[string[]]`, the hook directories that exist and must pass.
  - `New-HookSandbox` -> `[string]`, the path of a fresh throwaway HOME under the temp directory, with the `.claude` skeleton the hooks expect already created. Every test that runs a hook starts here; nothing in it points at the operator's real home.
  - `Invoke-HookWithHome -HookPath [string] -SandboxHome [string] -StdinJson [string] [-Env [hashtable]]` -> `[pscustomobject]` with `ExitCode [int]` and `Output [string]`.
  - `Import-HookFunction -ScriptPath [string] -Name [string]` -> `[string]`, the function's source text.
  - `Invoke-UnderPosixJoin -Expression [string] -HomeValue [string] [-ClearEnv [string[]]]` -> the expression's value, evaluated with `$HOME` forced and `Join-Path` shadowed by a POSIX-only implementation.

- [ ] **Step 1: Back up the hook before touching it**

This is the operator's live config, not a repo file.

```powershell
$f = 'C:\Users\user\.claude\hooks\Scan-MemorySecrets.ps1'
Copy-Item -LiteralPath $f -Destination "$f.bak.$(Get-Date -AsUTC -Format 'yyyyMMdd-HHmmss')"
```

- [ ] **Step 2: Write the test harness and the three failing Scan cases**

Create `install/Account-Hooks.Tests.ps1` with exactly this content.

```powershell
# install/Account-Hooks.Tests.ps1
Describe "Account hooks" {
    BeforeAll {
        # Two possible sources for the same four hooks: the canonical live copy under the
        # operator's ~/.claude, and the exported payload in this repo once Task 14 has run.
        # Both are checked when present, so an export that drops a fix fails here rather than
        # on a receiver.
        $script:hookRoots = @(
            @(
                (Join-Path (Join-Path $HOME '.claude') 'hooks')
                (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'account') 'claude/hooks')
            ) | Where-Object { Test-Path -LiteralPath $_ }
        )

        # Runs a hook in a child pwsh with $HOME pointed at a sandbox. $HOME is read-only
        # in-process, and Set-Variable -Force reaches only the current scope and never a child
        # script, so the redirect has to happen through the environment. On Windows $HOME is
        # derived from USERPROFILE and not from $env:HOME: measured, with USERPROFILE,
        # HOMEDRIVE and HOMEPATH removed and only $env:HOME set, $HOME comes back empty. Both
        # are set here so the same helper works on either platform.
        function Invoke-HookWithHome {
            param(
                [string]$HookPath,
                [string]$SandboxHome,
                [string]$StdinJson,
                [hashtable]$Env = @{}
            )
            $names = @(@('USERPROFILE', 'HOME') + @($Env.Keys))
            $saved = @{}
            foreach ($k in $names) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
            try {
                $env:USERPROFILE = $SandboxHome
                $env:HOME = $SandboxHome
                foreach ($k in @($Env.Keys)) { Set-Item -Path "Env:$k" -Value $Env[$k] }
                $out = @($StdinJson | pwsh -NoProfile -File $HookPath 2>&1)
                return [pscustomobject]@{
                    ExitCode = $LASTEXITCODE
                    Output   = ($out -join "`n")
                }
            }
            finally {
                foreach ($k in $names) {
                    if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
                    else { Set-Item -Path "Env:$k" -Value $saved[$k] }
                }
            }
        }

        # Lifts one function's source text out of a hook without running the hook.
        function Import-HookFunction {
            param([string]$ScriptPath, [string]$Name)
            $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                $ScriptPath, [ref]$null, [ref]$null)
            $fn = @($ast.FindAll({ param($n)
                        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
                    Where-Object { $_.Name -eq $Name })
            if ($fn.Count -eq 0) { throw "$ScriptPath no longer defines $Name" }
            return $fn[0].Extent.Text
        }

        # Evaluates a path-building expression with $HOME forced to a POSIX value and Join-Path
        # shadowed by a POSIX-only implementation. Without the stub a Windows host cannot tell a
        # correct nested Join-Path from one whose child path carries embedded backslashes:
        # Windows accepts both spellings, so the Linux-only failure is invisible here. Under the
        # stub only the segment-per-argument form comes back separator-clean.
        function Invoke-UnderPosixJoin {
            param([string]$Expression, [string]$HomeValue, [string[]]$ClearEnv = @())
            function Join-Path {
                param([Parameter(ValueFromRemainingArguments)]$Parts)
                (@($Parts) -join '/')
            }
            Set-Variable -Name HOME -Value $HomeValue -Scope Local -Force
            $saved = @{}
            foreach ($k in $ClearEnv) {
                $saved[$k] = [Environment]::GetEnvironmentVariable($k)
                Remove-Item "Env:$k" -ErrorAction SilentlyContinue
            }
            try { return (& ([scriptblock]::Create($Expression))) }
            finally {
                foreach ($k in $ClearEnv) {
                    if ($null -ne $saved[$k]) { Set-Item "Env:$k" -Value $saved[$k] }
                }
            }
        }

        function New-HookSandbox {
            $s = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-hooks-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $s -Force | Out-Null
            return $s
        }
    }

    # Every assertion below iterates $script:hookRoots. An empty list would make all of them
    # pass without evaluating anything, which is the failure patterns/test-falsifiability.md
    # names. Assert the list is populated before relying on it.
    It "resolves at least one hooks directory to run against" {
        $script:hookRoots.Count | Should -BeGreaterThan 0
    }

    It "blocks a secret written under a memory root derived from HOME" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'P') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                # Forward slashes: this is the shape Claude Code actually sends, and it is what
                # the hook's own '/'->'\' normalisation at line 28 exists to handle.
                $target = (Join-Path $dir 'note.md') -replace '\\', '/'
                $json = @{ tool_input = @{ file_path = $target; content = 'AKIAIOSFODNN7EXAMPLE' } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Scan-MemorySecrets.ps1') `
                    -SandboxHome $sandbox -StdinJson $json
                $r.ExitCode | Should -Be 2 -Because "$root must scan a memory root under any HOME"
                $r.Output | Should -Match 'BLOCKED'
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "blocks a secret written under a council-transcripts root derived from HOME" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $dir = Join-Path (Join-Path (Join-Path $sandbox '.claude') 'council-transcripts') 'P'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $target = (Join-Path $dir 'round-1.md') -replace '\\', '/'
                $json = @{ tool_input = @{ file_path = $target; content = 'AKIAIOSFODNN7EXAMPLE' } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Scan-MemorySecrets.ps1') `
                    -SandboxHome $sandbox -StdinJson $json
                $r.ExitCode | Should -Be 2 -Because "$root must scan a council root under any HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "still allows a clean memory write and a write outside both roots" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $hook = Join-Path $root 'Scan-MemorySecrets.ps1'
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'P') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null

                $clean = @{ tool_input = @{
                        file_path = ((Join-Path $dir 'note.md') -replace '\\', '/')
                        content   = 'A plain note with no credentials in it.'
                    } } | ConvertTo-Json -Depth 5 -Compress
                (Invoke-HookWithHome -HookPath $hook -SandboxHome $sandbox -StdinJson $clean).ExitCode |
                    Should -Be 0

                # Outside both roots the hook must stay out of the way, secret or not. This is
                # the scoping half of the fix: a root derived too broadly would block ordinary
                # source files carrying test fixtures.
                $outside = @{ tool_input = @{
                        file_path = ((Join-Path $sandbox 'src/app.ts') -replace '\\', '/')
                        content   = 'AKIAIOSFODNN7EXAMPLE'
                    } } | ConvertTo-Json -Depth 5 -Compress
                (Invoke-HookWithHome -HookPath $hook -SandboxHome $sandbox -StdinJson $outside).ExitCode |
                    Should -Be 0
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }
}
```

- [ ] **Step 3: Run the suite and confirm the two blocking cases fail**

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`

Expected: exit 1. `resolves at least one hooks directory` passes, `still allows a clean memory write` passes, and both blocking cases fail with `Expected 2, but got 0`. Measured against the current hook with a sandbox home: exit code 0 and empty output, because `$np.StartsWith('C:\Users\user\.claude\projects\')` is false for every sandbox path.

- [ ] **Step 4: Fix the roots in Scan-MemorySecrets.ps1**

In `C:\Users\user\.claude\hooks\Scan-MemorySecrets.ps1`, replace the two literal root assignments. Locate them by the two lines immediately following `$np = $path -replace '/', '\'` (lines 28-30 as of this writing):

```powershell
$np = $path -replace '/', '\'
$memRoot = 'C:\Users\user\.claude\projects\'
$councilRoot = 'C:\Users\user\.claude\council-transcripts\'
```

with:

```powershell
$np = $path -replace '/', '\'
# Roots are derived from $HOME, then pushed through the same '/'->'\' normalisation $np got
# above and given the trailing separator back. A bare Join-Path result is forward-slashed on
# Linux, never matches $np, and would leave this hook exiting 0 for every write there, which
# is the failure the derivation exists to remove. Nested two-argument Join-Path, not the
# multi-segment form: this hook may run under Windows PowerShell 5.1, where a third positional
# argument is a binding error.
$claudeHome = (Join-Path $HOME '.claude') -replace '/', '\'
$memRoot = (Join-Path $claudeHome 'projects') + '\'
$councilRoot = (Join-Path $claudeHome 'council-transcripts') + '\'
```

- [ ] **Step 5: Correct the header comment that now describes the old behaviour**

Replace lines 14-16, currently:

```
# Second blind spot, same direction: the roots below are absolute and hardcoded.
# A memory directory anywhere else is not scanned, and exits 0 at the root check
# rather than reporting that it declined to look.
```

with:

```
# Second blind spot, same direction: the roots below are derived from $HOME. A
# memory directory outside the user's own ~/.claude is not scanned, and exits 0 at
# the root check rather than reporting that it declined to look.
```

- [ ] **Step 6: Run the suite and confirm it is green**

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`
Expected: exit 0, `Tests Passed: 4, Failed: 0`.

- [ ] **Step 7: Ablate the fix to prove the test is what holds it up**

Temporarily restore the literal `$memRoot = 'C:\Users\user\.claude\projects\'`, re-run the suite, and confirm `blocks a secret written under a memory root derived from HOME` goes red again. Then put the fix back and re-run to green. Per `patterns/ablation-verification.md`, a passing test proves nothing until its failure has been observed against the patched build.

This ablation edits the operator's live hook, so it leaves that hook broken for as long as it runs. If anything goes wrong at any point, restore the file from the `.bak.<timestamp>` copy taken in Step 1 and re-run the suite before doing anything else.

- [ ] **Step 8: Run the repo suites**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

- [ ] **Step 9: Commit**

```bash
git add install/Account-Hooks.Tests.ps1
git commit -m "fix(account): derive secret-scanner roots from HOME

The PreToolUse secret scanner's memory and council roots were absolute
literals naming this workstation, so on any other machine neither branch
matched and the hook exited 0 for every write: the control worked here and
scanned nothing everywhere else. change-management.md already names the
family, a scope filter that resolves empty must fail closed.

Derived roots go through the same '/'->'\\' normalisation the incoming path
gets before the StartsWith comparison. Rejected the bare Join-Path form the
spec first proposed: it is forward-slashed on Linux, never matches the
normalised path, and would have shipped a fix that is a no-op on the one
platform it was written for.

The hook itself lives in ~/.claude and is not in this repo yet; the test
suite runs against whichever of the live and exported copies are present.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 2: Sync-MemoryToObsidian derives its home, slug and vault

Spec bug 2, six sites in one file. Line 14 hardcodes the vault, line 17 the council root, line 56 the memory root, line 47 a regex anchored on `^C:\\Users\\user\\\.claude\\`, and lines 39 and 49 the slug literal `C--Users-user`. An environment variable for the vault alone reaches one of the six and leaves the hook a no-op on every receiver. One file, one test cycle.

**Files:**
- Modify: `C:\Users\user\.claude\hooks\Sync-MemoryToObsidian.ps1` (lines 13-17, 39, 47, 49, 56)
- Test: `install/Account-Hooks.Tests.ps1` (add four `It` blocks inside the existing `Describe "Account hooks"`)

**Interfaces:**
- Consumes: `$script:hookRoots`, `Invoke-HookWithHome`, `New-HookSandbox` from Task 1.
- Produces: nothing a later task calls. The environment variable `CLAUDE_OBSIDIAN_VAULT` becomes the hook's vault override, and Task 6 folds the same fallback path into `{{OBSIDIAN_VAULT}}`.

- [ ] **Step 1: Back up the hook**

```powershell
$f = 'C:\Users\user\.claude\hooks\Sync-MemoryToObsidian.ps1'
Copy-Item -LiteralPath $f -Destination "$f.bak.$(Get-Date -AsUTC -Format 'yyyyMMdd-HHmmss')"
```

- [ ] **Step 2: Write the four failing cases**

Append these inside the closing brace of `Describe "Account hooks"` in `install/Account-Hooks.Tests.ps1`.

```powershell
    It "copies a memory write into a vault named by CLAUDE_OBSIDIAN_VAULT" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'E--projects-demo') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'MEMORY.md'
                'note' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault }
                $r.ExitCode | Should -Be 0
                $landed = Join-Path (Join-Path (Join-Path $vault 'E--projects-demo') 'Memory') 'MEMORY.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must find a memory root under any HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "routes a global spec write to the slug of the running HOME, not to C--Users-user" {
        # The sharpest of the four: it fails unless lines 47 and 49 both moved off the
        # workstation literals. A fix that changed only the vault would put the file under
        # <vault>/C--Users-user/Specs on a receiver, a foreign username's tree.
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path $sandbox '.claude') 'specs'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'design.md'
                'spec' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault }
                $r.ExitCode | Should -Be 0
                $slug = $sandbox.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
                $landed = Join-Path (Join-Path (Join-Path $vault $slug) 'Specs') 'design.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must slug the running HOME"
                Test-Path -LiteralPath (Join-Path $vault 'C--Users-user') |
                    Should -BeFalse -Because "no receiver may mint this workstation's slug"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "copies a council transcript into the vault under the project's Council folder" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $vault = Join-Path $sandbox 'vault'
                $dir = Join-Path (Join-Path (Join-Path $sandbox '.claude') 'council-transcripts') 'E--projects-demo'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'round-1.md'
                'transcript' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = $vault }
                $r.ExitCode | Should -Be 0
                $landed = Join-Path (Join-Path (Join-Path $vault 'E--projects-demo') 'Council') 'round-1.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root must find a council root under any HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }

    It "falls back to Documents/Obsidian Vault/Claude Code under HOME when the env var is unset" {
        foreach ($root in $script:hookRoots) {
            $sandbox = New-HookSandbox
            try {
                $dir = Join-Path (Join-Path (Join-Path (Join-Path $sandbox '.claude') 'projects') 'P') 'memory'
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                $src = Join-Path $dir 'MEMORY.md'
                'note' | Set-Content -LiteralPath $src
                $json = @{ tool_input = @{ file_path = ($src -replace '\\', '/') } } |
                    ConvertTo-Json -Depth 5 -Compress
                # Empty string, not absent: Invoke-HookWithHome restores whatever the runner
                # had, and the operator's own session may well have this variable set.
                $r = Invoke-HookWithHome `
                    -HookPath (Join-Path $root 'Sync-MemoryToObsidian.ps1') `
                    -SandboxHome $sandbox -StdinJson $json `
                    -Env @{ CLAUDE_OBSIDIAN_VAULT = '' }
                $r.ExitCode | Should -Be 0
                $docs = Join-Path (Join-Path (Join-Path $sandbox 'Documents') 'Obsidian Vault') 'Claude Code'
                $landed = Join-Path (Join-Path (Join-Path $docs 'P') 'Memory') 'MEMORY.md'
                Test-Path -LiteralPath $landed |
                    Should -BeTrue -Because "$root's fallback must sit under the running HOME"
            }
            finally { Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue }
        }
    }
```

- [ ] **Step 3: Run the suite and confirm the four new cases fail**

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`

Expected: exit 1, `Tests Passed: 4, Failed: 4`. All four fail on a `Should -BeTrue` against a path that was never written, because `$np.StartsWith('C:\Users\user\.claude\...')` is false for every sandbox path and the hook exits 0 at line 57 without copying.

- [ ] **Step 4: Derive the three roots at the top of the hook**

In `C:\Users\user\.claude\hooks\Sync-MemoryToObsidian.ps1`, replace the block running from `$np = $f -replace '/', '\'` through the `$councilRoot` assignment (lines 13-17 as of this writing, including the `# --- Council transcripts ---` banner between them):

```powershell
$np = $f -replace '/', '\'
$vaultBase = 'C:\Users\user\Documents\Obsidian Vault\Claude Code'

# --- Council transcripts ---
$councilRoot = 'C:\Users\user\.claude\council-transcripts\'
```

with:

```powershell
$np = $f -replace '/', '\'

# Every comparison below runs against $np, which is backslash-normalised on the line above.
# Derived roots go through the same replace and keep the trailing separator, or a Join-Path
# result stays forward-slashed on Linux and no StartsWith ever matches. Nested two-argument
# Join-Path throughout: this hook runs under "shell": "powershell", and that host may be
# Windows PowerShell 5.1, where a third positional argument is a binding error.
$claudeHome = (Join-Path $HOME '.claude') -replace '/', '\'

# The rule Get-ProjectSlug applies (Restore-ClaudeProject.ps1:151-170), inlined. -creplace,
# not -replace: .NET's IgnoreCase regex folds U+212A KELVIN SIGN onto 'k' and would leave it
# unreplaced, while Claude Code's own ordinal JS regex always replaces it.
$homeSlug = $HOME.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'

$vaultBase = if ($env:CLAUDE_OBSIDIAN_VAULT) {
    $env:CLAUDE_OBSIDIAN_VAULT
}
else {
    Join-Path (Join-Path (Join-Path $HOME 'Documents') 'Obsidian Vault') 'Claude Code'
}

# --- Council transcripts ---
$councilRoot = (Join-Path $claudeHome 'council-transcripts') + '\'
```

- [ ] **Step 5: Repoint the four remaining literals**

Four single-line edits, each located by its surrounding context rather than by line number alone.

Inside the `docs/superpowers/{plans,specs}` branch, the line reading `if ($proj -eq '.claude') { $proj = 'C--Users-user' }`:

```powershell
    if ($proj -eq '.claude') { $proj = $homeSlug }
```

The global plans/specs regex, currently `if ($np -match '^C:\\Users\\user\\\.claude\\(plans|specs)\\([^\\]+)$') {`:

```powershell
if ($np -match ('^' + [regex]::Escape($claudeHome) + '\\(plans|specs)\\([^\\]+)$')) {
```

The destination two lines below it, currently `$dest = Join-Path $vaultBase 'C--Users-user' $kind`:

```powershell
    $dest = Join-Path (Join-Path $vaultBase $homeSlug) $kind
```

And under `# --- Memory files ---`, currently `$memRoot = 'C:\Users\user\.claude\projects\'`:

```powershell
$memRoot = (Join-Path $claudeHome 'projects') + '\'
```

- [ ] **Step 6: Run the suite and confirm it is green**

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`
Expected: exit 0, `Tests Passed: 8, Failed: 0`.

- [ ] **Step 7: Ablate both halves of the fix**

Restore the literal `$memRoot = 'C:\Users\user\.claude\projects\'`, re-run, confirm `copies a memory write into a vault named by CLAUDE_OBSIDIAN_VAULT` goes red. Put it back. Separately restore `$proj = 'C--Users-user'`, re-run, confirm `routes a global spec write to the slug of the running HOME` goes red. Two ablations, because two independent sites hold those two tests up. Put both fixes back and re-run to green.

Both edits land in the operator's live sync hook. If anything goes wrong at any point, restore the file from the `.bak.<timestamp>` copy taken in Step 1 and re-run the suite before doing anything else.

- [ ] **Step 8: Confirm the operator's real vault was not written to**

```powershell
pwsh -NoProfile -Command "Get-ChildItem 'C:\Users\user\Documents\Obsidian Vault\Claude Code' -Directory -ErrorAction SilentlyContinue | Where-Object { \$_.Name -like 'acct-hooks-*' -or \$_.Name -like 'C--Users-user-AppData*' } | Select-Object -ExpandProperty Name"
```

Expected: no output. The sandbox vault sits under the system temp directory and the fallback case points at the sandbox's own `Documents`, so neither path can reach the live vault. Run it anyway: this task's whole subject is a hook that writes to a path derived at run time.

- [ ] **Step 9: Run the repo suites**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

- [ ] **Step 10: Commit**

```bash
git add install/Account-Hooks.Tests.ps1
git commit -m "fix(account): derive obsidian sync roots, slug and vault from HOME

Six sites in one hook, not one. The vault, the council root, the memory
root, the global plans/specs regex and two copies of the slug literal
C--Users-user all named this workstation. Reading the vault from an
environment variable reaches one of the six and leaves the hook a no-op on
every receiver, so all six move together.

The slug rule is inlined from Get-ProjectSlug rather than imported: the hook
runs as a standalone PostToolUse script with no access to the installer's
scope, and one -creplace is smaller than a dependency on install/.

Roots take the same forward-to-back slash normalisation the incoming path
gets, for the reason recorded on the secret scanner in the previous commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 3: Lint-DocumentProse and Guard-SkillSize build POSIX-safe roots

Spec bugs 3 and 4. Both are the same defect: a path built so that a Windows host cannot tell it from a correct one. `Lint-DocumentProse.ps1:71` puts four segments inside one `Join-Path` child argument, where the backslashes between them are separators on Windows and ordinary filename characters on Linux, so the Vale kit never resolves there and every consumer fails open. `Guard-SkillSize.ps1:34-35` reads `$env:USERPROFILE` twice, undefined on Linux, and the `if (-not $dir) { exit 0 }` further down then fails open when no root resolves. Two files, one fix mechanism, one test cycle, one reviewer gate.

Both fixes move the path build into a named function. That is the receipt for the only new construct in this task: a script-scope literal is not reachable from a test without scraping the source with a regex, and both scripts already define functions right beside the code being moved.

**Files:**
- Modify: `C:\Users\user\.claude\hooks\Lint-DocumentProse.ps1` (line 71)
- Modify: `C:\Users\user\.claude\hooks\Guard-SkillSize.ps1` (lines 33-37)
- Test: `install/Account-Hooks.Tests.ps1` (add two `It` blocks)

**Interfaces:**
- Consumes: `$script:hookRoots`, `Import-HookFunction`, `Invoke-UnderPosixJoin` from Task 1.
- Produces:
  - `Get-ValeConfigPath` -> `[string]`, defined in `Lint-DocumentProse.ps1`, no parameters.
  - `Get-SkillRoot` -> `[string[]]`, defined in `Guard-SkillSize.ps1`, no parameters.
  Both are read by name from `install/Account-Hooks.Tests.ps1` and by nothing else.

- [ ] **Step 1: Back up both hooks**

```powershell
foreach ($n in 'Lint-DocumentProse.ps1', 'Guard-SkillSize.ps1') {
    $f = Join-Path 'C:\Users\user\.claude\hooks' $n
    Copy-Item -LiteralPath $f -Destination "$f.bak.$(Get-Date -AsUTC -Format 'yyyyMMdd-HHmmss')"
}
```

- [ ] **Step 2: Write the two failing cases**

Append inside the closing brace of `Describe "Account hooks"`.

```powershell
    It "builds the Vale config path one segment at a time" {
        foreach ($root in $script:hookRoots) {
            $text = Import-HookFunction -ScriptPath (Join-Path $root 'Lint-DocumentProse.ps1') `
                -Name 'Get-ValeConfigPath'
            $built = Invoke-UnderPosixJoin -Expression ($text + "`nGet-ValeConfigPath") `
                -HomeValue '/home/u'
            $built | Should -Be '/home/u/.claude/tools/prose-lint/.vale.ini' `
                -Because "$root must not put separators inside a single path segment"
        }
    }

    It "builds skill roots from HOME, and drops the bundled root when LOCALAPPDATA is unset" {
        foreach ($root in $script:hookRoots) {
            $text = Import-HookFunction -ScriptPath (Join-Path $root 'Guard-SkillSize.ps1') `
                -Name 'Get-SkillRoot'
            $built = @(Invoke-UnderPosixJoin -Expression ($text + "`nGet-SkillRoot") `
                    -HomeValue '/home/u' -ClearEnv @('USERPROFILE', 'LOCALAPPDATA'))
            $built.Count | Should -Be 2 `
                -Because "$root has no bundled-skills root to offer when LOCALAPPDATA is unset"
            $built[0] | Should -Be '/home/u/.claude/skills'
            $built[1] | Should -Be '/home/u/.claude/plugins'

            # And the Windows path still yields all three, so the guard did not trade one
            # platform for the other.
            $win = @(Invoke-UnderPosixJoin -Expression ($text + "`nGet-SkillRoot") `
                    -HomeValue '/home/u')
            $win.Count | Should -Be 3
            $win[2] | Should -Match 'claude/bundled-skills$'
        }
    }
```

- [ ] **Step 3: Run the suite and confirm both new cases fail**

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`

Expected: exit 1, `Tests Passed: 8, Failed: 2`. Both fail inside `Import-HookFunction` with `... no longer defines Get-ValeConfigPath` and `... no longer defines Get-SkillRoot`, since neither function exists yet. After Step 4 alone the first would fail instead on the value, `/home/u/.claude\tools\prose-lint\.vale.ini` against the expected all-forward-slash string, which is the assertion that actually discriminates. Confirm that intermediate state by hand before Step 5 if you want the sharper red.

- [ ] **Step 4: Give Lint-DocumentProse a named path builder**

In `C:\Users\user\.claude\hooks\Lint-DocumentProse.ps1`, replace the single line reading `$config = Join-Path $HOME '.claude\tools\prose-lint\.vale.ini'` (line 71 as of this writing, immediately above `if (-not (Test-Path -LiteralPath $config)) { exit 0 }`) with:

```powershell
# Nested two-argument Join-Path, one segment per call. Backslashes inside a single child
# argument are separators on Windows and ordinary filename characters on Linux, so the old
# one-argument form never resolved there and this advisory hook went silently inert. The
# multi-segment form Join-Path gained in PowerShell 6 is not usable here: this file declares
# #Requires -Version 5.1 at line 1, and Windows PowerShell 5.1 rejects a third positional
# argument outright.
function Get-ValeConfigPath {
    return (Join-Path (Join-Path (Join-Path (Join-Path $HOME '.claude') 'tools') 'prose-lint') '.vale.ini')
}

$config = Get-ValeConfigPath
```

- [ ] **Step 5: Give Guard-SkillSize a named root builder**

In `C:\Users\user\.claude\hooks\Guard-SkillSize.ps1`, replace the `$SkillRoots` array literal (lines 33-37 as of this writing, sitting between the `$UsableFraction = 0.92` assignment and the `ConvertTo-PositiveInt` comment block):

```powershell
$SkillRoots = @(
    "$env:USERPROFILE\.claude\skills"
    "$env:USERPROFILE\.claude\plugins"
    "$env:LOCALAPPDATA\Temp\claude\bundled-skills"
)
```

with:

```powershell
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
```

- [ ] **Step 6: Confirm the guard still works on this box end to end**

`Guard-SkillSize.ps1` carries its own self-test, which exercises `Get-SkillDirectory` against the real skill roots.

Run: `pwsh -NoProfile -File "C:\Users\user\.claude\hooks\Guard-SkillSize.ps1" -SelfTest`
Expected: `SELFTEST OK`, exit 0. A non-zero exit or `SELFTEST FAILED` means `$SkillRoots` no longer reaches this machine's real skills directory, which is the regression this step exists to catch.

- [ ] **Step 7: Confirm the prose linter still fires on this box**

Run: `pwsh -NoProfile -Command "& { function Get-ValeConfigPath { return (Join-Path (Join-Path (Join-Path (Join-Path \$HOME '.claude') 'tools') 'prose-lint') '.vale.ini') }; Test-Path -LiteralPath (Get-ValeConfigPath) }"`
Expected: `True`. The hook itself is advisory and silent on a clean file, so a direct `Test-Path` on the built config is the signal that the kit still resolves here.

- [ ] **Step 8: Run the suite and confirm it is green**

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`
Expected: exit 0, `Tests Passed: 10, Failed: 0`.

- [ ] **Step 9: Ablate**

Change `Get-ValeConfigPath` back to the single-argument form `Join-Path $HOME '.claude\tools\prose-lint\.vale.ini'`, re-run, confirm `builds the Vale config path one segment at a time` goes red with the backslash-bearing value. Separately change `Get-SkillRoot`'s first two entries back to `"$env:USERPROFILE\.claude\skills"` and `"$env:USERPROFILE\.claude\plugins"`, re-run, confirm `builds skill roots from HOME` goes red. Restore both and re-run to green.

Both edits land in live hooks that fire on the operator's own writes, and this task holds two of them broken in turn. If anything goes wrong at any point, restore both files from the `.bak.<timestamp>` copies taken in Step 1 and re-run the suite before doing anything else.

- [ ] **Step 10: Run the repo suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

```bash
git add install/Account-Hooks.Tests.ps1
git commit -m "fix(account): build prose-lint and skill-size roots for both platforms

Two hooks, one defect shape: a path a Windows host cannot tell from a
correct one. Lint-DocumentProse put four segments inside one Join-Path child
argument, where the separators between them are ordinary filename characters
on Linux, so the Vale kit never resolved and every consumer failed open.
Guard-SkillSize read USERPROFILE, undefined on Linux, which left
Get-SkillDirectory returning null and the guard allowing every skill.

Rejected the multi-segment Join-Path the design proposed. Measured on
Windows PowerShell 5.1.26100.9278: Join-Path with a third positional
argument is a binding error, and Lint-DocumentProse declares
#Requires -Version 5.1 while the host that runs \"shell\": \"powershell\"
entries is still an open question. Nested two-argument calls are correct on
5.1 and on 7.

Both builders moved into named functions so the tests can evaluate them
under a stubbed POSIX Join-Path; a bare script-scope literal is only
reachable by scraping the source with a regex.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 4: Shared library, and the exporter's allowlist mirror

The first half of `Export-Account.ps1`: parameters, the payload tables, and the copy. The copy works from an allowlist and never a denylist, so a new runtime directory appearing under `~/.claude/` is excluded by default rather than swept into the repo. It mirrors rather than overlays, so a file removed from `~/.claude/` leaves the repo on the next export.

`install/AccountShared.ps1` exists because both new scripts need `Get-ProjectSlug`, `Test-ResidualWindowsPath` and `Convert-HookCommand`, and those live inside `Restore-ClaudeProject.ps1`, a script with two mandatory parameters that cannot be dot-sourced without prompting. Lifting them through the AST gives one definition rather than a copy that drifts. `Restore-ClaudeProject.Tests.ps1:8-17` already uses this exact idiom, including the throw when a name goes missing.

**Files:**
- Create: `install/AccountShared.ps1`
- Create: `install/Export-Account.ps1`
- Create: `install/Export-Account.Tests.ps1`
- Modify: `docs/backlog.md` (append the Gate 1 tracker item, Step 8)

**Interfaces:**
- Consumes: `Get-ProjectSlug`, `Test-ResidualWindowsPath`, `Convert-HookCommand`, all defined in `install/Restore-ClaudeProject.ps1` and lifted by name.
- Produces, from `install/AccountShared.ps1`, dot-sourced by Tasks 5, 6, 7, 8, 9, 10 and 11:
  - `$script:AccountTreeDirs` -> `[string[]]`, repo-relative directory names mirrored whole.
  - `$script:AccountRootFiles` -> `[string[]]`, single files copied from the account root.
  - `$script:AccountSkipFiles` -> `[string[]]`, payload-relative paths never copied.
  - `$script:AccountTemplatedFiles` -> `[ordered]` hashtable, payload-relative path -> `[string[]]` of token base names.
  - `Get-MainCheckout -StartDir [string]` -> `[string]`, forward-slashed absolute path of the main checkout.
- Produces, from `install/Export-Account.ps1`:
  - `Copy-AccountTree -SourceRoot [string] -DestRoot [string] -Relative [string] -SkipRelative [string[]]` -> `[int]` files copied.
- Produces, from `install/Export-Account.Tests.ps1`, used by Tasks 5, 6 and 7:
  - `New-StandInHome` -> `[string]`, absolute path of a planted stand-in `~/.claude` parent directory. The account layer sits at `<returned>/.claude`.
  - `New-OutputRoot` -> `[string]`, an unused temp path for one export's `-OutputRoot`. It does not create the directory; the exporter does.

- [ ] **Step 1: Write the failing tests**

Create `install/Export-Account.Tests.ps1`.

```powershell
# install/Export-Account.Tests.ps1
Describe "Export-Account" {
    BeforeAll {
        $script:export = "$PSScriptRoot/Export-Account.ps1"
        $script:shared = "$PSScriptRoot/AccountShared.ps1"

        # Plants a stand-in ~/.claude holding one file of every shape the exporter has a rule
        # about. No test asserts a count against the operator's live ~/.claude, which moves
        # under any session that edits it.
        function New-StandInHome {
            $standHome = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-export-" + [guid]::NewGuid())
            $claude = Join-Path $standHome '.claude'
            foreach ($d in 'rules', 'agents', 'hooks', 'tools/prose-lint/styles/Cringely',
                'skills/prose-lint', 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $claude $d) -Force | Out-Null
            }
            'rule body'                | Set-Content (Join-Path $claude 'rules/security.md')
            'stale backup'             | Set-Content (Join-Path $claude 'rules/security.md.bak.20260101-000000')
            'agent def'                | Set-Content (Join-Path $claude 'agents/appsec-sme.md')
            'StylesPath = styles'      | Set-Content (Join-Path $claude 'tools/prose-lint/.vale.ini')
            'rule yaml'                | Set-Content (Join-Path $claude 'tools/prose-lint/styles/Cringely/X.yml')
            'core owned'               | Set-Content (Join-Path $claude 'hooks/model-tier-gate.ts')
            'internal traffic'         | Set-Content (Join-Path $claude 'hooks/Guard-ModelTier.HANDOFF.md')
            'ps statusline'            | Set-Content (Join-Path $claude 'statusline-command.ps1')
            'sh statusline'            | Set-Content (Join-Path $claude 'statusline-command.sh')
            'local override'           | Set-Content (Join-Path $claude 'settings.local.json')

            # All six rows of $AccountTemplatedFiles, each carrying a foldable literal. The fold
            # pass throws on a row it cannot find, by design, so a fixture missing any of them
            # takes down every other test in this file rather than failing one.
            "Core repo: E:\projects\agent-harness-core"                    | Set-Content (Join-Path $claude 'rules/harness-core.md')
            "the core at E:\projects\agent-harness-core"                   | Set-Content (Join-Path $claude 'hooks/harness-core-reminder.sh')
            "vale --config `"$($claude -replace '/', '\')\tools\prose-lint\.vale.ini`"" |
                Set-Content (Join-Path $claude 'skills/prose-lint/SKILL.md')
            'write to C:\vault\Handoffs\x.md'                              | Set-Content (Join-Path $claude 'skills/handoff/SKILL.md')
            # Foldable under the exporter's default -HomeSlug, which is Get-ProjectSlug $HOME.
            # Same -creplace, inlined, because this fixture runs before AccountShared is loaded.
            $slugLiteral = $HOME.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
            "home folder is $slugLiteral"                                  | Set-Content (Join-Path $claude 'skills/council/SKILL.md')
            "$slugLiteral and C:\vault\Handoffs"                           | Set-Content (Join-Path $claude 'skills/subagent-prompting/SKILL.md')

            # A real $patterns block, not a stub. Get-SecretPattern lifts this table out of the
            # STAND-IN hook, not the live one, and throws when the AST has no such assignment,
            # which would take Task 7's three tests and both round-trip tests with it. Two rows
            # is enough, and the sk_ rule is the one the planted-token test depends on.
            @'
$patterns = @(
    @{ Name = 'API token (tk_/sk_/ak_)'; Regex = '(?<![a-zA-Z0-9_])(tk_|sk_|ak_)[a-zA-Z0-9]{10,}' }
    @{ Name = 'AWS-style key';           Regex = 'AKIA[0-9A-Z]{16}' }
)
exit 0
'@ | Set-Content (Join-Path $claude 'hooks/Scan-MemorySecrets.ps1')

            # Two things the allowlist must leave behind: a directory nobody named, and a
            # credential sitting at the account root.
            New-Item -ItemType Directory -Path (Join-Path $claude 'shell-snapshots') -Force | Out-Null
            'runtime state'            | Set-Content (Join-Path $claude 'shell-snapshots/snap-1.ps1')
            '{"token":"x"}'            | Set-Content (Join-Path $claude '.credentials.json')

            return $standHome
        }

        function New-OutputRoot {
            Join-Path ([System.IO.Path]::GetTempPath()) ("acct-out-" + [guid]::NewGuid())
        }
    }

    It "lifts all three path functions out of Restore-ClaudeProject.ps1" {
        # A rename in Restore would otherwise leave both new scripts calling an undefined
        # function at run time, with no signal until someone ran an export.
        { . $script:shared } | Should -Not -Throw
        . $script:shared
        (Get-Command Get-ProjectSlug -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
        (Get-Command Test-ResidualWindowsPath -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
        (Get-Command Convert-HookCommand -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
        Get-ProjectSlug 'C:\Users\user' | Should -Be 'C--Users-user'
        Get-ProjectSlug '/home/u' | Should -Be '-home-u'
    }

    It "resolves the main checkout from a worktree as well as from the checkout itself" {
        . $script:shared
        $main = Get-MainCheckout -StartDir (Split-Path $PSScriptRoot -Parent)
        $main | Should -Not -Match '\\'
        Test-Path -LiteralPath (Join-Path $main 'CONTRIBUTING.md') | Should -BeTrue
        # Assert the returned path is not itself a worktree. Testing whether the main checkout
        # CONTAINS a worktrees directory is a different question and the wrong one: this repo's
        # own write-agent gate puts checkouts under .claude/worktrees/, so that directory is
        # present in the main checkout and the assertion would be red on a healthy tree.
        $main | Should -Not -Match '(?i)worktrees' `
            -Because "a worktree path would mean the fold folds the wrong literal"
    }

    It "copies only the allowlisted tree and drops .bak, core-owned and handoff files" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            & $script:export -ClaudeHome (Join-Path $stand '.claude') -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null

            Test-Path -LiteralPath (Join-Path $out 'rules/security.md')                 | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'agents/appsec-sme.md')              | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'skills/prose-lint/SKILL.md')        | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'tools/prose-lint/.vale.ini')        | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'tools/prose-lint/styles/Cringely/X.yml') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'hooks/Scan-MemorySecrets.ps1')      | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'statusline-command.ps1')            | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $out 'statusline-command.sh')             | Should -BeTrue

            Test-Path -LiteralPath (Join-Path $out 'rules/security.md.bak.20260101-000000') |
                Should -BeFalse -Because "change-management.md mints one .bak per edit and none belong in the repo"
            Test-Path -LiteralPath (Join-Path $out 'hooks/model-tier-gate.ts') |
                Should -BeFalse -Because "core/claude/hooks/model-tier-gate.ts is the authoritative copy"
            Test-Path -LiteralPath (Join-Path $out 'hooks/Guard-ModelTier.HANDOFF.md') |
                Should -BeFalse -Because "handoffs are internal agent traffic"
            Test-Path -LiteralPath (Join-Path $out 'shell-snapshots') |
                Should -BeFalse -Because "an unnamed directory is excluded by default, not swept in"
            Test-Path -LiteralPath (Join-Path $out '.credentials.json') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $out 'settings.local.json') |
                Should -BeFalse -Because "settings.local.json is the per-machine escape hatch"
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "mirrors rather than overlays, so a deleted source file leaves the payload" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $args = @{
                ClaudeHome = (Join-Path $stand '.claude'); OutputRoot = $out
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
                VaultPath = 'C:/vault'
            }
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'agents/appsec-sme.md') | Should -BeTrue

            Remove-Item -LiteralPath (Join-Path $stand '.claude/agents/appsec-sme.md')
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'agents/appsec-sme.md') |
                Should -BeFalse -Because "an overlay export would accrete deleted files forever"
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }

    It "is idempotent: a second export with nothing changed writes identical bytes" {
        # This is what makes `git status` after an export a usable review of what changed in
        # the account layer. Without it every export is a diff and the signal is worthless.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $args = @{
                ClaudeHome = (Join-Path $stand '.claude'); OutputRoot = $out
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
                VaultPath = 'C:/vault'
            }
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            $first = @(Get-ChildItem -LiteralPath $out -Recurse -File | Sort-Object FullName |
                ForEach-Object { "$($_.FullName.Substring($out.Length))=$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" })
            & $script:export @args -SkipSettings -SkipMcp | Out-Null
            $second = @(Get-ChildItem -LiteralPath $out -Recurse -File | Sort-Object FullName |
                ForEach-Object { "$($_.FullName.Substring($out.Length))=$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" })
            ($second -join "`n") | Should -Be ($first -join "`n")
        }
        finally {
            Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue
        }
    }
}
```

- [ ] **Step 2: Run and confirm every case fails**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 1, five failures, the first two on `install/AccountShared.ps1` not existing and the rest on `install/Export-Account.ps1` not existing.

- [ ] **Step 3: Write install/AccountShared.ps1**

```powershell
# install/AccountShared.ps1
#
# Dot-sourced by Export-Account.ps1 and Install-Account.ps1. Holds the payload tables the two
# must agree on, and lifts three path functions out of Restore-ClaudeProject.ps1.
#
# The lift, rather than a copy: those functions live inside a script with two mandatory
# parameters, so dot-sourcing it would prompt. A second copy of Get-ProjectSlug would drift
# from Restore's the moment either was edited, and the slug rule is the one place where a
# silent divergence produces session folders that look healthy while --resume reports nothing.
# Restore-ClaudeProject.Tests.ps1:8-17 already lifts the same three the same way.

$restoreScript = Join-Path $PSScriptRoot 'Restore-ClaudeProject.ps1'
$restoreAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $restoreScript, [ref]$null, [ref]$null)
$restoreDefs = @($restoreAst.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
foreach ($fnName in 'Get-ProjectSlug', 'Convert-HookCommand', 'Test-ResidualWindowsPath') {
    $fn = @($restoreDefs | Where-Object { $_.Name -eq $fnName })
    # Without this, a rename in Restore leaves both scripts calling an undefined function with
    # no signal until someone runs an export.
    if ($fn.Count -eq 0) { throw "Restore-ClaudeProject.ps1 no longer defines $fnName" }
    . ([scriptblock]::Create($fn[0].Extent.Text))
}

# --- payload tables -----------------------------------------------------------
# The allowlist. Nothing else under ~/.claude is looked at, so a new runtime directory
# appearing there is excluded by default rather than swept into the repo.
$script:AccountTreeDirs = @('rules', 'agents', 'skills', 'tools/prose-lint', 'hooks')
$script:AccountRootFiles = @('statusline-command.ps1', 'statusline-command.sh')

# Payload-relative paths that never travel. model-tier-gate.ts is core-owned: the installer
# copies it from core/claude/hooks/ in the same clone, and two copies in one repo would drift.
# The HANDOFF is internal agent traffic naming a script that no longer exists under that name.
$script:AccountSkipFiles = @('hooks/model-tier-gate.ts', 'hooks/Guard-ModelTier.HANDOFF.md')

# Model-read text carrying machine paths. A hook derives its paths at run time and is fixed at
# source; these cannot be, because a placeholder written into the live file is read literally by
# the model on this box. Export folds, install expands. The table is an allowlist for the same
# reason the tree is: rules/ssh.md and rules/change-management.md name this machine on purpose
# and must not be touched.
$script:AccountTemplatedFiles = [ordered]@{
    'rules/harness-core.md'              = @('CORE_REPO')
    'hooks/harness-core-reminder.sh'     = @('CORE_REPO')
    'skills/prose-lint/SKILL.md'         = @('CLAUDE_HOME')
    'skills/handoff/SKILL.md'            = @('OBSIDIAN_VAULT')
    'skills/council/SKILL.md'            = @('HOME_SLUG')
    'skills/subagent-prompting/SKILL.md' = @('OBSIDIAN_VAULT', 'HOME_SLUG')
}

# Resolves the main checkout even when called from a worktree under .claude/worktrees/, which
# is where this repo's own write agents run. Measured on git 2.53.0: --path-format=absolute
# --git-common-dir returns E:/projects/agent-harness-core/.git from both the main checkout and
# from a worktree, so the parent is the main checkout in both cases. Folding a worktree path
# would produce a token that matches nothing on the next export.
function Get-MainCheckout {
    param([string]$StartDir)
    # Get-Command first. `& git` with no git on PATH is a terminating CommandNotFoundException
    # that 2>$null does not swallow, so without this the caller gets that message instead of
    # the actionable one below.
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is not on PATH, so the main checkout cannot be resolved from '$StartDir'. Pass -CoreRepo explicitly."
    }
    $common = & git -C $StartDir rev-parse --path-format=absolute --git-common-dir 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $common) {
        throw "Could not resolve the main checkout from '$StartDir'. Pass -CoreRepo explicitly."
    }
    return ((Split-Path $common -Parent) -replace '\\', '/')
}
```

- [ ] **Step 4: Write the first half of install/Export-Account.ps1**

```powershell
<#
.SYNOPSIS
    Exports this workstation's ~/.claude account layer into account/claude/ in this repo.

.DESCRIPTION
    Runs on the canonical workstation only. Config is authored in ~/.claude here, exported
    into the repo, and consumed elsewhere; a divergence on a receiver is a bug rather than a
    fork to preserve.

    The copy works from an allowlist in AccountShared.ps1 and never a denylist, and it mirrors
    rather than overlays: each allowlisted directory is removed and recopied, so a file deleted
    from ~/.claude leaves the repo instead of accreting there. Within those directories every
    *.bak.* is dropped.

    A second export with nothing changed produces no diff, which makes `git status` after an
    export a usable review of what changed in the account layer.

.PARAMETER ClaudeHome
    The account home to export. Defaults to $HOME/.claude.

.PARAMETER ClaudeJson
    The file holding mcpServers. Defaults to $HOME/.claude.json.

.PARAMETER OutputRoot
    Destination. Defaults to account/claude/ under the running clone.

.PARAMETER CoreRepo
    The literal folded into {{CORE_REPO}}. Defaults to the main checkout resolved through git.

.PARAMETER NpmGlobal
    The literal folded into {{NPM_GLOBAL}}. Defaults to `npm root -g`.

.PARAMETER VaultPath
    The literal folded into {{OBSIDIAN_VAULT}}. Defaults to $env:CLAUDE_OBSIDIAN_VAULT, else
    $HOME/Documents/Obsidian Vault/Claude Code.

.PARAMETER SkipSettings
    Skip the settings.account.json rewrite. Test seam.

.PARAMETER SkipMcp
    Skip the mcp-servers.json lift. Test seam.

.EXAMPLE
    pwsh -NoProfile -File install/Export-Account.ps1
#>
# PositionalBinding=$false, not a position list: Restore-ClaudeProject.ps1:71-95 records that
# PowerShell auto-assigns a position to every non-switch parameter lacking one, in declaration
# order, so a later-added seam silently becomes positional and a stray extra argument sets it
# without a binding error. Unlike Restore this script has no existing positional callers.
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$ClaudeHome,
    [string]$ClaudeJson,
    [string]$OutputRoot,
    [string]$CoreRepo,
    [string]$NpmGlobal,
    [string]$VaultPath,
    [switch]$SkipSettings,
    [switch]$SkipMcp
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AccountShared.ps1')

$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $ClaudeHome) { $ClaudeHome = Join-Path $HOME '.claude' }
if (-not $ClaudeJson) { $ClaudeJson = Join-Path $HOME '.claude.json' }
if (-not $OutputRoot) { $OutputRoot = Join-Path (Join-Path $repoRoot 'account') 'claude' }
if (-not $CoreRepo)   { $CoreRepo = Get-MainCheckout -StartDir $repoRoot }
if (-not $VaultPath) {
    $VaultPath = if ($env:CLAUDE_OBSIDIAN_VAULT) { $env:CLAUDE_OBSIDIAN_VAULT }
    else { Join-Path (Join-Path (Join-Path $HOME 'Documents') 'Obsidian Vault') 'Claude Code' }
}
# Get-Command before the call: invoking a native command that is not on PATH throws a
# terminating CommandNotFoundException, and `2>$null` does not catch it. Under
# $ErrorActionPreference = 'Stop' that takes the exporter down instead of leaving $NpmGlobal
# null, which is the value the rest of this file is written to handle.
if (-not $PSBoundParameters.ContainsKey('NpmGlobal')) {
    $NpmGlobal = if (Get-Command npm -ErrorAction SilentlyContinue) {
        $v = (& npm root -g 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0) { $v } else { $null }
    } else { $null }
}

if (-not (Test-Path -LiteralPath $ClaudeHome)) { throw "No account layer at '$ClaudeHome'." }

Write-Host "Account home : $ClaudeHome"
Write-Host "Output root  : $OutputRoot"

# Mirror one allowlisted directory. The destination subtree is removed first, which is the
# whole difference between a mirror and an overlay: without it a file deleted from ~/.claude
# stays in the repo forever and every receiver keeps installing it.
function Copy-AccountTree {
    param(
        [string]$SourceRoot,
        [string]$DestRoot,
        [string]$Relative,
        [string[]]$SkipRelative
    )
    $from = Join-Path $SourceRoot $Relative
    $to = Join-Path $DestRoot $Relative
    if (-not (Test-Path -LiteralPath $from)) {
        Write-Warning "absent, skipping: $from"
        return 0
    }
    if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $to -Force

    $copied = 0
    # -Force so hidden entries are enumerated; a dir\* wildcard silently skips them on Windows.
    foreach ($f in @(Get-ChildItem -LiteralPath $from -Recurse -File -Force)) {
        $rel = ($f.FullName.Substring($from.Length).TrimStart('\', '/')) -replace '\\', '/'
        if ($f.Name -like '*.bak.*') { continue }
        if ($SkipRelative -contains "$Relative/$rel") { continue }
        $dest = Join-Path $to $rel
        $null = New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $copied++
    }
    return $copied
}

$null = New-Item -ItemType Directory -Path $OutputRoot -Force

foreach ($d in $script:AccountTreeDirs) {
    $n = Copy-AccountTree -SourceRoot $ClaudeHome -DestRoot $OutputRoot `
        -Relative $d -SkipRelative $script:AccountSkipFiles
    Write-Host "  ${d}: $n files"
}

foreach ($f in $script:AccountRootFiles) {
    $src = Join-Path $ClaudeHome $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $OutputRoot $f) -Force
        Write-Host "  ${f}: copied"
    }
    else { Write-Warning "absent, skipping: $src" }
}
```

- [ ] **Step 5: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 5, Failed: 0`.

- [ ] **Step 6: Ablate the mirror**

Delete the `if (Test-Path -LiteralPath $to) { Remove-Item ... }` line from `Copy-AccountTree`, re-run, confirm `mirrors rather than overlays` goes red. Then delete the `if ($f.Name -like '*.bak.*') { continue }` line, re-run, confirm `copies only the allowlisted tree` goes red on the `.bak` assertion. Restore both and re-run to green.

- [ ] **Step 7: Run the other suites**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

Run: `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`
Expected: exit 0. Nothing in this task touches the installer, and this is the check that says so.

Run: `pwsh -NoProfile -File install/Restore-ClaudeProject.Tests.ps1`
Expected: exit 0. `AccountShared.ps1` reads Restore's source but does not modify it; this confirms that.

- [ ] **Step 8: Commit**

`Export-Account.ps1` is a new executable artifact, and CONTRIBUTING's Gate 1 wants its registration in the same commit. Its registration is operator-facing text in `README.md` and `~/.claude/rules/harness-core.md`, which lands in Task 13 once the script is finished. Gate 1's sanctioned path for that split is a header notice plus a tracker item, so add these two lines at the very top of `install/Export-Account.ps1`, above the comment-based help:

```powershell
# UNWIRED until Task 13 of docs/superpowers/plans/2026-09-03-account-layer-portability.md adds
# its README and rules/harness-core.md registration. Invoke: pwsh -NoProfile -File install/Export-Account.ps1
```

The header is half of what Gate 1 asks for. It also wants "a tracker item (a backlog entry or an issue) that names who wires it", and there is precedent in `docs/backlog.md` item 10, which exists because a file shipped with a header notice and no tracker item. Append this to the end of `docs/backlog.md`, renumbering only if the file has grown past 15 since this plan was written:

```markdown

---

## 16. Export-Account and Install-Account ship unwired until Task 13

**Status:** open. Closes when Task 13 of `docs/superpowers/plans/2026-09-03-account-layer-portability.md` lands.
**Surfaced:** 2026-09-03, account layer portability work.

Both scripts carry the Gate 1 header notice. Neither is named by `README.md` or by
`~/.claude/rules/harness-core.md`, so nothing tells an operator they exist. Task 13 adds both
registrations and removes both notices; this item is the tracker Gate 1 asks for in the meantime.

Owner: whoever executes Task 13 of that plan. If the plan is abandoned before Task 13, the two
scripts and their test files come out rather than staying as unwired files that read as installed.
```

```bash
git add install/AccountShared.ps1 install/Export-Account.ps1 install/Export-Account.Tests.ps1 docs/backlog.md
git commit -m "feat(install): Export-Account allowlist mirror and shared path library

The account layer has no distribution path, which is why an account-scope
model-tier guard sat unregistered for three weeks: registering it was a
manual step on every machine. This is the first half of the exporter.

Allowlist, not denylist: a new runtime directory appearing under ~/.claude
is excluded by default rather than swept into the repo. Mirror, not overlay:
each allowlisted directory is removed and recopied, so a file deleted from
~/.claude leaves the repo instead of accreting there and being reinstalled
on every receiver forever.

AccountShared.ps1 lifts Get-ProjectSlug, Convert-HookCommand and
Test-ResidualWindowsPath out of Restore-ClaudeProject.ps1 through the AST
rather than copying them. Rejected the copy: the slug rule is the one place
a silent divergence produces session folders that look healthy while
--resume reports nothing. Rejected a shared module that Restore also
imports: that would break Restore's own tests, which lift the same three
functions by name, for no gain in this change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 5: settings.account.json, the templated settings rewrite

`settings.json` cannot travel as it stands. Every hook command carries an absolute path in one of three quoting forms: `& 'C:\Users\user\.claude\hooks\Scan-MemorySecrets.ps1'` for the four `.ps1` hooks, `bun "C:\Users\user\.claude\hooks\model-tier-gate.ts"` and the matching `bash "..."` form, and unquoted `node C:/Users/user/AppData/Roaming/npm/node_modules/ccstatusline/dist/ccstatusline.js` in `statusLine.command` and two hook entries.

**Files:**
- Modify: `install/Export-Account.ps1` (append after the root-file copy loop from Task 4)
- Test: `install/Export-Account.Tests.ps1` (add four `It` blocks)

**Interfaces:**
- Consumes: `$script:AccountTreeDirs` and the parameter set from Task 4; `New-StandInHome` from Task 4's test file.
- Produces, from `install/Export-Account.ps1`, consumed by Task 6 and read by Tasks 9 and 10:
  - `Get-AccountFoldTable -ClaudeHome [string] -NpmGlobal [string] -CoreRepo [string] -VaultPath [string] -HomeSlug [string]` -> `[pscustomobject[]]`, each carrying `Token [string]`, `Literal [string]` and `IsPath [bool]`.
  - `ConvertTo-TemplatedText -Text [string] -Fold [pscustomobject]` -> `[string]`, one fold applied to one string. Task 6 calls this per row.
  - `ConvertTo-TemplatedCommand -Text [string] -Folds [pscustomobject[]]` -> `[string]`, every fold in the table applied to one command string. Task 7 calls this on `mcpServers` values.
  - The file `<OutputRoot>/settings.account.json`, whose hook and `statusLine` commands carry `{{CLAUDE_HOME}}` and `{{NPM_GLOBAL}}` in forward-slash form.

- [ ] **Step 1: Write the failing tests**

Add inside the closing brace of `Describe "Export-Account"`.

```powershell
    It "folds all three quoting forms into forward-slash placeholders" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $chBack = $ch -replace '/', '\'
            $settings = @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'; ENABLE_TOOL_SEARCH = 'auto:5' }
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                hooks = @{
                    PreToolUse = @(
                        @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'
                                    command = "& '$chBack\hooks\Scan-MemorySecrets.ps1'"
                                    shell = 'powershell'; timeout = 5 }) }
                        @{ matcher = 'Agent|Task|Workflow'; hooks = @(
                                @{ type = 'command'
                                    command = "bun `"$chBack\hooks\model-tier-gate.ts`""
                                    timeout = 10 }) }
                    )
                    SessionStart = @(
                        @{ hooks = @(
                                @{ type = 'command'
                                    command = "bash `"$chBack\hooks\harness-core-reminder.sh`""
                                    timeout = 10 }) }
                    )
                    UserPromptSubmit = @(
                        @{ hooks = @(
                                @{ type = 'command'
                                    command = 'node C:/npm/node_modules/ccstatusline/dist/ccstatusline.js --hook'
                                    timeout = 15 }) }
                    )
                }
                statusLine = @{ type = 'command'
                    command = 'node C:/npm/node_modules/ccstatusline/dist/ccstatusline.js'
                    padding = 0 }
                skipDangerousModePermissionPrompt = $true
            }
            $settings | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $raw = Get-Content (Join-Path $out 'settings.account.json') -Raw
            $s = $raw | ConvertFrom-Json

            $cmds = @()
            foreach ($e in $s.hooks.PSObject.Properties.Name) {
                foreach ($g in @($s.hooks.$e)) { foreach ($h in @($g.hooks)) { $cmds += $h.command } }
            }
            $cmds | Should -Contain "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
            $cmds | Should -Contain 'bun "{{CLAUDE_HOME}}/hooks/model-tier-gate.ts"'
            $cmds | Should -Contain 'bash "{{CLAUDE_HOME}}/hooks/harness-core-reminder.sh"'
            $cmds | Should -Contain '{{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook'.Insert(0, 'node ')
            $s.statusLine.command | Should -Be 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js'

            # The whole rewritten path, not only the prefix. A prefix-only fold leaves a
            # receiver with /home/u/.claude\hooks\Scan-MemorySecrets.ps1, which is one string
            # on Linux and not a path at all.
            $raw | Should -Not -Match 'CLAUDE_HOME\}\}\\\\'
            # Assert on the parsed commands, not on $raw. JSON doubles every backslash, so a
            # pattern built by [regex]::Escape($chBack) needs SINGLE backslashes and can never
            # match the doubled text whatever the exporter did. Measured: that form does not
            # match "& 'C:\\Users\\user\\.claude\\hooks\\x.ps1'", so it is an assertion with no
            # failing input, which is what patterns/test-falsifiability.md targets.
            foreach ($c in $cmds) { $c | Should -Not -Match ([regex]::Escape($chBack)) }
            $s.statusLine.command | Should -Not -Match ([regex]::Escape($chBack))
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "keeps every non-command key, including the two the operator chose to ship" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1' }
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                skillOverrides = @{ 'appsec-kpi-deck' = 'off' }
                enabledPlugins = @{ 'superpowers@claude-plugins-official' = $true }
                skipDangerousModePermissionPrompt = $true
                effortLevel = 'xhigh'
                hooks = @{}
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $s = Get-Content (Join-Path $out 'settings.account.json') -Raw | ConvertFrom-Json
            $s.permissions.defaultMode | Should -Be 'auto'
            # Decision 8: excluding these was recommended and the operator overruled it. The
            # cost is recorded in the design; the test's job is to notice if they silently stop
            # shipping, in either direction.
            $s.skipDangerousModePermissionPrompt | Should -BeTrue
            $s.effortLevel | Should -Be 'xhigh'
            $s.skillOverrides.'appsec-kpi-deck' | Should -Be 'off'
            $s.env.CLAUDE_CODE_USE_POWERSHELL_TOOL | Should -Be '1'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "serialises a one-hook matcher group as a JSON array" {
        # A round trip through ConvertFrom-Json is not a reliable check: the file's raw text is
        # the only faithful signal of what got written. Install-Harness.Tests.ps1 makes the same
        # assertion the same way, for the same reason.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $chBack = $ch -replace '/', '\'
            @{ hooks = @{ PreToolUse = @(
                        @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '$chBack\hooks\Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null

            $raw = Get-Content (Join-Path $out 'settings.account.json') -Raw
            $raw | Should -Not -Match '"hooks":\s*\{\s*"type"'
            $raw | Should -Match '"hooks":\s*\['
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "leaves settings.json itself out of the payload" {
        # Only the templated copy travels. Shipping the literal file would put this
        # workstation's absolute paths on every receiver.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            '{"hooks":{}}' | Set-Content (Join-Path $ch 'settings.json')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipMcp | Out-Null
            Test-Path -LiteralPath (Join-Path $out 'settings.json') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $out 'settings.account.json') | Should -BeTrue
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }
```

- [ ] **Step 2: Run and confirm the four new cases fail**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 1, `Tests Passed: 5, Failed: 4`. Each fails on `Get-Content` against a `settings.account.json` that was never written.

- [ ] **Step 3: Add the fold table and the text templater to Export-Account.ps1**

Append to `install/Export-Account.ps1`, after the root-file copy loop.

```powershell
# --- fold table --------------------------------------------------------------
# Each fold has one named source. {{CLAUDE_HOME}} is the -ClaudeHome value, {{NPM_GLOBAL}} is
# `npm root -g`, {{CORE_REPO}} is the main checkout, {{OBSIDIAN_VAULT}} and {{HOME_SLUG}} come
# from $HOME. Order is immaterial: no literal contains another, since the npm path and the
# vault both sit under the bare home rather than under .claude, and the slug shares no
# characters with any path spelling.
function Get-AccountFoldTable {
    param(
        [string]$ClaudeHome,
        [string]$NpmGlobal,
        [string]$CoreRepo,
        [string]$VaultPath,
        [string]$HomeSlug
    )
    return @(
        [pscustomobject]@{ Token = '{{CLAUDE_HOME}}';    Literal = $ClaudeHome; IsPath = $true }
        [pscustomobject]@{ Token = '{{NPM_GLOBAL}}';     Literal = $NpmGlobal;  IsPath = $true }
        [pscustomobject]@{ Token = '{{CORE_REPO}}';      Literal = $CoreRepo;   IsPath = $true }
        [pscustomobject]@{ Token = '{{OBSIDIAN_VAULT}}'; Literal = $VaultPath;  IsPath = $true }
        [pscustomobject]@{ Token = '{{HOME_SLUG}}';      Literal = $HomeSlug;   IsPath = $false }
    )
}

# Folds one literal into its token. A path fold matches both separator spellings and
# forward-slashes the whole tail, not only the prefix: install writes forward-slash form, and
# this box's originals are backslashed, so a fold that matched one spelling would leave the
# other literal and break the round trip the design depends on.
#
# Only the $homePattern idiom is reused from Convert-HookCommand (Restore-ClaudeProject.ps1:192).
# Calling that function whole here is wrong in both directions: its Linux branch welds the
# "& '...ps1'" to "pwsh -NoProfile -File" rewrite in at L245-247, which would ship Linux
# commands to Windows receivers, and its Windows branch at L195-197 leaves the tail
# backslashed. The installer may call it whole, with $OldHome set to '{{CLAUDE_HOME}}'.
function ConvertTo-TemplatedText {
    param([string]$Text, [pscustomobject]$Fold)
    if (-not $Fold.Literal -or -not $Text) { return $Text }
    if (-not $Fold.IsPath) { return $Text.Replace($Fold.Literal, $Fold.Token) }

    # Normalise the literal to backslashes BEFORE escaping. [regex]::Escape leaves '/' alone, so
    # building the pattern straight from a forward-slashed literal produces a forward-only
    # pattern and the both-separator substitution below matches nothing to rewrite. That is not
    # hypothetical: Get-MainCheckout returns a forward-slashed path, and both live {{CORE_REPO}}
    # source files spell it with backslashes, so without this line the real export folds nothing
    # and ships E:\projects\agent-harness-core to every receiver with the whole suite green.
    # Measured: Escape('E:/projects/...') -> 'E:/projects/...' (no separator class);
    # Escape('E:\projects\...') -> 'E:[\\/]projects[\\/]...' which matches both spellings.
    $pattern = [regex]::Escape(($Fold.Literal -replace '/', '\')) -replace '\\\\', '[\\\\/]'
    $token = $Fold.Token
    $tail = '(?<tail>(?:[\\/][^"''\s]*)*)'
    return [regex]::Replace($Text, $pattern + $tail, {
            param($m)
            $token + $m.Groups['tail'].Value.Replace('\', '/')
        })
}

function ConvertTo-TemplatedCommand {
    param([string]$Text, [pscustomobject[]]$Folds)
    $out = $Text
    foreach ($f in @($Folds)) { $out = ConvertTo-TemplatedText -Text $out -Fold $f }
    return $out
}

$homeSlug = Get-ProjectSlug ($HOME)
$folds = @(Get-AccountFoldTable -ClaudeHome $ClaudeHome -NpmGlobal $NpmGlobal `
        -CoreRepo $CoreRepo -VaultPath $VaultPath -HomeSlug $homeSlug)

# --- settings.account.json ---------------------------------------------------
if (-not $SkipSettings) {
    $settingsSrc = Join-Path $ClaudeHome 'settings.json'
    if (-not (Test-Path -LiteralPath $settingsSrc)) {
        Write-Warning "absent, skipping: $settingsSrc"
    }
    else {
        # Parse and rewrite the command strings rather than text-replacing the whole file: the
        # JSON encoding doubles every backslash, so a text pass would have to match two
        # spellings of two spellings and would also reach strings that are not paths.
        $settings = Get-Content -LiteralPath $settingsSrc -Raw | ConvertFrom-Json

        foreach ($event in $settings.hooks.PSObject.Properties.Name) {
            # Wrap the pipeline OUTPUT, not just the input: a single-match result unwraps to a
            # bare scalar and would serialise "hooks": {...} instead of "hooks": [...], which
            # Claude Code cannot load (install/Install-Harness.ps1:822-826).
            $groups = @($settings.hooks.$event)
            foreach ($group in $groups) {
                $hooks = @($group.hooks)
                foreach ($hook in $hooks) {
                    $hook.command = ConvertTo-TemplatedCommand -Text $hook.command -Folds $folds
                }
                $group.hooks = $hooks
            }
            $settings.hooks.$event = $groups
        }
        if ($settings.statusLine.command) {
            $settings.statusLine.command =
                ConvertTo-TemplatedCommand -Text $settings.statusLine.command -Folds $folds
        }

        $settings | ConvertTo-Json -Depth 20 |
            Set-Content -LiteralPath (Join-Path $OutputRoot 'settings.account.json') -Encoding utf8
        Write-Host '  settings.account.json: written'
    }
}
```

- [ ] **Step 4: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 9, Failed: 0`.

- [ ] **Step 5: Ablate the tail slashing**

In `ConvertTo-TemplatedText`, change `$m.Groups['tail'].Value.Replace('\', '/')` to `$m.Groups['tail'].Value`, re-run, and confirm `folds all three quoting forms into forward-slash placeholders` goes red on the `Should -Contain` for the `.ps1` command, whose value becomes `& '{{CLAUDE_HOME}}\hooks\Scan-MemorySecrets.ps1'`. Restore and re-run to green.

- [ ] **Step 6: Run the other suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

```bash
git add install/Export-Account.ps1 install/Export-Account.Tests.ps1
git commit -m "feat(install): fold settings.json into settings.account.json

Every hook command in settings.json is absolute, in three quoting forms
(& 'path' with a shell key, bun/bash \"path\", and an unquoted node path
into the npm global root). None of them travel.

The rewrite parses and edits command strings rather than text-replacing the
whole file: JSON encoding doubles every backslash, so a text pass would have
to match two spellings of two spellings and would also reach strings that
are not paths.

Every fold matches both separator spellings and forward-slashes the whole
tail, not only the prefix. A prefix-only fold leaves a receiver with
/home/u/.claude\\hooks\\x.ps1, which is one string on Linux and not a path.
That also keeps install-then-export a no-op on the canonical box, since
install writes forward-slash form while the originals here are backslashed.

Reuses only the homePattern idiom from Convert-HookCommand, not the function:
its Linux branch welds the pwsh -NoProfile -File rewrite in unconditionally,
which would ship Linux commands to Windows receivers.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 6: Fold the six model-read files

Spec bugs 5 through 8. These six files carry machine paths that a hook could derive at run time but a model-read document cannot, because a placeholder written into the live file is read literally by the model on this box. They get the export-time fold instead, mirrored by install-time expansion in Task 9. The table is an allowlist for the same reason the tree is: `rules/ssh.md` names `C:\Users\user\.ssh\config` and `rules/change-management.md` records the Git Bash `$HOME` trap by its literal path, both on purpose, and neither may be touched.

**Files:**
- Modify: `install/Export-Account.ps1` (append after the settings block)
- Test: `install/Export-Account.Tests.ps1` (add four `It` blocks)

**Interfaces:**
- Consumes: `$script:AccountTemplatedFiles` from Task 4, `Get-AccountFoldTable` and `ConvertTo-TemplatedText` from Task 5. Text, not Command: this task folds file bodies, and `ConvertTo-TemplatedCommand` is the wrapper Task 5 uses on settings command strings.
- Produces: nothing new by name. Task 9 expands the same table in the same six files.

- [ ] **Step 1: Write the failing tests**

Add inside the closing brace of `Describe "Export-Account"`.

```powershell
    It "folds each templated file with only the tokens its table row names" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $core = 'E:\projects\agent-harness-core'
            $vault = 'C:\Users\user\Documents\Obsidian Vault\Claude Code'
            $slug = $stand.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
            foreach ($d in 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $ch $d) -Force | Out-Null
            }
            "Core repo: ``$core``. Run pwsh $core\install\Install-Harness.ps1" |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            "The core repo at $core is the baseline. Run $core\install\Install-Harness.ps1" |
                Set-Content (Join-Path $ch 'hooks/harness-core-reminder.sh')
            "vale --config `"$ch\tools\prose-lint\.vale.ini`" --output=line" |
                Set-Content (Join-Path $ch 'skills/prose-lint/SKILL.md')
            "write to $vault\Handoffs\<slug>\handoff-latest.md" |
                Set-Content (Join-Path $ch 'skills/handoff/SKILL.md')
            "home directory maps to project folder $slug" |
                Set-Content (Join-Path $ch 'skills/council/SKILL.md')
            "~/.claude/projects/$slug/memory/MEMORY.md and $vault\Handoffs\handoff-latest.md" |
                Set-Content (Join-Path $ch 'skills/subagent-prompting/SKILL.md')

            # rules/ssh.md and rules/change-management.md are NOT in the table and describe this
            # machine on purpose. Plant one carrying a foldable literal and prove it survives.
            "SSH config is at $ch\..\.ssh\config and the core repo is $core" |
                Set-Content (Join-Path $ch 'rules/ssh.md')

            & $script:export -ClaudeHome $ch -OutputRoot $out -CoreRepo $core `
                -NpmGlobal 'C:/npm' -VaultPath $vault -HomeSlug $slug -SkipSettings -SkipMcp | Out-Null

            (Get-Content (Join-Path $out 'rules/harness-core.md') -Raw) |
                Should -Match '\{\{CORE_REPO\}\}/install/Install-Harness\.ps1'
            (Get-Content (Join-Path $out 'hooks/harness-core-reminder.sh') -Raw) |
                Should -Match '\{\{CORE_REPO\}\}/install/Install-Harness\.ps1'
            (Get-Content (Join-Path $out 'skills/prose-lint/SKILL.md') -Raw) |
                Should -Match '\{\{CLAUDE_HOME\}\}/tools/prose-lint/\.vale\.ini'
            (Get-Content (Join-Path $out 'skills/handoff/SKILL.md') -Raw) |
                Should -Match '\{\{OBSIDIAN_VAULT\}\}/Handoffs/'
            (Get-Content (Join-Path $out 'skills/council/SKILL.md') -Raw) |
                Should -Match '\{\{HOME_SLUG\}\}'
            $sub = Get-Content (Join-Path $out 'skills/subagent-prompting/SKILL.md') -Raw
            $sub | Should -Match '\{\{HOME_SLUG\}\}'
            $sub | Should -Match '\{\{OBSIDIAN_VAULT\}\}/Handoffs/handoff-latest\.md'

            # The allowlist half. ssh.md is outside the table, so both literals stay.
            $ssh = Get-Content (Join-Path $out 'rules/ssh.md') -Raw
            $ssh | Should -Not -Match '\{\{'
            $ssh | Should -Match ([regex]::Escape($core))
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "folds a literal written with either separator spelling" {
        # Install writes forward-slash form, so after an install on the canonical box
        # harness-core.md reads E:/projects/agent-harness-core. A backslash-only fold would
        # leave that literal and break the round trip.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            "backslash E:\projects\agent-harness-core\install and slash E:/projects/agent-harness-core/install" |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:\projects\agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null
            $t = Get-Content (Join-Path $out 'rules/harness-core.md') -Raw
            $t | Should -Not -Match 'agent-harness-core'
            @([regex]::Matches($t, '\{\{CORE_REPO\}\}/install')).Count | Should -Be 2
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "folds a forward-slashed literal against backslashed text" {
        # The case that owns the real export. Get-MainCheckout returns a forward-slashed path,
        # and both live {{CORE_REPO}} source files spell it with backslashes, so this is the
        # exact combination a default `pwsh -NoProfile -File install/Export-Account.ps1` runs.
        # Every other folding test here passes -CoreRepo backslashed and cannot see it: with the
        # pattern built straight from the literal, [regex]::Escape leaves '/' alone, the
        # both-separator substitution has nothing to rewrite, and the fold silently no-ops while
        # the whole suite stays green.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            "Core repo: E:\projects\agent-harness-core\install\Install-Harness.ps1" |
                Set-Content (Join-Path $ch 'rules/harness-core.md')
            "the core at E:\projects\agent-harness-core" |
                Set-Content (Join-Path $ch 'hooks/harness-core-reminder.sh')
            & $script:export -ClaudeHome $ch -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings -SkipMcp | Out-Null

            $t = Get-Content (Join-Path $out 'rules/harness-core.md') -Raw
            $t | Should -Match '\{\{CORE_REPO\}\}/install/Install-Harness\.ps1'
            $t | Should -Not -Match 'agent-harness-core'
            (Get-Content (Join-Path $out 'hooks/harness-core-reminder.sh') -Raw) |
                Should -Not -Match 'agent-harness-core'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "throws when a table row names a file the payload does not carry" {
        # A silent skip here is how a fold quietly stops happening: the file gets renamed
        # upstream, the row goes stale, and the payload ships a machine path with nothing
        # reporting it. The exporter must say so.
        #
        # $AccountTemplatedFiles is [ordered] and rules/harness-core.md is iterated first, so
        # the row removed here has to be that one for the message to name it. Removing a later
        # row would throw about the first absent file rather than the one under test.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            Remove-Item -LiteralPath (Join-Path $ch 'rules/harness-core.md')
            { & $script:export -ClaudeHome $ch -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings -SkipMcp } |
                Should -Throw -ExpectedMessage '*rules/harness-core.md*'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }
```

- [ ] **Step 2: Add -HomeSlug to the exporter's parameter block**

The first test passes `-HomeSlug`. Add it to the `param()` block of `install/Export-Account.ps1`, after `-VaultPath`:

```powershell
    [string]$VaultPath,
    [string]$HomeSlug,
```

Then replace the whole three-line block Task 5 added, verbatim, not just its first line:

```powershell
$homeSlug = Get-ProjectSlug ($HOME)
$folds = @(Get-AccountFoldTable -ClaudeHome $ClaudeHome -NpmGlobal $NpmGlobal `
        -CoreRepo $CoreRepo -VaultPath $VaultPath -HomeSlug $homeSlug)
```

with:

```powershell
if (-not $HomeSlug) { $HomeSlug = Get-ProjectSlug $HOME }
$folds = @(Get-AccountFoldTable -ClaudeHome $ClaudeHome -NpmGlobal $NpmGlobal `
        -CoreRepo $CoreRepo -VaultPath $VaultPath -HomeSlug $HomeSlug)
```

All three lines go. PowerShell variable names are case-insensitive, so `$homeSlug` and the new `$HomeSlug` parameter are one variable: a leftover `$homeSlug = Get-ProjectSlug $HOME` sitting after the new `if` silently overwrites whatever the caller passed, and the first test then fails on a slug mismatch with nothing in the diff to explain it.

- [ ] **Step 3: Run and confirm the four new cases fail**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 1, `Tests Passed: 9, Failed: 4`. The first three fail because the copied files still hold their literals, the fourth because the exporter does not throw.

- [ ] **Step 4: Add the templated-file pass to Export-Account.ps1**

Append after the settings block.

```powershell
# --- model-read folds --------------------------------------------------------
# Executed hooks derive their paths at run time and were fixed at source. These six cannot be:
# a placeholder written into the live file is read literally by the model on this box, so the
# fold happens on the way out and the installer expands it on the way in.
foreach ($rel in $script:AccountTemplatedFiles.Keys) {
    $target = Join-Path $OutputRoot $rel
    if (-not (Test-Path -LiteralPath $target)) {
        # Loud, not skipped. A stale row is how a fold quietly stops happening: the file gets
        # renamed upstream and the payload then ships a machine path with nothing reporting it.
        throw "Templated file '$rel' is named in AccountShared.ps1 but absent from the payload. Update the table or the allowlist."
    }
    $wanted = @($script:AccountTemplatedFiles[$rel])
    $rowFolds = @($folds | Where-Object { $wanted -contains ($_.Token -replace '[{}]', '') })
    $text = Get-Content -LiteralPath $target -Raw
    foreach ($f in $rowFolds) { $text = ConvertTo-TemplatedText -Text $text -Fold $f }
    Set-Content -LiteralPath $target -Value $text -NoNewline
    Write-Host "  ${rel}: folded $(@($rowFolds).Count) token(s)"
}
```

- [ ] **Step 5: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 13, Failed: 0`.

- [ ] **Step 6: Ablate the allowlist**

Change the `$rowFolds` line to `$rowFolds = @($folds)`, so every file gets every token, re-run, and confirm `folds each templated file with only the tokens its table row names` goes red on `$ssh | Should -Not -Match '\{\{'`. Restore and re-run to green. Then change the `throw` to a `Write-Warning` plus `continue`, re-run, and confirm `throws when a table row names a file the payload does not carry` goes red. Restore and re-run to green.

- [ ] **Step 7: Run the other suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

```bash
git add install/AccountShared.ps1 install/Export-Account.ps1 install/Export-Account.Tests.ps1
git commit -m "feat(install): fold machine paths out of the six model-read files

rules/harness-core.md and hooks/harness-core-reminder.sh hardcode this
repo's location; skills/prose-lint names the Vale kit by absolute path;
skills/handoff, skills/council and skills/subagent-prompting carry the
Obsidian vault path and the C--Users-user project slug. On a receiver
/handoff writes to a path that does not exist and nothing says so.

These six take the export-time fold rather than a source fix, because a
placeholder written into the live file is read literally by the model here.
A $HOME-relative form is wrong for prose-lint in particular: Git Bash $HOME
on this box is /c/Users/user/Documents, so that fix would break the skill
the moment the model ran vale through the Bash tool.

The fold table is an allowlist keyed per file. rules/ssh.md and
rules/change-management.md name this machine deliberately and are outside
it. A row naming a file the payload does not carry throws rather than
skipping: a silent skip is how a fold stops happening after an upstream
rename, with nothing reporting the machine path that then ships.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 7: Lift mcpServers out of ~/.claude.json, behind a secret gate

MCP servers are not under `~/.claude/` at all. They live under `mcpServers` in `~/.claude.json`, a file that is otherwise 46 project entries, `userID`, `anonymousId`, statsig caches and onboarding flags, none of which travel. Only `garmin` is portable. `1password` names a Windows Store path with an embedded version and `code-context` a WSL user's home; both ship as-is, because no placeholder can express either one and a placeholder would be pretending. The receiver-side residual report in Task 11 names them.

**Files:**
- Modify: `install/Export-Account.ps1` (append after the model-read fold pass)
- Test: `install/Export-Account.Tests.ps1` (add three `It` blocks)

**Interfaces:**
- Consumes: `$folds` and `ConvertTo-TemplatedCommand` from Task 5; the `-ClaudeJson` parameter from Task 4. Command, not Text: an `mcpServers` command string is a command, and the wrapper applies the whole fold table in one call.
- Produces, from `install/Export-Account.ps1`:
  - `Get-SecretPattern -ScanHookPath [string]` -> `[hashtable[]]`, each with `Name [string]` and `Regex [string]`.
  - `Test-AccountSecret -Text [string] -Patterns [hashtable[]]` -> `[string[]]`, the names of matching patterns, empty when clean.
  - The file `<OutputRoot>/mcp-servers.json`, shaped `{ "mcpServers": { <name>: { type, command, args, env } } }`. Task 11 reads exactly this shape.

- [ ] **Step 1: Write the failing tests**

Add inside the closing brace of `Describe "Export-Account"`.

```powershell
    It "lifts only the mcpServers key out of claude.json" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{
                userID = 'abc123'
                anonymousId = 'def456'
                projects = @{ 'E:\projects\demo' = @{ lastCost = 1.5 } }
                mcpServers = @{
                    garmin = @{ type = 'stdio'; command = 'uvx'
                        args = @('--from', 'git+https://github.com/Taxuspt/garmin_mcp', 'garmin-mcp')
                        env = @{} }
                    '1password' = @{ type = 'stdio'
                        command = 'C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe'
                        args = @(); env = @{} }
                }
            } | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings | Out-Null

            $raw = Get-Content (Join-Path $out 'mcp-servers.json') -Raw
            $m = $raw | ConvertFrom-Json
            $m.mcpServers.garmin.command | Should -Be 'uvx'
            $m.mcpServers.'1password'.command | Should -Match 'onepassword-mcp\.exe$'
            @($m.PSObject.Properties.Name) | Should -Be @('mcpServers')
            # None of the rest of that file may travel: it is 46 project entries and two
            # identifiers, and one of them names the operator.
            $raw | Should -Not -Match 'userID'
            $raw | Should -Not -Match 'anonymousId'
            $raw | Should -Not -Match 'lastCost'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "fails closed when any mcpServers string trips the secret scanner's own patterns" {
        # Server entries reach secrets through 1Password or an environment variable, never
        # inline. Measured against today's live mcpServers: all 15 strings clean, 0 hits.
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ leaky = @{ type = 'stdio'; command = 'x'
                        args = @('--token', 'sk_livetoken0123456789abcdef'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content $cj

            { & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                    -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                    -VaultPath 'C:/vault' -SkipSettings } |
                Should -Throw -ExpectedMessage '*leaky*'
            Test-Path -LiteralPath (Join-Path $out 'mcp-servers.json') |
                Should -BeFalse -Because "a failed gate must leave nothing behind to commit"
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }

    It "folds a server command that sits under the account home" {
        $stand = New-StandInHome
        $out = New-OutputRoot
        try {
            $ch = (Join-Path $stand '.claude')
            $cj = Join-Path $stand '.claude.json'
            @{ mcpServers = @{ local = @{ type = 'stdio'
                        command = 'node'
                        args = @(($ch -replace '/', '\') + '\tools\srv\index.js')
                        env = @{} } } } | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:export -ClaudeHome $ch -ClaudeJson $cj -OutputRoot $out `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' `
                -VaultPath 'C:/vault' -SkipSettings | Out-Null

            $m = Get-Content (Join-Path $out 'mcp-servers.json') -Raw | ConvertFrom-Json
            @($m.mcpServers.local.args)[0] | Should -Be '{{CLAUDE_HOME}}/tools/srv/index.js'
        }
        finally { Remove-Item -Recurse -Force $stand, $out -ErrorAction SilentlyContinue }
    }
```

- [ ] **Step 2: Run and confirm the three new cases fail**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 1, `Tests Passed: 13, Failed: 3`. The first and third fail on `Get-Content` against a `mcp-servers.json` that was never written; the second fails because nothing throws.

- [ ] **Step 3: Add the lift and its gate to Export-Account.ps1**

Append after the model-read fold pass.

```powershell
# --- mcpServers --------------------------------------------------------------
# The pattern table is read out of the live secret scanner rather than copied, so the gate here
# and the gate on every memory write are the same seven patterns. A copy would drift, and the
# drift would be invisible: both sides would still pass their own tests.
#
# Rejected the alternative of piping each string through Scan-MemorySecrets.ps1 as a child
# process. It exercises the control end to end, which is better, but it costs one process spawn
# per string and the hook only reports a boolean verdict, so a failure could not name which
# pattern matched.
function Get-SecretPattern {
    param([string]$ScanHookPath)
    if (-not (Test-Path -LiteralPath $ScanHookPath)) {
        throw "Cannot read the secret pattern table: '$ScanHookPath' is absent."
    }
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $ScanHookPath, [ref]$null, [ref]$null)
    $assign = @($ast.FindAll({ param($n)
                $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                $n.Left.Extent.Text -eq '$patterns' }, $true))
    if ($assign.Count -eq 0) {
        throw "Scan-MemorySecrets.ps1 no longer defines `$patterns."
    }
    return @(& ([scriptblock]::Create($assign[0].Right.Extent.Text)))
}

function Test-AccountSecret {
    param([string]$Text, [hashtable[]]$Patterns)
    $hits = @()
    if (-not $Text) { return $hits }
    foreach ($p in @($Patterns)) {
        if ($Text -match $p.Regex) { $hits += $p.Name }
    }
    return @($hits)
}

if (-not $SkipMcp) {
    if (-not (Test-Path -LiteralPath $ClaudeJson)) {
        Write-Warning "absent, skipping: $ClaudeJson"
    }
    else {
        $claudeJsonObj = Get-Content -LiteralPath $ClaudeJson -Raw | ConvertFrom-Json
        $servers = $claudeJsonObj.mcpServers
        if (-not $servers) {
            Write-Warning "no mcpServers key in $ClaudeJson"
        }
        else {
            $patterns = @(Get-SecretPattern -ScanHookPath (Join-Path $ClaudeHome 'hooks/Scan-MemorySecrets.ps1'))

            # Fold and gate in one pass. The gate throws before anything is written, so a failed
            # export leaves no half-written file for someone to commit.
            foreach ($name in @($servers.PSObject.Properties.Name)) {
                $srv = $servers.$name
                $strings = @($name)
                if ($srv.command) {
                    $srv.command = ConvertTo-TemplatedCommand -Text $srv.command -Folds $folds
                    $strings += $srv.command
                }
                if ($null -ne $srv.args) {
                    $srv.args = @(@($srv.args) | ForEach-Object {
                            ConvertTo-TemplatedCommand -Text $_ -Folds $folds })
                    $strings += @($srv.args)
                }
                if ($srv.env) {
                    foreach ($k in @($srv.env.PSObject.Properties.Name)) {
                        $srv.env.$k = ConvertTo-TemplatedCommand -Text $srv.env.$k -Folds $folds
                        $strings += @($k, $srv.env.$k)
                    }
                }
                foreach ($s in $strings) {
                    $hits = @(Test-AccountSecret -Text $s -Patterns $patterns)
                    if ($hits.Count -gt 0) {
                        throw "Refusing to export mcpServers entry '$name': $($hits -join ', '). Server entries reach secrets through 1Password or an environment variable, never inline."
                    }
                }
            }

            [pscustomobject]@{ mcpServers = $servers } | ConvertTo-Json -Depth 20 |
                Set-Content -LiteralPath (Join-Path $OutputRoot 'mcp-servers.json') -Encoding utf8
            Write-Host "  mcp-servers.json: $(@($servers.PSObject.Properties.Name).Count) server(s)"
        }
    }
}

Write-Host "Export complete. Review with: git status account/claude"
```

- [ ] **Step 4: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 16, Failed: 0`.

- [ ] **Step 5: Ablate the gate**

Comment out the `throw` inside the `foreach ($s in $strings)` loop, re-run, confirm `fails closed when any mcpServers string trips the secret scanner's own patterns` goes red. Restore and re-run to green.

- [ ] **Step 6: Confirm the gate passes against the live mcpServers**

```powershell
pwsh -NoProfile -File install/Export-Account.ps1 -OutputRoot (Join-Path $env:TEMP 'acct-smoke') -WarningAction Continue
```

Expected: no throw, and `mcp-servers.json: 3 server(s)` on stdout. The three are `1password`, `code-context` and `garmin`.

- [ ] **Step 7: Delete the smoke directory**

```powershell
Remove-Item -Recurse -Force (Join-Path $env:TEMP 'acct-smoke')
```

Its own step, because it is the one action in this task that leaves a real artifact behind. A smoke export of the live account layer sitting in `%TEMP%` is a full copy of the operator's rules, agents and skills outside any tree that gets reviewed, and Task 14 writes the payload that actually ships.

- [ ] **Step 8: Run the other suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

```bash
git add install/Export-Account.ps1 install/Export-Account.Tests.ps1
git commit -m "feat(install): lift mcpServers into the payload behind a secret gate

MCP servers live in ~/.claude.json, which is otherwise 46 project entries,
two identifiers and statsig caches. Only the mcpServers key travels.

The gate reads the seven-pattern table out of Scan-MemorySecrets.ps1 through
the AST rather than copying it, so the check that guards every memory write
and the check that guards the payload cannot drift apart. Rejected piping
each string through the hook as a child process: better coverage, but one
spawn per string and a boolean verdict that cannot name the matching
pattern.

It fails closed and throws before writing anything, so a failed export
leaves no half-written file to commit.

1password and code-context ship as-is and do not work anywhere else: no
placeholder can express a Store path with an embedded version or a WSL
user's home, and a placeholder would be pretending. The receiver-side
residual report names them by design.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 8: Install-Account preflight and content copy

The first half of `Install-Account.ps1`: parameters, the prerequisite warnings, the copy over `~/.claude/`, and `model-tier-gate.ts` sourced from core. Every consumer of the account layer fails open when its engine is missing, so without the preflight the kit goes silently dead on a fresh box and looks installed.

**Files:**
- Create: `install/Install-Account.ps1`
- Create: `install/Install-Account.Tests.ps1`

**Interfaces:**
- Consumes: `$script:AccountTreeDirs`, `$script:AccountRootFiles`, `Test-ResidualWindowsPath`, `Convert-HookCommand` from `install/AccountShared.ps1` (Task 4).
- Produces, from `install/Install-Account.ps1`:
  - `Test-Prerequisite -NeedJq [bool]` -> `[string[]]`, names of absent tools. The caller decides whether jq is wanted, so the function takes no platform argument.
  - `Copy-PayloadTree -PayloadRoot [string] -ClaudeHome [string] -Relative [string]` -> `[int]` files copied.
  - The parameter set `-ClaudeHome`, `-ClaudeJson`, `-PayloadRoot`, `-CoreRepo`, `-NpmGlobal`, `-TargetIsWindows`, `-SkipPreflight`, used unchanged by Tasks 9, 10, 11 and 12.
- Produces, from `install/Install-Account.Tests.ps1`, used by Tasks 9, 10, 11 and 12:
  - `New-StandInPayload` -> `[string]`, absolute path of a planted `account/claude`-shaped payload.
  - `New-StandInClaudeHome` -> `[string]`, absolute path of an empty stand-in `.claude` directory.

- [ ] **Step 1: Write the failing tests**

Create `install/Install-Account.Tests.ps1`.

```powershell
# install/Install-Account.Tests.ps1
Describe "Install-Account" {
    BeforeAll {
        $script:install = "$PSScriptRoot/Install-Account.ps1"
        $script:repoRoot = Split-Path $PSScriptRoot -Parent

        # A payload shaped like account/claude, planted rather than exported, so these tests
        # never depend on Task 14 having run and never read the operator's live ~/.claude.
        function New-StandInPayload {
            $p = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-payload-" + [guid]::NewGuid())
            foreach ($d in 'rules', 'agents', 'hooks', 'skills/prose-lint', 'tools/prose-lint') {
                New-Item -ItemType Directory -Path (Join-Path $p $d) -Force | Out-Null
            }
            'rule body'           | Set-Content (Join-Path $p 'rules/security.md')
            'Core repo: {{CORE_REPO}}' | Set-Content (Join-Path $p 'rules/harness-core.md')
            'agent def'           | Set-Content (Join-Path $p 'agents/appsec-sme.md')
            'vale --config "{{CLAUDE_HOME}}/tools/prose-lint/.vale.ini"' |
                Set-Content (Join-Path $p 'skills/prose-lint/SKILL.md')
            'StylesPath = styles' | Set-Content (Join-Path $p 'tools/prose-lint/.vale.ini')
            'exit 0'              | Set-Content (Join-Path $p 'hooks/Scan-MemorySecrets.ps1')
            'the core is at {{CORE_REPO}}' | Set-Content (Join-Path $p 'hooks/harness-core-reminder.sh')
            'ps statusline'       | Set-Content (Join-Path $p 'statusline-command.ps1')
            'sh statusline'       | Set-Content (Join-Path $p 'statusline-command.sh')
            '{"hooks":{}}'        | Set-Content (Join-Path $p 'settings.account.json')
            '{"mcpServers":{}}'   | Set-Content (Join-Path $p 'mcp-servers.json')
            return $p
        }

        function New-StandInClaudeHome {
            $h = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-home-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $h -Force | Out-Null
            return $h
        }
    }

    It "copies the payload tree into the target claude home" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md')          | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'agents/appsec-sme.md')       | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'skills/prose-lint/SKILL.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'tools/prose-lint/.vale.ini') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'hooks/Scan-MemorySecrets.ps1') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'statusline-command.ps1')     | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $h 'statusline-command.sh')      | Should -BeTrue
            # The payload's own files are inputs, not content, and must not land in the target.
            Test-Path -LiteralPath (Join-Path $h 'settings.account.json') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $h 'mcp-servers.json')      | Should -BeFalse
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "installs model-tier-gate.ts from core, byte-identical, though the payload lacks it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            Test-Path -LiteralPath (Join-Path $p 'hooks/model-tier-gate.ts') |
                Should -BeFalse -Because "core owns that file and the exporter skips it"
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') `
                -CoreRepo $script:repoRoot -SkipPreflight | Out-Null
            $installed = Join-Path $h 'hooks/model-tier-gate.ts'
            Test-Path -LiteralPath $installed | Should -BeTrue
            (Get-FileHash $installed -Algorithm SHA256).Hash |
                Should -Be (Get-FileHash (Join-Path $script:repoRoot 'core/claude/hooks/model-tier-gate.ts') -Algorithm SHA256).Hash
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "names every absent prerequisite, and jq only when the Linux fallback needs it" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            # PATH emptied to a directory holding nothing, so every probe misses. Without this
            # the assertion would depend on what happens to be installed on the runner.
            $emptyBin = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-bin-" + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $emptyBin -Force | Out-Null
            $savedPath = $env:PATH
            try {
                $env:PATH = $emptyBin
                $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                    -ClaudeJson (Join-Path $h 'claude.json') `
                    -CoreRepo $script:repoRoot -TargetIsWindows:$false -NpmGlobal '' *>&1 | Out-String
            }
            finally { $env:PATH = $savedPath; Remove-Item -Recurse -Force $emptyBin -EA SilentlyContinue }

            foreach ($tool in 'vale', 'bun', 'node', 'bash', 'uvx', 'jq') {
                $out | Should -Match "\b$tool\b" -Because "every consumer of $tool fails open, so an absent one is invisible without the warning"
            }
            # The install still completes: preflight warns, it does not gate.
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') | Should -BeTrue
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "does not offer jq when npm is present, since the shell statusline is never reached" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo $script:repoRoot `
                -TargetIsWindows:$false -NpmGlobal '/usr/lib/node_modules' *>&1 | Out-String
            $out | Should -Not -Match '\bjq\b'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }
}
```

- [ ] **Step 2: Run and confirm every case fails**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 1, four failures, all on `install/Install-Account.ps1` not existing.

- [ ] **Step 3: Write the first half of install/Install-Account.ps1**

The header notice below is the same Gate 1 split as Task 4. The tracker item Gate 1 also asks for is `docs/backlog.md` item 16, added in Task 4 Step 8, and it already names both scripts: no second entry, and nothing to add here beyond the two header lines.

```powershell
# UNWIRED until Task 13 of docs/superpowers/plans/2026-09-03-account-layer-portability.md adds
# its README and rules/harness-core.md registration. Invoke: pwsh -NoProfile -File install/Install-Account.ps1
<#
.SYNOPSIS
    Installs this repo's account/claude payload onto a workstation's ~/.claude.

.DESCRIPTION
    Runs on any workstation from a clone, on Windows or Linux. Content directories are copied
    over the top of ~/.claude. Four things the copy cannot do on its own are handled here:
    placeholder expansion, the Linux invocation rewrite, a settings merge that does not clobber
    what Claude Code writes into settings.json itself, and a residual-path report.

    The update path is `git pull` then re-run this script. Install overwrites;
    settings.local.json is the per-machine escape hatch. Removal does not propagate to a
    receiver and a receiver's own edit to an installed file is reverted without comment. Both
    follow from having no manifest, and both are intended.

.PARAMETER ClaudeHome
    Where to install. Defaults to $HOME/.claude.

.PARAMETER ClaudeJson
    The file holding mcpServers. Defaults to $HOME/.claude.json.

.PARAMETER PayloadRoot
    Where to install from. Defaults to account/claude under the running clone.

.PARAMETER CoreRepo
    Expands {{CORE_REPO}} and sources model-tier-gate.ts. Defaults to the running clone.

.PARAMETER NpmGlobal
    Expands {{NPM_GLOBAL}}. Defaults to `npm root -g`. Pass an empty string to take the
    npm-absent branch, which drops the two ccstatusline hook entries and points
    statusLine.command at the shipped script for the platform.

.PARAMETER TargetIsWindows
    Which platform the install is being prepared for. Defaults to the platform actually
    running. A real run should never pass it; it exists so the tests can reach the Linux-only
    branches from a Windows host, which is the same seam and the same reason as
    Restore-ClaudeProject.ps1:88-95.

.PARAMETER SkipPreflight
    Skip the prerequisite probe. Test seam.

.EXAMPLE
    pwsh -NoProfile -File install/Install-Account.ps1
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$ClaudeHome,
    [string]$ClaudeJson,
    [string]$PayloadRoot,
    [string]$CoreRepo,
    [string]$NpmGlobal,
    [bool]$TargetIsWindows = $(if ($PSVersionTable.PSVersion.Major -lt 6) { $true } else { $IsWindows }),
    [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AccountShared.ps1')

$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $ClaudeHome)  { $ClaudeHome = Join-Path $HOME '.claude' }
if (-not $ClaudeJson)  { $ClaudeJson = Join-Path $HOME '.claude.json' }
if (-not $PayloadRoot) { $PayloadRoot = Join-Path (Join-Path $repoRoot 'account') 'claude' }
if (-not $CoreRepo)    { $CoreRepo = $repoRoot }

# ContainsKey, not a truthiness check: an explicitly passed empty string means "npm is absent"
# and is how the tests reach that branch, while an omitted parameter means "go look".
# Get-Command first: calling a native command that is not on PATH is a terminating
# CommandNotFoundException, which 2>$null does not swallow, so a clean box without npm would
# take the installer down on line 1 instead of reaching the npm-absent branch this file exists
# to serve.
if (-not $PSBoundParameters.ContainsKey('NpmGlobal')) {
    $NpmGlobal = if (Get-Command npm -ErrorAction SilentlyContinue) {
        $v = (& npm root -g 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0) { $v } else { $null }
    } else { $null }
}
$npmPresent = [bool]$NpmGlobal

if (-not (Test-Path -LiteralPath $PayloadRoot)) {
    throw "No payload at '$PayloadRoot'. Run install/Export-Account.ps1 on the canonical workstation first."
}

Write-Host "Target platform : $(if ($TargetIsWindows) { 'Windows' } else { 'Linux' })"
Write-Host "Payload         : $PayloadRoot"
Write-Host "Claude home     : $ClaudeHome"

# Every consumer of these fails open when the tool is absent, so without this the kit goes
# silently dead on a fresh box and looks installed. jq only matters on Linux when the
# npm-absent branch points statusLine.command at statusline-command.sh, which calls jq three
# times.
function Test-Prerequisite {
    param([bool]$NeedJq)
    $wanted = @('pwsh', 'vale', 'bun', 'node', 'bash', 'uvx')
    if ($NeedJq) { $wanted += 'jq' }
    $missing = @()
    foreach ($t in $wanted) {
        if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { $missing += $t }
    }
    return @($missing)
}

if (-not $SkipPreflight) {
    $needJq = (-not $TargetIsWindows) -and (-not $npmPresent)
    $missing = @(Test-Prerequisite -NeedJq $needJq)
    if ($missing.Count -gt 0) {
        Write-Warning "Not on PATH: $($missing -join ', '). Each one's consumer fails open, so the feature it drives will be silently absent rather than reporting an error."
    }
}

function Copy-PayloadTree {
    param([string]$PayloadRoot, [string]$ClaudeHome, [string]$Relative)
    $from = Join-Path $PayloadRoot $Relative
    $to = Join-Path $ClaudeHome $Relative
    if (-not (Test-Path -LiteralPath $from)) { return 0 }
    $null = New-Item -ItemType Directory -Path $to -Force
    $copied = 0
    foreach ($f in @(Get-ChildItem -LiteralPath $from -Recurse -File -Force)) {
        $rel = ($f.FullName.Substring($from.Length).TrimStart('\', '/')) -replace '\\', '/'
        $dest = Join-Path $to $rel
        $null = New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $copied++
    }
    return $copied
}

$null = New-Item -ItemType Directory -Path $ClaudeHome -Force

foreach ($d in $script:AccountTreeDirs) {
    $n = Copy-PayloadTree -PayloadRoot $PayloadRoot -ClaudeHome $ClaudeHome -Relative $d
    Write-Host "  ${d}: $n files"
}
foreach ($f in $script:AccountRootFiles) {
    $src = Join-Path $PayloadRoot $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $ClaudeHome $f) -Force
    }
}

# Core is authoritative for this one file, so it comes out of core/ in the same clone rather
# than out of the payload. Two copies in one repo would drift the moment either was edited.
$gateSrc = Join-Path $CoreRepo 'core/claude/hooks/model-tier-gate.ts'
if (Test-Path -LiteralPath $gateSrc) {
    $null = New-Item -ItemType Directory -Path (Join-Path $ClaudeHome 'hooks') -Force
    Copy-Item -LiteralPath $gateSrc -Destination (Join-Path $ClaudeHome 'hooks/model-tier-gate.ts') -Force
    Write-Host '  hooks/model-tier-gate.ts: from core'
}
else {
    Write-Warning "Absent: $gateSrc. The model-tier gate will not be installed, and a model-less Agent dispatch will not be blocked."
}

# Same CommandNotFoundException hazard as npm above, and this one fires on the Windows box
# whenever a test drives the Linux branch: `& chmod` with no chmod on PATH is terminating, so
# the round-trip test in Task 12 would die here rather than assert on the installed tree.
$chmod = Get-Command chmod -ErrorAction SilentlyContinue
if (-not $TargetIsWindows -and $chmod) {
    foreach ($s in @(Get-ChildItem (Join-Path $ClaudeHome 'hooks') -Recurse -File -Filter *.sh -ErrorAction SilentlyContinue)) {
        & $chmod.Source +x $s.FullName
    }
}
elseif (-not $TargetIsWindows) {
    Write-Warning 'chmod not on PATH: .sh hooks are not marked executable. Run `chmod +x ~/.claude/hooks/*.sh` on the target.'
}
```

- [ ] **Step 4: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 4, Failed: 0`.

- [ ] **Step 5: Ablate the jq condition**

Change `$needJq = (-not $TargetIsWindows) -and (-not $npmPresent)` to `$needJq = $true`, re-run, and confirm `does not offer jq when npm is present` goes red. Restore and re-run to green.

- [ ] **Step 6: Run the other suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 16, Failed: 0`.

```bash
git add install/Install-Account.ps1 install/Install-Account.Tests.ps1
git commit -m "feat(install): Install-Account preflight and content copy

First half of the receiver-side installer. Copies the payload over
~/.claude, sources model-tier-gate.ts from core rather than from the payload
so the repo holds one copy of it, and warns about every absent prerequisite.

The preflight warns rather than gates. Every consumer here fails open when
its engine is missing, which is the reason for the warning: without it the
Vale kit, the worktree gate and the garmin server are all silently absent on
a fresh box while the install reports success.

jq joins the list only on Linux with npm absent, which is the one path that
points statusLine.command at statusline-command.sh, and that script calls jq
three times.

-NpmGlobal distinguishes an omitted parameter from an explicitly empty one
through PSBoundParameters: omitted means go look, empty means npm is absent.
That is how the tests reach the fallback branch without uninstalling npm.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 9: Placeholder expansion, the Linux rewrite, and the npm-absent branch

Three things the copy cannot do on its own. The five tokens expand from the receiver's own environment. On a non-Windows target every hook entry of the form `& 'x.ps1'` becomes `pwsh -NoProfile -File 'x.ps1'` with the `shell` key removed, because the command string otherwise goes to `/bin/sh` and never runs. And if `npm` is absent the installer drops the two ccstatusline entries and points `statusLine.command` at the shipped script for the platform, rather than writing a command that cannot run.

`Convert-HookCommand` does the expansion and the invocation rewrite in one pass when called with `$OldHome` set to `{{CLAUDE_HOME}}`. Measured: `Convert-HookCommand "& '{{CLAUDE_HOME}}/hooks/Scan.ps1'" '{{CLAUDE_HOME}}' '/home/u/.claude' $false` returns `pwsh -NoProfile -File '/home/u/.claude/hooks/Scan.ps1'`, and the same call with `$true` and a forward-slashed new home returns `& 'C:/Users/me/.claude/hooks/Scan.ps1'`. It never touches the `shell` key, so that removal is new code here.

**Files:**
- Modify: `install/Install-Account.ps1` (two new parameters, then append after the chmod block)
- Test: `install/Install-Account.Tests.ps1` (add five `It` blocks)

**Interfaces:**
- Consumes: `Convert-HookCommand` and `$script:AccountTemplatedFiles` from `install/AccountShared.ps1`; `Get-ProjectSlug` for the `-HomeSlug` default.
- Produces, from `install/Install-Account.ps1`:
  - Two new script parameters, `[string]$VaultPath` and `[string]$HomeSlug`, both optional. `-VaultPath` defaults to `$env:CLAUDE_OBSIDIAN_VAULT` and then to `$HOME/Documents/Obsidian Vault/Claude Code`; `-HomeSlug` defaults to `Get-ProjectSlug $HOME`. Task 12 passes both.
  - `Get-AccountTokenMap -ClaudeHome [string] -NpmGlobal [string] -CoreRepo [string] -VaultPath [string] -HomeSlug [string]` -> `[hashtable]`, token text -> forward-slashed value.
  - `Expand-AccountToken -Text [string] -Tokens [hashtable]` -> `[string]`.
  - `Convert-SettingsForTarget -Settings [pscustomobject] -ClaudeHome [string] -Tokens [hashtable] -TargetIsWindows [bool] -NpmPresent [bool]` -> `[pscustomobject]`.
  - `<ClaudeHome>/settings.json`, written by overwrite in this task. Task 10 replaces the write with a merge; nothing else about the object changes.

- [ ] **Step 1: Write the failing tests**

Add inside the closing brace of `Describe "Install-Account"`.

```powershell
    It "expands all five tokens in the files that carry them" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            foreach ($d in 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $p $d) -Force | Out-Null
            }
            'write to {{OBSIDIAN_VAULT}}/Handoffs/<slug>/handoff-latest.md' |
                Set-Content (Join-Path $p 'skills/handoff/SKILL.md')
            'home maps to {{HOME_SLUG}}' | Set-Content (Join-Path $p 'skills/council/SKILL.md')
            '~/.claude/projects/{{HOME_SLUG}}/memory and {{OBSIDIAN_VAULT}}/Handoffs' |
                Set-Content (Join-Path $p 'skills/subagent-prompting/SKILL.md')
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Skill'; hooks = @(
                                @{ type = 'command'
                                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal 'C:/npm/node_modules' -SkipPreflight | Out-Null

            $expectedHome = $h -replace '\\', '/'
            $expectedSlug = $HOME.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'
            (Get-Content (Join-Path $h 'rules/harness-core.md') -Raw) |
                Should -Match ([regex]::Escape('E:/projects/agent-harness-core'))
            (Get-Content (Join-Path $h 'hooks/harness-core-reminder.sh') -Raw) |
                Should -Match ([regex]::Escape('E:/projects/agent-harness-core'))
            (Get-Content (Join-Path $h 'skills/prose-lint/SKILL.md') -Raw) |
                Should -Match ([regex]::Escape("$expectedHome/tools/prose-lint/.vale.ini"))
            (Get-Content (Join-Path $h 'skills/council/SKILL.md') -Raw) |
                Should -Match ([regex]::Escape($expectedSlug))
            $sub = Get-Content (Join-Path $h 'skills/subagent-prompting/SKILL.md') -Raw
            $sub | Should -Match ([regex]::Escape($expectedSlug))
            $sub | Should -Not -Match '\{\{'

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            @($s.hooks.PreToolUse)[0].hooks[0].command |
                Should -Be 'node C:/npm/node_modules/ccstatusline/dist/ccstatusline.js --hook'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "rewrites a PowerShell hook entry for Linux and removes its shell key" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'; ENABLE_TOOL_SEARCH = 'auto:5' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'
                                    command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell'; timeout = 5 }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal '/usr/lib/node_modules' -TargetIsWindows:$false -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $hook = @(@($s.hooks.PreToolUse)[0].hooks)[0]
            $hook.command | Should -Be "pwsh -NoProfile -File '$($h -replace '\\', '/')/hooks/Scan-MemorySecrets.ps1'"
            # Without the removal the command string still goes to a PowerShell host and the
            # pwsh rewrite is pointless.
            $hook.PSObject.Properties.Name | Should -Not -Contain 'shell'
            $s.env.PSObject.Properties.Name | Should -Not -Contain 'CLAUDE_CODE_USE_POWERSHELL_TOOL'
            $s.env.ENABLE_TOOL_SEARCH | Should -Be 'auto:5'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "leaves the invocation form, the shell key and the env var alone on Windows" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'
                                    command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal 'C:/npm' -TargetIsWindows:$true -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $hook = @(@($s.hooks.PreToolUse)[0].hooks)[0]
            $hook.command | Should -Be "& '$($h -replace '\\', '/')/hooks/Scan-MemorySecrets.ps1'"
            $hook.shell | Should -Be 'powershell'
            $s.env.CLAUDE_CODE_USE_POWERSHELL_TOOL | Should -Be '1'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "drops the ccstatusline entries and repoints statusLine when npm is absent" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                hooks = @{
                    PreToolUse = @( @{ matcher = 'Skill'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Guard-SkillSize.ps1'"
                                    shell = 'powershell' }
                                @{ type = 'command'
                                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook' }) })
                    UserPromptSubmit = @( @{ hooks = @(
                                @{ type = 'command'
                                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js --hook' }) })
                }
                statusLine = @{ type = 'command'
                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js'; padding = 0 }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal '' -TargetIsWindows:$true -SkipPreflight *>&1 | Out-String

            $raw = Get-Content (Join-Path $h 'settings.json') -Raw
            $raw | Should -Not -Match 'ccstatusline'
            $raw | Should -Not -Match '\{\{NPM_GLOBAL\}\}'
            $s = $raw | ConvertFrom-Json
            $s.statusLine.command | Should -Be "pwsh -NoProfile -File '$($h -replace '\\', '/')/statusline-command.ps1'"
            # The Guard-SkillSize entry in the same matcher group must survive: the branch drops
            # two commands, not a whole group.
            @(@($s.hooks.PreToolUse)[0].hooks).Count | Should -Be 1
            # A UserPromptSubmit group left with no hooks must go, not serialise as an empty
            # array Claude Code then has to skip.
            $s.hooks.PSObject.Properties.Name | Should -Not -Contain 'UserPromptSubmit'
            $out | Should -Match 'npm'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "points the statusline fallback at the shell script on Linux" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ hooks = @{}; statusLine = @{ type = 'command'
                    command = 'node {{NPM_GLOBAL}}/ccstatusline/dist/ccstatusline.js' } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')
            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal '' -TargetIsWindows:$false -SkipPreflight | Out-Null
            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.statusLine.command | Should -Be "bash '$($h -replace '\\', '/')/statusline-command.sh'"
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }
```

- [ ] **Step 2: Run and confirm the five new cases fail**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 1, `Tests Passed: 4, Failed: 5`. All five fail on `Get-Content` against a `settings.json` that was never written, or on a `{{TOKEN}}` still present in a copied file.

- [ ] **Step 3: Add expansion and the platform rewrite to Install-Account.ps1**

Two new parameters first. In the `param()` block written in Task 8, after `[string]$NpmGlobal,`, add:

```powershell
    [string]$VaultPath,
    [string]$HomeSlug,
```

and add the matching comment-based help entries after the `.PARAMETER NpmGlobal` block:

```
.PARAMETER VaultPath
    Expands {{OBSIDIAN_VAULT}}. Defaults to $env:CLAUDE_OBSIDIAN_VAULT, then to
    $HOME/Documents/Obsidian Vault/Claude Code.

.PARAMETER HomeSlug
    Expands {{HOME_SLUG}}. Defaults to Get-ProjectSlug $HOME. Test seam: a child pwsh takes
    $HOME from USERPROFILE, not from $env:HOME, so a test cannot steer the default from outside.
```

Then append the rest after the chmod block.

```powershell
# --- token expansion ---------------------------------------------------------
# Every value is forward-slashed. PowerShell on Windows accepts & 'C:/...' and Linux accepts
# nothing else, so one spelling covers both platforms and the export folds it back cleanly.
function Get-AccountTokenMap {
    param(
        [string]$ClaudeHome,
        [string]$NpmGlobal,
        [string]$CoreRepo,
        [string]$VaultPath,
        [string]$HomeSlug
    )
    return @{
        '{{CLAUDE_HOME}}'    = ($ClaudeHome -replace '\\', '/')
        '{{NPM_GLOBAL}}'     = ($NpmGlobal  -replace '\\', '/')
        '{{CORE_REPO}}'      = ($CoreRepo   -replace '\\', '/')
        '{{OBSIDIAN_VAULT}}' = ($VaultPath  -replace '\\', '/')
        '{{HOME_SLUG}}'      = $HomeSlug
    }
}

function Expand-AccountToken {
    param([string]$Text, [hashtable]$Tokens)
    if (-not $Text) { return $Text }
    $out = $Text
    foreach ($k in @($Tokens.Keys)) { $out = $out.Replace($k, [string]$Tokens[$k]) }
    return $out
}

# Parameters, not locals. A test drives this script as a child process with a stand-in $HOME
# that the child does not inherit, so an internally derived vault path and slug would expand to
# the runner's real values and the round trip in Task 12 could not assert on either.
if (-not $VaultPath) {
    $VaultPath = if ($env:CLAUDE_OBSIDIAN_VAULT) { $env:CLAUDE_OBSIDIAN_VAULT }
    else { Join-Path (Join-Path (Join-Path $HOME 'Documents') 'Obsidian Vault') 'Claude Code' }
}
if (-not $HomeSlug) { $HomeSlug = Get-ProjectSlug $HOME }

$tokens = Get-AccountTokenMap -ClaudeHome $ClaudeHome -NpmGlobal $NpmGlobal `
    -CoreRepo $CoreRepo -VaultPath $VaultPath -HomeSlug $HomeSlug

foreach ($rel in $script:AccountTemplatedFiles.Keys) {
    $target = Join-Path $ClaudeHome $rel
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $text = Get-Content -LiteralPath $target -Raw
    Set-Content -LiteralPath $target -Value (Expand-AccountToken -Text $text -Tokens $tokens) -NoNewline
}

# --- settings ----------------------------------------------------------------
# Convert-HookCommand does the {{CLAUDE_HOME}} expansion and, on Linux only, the
# "& '...ps1'" to "pwsh -NoProfile -File" rewrite in one pass. It never touches the shell key,
# so that removal is new code below. {{NPM_GLOBAL}} is not under {{CLAUDE_HOME}} and is left
# alone by that function, so it takes the plain token replace.
function Convert-SettingsForTarget {
    param(
        [pscustomobject]$Settings,
        [string]$ClaudeHome,
        [hashtable]$Tokens,
        [bool]$TargetIsWindows,
        [bool]$NpmPresent
    )
    $homeSlashed = $ClaudeHome -replace '\\', '/'

    foreach ($event in @($Settings.hooks.PSObject.Properties.Name)) {
        $keptGroups = New-Object System.Collections.Generic.List[pscustomobject]
        foreach ($group in @($Settings.hooks.$event)) {
            # Wrap the pipeline OUTPUT: a single surviving hook unwraps to a bare scalar and
            # would serialise "hooks": {...} instead of "hooks": [...]
            # (install/Install-Harness.ps1:822-826).
            $kept = @(@($group.hooks) | Where-Object {
                    $NpmPresent -or ($_.command -notmatch 'ccstatusline')
                })
            if ($kept.Count -eq 0) { continue }
            foreach ($hook in $kept) {
                $hook.command = Convert-HookCommand $hook.command '{{CLAUDE_HOME}}' $homeSlashed $TargetIsWindows
                $hook.command = Expand-AccountToken -Text $hook.command -Tokens $Tokens
                if (-not $TargetIsWindows -and $hook.PSObject.Properties['shell']) {
                    # On Linux the command string goes to /bin/sh. Leaving the key would send
                    # the rewritten pwsh command back to a PowerShell host that is not there.
                    $hook.PSObject.Properties.Remove('shell')
                }
            }
            $group.hooks = $kept
            $keptGroups.Add($group)
        }
        if ($keptGroups.Count -eq 0) { $Settings.hooks.PSObject.Properties.Remove($event) }
        else { $Settings.hooks.$event = $keptGroups.ToArray() }
    }

    if ($Settings.statusLine.command) {
        if ($NpmPresent) {
            $Settings.statusLine.command =
                Expand-AccountToken -Text $Settings.statusLine.command -Tokens $Tokens
        }
        else {
            # Point at a script that exists rather than write a command that cannot run.
            # Whether these two scripts still work is untested: nothing has invoked them since
            # ccstatusline took over, and this branch is the first thing that will.
            $Settings.statusLine.command = if ($TargetIsWindows) {
                "pwsh -NoProfile -File '$homeSlashed/statusline-command.ps1'"
            }
            else {
                "bash '$homeSlashed/statusline-command.sh'"
            }
        }
    }

    if (-not $TargetIsWindows -and $Settings.env -and
        $Settings.env.PSObject.Properties['CLAUDE_CODE_USE_POWERSHELL_TOOL']) {
        $Settings.env.PSObject.Properties.Remove('CLAUDE_CODE_USE_POWERSHELL_TOOL')
    }

    return $Settings
}

$settingsSrc = Join-Path $PayloadRoot 'settings.account.json'
if (Test-Path -LiteralPath $settingsSrc) {
    if (-not $npmPresent) {
        Write-Warning 'npm is absent: dropping the two ccstatusline hook entries and pointing statusLine.command at the shipped statusline script for this platform.'
    }
    $payloadSettings = Get-Content -LiteralPath $settingsSrc -Raw | ConvertFrom-Json
    $payloadSettings = Convert-SettingsForTarget -Settings $payloadSettings `
        -ClaudeHome $ClaudeHome -Tokens $tokens `
        -TargetIsWindows $TargetIsWindows -NpmPresent $npmPresent

    # Overwrite for now. Task 10 replaces this with a merge against whatever the receiver's
    # Claude Code has written into the same file.
    $payloadSettings | ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath (Join-Path $ClaudeHome 'settings.json') -Encoding utf8
    Write-Host '  settings.json: written'
}
```

- [ ] **Step 4: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 9, Failed: 0`.

- [ ] **Step 5: Ablate the shell-key removal and the group pruning**

Comment out the `$hook.PSObject.Properties.Remove('shell')` line, re-run, confirm `rewrites a PowerShell hook entry for Linux and removes its shell key` goes red. Restore. Then change `if ($kept.Count -eq 0) { continue }` to `if ($false) { continue }`, re-run, confirm `drops the ccstatusline entries` goes red on the `UserPromptSubmit` assertion. Restore and re-run to green.

- [ ] **Step 6: Run the other suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

```bash
git add install/Install-Account.ps1 install/Install-Account.Tests.ps1
git commit -m "feat(install): expand placeholders and adapt settings to the target

Three things the copy cannot do. The five tokens expand from the receiver's
own environment, all in forward-slash form: PowerShell on Windows accepts
& 'C:/...' and Linux accepts nothing else, so one spelling covers both and
the exporter folds it back cleanly.

The Linux rewrite reuses Convert-HookCommand whole, with OldHome set to
{{CLAUDE_HOME}}, which expands the token and rewrites & 'x.ps1' to
pwsh -NoProfile -File in one pass. It never touches the shell key, so that
removal is new here: leaving it would send the rewritten command back to a
PowerShell host that is not on the box.

With npm absent the branch drops the two ccstatusline entries and points
statusLine.command at the shipped script for the platform. A matcher group
left with no hooks is removed rather than serialised empty, and a sibling
hook in the same group survives. Whether those two statusline scripts still
run on a receiver is untested; nothing has invoked them since ccstatusline
took over and this branch is the first thing that will.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 10: Merge settings.json instead of replacing it

Claude Code writes `settings.json` itself. `/plugin` flips `enabledPlugins`, and `effortLevel`, `alwaysThinkingEnabled` and `teammateMode` change from the UI. An overwrite would revert every one of those on the receiver each time the operator pulled, so the payload is deep-merged into whatever is already there. `Install-Harness.ps1`'s merge at lines 808-866 keys a hook's identity on the command string alone and knows nothing about matchers or events, so it is not reusable here.

**Files:**
- Modify: `install/Install-Account.ps1` (replace the overwrite added at the end of Task 9)
- Test: `install/Install-Account.Tests.ps1` (add three `It` blocks)

**Interfaces:**
- Consumes: `Convert-SettingsForTarget` from Task 9.
- Produces, from `install/Install-Account.ps1`:
  - `Merge-AccountSettings -Payload [pscustomobject] -Existing [pscustomobject]` -> `[pscustomobject]`.
  - `Merge-HookEvent -PayloadGroups [object[]] -ExistingGroups [object[]]` -> `[object[]]`.

- [ ] **Step 1: Write the failing tests**

Add inside the closing brace of `Describe "Install-Account"`.

```powershell
    It "keeps receiver-only settings keys the payload does not carry" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{
                enabledPlugins = @{ 'superpowers@claude-plugins-official' = $true }
                effortLevel = 'xhigh'
                teammateMode = 'auto'
                permissions = @{ allow = @('Bash(ls:*)') }
                hooks = @{ SessionStart = @( @{ hooks = @(
                                @{ type = 'command'; command = 'echo receiver-only' }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $h 'settings.json')

            @{
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal 'C:/npm' -TargetIsWindows:$true -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            # An overwrite would revert every one of these on the receiver on every pull.
            $s.enabledPlugins.'superpowers@claude-plugins-official' | Should -BeTrue
            $s.effortLevel | Should -Be 'xhigh'
            $s.teammateMode | Should -Be 'auto'
            # permissions.allow is an ordered set union, receiver entries first.
            @($s.permissions.allow) | Should -Be @('Bash(ls:*)', 'mcp__code-context')
            $s.permissions.defaultMode | Should -Be 'auto'
            # A receiver-only hook event survives untouched beside the payload's.
            @(@($s.hooks.SessionStart)[0].hooks)[0].command | Should -Be 'echo receiver-only'
            @(@($s.hooks.PreToolUse)[0].hooks)[0].command | Should -Match 'Scan-MemorySecrets\.ps1'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "is idempotent: a second install adds no duplicate hook entry" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')
            $args = @{
                PayloadRoot = $p; ClaudeHome = $h; ClaudeJson = (Join-Path $h 'claude.json')
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
                TargetIsWindows = $true
            }
            & $script:install @args -SkipPreflight | Out-Null
            & $script:install @args -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $cmds = @()
            foreach ($g in @($s.hooks.PreToolUse)) { foreach ($x in @($g.hooks)) { $cmds += $x.command } }
            @($cmds | Where-Object { $_ -match 'Scan-MemorySecrets' }).Count | Should -Be 1
            @($s.hooks.PreToolUse).Count | Should -Be 1
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "replaces statusLine whole and lets the payload win a shared scalar" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            @{ statusLine = @{ type = 'command'; command = 'old'; padding = 4; refreshInterval = 99 }
                effortLevel = 'low' } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $h 'settings.json')
            @{ hooks = @{}; statusLine = @{ type = 'command'; command = 'node {{NPM_GLOBAL}}/x.js'; padding = 0 }
                effortLevel = 'xhigh' } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h `
                -ClaudeJson (Join-Path $h 'claude.json') -CoreRepo 'E:/projects/agent-harness-core' `
                -NpmGlobal 'C:/npm' -TargetIsWindows:$true -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $h 'settings.json') -Raw | ConvertFrom-Json
            $s.statusLine.command | Should -Be 'node C:/npm/x.js'
            $s.statusLine.padding | Should -Be 0
            # Whole replacement, not a deep merge: a stale refreshInterval from the receiver's
            # previous statusline would silently apply to the new one.
            $s.statusLine.PSObject.Properties.Name | Should -Not -Contain 'refreshInterval'
            $s.effortLevel | Should -Be 'xhigh'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }
```

- [ ] **Step 2: Run and confirm the three new cases fail**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 1, `Tests Passed: 9, Failed: 3`. The first fails on `$s.effortLevel` being `$null` and the receiver-only `SessionStart` event being gone, since Task 9's write is a plain overwrite. The second passes accidentally today and must be re-checked after Step 3; the third fails on `refreshInterval` still absent for the wrong reason. Note which of the three are genuinely red before writing the merge.

- [ ] **Step 3: Add the merge and swap it in for the overwrite**

Insert before the `$settingsSrc` block in `install/Install-Account.ps1`.

```powershell
# A hook entry's identity is its event, its matcher and its expanded command. A present entry
# is replaced in place, a missing one is appended, and a receiver-only one is left alone.
# Install-Harness.ps1's merge keys on the command string alone (L808-866), which cannot tell
# the same script wired under two matchers apart, so it is not reusable here.
function Merge-HookEvent {
    param([object[]]$PayloadGroups, [object[]]$ExistingGroups)
    $result = New-Object System.Collections.Generic.List[pscustomobject]
    foreach ($g in @($ExistingGroups)) { $result.Add($g) }

    foreach ($pg in @($PayloadGroups)) {
        $pMatcher = if ($pg.PSObject.Properties['matcher']) { $pg.matcher } else { $null }
        $target = $null
        foreach ($eg in $result) {
            $eMatcher = if ($eg.PSObject.Properties['matcher']) { $eg.matcher } else { $null }
            if ($eMatcher -eq $pMatcher) { $target = $eg; break }
        }
        if (-not $target) { $result.Add($pg); continue }

        $merged = New-Object System.Collections.Generic.List[pscustomobject]
        foreach ($h in @($target.hooks)) { $merged.Add($h) }
        foreach ($ph in @($pg.hooks)) {
            $idx = -1
            for ($i = 0; $i -lt $merged.Count; $i++) {
                if ($merged[$i].command -eq $ph.command) { $idx = $i; break }
            }
            if ($idx -ge 0) { $merged[$idx] = $ph } else { $merged.Add($ph) }
        }
        $target.hooks = $merged.ToArray()
    }
    return $result.ToArray()
}

function Merge-AccountSettings {
    param([pscustomobject]$Payload, [pscustomobject]$Existing)
    if (-not $Existing) { return $Payload }

    foreach ($prop in @($Payload.PSObject.Properties)) {
        $name = $prop.Name
        $pv = $prop.Value

        if (-not $Existing.PSObject.Properties[$name]) {
            $Existing | Add-Member -NotePropertyName $name -NotePropertyValue $pv -Force
            continue
        }
        $ev = $Existing.$name

        if ($name -eq 'statusLine') {
            # Replaced whole. A deep merge would leave a stale refreshInterval or padding from
            # whatever statusline the receiver had before.
            $Existing.$name = $pv
        }
        elseif ($name -eq 'hooks') {
            foreach ($event in @($pv.PSObject.Properties.Name)) {
                $existingGroups = if ($ev.PSObject.Properties[$event]) { @($ev.$event) } else { @() }
                $mergedEvent = @(Merge-HookEvent -PayloadGroups @($pv.$event) -ExistingGroups $existingGroups)
                if ($ev.PSObject.Properties[$event]) { $ev.$event = $mergedEvent }
                else { $ev | Add-Member -NotePropertyName $event -NotePropertyValue $mergedEvent -Force }
            }
        }
        elseif ($name -eq 'permissions') {
            foreach ($sub in @($pv.PSObject.Properties.Name)) {
                if ($sub -eq 'allow') {
                    # Ordered set union, receiver entries first, so a receiver's own grants keep
                    # their position and the payload's are appended once.
                    $union = New-Object System.Collections.Generic.List[string]
                    foreach ($a in @($ev.allow)) { if (-not $union.Contains($a)) { $union.Add($a) } }
                    foreach ($a in @($pv.allow)) { if (-not $union.Contains($a)) { $union.Add($a) } }
                    if ($ev.PSObject.Properties['allow']) { $ev.allow = $union.ToArray() }
                    else { $ev | Add-Member -NotePropertyName allow -NotePropertyValue $union.ToArray() -Force }
                }
                else {
                    $ev | Add-Member -NotePropertyName $sub -NotePropertyValue $pv.$sub -Force
                }
            }
        }
        elseif ($pv -is [pscustomobject] -and $ev -is [pscustomobject]) {
            # env, enabledPlugins, extraKnownMarketplaces, skillOverrides: payload wins on a
            # shared key, receiver-only keys are kept.
            $Existing.$name = Merge-AccountSettings -Payload $pv -Existing $ev
        }
        else {
            $Existing.$name = $pv
        }
    }
    return $Existing
}
```

Then replace the overwrite at the end of the `$settingsSrc` block:

```powershell
    $liveSettings = Join-Path $ClaudeHome 'settings.json'
    $existing = if (Test-Path -LiteralPath $liveSettings) {
        Get-Content -LiteralPath $liveSettings -Raw | ConvertFrom-Json
    }
    else { $null }
    $merged = Merge-AccountSettings -Payload $payloadSettings -Existing $existing
    $merged | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $liveSettings -Encoding utf8
    Write-Host '  settings.json: merged'
```

- [ ] **Step 4: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 12, Failed: 0`.

- [ ] **Step 5: Ablate the merge**

Replace `$merged = Merge-AccountSettings ...` with `$merged = $payloadSettings`, re-run, and confirm `keeps receiver-only settings keys the payload does not carry` goes red on `$s.effortLevel`. Then restore that and change the hook identity in `Merge-HookEvent` from the matcher-and-command pair to command alone by deleting the `if ($eMatcher -eq $pMatcher)` guard so every group matches the first, re-run, and confirm `is idempotent` goes red on the group count. Restore both and re-run to green.

- [ ] **Step 6: Run the other suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

```bash
git add install/Install-Account.ps1 install/Install-Account.Tests.ps1
git commit -m "feat(install): deep-merge settings.json rather than replacing it

Claude Code writes settings.json itself: /plugin flips enabledPlugins, and
effortLevel, alwaysThinkingEnabled and teammateMode change from the UI. An
overwrite would revert every one of those on the receiver each time the
operator pulled, which turns the update path into a regression.

A hook entry's identity is its event, its matcher and its expanded command,
so a present entry is replaced in place, a missing one appended, and a
receiver-only one left alone. Rejected reusing Install-Harness.ps1's merge:
it keys on the command string alone and cannot tell the same script wired
under two matchers apart.

permissions.allow is an ordered set union with receiver entries first.
statusLine is replaced whole rather than deep-merged, or a stale
refreshInterval from the receiver's previous statusline would silently apply
to the new one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 11: mcpServers add-if-missing, and the residual report

`mcpServers` is the one key where the receiver wins. `1password` and `code-context` ship as-is and do not work anywhere else, so a receiver hand-fixes those two entries in `~/.claude.json`. Payload-wins would revert the fix on the next pull, and `settings.local.json` cannot reach `~/.claude.json` to hold it. Nothing else in that file is touched.

The residual report closes the loop. Its acceptance criterion comes from the design: it names `1password` and `code-context`, and anything else it names is an exporter bug. The design also prescribes `Test-ResidualWindowsPath` as the rule, and that rule cannot meet the criterion in either direction. On a Windows receiver every correctly expanded command carries a drive letter, so it names all of them. And it never fires on `code-context`, whose `wsl -e /home/prior/code-context-mcp.sh` has no drive letter and no `USERPROFILE`. The rule below is "carries an absolute path that does not exist here", which does meet the criterion, and `Test-ResidualWindowsPath` stays as the classifier on the printed line.

**Files:**
- Modify: `install/Install-Account.ps1` (append after the settings merge)
- Test: `install/Install-Account.Tests.ps1` (add four `It` blocks)

**Interfaces:**
- Consumes: `Test-ResidualWindowsPath` from `install/AccountShared.ps1`; `Expand-AccountToken` and `$tokens` from Task 9; the `mcp-servers.json` shape from Task 7.
- Produces, from `install/Install-Account.ps1`:
  - `Expand-McpServer -Servers [pscustomobject] -Tokens [hashtable]` -> `[pscustomobject]`, the same object with every `command`, `args` element and `env` value expanded. Runs over every server, before the merge.
  - `Merge-McpServer -PayloadServers [pscustomobject] -ClaudeJsonPath [string]` -> `[string[]]`, the names actually added. Takes no token map: expansion is `Expand-McpServer`'s job and has already happened by the time this is called.
  - `Get-UnresolvedPath -Text [string]` -> `[string[]]`, the absolute paths in that string that do not exist on this machine.
  - `Get-ResidualCommand -Settings [pscustomobject] -Servers [pscustomobject]` -> `[pscustomobject[]]`, each with `Where [string]`, `Command [string]`, `Dead [string]` and `Shape [string]`. Both arguments are read back from the installed files, `<ClaudeHome>/settings.json` and `$ClaudeJson`, never from the payload.

- [ ] **Step 1: Write the failing tests**

Add inside the closing brace of `Describe "Install-Account"`.

```powershell
    It "adds missing mcpServers entries and touches nothing else in claude.json" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{
                userID = 'abc123'
                projects = @{ '/home/u/demo' = @{ lastCost = 2.5 } }
                mcpServers = @{ existing = @{ type = 'stdio'; command = 'keep-me'; args = @() } }
            } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{
                    garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')

            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight | Out-Null

            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $j.mcpServers.garmin.command   | Should -Be 'uvx'
            $j.mcpServers.existing.command | Should -Be 'keep-me'
            $j.userID | Should -Be 'abc123'
            $j.projects.'/home/u/demo'.lastCost | Should -Be 2.5
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "leaves a hand-fixed entry alone across a second install" {
        # The loop this prevents: the receiver hand-fixes 1password in claude.json because the
        # shipped Store path with its embedded version does not exist there, the next pull
        # reverts it, and settings.local.json cannot reach that file to hold the fix.
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{ '1password' = @{ type = 'stdio'
                        command = 'C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe'
                        args = @(); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
            $args = @{
                PayloadRoot = $p; ClaudeHome = $h; ClaudeJson = $cj
                CoreRepo = 'E:/projects/agent-harness-core'; NpmGlobal = 'C:/npm'
            }
            & $script:install @args -SkipPreflight | Out-Null

            $j = Get-Content $cj -Raw | ConvertFrom-Json
            $j.mcpServers.'1password'.command = '/usr/local/bin/op-mcp'
            $j | ConvertTo-Json -Depth 20 | Set-Content $cj

            & $script:install @args -SkipPreflight | Out-Null
            $j2 = Get-Content $cj -Raw | ConvertFrom-Json
            $j2.mcpServers.'1password'.command | Should -Be '/usr/local/bin/op-mcp'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "names both non-portable servers, and nothing that resolves on this machine" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{
                    '1password' = @{ type = 'stdio'
                        command = 'C:\Program Files\WindowsApps\Agilebits.1Password_8.12.26.40_x64__amwd9z03whsfe\onepassword-mcp.exe'
                        args = @(); env = @{} }
                    'code-context' = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', '/home/prior/code-context-mcp.sh'); env = @{} }
                    garmin = @{ type = 'stdio'; command = 'uvx'; args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
            @{ hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '{{CLAUDE_HOME}}/hooks/Scan-MemorySecrets.ps1'"
                                    shell = 'powershell' }) }) } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'settings.account.json')

            $out = & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal '/usr/lib/node_modules' `
                -TargetIsWindows:$false -SkipPreflight *>&1 | Out-String

            # Scope every assertion to the report block. The "N added (names)" line above it
            # legitimately names all three servers, so a whole-output match would pass for the
            # wrong reason and a whole-output negative would fail for the wrong reason.
            $parts = @($out -split 'Still carrying a source-machine path')
            $parts.Count | Should -Be 2 -Because "the report must have printed at all"
            $report = $parts[1]

            $report | Should -Match '1password'
            # code-context is the case Test-ResidualWindowsPath alone cannot see: `wsl -e
            # /home/prior/code-context-mcp.sh` carries no drive letter and no USERPROFILE, so a
            # drive-letter rule would report one of the two entries this exists to name.
            $report | Should -Match 'code-context'
            $report | Should -Not -Match 'garmin'
            # The expanded hook command points at a file that is really there, so it must not
            # be reported. On a Windows receiver every correctly expanded command carries a
            # drive letter, and a report that names all of them is no report at all.
            $report | Should -Not -Match 'Scan-MemorySecrets'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }

    It "completes the install even with residuals outstanding" {
        $p = New-StandInPayload; $h = New-StandInClaudeHome
        try {
            $cj = Join-Path $h 'claude.json'
            @{ mcpServers = @{} } | ConvertTo-Json -Depth 20 | Set-Content $cj
            @{ mcpServers = @{ wsl = @{ type = 'stdio'; command = 'wsl'
                        args = @('-e', 'C:\Users\user\x.sh'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $p 'mcp-servers.json')
            & $script:install -PayloadRoot $p -ClaudeHome $h -ClaudeJson $cj `
                -CoreRepo 'E:/projects/agent-harness-core' -NpmGlobal 'C:/npm' -SkipPreflight | Out-Null
            Test-Path -LiteralPath (Join-Path $h 'rules/security.md') | Should -BeTrue
            (Get-Content $cj -Raw | ConvertFrom-Json).mcpServers.wsl.command | Should -Be 'wsl'
        }
        finally { Remove-Item -Recurse -Force $p, $h -ErrorAction SilentlyContinue }
    }
```

- [ ] **Step 2: Run and confirm the four new cases fail**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 1, `Tests Passed: 12, Failed: 4`. The first and second fail on `$j.mcpServers.garmin` being `$null`, the third on no report text in the output, the fourth on the `wsl` entry never being added.

- [ ] **Step 3: Add the merge and the report to Install-Account.ps1**

Append after the settings merge.

```powershell
# --- mcpServers --------------------------------------------------------------
# Add-if-missing, receiver wins on an existing entry. Payload-wins would loop with shipping
# 1password and code-context as-is: the receiver hand-fixes those two, the next pull reverts
# them, and settings.local.json cannot reach ~/.claude.json to hold the fix. Nothing else in
# that file is touched.
# Expansion is its own pass over every server, run before the merge. Doing it inside the merge
# loop would expand only the servers that get added, because the loop skips the ones the
# receiver already has, and the residual report below reads the same object: an unexpanded
# {{CLAUDE_HOME}} would then be reported as a source-machine path on every receiver that
# already had that server.
function Expand-McpServer {
    param([pscustomobject]$Servers, [hashtable]$Tokens)
    if (-not $Servers) { return $Servers }
    foreach ($name in @($Servers.PSObject.Properties.Name)) {
        $srv = $Servers.$name
        if ($srv.command) { $srv.command = Expand-AccountToken -Text $srv.command -Tokens $Tokens }
        if ($null -ne $srv.args) {
            $srv.args = @(@($srv.args) | ForEach-Object { Expand-AccountToken -Text $_ -Tokens $Tokens })
        }
        if ($srv.env) {
            foreach ($k in @($srv.env.PSObject.Properties.Name)) {
                $srv.env.$k = Expand-AccountToken -Text $srv.env.$k -Tokens $Tokens
            }
        }
    }
    return $Servers
}

function Merge-McpServer {
    param([pscustomobject]$PayloadServers, [string]$ClaudeJsonPath)
    $added = @()
    if (-not $PayloadServers) { return $added }

    $doc = if (Test-Path -LiteralPath $ClaudeJsonPath) {
        Get-Content -LiteralPath $ClaudeJsonPath -Raw | ConvertFrom-Json
    }
    else { [pscustomobject]@{} }
    if (-not $doc.PSObject.Properties['mcpServers']) {
        $doc | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    foreach ($name in @($PayloadServers.PSObject.Properties.Name)) {
        if ($doc.mcpServers.PSObject.Properties[$name]) { continue }
        $doc.mcpServers | Add-Member -NotePropertyName $name -NotePropertyValue $PayloadServers.$name -Force
        $added += $name
    }

    $doc | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ClaudeJsonPath -Encoding utf8
    return @($added)
}

$mcpSrc = Join-Path $PayloadRoot 'mcp-servers.json'
if (Test-Path -LiteralPath $mcpSrc) {
    $payloadServers = Expand-McpServer -Tokens $tokens `
        -Servers ((Get-Content -LiteralPath $mcpSrc -Raw | ConvertFrom-Json).mcpServers)
    $added = @(Merge-McpServer -PayloadServers $payloadServers -ClaudeJsonPath $ClaudeJson)
    Write-Host "  mcpServers: $($added.Count) added$(if ($added.Count) { " ($($added -join ', '))" })"
}

# --- residual report ---------------------------------------------------------
# No settings rewrite can reach a path baked into a Store filename or a WSL user's home, so the
# honest move is to name them rather than pretend a placeholder covers them.
#
# The test is "carries an absolute path that does not exist here", not Test-ResidualWindowsPath
# alone. That function answers a different question, and the design's own acceptance criterion
# ("names 1password and code-context; anything else it names is an exporter bug") cannot hold
# under it in either direction. On a Windows receiver every correctly expanded command carries a
# drive letter, so a drive-letter rule reports all of them and the report stops meaning
# anything. And it never fires on code-context's `wsl -e /home/prior/code-context-mcp.sh`, which
# has no drive letter and no USERPROFILE, so one of the two entries the report exists to name is
# invisible to it. Test-ResidualWindowsPath is kept as the classifier on the printed line, which
# is what tells the operator whether a dead path is Windows-shaped.
function Get-UnresolvedPath {
    param([string]$Text)
    $out = @()
    if (-not $Text) { return $out }
    # A drive-letter path or a POSIX-rooted one, stopping at a quote or whitespace. Flags like
    # -NoProfile and bare command names carry no leading separator and are never matched.
    foreach ($m in [regex]::Matches($Text, '(?:[A-Za-z]:[\\/]|/)[^"''\s]*')) {
        $p = $m.Value.TrimEnd(',', ';', ')')
        if ($p -and -not (Test-Path -LiteralPath $p)) { $out += $p }
    }
    return @($out)
}

function Get-ResidualCommand {
    param([pscustomobject]$Settings, [pscustomobject]$Servers)
    $found = @()

    function Add-IfDead {
        param([string]$Where, [string]$Command, [System.Collections.IList]$Into)
        $dead = @(Get-UnresolvedPath -Text $Command)
        if ($dead.Count -eq 0) { return }
        $shape = if (Test-ResidualWindowsPath $Command) { 'Windows-shaped' } else { 'POSIX-shaped' }
        $Into.Add([pscustomobject]@{
                Where = $Where; Command = $Command; Dead = ($dead -join ', '); Shape = $shape
            })
    }

    $list = New-Object System.Collections.Generic.List[pscustomobject]
    foreach ($event in @($Settings.hooks.PSObject.Properties.Name)) {
        foreach ($g in @($Settings.hooks.$event)) {
            foreach ($x in @($g.hooks)) { Add-IfDead -Where "hooks.$event" -Command $x.command -Into $list }
        }
    }
    if ($Settings.statusLine.command) {
        Add-IfDead -Where 'statusLine' -Command $Settings.statusLine.command -Into $list
    }
    foreach ($name in @($Servers.PSObject.Properties.Name)) {
        $srv = $Servers.$name
        # One line per server, not one per string: two dead args on one entry are one problem.
        $joined = (@($srv.command) + @($srv.args)) -join ' '
        Add-IfDead -Where "mcpServers.$name" -Command $joined -Into $list
    }
    $found = @($list.ToArray())
    return $found
}

# Both halves of this report read the INSTALLED state, never the payload: settings.json as it
# now sits under $ClaudeHome, and mcpServers as they now sit in $ClaudeJson. One source, so the
# report says what is on this machine rather than half of that and half of what shipped.
# Reading the payload's servers instead would re-name 1password and code-context on every
# install after the receiver hand-fixed them, and preserving that hand-fix is the whole reason
# the merge above is add-if-missing.
$liveForReport = Join-Path $ClaudeHome 'settings.json'
$reportSettings = if (Test-Path -LiteralPath $liveForReport) {
    Get-Content -LiteralPath $liveForReport -Raw | ConvertFrom-Json
}
else { [pscustomobject]@{ hooks = [pscustomobject]@{} } }

$reportServers = if (Test-Path -LiteralPath $ClaudeJson) {
    (Get-Content -LiteralPath $ClaudeJson -Raw | ConvertFrom-Json).mcpServers
}
else { $null }

$residuals = @(Get-ResidualCommand -Settings $reportSettings -Servers $reportServers)
if ($residuals.Count -gt 0) {
    Write-Host ''
    Write-Host 'Still carrying a source-machine path, and no settings rewrite can reach them:'
    foreach ($r in $residuals) {
        Write-Host "  $($r.Where) [$($r.Shape)]: $($r.Command)"
        Write-Host "    does not exist here: $($r.Dead)"
    }
    Write-Host 'Expected here: mcpServers.1password (a Store path with an embedded version) and mcpServers.code-context (a WSL launcher into another user home). Anything else on this list is an exporter bug.'
}
Write-Host ''
Write-Host 'Install complete. Restart Claude Code to pick up the new settings.'
```

- [ ] **Step 4: Run and confirm the suite is green**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 16, Failed: 0`.

- [ ] **Step 5: Ablate the receiver-wins rule and the residual rule**

Change `if ($doc.mcpServers.PSObject.Properties[$name]) { continue }` to `if ($false) { continue }`, re-run, and confirm `leaves a hand-fixed entry alone across a second install` goes red. Restore.

Then replace the body of `Get-UnresolvedPath` with a drive-letter-only rule, `if (Test-ResidualWindowsPath $Text) { return @($Text) } else { return @() }`, re-run, and confirm `names both non-portable servers, and nothing that resolves on this machine` goes red twice over: `code-context` disappears from the report because `wsl -e /home/prior/code-context-mcp.sh` has no drive letter, and `Scan-MemorySecrets` appears in it because the correctly expanded Windows temp path does. That double failure is the evidence that the two halves of the acceptance criterion are both load-bearing. Restore and re-run to green.

- [ ] **Step 6: Run the other suites and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

```bash
git add install/Install-Account.ps1 install/Install-Account.Tests.ps1
git commit -m "feat(install): merge mcpServers add-if-missing and report residuals

mcpServers is the one key where the receiver wins. Payload-wins would loop
with shipping 1password and code-context as-is: the receiver hand-fixes both
in ~/.claude.json, the next pull reverts them, and settings.local.json
cannot reach that file to hold the fix. Every session on the receiver would
then report two failed MCP connections forever.

Nothing else in claude.json is touched. That file is otherwise 46 project
entries, two identifiers and statsig caches.

The residual report names every command carrying an absolute path that does
not exist on this machine. The design prescribed Test-ResidualWindowsPath
for this and that rule cannot meet the design's own criterion: on a Windows
receiver every correctly expanded command has a drive letter, so it names
all of them, and it never fires on code-context's wsl -e /home/prior/...,
which is one of the two entries the report exists to name. That function is
kept as the classifier on the printed line. The test asserts garmin and the
expanded hook command are absent from the report as well as asserting both
non-portable servers are present, because a report that names everything is
no report.

The install still completes with residuals outstanding: the two entries are
known-broken by design, not a reason to refuse the other content.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 12: Round trip, and a clean-home install

Two cases that need both scripts. The round trip is what makes the installer safe to run on the canonical box: install expands, the next export folds the literals back, and the two files agree byte for byte. The clean-home install is the shape a receiver actually sees.

**Files:**
- Test: `install/Install-Account.Tests.ps1` (add a second `Describe` block at the end of the file)

**Interfaces:**
- Consumes: `install/Export-Account.ps1` and `install/Install-Account.ps1` complete. `New-CanonicalHome` is defined in this `Describe`'s own `BeforeAll`, so the block does not reach into the other test file's scope; it is a different fixture from Task 4's `New-StandInHome` and not a copy of it.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Append to `install/Install-Account.Tests.ps1`, after the closing brace of `Describe "Install-Account"`.

```powershell
Describe "Account layer round trip" {
    BeforeAll {
        $script:export = "$PSScriptRoot/Export-Account.ps1"
        $script:install = "$PSScriptRoot/Install-Account.ps1"
        $script:repoRoot = Split-Path $PSScriptRoot -Parent

        # A stand-in canonical workstation: a ~/.claude carrying one file of each shape that
        # gets folded, plus a settings.json in all three quoting forms.
        function New-CanonicalHome {
            $canonHome = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-canon-" + [guid]::NewGuid())
            $ch = Join-Path $canonHome '.claude'
            foreach ($d in 'rules', 'agents', 'hooks', 'tools/prose-lint',
                'skills/prose-lint', 'skills/handoff', 'skills/council', 'skills/subagent-prompting') {
                New-Item -ItemType Directory -Path (Join-Path $ch $d) -Force | Out-Null
            }
            $chBack = $ch -replace '/', '\'
            $core = 'E:\projects\agent-harness-core'
            $vault = Join-Path $canonHome 'Documents\Obsidian Vault\Claude Code'
            $slug = $canonHome.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-'

            'plain rule'                                     | Set-Content (Join-Path $ch 'rules/security.md')
            "Core repo: $core"                               | Set-Content (Join-Path $ch 'rules/harness-core.md')
            'agent def'                                      | Set-Content (Join-Path $ch 'agents/appsec-sme.md')
            "the core at $core"                              | Set-Content (Join-Path $ch 'hooks/harness-core-reminder.sh')
            'StylesPath = styles'                            | Set-Content (Join-Path $ch 'tools/prose-lint/.vale.ini')

            # A real $patterns block, not a stub. The exporter's secret gate lifts this table by
            # AST out of the stand-in hook and throws when the assignment is absent, so 'exit 0'
            # here would fail the export before either round-trip case reached an assertion.
            # Same two rows as the Export-Account fixture, for the same reason.
            @'
$patterns = @(
    @{ Name = 'API token (tk_/sk_/ak_)'; Regex = '(?<![a-zA-Z0-9_])(tk_|sk_|ak_)[a-zA-Z0-9]{10,}' }
    @{ Name = 'AWS-style key';           Regex = 'AKIA[0-9A-Z]{16}' }
)
exit 0
'@ | Set-Content (Join-Path $ch 'hooks/Scan-MemorySecrets.ps1')
            "vale --config `"$chBack\tools\prose-lint\.vale.ini`"" | Set-Content (Join-Path $ch 'skills/prose-lint/SKILL.md')
            "write to $vault\Handoffs\x.md"                  | Set-Content (Join-Path $ch 'skills/handoff/SKILL.md')
            "home folder is $slug"                           | Set-Content (Join-Path $ch 'skills/council/SKILL.md')
            "$slug and $vault\Handoffs"                      | Set-Content (Join-Path $ch 'skills/subagent-prompting/SKILL.md')
            'ps statusline'                                  | Set-Content (Join-Path $ch 'statusline-command.ps1')
            'sh statusline'                                  | Set-Content (Join-Path $ch 'statusline-command.sh')

            @{
                env = @{ CLAUDE_CODE_USE_POWERSHELL_TOOL = '1' }
                permissions = @{ allow = @('mcp__code-context'); defaultMode = 'auto' }
                hooks = @{ PreToolUse = @( @{ matcher = 'Write|Edit'; hooks = @(
                                @{ type = 'command'; command = "& '$chBack\hooks\Scan-MemorySecrets.ps1'"
                                    shell = 'powershell'; timeout = 5 }) }) }
                statusLine = @{ type = 'command'
                    command = 'node C:/npm/node_modules/ccstatusline/dist/ccstatusline.js'; padding = 0 }
            } | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $ch 'settings.json')

            @{ mcpServers = @{ garmin = @{ type = 'stdio'; command = 'uvx'
                        args = @('garmin-mcp'); env = @{} } } } |
                ConvertTo-Json -Depth 20 | Set-Content (Join-Path $canonHome '.claude.json')

            return $canonHome
        }

        $script:exportArgs = {
            param($canonHome, $out)
            @{
                ClaudeHome = (Join-Path $canonHome '.claude')
                ClaudeJson = (Join-Path $canonHome '.claude.json')
                OutputRoot = $out
                CoreRepo = 'E:\projects\agent-harness-core'
                NpmGlobal = 'C:/npm/node_modules'
                VaultPath = (Join-Path $canonHome 'Documents\Obsidian Vault\Claude Code')
                HomeSlug = ($canonHome.TrimEnd('\', '/') -creplace '[^A-Za-z0-9]', '-')
            }
        }
    }

    It "install then export reproduces the payload byte for byte" {
        # The claim this checks: running the installer on the canonical box is safe, because the
        # next export folds the literals back to exactly the tokens they came from. If a fold
        # matched only one separator spelling this would fail, since install writes
        # forward-slash form and the originals here are backslashed.
        $canonHome = New-CanonicalHome
        $out1 = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-rt1-" + [guid]::NewGuid())
        $out2 = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-rt2-" + [guid]::NewGuid())
        try {
            $a = & $script:exportArgs $canonHome $out1
            & $script:export @a | Out-Null

            # -VaultPath and -HomeSlug are what make this a round trip. Without them the
            # installer derives both from the runner's real $HOME, expands {{OBSIDIAN_VAULT}}
            # and {{HOME_SLUG}} to values the canonical fixture never contained, and the second
            # export has nothing to fold back: the two payloads then differ on three files for
            # a reason that has nothing to do with the separator handling under test.
            & $script:install -PayloadRoot $out1 -ClaudeHome (Join-Path $canonHome '.claude') `
                -ClaudeJson (Join-Path $canonHome '.claude.json') `
                -CoreRepo 'E:\projects\agent-harness-core' -NpmGlobal 'C:/npm/node_modules' `
                -VaultPath $a.VaultPath -HomeSlug $a.HomeSlug `
                -TargetIsWindows:$true -SkipPreflight | Out-Null

            $b = & $script:exportArgs $canonHome $out2
            & $script:export @b | Out-Null

            foreach ($rel in 'rules/harness-core.md', 'hooks/harness-core-reminder.sh',
                'skills/prose-lint/SKILL.md', 'skills/handoff/SKILL.md',
                'skills/council/SKILL.md', 'skills/subagent-prompting/SKILL.md') {
                (Get-Content (Join-Path $out2 $rel) -Raw) |
                    Should -Be (Get-Content (Join-Path $out1 $rel) -Raw) -Because "$rel must fold back"
            }
            $s1 = Get-Content (Join-Path $out1 'settings.account.json') -Raw | ConvertFrom-Json
            $s2 = Get-Content (Join-Path $out2 'settings.account.json') -Raw | ConvertFrom-Json
            @(@($s2.hooks.PreToolUse)[0].hooks)[0].command |
                Should -Be @(@($s1.hooks.PreToolUse)[0].hooks)[0].command
            $s2.statusLine.command | Should -Be $s1.statusLine.command
        }
        finally { Remove-Item -Recurse -Force $canonHome, $out1, $out2 -ErrorAction SilentlyContinue }
    }

    It "an install into an empty home leaves every hook command pointing at a real file" {
        $canonHome = New-CanonicalHome
        $out = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-rt3-" + [guid]::NewGuid())
        $fresh = Join-Path ([System.IO.Path]::GetTempPath()) ("acct-fresh-" + [guid]::NewGuid())
        try {
            $a = & $script:exportArgs $canonHome $out
            & $script:export @a | Out-Null

            $freshClaude = Join-Path $fresh '.claude'
            & $script:install -PayloadRoot $out -ClaudeHome $freshClaude `
                -ClaudeJson (Join-Path $fresh '.claude.json') `
                -CoreRepo $script:repoRoot -NpmGlobal 'C:/npm/node_modules' `
                -TargetIsWindows:$true -SkipPreflight | Out-Null

            $s = Get-Content (Join-Path $freshClaude 'settings.json') -Raw | ConvertFrom-Json
            $cmd = @(@($s.hooks.PreToolUse)[0].hooks)[0].command
            $cmd | Should -Not -Match '\{\{'
            # Pull the quoted path out of "& 'path'" and confirm the file is there. A command
            # that expands to a plausible path over nothing is the failure mode this catches,
            # and it is invisible until a hook silently stops firing.
            #
            # [regex]::Match, not Should -Match plus $Matches. Pester 5.7.1 evaluates the match
            # inside its own scope, so $Matches is null by the time the next line reads it and
            # $Matches.p yields $null: Test-Path -LiteralPath $null then throws a parameter
            # binding error rather than failing an assertion, which reads as a broken test
            # rather than a broken install.
            $m = [regex]::Match($cmd, "^& '(?<p>[^']+)'$")
            $m.Success | Should -BeTrue -Because "the expanded command must still be a quoted call"
            Test-Path -LiteralPath $m.Groups['p'].Value | Should -BeTrue

            Test-Path -LiteralPath (Join-Path $freshClaude 'hooks/model-tier-gate.ts') | Should -BeTrue
            # -CoreRepo here is $script:repoRoot, so the expected literal is derived from it
            # rather than hardcoded. A hardcoded E:/projects/agent-harness-core would pass on
            # this workstation for the wrong reason and fail on any other clone.
            (Get-Content (Join-Path $freshClaude 'rules/harness-core.md') -Raw) |
                Should -Match ([regex]::Escape($script:repoRoot -replace '\\', '/'))
            (Get-Content (Join-Path $freshClaude 'skills/subagent-prompting/SKILL.md') -Raw) |
                Should -Not -Match '\{\{'
            (Get-Content (Join-Path $fresh '.claude.json') -Raw | ConvertFrom-Json).mcpServers.garmin.command |
                Should -Be 'uvx'
        }
        finally { Remove-Item -Recurse -Force $canonHome, $out, $fresh -ErrorAction SilentlyContinue }
    }
}
```

- [ ] **Step 2: Run and confirm both cases fail or pass on their own merits**

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`

Expected: exit 0, `Tests Passed: 18, Failed: 0`, if Tasks 4 through 11 are correct. These two cases test the seam between the finished scripts rather than new code, so a green first run is the expected outcome here and not a sign the tests are vacuous. Step 3 is what establishes they can fail.

- [ ] **Step 3: Ablate the separator handling to prove the round trip discriminates**

In `install/Export-Account.ps1`, change `ConvertTo-TemplatedText`'s pattern line from

```powershell
    $pattern = [regex]::Escape(($Fold.Literal -replace '/', '\')) -replace '\\\\', '[\\\\/]'
```

to

```powershell
    $pattern = [regex]::Escape($Fold.Literal -replace '/', '\')
```

so it matches the backslash spelling only. Re-run and confirm `install then export reproduces the payload byte for byte` goes red on `rules/harness-core.md`: the first export folds the backslashed original, the install writes `E:/projects/agent-harness-core`, and the second export leaves that forward-slashed literal in place. Restore and re-run to green.

- [ ] **Step 4: Run every suite**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 16, Failed: 0`.

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`
Expected: exit 0, `Tests Passed: 10, Failed: 0`.

Run: `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`
Expected: exit 0.

Run: `pwsh -NoProfile -File install/Restore-ClaudeProject.Tests.ps1`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add install/Install-Account.Tests.ps1
git commit -m "test(install): round trip and clean-home install

The round trip is the claim that makes the installer safe to run on the
canonical box: install expands, the next export folds the literals back, and
the payload is unchanged. It discriminates only because every fold matches
both separator spellings, and the ablation for this commit was removing that
and watching harness-core.md diverge.

The clean-home case pulls the quoted path out of the expanded hook command
and confirms the file is there. An expansion that produces a plausible path
over nothing is invisible until a hook silently stops firing, which is the
same failure shape as the account-scope model-tier guard that sat
unregistered for three weeks.

Neither case is a substitute for the real second machine. That install
remains the only evidence for the plugins-repopulate-from-settings claim,
and it has not been run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 13: Registration, so the two scripts are finished rather than merely present

CONTRIBUTING's Gate 1: a new executable artifact is not finished when the file exists, it is finished when something invokes it. For an operator-invoked installer, that something is the README text and the `harness-core.md` reminder naming the command. Both scripts have carried an UNWIRED header notice since Tasks 4 and 8; this task adds the registration and removes the notices.

The `~/.claude/rules/harness-core.md` edit comes before the payload is generated, not after, or Task 14 would export a copy of the file that predates its own registration.

**Files:**
- Modify: `README.md`
- Modify: `C:\Users\user\.claude\rules\harness-core.md`
- Modify: `install/Export-Account.ps1` (remove the two-line UNWIRED header)
- Modify: `install/Install-Account.ps1` (remove the two-line UNWIRED header)
- Modify: `docs/backlog.md` (close item 16, Step 5)

**Interfaces:**
- Consumes: both finished scripts.
- Produces: nothing by name. Task 14 folds `E:\projects\agent-harness-core` out of the new `harness-core.md` text as `{{CORE_REPO}}`, so the paths written here must use that exact literal spelling.

- [ ] **Step 1: Back up the rules file**

```powershell
$f = 'C:\Users\user\.claude\rules\harness-core.md'
Copy-Item -LiteralPath $f -Destination "$f.bak.$(Get-Date -AsUTC -Format 'yyyyMMdd-HHmmss')"
```

- [ ] **Step 2: Add the account-layer row to the README's "What's here" table**

In `README.md`, in the table under `## What's here`, insert this row directly after the `install/` row:

```markdown
| `account/claude/` | The workstation account layer: rules, agents, skills, the Vale prose-lint kit, hooks, and templated `settings.account.json` and `mcp-servers.json`. Generated by `install/Export-Account.ps1`, never hand-edited |
```

- [ ] **Step 3: Add the account-layer section to the README**

In `README.md`, insert this section directly after the `## Install` section and before whatever follows it:

```markdown
## Account layer

The project installer above copies core into one repo's `.claude/`. The account layer is the
other half: the `~/.claude/` config that applies to every repo on a machine, which until now
existed only on the workstation where it was written. A guard that needs hand-registration on
every machine sits unregistered somewhere, and no distribution path is why one did.

One direction. Config is authored in `~/.claude/` on the canonical workstation, exported into
`account/claude/` here, and consumed elsewhere. A divergence on a receiving machine is a bug
rather than a fork to keep.

Export, on the canonical workstation only:

```
pwsh -NoProfile -File install/Export-Account.ps1
```

It mirrors an allowlisted subset of `~/.claude/` into `account/claude/`, folding this machine's
absolute paths into five placeholder tokens. A second export with nothing changed produces no
diff, so `git status account/claude` after a run is a usable review of what moved. It refuses
to write an `mcpServers` entry carrying anything the memory secret scanner recognises.

Install, on any machine, after a `git pull`:

```
pwsh -NoProfile -File install/Install-Account.ps1
```

It copies the payload over `~/.claude/`, expands the tokens from the receiver's own
environment, rewrites PowerShell hook invocations for a non-Windows target, deep-merges
`settings.json` rather than replacing it (Claude Code writes that file itself, and an overwrite
would revert every `/plugin` toggle on every pull), adds missing `mcpServers` entries to
`~/.claude.json` without touching an existing one, and prints every command still carrying a
source-machine path. Prerequisites are `pwsh` 7 and git; `vale`, `bun`, `node` with a global
`ccstatusline`, Git Bash on Windows, `uvx` and, on a Linux box with no npm, `jq` each drive one
feature that fails open without it, which is what the preflight warning makes visible.

Two limits follow from having no manifest, and both are intended. A file or hook entry deleted
on the canonical box stays on receivers, because the copy overwrites and the merge adds. And a
receiver's own edit to an installed file is reverted by the next install without comment.
`settings.local.json` is the per-machine escape hatch and never travels.
```

- [ ] **Step 4: Add the account-layer section to ~/.claude/rules/harness-core.md**

Insert this section into `C:\Users\user\.claude\rules\harness-core.md`, after the `## After install, use what's there` section and before `## Findings flow (both channels)`. The `E:\projects\agent-harness-core` spelling is load-bearing: Task 14's export folds that exact literal into `{{CORE_REPO}}`.

```markdown
## Account layer, on this machine and on any other

`~/.claude/` is authored here and distributed through the core repo. One direction: a
divergence on another machine is a bug, not a fork.

After changing anything under `~/.claude/rules/`, `agents/`, `skills/`, `hooks/` or
`tools/prose-lint/`, or after a settings change worth keeping, export it:

```powershell
pwsh -NoProfile -File E:\projects\agent-harness-core\install\Export-Account.ps1
```

Then review `git status account/claude` in the core repo and commit. A second export with
nothing changed produces no diff, so anything the status shows is a real change.

On a second machine, after `git pull` in the core repo:

```powershell
pwsh -NoProfile -File E:\projects\agent-harness-core\install\Install-Account.ps1
```

Do not hand-edit `account/claude/` in the repo. It is generated, and the next export overwrites
it. Fix the source under `~/.claude/` and export again.
```

- [ ] **Step 5: Remove both UNWIRED notices**

Delete the two-line comment block at the very top of `install/Export-Account.ps1`:

```powershell
# UNWIRED until Task 13 of docs/superpowers/plans/2026-09-03-account-layer-portability.md adds
# its README and rules/harness-core.md registration. Invoke: pwsh -NoProfile -File install/Export-Account.ps1
```

and the matching block at the top of `install/Install-Account.ps1`.

Then close the tracker item the notices pointed at. In `docs/backlog.md`, change item 16's status line to:

```markdown
**Status:** closed 2026-09-03. Both scripts are registered in `README.md` and `~/.claude/rules/harness-core.md`, and both header notices are gone.
```

A tracker item that outlives the condition it tracks is the same defect as a header notice that outlives its own wiring.

- [ ] **Step 6: Confirm nothing else claims those scripts are unwired**

Run: `pwsh -NoProfile -Command "Select-String -Path install/*.ps1, README.md -Pattern 'UNWIRED' | Select-Object -ExpandProperty Line"`
Expected: no output.

Run: `pwsh -NoProfile -Command "Select-String -Path README.md, 'C:\Users\user\.claude\rules\harness-core.md' -Pattern 'Export-Account|Install-Account' | Measure-Object | Select-Object -ExpandProperty Count"`
Expected: `6` or more. Both scripts named in both files, which is what Gate 1 asks for.

- [ ] **Step 7: Lint the two prose additions**

Run: `pwsh -NoProfile -Command "vale --config 'C:\Users\user\.claude\tools\prose-lint\.vale.ini' --output=line README.md"`
Expected: no new findings attributable to the section added in Step 3. The README has existing text and existing findings; compare against the same command run before the edit if the output is not obviously clean.

- [ ] **Step 8: Run every suite and commit**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 18, Failed: 0`.

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 16, Failed: 0`.

```bash
git add README.md install/Export-Account.ps1 install/Install-Account.ps1 docs/backlog.md
git commit -m "docs(install): register Export-Account and Install-Account

CONTRIBUTING's Gate 1: an executable artifact is finished when something
invokes it, not when the file exists. For an operator-invoked installer that
is the README text and the ~/.claude/rules/harness-core.md reminder naming
the command. Both scripts have carried the sanctioned UNWIRED header notice
since they landed; this removes them.

The rules file is the account layer's own copy and is not in this repo yet.
It changes here, before the payload is generated, so the exported copy
carries its own registration rather than a version that predates it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

### Task 14: Generate the payload

Run the finished exporter against the real `~/.claude/` and commit what it produces. This is the first time the payload exists, so it is also the first time `install/Account-Hooks.Tests.ps1` runs its assertions against `account/claude/hooks/` as well as the live copy, which is the check that the three hook fixes actually travelled.

Nothing in this task is hand-written. If a file in `account/claude/` looks wrong, the fix goes in `~/.claude/` or in the exporter, and the export runs again.

**Files:**
- Create: `account/claude/**` (generated)

**Interfaces:**
- Consumes: everything from Tasks 1 through 13.
- Produces: the payload that `install/Install-Account.ps1` reads by default.

- [ ] **Step 1: Confirm the working tree is clean before generating**

Run: `git status --porcelain -- . ':!.claude/worktrees'`
Expected: no output. A generated tree landing on top of unrelated edits makes the review in Step 4 unreadable.

The pathspec exclusion is not cosmetic. This repo's own write agents run in worktrees under `.claude/worktrees/`, and a bare `git status --porcelain` reports every one of them as untracked. An executor that reads that as a dirty tree stalls here with nothing wrong.

- [ ] **Step 2: Run the exporter**

Run: `pwsh -NoProfile -File install/Export-Account.ps1`

Expected on stdout: an `Account home` and `Output root` line, one `<dir>: <n> files` line for each of `rules`, `agents`, `skills`, `tools/prose-lint` and `hooks`, `settings.account.json: written`, one `folded <n> token(s)` line for each of the six templated files, `mcp-servers.json: 3 server(s)`, and `Export complete`. Any throw here is a real defect: the secret gate refusing an `mcpServers` string, or a templated-file row naming a file the payload does not carry.

- [ ] **Step 3: Confirm nothing that should not travel is in the payload**

Run this through the PowerShell tool, or save it to a `.ps1` under the session scratchpad and run that file. Do not pipe it through the Bash tool: a `@'...'@` here-string is PowerShell syntax that `sh` does not parse, and a Bash-hosted `pwsh -Command` also eats the backslashes out of the regexes below, which silently changes what is being matched rather than failing.

```powershell
pwsh -NoProfile -Command @'
$p = "account/claude"
"bak:      " + @(Get-ChildItem $p -Recurse -File -Force | Where-Object { $_.Name -like "*.bak.*" }).Count
"gate:     " + (Test-Path "$p/hooks/model-tier-gate.ts")
"handoff:  " + (Test-Path "$p/hooks/Guard-ModelTier.HANDOFF.md")
"settings: " + (Test-Path "$p/settings.json")
"creds:    " + (Test-Path "$p/.credentials.json")
"local:    " + (Test-Path "$p/settings.local.json")
'@
```

Expected: `bak: 0`, and `False` on all five.

- [ ] **Step 4: Confirm every fold landed and no machine path survived where one should not**

Same rule as Step 3: PowerShell tool or a scratchpad `.ps1`, never the Bash tool. The `\{\{[A-Z_]+\}\}` pattern is the one that loses most from a backslash-eating shell, and it loses quietly.

```powershell
pwsh -NoProfile -Command @'
$p = "account/claude"
foreach ($f in "rules/harness-core.md","hooks/harness-core-reminder.sh","skills/prose-lint/SKILL.md",
                "skills/handoff/SKILL.md","skills/council/SKILL.md","skills/subagent-prompting/SKILL.md") {
    $t = Get-Content "$p/$f" -Raw
    "{0,-42} tokens={1} user={2} Eprojects={3}" -f $f,
        @([regex]::Matches($t, "\{\{[A-Z_]+\}\}")).Count,
        @([regex]::Matches($t, "C:.Users.user")).Count,
        @([regex]::Matches($t, "E:.projects.agent-harness-core")).Count
}
"settings.account.json literals: " + @([regex]::Matches((Get-Content "$p/settings.account.json" -Raw), "C:..Users..user")).Count
"ssh.md untouched: " + (@([regex]::Matches((Get-Content "$p/rules/ssh.md" -Raw), "\{\{")).Count -eq 0)
'@
```

Expected: `tokens` at least 1 for every one of the six, `user=0` and `Eprojects=0` on all six, `settings.account.json literals: 0`, and `ssh.md untouched: True`.

If `user` or `Eprojects` is non-zero on one of the six, the fold table missed a spelling in that file. Fix `ConvertTo-TemplatedText` or the table in `install/AccountShared.ps1`, add the case to `install/Export-Account.Tests.ps1`, and re-run the export. Do not hand-edit the payload.

- [ ] **Step 5: Confirm the hook fixes travelled**

Run: `pwsh -NoProfile -File install/Account-Hooks.Tests.ps1`

Expected: exit 0, `Tests Passed: 10, Failed: 0`, and the run is now exercising two hook roots rather than one. Confirm that by temporarily reverting one fix in the payload copy only, for example putting `$memRoot = 'C:\Users\user\.claude\projects\'` back into `account/claude/hooks/Scan-MemorySecrets.ps1`, re-running, and confirming `blocks a secret written under a memory root derived from HOME` goes red. Then re-run the exporter to restore the payload from source and confirm the suite is green again.

The edit goes in `account/claude/`, never in `~/.claude/`. That tree is generated and not yet committed, so if anything goes wrong the recovery is another `pwsh -NoProfile -File install/Export-Account.ps1`, which rewrites it from the live source. If the live hook was touched by mistake, restore it from the `.bak.<timestamp>` copy taken in Task 1 Step 1 and re-run this suite before going on.

- [ ] **Step 6: Confirm the export is idempotent against the real tree**

Run: `pwsh -NoProfile -File install/Export-Account.ps1` a second time, then `git status --porcelain account/claude`

Expected: the same set of files as after the first run, with no additional modifications from the second. This is the claim that makes `git status` a usable review of the account layer, checked once against the real tree rather than only against a fixture.

- [ ] **Step 7: Run every suite**

Run: `bun test`
Expected: `395 pass`, `0 fail`.

Run: `pwsh -NoProfile -File install/Export-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 16, Failed: 0`.

Run: `pwsh -NoProfile -File install/Install-Account.Tests.ps1`
Expected: exit 0, `Tests Passed: 18, Failed: 0`.

Run: `pwsh -NoProfile -File install/Install-Harness.Tests.ps1`
Expected: exit 0.

Run: `pwsh -NoProfile -File install/Restore-ClaudeProject.Tests.ps1`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add account/claude
git commit -m "chore(account): generate the account/claude payload

Produced by install/Export-Account.ps1 against ~/.claude on the canonical
workstation. Nothing here is hand-written, and a second export with nothing
changed produces no diff, so any later change to this tree is a real change
to the account layer.

model-tier-gate.ts is deliberately absent: core/claude/hooks holds the
authoritative copy and the installer sources it from there. Two copies in
one repo would drift the moment either was edited.

1password and code-context ship as-is in mcp-servers.json and work on no
other machine. No placeholder can express a Windows Store path with an
embedded version or a WSL user's home, and a placeholder would be
pretending; the receiver-side residual report names both.

Unproven, and the only thing that settles it is a real second machine: that
plugins repopulate on a receiver from enabledPlugins and
extraKnownMarketplaces alone, since plugins/cache/ does not ship and the two
extra marketplaces are arbitrary GitHub repos rather than the official one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VrXs4JF9EQbPffeJLXpqq4"
```

---

## What this plan does not do

Named here so an executor does not go looking for a task that is missing on purpose.

- **The clean-install test on a real second machine.** The spec lists it, and it is the only evidence for the claim that plugins repopulate from settings alone. It needs hardware this plan cannot reach. Task 12's clean-home case is a stand-in directory, not a second box, and Task 14's commit message says so.
- **Whether Claude Code sends `tool_name: "Workflow"`** to the model-tier gate. Unchanged by this work; the gate ships as core already has it.
- **The host that runs `"shell": "powershell"` on a Windows receiver.** Every path build this plan writes is valid on both Windows PowerShell 5.1 and pwsh 7, so the question no longer blocks anything here, but it stays open for `Sync-MemoryToObsidian.ps1`, which already used pwsh-7-only three-argument `Join-Path` before this work and still does at four other sites.
- **The Linux location of bundled skills** for `Guard-SkillSize.ps1`. Task 3 drops that root on Linux rather than guessing at it.
- **Whether `statusline-command.ps1` and `.sh` still run.** Task 9 wires the npm-absent branch to them and says in the code comment that nothing has invoked them since ccstatusline took over.
- **A manifest, drift detection, or removal propagation** for the account layer. Decision 5 declines to build them in v1.

## Where this plan departs from the spec

Three places, each with the reason. An executor who finds these surprising should read this section rather than reverting to the spec's wording.

- **Nested two-argument `Join-Path`, not the multi-segment form.** The spec prescribes multi-segment for bugs 3 and 4. Measured on this box: `powershell.exe 5.1.26100.9278` rejects `Join-Path "C:\a" "b" "c"` with "A positional parameter cannot be found that accepts argument 'c'." `Lint-DocumentProse.ps1:1` declares `#Requires -Version 5.1`, and the spec's own Still-unresolved list says the host for a `"shell": "powershell"` entry may be 5.1. Nested calls are correct on both.
- **The residual report tests for a path that does not exist, not for a drive letter.** Reasons in Task 11's opening paragraph. `Test-ResidualWindowsPath` is still used, as the classifier on each printed line.
- **Both scripts take more parameters than the spec lists.** The spec names `-ClaudeHome`, `-ClaudeJson` and `-OutputRoot` for the exporter. This plan adds `-CoreRepo`, `-NpmGlobal`, `-VaultPath`, `-HomeSlug`, `-SkipSettings` and `-SkipMcp`, and gives the installer `-CoreRepo`, `-NpmGlobal` and `-SkipPreflight` beside the `-TargetIsWindows` the spec does name. Every one is a test seam with a real default, and without them a test would have to shell out to `git`, `npm` and the operator's live vault to reach a branch. `Restore-ClaudeProject.ps1:88-95` is the precedent: it added `-TargetIsWindows` for exactly this reason and records that the Linux branch was otherwise unreachable from any test on a Windows host, with no Linux CI in the repo.

Two smaller judgment calls, recorded so nobody re-derives them:

- **Bugs 5 through 8 get no source-fix task.** They are model-read text, and the spec routes them through the export-time fold. Stated once in File Structure and implemented in Tasks 6 and 9.
- **The statusline fallback command form.** The spec says point `statusLine.command` at the shipped script per platform but not in what form. This plan uses `pwsh -NoProfile -File '<home>/statusline-command.ps1'` on Windows and `bash '<home>/statusline-command.sh'` elsewhere, both runnable without a `shell` key.
