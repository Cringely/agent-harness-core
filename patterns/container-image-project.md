# Container Image Project: One Image, a CI Build, a Plain Compose Stack

## The problem it solves

A self-hosted web app with a background worker needs a route from a merged commit to a running
container on a small private host. Left unplanned, that route grows in one of two bad directions.
One is an image built by hand on the host, where the tag moves, nobody can say what is running and
secrets sit in an env file. The other is a private deployment platform, with a deployer service, app
credentials and rules binding each deploy to a CI run, and it ends up costing more than the app.

This pattern sits between them. CI builds one image and pushes it to a private registry, each host
runs an ordinary compose stack that pulls it, and a person updates a host by editing two values.

It comes from one project so far, a web app with a worker, which built a custom deployer first and
then removed it. The examples assume GitHub Actions, GHCR and Traefik. Other CI services, registries
and reverse proxies have equivalents for each setting named here.

One caveat covers the Secrets section. The rule was decided in the source project after its first
release, and the code that reads secrets this way was not yet merged there when this was written. So
that section describes a decided rule, not a tested one.

## When to use it, and when not

Use it when all of these hold:

- one or two hosts, run by one person or a small group
- every user reaches the app through a reverse proxy that enforces single sign-on
- a hosted CI service and a private registry are available
- updating by hand a few times a week is acceptable

Skip it when an orchestrator already runs the host, or when the image is distributed to other
people, because signing and provenance are then back in scope. A single stateless container needs
only a compose file and a pinned upstream image.

## Security posture and proportionality

Write the threat model down before the first review, as one paragraph in the decision log. The source
project recorded a private host, never distributed, with a few users who all arrive through SSO.

These stay at full strength:

- Data privacy. No personal data in the repository, the build context, CI or tests. No identifying
  details in committed text. No secret in a config file, a log or an alert.
- External attackers. SSO on every path, no published ports, injection-safe handling of untrusted
  input, least-privilege tokens.
- Fail-closed deploys. A missing value, a failed backup or a failed migration stops the update with
  the old release still running.
- Accidents. Anything a slip or an automated agent can trigger without intent is blocked by a check
  and not left to care. A routing label inherited from a base image is the standing example.

Relaxed by decision: image signing, attestations, provenance and SBOMs, and any new control against a
collaborator with write access who deliberately works against the system.

Optional hardening, added when the cost is worth it:

- in-build tests with no network, which needs a recent engine and tests that tolerate it
- a test pinning each compose service's exact key set, which taxes every compose edit
- signature verification of vendor downloads, where the vendor signs
- an egress allowlist proxy, which becomes required once a role handles untrusted content while
  holding a credential

## Image design

An image whose inputs float cannot be rebuilt or traced to a commit, and then every incident starts
with guessing what is running. These rules fix the inputs and make the build refuse to produce an
image the tests reject.

Build one image for every role. The role is the container command: `web`, `worker`, `migrate`,
`health <role>`. That gives one build, one test run and one digest to pin. Roles differ by command,
uid, networks and mounts.

- Pin every base image by digest (`name:tag@sha256:...`), supplied as build args from one pin file. A
  bump is a commit.
- Choose bases that carry only `org.opencontainers.image.*` labels. An inherited label cannot be
  removed, so a base with a legacy label such as `maintainer` fails the allowlist below.
- The `# syntax=` line pulls a frontend image. Leave it out, or pin it by digest like a base. Leaving
  it out means the engine's built-in frontend decides which Dockerfile features work.
- Verify every download against a pinned checksum. Fetch tools such as curl stay in a throwaway
  stage. The shipped image then has no curl, so healthchecks call the app binary.
- Install dependencies from a frozen lockfile with install scripts disabled.
- Put a test stage inside the build. It runs the suite and writes a marker file, and the final stage
  copies that marker, so a failing test cannot produce an image. The publish workflow does not wait
  on the check workflow, which makes this stage the gate.
- Bake in no secrets and no private data. Write `.dockerignore` as an allowlist: `*` first, then one
  re-include per build input.
- Run as a non-root user over root-owned code, so a compromised process cannot rewrite itself.
- Turn off implicit env-file loading if the runtime has it.
- Set `init: true`, so the app is not PID 1 and a stop signal ends it promptly. Handle SIGTERM in the
  app as well, so it closes the database and finishes in-flight work before it exits.
- Carry only `org.opencontainers.image.*` labels. CI checks this allowlist after the push.

