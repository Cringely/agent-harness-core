# Risk bands, runtime flag ladder, output sections

## Risk bands

Assign the band from exposure and runtime, then adjust for exploit evidence. Severity labels from a
scanner do not set the band.

| Band | Predicate (any one) |
|---|---|
| Critical | A reachable listener or untrusted-input parser has a CVE in CISA KEV or with public exploit code. Or a flag from the Critical row below is set on a container with a reachable listener or untrusted-input parser. Or plaintext secrets are in the image or compose file, whatever is reachable. |
| High | A reachable listener or parser has a memory-safety or auth-bypass CVE with no KEV entry. Or the container has at least one High-row flag other than root and `no-new-privileges`, and has a reachable listener or parser. |
| Medium | Vulnerable packages exist but none is reachable from a listener or parser on the evidence you hold. Or hardening gaps from the Medium row with no reachable vulnerable component. |
| Low | No reachable vulnerable component, non-root, no flags above Low. |

A Critical-row flag other than plaintext secrets, with no reachable listener or parser, sets High. A
High-row flag with no reachable listener or parser sets Medium. Root with a reachable listener and no
other High flag is Medium. When predicates for more than one band match, the highest applies. If none
matches, the band is Medium and the unmatched case goes in Data gaps.

"Reachable" means: the process runs in the deployed container, listens or parses data an untrusted
party controls, and the port is published or reachable on a network you cannot vouch for. Without
runtime data, state the band per case ("Medium if not published, High if published") and put the
missing data in the gaps table.

## Runtime flag ladder (Docker and Compose)

Adapted from the Findings Classification table in UnitOneAI/SecuritySkills
`skills/cloud/container-security/SKILL.md` at commit 70bc259bb01abb3015ad2ad859ad5253cbf0bcab,
MIT License, Copyright (c) 2025 UnitOne.ai. Changes: Kubernetes-only rows removed, Docker and Compose
flag names added, CIS numbers added from `cis-docker-controls.md`, and seccomp moved from Medium to
High because Docker applies a default profile, so `seccomp=unconfined` is an explicit removal.

| Level | Flag or condition (CIS Docker number) |
|---|---|
| Critical | `privileged: true` (5.5). Docker socket mounted (5.32). `pid: host` (5.16) or `network_mode: host` (5.10) on an app container. Secrets in plaintext in the image or compose file (4.10). |
| High | Runs as root (4.1). `cap_add` of SYS_ADMIN, NET_ADMIN, SYS_PTRACE or ALL (5.4). Sensitive host directories mounted (5.6). `no-new-privileges` not set (5.26). `seccomp=unconfined` (5.22). AppArmor or SELinux disabled (5.2, 5.3). Host devices passed through (5.18). |
| Medium | Ports published on all interfaces instead of a specific host IP (5.14). No memory or PIDs limit (5.11, 5.29). Writable root filesystem (5.13). Mutable image tag in compose. Secrets passed as environment variables. |
| Low | No HEALTHCHECK (4.6, 5.27). ADD instead of COPY (4.9). |

## Output sections, in this order

1. **Verdict.** One line: band, confidence (high, medium, low), and the conditions. Shape:
   "High, medium confidence. Holds if port 1883 is published. Drops to Medium if the entrypoint does
   not start the broker. Rises to Critical with `privileged: true` or the Docker socket mounted."
2. **Claim and assumption check.** One row per claim the requester or a prior review made: claim,
   verdict (holds, does not hold, unverified), evidence and tier.
3. **Findings ranked by exposure.** Columns: rank, component and version, exposure class (listener,
   parser, privilege, none found), CVE or issue, source (engine, DB date, severity source), KEV and
   EPSS, fix path (upgrade, Pro or ESM only, remove package, upstream build, none), evidence tier.
   Rank by exposure class first, KEV second, EPSS third, severity label last.
4. **Hygiene smells.** Packages that do not belong in a runtime image, each with what it adds.
5. **Minimum changes to drop one band.** The smallest set, each tied to the finding it removes.
6. **Data gaps.** Columns: gap, artifact or command that closes it, which band decision it affects.
7. **Sources.** Every count with engine, database or feed version, severity source, and read time.
