// Live-process tests for the git commit-msg hook (core/claude/hooks/commit-msg).
// Issue #133: the hook refuses a commit whose message carries an AI-attribution
// line, and nothing under test/ drove it — the only prior mention was a string
// match in test/citation-drift.ts.
//
// Like pre-commit.test.ts and identity-gate.test.ts, this hook is a POSIX shell
// script with no exported core to unit test, and it is a git hook, not a Claude
// Code hook — the "reads as a deny" channel here is a non-zero exit from a real
// `git commit`, not a permissionDecision. So every case here drives the hook
// through a REAL `git commit` in a real temp repo (mirroring
// identity-gate.test.ts's initPrePushRepo, which installs the hook straight at
// its real git-resolved path and lets a real `git push` invoke it) rather than
// `sh <hook> <msg-file>` directly: Git for Windows runs hooks with
// LC_CTYPE=C.UTF-8, and a direct `sh` invocation in a test has missed locale
// bugs a real git invocation would have caught.
//
// CONTRIBUTING.md:47's denial-test rule binds this hook (it refuses via a
// non-zero exit, a channel git reads as a block): a case that passes only
// proves the gate lets work through, so every describe block below pairs a
// refusing case with an accepting one.
//
// Every attribution string in these fixtures is exactly the shape the hook is
// written to catch, and none of it appears in this file's own commit message
// (change-management.md: no AI attribution in a real commit here) — the
// commit that adds this file describes these cases in prose instead of
// quoting them.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case runs a real git commit and so a real hook, which is slow where process spawns are slow.
setDefaultTimeout(60_000);

/** A rationale line the hook accepts: "Why:" plus at least three words. */
const WHY = "Why: the first backoff was too short.\n";

const HOOK_SRC = join(import.meta.dir, "..", "core", "claude", "hooks", "commit-msg");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

/** A fresh repo, hook not yet installed — installHook() below places it at
 * its real git-resolved path so a real `git commit` invokes it exactly as
 * production would, shebang and all, rather than through an explicit
 * `sh <hook>` (the same approach identity-gate.test.ts uses for pre-push). */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "commitmsg-"));
  tempDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

/** Stage one trivial file so a commit attempt has something to commit — the
 * hook's own refusal is what's under test, not "nothing staged". */
function stageSomething(dir: string, name = "f.txt") {
  writeFileSync(join(dir, name), "content\n");
  git(["add", name], dir);
}

/** Attempts a commit with the given message, passed as a real argv entry
 * (never through a shell string) so embedded newlines and colons reach git
 * exactly as written. */
function commitWith(dir: string, message: string) {
  return git(["commit", "-m", message], dir);
}

function headExists(dir: string): boolean {
  return git(["rev-parse", "--verify", "HEAD"], dir).exitCode === 0;
}

/** Installs the hook at its real git-resolved path and makes it executable
 * (needed on the ubuntu runner; a harmless no-op on Windows). */
function installHook(dir: string) {
  writeFileSync(join(dir, ".git", "hooks", "commit-msg"), readFileSync(HOOK_SRC));
  chmodSync(join(dir, ".git", "hooks", "commit-msg"), 0o755);
}

