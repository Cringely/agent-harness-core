# Commands for each review step

Headings match the step numbers in SKILL.md. Step 7 (hygiene) uses the file listing from step 1. Step 10 (docker-bench) is in `cis-docker-controls.md`.

Read an empty result as absence only after a control on the same input. The KEV feed's `count` field is over 1000 and it lists CVE-2021-44228. `files.txt` lists `bin/sh` or the known entrypoint. The same Packages.gz lookup returns a Section for a package known to be in that component. The EPSS response returns a score for a known CVE. The Trivy report `R` gives a number for step 4's row count. `docker ps -q` is non-empty. A fetch or control that fails reads as "lookup failed", never as "not in KEV" or "not present".

`IMG` is an image reference, `C` a container name or ID, `R` a Trivy JSON report
(`trivy image -f json -o R IMG`). Commands that touch a host need the host owner's agreement.

## Step 1. Exposure triage

Image config and build history without running the image. Output is an allowlist, not a
redaction: what prints is a key name, a layer size, a created timestamp, or a word from a fixed
vocabulary. Build-step text, env values, argv strings and healthcheck commands are matched against
patterns and never printed, whatever they contain. A field that fails its format check prints
`(unparsed)` or `(hidden)`. Never print `CreatedBy`, `Comment`, `Env`, `Entrypoint`, `Cmd`,
`Healthcheck` or `Labels` raw to work around a `(hidden)`.

Write the views module once per review, in the working directory:

```sh
cat > review.jq <<'EOF'
# Allowlist views. Every string printed is a key name, a size, a timestamp or a word from a
# fixed vocabulary. Build-step text, env values and argv strings are only tested, never printed.
def secret_name: test("passw(or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|(^|_)auth$"; "i") and (test("_file$"; "i") | not);
def classes:
  gsub("(file|dir|sha256):[0-9a-f]{64}|\\b[0-9a-f]{64}\\b|\\b[0-9a-f]{128}\\b"; "") as $t
  | [ (if ($t | test("-----BEGIN|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|glpat-|xox[abposr]-|AKIA[0-9A-Z]{16}|://[^/@ :]+:[^/@ ]+@|[Bb]earer +[A-Za-z0-9._~+/=-]{8,}")) then "key-material" else empty end),
      (if ($t | test("(passw(or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*(?<!_file)=\"?[^ $\"]"; "i")) then "secret-assignment" else empty end),
      (if ($t | test("passw(or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization"; "i")) then "secret-word" else empty end),
      (if ($t | test("(?=[A-Za-z0-9_+]*[0-9])(?=[A-Za-z0-9_+]*[A-Za-z])[A-Za-z0-9_+]{32,}")) then "opaque" else empty end) ]
  | if length == 0 then "none" else join(",") end;
def keyname: if test("^[A-Za-z_][A-Za-z0-9_.-]{0,127}$") then . else "(unparsed)" end;
def vclass:
  if . == null then "reference"
  elif tostring == "" then "empty"
  elif tostring | test("^\\$[A-Za-z_][A-Za-z0-9_]*$|^\\$\\{[A-Za-z_][A-Za-z0-9_]*(:?[?][^}]*|:?-)?\\}$") then "reference"
  else "literal" end;
def env_line($k; $v):
  ($v | vclass) as $c
  | ([ (if $k | secret_name then "name" else empty end),
       (if $c == "literal" then ($v | tostring | classes | split(",")[] | select(. == "key-material" or . == "secret-assignment")) else empty end) ]
     | if length == 0 then "none" else join(",") end) as $s
  | "\($k | tostring | keyname) value=\($c) secret=\($s)";
def env_pairs:
  if type == "array" then .[] | tostring | (index("=")) as $i
    | if $i == null then {key: ., value: null} else {key: .[:$i], value: .[$i + 1:]} end
  else to_entries[] end;
def keyword:
  sub("^/bin/sh -c #\\(nop\\) +"; "") as $s
  | ([$s | capture("^(?<k>[A-Z]+)( |$)") | .k] | first) as $k
  | if $k != null and any("ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "HEALTHCHECK",
        "LABEL", "MAINTAINER", "ONBUILD", "RUN", "SHELL", "STOPSIGNAL", "USER", "VOLUME", "WORKDIR"; . == $k)
    then $k
    elif $s | test("^([|][0-9]+ |/bin/sh -c )") then "RUN"
    else "OTHER" end;
def arg_name:
  [sub("^/bin/sh -c #\\(nop\\) +"; "") | sub("^ARG +"; "") | capture("^(?<n>[A-Za-z_][A-Za-z0-9_]*)(=| |$)") | .n]
  | first // "(unparsed)";
def argv:
  if . == null then null else
  { program: ((.[0] // "") | tostring | split("/") | last
      | if test("^[A-Za-z0-9._+-]{1,64}$") and classes == "none" then . else "(hidden)" end),
    args: (length - 1),
    shell_form: ((.[0] // "" | tostring | test("(^|/)(ba|da|a)?sh$")) and .[1] == "-c"),
    secret_like: (map(tostring) | join(" ") | classes) } end;
def history_view:
  to_entries[] | .key as $i | .value | (.CreatedBy // "" | tostring) as $c | ($c | keyword) as $k
  | [ "layer=\($i)",
      "created=\(.CreatedAt // "" | tostring | if test("^[0-9][0-9 :.TZ+-]{0,40}(UTC)?$") then gsub(" "; "_") else "(unparsed)" end)",
      "size=\(.Size // "" | tostring | if test("^[0-9.]{1,12} ?[kKMGTP]?i?B?$") then gsub(" "; "") else "(unparsed)" end)",
      $k,
      (if $k == "ARG" then "name=\($c | arg_name)" else empty end),
      "secret-like=\($c | classes)",
      "pipe-to-shell=\(if $c | test("(curl|wget)[^|]*[|] *(ba)?sh") then "yes" else "no" end)" ]
  | join(" ");
def inspect_view:
  .[0].Config | {
    User: (.User // "" | tostring
      | if . == "" then "(unset, runs as root)"
        elif test("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$") then .
        else "(unparsed)" end),
    ExposedPorts: [(.ExposedPorts // {}) | keys[] | if test("^[0-9]{1,5}(-[0-9]{1,5})?/(tcp|udp|sctp)$") then . else "(unparsed)" end],
    Entrypoint: (.Entrypoint | argv),
    Cmd: (.Cmd | argv),
    Healthcheck: (if .Healthcheck == null then "none"
      else "present, secret-like=\(.Healthcheck.Test // [] | map(tostring) | join(" ") | classes)" end),
    Env: [(.Env // []) | env_pairs | env_line(.key; .value)] };
def compose_view: {
  services: (.services | map_values({image, user, privileged, cap_add, network_mode, pid, ipc,
    userns_mode, volumes, ports, read_only, security_opt, devices, mem_limit, pids_limit, deploy,
    env_file, environment: [(.environment // {}) | env_pairs | env_line(.key; .value)]})),
  secrets: (.secrets // {} | map_values(keys)) };
EOF
```

