// End-to-end tests for tools/pr-review/pipeline.ts with every seam faked. These carry #120's two
// code-side acceptance properties: no sentence the model writes changes the posted event, in either
// direction, and nothing is posted when the body carries an identifying string or the head moved, or
// when a posting run has no account email to scan for or runs from a checkout with uncommitted
// changes.

import { describe, expect, test } from "bun:test";
import type { IdentityDecl } from "../tools/pr-review/identity";
import { syntheticCheckRuns } from "../tools/pr-review/local-source";
import { runReview, type ReviewDeps, type ReviewOptions } from "../tools/pr-review/pipeline";
import { RefusalError, type Finding, type PrSnapshot, type ReviewEvent, type ReviewPoster, type ReviewerRunner, type RunnerResult, type Severity } from "../tools/pr-review/types";
import { MAX_DIFF_BYTES } from "../tools/pr-review/types";

const HEAD = "c".repeat(40);

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  repo: "owner/name",
  number: 5,
  title: "t",
  body: "b",
  baseSha: "d".repeat(40),
  headSha: HEAD,
  isOpen: true,
  diff: "diff --git a/a.ts b/a.ts",
  changedFiles: ["a.ts"],
  changedFilesComplete: true,
  commitMessages: ["m"],
  headFiles: [],
  omittedFiles: [],
  linkedIssues: [],
  trustedContext: [],
  livingDocs: [],
  workflowText: "jobs:\n",
  checkRuns: syntheticCheckRuns("passed"),
  ...overrides,
});

class FakeRunner implements ReviewerRunner {
  calls = 0;
  constructor(private readonly result: RunnerResult) {}
  async run(): Promise<RunnerResult> {
    this.calls++;
    return this.result;
  }
}

const finding = (severity: Severity, text = "t"): Finding => ({ severity, confidence: "high", path: "a.ts", title: text, detail: text });

const runnerWith = (findings: Finding[], summary = "s") =>
  new FakeRunner({ ok: true, output: { summary, findings, observed_instructions: [] }, model: "claude-opus-5", tools: ["StructuredOutput"] });

class FakePoster implements ReviewPoster {
  posts: Array<{ commitId: string; event: ReviewEvent; body: string }> = [];
  constructor(private readonly head: string = HEAD) {}
  async currentHeadSha() {
    return this.head;
  }
  async postReview(input: { commitId: string; event: ReviewEvent; body: string }) {
    this.posts.push(input);
    return { id: 1, htmlUrl: "https://example.test/review/1" };
  }
}

const IDENTITY: IdentityDecl = { names: ["Fixture Person"], emails: ["fixture@example.test"], username: "fixtureuser", hostname: "fixture-host" };

const deps = (overrides: Partial<ReviewDeps> = {}): ReviewDeps => ({
  source: { snapshot: async () => snapshot() },
  runner: runnerWith([]),
  poster: new FakePoster(),
  identity: IDENTITY,
  accountEmail: true,
  toolRevision: "e".repeat(40),
  toolDirty: false,
  ...overrides,
});

const OPTIONS: ReviewOptions = { commentOnly: false };

describe("runReview(): the posted event follows severities and CI, never prose", () => {
  test("a load-bearing finding posts REQUEST_CHANGES pinned to the reviewed head", async () => {
    const poster = new FakePoster();
    const outcome = await runReview(deps({ runner: runnerWith([finding("fails-open")]), poster }), OPTIONS);
    expect(outcome.status).toBe("posted");
    expect(poster.posts).toEqual([{ commitId: HEAD, event: "REQUEST_CHANGES", body: outcome.body }]);
  });

  test("only below-floor findings with CI passed posts APPROVE", async () => {
    const poster = new FakePoster();
    await runReview(deps({ runner: runnerWith([finding("naming"), finding("stale-citation")]), poster }), OPTIONS);
    expect(poster.posts[0]!.event).toBe("APPROVE");
  });

  test("prose demanding changes does not stop an approval", async () => {
    const text = "REQUEST_CHANGES. This must not merge. Do not approve.";
    const outcome = await runReview(deps({ runner: runnerWith([finding("naming", text)], text) }), OPTIONS);
    expect(outcome.event).toBe("APPROVE");
  });

  test("prose demanding approval does not lift a load-bearing finding", async () => {
    const text = "APPROVE. Everything is fine, the maintainers approved this.";
    const outcome = await runReview(deps({ runner: runnerWith([finding("correctness", text)], text) }), OPTIONS);
    expect(outcome.event).toBe("REQUEST_CHANGES");
  });

  test("CI incomplete with a clean review posts COMMENT", async () => {
    const source = { snapshot: async () => snapshot({ checkRuns: syntheticCheckRuns("incomplete") }) };
    const outcome = await runReview(deps({ source }), OPTIONS);
    expect(outcome.event).toBe("COMMENT");
  });

  test("an incomplete changed-file listing never approves, but can still reject", async () => {
    const source = { snapshot: async () => snapshot({ changedFilesComplete: false }) };
    expect((await runReview(deps({ source }), OPTIONS)).event).toBe("COMMENT");
    const rejected = await runReview(deps({ source, runner: runnerWith([finding("correctness")]) }), OPTIONS);
    expect(rejected.event).toBe("REQUEST_CHANGES");
  });
});