describe("commit-msg hook — refuses each AI-attribution channel it documents", () => {
  // Each fixture trips exactly one of the hook's four checks, isolated from
  // the other three, so a regression in one check's regex cannot hide behind
  // another check catching the same fixture for a different reason.
  const cases: Array<[string, string]> = [
    [
      "Co-Authored-By trailer naming Claude",
      `fix: correct the retry backoff\n\n${WHY}\nCo-authored-by: Claude Helper <helper@example.test>\n`,
    ],
    [
      "Claude-Session trailer",
      `fix: correct the retry backoff\n\n${WHY}\nClaude-Session: opaque-token-not-a-url\n`,
    ],
    [
      "'Generated with Claude Code' attribution line",
      `fix: correct the retry backoff\n\n${WHY}\nGenerated with Claude Code\n`,
    ],
    [
      "an anthropic.com address",
      `fix: correct the retry backoff\n\n${WHY}\nContact noreply@anthropic.com for details.\n`,
    ],
  ];

  // Each fixture carries a qualifying Why line, so only the attribution check
  // can be what refuses it.
  test.each(cases)("%s: git commit is refused, no commit is created", (_label, message) => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(dir, message);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("commit-msg: refused");
    expect(result.stderr.toString()).not.toContain("Why:");
    expect(headExists(dir)).toBe(false);
  });

  test("attribution refuses a message that has no Why line too, for the attribution reason", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(dir, "fix: correct the retry backoff\n\nClaude-Session: opaque-token-not-a-url\n");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Claude-Session trailer");
    expect(headExists(dir)).toBe(false);
  });
});

describe("commit-msg hook — accepts a clean message", () => {
  test("a normal commit message with no attribution line: git commit succeeds", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(
      dir,
      `fix: correct the retry backoff\n\n${WHY}\nNo attribution here, just a normal commit describing the change.\n`,
    );

    expect(result.exitCode).toBe(0);
    expect(headExists(dir)).toBe(true);
  });
});

describe("commit-msg hook — the two-space prose escape hatch", () => {
  test("a trigger phrase indented by two spaces is prose, not a trailer, and is accepted", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    // The hook's own header documents this: indenting a line by two or more
    // spaces is how to write one of these strings in prose (a commit that
    // documents the rule, for instance) without tripping the gate.
    const message =
      "docs: describe the commit-msg escape hatch\n\n" +
      `${WHY}\n` +
      "The hook refuses any line starting with this trailer:\n" +
      "  Co-authored-by: Claude <noreply@anthropic.com>\n" +
      "Indenting by two spaces is how to write it in prose instead.\n";

    const result = commitWith(dir, message);

    expect(result.exitCode).toBe(0);
    expect(headExists(dir)).toBe(true);
  });
});

