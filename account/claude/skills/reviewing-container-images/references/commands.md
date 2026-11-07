# Commands for each review step

Headings match the step numbers in SKILL.md. Step 7 (hygiene) uses the file listing from step 1. Step 10 (docker-bench) is in `cis-docker-controls.md`.

Read an empty result as absence only after a control on the same input. The KEV feed's `count` field is over 1000 and it lists CVE-2021-44228. `files.txt` lists `bin/sh` or the known entrypoint. The same Packages.gz lookup returns a Section for a package known to be in that component. The EPSS response returns a score for a known CVE. The Trivy report `R` gives a number for step 4's row count. `docker ps -q` is non-empty. A fetch or control that fails reads as "lookup failed", never as "not in KEV" or "not present".

`IMG` is an image reference, `C` a container name or ID, `R` a Trivy JSON report
(`trivy image -f json -o R IMG`). Commands that touch a host need the host owner's agreement.

## Step 1. Exposure triage

Image config without running it. Env, ARG and build-step values print as key names only, so no
secret value reaches the transcript:

```sh
docker image inspect IMG | jq '.[0].Config | {User, ExposedPorts, Entrypoint, Cmd, Healthcheck,
  EnvKeys: [.Env[]? | split("=")[0]]}'
# Build steps. A step holding KEY=value prints as its instruction plus key names, values cut.
docker history --no-trunc --format '{{.CreatedBy}}' IMG | awk '
  !/=/ { print; next }
  { out = $1; s = $0
    while (match(s, /[A-Za-z_][A-Za-z0-9_]*=/)) { out = out " " substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH) }
    print out " (values hidden)" }'
docker history --no-trunc --format '{{.CreatedBy}}' IMG | grep -nE '(curl|wget)[^|]*[|] *(ba)?sh' | cut -d: -f1   # pipe-to-shell steps, by line
```

File listing without running the image:

```bash
set -o pipefail; rm -f files.txt        # a failed create must not leave the last run's listing behind
if cid=$(docker create IMG); then
  docker export "$cid" | tar -tv > files.txt; rc=$?
  docker rm "$cid" > /dev/null
  [ "$rc" -eq 0 ] || { rm -f files.txt; echo "export failed, stop and read the error above"; }
else
  echo "docker create failed, stop and read the error above"
fi
if [ -s files.txt ]; then                # the greps run only when the listing exists
  grep -E 'bin/(sshd|mosquitto|nginx|httpd|avahi-daemon|cupsd|vsftpd|telnetd|rpcbind)$' files.txt
  grep -E '^-..[sS]|^-.....[sS]' files.txt  # setuid and setgid files (CIS 4.8), S is the bit without execute
else
  echo "no files.txt, nothing below this line may be read"
fi
```

What actually listens, on a host where the container runs (root on the host):

```sh
pid=$(docker inspect -f '{{.State.Pid}}' C) && sudo nsenter -t "$pid" -n ss -ltnup
```

Parsers of untrusted input: search the package list for media codecs (ffmpeg, libav*, gstreamer
plugins), image parsers (libpng, libjpeg, libtiff, libwebp, ImageMagick), HTTP, RTSP, SRT, MQTT,
WebSocket, TLS, XML and JSON libraries, then confirm the app feeds them network or user data.

## Step 2. Source labeling

```sh
trivy version                 # prints the vulnerability DB version and UpdatedAt
grype db status               # prints the Grype DB build date
jq -r '[.Results[].Vulnerabilities[]?.SeveritySource] | group_by(.) | map("\(.[0]) \(length)") | .[]' R
jq -r '[.Results[].Vulnerabilities[]?.DataSource.Name] | group_by(.) | map("\(.[0]) \(length)") | .[]' R
```

For a registry UI or API, record which engine the view uses (OSV, Trivy, vendor), the page or
endpoint, and the time you read it. OSV-backed views re-evaluate continuously, so the same image can
show different counts an hour apart.

To reconcile two views of the same image, confirm both point at the same digest, export each CVE list
with its severity and severity source, and diff the ID sets. Report the difference by cause (engine,
severity source, read time), not as one view being wrong.

## Step 3. Fixability and archive support status

```sh
jq -r '[.Results[].Vulnerabilities[]?.Status] | group_by(.) | map("\(.[0]) \(length)") | .[]' R
```

Trivy documents only `fixed` and `affected` for Ubuntu (Debian adds `fix_deferred` and
`end_of_life`, RHEL has more). On Ubuntu, `affected` with no FixedVersion does not tell you whether a
fix is pending upstream, available only through Ubuntu Pro, or will never ship. Check the archive
component, from the archive index first, without running the image. The Packages index for each
component of the release (`jammy`, `noble`, and so on) lists the package with its Section. Fetch it
over https only, never plain http, because an unverified index can be swapped in transit:

```sh
curl -fsS https://archive.ubuntu.com/ubuntu/dists/RELEASE/universe/binary-amd64/Packages.gz | zcat | grep -A12 '^Package: PKG$' | grep -m1 '^Section'
```

A hit in `universe/` means community-maintained. No hit there: try `main`, then `multiverse`. A
Section starting `universe/` or `multiverse/` means community-maintained. Fixes come from community
uploads, or through Ubuntu Pro (esm-apps) for high and critical CVEs only. Read the tracker row for
each CVE.

Fallback when the index lookup fails: read the package lists already inside the image, with no
network. Never run the image under review with network access. Slim images often delete their lists,
so an empty result here reads as "lookup failed":

```sh
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --entrypoint sh IMG -c 'apt-cache policy PKG && apt-cache show PKG | grep -m1 ^Section'
```