State what is not pinned. OS packages float behind the pinned base's signing keys, and CA
certificates float on purpose so revocations arrive.

## The CI build and push

Use two workflows. The check workflow runs on pull requests and on main, read-only, with no secrets.
It never cancels a run on main, so every main commit keeps a result.

The publish workflow holds the only write credential, and its shape follows from that:

- Triggers are a push to main and a manual dispatch. Never `pull_request`, `pull_request_target` or
  `workflow_run` on the job that holds `packages: write`, because a pull request's code must not
  reach the package.
- A job-level guard, `if: github.ref == 'refs/heads/main'`, stops a dispatch on another branch from
  moving the `main` tag. A branch can edit the workflow file and remove the guard, so the control
  that counts is production's digest pin.
- Permissions are `{}` at workflow level, with `contents: read` and `packages: write` on the one job.
- Every action is pinned to a 40-hex commit. Checkout sets `persist-credentials: false`. Values
  reach shell scripts through `env:`, never by interpolation into the script text.
- The image name is built from the repository owner, giving `ghcr.io/<owner>/<app>` with no account
  name committed. Registry names are lowercase, so the script lower-cases the owner and checks it
  against a lowercase name pattern before use. Without that, an owner with one capital letter fails
  every push.
- Concurrency never cancels a running build. The CI service can still drop a pending run, so a
  merge that lands mid-build may get no tag. Dispatch main again.
- Tags are `:<12-hex sha>`, `:sha-<full sha>` and `:main`.

After the push, read the digest back from the registry. The default builder can report the config
digest, which a pull by digest cannot resolve.

```sh
digest=$(docker buildx imagetools inspect "$IMAGE:$SHORT" --format '{{json .Manifest}}' | jq -r '.digest // ""')
```

The script runs under `set -euo pipefail` and makes four checks in order, each of which fails the
job:

1. The digest is `sha256:` followed by 64 hex characters. The empty-string fallback above keeps a
   missing digest from becoming the text `null`.
2. The digest names a single image.
3. That image's revision label equals the commit.
4. No label falls outside the allowlist.

Only then does the job print the tag and digest to the run summary, so a failed check leaves
production nothing to pin.

Staging is not covered by that. The source project pushes all three tags in one step, so `:main` has
already moved when a check fails, and staging can pull an image whose inherited routing label adds a
route to web without the auth middleware. The stronger order pushes only the two sha tags, runs the
checks, then moves `:main` with a registry retag such as `docker buildx imagetools create`, so a
failed check never moves it. The source project has not adopted that order. Until a project does,
its staging must hold only fabricated data.

## The compose stack

Hardening set one key at a time gets missed on the service added six months later. One anchor
carries the defaults for every service, and policy tests check what each service ends up with.

The image reference carries the tag and an optional digest in one expression. With a digest set,
Docker resolves by the digest alone and ignores the tag. That is observed behaviour. The Docker and
Compose documentation present tag and digest as alternatives and do not describe the combined form,
so pull by the combined reference during the first live run.

```yaml
x-hardening: &hardening
  read_only: true
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  init: true
  tmpfs: ["/tmp:size=16m"]
  restart: unless-stopped
  labels:
    traefik.enable: "false"
  logging:
    driver: json-file
    options: { max-size: "50m", max-file: "3" }

services:
  web:
    <<: *hardening
    image: ${APP_IMAGE:?set APP_IMAGE in .env}:${APP_TAG:-main}${APP_DIGEST:+@}${APP_DIGEST:-}
```

A YAML merge key is shallow. A service that sets its own `labels`, `tmpfs`, `security_opt` or
`cap_drop` replaces the anchor's value instead of adding to it, so it must repeat the anchor's
entries. Otherwise one label added for monitoring drops `traefik.enable: "false"` from that service
with no error.

- Uids are per role. Services that share the data directory share one uid, and egress proxies get
  another.
- Each service sets `mem_limit`, `cpus` and `pids_limit`.
- Healthchecks run `health <role>` from the app binary. The worker writes a heartbeat row, so a
  process that is alive but wedged shows unhealthy.
- Every host-specific value is `${KEY:?set KEY in .env}`, so compose never substitutes an empty
  string. A committed example file documents each key.
- The web network is external and created with `--internal`. Only the reverse proxy and the web
  service join it. Nothing publishes a port, mounts the Docker socket, uses the host network or runs
  privileged.