Then:

```sh
docker image inspect IMG | jq -L . 'include "review"; inspect_view'
# One line per layer, newest first: layer index, created, size, instruction keyword, the ARG name
# for an ARG step, the secret-like classes, and whether the step pipes a download to a shell.
# The step text is never printed. JSON format keeps a multi-line (heredoc) step on one record.
docker history --no-trunc --format '{{json .}}' IMG | jq -rs -L . 'include "review"; history_view'
```

Reading the output:

- **Env entries** read `KEY value=CLASS secret=REASONS`. CLASS is `literal`, `empty` or
  `reference` (a lone `$VAR` or `${VAR}`, or a key passed through with no value). A `${VAR:-x}`
  with a non-empty default is `literal`, because the default is written in the file. REASONS is
  `name` (the key looks like a credential name, `*_FILE` keys excepted), `key-material` or
  `secret-assignment` (found in a literal value), or `none`.
- **`secret-like` on a step, an argv or a healthcheck** lists the classes it matched.
  `key-material` (a private key header, a known token prefix, credentials in a URL, a bearer token)
  and `secret-assignment` (a credential-named key set to a non-empty literal) count as a literal
  secret. `secret-word` (a credential word with no value beside it) and `opaque` (a long
  mixed letter-and-digit string, sha256 and sha512 digests excepted) mark a candidate the pattern
  cannot settle. `none` means no pattern matched, which is not evidence that no secret is there.
- `name=` on an ARG step is the first name the instruction declares. Further names in the same
  instruction are not printed. Their values still feed that step's `secret-like`.
- `program` is the basename of argv[0], or `(hidden)`. With `shell_form: true` the real program
  is inside the hidden `-c` string. Find it from the file listing, the Dockerfile, or the process
  table in a running container.

Report a literal secret by key name, or by layer index and class, never by value.

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
# Merged compose, overrides applied, projected to the runtime fields with review.jq from step 1.
# Each environment entry prints as KEY value=CLASS secret=REASONS (step 1 explains both), so a
# plaintext secret and a variable reference are told apart without printing either. Top-level
# secrets print as their source kind (file, environment). command, entrypoint and labels are not
# projected, so their text never prints.
docker compose -f FILE config --no-interpolate --format json | jq -L . 'include "review"; compose_view'
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
