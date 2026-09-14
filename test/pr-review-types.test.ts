// Tests for the four hoisted exports in tools/pr-review/types.ts that the plan otherwise defined
// twice, identically, across files this task does not own: RefusalError, the three severity/
// confidence Sets, SHA_RE, and parseRepo. Every later task imports these instead of redefining
// them, so a defect here would reach every file that trusts the shared copy.

import { describe, expect, test } from "bun:test";
import {
  BELOW_FLOOR_SEVERITIES,
  CONFIDENCE_SET,
  CONFIDENCES,
  LOAD_BEARING_SET,
  LOAD_BEARING_SEVERITIES,
  RefusalError,
  SEVERITY_SET,
  SHA_RE,
  parseRepo,
} from "../tools/pr-review/types";

describe("RefusalError", () => {
  test("is an Error, is instanceof RefusalError, and carries its name and message", () => {
    const err = new RefusalError("checkout has uncommitted changes");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RefusalError);
    expect(err.name).toBe("RefusalError");
    expect(err.message).toBe("checkout has uncommitted changes");
  });
});

describe("severity and confidence sets", () => {
  test("SEVERITY_SET holds exactly the union of both severity tuples", () => {
    const expected = [...LOAD_BEARING_SEVERITIES, ...BELOW_FLOOR_SEVERITIES].sort();
    expect([...SEVERITY_SET].sort()).toEqual(expected);
  });

  test("CONFIDENCE_SET holds exactly CONFIDENCES", () => {
    expect([...CONFIDENCE_SET].sort()).toEqual([...CONFIDENCES].sort());
  });

  test("LOAD_BEARING_SET holds exactly LOAD_BEARING_SEVERITIES", () => {
    expect([...LOAD_BEARING_SET].sort()).toEqual([...LOAD_BEARING_SEVERITIES].sort());
  });

  test("LOAD_BEARING_SET excludes every below-floor severity", () => {
    for (const severity of BELOW_FLOOR_SEVERITIES) {
      expect(LOAD_BEARING_SET.has(severity)).toBe(false);
    }
  });
});

describe("SHA_RE", () => {
  test("accepts a 40-character lowercase hex SHA", () => {
    expect(SHA_RE.test("a".repeat(40))).toBe(true);
    expect(SHA_RE.test("0123456789abcdef0123456789abcdef01234567")).toBe(true); // 40 hex chars, mixed digits and letters
  });

  test("rejects a SHA that is too short", () => {
    expect(SHA_RE.test("a".repeat(39))).toBe(false);
  });

  test("rejects a SHA that is too long", () => {
    expect(SHA_RE.test("a".repeat(41))).toBe(false);
  });

  test("rejects uppercase hex, since the plan's regex class is [0-9a-f] only", () => {
    expect(SHA_RE.test("A".repeat(40))).toBe(false);
    expect(SHA_RE.test("a".repeat(39) + "F")).toBe(false);
  });

  test("rejects non-hex characters", () => {
    expect(SHA_RE.test("g".repeat(40))).toBe(false);
    expect(SHA_RE.test("a".repeat(39) + "!")).toBe(false);
  });
});

describe("parseRepo", () => {
  test("accepts owner/name and splits it", () => {
    expect(parseRepo("Cringely/agent-harness-core")).toEqual({ owner: "Cringely", name: "agent-harness-core" });
  });

  test.each([
    ["no slash", "agent-harness-core"],
    ["more than one slash", "Cringely/agent-harness-core/extra"],
    ["empty string", ""],
    ["empty owner", "/agent-harness-core"],
    ["empty name", "Cringely/"],
    ["owner is a single dot", "./agent-harness-core"],
    ["owner is a double dot", "../agent-harness-core"],
    ["name is a single dot", "Cringely/."],
    ["name is a double dot", "Cringely/.."],
    ["a space in the name", "Cringely/agent harness core"],
    ["an at-sign in the owner", "@Cringely/agent-harness-core"],
    ["a slash-adjacent control character", "Cringely/agent-harness-core\n"],
  ])("rejects %s", (_label, repo) => {
    expect(parseRepo(repo)).toBeNull();
  });
});
