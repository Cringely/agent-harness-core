// One review, end to end. The order is the contract:
//   posting preconditions (when posting: an account email to scan for, a clean reviewer checkout)
//   -> snapshot -> verification (code) -> model run (tool-less) -> validation (code)
//   -> event (code, from severities and verification only) -> optional lowering to COMMENT
//   -> rendered body -> identity scan (rendered body and every untruncated model-written string)
//   -> head re-check -> post pinned to the reviewed head.
// Nothing here reads a model-written string except to hand it to the renderer, which fences it, to
// scan it for identifying strings, and to return the validated findings in the outcome.

import { validateReviewerOutput } from "./findings";
import { findIdentityHits, type IdentityDecl } from "./identity";
import { buildPrompt } from "./prompt";
import { renderReviewBody } from "./render";
import {
  MAX_DIFF_BYTES,
  RefusalError,
  type Finding,
  type PostedReview,
  type PrSource,
  type ReviewEvent,
  type ReviewPoster,
  type ReviewerOutput,
  type ReviewerRunner,
  type Severity,
  type Verification,
} from "./types";
import { computeEvent, verificationOf } from "./verdict";

export interface ReviewDeps {
  source: PrSource;
  runner: ReviewerRunner;
  poster: ReviewPoster | null;
  identity: IdentityDecl;
  // Whether the identity scan resolved the claude CLI's own account email (identity.ts,
  // loadIdentity().accountEmail), never derived from identity.emails: an identity-file email does
  // not stand in for the address the CLI actually hands the reviewing model (F3, A8.1).
  accountEmail: boolean;
  toolRevision: string;
  toolDirty: boolean;
}

export interface ReviewOptions {
  commentOnly: boolean;
}

export interface ReviewOutcome {
  status: "posted" | "dry-run" | "refused";
  refusal: string | null;
  event: ReviewEvent;
  computedEvent: ReviewEvent;
  basis: string;
  verification: Verification;
  severities: Severity[];
  findings: Finding[];
  observedInstructionCount: number;
  reviewerOk: boolean;
  reviewerFailure: string | null;
  reviewerDiagnostic: string | null;
  headSha: string;
  body: string;
  posted: PostedReview | null;
}

