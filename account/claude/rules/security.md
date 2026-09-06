# Security Standards

Applies CIS Controls v8, NIST CSF, OWASP Top 10, and SLSA proportionally. This is a homelab, not a SOC, but the principles are not optional.

## Default Posture

Security controls apply from the start, not as a follow-up. If a task would introduce a known weakness, flag it before proceeding.

## Least Privilege

Every access grant should be the minimum needed.

- Containers: `no-new-privileges`, `cap_drop: ALL`, `read_only: true` where feasible
- API tokens: scoped to the resource/action they need
- Network: services only on required networks; databases never on front network
- File permissions: `0644` for bind-mount Docker secrets (non-root UIDs can't read 0600); `0600` for host-only secrets

## Identifying Information Never Reaches a Remote Repo

Mandate, 2026-09-05. Never provide identifying information to a remote repository. **Only a human
can override this.** An agent may not waive it, may not decide a particular case is harmless, and
may not treat a prior push as precedent for the next one.

Identifying information means the operator's legal name, personal email addresses, the workstation
username, absolute paths that contain any of them, machine and host names, and anything else that
ties the work to a person or a physical machine. It covers every channel a repo carries, not only
file contents:

- **Commit metadata.** `user.name` and `user.email` on both author and committer, and the two fields
  fail independently. This is the channel that gets missed, because scrubbing file content leaves it
  untouched — a content-only scan of this repo on 2026-09-05 reported clean while 30 commits carried
  a real name in both the author and committer fields. Their email was already the noreply address
  on every one of the 30, which is exactly why the leak survived: a repo can be clean on the field
  people check and dirty on the field beside it. Scan for the name and the email separately.
- **File contents**, including generated payloads and vendored trees.
- **Commit messages**, which `git-filter-repo --replace-text` does not rewrite; that needs
  `--message-callback`.
- **Branch names, tags, PR and issue text.**

The identity for public work is a GitHub noreply address under a pseudonymous handle. Set it per
repo (`git config --local`) rather than relying on the global value: a global that carries a real
name is silently inherited by every repo without a local override, on every commit.

**Before any push to a remote, verify both channels.** Content:
`git grep -I -l -i -e <name> -e <username> -e <email>`. Metadata:
`git log --format='%an <%ae> | %cn <%ce>' <upstream>..HEAD | sort -u`. A clean content scan is not
evidence about metadata, and neither is a clean metadata scan about content.

A generator that produces a payload for a public repo carries this as a gate, not a convention. It
must refuse to write a payload containing identifying strings rather than trusting that a scrub
happened somewhere upstream — a one-time external cleanup leaves the generator able to reintroduce
what was removed, with nothing to catch it.

## Secrets

Never hardcode credentials, tokens, keys, or sensitive IPs in any file. Applies to scripts, configs, changelogs, commits, docs, and comments.

- Shell: `TOKEN=$(cat /path/to/secrets/token_file)`
- Docker Compose: `secrets:` bind-mounts and `_FILE` env var suffixes
- `.env` files: non-sensitive config only (UIDs, paths, domains). Passwords and tokens go in `secrets/`
- Logging: never write credential values. Log `token=loaded` not `token=abc1234...`
- Backup files: delete `.bak.*` once the change is confirmed stable

## Secure Configuration

- New containers: hardened template (`no-new-privileges`, `cap_drop: ALL`, `read_only: true`); relax only with justification
- New services behind proxy: require auth middleware by default
- Exposed ports: bind to specific interface IP, not `0.0.0.0`, unless documented
- Default credentials: change or disable before first use

## Input Validation and Injection Prevention

Any code accepting external input (CLI args, files, env vars, network) must validate before use.

- Allowlist over denylist. Validate type, length, format, range
- Never build shell commands by string concatenation — use arrays, avoid `eval`
- In Python: `subprocess` with a list, never `shell=True` with external input
- In SQL: parameterized queries only
- Validate and canonicalize file paths; reject `..` traversal

## Supply Chain

- Docker images: pin to specific version (`image:1.2.3`), prefer digest (`@sha256:...`). Never `:latest` in production
- Never pipe curl to bash. Verify checksums before executing downloaded scripts
- Keep build/deploy scripts in version control. Production state must be reproducible from git

## Defense in Depth

No single control should be the only barrier. Pair native app auth with SSO forwardAuth. IP allowlists alone are not authentication.

## Pre-Work Security Check

Before any new script, service config, or infrastructure change:

1. Does this introduce a hardcoded credential or sensitive value?
2. Does this expose a port, path, or API that wasn't exposed before?
3. Does this grant more access than the task requires?
4. Would anything sensitive be visible if committed to a public repo?
5. Is there a backup/rollback path if this creates a security regression?

## Homelab Proportionality

- **Always apply**: least privilege, secrets hygiene, no default credentials, network segmentation, secure config defaults
- **Production services** (SSO, reverse proxy, databases, monitoring): defense in depth, auth on all paths
- **Accepted tradeoffs**: `insecureSkipVerify` for self-signed LAN backends (documented), `privileged` only where required (documented)
- **Skip**: formal risk register, audit trails for every read, automated compliance scanning
