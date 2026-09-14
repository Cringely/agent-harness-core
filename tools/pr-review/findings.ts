// The JSON schema handed to `claude -p --json-schema`, and the validator that re-checks the
// model's output in code. The CLI enforces the schema through its StructuredOutput tool, but that
// enforcement lives outside this repository and no test here can observe it, so every field is
// validated again before anything reads it.
//
// Rejection reasons name a field and an index, never a value. They can be rendered into the public
// review body, and a value is text the model chose.

import {
  BELOW_FLOOR_SEVERITIES,
  CONFIDENCE_SET,
  CONFIDENCES,
  LOAD_BEARING_SEVERITIES,
  SEVERITY_SET,
  type Finding,
  type ObservedInstruction,
  type ReviewerOutput,
} from "./types";

export const FINDINGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "observed_instructions"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "confidence", "path", "title", "detail"],
        properties: {
          severity: { type: "string", enum: [...LOAD_BEARING_SEVERITIES, ...BELOW_FLOOR_SEVERITIES] },
          confidence: { type: "string", enum: [...CONFIDENCES] },
          path: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    observed_instructions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "excerpt"],
        properties: {
          path: { type: "string" },
          excerpt: { type: "string" },
        },
      },
    },
  },
} as const;

export type ValidationResult = { ok: true; value: ReviewerOutput } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

export function validateReviewerOutput(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, reason: "output is not a JSON object" };
  if (!hasExactKeys(raw, ["summary", "findings", "observed_instructions"])) {
    return { ok: false, reason: "output's top-level keys differ from the schema" };
  }
  if (typeof raw.summary !== "string") return { ok: false, reason: "summary is not a string" };
  if (!Array.isArray(raw.findings)) return { ok: false, reason: "findings is not an array" };
  if (!Array.isArray(raw.observed_instructions)) return { ok: false, reason: "observed_instructions is not an array" };

  const findings: Finding[] = [];
  for (const [i, item] of raw.findings.entries()) {
    if (!isPlainObject(item) || !hasExactKeys(item, ["severity", "confidence", "path", "title", "detail"])) {
      return { ok: false, reason: `findings[${i}] keys differ from the schema` };
    }
    if (typeof item.severity !== "string" || !SEVERITY_SET.has(item.severity)) {
      return { ok: false, reason: `findings[${i}].severity is not a known severity` };
    }
    if (typeof item.confidence !== "string" || !CONFIDENCE_SET.has(item.confidence)) {
      return { ok: false, reason: `findings[${i}].confidence is not a known confidence` };
    }
    if (typeof item.path !== "string" || typeof item.title !== "string" || typeof item.detail !== "string") {
      return { ok: false, reason: `findings[${i}] has a text field that is not a string` };
    }
    findings.push({
      severity: item.severity as Finding["severity"],
      confidence: item.confidence as Finding["confidence"],
      path: item.path,
      title: item.title,
      detail: item.detail,
    });
  }

  const observed: ObservedInstruction[] = [];
  for (const [i, item] of raw.observed_instructions.entries()) {
    if (
      !isPlainObject(item) ||
      !hasExactKeys(item, ["path", "excerpt"]) ||
      typeof item.path !== "string" ||
      typeof item.excerpt !== "string"
    ) {
      return { ok: false, reason: `observed_instructions[${i}] does not match the schema` };
    }
    observed.push({ path: item.path, excerpt: item.excerpt });
  }

  return { ok: true, value: { summary: raw.summary, findings, observed_instructions: observed } };
}