describe("commit-msg hook — requires a Why line", () => {
  const WHY_REASON = "No 'Why:' line";

  function expectRefusedForWhy(message: string) {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(dir, message);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(WHY_REASON);
    expect(headExists(dir)).toBe(false);
  }

  function expectAccepted(message: string) {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(dir, message);

    expect(result.stderr.toString()).not.toContain("commit-msg: refused");
    expect(result.exitCode).toBe(0);
    expect(headExists(dir)).toBe(true);
  }

  const refused: Array<[string, string]> = [
    ["a body with no Why line", "fix: correct the retry backoff\n\nThe first attempt waited zero seconds.\n"],
    ["a hand-typed Merge subject with a body and no Why line", "Merge stuff\n\nCombined two lines of work.\n"],
    ["a docs commit that has a body but no Why line", "docs: explain the backoff\n\nAdds a paragraph.\n"],
    ["an empty Why line", "fix: correct the retry backoff\n\nWhy:\n"],
    ["a Why line holding only whitespace", "fix: correct the retry backoff\n\nWhy:    \n"],
    ["a Why line with fewer than three words", "fix: correct the retry backoff\n\nWhy: too short\n"],
    ["a Why line that does not start the line", "fix: correct the retry backoff\n\nNote Why: the first backoff was too short.\n"],
    ["a Why line only inside a comment line", "fix: correct the retry backoff\n\n# Why: the first backoff was too short.\nBody text.\n"],
  ];

  test.each(refused)("%s: refused with a one-line reason", (_label, message) => {
    expectRefusedForWhy(message);
  });

  test("the refusal prints exactly one line", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);

    const result = commitWith(dir, "fix: correct the retry backoff\n\nBody only.\n");

    const lines = result.stderr.toString().split(/\r?\n/).filter((l) => l.includes("commit-msg: refused"));
    expect(lines).toHaveLength(1);
  });

  const accepted: Array<[string, string]> = [
    ["a Why line with three words", "fix: correct the retry backoff\n\nWhy: backoff was missing.\n"],
    ["a lowercase why line", "fix: correct the retry backoff\n\nwhy: the first backoff was too short.\n"],
    ["an uppercase WHY line", "fix: correct the retry backoff\n\nWHY: the first backoff was too short.\n"],
    ["a Why line directly under the subject", "fix: correct the retry backoff\nWhy: the first backoff was too short.\n"],
    ["a Why line below other body text", "fix: correct the retry backoff\n\nThe first attempt waited zero seconds.\n\nWhy: the first backoff was too short.\n"],
    ["a second Why line when the first is empty", "fix: correct the retry backoff\n\nWhy:\nWhy: the first backoff was too short.\n"],
  ];

  test.each(accepted)("%s: accepted", (_label, message) => {
    expectAccepted(message);
  });

  test("a CRLF message file with a Why line is accepted", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);
    const file = join(dir, "msg.txt");
    writeFileSync(file, "fix: correct the retry backoff\r\n\r\nWhy: the first backoff was too short.\r\n");

    const result = git(["commit", "--cleanup=verbatim", "-F", file], dir);

    expect(result.stderr.toString()).not.toContain("commit-msg: refused");
    expect(result.exitCode).toBe(0);
  });

  test("a CRLF message file with an empty Why line is refused", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);
    const file = join(dir, "msg.txt");
    writeFileSync(file, "fix: correct the retry backoff\r\n\r\nWhy:\r\n");

    const result = git(["commit", "--cleanup=verbatim", "-F", file], dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(WHY_REASON);
  });

  test("a CRLF Why line is not padded to three words by its carriage return", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);
    const file = join(dir, "msg.txt");
    // Two real words, a space, then CR: an unstripped CR would count as a third word.
    writeFileSync(file, "fix: correct the retry backoff\r\n\r\nWhy: too short \r\n");

    const result = git(["commit", "--cleanup=verbatim", "-F", file], dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(WHY_REASON);
  });

  test("a CRLF message file with attribution is still refused for attribution", () => {
    const dir = initRepo();
    installHook(dir);
    stageSomething(dir);
    const file = join(dir, "msg.txt");
    writeFileSync(
      file,
      "fix: correct the retry backoff\r\n\r\nWhy: the first backoff was too short.\r\nClaude-Session: opaque\r\n",
    );

    const result = git(["commit", "--cleanup=verbatim", "-F", file], dir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Claude-Session trailer");
  });

  describe("exemptions", () => {
    test.each([
      ["docs", "docs: explain the backoff\n"],
      ["docs with a scope", "docs(readme): explain the backoff\n"],
      ["chore", "chore: bump the lockfile\n"],
      ["style", "style: reformat the retry loop\n"],
      ["a breaking-change docs marker", "docs!: rename the backoff section\n"],
    ])("a subject-only %s commit is accepted", (_label, message) => {
      expectAccepted(message);
    });

    test.each([
      ["feat", "feat: add a retry backoff\n"],
      ["fix", "fix: correct the retry backoff\n"],
      ["untyped", "Correct the retry backoff\n"],
    ])("a subject-only %s commit is accepted", (_label, message) => {
      expectAccepted(message);
    });

    test.each([
      ["fixup!", "fixup! fix: correct the retry backoff\n\nBody text with no rationale line.\n"],
      ["squash!", "squash! fix: correct the retry backoff\n\nBody text with no rationale line.\n"],
      ["amend!", "amend! fix: correct the retry backoff\n\nBody text with no rationale line.\n"],
    ])("a %s subject is accepted", (_label, message) => {
      expectAccepted(message);
    });

    test("a fixup! mention is exempt only at the start of the subject", () => {
      expectRefusedForWhy("fix: handle fixup! subjects\n\nBody text.\n");
    });

    test("a merge commit is accepted without a Why line", () => {
      const dir = initRepo();
      installHook(dir);
      stageSomething(dir);
      expect(commitWith(dir, `fix: base commit\n\n${WHY}`).exitCode).toBe(0);
      git(["branch", "-M", "main"], dir);
      git(["checkout", "-q", "-b", "side"], dir);
      stageSomething(dir, "side.txt");
      expect(commitWith(dir, `feat: side work\n\n${WHY}`).exitCode).toBe(0);
      git(["checkout", "-q", "main"], dir);
      stageSomething(dir, "main.txt");
      expect(commitWith(dir, `feat: main work\n\n${WHY}`).exitCode).toBe(0);

      // The subject does not start with "Merge ", so this passes on MERGE_HEAD alone.
      const merged = git(["merge", "--no-ff", "-m", "combine the two lines of work\n\nBody text with no rationale line.", "side"], dir);

      expect(merged.stderr.toString()).not.toContain("commit-msg: refused");
      expect(merged.exitCode).toBe(0);
      expect(git(["rev-parse", "--verify", "HEAD^2"], dir).exitCode).toBe(0);
    });

    test.each([
      ["branch", "Merge branch 'side' into main\n\nBody text here.\n"],
      ["remote-tracking branch", "Merge remote-tracking branch 'origin/main'\n\nBody text here.\n"],
      ["pull request", "Merge pull request #1 from a/b\n\nBody text here.\n"],
      ["tag", "Merge tag 'v1' into main\n\nBody text here.\n"],
      ["commit", "Merge commit 'abc123' into main\n\nBody text here.\n"],
      ["branches (octopus)", "Merge branches 'a' and 'b'\n\nBody text here.\n"],
    ])("a git-written Merge %s subject with a body is accepted without a Why line", (_label, message) => {
      expectAccepted(message);
    });

    test("a conflicted git revert, finished with git commit, is accepted without a Why line", () => {
      // git revert runs no commit-msg hook when it commits cleanly. It does when a
      // conflict is resolved by hand and finished with git commit, which is the
      // only way the generated Revert subject reaches the hook.
      const dir = initRepo();
      installHook(dir);
      const write = (content: string) => writeFileSync(join(dir, "f.txt"), content);
      const commitAll = (subject: string) => {
        git(["add", "f.txt"], dir);
        expect(commitWith(dir, `${subject}\n\n${WHY}`).exitCode).toBe(0);
      };
      write("a\n");
      commitAll("fix: first version");
      write("b\n");
      commitAll("fix: second version");
      write("c\n");
      commitAll("fix: third version");

      const env = { ...process.env, GIT_EDITOR: "true" };
      const run = (args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
      expect(run(["revert", "--no-edit", "HEAD~1"]).exitCode).not.toBe(0);
      write("resolved\n");
      git(["add", "f.txt"], dir);
      const finished = run(["commit"]);

      expect(finished.stderr.toString()).not.toContain("commit-msg: refused");
      expect(finished.exitCode).toBe(0);
      expect(git(["log", "-1", "--format=%s"], dir).stdout.toString()).toContain('Revert "fix: second version"');
    });

    test("a Reapply subject, which git revert writes when it reverts a revert, is accepted", () => {
      expectAccepted('Reapply "fix: second version"\n\nBody text with no rationale line.\n');
    });

    test("a hand-written message that only mentions revert is not exempt", () => {
      expectRefusedForWhy("fix: revert the backoff change\n\nUndoes the change.\n");
    });

    test.each([
      ["one sign-off", "fix: correct the retry backoff\n\nSigned-off-by: A Person <a@example.test>\n"],
      ["two trailers", "fix: correct the retry backoff\n\nSigned-off-by: A Person <a@example.test>\nReviewed-by: B Person <b@example.test>\n"],
    ])("a subject-only commit with %s and nothing else is accepted", (_label, message) => {
      expectAccepted(message);
    });

    test.each([
      ["a trailer plus a prose line", "fix: correct the retry backoff\n\nThe first attempt waited zero seconds.\n\nSigned-off-by: A Person <a@example.test>\n"],
      ["a colon line whose key has no hyphen", "fix: correct the retry backoff\n\nNote: the first attempt waited zero seconds.\n"],
    ])("%s still counts as a body and needs a Why line", (_label, message) => {
      expectRefusedForWhy(message);
    });
  });
});