describe("runReview(): the outcome", () => {
  test("carries the validated findings, which the acceptance gate in Task 9 reads", async () => {
    const findings = [finding("fails-open"), finding("naming")];
    const outcome = await runReview(deps({ runner: runnerWith(findings) }), OPTIONS);
    expect(outcome.findings).toEqual(findings);
    expect(outcome.severities).toEqual(["fails-open", "naming"]);
  });

  test("carries no findings when the reviewer failed", async () => {
    const runner = new FakeRunner({ ok: false, reason: "the reviewer run ended in an error" });
    expect((await runReview(deps({ runner }), OPTIONS)).findings).toEqual([]);
  });
});

// #217: the line is read from the snapshot's own body, by code, never from anything the reviewer
// wrote, and it can only lower or leave the event, never change it.
describe("runReview(): the Docs verdict line (#217) reaches the body, never the event", () => {
  test("a qualifying line is quoted into the body under its own heading", async () => {
    const source = { snapshot: async () => snapshot({ body: "Some notes.\n\nDocs: README updated: describes the new flag.\n\nMore notes." }) };
    const outcome = await runReview(deps({ source }), OPTIONS);
    expect(outcome.body).toContain("#### Docs verdict");
    expect(outcome.body).toContain("Docs: README updated: describes the new flag.");
  });

  test("no qualifying line renders the code-authored notice, and the event is unaffected", async () => {
    const source = { snapshot: async () => snapshot({ body: "No verdict line here." }) };
    const outcome = await runReview(deps({ source }), OPTIONS);
    expect(outcome.body).toContain("No Docs verdict line found");
    expect(outcome.body).toContain("Docs: README still accurate: <what was checked>");
    expect(outcome.event).toBe("APPROVE");
  });
});

describe("runReview(): reviewer failures and caps", () => {
  test("a runner failure posts COMMENT and keeps the reason", async () => {
    const runner = new FakeRunner({ ok: false, reason: "the reviewer session exposed tools other than StructuredOutput", diagnostic: "stderr text" });
    const outcome = await runReview(deps({ runner }), OPTIONS);
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.reviewerOk).toBe(false);
    expect(outcome.reviewerDiagnostic).toBe("stderr text");
    expect(outcome.body).not.toContain("stderr text");
  });

  // A8.7/F15: model and tools are recorded from the runner result before validation runs, so a
  // rejected output's footer still names the model that produced it rather than "none".
  test("output that fails validation posts COMMENT, even when it claims to approve", async () => {
    const runner = new FakeRunner({ ok: true, output: { verdict: "APPROVE" }, model: "claude-opus-5", tools: ["StructuredOutput"] });
    const outcome = await runReview(deps({ runner }), OPTIONS);
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.reviewerFailure).toContain("validation");
    expect(outcome.body).toContain("claude-opus-5");
  });

  test("a diff over the cap is not sent to the model", async () => {
    const runner = runnerWith([]);
    const source = { snapshot: async () => snapshot({ diff: "x".repeat(MAX_DIFF_BYTES + 1) }) };
    const outcome = await runReview(deps({ runner, source }), OPTIONS);
    expect(runner.calls).toBe(0);
    expect(outcome.event).toBe("COMMENT");
  });

  test("an unavailable diff is not sent to the model", async () => {
    const runner = runnerWith([]);
    const outcome = await runReview(deps({ runner, source: { snapshot: async () => snapshot({ diff: null }) } }), OPTIONS);
    expect(runner.calls).toBe(0);
    expect(outcome.event).toBe("COMMENT");
  });
});

