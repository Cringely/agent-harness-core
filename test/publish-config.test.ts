// Tests for tools/publish/config.ts (#274): the local file naming the git and gh identity per
// repository owner and the reviewer per repository. Every refusal below is pinned, and every
// refusal message is checked for the value that tripped it. All identities are synthetic.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPublishConfig,
  ownerIdentity,
  parsePublishConfig,
  reviewerConfig,
} from "../tools/publish/config";
import { PublishRefusal } from "../tools/publish/errors";

const OWNER = { gitName: "fixture-owner", gitEmail: "fixture-owner@users.noreply.example.test", ghUser: "fixture-owner" };
const REVIEWER = { appId: "1", keyCommand: ["fixture-key-cmd", "--print"], keyCommandEnv: { FIXTURE_FLAG: "false" }, checkout: join(tmpdir(), "fixture-checkout") };

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ owners: { "fixture-owner": OWNER }, reviewers: { "fixture-owner/fixture-repo": REVIEWER }, ...overrides });
}

function refusal(raw: string): string {
  try {
    parsePublishConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(PublishRefusal);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("parsePublishConfig()", () => {
  test("parses a full config and looks owners and repos up case-insensitively", () => {
    const parsed = parsePublishConfig(config());
    expect(ownerIdentity(parsed, "Fixture-Owner/fixture-repo")).toEqual(OWNER);
    expect(reviewerConfig(parsed, "FIXTURE-OWNER/Fixture-Repo")).toEqual(REVIEWER);
  });

  test("accepts a config with no reviewers", () => {
    const parsed = parsePublishConfig(JSON.stringify({ owners: { "fixture-owner": OWNER } }));
    expect(parsed.reviewers).toEqual({});
  });

  test("refuses text that is not JSON", () => {
    expect(refusal("{ not json")).toContain("not valid JSON");
  });

  test("refuses an unknown top-level key", () => {
    expect(refusal(config({ extra: 1 }))).toContain("only owners and reviewers");
  });

  test("refuses a config with no owners", () => {
    expect(refusal(JSON.stringify({ owners: {} }))).toContain("declares no owners");
  });

  test("refuses an owner entry with an extra key", () => {
    expect(refusal(config({ owners: { "fixture-owner": { ...OWNER, token: "zzsecret9" } } }))).toContain("only gitName, gitEmail and ghUser");
  });

  test("refuses a blank gitName", () => {
    expect(refusal(config({ owners: { "fixture-owner": { ...OWNER, gitName: "  " } } }))).toContain("gitName");
  });

  test("refuses a gitEmail that is not an address, without echoing it", () => {
    const message = refusal(config({ owners: { "fixture-owner": { ...OWNER, gitEmail: "not-an-address-zz9" } } }));
    expect(message).toContain("gitEmail");
    expect(message).not.toContain("zz9");
  });

  test("refuses a ghUser carrying shell metacharacters", () => {
    expect(refusal(config({ owners: { "fixture-owner": { ...OWNER, ghUser: "a;touch x" } } }))).toContain("ghUser");
  });

  test("refuses a non-numeric appId without echoing it", () => {
    const message = refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, appId: "zz-app" } } }));
    expect(message).toContain("appId");
    expect(message).not.toContain("zz-app");
  });

  test("refuses an empty keyCommand", () => {
    expect(refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, keyCommand: [] } } }))).toContain("keyCommand");
  });

  test("refuses a keyCommandEnv with a malformed variable name", () => {
    expect(refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, keyCommandEnv: { "bad name": "x" } } } }))).toContain(
      "keyCommandEnv",
    );
  });

  test("refuses a keyCommandEnv variable named like a secret, without echoing its value", () => {
    for (const name of ["OP_SERVICE_ACCOUNT_TOKEN", "CLIENT_SECRET", "API_KEY", "DB_PASSWORD"]) {
      const message = refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, keyCommandEnv: { [name]: "zzsecret9" } } } }));
      expect(message).toContain("marks a secret");
      expect(message).not.toContain("zzsecret9");
    }
  });

  test("refuses a relative checkout path", () => {
    expect(refusal(config({ reviewers: { "fixture-owner/fixture-repo": { ...REVIEWER, checkout: "relative/dir" } } }))).toContain("checkout");
  });

  test("refuses a reviewers key that is not owner/name", () => {
    expect(refusal(config({ reviewers: { "not-a-repo": REVIEWER } }))).toContain("owner/name");
  });
});

describe("lookups", () => {
  test("ownerIdentity refuses an owner the config does not declare", () => {
    expect(() => ownerIdentity(parsePublishConfig(config()), "someone-else/repo")).toThrow(PublishRefusal);
  });

  test("reviewerConfig refuses a repository the config does not declare", () => {
    expect(() => reviewerConfig(parsePublishConfig(config()), "fixture-owner/other-repo")).toThrow(PublishRefusal);
  });
});

describe("loadPublishConfig()", () => {
  test("refuses a missing file without naming the path it tried", () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    let message = "";
    try {
      loadPublishConfig(path);
    } catch (error) {
      expect(error).toBeInstanceOf(PublishRefusal);
      message = (error as Error).message;
    }
    expect(message).toContain("no publish config");
    expect(message).not.toContain(dir);
  });

  test("reads and parses a present file", () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, config());
    expect(ownerIdentity(loadPublishConfig(path), "fixture-owner/fixture-repo").ghUser).toBe("fixture-owner");
  });
});