describe("commit-msg hook — judges the message git will store", () => {
  // git runs commit-msg before its own cleanup, so the hook has to apply the
  // same cleanup itself: cut at the scissors line when an editor ran, and drop
  // comment lines only when the effective cleanup mode strips them.

  /** Commits through a real editor: the editor script prepends `text` to the
   * template git wrote, as a person typing above the comment block would. */
  function commitViaEditor(dir: string, text: string, args: string[] = []) {
    const script = join(dir, ".git", "prepend-editor.sh");
    writeFileSync(script, '#!/bin/sh\n{ printf \'%s\\n\' "$PREPEND"; cat "$1"; } > "$1.tmp" && mv "$1.tmp" "$1"\n');
    const env = { ...process.env, GIT_EDITOR: `sh "${script.replace(/\\/g, "/")}"`, PREPEND: text };
    return Bun.spawnSync(["git", "commit", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
  }

  function setup(config: Array<[string, string]> = []): string {
    const dir = initRepo();
    for (const [key, value] of config) git(["config", key, value], dir);
    installHook(dir);
    stageSomething(dir);
    return dir;
  }

  function accepted(result: ReturnType<typeof git>, dir: string) {
    expect(result.stderr.toString()).not.toContain("commit-msg: refused");
    expect(result.exitCode).toBe(0);
    expect(headExists(dir)).toBe(true);
  }

  function refusedForWhy(result: ReturnType<typeof git>, dir: string) {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("No 'Why:' line");
    expect(headExists(dir)).toBe(false);
  }

  test("a subject-only git commit -v is accepted: the diff below the scissors line is not body", () => {
    const dir = setup();
    const result = commitViaEditor(dir, "fix: correct the retry backoff", ["-v"]);
    accepted(result, dir);
    expect(git(["log", "-1", "--format=%B"], dir).stdout.toString().trim()).toBe("fix: correct the retry backoff");
  });

  test("the attribution scan reads the whole raw file, so an attribution string inside a verbose diff is refused", () => {
    // A known false refusal, taken on purpose: the hook cannot see -v, so it
    // cannot know git will discard the diff, and cutting there would let a
    // trailer below a hand-typed scissors line through.
    const dir = setup();
    writeFileSync(join(dir, "notes.txt"), "Contact noreply@anthropic.com for details.\n");
    git(["add", "notes.txt"], dir);
    const result = commitViaEditor(dir, "docs: add the contact note", ["-v"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Anthropic address");
    expect(headExists(dir)).toBe(false);
  });

  test("an attribution trailer below a hand-typed scissors line is refused when git keeps it", () => {
    // Editor ran (GIT_EDITOR=true), default strip cleanup, no -v: git drops the
    // scissors line as a comment and stores the trailer under it.
    const dir = setup();
    const env = { ...process.env, GIT_EDITOR: "true" };
    const message =
      "fix: correct the retry backoff\n\n" +
      "# ------------------------ >8 ------------------------\n" +
      "Co-authored-by: Claude <helper@example.test>\n";
    const result = Bun.spawnSync(["git", "commit", "-e", "-m", message], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Co-Authored-By trailer");
    expect(headExists(dir)).toBe(false);
  });

  describe("GIT_EDITOR=: is ambiguous, so the Why check takes the reading that requires it", () => {
    // git sets GIT_EDITOR=: for the hook when it used no editor, and passes a
    // caller's own GIT_EDITOR=: through when it did. The hook judges both.
    function run(dir: string, args: string[]) {
      const env = { ...process.env, GIT_EDITOR: ":" };
      return Bun.spawnSync(["git", "commit", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
    }

    test("a Why line only below a scissors line that git cuts under -v is refused", () => {
      // Editor mode with a no-op editor and -v: git cuts at the first scissors
      // line and stores the body without the Why line.
      const dir = setup();
      const message =
        "fix: correct the retry backoff\n\n" +
        "The first attempt waited zero seconds.\n" +
        "# ------------------------ >8 ------------------------\n" +
        "Why: the stored message would lack this line.\n";
      refusedForWhy(run(dir, ["-e", "-v", "-m", message]), dir);
    });

    test("a Why line above the scissors line is accepted", () => {
      const dir = setup();
      const message =
        "fix: correct the retry backoff\n\n" +
        "The first attempt waited zero seconds.\n" +
        "Why: the first backoff was too short.\n";
      accepted(run(dir, ["-e", "-v", "-m", message]), dir);
    });

    test("a subject-only -m commit is accepted", () => {
      const dir = setup();
      accepted(run(dir, ["-m", "fix: correct the retry backoff"]), dir);
    });

    test("a #-led body line under -m still counts as body", () => {
      const dir = setup();
      refusedForWhy(run(dir, ["-m", "fix: retry", "-m", "#263 adds the backoff"]), dir);
    });

    test("known cost: a subject-only amend in editor mode is refused, --no-edit is the way round it", () => {
      const dir = setup();
      expect(git(["commit", "-m", "fix: base"], dir).exitCode).toBe(0);
      stageSomething(dir, "g.txt");
      const amended = run(dir, ["--amend"]);
      expect(amended.exitCode).not.toBe(0);
      expect(amended.stderr.toString()).toContain("No 'Why:' line");
      const noEdit = run(dir, ["--amend", "--no-edit"]);
      expect(noEdit.stderr.toString()).not.toContain("commit-msg: refused");
      expect(noEdit.exitCode).toBe(0);
    });
  });

  test("a subject-only commit through the editor with a non-default comment character is accepted", () => {
    const dir = setup([["core.commentChar", ";"]]);
    accepted(commitViaEditor(dir, "fix: correct the retry backoff"), dir);
  });

  test("with a non-default comment character a #-led body line is content", () => {
    const dir = setup([["core.commentChar", ";"]]);
    refusedForWhy(commitViaEditor(dir, "fix: correct the retry backoff\n\n#263 adds the backoff"), dir);
  });

  test("an editor commit under the default cleanup drops #-led lines, so a #-only body passes", () => {
    const dir = setup();
    accepted(commitViaEditor(dir, "fix: correct the retry backoff\n\n# a note git strips"), dir);
  });

  test("commit.cleanup=scissors keeps a #-led line above the cut, so it needs a Why line", () => {
    const dir = setup([["commit.cleanup", "scissors"]]);
    refusedForWhy(commitViaEditor(dir, "fix: correct the retry backoff\n\n#263 adds the backoff"), dir);
  });

  test("commit.cleanup=scissors with a subject-only edit is accepted", () => {
    const dir = setup([["commit.cleanup", "scissors"]]);
    accepted(commitViaEditor(dir, "fix: correct the retry backoff"), dir);
  });

  test.each([
    ["no cleanup config (git keeps # lines when no editor runs)", []],
    ["commit.cleanup=verbatim", [["commit.cleanup", "verbatim"]]],
    ["commit.cleanup=whitespace", [["commit.cleanup", "whitespace"]]],
  ] as Array<[string, Array<[string, string]>]>)("-m with a #-led body line and %s: refused", (_label, config) => {
    const dir = setup(config);
    refusedForWhy(git(["commit", "-m", "fix: retry", "-m", "#263 adds the backoff"], dir), dir);
  });

  test("-m with only #-led body lines under commit.cleanup=strip is accepted", () => {
    const dir = setup([["commit.cleanup", "strip"]]);
    accepted(git(["commit", "-m", "fix: retry", "-m", "# a note git strips"], dir), dir);
    expect(git(["log", "-1", "--format=%B"], dir).stdout.toString().trim()).toBe("fix: retry");
  });
});
