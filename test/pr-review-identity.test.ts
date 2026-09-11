// Tests for tools/pr-review/identity.ts, the check that refuses to post a review body carrying an
// identifying string. Same three states as the git identity gate described in README.md: file
// absent means username and hostname only; file present but unusable means refuse; file present
// and valid means check everything. Whatever the file says, the email in the claude CLI's account
// state (.claude.json) is checked too. Every identity here is synthetic.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { accountStateDir, findIdentityHits, loadIdentity, type IdentityDecl } from "../tools/pr-review/identity";
// Global constraints allow a test to import a render.ts export; I2/I3's tests run hostile text
// through the real fenced() so the fix is checked against the field shape the renderer actually
// emits, not a hand-built approximation of it.
import { fenced } from "../tools/pr-review/render";

const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(fileContent?: string, accountState?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-identity-"));
  homes.push(dir);
  if (fileContent !== undefined) writeFileSync(join(dir, ".claude-account-identity.json"), fileContent);
  if (accountState !== undefined) writeFileSync(join(dir, ".claude.json"), accountState);
  return dir;
}

// The shape the claude CLI writes, cut down to the one field the scan reads.
const ACCOUNT_STATE = JSON.stringify({ oauthAccount: { emailAddress: "fixture@example.test" } });

// Every loadIdentity call below passes home and env explicitly (Note T4): a call that omitted
// either could fall through to this workstation's real homedir() or real process.env, and a
// toEqual mismatch would then print real data instead of a fixture.
const load = (dir: string) => loadIdentity({ home: dir, username: "fixtureuser", host: "fixture-host", env: {} });

const decl = (overrides: Partial<IdentityDecl> = {}): IdentityDecl => ({
  names: ["Fixture Person"],
  emails: ["fixture@example.test"],
  username: "fixtureuser",
  hostname: "fixture-host",
  ...overrides,
});

