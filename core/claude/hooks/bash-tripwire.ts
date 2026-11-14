// PreToolUse hook (matcher: Bash) — the opt-in Bash tripwire (#266).
//
// A short list of command shapes that are rarely what the operator meant and expensive when they
// are wrong. The hook can only add friction. It returns "ask" (Claude Code prompts, and the prompt
// still appears in bypassPermissions mode), "deny" for the few commands nobody wants run, or no
// decision at all. It never returns "allow", so it cannot widen what a session may do, and an
// error anywhere ends in no decision rather than an allow.
//
// Everything is local and deterministic: no network, no API key, no model. Nothing about a command
// leaves the machine. A design that sent each command to a hosted classifier was considered and
// rejected, because command text routinely carries inline tokens and the vendor's retention terms
// do not bound how long it is kept.
//
// What it flags:
//   deny  recursive delete of `/`, `~`, `$HOME`, a home directory path, or a drive root.
//   ask   recursive force delete of a `.git` directory, or of a path that is only a variable
//         (the empty-variable accident, `rm -rf "$DIR/"`).
//   ask   git push with --force, -f, --force-with-lease, --force-if-includes or a `+refspec`.
//   ask   curl, wget (or PowerShell iwr/irm) feeding a shell interpreter, by pipe, process
//         substitution or `$(...)`.
//   ask   reading credential material: `gh auth token`, `op read`, an ssh private key, a `.env`
//         file or anything under a `secrets/` directory, through a reader command (cat, head,
//         Get-Content and similar).
//
// WHAT THIS IS NOT. It is a tripwire, not a sandbox. It reads the command text with a small shell
// tokenizer, so it sees `bash -c "..."`, `eval`, `sudo`, `env` and `$(...)` wrappers. It skips
// single-quoted strings, which are data, and heredoc bodies unless the heredoc feeds a shell or
// goes over ssh, where the body is a script. It does not expand variables, follow aliases or
// functions, resolve a path, or read a script a command runs. A command built to evade it will.
// Its job is the accident and the habitual shortcut, where one prompt is the whole value.
// Readers it does not know (grep, sed, awk, cp, scp) are not covered.
//
// OPT-IN. The installer ships this file and registers it only under -IncludeBashTripwire. A
// project that never passes the switch gets neither the script nor the settings entry.
//
// WIRE CONTRACT. An ask or deny is a `hookSpecificOutput` object on stdout with exit 0, the form
// agent-worktree-gate.ts uses. No decision is exit 0 with nothing on stdout. The code shape is the
// siblings': a pure exported `decide()`, with the process entrypoint behind `import.meta.main`.
//
// FAIL CONTRACT. Malformed stdin, a payload that is not a Bash call, a missing or non-string
// command, an unbalanced quote or parenthesis, and an exception in the scanner all end in no
// decision. A scanner that fails partway still reports what it found before it failed. Nesting
// deeper than MAX_DEPTH (shells inside shells inside substitutions) is not unwrapped further.

export type Decision =
  | { action: "none" }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string };

const NONE: Decision = { action: "none" };

/** How many levels of `bash -c`, `eval` and `$(...)` are unwrapped. Past it the text goes unread. */
export const MAX_DEPTH = 5;

interface Finding {
  severity: "ask" | "deny";
  reason: string;
}

interface Cmd {
  argv: string[];
  /** Commands joined by `|` share a pipeline number. Any other separator starts a new one. */
  pipeline: number;
}

