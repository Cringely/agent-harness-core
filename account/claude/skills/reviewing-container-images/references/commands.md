# Commands for each review step

Headings match the step numbers in SKILL.md. Step 7 (hygiene) uses the file listing from step 1. Step 10 (docker-bench) is in `cis-docker-controls.md`.

Read an empty result as absence only after a control on the same input. The KEV feed's `count` field is over 1000 and it lists CVE-2021-44228. `files.txt` lists `bin/sh` or the known entrypoint. The same Packages.gz lookup returns a Section for a package known to be in that component. The EPSS response returns a score for a known CVE. The Trivy report `R` gives a number for step 4's row count. `docker ps -q` is non-empty. A fetch or control that fails reads as "lookup failed", never as "not in KEV" or "not present".

`IMG` is an image reference, `C` a container name or ID, `R` a Trivy JSON report
(`trivy image -f json -o R IMG`). Commands that touch a host need the host owner's agreement.

## Step 1. Exposure triage

Image config and build history without running the image. Output is an allowlist, not a
redaction. Build-step text, env values, env_file lines, argv strings and healthcheck commands are
matched against patterns and print only as a class, whatever they contain. Labels, logging options
and mount driver options are not read at all. The module header below lists what does print. A
field that fails its format check prints `(unparsed)` or `(hidden)`. Never print a field raw to
work around a `(hidden)`. Every `docker image inspect`, `docker inspect`, `docker history`,
`docker image ls` and `docker compose config` in this file goes through a view in this module,
except the `{{.State.Pid}}` lookup below, which puts a number in a shell variable. An env file is
never read except through `envfile_view` (step 8).

Write the views module once per review, in the working directory:

```sh
cat > review.jq <<'EOF'
# Allowlist views for steps 1, 8 and 9. Never printed: build-step text, env values, env_file lines,
# argv strings and healthcheck commands, which print only as a class, and labels (deploy.labels
# included), logging options and mount driver options, which no view reads. Printed after a
# format check, as "(unparsed)" or "(hidden)" when the check fails: key names, sizes, timestamps,
# the image or container user, exposed and published ports, the argv[0] basename, image references
# and IDs, container names,
# env_file paths and docker socket mount paths. Printed unchecked, because the flag ladder reads
# them and they hold flags and host paths rather than free text: compose image and user,
# privileged, cap_add, namespace modes, volumes and binds, devices, security_opt, limits, and
# deploy mode, replicas, placement, resources and restart_policy.
def secret_name: test("passw(or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|(^|_)auth$|(^|_)(pass|pwd)(_|$)"; "i")
  and (test("_file$"; "i") | not) and (test("^(old)?pwd$"; "i") | not);
def classes:
  gsub("(file|dir|sha256):[0-9a-f]{64}|\\b[0-9a-f]{64}\\b|\\b[0-9a-f]{128}\\b"; "") as $t
  | [ (if ($t | test("-----BEGIN|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|glpat-|xox[abposr]-|AKIA[0-9A-Z]{16}|://[^/@ :]+:[^/@ ]+@|[Bb]earer +[A-Za-z0-9._~+/=-]{8,}")) then "key-material" else empty end),
      (if ($t | test("((passw(or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*(?<!_file)|[A-Za-z0-9]_(pass|pwd))=\"?[^ $\"]"; "i")) then "secret-assignment" else empty end),
      (if ($t | test("passw(or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization"; "i")) then "secret-word" else empty end),
      (if ($t | test("(?=[A-Za-z0-9_+]*[0-9])(?=[A-Za-z0-9_+]*[A-Za-z])[A-Za-z0-9_+]{32,}")) then "opaque" else empty end) ]
  | if length == 0 then "none" else join(",") end;
# A 24-character run with no separator is a value fragment, not a variable name.
def keyname: if test("^[A-Za-z_][A-Za-z0-9_.-]{0,127}$") and (test("[A-Za-z0-9]{24,}") | not) then . else "(unparsed)" end;
def vclass:
  if . == null then "reference"
  elif tostring == "" then "empty"
  elif tostring | test("^\\$[A-Za-z_][A-Za-z0-9_]*$|^\\$\\{[A-Za-z_][A-Za-z0-9_]*(:?[?][^}]*|:?-)?\\}$") then "reference"
  else "literal" end;
# Every class a literal value matches is kept, the undecidable secret-word and opaque included.
def env_line($k; $v; $src):
  ($v | vclass) as $c
  | ([ (if $k | tostring | secret_name then "name" else empty end),
       (if $c == "literal" then ($v | tostring | classes | split(",")[] | select(. != "none")) else empty end) ]
     | if length == 0 then "none" else join(",") end) as $s
  | "\($k | tostring | keyname) value=\($c) secret=\($s)\(if $src == null then "" else " source=\($src)" end)";
def env_line($k; $v): env_line($k; $v; null);
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
def user_check: . // "" | tostring
  | if . == "" then "(unset, runs as root)"
    elif test("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$") then .
    else "(unparsed)" end;
def inspect_view:
  .[0].Config | {
    User: (.User | user_check),
    ExposedPorts: [(.ExposedPorts // {}) | keys[] | if test("^[0-9]{1,5}(-[0-9]{1,5})?/(tcp|udp|sctp)$") then . else "(unparsed)" end],
    Entrypoint: (.Entrypoint | argv),
    Cmd: (.Cmd | argv),
    Healthcheck: (if .Healthcheck == null then "none"
      else "present, secret-like=\(.Healthcheck.Test // [] | map(tostring) | join(" ") | classes)" end),
    Env: [(.Env // []) | env_pairs | env_line(.key; .value)] };
def pathcheck: tostring | if test("^[A-Za-z0-9_./@+:\\\\ -]{1,255}$") and (classes | test("key-material|opaque") | not) then . else "(unparsed)" end;
def env_files: .env_file // [] | if type == "string" then [.] else . end | .[] | if type == "object" then .path else . end;
# Input is one env file read whole (jq -Rs). Matches start at a line start, so a quoted value that
# spans lines is consumed with its entry and its lines are never read as entries of their own.
def unquote: if length >= 2 and ((startswith("\"") and endswith("\"")) or (startswith("'") and endswith("'"))) then .[1:-1]
  else sub("[ \\t]+#.*$"; "") end;
def envfile_view($f):
  "env_file \($f | pathcheck)",
  (gsub("\\r"; "") | [scan("(?:^|\\n)[ \\t]*(?:export[ \\t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \\t]*(?:(=)[ \\t]*(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*'|[^\\n]*))?[ \\t]*(?=\\n|$)")][]
   | if .[1] == null then env_line(.[0]; null; "env_file") else env_line(.[0]; .[2] | unquote; "env_file") end);
# $ef is envfile_view's output. compose config may merge env_file entries into environment, so in
# a service that names an env_file, an environment key that any env_file sets is marked
# env_file-or-compose. Step 8's count check settles which one it is.
def compose_view($ef):
  [$ef | scan("(?:^|\\n)([^ \\n]+) value=") | .[0]] as $efk
  | { services: (.services | map_values(
        ([env_files] | length > 0) as $hasef
        | { image, user, privileged, cap_add, network_mode, pid, ipc, userns_mode, volumes, ports,
            read_only, security_opt, devices, mem_limit, pids_limit,
            deploy: (if .deploy == null then null else .deploy | {mode, replicas, placement, resources, restart_policy} end),
            env_file: [env_files | pathcheck],
            environment: [(.environment // {}) | env_pairs | (.key | tostring | keyname) as $k
              | env_line(.key; .value; if $hasef and any($efk[]; . == $k) then "env_file-or-compose" else "compose" end)] })),
      secrets: (.secrets // {} | map_values(keys)) };
def compose_view: compose_view("");
def hostconfig_view:
  .[0] | { User: (.Config.User | user_check),
    HostConfig: (.HostConfig | {Privileged, CapAdd, NetworkMode, PidMode, IpcMode, UsernsMode, Binds,
      Mounts: [(.Mounts // [])[] | {Type, Source, Target, ReadOnly}], PortBindings, ReadonlyRootfs,
      SecurityOpt, Devices, Memory, PidsLimit, LogDriver: .LogConfig.Type}) };
def cname: tostring | ltrimstr("/") | if test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$") then . else "(unparsed)" end;
def ref_check: tostring | if test("^[A-Za-z0-9][A-Za-z0-9._/:-]{0,254}(@sha256:[0-9a-f]{64})?$") then . else "(unparsed)" end;
def socket_view:
  .[] | (.Name | cname) as $n
  | ([.Mounts[]?.Source] + [.HostConfig.Mounts[]?.Source] + [.HostConfig.Binds[]? | split(":")[0]])
  | unique | .[] | select(type == "string" and test("^(/|/run/?|/var/run/?|/.*docker[.]sock)$")) | "\($n) \(.)";
def images_view:
  [ (.Repository | tostring | if . == "<none>" then . else ref_check end),
    (.Tag | tostring | if . == "<none>" or test("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$") then . else "(unparsed)" end),
    (.Digest | tostring | if . == "<none>" or test("^sha256:[0-9a-f]{64}$") then . else "(unparsed)" end),
    (.ID | tostring | if test("^(sha256:)?[0-9a-f]{12,64}$") then . else "(unparsed)" end) ] | join(" ");
def running_view:
  .[] | [ "name=\(.Name | cname)",
    "image=\(.Config.Image | ref_check)",
    "id=\(.Image | tostring | if test("^sha256:[0-9a-f]{64}$") then . else "(unparsed)" end)",
    "state=\(.State.Status | tostring | if IN("created", "running", "paused", "restarting", "removing", "exited", "dead") then . else "(unparsed)" end)",
    "published=\([(.NetworkSettings.Ports // {}) | to_entries[] | .key as $p | (.value // [])[]
      | "\(.HostIp // ""):\(.HostPort // "")->\($p)"
      | if test("^[0-9A-Fa-f.:\\[\\]]*:[0-9]{1,5}->[0-9]{1,5}/(tcp|udp|sctp)$") then . else "(unparsed)" end] | join(","))" ]
  | join(" ");
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

- **Env entries** read `KEY value=CLASS secret=REASONS`, with `source=SOURCE` added in step 8.
  CLASS is `literal`, `empty` or `reference` (a lone `$VAR` or `${VAR}`, or a key passed through
  with no value). A `${VAR:-x}` with a non-empty default is `literal`, because the default is
  written in the file. REASONS lists every match, or `none`: `name` (the key looks like a
  credential name, `*_PASS` and `*_PWD` included, `*_FILE` and `PWD` excepted), and for a literal
  value every class below that it matched, `secret-word` and `opaque` included. A key that fails
  its format check prints `(unparsed)` with its classes still shown.
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
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --entrypoint sh IMG -c 'apt-cache policy PKG | grep -oE "[a-z0-9.-]+/(main|restricted|universe|multiverse)( |$)" | sort -u; apt-cache show PKG | grep -m1 "^Section"'
```

