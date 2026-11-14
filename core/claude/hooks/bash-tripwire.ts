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
// single-quoted strings, which are data, and heredoc bodies unless any word of the pipeline that
// owns the heredoc names a shell or ssh, where the body is a script. That holds behind any wrapper
// (`timeout`, `nice`, `sudo`, `xargs`), and a group, subshell or substitution holding the heredoc
// counts as one stage of the pipeline around it. A `<<` inside a quoted string on its line is not
// a heredoc. It does not expand variables, follow aliases or
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
// FAIL CONTRACT. Malformed stdin, a payload that is not a Bash call, and a missing or non-string
// command end in no decision. A command the scanner cannot read in full is different, because it
// is a real command: an unclosed single or double quote, nesting deeper than MAX_DEPTH (shells
// inside shells inside substitutions), or an exception in the scanner. For those the hook keeps
// what it found before it stopped, then reads the raw text with no quoting or nesting at all
// (rawScan) and asks on any flagged pattern anywhere in it. That over-matches, which for a command
// it could not read is the safe direction. An unreadable command with nothing flagged in its text
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

/** Stands in for the `<<WORD` operator so the pipeline that owns it can be found. */
const HEREDOC_MARK = "__bash_tripwire_heredoc__";

/** How far past the heredoc the owner scan reads before it gives up and calls the body code. */
const HEREDOC_OWNER_SCAN = 1 << 16;

const GROUP_OPENERS = new Set(["if", "while", "until", "for", "select", "case"]);
const GROUP_CLOSERS = new Set(["fi", "done", "esac"]);
const PREFIX_KEYWORDS = new Set(["then", "do", "else", "elif", "!", "time"]);

function namesShell(word: string): boolean {
  const base = baseName(word);
  return SHELLS.has(base) || base === "ssh";
}

interface OwnerFrame {
  /** `(` subshell or process substitution, `$(`, backtick, `{` group, or an if/while/for/case compound. */
  kind: "top" | "paren" | "sub" | "tick" | "brace" | "compound";
  /** Words of the pipeline being read in this frame. */
  words: string[];
  /** Every word read in this frame, which is what the frame contributes to its parent's pipeline. */
  all: string[];
  word: string;
  quoted: boolean;
  dq: boolean;
  cmdPos: boolean;
  /** The heredoc, or a frame holding it, is a stage of the pipeline being read here. */
  target: boolean;
  /** A pipeline of this frame held the heredoc and has ended, so the parent's pipeline now does. */
  held: boolean;
}

/**
 * Whether the heredoc whose `<<` starts at `at` on `line` is code rather than data. `rest` is the
 * command text after the heredoc's terminator line.
 *
 * It is code when any word of the pipeline that owns the `<<` names a shell or ssh (whose remote
 * login shell reads stdin), with any path prefix stripped. Wrappers are not enumerated, so
 * `timeout 5 bash`, `nice bash`, `sudo -u x stdbuf -oL bash` and `xargs bash -c` all count. A
 * group, subshell, compound command or substitution is one stage of the pipeline around it, so the
 * pipeline that owns a heredoc inside one runs on outward, past a closer that may sit after the
 * body: `{ cat <<EOF; } | bash`, `(cat <<EOF ... EOF) | bash`, `bash -c "$(cat <<EOF ...)"`. A
 * command after `;`, `&&`, `||` or `&` is a different pipeline and does not count, which is what
 * keeps `bash -n x.sh && git commit -m "$(cat <<EOF` a data heredoc. Words in the body are never
 * read here.
 *
 * Anything this cannot settle answers true, which keeps the body in place to be scanned: a `<<`
 * inside a quoted string (not a heredoc at all), an unclosed single quote, or an owner pipeline
 * that runs on past HEREDOC_OWNER_SCAN characters.
 */
