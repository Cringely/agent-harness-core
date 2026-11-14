// PreToolUse hook (matcher: Bash) — the opt-in Bash tripwire (#266).
//
// A short list of command shapes that are rarely what the operator meant and expensive when they
// are wrong. The hook can only add friction. It returns "ask" (Claude Code prompts, and the prompt
// still appears in bypassPermissions mode), "deny" for the few commands nobody wants run, or no
// decision at all. It never returns "allow", so it cannot widen what a session may do. A command
// it cannot read in full is read again as raw text rather than passed (see FAIL CONTRACT).
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
// single-quoted strings, which are data. Heredoc bodies are always read as commands, whatever owns
// the heredoc, because telling a data heredoc from one a shell runs needs a parser that agrees with
// bash grammar, and the attempts at one each disagreed with it in a new way. The cost is a prompt on
// a body that only quotes a listed pattern, such as a commit message or note with a line reading
// `git push --force`. Each body is cut out by its line and terminator and read as a script of its
// own, so a quote in a body cannot pair with a quote outside it. It does not expand variables, follow aliases or functions, resolve a path, or
// read a script a command runs. A command built to evade it will.
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
// FAIL CONTRACT. Malformed stdin, a payload that is not a Bash call, and a missing or non-string
// command end in no decision. A command the scanner cannot read in full is different, because it
// is a real command: an unclosed single or double quote, nesting deeper than MAX_DEPTH (shells
// inside shells inside substitutions), or an exception in the scanner. For those the hook keeps
// what it found before it stopped, then reads the raw text with no quoting or nesting at all
// (rawScan) and asks on any flagged pattern anywhere in it. The command is read twice, cut into
// its command text and heredoc bodies, each part on its own, and uncut as one script, and every
// finding from both reads counts. An apostrophe in a prose body leaves the uncut read unreadable,
// so it can ask on a pattern quoted elsewhere, but a deny the cut read finds still stands. That
// over-matches, which for a command it could not read is the safe direction. An unreadable command with nothing flagged in its text
// is still no decision.

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

