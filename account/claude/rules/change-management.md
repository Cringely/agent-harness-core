# Change Management Protocol

## Homelab Context
This is a homelab environment. Balance between move-fast experimentation and avoiding outages. Production services (Authentik SSO, monitoring, media stack) deserve more care than experimental containers.

## Non-Destructive Changes First

**For configuration files:**
- Back up before editing: `cp config.yml config.yml.bak.$(date +%Y%m%d-%H%M%S)`
- Test syntax before applying (e.g., `docker compose config`, `nginx -t`)
- Keep the last working version accessible

**For Docker services:**
- Don't delete volumes unless certain they're not needed
- Use `docker compose stop` before `down` to preserve state
- Tag images before major upgrades for easy rollback

**For infrastructure changes:**
- Export current state before changes (VM snapshots, LXC backups)
- Document the "before" state (running services, port mappings, network config)

## Verification Gates

**After each change:**
- Verify the service still works (curl health checks, browser test)
- Check logs for errors: `docker compose logs -f --tail=50 <service>`
- Confirm dependent services still function

**Before moving to next step:**
- Current change is stable
- No new errors in logs
- Service responds to requests

## Git Commit Identity

All commits must use the user's GitHub identity only. Never add Claude as a co-author or include any `Co-Authored-By` trailer. The commit author is always the user (Cringely). Do not add bot signatures, co-author lines, or any attribution to Claude in commit messages.

## Decision Documentation

**In commit messages:**
- Why this change was needed (not just what changed)
- What was considered and rejected
- Any trade-offs made

**In code comments:**
- Why non-obvious configuration exists
- Warnings about things that look wrong but are intentional
- References to relevant docs or issues

## Decision Notes

Before infrastructure, security, or process changes, check the Decisions group in MEMORY.md; read any note relevant to the area. Check both scopes. Decision notes routinely live under a different project's memory directory than the one you are working in, and several projects' MEMORY.md files carry no Decisions group at all, so an absent group is not evidence that no decision exists. A conflict with an `accepted` decision is flagged to the user, not overridden. `proposed` notes are recommendations only.

When work surfaces a consequential choice in one of the three decision categories (infrastructure/architecture, security tradeoffs, process & agent behavior), first check the Decisions group — including its `Rejected:` line — for an existing or rejected note on the same choice, then create a `proposed` decision note (format in the memory-system skill). Never mark your own note `accepted`. Do not create decision notes outside these categories.

Precedence when sources disagree: rules files > accepted decision notes > handoff.

## Risky Operations Requiring Confirmation

Ask user before:
- Deleting Docker volumes or bind-mount directories
- Dropping database tables or schemas
- Force-pushing to git repos
- Pruning Docker images/containers/networks/volumes (might remove unrelated items)
- Modifying production service configs (Authentik, Traefik, monitoring)
- Changing firewall rules or network configuration
- Removing services from docker-compose.yml

## Backup Requirements

**Before these operations, confirm backup exists:**
- Database migrations or schema changes → manual dump or verify automated backup
- Removing services from stack → export volumes if they contain data
- Major version upgrades of databases (Postgres, Redis) → backup + test restore
- SSL certificate changes → backup existing certs
- Authentik configuration changes → export blueprints

## Incremental Changes

**Prefer small steps:**
- Add one service at a time, verify, then add next
- Change one config parameter, test, then change next
- Deploy to staging (docker-staging VM) before production

## Rollback Strategy

**Always know how to undo:**
- Keep previous image tags available for fast rollback
- Know the command to restore previous config
- Document rollback steps in plan files for complex changes
- Git commits can be reverted

## Change Log for Multi-Step Operations

For complex multi-step changes (like Phase 4-11 in Docker stack):
- Use plan files to track progress
- Update auto memory after completing each phase
- Note which configs changed and where backups are
- Record any manual steps that need repeating if rolled back

## Invariant Promotion

When the same class of failure appears more than once across sessions, promote it from an incident note in MEMORY.md to a permanent rule in the relevant rules file. An invariant is not a record of what happened — it is a constraint that prevents recurrence.