- Other networks are `internal: true`. A role that needs the outside goes through an allowlist proxy
  container, which is the only member of an egress bridge.
- A network with a static address sets a `subnet` and a smaller `ip_range`, and every static address
  sits inside the subnet but outside the `ip_range`. An address inside the range can be handed to
  another container first.
- Reverse proxy labels sit on the web service only, and the anchor turns routing off everywhere
  else. A container also carries its image's labels and the proxy's Docker provider reads them, so a
  routing label inherited from a base image could add a route that skips the auth middleware.
- When the app trusts identity headers and has no authentication of its own, the middleware must
  overwrite every identity header the app reads, or a client can name its own user. In Traefik's
  forward auth, `authResponseHeaders` replaces only the headers it lists, so it must list each one.
  `authResponseHeadersRegex` strips matching client headers first.

The egress proxy accepts CONNECT on port 443 only and refuses IP literals. It checks the host against
its allowlist before any DNS lookup, refuses private addresses and connects to the exact address it
checked. It listens on its static internal address and refuses a wildcard bind at startup, because
it also joins the egress bridge, which the host can reach.

## Secrets

Secrets are files, and the app reads them from two sources only: a path named by `NAME_FILE`, or the
default `/run/secrets/<name>`. A plain `NAME` variable holding the value is refused at startup, with
an error that tells the operator to unset it. Errors name the variable and the path, never the value.
`.env` holds no secrets.

Outside swarm mode, compose bind-mounts a file secret with its host owner and mode, and ignores any
uid or mode written in the compose file. Set them on the host, with the directory at 0750 and each
file at 0640, owned by root with the reading role's group. When the readers are known, grant the
group and not the world. Mount each secret into the one service that reads it.

## Data and migrations

The source project uses SQLite in WAL mode, which keeps a write-ahead log file beside the database
file. Rules marked SQLite below are specific to that choice, and each sits beside the general rule
it comes from.

- The data directory is a host bind mount. The image's `chown` has no effect there, so create the
  directory owned by the app uid before the first start. SQLite: the mount must be a local file
  system.
- A one-shot `migrate` service runs ahead of the app with `restart: "no"`, `network_mode: none` and
  the data mount only. Web and worker depend on it with `service_completed_successfully`. The app
  never migrates itself and refuses to start below its schema floor.
- Migrations are numbered, forward-only and additive, each in its own transaction. A test refuses
  `DROP` and `RENAME`. An older release started against a newer schema runs without touching it, so
  rolling back the image does not require restoring the database.
- Migrate takes a consistent backup first, made by the database itself and labelled with the release
  tag, and prunes old ones only afterwards. A failed backup or migration stops the update with the
  old release still serving. SQLite: use its online backup, which is safe while the app has the
  database open.
- Every `up` on production takes a backup and only the last N are kept, so repeated runs push the
  older ones out. A host script that pulls and ups every stack does that daily. Exclude this stack
  from such a script, or size N for it.
- Those backups share a disk with the database. Settle the off-host copy before real data goes in,
  by snapshotting the dataset or copying the backups directory. The off-host copy always comes from
  a backup the database made or from an atomic snapshot. SQLite: a plain file copy of a live
  database can pair the database file with a log file from another moment.
- Restore backs up the live database first and moves a damaged one aside. It deletes nothing.

## Environments

Staging tracks `:main`. Production pins both the commit tag and the digest, and its migrate step
exits before doing anything when either is missing. That check catches a forgotten pin and is no
defence against a hostile image.

A marker file in the production data directory guards both directions. Staging refuses a directory
that holds it. Production refuses one that lacks it, so a container pointed at an empty directory
stops instead of starting fresh and looking healthy.

To update production, take the tag and digest from the publish run's summary for the merge commit,
set both in `.env`, then run `docker compose pull` and `docker compose up -d`. Never take them from
`docker pull` output, which reports whatever the tag points at now.

Rollback is the previous pair and the same two commands. A restore is needed only when the newer
release damaged the data or the older release cannot run on the newer schema. The backup to restore
is the oldest one labelled with the newer release's tag, which its migrate took before migrating.
Check that it still exists before starting, because pruning may have removed it.

A staging stack that resets its data on deploy must stop web and worker before it recreates anything.
Compose runs migrate before it replaces them, so a plain pull and up leaves the old processes on a
deleted database file with green healthchecks. Keep such a stack out of any host script that pulls
and ups every stack, since that script runs the reset without the stop.