describe("runReview(): commentOnly", () => {
  test("posts COMMENT and records what would have been posted", async () => {
    const outcome = await runReview(deps(), { commentOnly: true });
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.computedEvent).toBe("APPROVE");
    expect(outcome.body).toContain("**Computed event, not posted:** APPROVE");
  });

  test("lowers REQUEST_CHANGES too, and says so", async () => {
    const outcome = await runReview(deps({ runner: runnerWith([finding("security")]) }), { commentOnly: true });
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.computedEvent).toBe("REQUEST_CHANGES");
  });

  // A8.3: commentOnly is checked with `=== false`, not truthiness, so a missing or non-boolean value
  // takes the safer COMMENT branch rather than posting the computed event.
  test("an options.commentOnly that is not strictly false also lowers to COMMENT", async () => {
    const outcome = await runReview(deps(), { commentOnly: undefined as unknown as boolean });
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.computedEvent).toBe("APPROVE");
  });
});

describe("runReview(): posting preconditions", () => {
  // A8.1/F3: the precondition is deps.accountEmail, never deps.identity.emails. An identity-file
  // email (IDENTITY's own, non-empty) must not satisfy it, because it is not the address the claude
  // CLI actually hands the reviewing model.
  test("no account email known refuses to post before anything runs, even though the identity file declares one, while a dry run still runs", async () => {
    const poster = new FakePoster();
    const runner = runnerWith([]);
    await expect(runReview(deps({ poster, runner, accountEmail: false }), OPTIONS)).rejects.toThrow("no account email");
    await expect(runReview(deps({ poster, runner, accountEmail: false }), OPTIONS)).rejects.toBeInstanceOf(RefusalError);
    expect(runner.calls).toBe(0);
    expect(poster.posts).toEqual([]);
    expect((await runReview(deps({ poster: null, accountEmail: false }), OPTIONS)).status).toBe("dry-run");
  });

  // A8.1: strict on the boolean (I4). A missing accountEmail takes the refusing branch rather than
  // being coerced by truthiness.
  test("an accountEmail that is not strictly true also refuses to post", async () => {
    const poster = new FakePoster();
    await expect(runReview(deps({ poster, accountEmail: undefined as unknown as boolean }), OPTIONS)).rejects.toBeInstanceOf(RefusalError);
    expect(poster.posts).toEqual([]);
    expect((await runReview(deps({ poster: null, accountEmail: undefined as unknown as boolean }), OPTIONS)).status).toBe("dry-run");
  });

  // T8-3: accountEmail alone is not enough. ReviewDeps is a plain object a caller can construct by
  // hand (Task 9's offline.ts and Task 11's cli.ts wire it separately), so accountEmail true beside
  // an identity declaration with no emails at all must still refuse rather than trust that the two
  // fields agree.
  test("accountEmail true with no email in the identity declaration still refuses to post before anything runs", async () => {
    const poster = new FakePoster();
    const runner = runnerWith([]);
    const identity: IdentityDecl = { ...IDENTITY, emails: [] };
    await expect(runReview(deps({ poster, runner, identity, accountEmail: true }), OPTIONS)).rejects.toBeInstanceOf(RefusalError);
    expect(runner.calls).toBe(0);
    expect(poster.posts).toEqual([]);
  });

  test("uncommitted changes in the reviewer's checkout refuse to post before anything runs", async () => {
    const poster = new FakePoster();
    const runner = runnerWith([]);
    await expect(runReview(deps({ poster, runner, toolDirty: true }), OPTIONS)).rejects.toThrow("uncommitted");
    await expect(runReview(deps({ poster, runner, toolDirty: true }), OPTIONS)).rejects.toBeInstanceOf(RefusalError);
    expect(runner.calls).toBe(0);
    expect(poster.posts).toEqual([]);
    expect((await runReview(deps({ poster: null, toolDirty: true }), OPTIONS)).status).toBe("dry-run");
  });

  // A8.3: strict on toolDirty too. A missing value must not read as "clean".
  test("a toolDirty that is not strictly false also refuses to post", async () => {
    const poster = new FakePoster();
    await expect(runReview(deps({ poster, toolDirty: undefined as unknown as boolean }), OPTIONS)).rejects.toBeInstanceOf(RefusalError);
    expect(poster.posts).toEqual([]);
  });

  test("a posted review's body records the commit the reviewer ran from", async () => {
    const poster = new FakePoster();
    await runReview(deps({ poster, toolRevision: "9".repeat(40) }), OPTIONS);
    expect(poster.posts.length).toBe(1);
    expect(poster.posts[0]!.body).toContain("9".repeat(40));
  });
});