interface Resolved {
  name: string;
  args: string[];
  pipeline: number;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * A shell interpreter, or ssh (whose remote login shell reads stdin), named anywhere on a line.
 * A heredoc on such a line feeds a script to that interpreter, so its body is code, not data.
 * Matching the whole line over-matches (a `bash` in a commit message line), which only means a
 * body gets scanned: the safe direction.
 */
const INTERPRETER_ON_LINE = new RegExp(
  "(^|[\\s|;&(`'\"])(sh|bash|zsh|dash|ksh|csh|tcsh|fish|ash|pwsh|powershell|ssh)(\\.exe)?(?=[\\s|;&)`'\"]|$)",
  "i",
);

/**
 * Remove heredoc bodies, keeping the `<<WORD` operator and the closing line. The body is data (a
 * commit message, a generated file), and scanning it would flag prose that merely mentions a
 * dangerous command. A body fed to a shell interpreter or sent over ssh is a script, so it stays
 * in place and is scanned. A heredoc with no terminator line is left in place: scanning too much
 * is the safe direction. A `<<` inside a quoted string is not told apart from a real one, which can hide
 * the lines that follow it up to a line equal to the word. That is the same class of gap as every
 * other evasion in this file, accepted for the same reason.
 */
function stripHeredocBodies(src: string): string {
  if (!src.includes("<<")) return src;
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    const m = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\2(?!<)/.exec(line);
    if (!m) continue;
    if (INTERPRETER_ON_LINE.test(line)) continue;
    const word = m[3];
    const dash = m[1] === "-";
    let end = -1;
    for (let j = i; j < lines.length; j++) {
      const candidate = lines[j].replace(/\r$/, "");
      if ((dash ? candidate.replace(/^\t+/, "") : candidate) === word) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    out.push(lines[end]);
    i = end + 1;
  }
  return out.join("\n");
}

/** Index of the `)` that closes the `(` at `open`, or the last index when it never closes. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) return src.length - 1;
      i = e;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        else if (src[j] === "$" && src[j + 1] === "(") j = matchParen(src, j + 1);
        j++;
      }
      i = j;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

/** Split a command line into commands and words. Quotes are removed, substitutions are kept raw. */
function tokenize(src: string): Cmd[] {
  const cmds: Cmd[] = [];
  let argv: string[] = [];
  let tok = "";
  let inTok = false;
  let pipeline = 0;

  const pushTok = () => {
    if (inTok) argv.push(tok);
    tok = "";
    inTok = false;
  };
  const endCmd = (piped: boolean) => {
    pushTok();
    if (argv.length > 0) cmds.push({ argv, pipeline });
    argv = [];
    if (!piped) pipeline++;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const stop = e < 0 ? src.length : e;
      tok += src.slice(i + 1, stop);
      inTok = true;
      i = stop + 1;
    } else if (c === '"') {
      inTok = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[i + 1];
          tok += n === '"' || n === "\\" || n === "$" || n === "`" ? n : "\\" + n;
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "(") {
          const j = matchParen(src, i + 1);
          tok += src.slice(i, j + 1);
          i = j + 1;
        } else {
          tok += src[i];
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      if (next === "\n") {
        i += 2;
      } else if (next !== undefined && " \t\"'$\\`;&|<>()".includes(next)) {
        tok += next;
        inTok = true;
        i += 2;
      } else {
        // Keep the backslash: it is a path separator in a Windows path, not an escape.
        tok += c;
        inTok = true;
        i++;
      }
    } else if (c === "$" && next === "(") {
      const j = matchParen(src, i + 1);
      tok += src.slice(i, j + 1);
      inTok = true;
      i = j + 1;
    } else if (c === "`") {
      const e = src.indexOf("`", i + 1);
      const stop = e < 0 ? src.length - 1 : e;
      tok += src.slice(i, stop + 1);
      inTok = true;
      i = stop + 1;
    } else if ((c === "<" || c === ">") && next === "(") {
      const j = matchParen(src, i + 1);
      tok += src.slice(i, j + 1);
      inTok = true;
      i = j + 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      pushTok();
      i++;
    } else if (c === "\n" || c === ";") {
      endCmd(false);
      i++;
    } else if (c === "&") {
      if (next === "&") {
        endCmd(false);
        i += 2;
      } else if (next === ">" || tok.endsWith(">") || tok.endsWith("<")) {
        tok += c;
        inTok = true;
        i++;
      } else {
        endCmd(false);
        i++;
      }
    } else if (c === "|") {
      if (next === "|") {
        endCmd(false);
        i += 2;
      } else {
        endCmd(true);
        i += next === "&" ? 2 : 1;
      }
    } else if (c === "(" || c === ")") {
      endCmd(false);
      i++;
    } else if (c === "#" && !inTok) {
      while (i < src.length && src[i] !== "\n") i++;
    } else {
      tok += c;
      inTok = true;
      i++;
    }
  }
  endCmd(false);
  return cmds;
}

