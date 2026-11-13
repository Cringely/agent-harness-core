# Regression net

This directory replays this repository's real past defects. `bun run regression` runs the existing bun test that pins the fix for each one and prints, per defect, `CAUGHT` or `NOT CAUGHT`. It exits 1 when any defect is not caught, naming it. Tracked in issue #96.

## What a green run means

It means each defect in the manifest is still caught by the test that was written when it was fixed. That is all.

The net measures only failure classes this repository has already met. It cannot find a new one. The twelve bypasses of the identity gate that seeded this corpus were found by an adversarial agent attacking the gate, and the gate's own suite was green throughout all twelve. So a green regression run is not evidence that the harness is sound, and nobody should read it as one.

## Running it

- `bun run regression` runs every pinned test, one bun process per file and one file at a time. It takes about two and a half minutes on a Windows workstation, because several identity-gate tests build git repositories and need 15 to 20 seconds each.
- `bun run regression -- --static` only checks that every pinned file exists and declares every pinned test name. It runs no tests and takes well under a second. The ordinary `bun test` runs the same check (`test/regression-net.test.ts`), so a rename that orphans a pin fails CI before anyone runs the net.
- `bun run regression -- --only <id>` restricts the run to one defect and can be repeated.

Exit codes: 0 when every defect is caught, 1 when any is not caught or a pinned file or test name is gone, 2 when the manifest is unreadable or an option is unknown.

A defect counts as caught only when every test pinned to it ran and passed. A test that fails, times out, is skipped by a `skipIf` guard, or does not run at all leaves the defect not caught.

## The manifest

`manifest.json` is an array of entries:

```json
{
  "id": "identity-git-replace",
  "defect": "one line saying what went wrong",
  "fixedBy": "5cad0a3",
  "tests": [{ "file": "test/identity-gate.test.ts", "name": "the exact test title" }]
}
```

- `id` is unique and names the defect in the output.
- `fixedBy` is the commit or pull request that fixed it.
- `tests` lists the existing bun tests that fail if the defect returns. Each `name` is the literal title string of a `test()` call in `file`, with no template literals or `test.each` rows. An entry with no pinning test is refused, so the corpus holds no defect that nothing checks.

## Adding a defect

Once a fix is merged with its test, add one entry. Copy the test title exactly. Run `bun run regression -- --static` to confirm the name resolves, then `bun run regression -- --only <id>` to confirm it passes. Before trusting the entry, revert the fix and confirm the pinned test fails and the net reports `NOT CAUGHT`.

Do not add a defect whose only check is a `skipIf` test that may be skipped on some machines, or a Pester suite. The runner executes bun tests only, so defects pinned in `install/*.Tests.ps1` are outside this net for now.