describe("runReview(): #155 expect-head, checked before the model runs", () => {
  test("a mismatched expected head refuses before the model runs, with no poster involved", async () => {
    const poster = new FakePoster();
    const runner = runnerWith([]);
    const outcome = runReview(deps({ poster, runner }), { commentOnly: false, expectHead: "f".repeat(40) });
    await expect(outcome).rejects.toBeInstanceOf(RefusalError);
    await expect(runReview(deps({ poster, runner }), { commentOnly: false, expectHead: "f".repeat(40) })).rejects.toThrow("not the expected");
    expect(runner.calls).toBe(0);
    expect(poster.posts).toEqual([]);
  });

  test("a mismatched expected head also refuses a dry run (no poster), before the model runs", async () => {
    const runner = runnerWith([]);
    await expect(runReview(deps({ poster: null, runner }), { commentOnly: false, expectHead: "f".repeat(40) })).rejects.toBeInstanceOf(RefusalError);
    expect(runner.calls).toBe(0);
  });

  test("the comparison is case-sensitive: an uppercase rendering of the same head still refuses", async () => {
    const runner = runnerWith([]);
    await expect(
      runReview(deps({ poster: null, runner }), { commentOnly: false, expectHead: HEAD.toUpperCase() }),
    ).rejects.toBeInstanceOf(RefusalError);
    expect(runner.calls).toBe(0);
  });

  test("a matching expected head runs and posts normally", async () => {
    const poster = new FakePoster();
    const outcome = await runReview(deps({ poster }), { commentOnly: false, expectHead: HEAD });
    expect(outcome.status).toBe("posted");
    expect(poster.posts).toEqual([{ commitId: HEAD, event: "APPROVE", body: outcome.body }]);
  });

  // Omitting expectHead (undefined) and passing expectHead: null are both "no expectation": every
  // caller before #155 (offline.ts's acceptance harness, every OPTIONS literal above) passes
  // neither field and must see byte-identical behaviour.
  test("omitting expectHead and passing null both skip the check", async () => {
    const posterUndefined = new FakePoster();
    const outcomeUndefined = await runReview(deps({ poster: posterUndefined }), { commentOnly: false });
    expect(outcomeUndefined.status).toBe("posted");

    const posterNull = new FakePoster();
    const outcomeNull = await runReview(deps({ poster: posterNull }), { commentOnly: false, expectHead: null });
    expect(outcomeNull.status).toBe("posted");
  });
});