/** The bodies of every `$(...)`, backtick and `<(...)` outside single quotes, outermost only. */
function extractSubstitutions(src: string): string[] {
  const found: string[] = [];
  let inDq = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === '"') { inDq = !inDq; continue; }
    if (c === "'" && !inDq) {
      const e = src.indexOf("'", i + 1);
      if (e < 0) break;
      i = e;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && src[i + 1] === "(" && (c === "$" || !inDq)) {
      const j = matchParen(src, i + 1);
      found.push(src.slice(i + 2, src[j] === ")" ? j : j + 1));
      i = j;
    } else if (c === "`") {
      const e = src.indexOf("`", i + 1);
      const stop = e < 0 ? src.length : e;
      found.push(src.slice(i + 1, stop));
      i = stop;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "ash", "pwsh", "powershell", "iex", "invoke-expression"]);
const FETCHERS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod"]);
const READERS = new Set([
  "cat", "less", "more", "head", "tail", "bat", "batcat", "nl", "tac", "strings", "xxd", "od", "hexdump",
  "base64", "type", "get-content", "gc",
]);

const KEYWORDS = new Set(["if", "while", "until", "then", "do", "else", "elif", "!", "{", "}", "time", "command", "exec", "builtin", "nohup"]);
const SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"]);
const ENV_VALUE_FLAGS = new Set(["-u", "-C", "-S"]);

function resolve(argv: string[], pipeline: number): Resolved | null {
  let a = argv.slice();
  for (let guard = 0; guard < 64 && a.length > 0; guard++) {
    const head = a[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || KEYWORDS.has(head)) {
      a = a.slice(1);
      continue;
    }
    const base = baseName(head);
    if (base === "sudo" || base === "doas") {
      a = a.slice(1);
      while (a.length > 0 && a[0].startsWith("-")) a = SUDO_VALUE_FLAGS.has(a[0]) ? a.slice(2) : a.slice(1);
      continue;
    }
    if (base === "env") {
      a = a.slice(1);
      while (a.length > 0 && a[0].startsWith("-")) a = ENV_VALUE_FLAGS.has(a[0]) ? a.slice(2) : a.slice(1);
      continue;
    }
    break;
  }
  if (a.length === 0) return null;
  return { name: baseName(a[0]), args: a.slice(1), pipeline };
}

function baseName(word: string): string {
  const parts = word.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1].toLowerCase().replace(/\.exe$/, "");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Target classes for a recursive delete. Matched on the path as written, nothing is expanded. */
function classifyDeleteTarget(raw: string): "root" | "git" | "variable" | null {
  let s = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  let bare = s;
  for (;;) {
    const trimmed = bare.replace(/\/\*$/, "").replace(/\/\.$/, "").replace(/\/+$/, "");
    if (trimmed === bare) break;
    bare = trimmed;
  }
  if (bare === "" && s.startsWith("/")) return "root";
  if (/^[A-Za-z]:$/.test(bare)) return "root";
  if (/^\/(mnt\/)?[A-Za-z]$/.test(bare)) return "root";
  if (/^(~|\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|%USERPROFILE%)$/i.test(bare)) return "root";
  if (/^\/(home|Users)(\/[^/]+)?$/.test(bare)) return "root";
  if (bare === "/root") return "root";
  if (/^\/(mnt\/)?[A-Za-z]\/Users(\/[^/]+)?$/.test(bare)) return "root";
  if (/^[A-Za-z]:\/Users(\/[^/]+)?$/i.test(bare)) return "root";
  const last = bare.split("/").pop();
  if (last === ".git") return "git";
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(bare)) return "variable";
  return null;
}

