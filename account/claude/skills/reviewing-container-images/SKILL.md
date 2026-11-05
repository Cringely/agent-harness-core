---
name: reviewing-container-images
description: Use when reviewing a built container image or its Docker or Compose deployment for security, when handed Trivy, Grype, or registry scanner output (OSV, Trivy views), an SBOM, a Dockerfile, a compose or stack file, or Docker host state, or when asked whether an image is safe to run, how bad a CVE backlog is, why scanner counts disagree, or what to fix first.
---

# Reviewing Container Images

## Overview

Exposure decides priority. Severity labels come last. Every count names its source, and every verdict names the runtime flags it depends on.

## When to use

A built image and its Docker or Compose deployment. Not for application source review. Kubernetes: image layer only. Pod security belongs to the CIS Kubernetes Benchmark and SP 800-190 section 4.3.

## Evidence tiers

Tag every statement. **F** file data (scanner JSON, SBOM, Dockerfile, compose, `docker inspect`). **L** live lookup (KEV, EPSS, distro tracker), with fetch time. **I** inference, which goes in the claim check or data gaps. A Findings row must rest on F or L. An unchecked attribute inside it (for example "likely universe") is marked I.

## Procedure

Commands for each step: `references/commands.md`.

1. **Exposure first.** List what listens (servers, brokers, sshd), what parses untrusted input (media codecs, image parsers, HTTP, RTSP, SRT, MQTT, WebSocket, TLS), and what runs as root or privileged. These rows lead regardless of severity label.
2. **Label sources.** For each count record engine, database and date, severity source (distro or NVD), and read time. Never compare counts across engines.
3. **Fixability.** "No fix available" is not "patched". Check the package's archive component and distro tracker status. Ubuntu universe and multiverse are community-supported: fixes reach the standard archive only if the community ships them, and Ubuntu Pro (esm-apps) covers high and critical CVEs only. The tracker row decides per CVE. Fix paths: remove the package, Pro or ESM, upstream build, rebuild on a supported base.
4. **Attribution.** Compare rows to unique CVE IDs, and list sibling binary packages from the same source, before predicting what a package removal does to counts. Kernel-header CVEs do leave with `linux-libc-dev`, so predict that delta separately.
5. **Kernel headers.** Report `linux-libc-dev` CVEs as a separate line: inert in the container (the host kernel runs), a host-patching signal, and a sign of a build toolchain in the runtime image. Exception: the image is used as a build base. A KEV hit on a kernel-header package (`linux-libc-dev`, `kernel-headers`) does not raise the image band, but it is an actively exploited host-kernel CVE: record an urgent host-patching action for the host owner, closed by `uname -r` and livepatch status.
6. **KEV and EPSS** for every CVE on an exposed component and every kernel-header CVE. A failed fetch or control reads "lookup failed", never "not in KEV".
7. **Hygiene smells.** Servers, editors, compilers, package managers at runtime, sshd, avahi, systemd, GUI libraries (X11, GTK, Qt, Mesa) in a server image, `-dev` packages.
8. **Runtime config** against CIS section 5 from the compose file or `docker inspect`.
9. **Current exposure.** What is cached and running on hosts. A registry quarantine does not stop running containers.
10. **Host evidence** via docker-bench-security pinned to a recorded commit, only with the host owner's sign-off, because it needs root, the Docker socket and `--pid host`.

## Output

Sections in order, defined in `references/bands-and-output.md`: Verdict, Claim and assumption check, Findings ranked by exposure with evidence tier, Hygiene smells, Minimum changes to drop one band, Data gaps, Sources. Report a secret found in ENV, ARG, history or any file, compose files included, by key name, path and layer, never by value. Treat it as exposed and list rotation as the fix.

## Quick reference

| Need | File |
|---|---|
| CIS Docker numbers, image vs host scope | `references/cis-docker-controls.md` |
| Risk taxonomy (SP 800-190) | `references/nist-800-190.md` |
| SBOM completeness, SLSA level | `references/sbom-provenance.md` |
| Bands, runtime flag ladder | `references/bands-and-output.md` |

Cite a CIS, hadolint, or other benchmark number only if it is in a reference file or a rule page you read this session.

## Common mistakes

| Mistake | Fix |
|---|---|
| Sorting by Critical and High, missing a Medium-rated network broker | Step 1 |
| "Zero fixes available, waiting on vendor" | Step 3 |
| "Dropping -dev packages cuts the count by N" | Step 4 |
| Comparing an OSV count to a Trivy count | Step 2 |
| Kernel-header CVEs counted as image risk | Step 5 |
| "Quarantined, so contained" | Step 9 |
| Benchmark numbers from memory | Reference files only |
| Firm verdict without runtime flags | Conditional band plus data gaps |