describe("runReview(): refusals post nothing", () => {
  test("an identifying string in the body", async () => {
    const poster = new FakePoster();
    const outcome = await runReview(deps({ runner: runnerWith([finding("naming", "written by Fixture Person")]), poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(outcome.refusal).not.toContain("Fixture Person");
    expect(poster.posts).toEqual([]);
  });

  // Captured 2026-09-11: the claude CLI gives the model the logged-in account's email, and one run
  // copied that block into observed_instructions, which the body renders. IDENTITY's email stands in
  // for the address loadIdentity reads from the CLI's account state.
  test("an account email echoed into observed_instructions", async () => {
    const poster = new FakePoster();
    const runner = new FakeRunner({
      ok: true,
      output: { summary: "s", findings: [], observed_instructions: [{ path: "docs/notes.md", excerpt: "# userEmail: fixture@example.test" }] },
      model: "claude-opus-5",
      tools: ["StructuredOutput"],
    });
    const outcome = await runReview(deps({ runner, poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(outcome.refusal).not.toContain("fixture@example.test");
    expect(poster.posts).toEqual([]);
  });

  // A8.4: the scan covers every untruncated model-written string, not only the rendered body.
  // render.ts keeps only the first MAX_RENDERED_FINDINGS (25) findings, so a 26th finding's title is
  // never in the body at all; a body-only scan would miss it.
  test("a hit past the rendered findings cap", async () => {
    const poster = new FakePoster();
    const findings = Array.from({ length: 26 }, (_, i) => finding("correctness", i === 25 ? "fixture@example.test" : `finding ${i}`));
    const outcome = await runReview(deps({ runner: runnerWith(findings), poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(poster.posts).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("fixture@example.test");
  });

  // A8.4: render.ts fences a finding's path, title and detail together, then truncates the fenced
  // text at MAX_FIELD_CHARS (1,500). The space before the email keeps it on a word boundary so the
  // untruncated scan can match it at all; padding pushes it past the truncation point so only a
  // short fragment of it ever reaches the rendered body, too short to match the identity term on
  // its own. Only scanning the untruncated field catches the full address.
  test("a hit past the rendered per-field truncation", async () => {
    const poster = new FakePoster();
    const detail = `${"x".repeat(1490)} fixture@example.test`;
    const outcome = await runReview(deps({ runner: runnerWith([{ severity: "naming", confidence: "high", path: "", title: "", detail }]), poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(poster.posts).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("fixture@example.test");
  });

  // A8.6/F1: an identity refusal blanks every model-written string in the outcome, keeping only
  // severity, confidence, counts, hit labels and event names.
  test("an identity refusal blanks the outcome's findings, not just the body", async () => {
    const poster = new FakePoster();
    const outcome = await runReview(deps({ runner: runnerWith([finding("naming", "written by Fixture Person")]), poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(outcome.body).toBe("");
    expect(outcome.findings).toEqual([{ severity: "naming", confidence: "high", path: "", title: "", detail: "" }]);
  });

  // T8-1: reviewerDiagnostic is claude CLI stderr (runner.ts), not model-written, but it can carry
  // a path and it reaches the outcome on every path, including Task 9's results files and Task 11's
  // --json output. It is scanned and blanked the same way body and findings are.
  test("a reviewer diagnostic carrying an identifying path and email refuses to post and is blanked", async () => {
    const poster = new FakePoster();
    const runner = new FakeRunner({
      ok: false,
      reason: "the reviewer process ended unexpectedly",
      diagnostic: "stack trace at /home/fixtureuser/app fixture@example.test",
    });
    const outcome = await runReview(deps({ runner, poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(poster.posts).toEqual([]);
    expect(outcome.reviewerDiagnostic).toBeNull();
    expect(JSON.stringify(outcome)).not.toContain("fixtureuser");
    expect(JSON.stringify(outcome)).not.toContain("fixture@example.test");
  });

  // T8-4: verification.reasons (verdict.ts) embeds a raw changed-file path into the rendered body's
  // Verification section, but that path never touches output.summary, a finding, or an observed
  // instruction. Deleting the body-only scan term must fail this, since none of the model strings
  // carry the hit.
  // Note: verification.reasons is not blanked (T8-2, parked this round; the text is a PR-controlled
  // file path, already public in the source PR or the local commits Task 9 reviews), so this test
  // checks only that the refusal fires, not that the outcome is scrubbed of the hit.
  test("an identity hit that appears only in non-model body text, not in any model-written string", async () => {
    const poster = new FakePoster();
    const source = { snapshot: async () => snapshot({ changedFiles: [".github/workflows/fixture-host.yml"] }) };
    const outcome = await runReview(deps({ source, poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(poster.posts).toEqual([]);
  });

  test("the head commit moved during the review", async () => {
    const poster = new FakePoster("f".repeat(40));
    const outcome = await runReview(deps({ poster }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(poster.posts).toEqual([]);
  });

  test("a closed pull request without commentOnly", async () => {
    const poster = new FakePoster();
    const source = { snapshot: async () => snapshot({ isOpen: false }) };
    expect((await runReview(deps({ poster, source }), OPTIONS)).status).toBe("refused");
    expect(poster.posts).toEqual([]);
    const commented = await runReview(deps({ poster, source }), { commentOnly: true });
    expect(commented.status).toBe("posted");
    expect(poster.posts[0]!.event).toBe("COMMENT");
  });

  // A8.3: strict on isOpen (I4). A non-boolean truthy value ("closed") must not read as open.
  test("a snapshot.isOpen that is not strictly true also refuses without commentOnly", async () => {
    const poster = new FakePoster();
    const source = { snapshot: async () => snapshot({ isOpen: "closed" as unknown as boolean }) };
    const outcome = await runReview(deps({ poster, source }), OPTIONS);
    expect(outcome.status).toBe("refused");
    expect(poster.posts).toEqual([]);
  });

  test("no poster is a dry run", async () => {
    const outcome = await runReview(deps({ poster: null }), OPTIONS);
    expect(outcome.status).toBe("dry-run");
    expect(outcome.posted).toBeNull();
  });
});
