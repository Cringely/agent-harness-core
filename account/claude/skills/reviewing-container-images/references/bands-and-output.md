# Risk bands, runtime flag ladder, output sections

## Risk bands

The band is a function of the inputs below. Severity labels from a scanner are not an input.
Evaluate the steps in order and stop at the first predicate that holds. Step 4 has no predicate:
it takes everything steps 1 to 3 did not, so every combination of inputs lands in exactly one band
and no combination is left unmatched.

Inputs:

- **Exposed.** The container has a reachable listener or untrusted-input parser (defined below).
- **Per CVE**, kernel-header CVEs excluded (SKILL.md step 5). On an exposed component: the CVE sits
  in a listener or parser that is exposed. Triggerable: an untrusted party can trigger it through
  that listener or parser (memory safety, auth bypass, injection, deserialization, path traversal,
  SSRF, request smuggling, or another remote-impact class). Exploit evidence: in CISA KEV or public
  exploit code exists.
- **Flags** from the runtime flag ladder below, by level.
- **Secrets.** Each env entry and build step from `commands.md` steps 1 and 8, read as literal (an
  entry with value `literal` and secret not `none`, or a step whose `secret-like` includes
  `key-material` or `secret-assignment`), reference (value `reference`, secret `name`), or
  candidate (a step whose `secret-like` is only `secret-word` or `opaque`). `empty` and `none` set
  nothing.

| Step | Band | Predicate (any one) |
|---|---|---|
| 1 | Critical | (a) A CVE on an exposed component that is triggerable and has exploit evidence. (b) A Critical-row flag other than plaintext secrets, and exposed. (c) A literal secret in the image or compose file, exposed or not. |
| 2 | High | (a) A CVE on an exposed component that is triggerable. (b) A Critical-row flag other than plaintext secrets. (c) A High-row flag other than root and `no-new-privileges` not set, and exposed. |
| 3 | Medium | (a) Any CVE. (b) Any High-row or Medium-row flag, root and `no-new-privileges` not set included. (c) A secret read as reference. |
| 4 | Low | Everything else: no CVE outside kernel headers, no flag above Low, no literal or referenced secret. |

Consequences of the order, stated so nobody re-derives them. Exploit evidence lifts only a CVE that
already passes step 2(a). A KEV entry on a CVE that is not triggerable, or not on an exposed
component, stays at step 3. A Critical-row flag without exposure stops at step 2. A High-row flag
without exposure, and root or `no-new-privileges` not set with or without exposure, stop at step 3.

"Reachable" means: the process runs in the deployed container, listens or parses data an untrusted
party controls, and the port is published or reachable on a network you cannot vouch for.

Data gaps holds missing inputs only, never an unmatched case, since there is none. An input is
missing when the scan is absent or failed its control, a KEV lookup failed, runtime data for
reachability or flags is absent, or a build step is a candidate. For each missing input, run the
table under each value it can take and state the band per value ("Medium if not published, High if
published", or "Critical if layer 3 holds a secret, Medium if not"), then put the input in the gaps
table with the artifact that closes it. EPSS is not a band input. A failed EPSS lookup is a gap in
the ranking, not in the band.

## Runtime flag ladder (Docker and Compose)

Adapted from the Findings Classification table in UnitOneAI/SecuritySkills
`skills/cloud/container-security/SKILL.md` at commit 70bc259bb01abb3015ad2ad859ad5253cbf0bcab,
MIT License, Copyright (c) 2025 UnitOne.ai. Changes: Kubernetes-only rows removed, Docker and Compose
flag names added, CIS numbers added from `cis-docker-controls.md`, and seccomp moved from Medium to
High because Docker applies a default profile, so `seccomp=unconfined` is an explicit removal.

| Level | Flag or condition (CIS Docker number) |
|---|---|
| Critical | `privileged: true` (5.5). Docker socket mounted (5.32). `pid: host` (5.16) or `network_mode: host` (5.10) on an app container. Secrets in plaintext in the image or compose file, meaning a secret read as literal (4.10). |
| High | Runs as root (4.1). `cap_add` of SYS_ADMIN, NET_ADMIN, SYS_PTRACE or ALL (5.4). Sensitive host directories mounted (5.6). `no-new-privileges` not set (5.26). `seccomp=unconfined` (5.22). AppArmor or SELinux disabled (5.2, 5.3). Host devices passed through (5.18). |
| Medium | Ports published on all interfaces instead of a specific host IP (5.14). No memory or PIDs limit (5.11, 5.29). Writable root filesystem (5.13). Mutable image tag in compose. Secrets passed as environment variables, meaning a secret read as reference. |
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