**When to promote:**
- The same fix has been applied twice to different services (e.g., healthchecks failing because the image lacks the expected binary)
- A failure reveals a general class of problem, not a one-off typo
- A workaround keeps being rediscovered instead of being documented once

**How to promote:**
1. Identify the general rule behind the specific fix
2. Write it as a testable, actionable constraint (not "be careful with X")
3. Add it to the most relevant rules file (change-management.md for process, security.md for security, secure-coding.md for code patterns)
4. Remove or shorten the original MEMORY.md entry to a pointer

**Examples of promotable patterns from past work:**
- Alpine-based images resolve `localhost` to IPv6 first — use `127.0.0.1` in healthchecks and connection strings
- Container images may lack `curl` or `wget` — verify the binary exists before writing healthchecks that depend on it
- Docker Compose bind-mount secrets need `0644` not `0600` — non-root container users can't read `0600` files
- Services that add PUID/PGID support may still need explicit `user:` directives — check the image docs
- CRLF line endings break shell scripts sent via SSH from Windows — use Python3 or base64 encoding for remote file edits
- Git Bash `$HOME` on this workstation is `/c/Users/user/Documents`, not the real profile at `C:\Users\user`. Any Bash check written as `~/.claude/...` or `$HOME/...` silently reads a directory that does not exist and reports the file missing. Use the absolute `/c/Users/user/.claude/...` (or `$USERPROFILE`) when verifying anything under the profile from the Bash tool. Node's `os.homedir()` and PowerShell's `~` resolve correctly, so a hook can work fine while a Bash probe claims its config is gone. Bitten twice on 2026-07-28, in two sessions within the hour, both concluding the prose-lint kit had vanished when it was present and working.
- Never `--accept-routes` on a Tailscale node running `network_mode: host` within the advertised subnet — it routes the host's own LAN traffic into the tunnel, breaking all connectivity. The setting persists to the state file and survives container restarts.
- Docker networks with static IPs must define `ip_range` to restrict the IPAM dynamic pool — otherwise a container starting before the static-IP container can grab its address. Use a separate /24 for dynamic allocation.
- DHCP gateway must be inside the client subnet mask. IoT devices with minimal TCP stacks cannot route to an off-subnet gateway, even if the gateway is on the same L2 broadcast domain. If the subnet mask is narrower than the network, add a secondary IP to the router within the client's subnet range.
- Authentik server container needs `shm_size: 256m` — default 64MB fills from gunicorn worker IPC, causing SIGBUS crash loops
- PowerShell's collection handling breaks in both directions, and both failures read as a plausible wrong answer rather than an error. It collapses a single-element collection to a bare scalar, so wrap any pipeline or cmdlet output you will index, count, or iterate in `@()`. And it splits multi-line native-command output into a string ARRAY, where `.Contains("substring")` silently becomes an exact ELEMENT test and returns False for text that is plainly present — join with `-join "\`n"` (or `Out-String`) before any substring check. Bitten three times: `Where-Object` returning one hook serialized `"hooks": {...}` instead of `[...]`; `Get-Content -Tail` on a one-line transcript made `$lines[0]` return one character, which read as "context unknown" and disabled a guard hook; and `gh pr view --json body --jq .body | .Contains(...)` reported a PR body edit had not landed when it had, nearly triggering a duplicate write. The tell is the same each time: a boolean or a count that disagrees with what you can see in the raw output.
- The `@()` wrapping rule above has two failure modes of its own, and both produce a wrong value rather than an error. `@($null)` is a ONE-element array, not an empty one, so wrapping a source that can be null manufactures a phantom element: `$obj.PSObject.Properties.Name` on an empty `PSCustomObject` is `$null`, and `foreach ($k in @(...))` over it then runs one iteration with a null key. Filter with `| Where-Object { $_ }` wherever the source can be null. Separately, `@()` as a branch's only statement emits nothing for the branch to capture, so `$x = if ($c) { $a } else { @() }` assigns `$null` rather than an empty array; use a plain statement assignment, or `,@()`. Bitten four times on one branch in a single session, every time from code a plan supplied and every time with a green suite: an empty `env` object and an empty `mcpServers` in the exporter, an empty `hooks` object that broke 37 of 44 pre-existing tests and read as a regression in the task rather than a defect in the brief, and the `if/else` form, which crashed on ANY hook event installed for the first time. The tell is a loop body that runs once against an object you know is empty, or a variable that is null where you wrote a literal empty array.
- Any matcher that reads a repo file on Windows must be line-ending agnostic. With `core.autocrlf=true` and no `.gitattributes` rule for the extension, the index holds LF and the working tree holds CRLF, so `split("\n")` leaves a `\r` on every line and a regex anchored on `$` sits behind it. Use `/\r?\n/` and `\r?$`. Bitten three times in one repo: a whole-line `===` against a heading reported six drifted files that had not drifted (and the comparisons below it then passed vacuously, six empty strings being equal), a Pester `Should -Match '(?m)^\*$'` failed against a two-line fixture, and a case-handling divergence traced to the same cause. Fix the matcher, not the checkout: adding `text eol=lf` to `.gitattributes` renormalizes every existing clone to repair a test bug and leaves test correctness coupled to a git config value. MSYS `grep`/`sed`/`od` strip CR silently, so diagnose with `git ls-files --eol` or a node/bun read with `JSON.stringify`.
- Scrutiny-web does NOT support `file://` prefix in env vars — Viper passes the literal string as the token value. Use a standard env var from `.env` or a `scrutiny.yaml` config file instead.
- A scope filter that resolves empty must fail closed, never widen to the full population, and scope identity must come from an explicit caller-supplied value rather than being inferred from whether a filter is non-empty. Bitten four times in one reporting pipeline: the generator script deliberately keeps an empty subset non-null so its output comes back empty instead of silently widening to the full population (the one place that got it right); a downstream merge step consumed the newest metrics artifact with no scope check, feeding subset figures into a full-population report while provenance still read `present`; a list-building step under `bash -e` without `pipefail` goes green with an empty list, turning a narrow scoped run into a full-population one an order of magnitude larger, with live promotion un-gated; and a destination branch took its identity from whether the filter was non-empty, so every distinct ad-hoc filter shared one force-pushed branch. The boolean is the tell: a two-valued expression over an unbounded input domain cannot name a scope.
- Every timestamp is UTC at the point of formatting, not at the point of comparison. Bitten three times: `Get-Date` without `-AsUTC` in a failure-Issue title beside an `-AsUTC` body (different calendar day near midnight on a non-UTC runner), the same omission in a scheduled metrics workflow, and `[DateTimeOffset]::Parse` applied to a `ConvertFrom-Json` value that is already `[datetime] Kind=Utc`, which silently reinterprets it as local. Put `-AsUTC` on every `Get-Date`; parse type-aware (`[datetime]` → `ToUniversalTime()`, string → InvariantCulture + `AssumeUniversal`). Tests that compare formatted dates only discriminate on a non-UTC host, so a green suite is not evidence here.

**What is not an invariant:**
- A one-time migration step (belongs in MEMORY.md or commit history)
- A service-specific config value (belongs in the service's documentation)
- A fix for a bug that was patched upstream

## Session Close Protocol

Before ending any session with code or config changes:
1. **Commit last known good state** — all working changes must be in a commit before the session closes. Never leave uncommitted working changes.
2. **Push to remote** — ensure the commit is on GitHub, not just local.
3. **Sync production** — pull on TrueNAS if production was the work target.

## Temporary and Diagnostic Script Hygiene

Scripts that are not permanently deployed cron jobs or part of the stack must be cleaned up before any git commit or session close:
- Remove hardcoded secrets, tokens, passwords, and IPs before committing
- If a script is one-time or diagnostic, add it to `.gitignore` or delete it after use
- If a diagnostic script must exist temporarily, it must read secrets from files (`$(cat secrets/...)`) — never inline credentials
- Scripts that live in the repo permanently (cron jobs, monitoring scripts) must also read credentials from the secrets directory, not hardcode them

The test: before any `git add`, ask whether the file will run indefinitely as part of infrastructure. If yes, audit it for hardcoded secrets. If no, gitignore or delete it first.
