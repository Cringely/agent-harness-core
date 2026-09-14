// GitHub App authentication for the reviewer (#120). By the operator's ruling of 2026-09-11 the
// private key lives in 1Password and reaches this process only on stdin, piped from `op read`, so it
// never exists as a file this tool could misplace. It is parsed once and never leaves this file: no
// log line, error message, environment variable or child process carries it. The installation token
// it mints lives in the caller's memory for one run and is never written to disk.
//
// Permissions. Every run reads the App's configured permissions with the JWT and refuses to continue
// if the App holds anything outside #120's three, so an App widened later in the GitHub UI stops the
// tool rather than silently lending it the new reach. The token request names the two permissions
// the tool uses, and the granted set is checked again. The minted token is also checked against the
// one repository it was requested for: GitHub docs describe an installation token as narrowed by
// `repositories`, and this tool refuses one that comes back describing more than that. Check runs,
// issues, issue comments and pull request files on this public repository are read under GitHub's
// documented allowance ("can be used without authentication or the aforementioned permissions if
// only public resources are requested"), so no checks or issues permission is requested. A 403 from
// one of those endpoints in the live smoke test is the evidence that would add one, and it gets
// recorded first.
//
// Every fetch in this file carries either the App JWT or the request that mints the installation
// token, so every one of them passes `redirect: "error"`: whether Bun strips the Authorization
// header on a cross-origin redirect is unverified, and a same-origin redirect (a renamed repository)
// should fail closed rather than silently follow.

import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { RefusalError, parseRepo, type InstallationToken, type TokenMinter } from "./types";

export const GITHUB_API = "https://api.github.com";

export const APP_PERMISSION_ALLOWLIST: Readonly<Record<string, "read" | "write">> = {
  pull_requests: "write",
  contents: "read",
  metadata: "read",
};

export const TOKEN_PERMISSIONS = { pull_requests: "write", contents: "read" } as const;

export function githubHeaders(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-harness-core-pr-review",
  };
}

// iat 60 seconds back and exp nine minutes ahead: GitHub allows at most ten, and the margin absorbs
// clock drift in the other direction. GitHub accepts either the numeric App ID or the client ID as
// the issuer.
export function createAppJwt(appId: string, key: KeyObject, nowSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })}`;
  return `${signingInput}.${sign("sha256", Buffer.from(signingInput), key).toString("base64url")}`;
}

export type KeyLoad = { ok: true; key: KeyObject } | { ok: false; reason: string };

export function parsePrivateKey(pem: string): KeyLoad {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === "rsa" ? { ok: true, key } : { ok: false, reason: "the key is not an RSA private key" };
  } catch {
    return { ok: false, reason: "stdin did not carry a parseable private key" };
  }
}

// A terminal on stdin means nothing was piped, so refusing before reading keeps a key from ever
// being typed or echoed on a console terminal. That refusal is only as good as `isTTY`, though:
// under Git Bash's mintty, the shell the live commands run from, a native Windows program sees
// stdin as a pipe even when the operator forgot the `op read | ...` in front of it, so `isTTY`
// cannot catch that case. The bound below is what actually catches a missing pipe there: a run
// with nothing arriving on stdin times out instead of waiting forever for someone to type or paste
// a key (a paste inside the bound still works and still succeeds).
export async function readPrivateKey(
  stdin: { isTTY: boolean; read: () => Promise<string> },
  options: { timeoutMs?: number } = {},
): Promise<KeyLoad> {
  if (stdin.isTTY) return { ok: false, reason: "stdin is a console terminal; pipe the key in from op read" };
  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<KeyLoad>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: `no key arrived on stdin within ${Math.round(timeoutMs / 1000)} seconds; pipe it from op read` }),
      timeoutMs,
    );
  });
  const read = stdin.read().then((pem): KeyLoad => (pem.trim() === "" ? { ok: false, reason: "stdin carried no key" } : parsePrivateKey(pem)));
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

export function checkPermissions(permissions: unknown): string | null {
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return "GitHub returned no permission set";
  const granted = permissions as Record<string, unknown>;
  for (const [name, level] of Object.entries(granted)) {
    // Object.hasOwn, not a bracket lookup: APP_PERMISSION_ALLOWLIST is a plain object, so
    // APP_PERMISSION_ALLOWLIST["constructor"] resolves through Object.prototype instead of coming
    // back undefined, and JSON.parse gives "__proto__" as a real own key rather than routing through
    // the accessor. Either name would pass the old `=== undefined` check and then dodge the level
    // check too, since the resolved "allowed" value is a function or Object.prototype, not "read".
    if (!Object.hasOwn(APP_PERMISSION_ALLOWLIST, name)) return `the App holds a permission outside the allowlist: ${name}`;
    const allowed = APP_PERMISSION_ALLOWLIST[name] as "read" | "write";
    if (level !== "read" && level !== "write") return `the App's ${name} permission has an unrecognised level`;
    if (level === "write" && allowed === "read") return `the App holds ${name}: write where the allowlist grants read`;
  }
  if (granted.pull_requests !== "write") return "the App lacks pull_requests: write";
  return null;
}

const APP_ID = /^[A-Za-z0-9.]+$/;

export class AppTokenMinter implements TokenMinter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: { appId: string; key: KeyObject; repo: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async mint(): Promise<InstallationToken> {
    if (!APP_ID.test(this.options.appId)) throw new Error("the App id must be the numeric App ID or the client ID");
    const parsed = parseRepo(this.options.repo);
    if (parsed === null) throw new Error("the repository must be given as owner/name");
    const { owner, name } = parsed;
    const headers = githubHeaders(`Bearer ${createAppJwt(this.options.appId, this.options.key, Math.floor(this.now() / 1000))}`);

    const app = await this.call("GET", "/app", headers);
    const appProblem = checkPermissions(app.permissions);
    if (appProblem) throw new RefusalError(`refusing to mint a token: ${appProblem}`);

    const installation = await this.call("GET", `/repos/${owner}/${name}/installation`, headers);
    if (!Number.isInteger(installation.id)) throw new Error("GitHub returned no installation id for this repository");

    const minted = await this.call("POST", `/app/installations/${installation.id}/access_tokens`, headers, {
      repositories: [name],
      permissions: TOKEN_PERMISSIONS,
    });
    const tokenProblem = checkPermissions(minted.permissions);
    if (tokenProblem) throw new RefusalError(`refusing the minted token: ${tokenProblem}`);
    if (minted.repository_selection !== "selected") {
      throw new RefusalError(`refusing the minted token: repository_selection is ${JSON.stringify(minted.repository_selection)}, not "selected"`);
    }
    if (Array.isArray(minted.repositories)) {
      const names = (minted.repositories as Array<Record<string, unknown>>).map((repository) => repository.name);
      if (names.length !== 1 || names[0] !== name) {
        throw new RefusalError("refusing the minted token: repositories does not name exactly the requested repository");
      }
    }
    if (typeof minted.token !== "string" || minted.token === "") throw new Error("GitHub returned no installation token");
    return { token: minted.token, expiresAt: String(minted.expires_at) };
  }

  private async call(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
}
