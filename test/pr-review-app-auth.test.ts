// Tests for tools/pr-review/app-auth.ts. Keys are generated per run; no real App key is ever read.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { RefusalError } from "../tools/pr-review/types";
import {
  APP_PERMISSION_ALLOWLIST,
  AppTokenMinter,
  TOKEN_PERMISSIONS,
  checkPermissions,
  createAppJwt,
  parsePrivateKey,
  readPrivateKey,
} from "../tools/pr-review/app-auth";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

describe("createAppJwt()", () => {
  const jwt = createAppJwt("123456", privateKey, 1_700_000_000);
  const [header, payload, signature] = jwt.split(".");
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  test("has an RS256 header and the documented claims", () => {
    expect(jwt.split(".").length).toBe(3);
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload!)).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "123456" });
  });

  test("expires less than ten minutes after it was issued", () => {
    expect(decode(payload!).exp - 1_700_000_000).toBeLessThan(600);
  });

  test("verifies with the public key, and a tampered payload does not", () => {
    const signatureBytes = Buffer.from(signature!, "base64url");
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, signatureBytes)).toBe(true);
    const forged = Buffer.from(JSON.stringify({ iat: 1, exp: 9_999_999_999, iss: "123456" })).toString("base64url");
    expect(verify("sha256", Buffer.from(`${header}.${forged}`), publicKey, signatureBytes)).toBe(false);
  });
});