This prints the suite and component of each source, never the source URL, because a private
mirror's URL can carry credentials. A `.../universe` or `.../multiverse` line means community-maintained. On a host with the Pro client, `pro security-status --esm-apps` lists them. Then read the
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
# Merged compose, overrides applied, saved to a file and never printed raw. Pass every -f file.
docker compose -f FILE config --no-interpolate --format json > compose.json
# Each env_file the services name, classified entry by entry through review.jq from step 1. Never
# cat, grep or source an env file. A file that cannot be read prints the notice, not its content.
: > envfile.txt
jq -r -L . 'include "review"; .services[] | env_files' compose.json | while IFS= read -r f; do
  jq -Rrs -L . --arg f "$f" 'include "review"; envfile_view($f)' "$f" >> envfile.txt ||
    echo "an env_file could not be read, its entries are a data gap"
done
cat envfile.txt
# Runtime fields, each environment entry as KEY value=CLASS secret=REASONS source=SOURCE. command,
# entrypoint, labels, deploy.labels, logging and build args are not projected.
jq -L . --rawfile ef envfile.txt 'include "review"; compose_view($ef)' compose.json
# For an entry with source=env_file-or-compose: does a compose file set KEY itself? Prints a count,
# never a line. 0 means the value comes only from the env_file. Anything else, including a hit on
# the same key in another service, reads as set in the compose file.
cat FILE | grep -cE "^[[:space:]]*(-[[:space:]]*)?[\"']?KEY[\"']?[[:space:]]*[:=]"
# Container runtime fields and the effective user. The log driver prints by type only, because its
# options can hold a credential (splunk-token, for one). Mounts print type, source, target and
# read-only, never driver options.
docker inspect C | jq -L . 'include "review"; hostconfig_view'
# Docker socket reach (Critical, 5.32): the socket itself, or a directory that holds it (/, /run,
# /var/run) bound in. Reads every mount source, from Mounts, HostConfig.Mounts and HostConfig.Binds.
docker inspect $(docker ps -q) | jq -r -L . 'include "review"; socket_view'
```

`source=compose` means the compose model sets the entry. `source=env_file` lines come from
`envfile_view` and mean the value sits in an env file on the host. `source=env_file-or-compose`
means `docker compose config` may have merged an env_file entry into the service's environment.
The count check above decides between the two. `bands-and-output.md` (Secrets input) reads each one.

## Step 9. What is running now

```sh
# Cached images: repository, tag, digest, image ID.
docker image ls --digests --format '{{json .}}' | jq -r -L . 'include "review"; images_view'
# Running containers: name, image reference, image ID, state, published ports.
docker inspect $(docker ps -q) | jq -r -L . 'include "review"; running_view'
```

A registry quarantine or block stops new pulls. It does not stop a container already running, or a
restart from the image already cached on the host.