export async function runReview(deps: ReviewDeps, options: ReviewOptions): Promise<ReviewOutcome> {
  // Posting preconditions, checked before any read or model run, strict on both booleans (I4): a
  // missing or non-boolean value takes the refusing branch rather than being coerced by truthiness.
  // The claude CLI gives the model the logged-in account's email (captured 2026-09-11), so a scan
  // that never resolved that address could not catch the identifying string the model is known to
  // see. And a posted review must trace to committed reviewer code, so a checkout carrying
  // uncommitted edits cannot post (coordinator ruling, 2026-09-11). A dry run publishes nothing and
  // is allowed either way.
  if (deps.poster !== null && deps.accountEmail !== true) {
    throw new RefusalError(
      "refusing to post: the identity scan knows no email address; log in to claude, or declare one in ~/.claude-account-identity.json",
    );
  }
  if (deps.poster !== null && deps.toolDirty !== false) {
    throw new RefusalError("refusing to post: the reviewer's checkout has uncommitted changes, so the review would not trace to committed code");
  }
  const snapshot = await deps.source.snapshot();
  const verification = verificationOf(snapshot);

  let output: ReviewerOutput | null = null;
  let reviewerFailure: string | null = null;
  let reviewerDiagnostic: string | null = null;
  let model = "none";
  let tools: string[] = [];
  if (snapshot.diff === null) {
    reviewerFailure = "the pull request diff was unavailable, so no model review ran";
  } else if (Buffer.byteLength(snapshot.diff, "utf8") > MAX_DIFF_BYTES) {
    reviewerFailure = "the diff exceeds the review size cap, so no model review ran";
  } else {
    const run = await deps.runner.run(buildPrompt(snapshot));
    if (!run.ok) {
      reviewerFailure = run.reason;
      reviewerDiagnostic = run.diagnostic ?? null;
    } else {
      // F15: the model and tools that ran are recorded before validation, so a footer reporting a
      // validation failure still names the model that produced the rejected output.
      model = run.model;
      tools = run.tools;
      const validated = validateReviewerOutput(run.output);
      if (validated.ok) {
        output = validated.value;
      } else {
        reviewerFailure = `the reviewer's output failed validation: ${validated.reason}`;
      }
    }
  }

  const findings = output === null ? [] : output.findings;
  const severities = findings.map((finding) => finding.severity);
  const computed = computeEvent({ reviewerOk: output !== null, severities, verification });

  // The only adjustment, and it can only lower the event. Strict on commentOnly (A8.3/I4): anything
  // other than the literal `false` takes the safer COMMENT branch, the same reasoning as the
  // toolDirty and isOpen checks below.
  const event: ReviewEvent = options.commentOnly === false ? computed.event : "COMMENT";
  const eventNote = event !== computed.event ? "this run was limited to COMMENT reviews (--comment-only)" : null;

  const body = renderReviewBody({
    event,
    computedEvent: computed.event,
    basis: computed.basis,
    eventNote,
    output,
    reviewerFailure,
    verification,
    headSha: snapshot.headSha,
    reviewerModel: model,
    reviewerTools: tools,
    toolRevision: deps.toolRevision,
    toolDirty: deps.toolDirty,
    changedFiles: snapshot.changedFiles,
  });

  const observedInstructionCount = output?.observed_instructions.length ?? 0;

  const outcome = (status: ReviewOutcome["status"], refusal: string | null, posted: PostedReview | null, outBody: string, outFindings: Finding[]): ReviewOutcome => ({
    status,
    refusal,
    event,
    computedEvent: computed.event,
    basis: computed.basis,
    verification,
    severities,
    findings: outFindings,
    observedInstructionCount,
    reviewerOk: output !== null,
    reviewerFailure,
    reviewerDiagnostic,
    headSha: snapshot.headSha,
    body: outBody,
    posted,
  });

  // A8.4: render.ts truncates every field to MAX_FIELD_CHARS, keeps only the first
  // MAX_RENDERED_FINDINGS findings, and can omit whole optional sections once the body nears its
  // length cap, so an address past any of those cuts survives in the outcome (findings, --json,
  // results files, later PR text) unscanned if only the rendered body is checked. Every
  // model-written string the outcome can carry, untruncated, is scanned alongside the body; a hit
  // anywhere takes the refusal path.
  const modelStrings: string[] = [];
  if (output !== null) {
    modelStrings.push(output.summary);
    for (const finding of output.findings) modelStrings.push(finding.path, finding.title, finding.detail);
    for (const instruction of output.observed_instructions) modelStrings.push(instruction.path, instruction.excerpt);
  }
  const hits = [...new Set([...findIdentityHits(body, deps.identity), ...modelStrings.flatMap((text) => findIdentityHits(text, deps.identity))])];
  if (hits.length > 0) {
    // A8.6/F1: nothing a model wrote survives into a refused outcome, so a refused run stays
    // reportable (--json, a results file, a status message) without republishing what it caught.
    // Only hit-class labels, severities, counts and event names remain.
    const blanked = findings.map((finding) => ({ ...finding, path: "", title: "", detail: "" }));
    return outcome("refused", `the review body carries identifying strings (${hits.join(", ")}); nothing was posted`, null, "", blanked);
  }
  if (deps.poster === null) return outcome("dry-run", null, null, body, findings);
  if (snapshot.isOpen !== true && options.commentOnly !== true) {
    return outcome("refused", "the pull request is not open; only a --comment-only run may post to it", null, body, findings);
  }
  // With dismiss_stale_reviews_on_push an approval on an old commit would not count anyway, but a
  // REQUEST_CHANGES on an old commit would still block. Refusing keeps both honest.
  if ((await deps.poster.currentHeadSha()) !== snapshot.headSha) {
    return outcome("refused", "the head commit moved while the review ran; nothing was posted, so run the review again", null, body, findings);
  }
  const posted = await deps.poster.postReview({ commitId: snapshot.headSha, event, body });
  return outcome("posted", null, posted, body, findings);
}