describe("parsePrivateKey()", () => {
  test("accepts a PKCS#1 RSA PEM, the format GitHub issues App keys in", () => {
    expect(parsePrivateKey(PKCS1_PEM).ok).toBe(true);
  });

  test("accepts the same PEM with CRLF line endings, as a Windows pipe may deliver it", () => {
    expect(parsePrivateKey(PKCS1_PEM.replace(/\n/g, "\r\n")).ok).toBe(true);
  });

  test("rejects garbage and a non-RSA key", () => {
    expect(parsePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n").ok).toBe(false);
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(parsePrivateKey(ec).ok).toBe(false);
  });
});

describe("readPrivateKey()", () => {
  test("parses a key piped on stdin", async () => {
    expect((await readPrivateKey({ isTTY: false, read: async () => PKCS1_PEM })).ok).toBe(true);
  });

  test("a terminal on stdin is refused without reading from it", async () => {
    let read = false;
    const result = await readPrivateKey({
      isTTY: true,
      read: async () => {
        read = true;
        return PKCS1_PEM;
      },
    });
    expect(result.ok).toBe(false);
    expect(read).toBe(false);
  });

  test.each([
    ["empty input", ""],
    ["only whitespace", "\r\n  \n"],
    ["text that is not a key", "hello"],
  ])("%s is refused", async (_label, text) => {
    expect((await readPrivateKey({ isTTY: false, read: async () => text })).ok).toBe(false);
  });

  test("a refusal never quotes what was read", async () => {
    const result = await readPrivateKey({ isTTY: false, read: async () => "SECRET-MATERIAL-XYZ" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("SECRET-MATERIAL-XYZ");
  });

  test("a read that never resolves times out instead of hanging forever", async () => {
    // A10.4: under Git Bash's mintty, a native program can see stdin as a pipe (isTTY false) even
    // when the operator forgot to pipe a key in, so the bound below is what actually catches it.
    //
    // F3: this test races readPrivateKey against a guard timer of its own, independent of the
    // implementation under test. Without the guard, ablating the 60s bound leaves this await on a
    // promise that never settles: bun's own per-test timeout does not reliably fire once the
    // implementation's 50ms timer has already gone off and cleared, so the runner hangs instead of
    // failing (measured: killed externally at 45s, no summary line). The guard below fails this
    // test in about a second instead, and CI has no timeout-minutes set on this job either, so
    // without it a regression here would hang the whole workflow to GitHub's 360-minute default.
    const guardMs = 2_000;
    let guardTimer: ReturnType<typeof setTimeout>;
    const guard = new Promise<never>((_, reject) => {
      guardTimer = setTimeout(() => reject(new Error(`guard: readPrivateKey did not settle within ${guardMs}ms`)), guardMs);
    });
    try {
      const result = await Promise.race([readPrivateKey({ isTTY: false, read: () => new Promise<string>(() => {}) }, { timeoutMs: 50 }), guard]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("pipe it from op read");
    } finally {
      clearTimeout(guardTimer!);
    }
  });
});

describe("checkPermissions()", () => {
  test("the allowlist itself passes", () => {
    expect(checkPermissions({ ...APP_PERMISSION_ALLOWLIST })).toBeNull();
  });

  test("the allowlist is exactly #120's three permissions", () => {
    expect(APP_PERMISSION_ALLOWLIST).toEqual({ pull_requests: "write", contents: "read", metadata: "read" });
    expect(TOKEN_PERMISSIONS).toEqual({ pull_requests: "write", contents: "read" });
  });

  test.each([
    ["checks", { ...APP_PERMISSION_ALLOWLIST, checks: "read" }],
    ["issues", { ...APP_PERMISSION_ALLOWLIST, issues: "read" }],
    ["administration", { ...APP_PERMISSION_ALLOWLIST, administration: "read" }],
    ["workflows", { ...APP_PERMISSION_ALLOWLIST, workflows: "write" }],
    ["contents write", { ...APP_PERMISSION_ALLOWLIST, contents: "write" }],
    ["no pull_requests write", { contents: "read", metadata: "read" }],
    ["an unknown level", { ...APP_PERMISSION_ALLOWLIST, contents: "admin" }],
    ["no permission set", null],
    // A10.3: every row above names a permission a plan-derived denylist (checks, issues,
    // administration, workflows) would also list. "pages" is not on any such list, so this row
    // only fails against the real allowlist, never against a denylist standing in for it.
    ["an unlisted permission", { ...APP_PERMISSION_ALLOWLIST, pages: "read" }],
    // A10.2: APP_PERMISSION_ALLOWLIST is a plain object; a bracket lookup for this name would
    // resolve through Object.prototype instead of coming back undefined.
    ["a prototype method name", { ...APP_PERMISSION_ALLOWLIST, constructor: "write" }],
  ])("refuses %s", (_label, permissions) => {
    expect(checkPermissions(permissions)).not.toBeNull();
  });

  test("refuses a permission set carrying its own __proto__ key", () => {
    // A10.2: JSON.parse gives "__proto__" as a genuine own data property instead of routing
    // through the accessor (an object literal with a literal __proto__ key would not reproduce
    // this: that syntax sets the prototype instead of creating an own key).
    const permissions = JSON.parse('{"pull_requests":"write","__proto__":"read"}');
    expect(checkPermissions(permissions)).not.toBeNull();
  });
});

describe("AppTokenMinter", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const GRANTED = { pull_requests: "write", contents: "read", metadata: "read" };

  function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
    const calls: Array<{ key: string; init: RequestInit }> = [];
    const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const key = `${init.method ?? "GET"} ${url.pathname}`;
      calls.push({ key, init });
      const route = routes[key];
      return route ? route(init) : json({ message: "Not Found" }, 404);
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const happyRoutes = (overrides: Record<string, (init: RequestInit) => Response> = {}) => ({
    "GET /app": () => json({ permissions: GRANTED }),
    "GET /repos/owner/name/installation": () => json({ id: 42 }),
    "POST /app/installations/42/access_tokens": () =>
      json({
        token: "ghs_fixture",
        expires_at: "2026-09-11T00:00:00Z",
        permissions: GRANTED,
        repository_selection: "selected",
        repositories: [{ name: "name" }],
      }),
    ...overrides,
  });

  const minter = (impl: typeof fetch, repo = "owner/name", appId = "123456") =>
    new AppTokenMinter({ appId, key: privateKey, repo, fetchImpl: impl, now: () => 1_700_000_000_000 });

  test("mints a token narrowed to one repository and two permissions", async () => {
    const { impl, calls } = fakeFetch(happyRoutes());
    expect(await minter(impl).mint()).toEqual({ token: "ghs_fixture", expiresAt: "2026-09-11T00:00:00Z" });
    expect(calls.map((c) => c.key)).toEqual(["GET /app", "GET /repos/owner/name/installation", "POST /app/installations/42/access_tokens"]);
    const auth = new Headers(calls[0]!.init.headers).get("Authorization")!;
    expect(auth.startsWith("Bearer ")).toBe(true);
    expect(auth.slice("Bearer ".length).split(".").length).toBe(3);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ repositories: ["name"], permissions: TOKEN_PERMISSIONS });
  });

  test("every GitHub request is made with redirect: error", async () => {
    // A10.6: whether Bun 1.3.14 strips Authorization on a cross-origin redirect is unverified, so
    // every JWT- or token-bearing call fails closed on any redirect rather than following it.
    const { impl, calls } = fakeFetch(happyRoutes());
    await minter(impl).mint();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.init.redirect).toBe("error");
  });

  test("an App holding administration is refused before any installation lookup", async () => {
    const { impl, calls } = fakeFetch(happyRoutes({ "GET /app": () => json({ permissions: { ...GRANTED, administration: "write" } }) }));
    const attempt = minter(impl).mint();
    await expect(attempt).rejects.toThrow("administration");
    await expect(attempt).rejects.toBeInstanceOf(RefusalError);
    expect(calls.length).toBe(1);
  });

  test("a minted token wider than requested is refused, and the error does not carry it", async () => {
    const { impl } = fakeFetch(
      happyRoutes({
        "POST /app/installations/42/access_tokens": () =>
          json({
            token: "ghs_fixture",
            expires_at: "x",
            permissions: { ...GRANTED, contents: "write" },
            repository_selection: "selected",
            repositories: [{ name: "name" }],
          }),
      }),
    );
    const error = await minter(impl).mint().catch((e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as Error).message).not.toContain("ghs_fixture");
  });

  test("a token whose repository_selection is not \"selected\" is refused", async () => {
    // A10.5: the request narrows to one repository, but nothing checked that GitHub actually
    // returned a narrowed token before this ruling.
    const { impl } = fakeFetch(
      happyRoutes({
        "POST /app/installations/42/access_tokens": () =>
          json({ token: "ghs_fixture", expires_at: "x", permissions: GRANTED, repository_selection: "all" }),
      }),
    );
    const error = await minter(impl).mint().catch((e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
  });

  test("a token naming a different repository than requested is refused", async () => {
    const { impl } = fakeFetch(
      happyRoutes({
        "POST /app/installations/42/access_tokens": () =>
          json({
            token: "ghs_fixture",
            expires_at: "x",
            permissions: GRANTED,
            repository_selection: "selected",
            repositories: [{ name: "other" }],
          }),
      }),
    );
    const error = await minter(impl).mint().catch((e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
  });

  test("a token naming the requested repository plus an extra one is refused", async () => {
    // F2: the only prior wrong-repository test used a single wrong name, so the "exactly one"
    // half of the check (names.length !== 1) was never independently exercised; a response
    // listing the requested repository alongside another one passed undetected.
    const { impl } = fakeFetch(
      happyRoutes({
        "POST /app/installations/42/access_tokens": () =>
          json({
            token: "ghs_fixture",
            expires_at: "x",
            permissions: GRANTED,
            repository_selection: "selected",
            repositories: [{ name: "name" }, { name: "other" }],
          }),
      }),
    );
    const error = await minter(impl).mint().catch((e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
  });

  test.each([
    ["null", null],
    ["a string", "all"],
    ["an array-like object", { 0: { name: "name" }, 1: { name: "other" }, length: 2 }],
  ])("a token whose repositories is %s, not an array, is refused", async (_label, repositories) => {
    // F1: repository_selection "selected" alone is not the narrowing check. The array branch was
    // only entered on Array.isArray(minted.repositories), so a present-but-malformed repositories
    // field of any other type skipped the narrowing check entirely and the token was returned.
    const { impl } = fakeFetch(
      happyRoutes({
        "POST /app/installations/42/access_tokens": () =>
          json({ token: "ghs_fixture", expires_at: "x", permissions: GRANTED, repository_selection: "selected", repositories }),
      }),
    );
    const error = await minter(impl).mint().catch((e: Error) => e);
    expect(error).toBeInstanceOf(RefusalError);
  });

  test("an HTTP failure names the status and not the JWT", async () => {
    const { impl, calls } = fakeFetch(happyRoutes({ "GET /repos/owner/name/installation": () => json({ message: "Not Found" }, 404) }));
    const error = (await minter(impl).mint().catch((e: Error) => e)) as Error;
    expect(error.message).toContain("404");
    const jwt = new Headers(calls[0]!.init.headers).get("Authorization")!.slice("Bearer ".length);
    expect(error.message).not.toContain(jwt);
  });

  test.each(["owner/name/extra", "../name", "owner/", "owner name/x"])("refuses the repository string %p", async (repo) => {
    const { impl } = fakeFetch(happyRoutes());
    await expect(minter(impl, repo).mint()).rejects.toThrow();
  });

  test.each(["", "12 34", "Iv23/../x"])("refuses the App id %p", async (appId) => {
    const { impl } = fakeFetch(happyRoutes());
    await expect(minter(impl, "owner/name", appId).mint()).rejects.toThrow();
  });
});