function heredocIsCode(line: string, at: number, opLen: number, rest: string): boolean {
  const head = `${line.slice(0, at)} `;
  const markAt = head.length;
  const text = `${head}${HEREDOC_MARK} ${line.slice(at + opLen)}\n${rest}`;
  const limit = markAt + HEREDOC_OWNER_SCAN;
  const owner: string[] = [];
  let marked = false;
  const frame = (kind: OwnerFrame["kind"]): OwnerFrame =>
    ({ kind, words: [], all: [], word: "", quoted: false, dq: false, cmdPos: true, target: false, held: false });
  const frames: OwnerFrame[] = [frame("top")];
  const top = () => frames[frames.length - 1];
  const close = () => {
    const child = frames.pop()!;
    const parent = top();
    if (child.target) owner.push(...child.words);
    parent.words.push(...child.all);
    parent.all.push(...child.all);
    if (child.target || child.held) parent.target = true;
    parent.cmdPos = false;
  };
  const endWord = () => {
    const f = top();
    const w = f.word;
    const bare = !f.quoted;
    f.word = "";
    f.quoted = false;
    if (w === "" && bare) return;
    if (bare && w === HEREDOC_MARK) {
      marked = true;
      f.target = true;
      return;
    }
    if (bare && f.cmdPos) {
      if (w === "{" || GROUP_OPENERS.has(w)) {
        frames.push(frame(w === "{" ? "brace" : "compound"));
        return;
      }
      if ((w === "}" && f.kind === "brace") || (GROUP_CLOSERS.has(w) && f.kind === "compound")) {
        close();
        return;
      }
    }
    f.words.push(w);
    f.all.push(w);
    f.cmdPos = bare && PREFIX_KEYWORDS.has(w);
  };
  /** Ends the pipeline being read. True when that was the outermost pipeline holding the heredoc. */
  const separator = (): boolean => {
    endWord();
    const f = top();
    f.cmdPos = true;
    if (f.target) {
      owner.push(...f.words);
      if (frames.length === 1) return true;
      f.target = false;
      f.held = true;
    }
    f.words = [];
    return false;
  };
  let done = false;
  for (let i = 0; i < text.length && !done; i++) {
    if (i > limit) return true;
    const f = top();
    const c = text[i];
    if (c === "\\") {
      if (text[i + 1] !== "\n") {
        f.word += text[i + 1] ?? "";
        f.quoted = true;
      }
      i++;
      continue;
    }
    if (c === "'" && !f.dq) {
      const e = text.indexOf("'", i + 1);
      if (e < 0) return true;
      f.word += text.slice(i + 1, e);
      f.quoted = true;
      i = e;
      continue;
    }
    if (c === '"') {
      f.dq = !f.dq;
      f.quoted = true;
      continue;
    }
    if (c === "`") {
      if (f.kind === "tick" && !f.dq) close();
      else frames.push(frame("tick"));
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      frames.push(frame("sub"));
      i++;
      continue;
    }
    if (f.dq) {
      f.word += c;
      continue;
    }
    if (c === "(") {
      endWord();
      frames.push(frame("paren"));
    } else if (c === ")") {
      endWord();
      if (top().kind === "paren" || top().kind === "sub") close();
    } else if (c === "|") {
      endWord();
      if (text[i + 1] === "|") {
        i++;
        done = separator();
      } else {
        if (text[i + 1] === "&") i++;
        top().cmdPos = true;
      }
    } else if (c === "&") {
      if (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">") {
        endWord();
      } else {
        if (text[i + 1] === "&") i++;
        done = separator();
      }
    } else if (c === ";" || c === "\n") {
      done = separator();
    } else if (c === " " || c === "\t" || c === "\r" || c === "<" || c === ">") {
      endWord();
    } else {
      f.word += c;
    }
  }
  if (!done) {
    // Frames left open at the end: each one is a stage of the pipeline around it.
    endWord();
    let inside = false;
    for (let k = frames.length - 1; k >= 0; k--) {
      const f = frames[k];
      if (f.target || inside) owner.push(...f.words);
      inside = inside || f.target || f.held;
    }
  }
  if (!marked) return true;
  return owner.some(namesShell);
}

/**
 * Remove heredoc bodies, keeping the `<<WORD` operator and the closing line. The body is data (a
 * commit message, a generated file), and scanning it would flag prose that merely mentions a
 * dangerous command. A body that heredocIsCode says feeds a shell or ssh is a script, so it stays
 * in place and is scanned. A heredoc with no terminator line is left in place: scanning too much
 * is the safe direction.
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
    let rest = "";
    for (let j = end + 1; j < lines.length && rest.length <= HEREDOC_OWNER_SCAN; j++) rest += `${lines[j]}\n`;
    if (heredocIsCode(line, m.index, m[0].length, rest)) continue;
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

/**
 * `strip` is false for the text of a substitution. The pass that read the text holding it already
 * decided every heredoc in it, owner pipelines outside the substitution included, so a second pass
 * over the substitution alone would see only the inner pipeline and drop a body fed to a shell
 * outside it (`bash <(cat <<EOF ...)`). A `bash -c` or eval string is a new script, so it is
 * stripped in its own right.
 */
function scan(src: string, depth: number, out: Finding[], st: ScanState, strip = true): void {
  if (depth > MAX_DEPTH) {
    st.unread = true;
    return;
  }
  const text = strip ? stripHeredocBodies(src) : src;
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

  for (const inner of extractSubstitutions(text)) scan(inner, depth + 1, out, st, false);
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
  const st: ScanState = { unread: false };
  try {
    scan(command, 0, findings, st);
  } catch {
    // Keep what was found before the failure, and read the rest as raw text below.
    st.unread = true;
  }
  if (st.unread) {
    // Raw-text matches only ask: without the structure, a match may be an argument or prose.
    const raw = rawScan(command);
    if (raw.length > 0) {
      findings.push({ severity: "ask", reason: `could not read the whole command, and its raw text matches: ${raw.join(", ")}` });
    }
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
