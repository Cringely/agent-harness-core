# model-currency

Finds model IDs and tier aliases pinned in files and reports which are behind the latest models (#310). Run by hand from a core clone. Nothing installs it. The header of `check.ts` is the full reference for statuses, exit codes and what is scanned.

## Scan files

```
bun tools/model-currency/check.ts --root <dir-or-file> [--exclude <name>] [--latest <file.json>] [--no-resolve]
```

## Check what each tier alias resolves to on this machine (#258)

An alias such as `sonnet` can resolve to an older model than the latest, and an account or an org setting can stop serving a tier at all. Neither raises an error when a dispatch runs. This mode asks the local `claude` CLI directly:

```
bun tools/model-currency/check.ts --aliases [--latest <file.json>]
```

It reads no files. For each of `fable`, `opus`, `sonnet` and `haiku` it runs `claude -p --model <alias> --output-format json` in an empty temporary directory, reads the model name under `modelUsage`, and prints one tab-separated row per alias:

```
<status>  <alias>  <resolved model or ->  <expected latest or ->
```

- `current`: the alias resolved to the latest model of its family.
- `stale-alias`: it resolved to an older version.
- `not-served`: no single model of that family came back, because the tier is unavailable to this account, the call failed, or a fallback answered in its place.
- `unknown`: the resolved model is above the expected latest or unlisted, or no latest is known.

The expected latest comes only from the Models API (set `ANTHROPIC_API_KEY`) or a `--latest` JSON file, for example `{"sonnet": "claude-sonnet-5-5"}`. Aliases are never used to judge themselves, so with neither source every row is `unknown`. Exit 1 when any alias is `stale-alias`, 2 when any other row is not `current`, 0 when all four are `current`. `--aliases` cannot be combined with `--root`, `--exclude` or `--no-resolve`.

Each probe is a real model call on the logged-in account. Only the model names are read from its output. Nothing else is printed or kept. The tests inject the probe and never spawn `claude` or touch the network.