## Runbook and manual probes

First install, in order:

1. Create the data and backup directories owned by the app uid, plus the production marker.
2. Create the internal web network and attach the reverse proxy in its own compose file. A manual
   `network connect` is lost when the proxy is recreated.
3. Create the stack directory with the compose file and `.env`.
4. Create the secrets directory and files with the host owner and mode.
5. Log in to the registry as the user that runs compose, with a token that only reads packages and
   has an expiry. GHCR accepts only a classic token here, and its `read:packages` scope covers every
   package the account can read. Without a credential helper the token sits in the Docker config
   file, so keep that file at mode 0600.
6. Settle the off-host backup.
7. Run `docker compose config -q`, then pull, then `up -d`.
8. Run the probes. On production, run them while the SSO application for the host does not exist
   yet, so nobody can sign in to the app before they pass. The app has no authentication of its own,
   so the two redirect probes must already return a redirect to the sign-in host in that state.

The probes, repeated after any change to the stack file or the reverse proxy:

- `docker compose ps -a`, because a migrate that exited 0 is invisible without `-a`
- `docker network inspect`, expecting `Internal=true` and exactly the expected members
- an unauthenticated request, then the same request carrying a forged identity header, each
  expecting a redirect to the sign-in page. This shows the middleware is attached and nothing more.
- a read of the middleware's configuration, expecting every identity header the app reads to be
  listed for overwrite. A stronger probe signs in as one user, sends another user's identity header
  and expects its own identity back. The source project does not run that one.
- a label dump showing only allowlisted labels on the image and only the stack's own routing labels
  on containers
- egress probes from each role's network namespace, after a control probe that must get out through
  the proxy

## Policy tests over the config files

The compose file, the env example, the runbook, the workflow and the entrypoint have to agree. Drift
between them is what review kept finding, so the ordinary test suite parses them. These pay back
first:

- the workflow's triggers, with `pull_request`, `pull_request_target` and `workflow_run` all absent,
  plus its permissions, its action pins and the lower-casing of the owner
- each service's hardening values as they stand after the anchor merge, and no `ports` anywhere
- routing labels on web only, and every other service ending with `traefik.enable: "false"`
- the runbook's permission commands against the compose users and the secrets list
- env example keys against compose interpolations, and runbook commands against the entrypoint
- every `FROM` naming a pin arg or an earlier stage, and `*` as the first `.dockerignore` rule
- a reader in code for every compose secret

A test that reads the git index has to skip visibly inside the image build, where git is absent, so
CI also runs the suite on the checkout.

## Lessons learned

- Avoid a custom deployer unless something requires it. The source project built one, its defects
  surfaced only against the live CI service after cutover, and all of it was removed for the plain
  stack.
- Record the threat model early, or review effort drifts to threats the project does not have.
- The first release mounted a secret that no code read, because tests over compose never touched the
  app.
- Live runs found what offline tests missed, each time. Before calling the setup working, run the
  workflow once, pull by the published digest, bring the stack up and run the probes.

## Checklist for a new project

- [ ] Threat model written in the decision log
- [ ] One image, role as command, bases pinned by digest in one pin file
- [ ] Test stage in the build, allowlist `.dockerignore`, non-root user, no secrets in any layer
- [ ] Publish workflow on main only, scoped permissions, SHA-pinned actions, lower-cased owner
- [ ] Digest read from the registry, four checks passed before the summary
- [ ] `:main` moved only after the checks, or staging limited to fabricated data
- [ ] Hardening anchor, limits, healthchecks and per-role uids on every service
- [ ] Internal networks, no published ports, routing labels on web only
- [ ] Secrets as files with host-set owner and mode, plain variables refused
- [ ] One-shot migrate with a backup first, forward-only migrations, off-host backup settled
- [ ] Staging on `:main`, production pinned by tag and digest, data directory marker
- [ ] Stack kept out of host-wide pull-and-up scripts, or the backup keep count sized for them
- [ ] Runbook with install order, update, rollback, restore and probes
- [ ] Policy tests for the workflow, the compose file and the cross-file checks
- [ ] First live run: the tag and digest reference pulls, the stack starts, the probes pass

## Related

- [`fail-contract.md`](fail-contract.md): the one-sentence statement of what must stay true when a
  step fails, which the fail-closed deploy rules follow.
- [`forcing-functions.md`](forcing-functions.md): why the config rules are tests and not runbook
  prose.