/** Set when any part of the command was not read: an unclosed quote, the depth cap, an exception. */
interface ScanState {
  unread: boolean;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

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
function tokenize(src: string, st: ScanState): Cmd[] {
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
      // An unclosed quote folds the rest of the command into one word, so the rest went unread.
      if (e < 0) st.unread = true;
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
      if (i >= src.length) st.unread = true;
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

function scan(text: string, depth: number, out: Finding[], st: ScanState): void {
  if (depth > MAX_DEPTH) {
    st.unread = true;
    return;
  }
  const resolved: Resolved[] = [];
  for (const cmd of tokenize(text, st)) {
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
      if (at >= 0 && at + 1 < r.args.length) scan(r.args[at + 1], depth + 1, out, st);
    } else if (r.name === "eval" && r.args.length > 0) {
      scan(r.args.join(" "), depth + 1, out, st);
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

  for (const inner of extractSubstitutions(text)) scan(inner, depth + 1, out, st);
}

/** A shell interpreter's name as a word, for rawScan's check of a download in a substitution. */
const RAW_SHELL_WORD = /(?:^|[^\w.-])(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|ash|pwsh|powershell|iex|invoke-expression)(?:\.exe)?(?![\w.-])/i;
const RAW_DOWNLOAD_IN_SUBSTITUTION = /(\$\(|<\(|`)\s*(curl|wget|iwr|irm)\b/gi;
/** How many words after a command name rawScan hands to a check. Keeps a huge command linear. */
const RAW_WINDOW = 64;

/**
 * Read a command the scanner could not read in full as flat text. Quotes are dropped, and every
 * separator, parenthesis and backtick splits the text, so nothing can fold the rest of the command
 * into one word and nothing recurses. Each check runs from every word that names a command it
 * covers, not only from the start of a command, because the structure that says where a command
 * starts is what failed to parse. Returns the reason for each pattern that matched.
 */
function rawScan(src: string): string[] {
  const found: Finding[] = [];
  const text = src.replace(/\\+(?=["'])/g, "").replace(/["']/g, " ");

  for (const chunk of text.split(/[\n;&()`]/)) {
    let fetchedBefore = false;
    for (const stage of chunk.split("|")) {
      const words = stage.split(/\s+/).filter((w) => w !== "");
      const names = words.map(baseName);
      if (fetchedBefore && names.some((n) => SHELLS.has(n))) {
        found.push({ severity: "ask", reason: "pipes a download (curl, wget) into a shell interpreter" });
      }
      if (names.some((n) => FETCHERS.has(n))) fetchedBefore = true;
      for (let k = 0; k < words.length; k++) {
        const name = names[k];
        const args = words.slice(k + 1, k + 1 + RAW_WINDOW);
        if (name === "rm") checkRm(args, found);
        else if (name === "git") checkGit(args, found);
        else if (name === "gh" || name === "op" || READERS.has(name)) checkCredentials(name, args, found);
      }
    }
  }

  for (const line of text.split("\n")) {
    const shell = RAW_SHELL_WORD.exec(line);
    if (!shell) continue;
    for (const m of line.matchAll(RAW_DOWNLOAD_IN_SUBSTITUTION)) {
      if (m.index > shell.index) {
        found.push({ severity: "ask", reason: "runs a downloaded script through a shell interpreter" });
        break;
      }
    }
  }

  return [...new Set(found.map((f) => f.reason))];
}

// ---------------------------------------------------------------------------
// Heredoc segments
// ---------------------------------------------------------------------------

/**
 * A heredoc operator: `<<` or `<<-`, then a delimiter word that may be quoted or start with a
 * backslash. Purely lexical. It does not know whether the `<<` sits inside a quoted string, and
 * need not: a false match only moves text into a segment of its own, which is still scanned.
 */
const HEREDOC_OP = /(?<!<)<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|[\x5c]?([^\s;&|<>()'"`\x5c]+))/g;

function isTerminator(line: string, word: string, dash: boolean): boolean {
  const l = line.replace(/\r$/, "");
  return (dash ? l.replace(/^\t+/, "") : l) === word;
}

/**
 * Splits a script into its command text and its heredoc bodies. A body runs from the line after
 * its operator's line to the line before its terminator, or to the end of the text when there is
 * no terminator. Several operators on one line take their bodies in order. Operator and terminator
 * lines stay in the command text, so every line of the input lands in exactly one part.
 */
function splitHeredocs(text: string): { command: string; bodies: string[]; lines: number } {
  const lines = text.split("\n");
  const command: string[] = [];
  const bodies: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    command.push(line);
    for (const m of line.matchAll(HEREDOC_OP)) {
      const word = m[2] ?? m[3] ?? m[4];
      const dash = m[1] === "-";
      const start = i;
      while (i < lines.length && !isTerminator(lines[i], word, dash)) i++;
      bodies.push(lines.slice(start, i).join("\n"));
      if (i < lines.length) command.push(lines[i++]);
    }
  }
  return { command: command.join("\n"), bodies, lines: lines.length };
}

/**
 * Scans one segment as a script of its own, with its own unread state, so an unclosed quote in a
 * prose body sends only that body to the raw-text fallback.
 */
function scanSegment(text: string, out: Finding[], unread: boolean): void {
  if (text.trim() === "") return;
  const st: ScanState = { unread };
  try {
    scan(text, 0, out, st);
  } catch {
    // Keep what was found before the failure, and read the rest as raw text below.
    st.unread = true;
  }
  if (st.unread) {
    // Raw-text matches only ask: without the structure, a match may be an argument or prose.
    const raw = rawScan(text);
    if (raw.length > 0) {
      out.push({ severity: "ask", reason: `could not read the whole command, and its raw text matches: ${raw.join(", ")}` });
    }
  }
}

/**
 * Cuts every heredoc body out of the command and scans each body, and the command text left
 * behind, as separate scripts. A body is a script of its own because a quote inside it would
 * otherwise pair with a quote outside it and hide the commands between them in one quoted word.
 * Bodies are split again for heredocs of their own. Nested bodies are re-read at each level, so
 * past a line budget the remaining segments are scanned whole and read as raw text as well.
 *
 * The uncut command is also scanned as one script, and every finding from both reads counts. The
 * operator match does not know quoting, so a `<<` inside a quoted string can cut a closing quote
 * into a body and leave the command text reading differently from bash. The uncut read is the one
 * bash's own quoting agrees with in that case, and the cut read is the one that holds when a body
 * carries a stray quote, so neither alone is enough.
 */
function scanCommand(command: string, out: Finding[]): void {
  scanSegment(command, out, false);
  const queue = [command];
  let budget = 4 * command.split("\n").length + 256;
  while (queue.length > 0) {
    const seg = queue.pop()!;
    if (budget <= 0) {
      scanSegment(seg, out, true);
      continue;
    }
    const parts = splitHeredocs(seg);
    budget -= parts.lines;
    queue.push(...parts.bodies);
    scanSegment(parts.command, out, false);
  }
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
  scanCommand(command, findings);
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