describe("loadIdentity()", () => {
  test("no identity file: usable, undeclared, username and hostname still set", () => {
    const result = load(home());
    expect(result).toEqual({
      ok: true,
      declared: false,
      accountEmail: false,
      decl: { names: [], emails: [], username: "fixtureuser", hostname: "fixture-host" },
    });
  });

  test("a valid file: declared, lists kept", () => {
    const result = load(home(JSON.stringify({ names: ["Fixture Person"], emails: ["fixture@example.test"] })));
    expect(result.ok && result.declared && result.decl.names).toEqual(["Fixture Person"]);
  });

  test.each([
    ["not JSON", "{names:"],
    ["a JSON array", "[]"],
    ["names as a string", JSON.stringify({ names: "Fixture Person" })],
    ["an empty name", JSON.stringify({ names: [""], emails: ["fixture@example.test"] })],
    ["nothing declared", JSON.stringify({ names: [], emails: [] })],
  ])("a file holding %s: refused", (_label, content) => {
    expect(load(home(content)).ok).toBe(false);
  });

  // I5: the identity file's only legal shape is { names, emails }. A misspelled or extra key, or
  // a repeated key JSON.parse would silently collapse to its last value, must refuse rather than
  // drop the declared channel it typo'd or duplicated.
  test.each([
    ["a misspelled key (email instead of emails)", JSON.stringify({ names: ["Fixture Person"], email: ["fixture@example.test"] })],
    ["a capitalised key (Names instead of names)", JSON.stringify({ Names: ["Fixture Person"], emails: ["fixture@example.test"] })],
  ])("a file holding %s: refused", (_label, content) => {
    expect(load(home(content)).ok).toBe(false);
  });

  // A bare duplicate names key with no emails key would refuse anyway (the collapsed empty
  // names, with no emails either, hits "nothing declared"), which would not actually discriminate
  // this defense from that pre-existing one. Adding a valid emails key removes that coincidence:
  // without the duplicate-key check, this file would load as declared with names silently
  // dropped to [], because a non-empty emails list alone already satisfies "something declared".
  test("a names key repeated, whose later value JSON.parse would keep (empty), alongside a valid emails key: refused", () => {
    const raw = '{"names":["Fixture Person"],"names":[],"emails":["fixture@example.test"]}';
    expect(load(home(raw)).ok).toBe(false);
  });

  test("a directory where the file should be: refused", () => {
    const dir = home();
    mkdirSync(join(dir, ".claude-account-identity.json"));
    expect(load(dir).ok).toBe(false);
  });

  // A4.5: existsSync follows symlinks, so a dangling symlink used to read as absent and a
  // declared identity dropped silently to the undeclared state. Skipped where symlinkSync throws
  // EPERM (no symlink privilege on this Windows account); CI's ubuntu runner has it.
  test("a dangling symlink where the file should be: refused", () => {
    const dir = home();
    const link = join(dir, ".claude-account-identity.json");
    try {
      symlinkSync(join(dir, "missing-target.json"), link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    expect(load(dir).ok).toBe(false);
  });

  // C1: lstat can fail for reasons other than "nothing is there" (a parent directory search
  // permission denies access to its metadata). That must not read as absent either; skipped on
  // win32 (chmod on a directory does not restrict lstat inside it the same way) and as root
  // (root bypasses the permission being tested).
  test("a valid identity file whose containing directory denies search permission (EACCES on lstat): refused, not undeclared", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dir = home(JSON.stringify({ names: ["Fixture Person"] }));
    chmodSync(dir, 0o600);
    try {
      expect(load(dir).ok).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  // Captured 2026-09-11: the claude CLI keeps the logged-in account in .claude.json and gives the
  // reviewing model that account's email, which one run copied into its output. The scan has to know
  // that address even when no identity file exists.
  test("the claude account's email is scanned for without an identity file", () => {
    const result = load(home(undefined, ACCOUNT_STATE));
    expect(result).toEqual({
      ok: true,
      declared: false,
      accountEmail: true,
      decl: { names: [], emails: ["fixture@example.test"], username: "fixtureuser", hostname: "fixture-host" },
    });
    if (result.ok) expect(findIdentityHits("# userEmail: FIXTURE@example.test", result.decl)).toEqual(["email #1"]);
  });

  test("an identity file declaring only names still gets the claude account's email", () => {
    const result = load(home(JSON.stringify({ names: ["Fixture Person"] }), ACCOUNT_STATE));
    expect(result.ok && result.declared && result.decl).toEqual({
      names: ["Fixture Person"],
      emails: ["fixture@example.test"],
      username: "fixtureuser",
      hostname: "fixture-host",
    });
  });

  test.each([
    ["no oauthAccount", JSON.stringify({ numStartups: 1 })],
    ["an emailAddress that is not a string", JSON.stringify({ oauthAccount: { emailAddress: 7 } })],
  ])("account state with %s adds no email", (_label, content) => {
    const result = load(home(undefined, content));
    expect(result.ok && result.decl.emails).toEqual([]);
  });

  test("account state that is not JSON: refused, with a reason that names no path", () => {
    const dir = home(undefined, "{oauthAccount:");
    const result = load(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain(dir);
  });

  // A4.1: accountEmail must come only from readAccountEmail's own string branch, never from
  // whatever the identity file happens to declare. All three fixtures below carry an
  // identity-file email so a wrongly-derived accountEmail (e.g. decl.emails.length > 0) would
  // pass every one of them.
  describe("accountEmail is never derived from the identity file's own declared emails", () => {
    test("identity file declares an email, no account state at all: false", () => {
      const result = load(home(JSON.stringify({ emails: ["fixture@example.test"] })));
      expect(result.ok && result.accountEmail).toBe(false);
    });

    test("same file, account state present but its emailAddress is not a string: false", () => {
      const result = load(
        home(JSON.stringify({ emails: ["fixture@example.test"] }), JSON.stringify({ oauthAccount: { emailAddress: 7 } })),
      );
      expect(result.ok && result.accountEmail).toBe(false);
    });

    test("same file, valid account state: true", () => {
      const result = load(home(JSON.stringify({ emails: ["fixture@example.test"] }), ACCOUNT_STATE));
      expect(result.ok && result.accountEmail).toBe(true);
    });
  });

  // A4.4: a declaration padded with whitespace used to pass the "non-empty" check untrimmed, then
  // silently fail to match anything because the pattern needed the literal padding too.
  test("a declared name padded with whitespace is trimmed on load, and still matches without the padding", () => {
    const result = load(home(JSON.stringify({ names: [" Fixture Person "] })));
    expect(result.ok && result.decl.names).toEqual(["Fixture Person"]);
    if (result.ok) expect(findIdentityHits("by Fixture Person.", result.decl)).toEqual(["declared name #1"]);
  });
});

// A4.2: the pure directory-resolution helper, tested directly so the CLAUDE_CONFIG_DIR branch is
// covered without any loadIdentity call falling through to the real environment. I6: neither
// fixture path nor the assertion style may print real profile data on a failure, so the
// CLAUDE_CONFIG_DIR fixtures are a synthetic absolute path rather than something built from
// tmpdir() (which sits under the profile directory on Windows), and the homedir()-fallback
// assertion is a boolean rather than a toEqual that would print the real path on a mismatch.
describe("accountStateDir()", () => {
  test("an explicit home wins over CLAUDE_CONFIG_DIR", () => {
    const configDir = resolve("/fixture-config");
    expect(accountStateDir("/fixture/home", { CLAUDE_CONFIG_DIR: configDir })).toEqual({ ok: true, dir: "/fixture/home" });
  });

  test("no home, an absolute CLAUDE_CONFIG_DIR: used", () => {
    const configDir = resolve("/fixture-config");
    expect(accountStateDir(undefined, { CLAUDE_CONFIG_DIR: configDir })).toEqual({ ok: true, dir: configDir });
  });

  test("no home, CLAUDE_CONFIG_DIR set to empty: refused", () => {
    expect(accountStateDir(undefined, { CLAUDE_CONFIG_DIR: "" }).ok).toBe(false);
  });

  test("no home, a relative CLAUDE_CONFIG_DIR: refused", () => {
    expect(accountStateDir(undefined, { CLAUDE_CONFIG_DIR: "relative-dir" }).ok).toBe(false);
  });

  test("no home, CLAUDE_CONFIG_DIR unset: falls to homedir()", () => {
    const result = accountStateDir(undefined, {});
    expect(result.ok && result.dir === homedir()).toBe(true);
  });
});

describe("findIdentityHits()", () => {
  test("a clean body: no hits", () => {
    expect(findIdentityHits("No findings at or above the floor.", decl())).toEqual([]);
  });

  test.each([
    ["a declared name in another case", "Reviewed by fixture PERSON", "declared name #1"],
    ["a declared email", "contact FIXTURE@example.test", "email #1"],
    ["the username", "path C:/Users/fixtureuser/key.pem", "workstation username"],
    ["the hostname", "built on fixture-host today", "machine hostname"],
  ])("%s", (_label, text, label) => {
    expect(findIdentityHits(text, decl())).toEqual([label]);
  });

  // The collision identity-patterns.sh records, with a synthetic four-letter name: a declared
  // name inside an ordinary word is not a hit, the same name standing alone is. Re-run after I4's
  // boundary change (dropping underscore from the class): neither letter is affected, so this
  // regression case has to hold exactly as before.
  test("a declared name inside a longer word is not a hit", () => {
    const d = decl({ names: ["Just"] });
    expect(findIdentityHits("adjusting the augmentation", d)).toEqual([]);
    expect(findIdentityHits("Just arrived", d)).toEqual(["declared name #1"]);
  });

  test("regex metacharacters in a declaration match literally", () => {
    const d = decl({ names: ["A.B (C)"] });
    expect(findIdentityHits("signed a.b (c)", d)).toEqual(["declared name #1"]);
    expect(findIdentityHits("signed aXb (c)", d)).toEqual([]);
  });

  test("labels never carry the matched string", () => {
    const hits = findIdentityHits("Fixture Person fixture@example.test fixtureuser fixture-host", decl());
    expect(hits.length).toBe(4);
    for (const hit of hits) {
      expect(hit.toLowerCase()).not.toContain("fixture");
    }
  });

  // A4.6: os.hostname() returns an FQDN on some platforms; a body carrying only the short label
  // still has to hit.
  test("a fully-qualified hostname still matches on its first label", () => {
    const d = decl({ hostname: "fixture-host.lan" });
    expect(findIdentityHits("built on fixture-host today", d)).toEqual(["machine hostname"]);
  });

  // A4.3: characters GitHub renders invisibly (soft hyphen, tag characters, and similar) can sit
  // inside an otherwise-visible string and split a match that would otherwise be exact. Kept on
  // bare text; I2/I3 below re-run the sharper cases through the real fenced() pipeline.
  describe("invisible characters cannot hide an identifying string", () => {
    test("a soft hyphen inside a declared email still matches", () => {
      const text = "contact fixture" + String.fromCharCode(0xad) + "@example.test";
      expect(findIdentityHits(text, decl())).toEqual(["email #1"]);
    });

    test("a tag character inside a declared name still matches", () => {
      const text = "Fixture" + String.fromCodePoint(0xe0020) + " Person";
      expect(findIdentityHits(text, decl())).toEqual(["declared name #1"]);
    });
  });

  // I2: a fenced field always opens with three backticks, "text" and a newline (render.ts). The
  // first version of A4.3's canon deleted that newline outright instead of turning it into a
  // separator, which glued the opening word of the field to whatever came before it and broke
  // every one of these. Every hostile character below comes from a code point (fromCharCode or
  // fromCodePoint), never a typed escape sequence, per the escape rule.
  describe("invisible characters inside a rendered fenced field (I2)", () => {
    test("a soft hyphen inside a declared name, name first in the field", () => {
      const text = fenced("Fixture" + String.fromCharCode(0xad) + " Person is the reviewer");
      expect(findIdentityHits(text, decl())).toEqual(["declared name #1"]);
    });

    test("a soft hyphen inside a declared email, email first in the field", () => {
      const text = fenced("fixture" + String.fromCharCode(0xad) + "@example.test is the contact");
      expect(findIdentityHits(text, decl())).toEqual(["email #1"]);
    });

    test("an observed_instructions-shaped field: a path line then a soft-hyphenated email", () => {
      const text = fenced("path: README.md" + String.fromCharCode(10) + "contact fixture" + String.fromCharCode(0xad) + "@example.test");
      expect(findIdentityHits(text, decl())).toEqual(["email #1"]);
    });

    test("a tag character in a declared name, through the real fenced() pipeline", () => {
      const text = fenced("Fixture" + String.fromCodePoint(0xe0020) + " Person");
      expect(findIdentityHits(text, decl())).toEqual(["declared name #1"]);
    });

    test("a name with a soft hyphen, sitting after a tab that follows a word", () => {
      const text = fenced("notes" + String.fromCharCode(9) + "Fixture" + String.fromCharCode(0xad) + " Person");
      expect(findIdentityHits(text, decl())).toEqual(["declared name #1"]);
    });
  });

  // I3: forms that display identically to the declared string, or nearly so, without any
  // invisible character at all. NFKC normalization plus the "u" regex flag close these.
  describe("Unicode-equivalent forms that display the same (I3)", () => {
    test("NBSP standing in for the space in a declared name, through fenced()", () => {
      const text = fenced("Fixture" + String.fromCharCode(0xa0) + "Person");
      expect(findIdentityHits(text, decl())).toEqual(["declared name #1"]);
    });

    test("a declared NFC name matched against NFD text", () => {
      const nfc = "Zo" + String.fromCharCode(0xeb) + " Fixture"; // "Zoë Fixture", e-with-diaeresis precomposed
      const nfd = "Zo" + "e" + String.fromCharCode(0x308) + " Fixture"; // same word, e + combining diaeresis
      const d = decl({ names: [nfc] });
      expect(findIdentityHits(fenced("signed by " + nfd), d)).toEqual(["declared name #1"]);
    });

    test("a declared NFD name matched against NFC text", () => {
      const nfd = "Zo" + "e" + String.fromCharCode(0x308) + " Fixture";
      const nfc = "Zo" + String.fromCharCode(0xeb) + " Fixture";
      const d = decl({ names: [nfd] });
      expect(findIdentityHits(fenced("signed by " + nfc), d)).toEqual(["declared name #1"]);
    });

    test("the Kelvin sign compatibility character standing in for a plain K", () => {
      const d = decl({ names: ["Fixture K Person"] });
      const text = fenced("Fixture " + String.fromCharCode(0x212a) + " Person");
      expect(findIdentityHits(text, d)).toEqual(["declared name #1"]);
    });
  });

  // I4: the word-boundary class used to include underscore, so a term with an underscore on
  // either side (a snake_case path or identifier, or literal underscore emphasis inside a fence)
  // did not anchor.
  describe("an underscore beside a term (I4)", () => {
    test("a declared email surrounded by underscores, through fenced()", () => {
      const text = fenced("contact _fixture@example.test_ for details");
      expect(findIdentityHits(text, decl())).toEqual(["email #1"]);
    });

    test("the username followed by an underscore suffix, through fenced()", () => {
      const text = fenced("path C:/Users/fixtureuser_old/key.pem");
      expect(findIdentityHits(text, decl())).toEqual(["workstation username"]);
    });

    test("a declared name wrapped in double underscores", () => {
      const text = fenced("by __Fixture Person__.");
      expect(findIdentityHits(text, decl())).toEqual(["declared name #1"]);
    });
  });
});