A `.../universe` or `.../multiverse` source line means community-maintained. On a host with the Pro client, `pro security-status --esm-apps` lists them. Then read the
package row in the distro tracker (Ubuntu: ubuntu.com/security/CVE-ID. Debian:
security-tracker.debian.org/tracker/CVE-ID).

## Step 4. Attribution check (before predicting count changes)

```sh
jq '[.Results[].Vulnerabilities[]?] | length' R                                  # rows
jq '[.Results[].Vulnerabilities[]?.VulnerabilityID] | unique | length' R         # unique CVE IDs
jq -r '.Results[].Vulnerabilities[]? | select(.VulnerabilityID=="CVE-ID") | .PkgName' R
```

Rows greater than unique IDs means the tool lists one row per affected binary package. Equal means
each CVE sits on one package, and removing that package may move the CVE to a sibling built from the
same source (for example a `-dev` package and its runtime library). Check with
`jq -r '.Results[].Vulnerabilities[]? | "\(.VulnerabilityID) \(.PkgName) \(.PkgIdentifier.PURL)"' R`
and list every binary package from the same source before predicting a delta.

`linux-libc-dev` is the exception: its kernel CVEs have no runtime sibling in a normal image, so they
leave with the package. Predict the kernel-header delta and the other `-dev` delta as two numbers.
Without a per-package breakdown, give only the kernel-header count as a firm number and mark the rest
unknown.

## Step 5. Kernel headers

```sh
jq -r '.Results[].Vulnerabilities[]? | select(.PkgName=="linux-libc-dev") | .VulnerabilityID' R | sort -u | wc -l
```

Count them separately. Then check whether the image is used as a build base (`FROM IMG` in other
Dockerfiles, or a compiler in the file list).

## Step 6. KEV and EPSS lookups

```sh
curl -fsS https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json -o kev.json &&
  jq -e '.count > 1000' kev.json > /dev/null &&
  jq -r '.vulnerabilities[].cveID' kev.json | sort > kev.txt &&
  grep -qx CVE-2021-44228 kev.txt ||
  {
    rm -f kev.json kev.txt
    echo "KEV lookup failed"
  }
jq -r '.catalogVersion, .dateReleased' kev.json
jq -r '.Results[].Vulnerabilities[]?.VulnerabilityID' R | sort -u | comm -12 - kev.txt   # CVEs in KEV

# CVE-2021-44228 rides along in every request as the control. The API pages at 100 rows by default,
# so ask in chunks of 50 with an explicit limit, then diff requested IDs against returned IDs.
jq -r '.Results[].Vulnerabilities[]?.VulnerabilityID' R | sort -u > cves.txt
rm -f epss.txt cvechunk.*; split -l 50 cves.txt cvechunk.
for f in cvechunk.*; do
  list=$(printf 'CVE-2021-44228\n'; cat "$f"); list=$(echo "$list" | paste -sd, -)
  curl -fsS "https://api.first.org/data/v1/epss?limit=100&cve=$list" -o epss.json &&
    jq -e '.data[] | select(.cve=="CVE-2021-44228") | .epss' epss.json > /dev/null &&
    jq -e '.total == (.data | length)' epss.json > /dev/null &&
    jq -r '.data[] | "\(.cve) \(.epss) \(.percentile) \(.date)"' epss.json >> epss.txt ||
    echo "EPSS lookup failed for chunk $f"
done
cut -d' ' -f1 epss.txt | sort -u | comm -23 cves.txt -    # CVEs with no EPSS row
```

Any chunk that printed "EPSS lookup failed", and every CVE the last `comm` line prints, is reported as not looked up, never as a low score.

A failed block removes `kev.json` and `kev.txt`, so the `comm` line errors instead of printing an empty
result. Record the KEV `catalogVersion` and the EPSS `date` with the result.

Run the same lookup over the kernel-header CVEs from step 5. A KEV hit there is a host-patching action
(SKILL.md step 5), not a band change.

## Step 8. Runtime configuration (CIS section 5)

```sh
# Merged compose, overrides applied, projected to the runtime fields. Environment prints as key names
# only, and top-level secrets as their source kind (file, environment), never their values.
docker compose -f FILE config --no-interpolate --format json | jq '{
  services: (.services | map_values({image, user, privileged, cap_add, network_mode, pid, ipc,
    userns_mode, volumes, ports, read_only, security_opt, devices, mem_limit, pids_limit, deploy,
    env_file, env_keys: (.environment // {} | keys)})),
  secrets: (.secrets // {} | map_values(keys))}'
docker inspect C --format '{{json .HostConfig}}'    # Privileged, CapAdd, NetworkMode, PidMode, IpcMode,
                                                    # UsernsMode, Binds, PortBindings, ReadonlyRootfs,
                                                    # SecurityOpt, Devices, Memory, PidsLimit
docker inspect C --format '{{.Config.User}}'
# Docker socket reach (Critical, 5.32): the socket itself, or a directory that holds it (/, /run,
# /var/run) bound in. Reads every mount source, from Mounts, HostConfig.Mounts and HostConfig.Binds.
docker inspect $(docker ps -q) | jq -r '.[] | .Name as $n |
  ([.Mounts[]?.Source] + [.HostConfig.Mounts[]?.Source] + [.HostConfig.Binds[]? | split(":")[0]])
  | unique | .[] | $n + " " + .' | grep -E ' (/|/run/?|/var/run/?|/.*docker[.]sock)$'
```

## Step 9. What is running now

```sh
docker image ls --digests
docker ps --format '{{.ID}} {{.Image}} {{.Status}} {{.Ports}}'
docker inspect --format '{{.Name}} {{.Image}}' $(docker ps -q)     # image ID each container runs
```

A registry quarantine or block stops new pulls. It does not stop a container already running, or a
restart from the image already cached on the host.