function checkRm(args: string[], out: Finding[]): void {
  let recursive = false;
  let force = false;
  const targets: string[] = [];
  let endOfFlags = false;
  for (const a of args) {
    if (!endOfFlags && a === "--") { endOfFlags = true; continue; }
    if (!endOfFlags && a.startsWith("--")) {
      if (a === "--recursive") recursive = true;
      if (a === "--force") force = true;
    } else if (!endOfFlags && /^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      if (a.includes("f")) force = true;
    } else {
      targets.push(a);
    }
  }
  if (!recursive) return;
  for (const t of targets) {
    const cls = classifyDeleteTarget(t);
    if (cls === "root") {
      out.push({ severity: "deny", reason: "recursive delete of a root, home or drive directory" });
    } else if (force && cls === "git") {
      out.push({ severity: "ask", reason: "recursive force delete of a .git directory" });
    } else if (force && cls === "variable") {
      out.push({ severity: "ask", reason: "recursive force delete of a path that is only a variable, which deletes from the root if it is empty" });
    }
  }
}

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);

function checkGit(args: string[], out: Finding[]): void {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  if (args[i] !== "push") return;
  for (const a of args.slice(i + 1)) {
    const forced =
      a === "--force" ||
      a === "-f" ||
      a === "--force-if-includes" ||
      a === "--force-with-lease" ||
      a.startsWith("--force-with-lease=") ||
      /^-[A-Za-z]*f[A-Za-z]*$/.test(a) ||
      /^\+[^\s+]/.test(a);
    if (forced) {
      out.push({ severity: "ask", reason: "git push with force (--force, -f, --force-with-lease or a +refspec) can overwrite remote history" });
      return;
    }
  }
}

function isCredentialPath(raw: string): boolean {
  const p = raw.trim().replace(/\\/g, "/");
  const parts = p.split("/").filter((x) => x !== "");
  if (parts.length === 0) return false;
  const base = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  if (base === ".env" || /\.env$/.test(base)) return true;
  if (/^\.env\./.test(base) && !/\.(example|sample|template|dist|defaults?)$/i.test(base)) return true;
  if (dirs.includes("secrets") || dirs.includes(".secrets")) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(base)) return true;
  if (dirs.includes(".ssh") && !base.endsWith(".pub") && !["known_hosts", "known_hosts.old", "config", "authorized_keys"].includes(base)) return true;
  return false;
}

function checkCredentials(name: string, args: string[], out: Finding[]): void {
  if (name === "gh") {
    if (args[0] === "auth" && args[1] === "token") {
      out.push({ severity: "ask", reason: "reads the GitHub CLI token (gh auth token)" });
    } else if (args[0] === "auth" && args[1] === "status" && args.some((a) => a === "-t" || a === "--show-token")) {
      out.push({ severity: "ask", reason: "prints the GitHub CLI token (gh auth status --show-token)" });
    }
    return;
  }
  if (name === "op") {
    const first = args.find((a) => !a.startsWith("-"));
    if (first === "read") out.push({ severity: "ask", reason: "reads a 1Password secret (op read)" });
    return;
  }
  if (READERS.has(name)) {
    if (args.some((a) => !a.startsWith("-") && isCredentialPath(a))) {
      out.push({ severity: "ask", reason: `${name} reads credential material (ssh private key, .env or secrets/ file)` });
    }
  }
}

const DOWNLOAD_IN_SUBSTITUTION = /(\$\(|<\(|`)\s*(curl|wget|iwr|irm)\b/i;

function isShellFlagC(name: string, a: string): boolean {
  if (name === "pwsh" || name === "powershell") return /^-(c|command)$/i.test(a);
  return /^-[A-Za-z]*c[A-Za-z]*$/.test(a);
}

function scan(src: string, depth: number, out: Finding[]): void {
  if (depth > MAX_DEPTH) return;
  const text = stripHeredocBodies(src);
  const resolved: Resolved[] = [];
  for (const cmd of tokenize(text)) {
    const r = resolve(cmd.argv, cmd.pipeline);
    if (r) resolved.push(r);
  }

  for (const r of resolved) {
    if (r.name === "rm") checkRm(r.args, out);
    else if (r.name === "git") checkGit(r.args, out);
    else checkCredentials(r.name, r.args, out);

    if (SHELLS.has(r.name)) {
      if (r.args.some((a) => DOWNLOAD_IN_SUBSTITUTION.test(a))) {
        out.push({ severity: "ask", reason: "runs a downloaded script through a shell interpreter" });
      }
      const at = r.args.findIndex((a) => isShellFlagC(r.name, a));
      if (at >= 0 && at + 1 < r.args.length) scan(r.args[at + 1], depth + 1, out);
    } else if (r.name === "eval" && r.args.length > 0) {
      scan(r.args.join(" "), depth + 1, out);
    }
  }

  // A download in one pipeline stage reaching an interpreter in a later one.
  const byPipeline = new Map<number, Resolved[]>();
  for (const r of resolved) {
    const list = byPipeline.get(r.pipeline);
    if (list) list.push(r);
    else byPipeline.set(r.pipeline, [r]);
  }
  for (const stages of byPipeline.values()) {
    const firstFetch = stages.findIndex((s) => FETCHERS.has(s.name));
    if (firstFetch < 0) continue;
    if (stages.slice(firstFetch + 1).some((s) => SHELLS.has(s.name))) {
      out.push({ severity: "ask", reason: "pipes a download (curl, wget) into a shell interpreter" });
    }
  }

  for (const inner of extractSubstitutions(text)) scan(inner, depth + 1, out);
}

/** Decide on a PreToolUse payload. Never returns an allow. */
export function decide(payload: unknown): Decision {
  if (typeof payload !== "object" || payload === null) return NONE;
  const p = payload as Record<string, unknown>;
  if (typeof p.tool_name === "string" && p.tool_name !== "Bash") return NONE;
  const input = p.tool_input;
  if (typeof input !== "object" || input === null) return NONE;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || command.trim() === "") return NONE;

  const findings: Finding[] = [];
  try {
    scan(command, 0, findings);
  } catch {
    // Report what was found before the failure. Otherwise this is no decision.
  }
  if (findings.length === 0) return NONE;

  const severity = findings.some((f) => f.severity === "deny") ? "deny" : "ask";
  const reasons = [...new Set(findings.filter((f) => f.severity === severity).map((f) => f.reason))];
  const reason = `bash-tripwire: ${reasons.join("; ")}. This hook is an opt-in tripwire and only ever asks or denies.`;
  return { action: severity, reason };
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text();
    // Copilot CLI also runs .claude/settings.json hooks and fails closed on them (#227). Stand
    // down there, but never while CLAUDECODE is set, so a Claude Code session always runs the rest.
    if (process.env.COPILOT_CLI && !process.env.CLAUDECODE) process.exit(0);
    if (raw.trim() === "") process.exit(0);

    const decision = decide(JSON.parse(raw));
    if (decision.action !== "none") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision.action,
            permissionDecisionReason: decision.reason,
          },
        }),
      );
    }
  } catch (err) {
    // No decision. Exit 0 with nothing on stdout is Claude Code's "no opinion", and the stderr
    // line keeps a hook that has stopped working visible to whoever reads hook output.
    console.error(`bash-tripwire: hook error, no decision: ${String(err)}`);
  }
  process.exit(0);
}
