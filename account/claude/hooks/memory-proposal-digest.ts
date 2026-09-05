#!/usr/bin/env bun
// SessionStart (global): surface memory decision notes still sitting at
// status: proposed, so a proposal cannot expire just because nobody remembered
// to run a memory Lint pass. Plain stdout lands as session-start context, the
// same mechanism as harness-core-reminder.sh.
//
// Behavioral contract:
//   - Silent when there is nothing to say. Zero proposals, zero output.
//   - Never breaks session start. Every failure path exits 0 quietly.
//   - Read-only. It flags a lapsed proposal; changing status is the operator's call.
//   - No dependencies (there is no package.json here) and no YAML library.
//
//   bun ~/.claude/hooks/memory-proposal-digest.ts             # real scan
//   bun ~/.claude/hooks/memory-proposal-digest.ts --root DIR  # scan elsewhere (testing)
//   bun ~/.claude/hooks/memory-proposal-digest.ts --selftest   # parse + expiry math check

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const MAX_SHOWN = 8;
const DESC_MAX = 110;
const DAY_MS = 86400000;

interface Proposal {
  project: string;
  slug: string;
  description: string;
  confidence: string;
  validUntil: string;
  expiry: number | null; // UTC midnight of the last valid day
  daysLeft: number | null;
}

// --- frontmatter -----------------------------------------------------------

function unquote(v: string): string {
  const t = v.trim();
  const q = t[0];
  if (t.length >= 2 && (q === '"' || q === "'") && t.endsWith(q)) return t.slice(1, -1);
  return t;
}

// Flat map of the YAML frontmatter: top-level keys by name, one level of
// nesting as "parent.child". Returns null when there is no complete fence,
// which is how a truncated note gets skipped instead of throwing.
function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/); // CRLF working trees: never split on bare \n
  if (lines.length === 0 || lines[0].trim() !== "---") return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") { end = i; break; }
  }
  if (end === -1) return null;

  const out: Record<string, string> = {};
  let parent = "";
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1];
    const key = m[2];
    let value = m[3].trim();

    // Folded or literal block scalar: absorb the more-indented lines below it.
    if (value === ">" || value === "|" || /^[>|][-+]?\d*$/.test(value)) {
      const parts: string[] = [];
      let j = i + 1;
      for (; j < end; j++) {
        if (!lines[j].trim()) continue;
        if (lines[j].search(/\S/) <= indent.length) break;
        parts.push(lines[j].trim());
      }
      i = j - 1;
      value = parts.join(" ");
    }

    if (indent.length === 0) { parent = key; out[key] = unquote(value); }
    else if (parent) out[`${parent}.${key}`] = unquote(value);
  }
  return out;
}

// YYYY-MM-DD, or YYYY-MM meaning the last day of that month. Anything else is
// treated as "no usable date" rather than an error.
function expiryUtc(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const lastOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = m[3] ? Number(m[3]) : lastOfMonth;
  if (day < 1 || day > lastOfMonth) return null;
  return Date.UTC(year, month - 1, day);
}

// --- scan ------------------------------------------------------------------

function collect(projectsDir: string, now: Date): Proposal[] {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const found: Proposal[] = [];

  let projects: string[] = [];
  try { projects = readdirSync(projectsDir); } catch { return found; }

  for (const project of projects) {
    const memDir = join(projectsDir, project, "memory");
    let files: string[] = [];
    try {
      files = readdirSync(memDir).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch { continue; } // no memory dir, or unreadable: not our problem
    for (const file of files) {
      try {
        const fm = parseFrontmatter(readFileSync(join(memDir, file), "utf8"));
        if (!fm) continue;
        if (fm["metadata.type"] !== "decision") continue;
        if (fm["metadata.status"] !== "proposed") continue;
        const validUntil = fm["metadata.valid_until"] ?? "";
        const expiry = validUntil ? expiryUtc(validUntil) : null;
        found.push({
          project,
          slug: file.replace(/\.md$/i, ""),
          description: fm["description"] || fm["name"] || "(no description)",
          confidence: fm["metadata.confidence"] || "",
          validUntil,
          expiry,
          daysLeft: expiry === null ? null : Math.round((expiry - today) / DAY_MS),
        });
      } catch { /* one bad note never costs the whole digest */ }
    }
  }

  // Lapsed first (oldest lapse leads), then live by soonest expiry, undated last.
  const rank = (p: Proposal) => (p.daysLeft === null ? 2 : p.daysLeft < 0 ? 0 : 1);
  found.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.expiry ?? 0) - (b.expiry ?? 0) ||
      a.slug.localeCompare(b.slug),
  );
  return found;
}

// --- render ----------------------------------------------------------------

function tagOf(p: Proposal): string {
  if (p.daysLeft === null) return `no valid_until`;
  if (p.daysLeft < 0) return `LAPSED ${p.validUntil}`;
  if (p.daysLeft === 0) return `lapses today`;
  return `${p.daysLeft}d left`;
}

function render(proposals: Proposal[]): string {
  if (proposals.length === 0) return "";
  const lapsed = proposals.filter((p) => p.daysLeft !== null && p.daysLeft < 0).length;
  const lines: string[] = [];
  lines.push(
    `${proposals.length} memory decision note${proposals.length === 1 ? " is" : "s are"} ` +
      `still at status: proposed` +
      (lapsed ? ` (${lapsed} past valid_until)` : ``) +
      `. Nobody has ruled on these.`,
  );
  for (const p of proposals.slice(0, MAX_SHOWN)) {
    const conf = p.confidence ? `, confidence ${p.confidence}` : ``;
    lines.push(`  [${tagOf(p)}] ${p.project}/${p.slug}${conf}`);
    const d = p.description.length > DESC_MAX
      ? p.description.slice(0, DESC_MAX - 1).trimEnd() + "…"
      : p.description;
    lines.push(`      ${d}`);
  }
  if (proposals.length > MAX_SHOWN) {
    lines.push(`  …and ${proposals.length - MAX_SHOWN} more proposed notes not shown.`);
  }
  lines.push(
    `Notes live at ~/.claude/projects/<project>/memory/<slug>.md. Ask the operator to accept, ` +
      `reject, or defer (extend metadata.valid_until); never set status: accepted yourself.`,
  );
  return lines.join("\n");
}

// --- selftest --------------------------------------------------------------

function note(fm: string, body = "\n## Decision\n\nbody\n", crlf = false): string {
  const text = `---\n${fm}\n---\n${body}`;
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

function selftest(): void {
  const root = join(tmpdir(), `memory-proposal-digest-selftest-${process.pid}`);
  const empty = join(root, "..", `memory-proposal-digest-empty-${process.pid}`);
  const projA = join(root, "P--alpha", "memory");
  const projB = join(root, "P--beta", "memory");
  try {
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    mkdirSync(join(root, "P--no-memory"), { recursive: true });
    mkdirSync(empty, { recursive: true });

    // CRLF throughout, quoted description: the shape that a bare "\n" split breaks.
    writeFileSync(
      join(projA, "expired-one.md"),
      note(
        `name: expired-one\ndescription: "Lapsed proposal, quoted description"\nmetadata: \n  node_type: memory\n  type: decision\n  status: proposed\n  confidence: high\n  valid_until: 2026-07-01`,
        "\n## Decision\n\nbody\n",
        true,
      ),
    );
    writeFileSync(
      join(projA, "live-month.md"),
      note(`name: live-month\ndescription: Month-granularity expiry\nmetadata:\n  type: decision\n  status: proposed\n  confidence: low\n  valid_until: "2026-09"`),
    );
    // The expiry boundary: valid_until IS the fixture's today. Still live, and
    // the last day it is. Pins daysLeft < 0 against a flip to <= 0.
    writeFileSync(
      join(projA, "lapses-today.md"),
      note(`name: lapses-today\ndescription: Expires at the end of today\nmetadata:\n  type: decision\n  status: proposed\n  confidence: medium\n  valid_until: 2026-08-11`),
    );
    // Read before live-day.md, so finding live-day proves a malformed note
    // does not abort the scan.
    writeFileSync(
      join(projB, "aa-truncated.md"),
      `---\nname: aa-truncated\ndescription: no closing fence\nmetadata:\n  type: decision\n  status: proposed\n`,
    );
    writeFileSync(
      join(projB, "live-day.md"),
      note(`name: live-day\ndescription: Day-granularity expiry\nmetadata:\n  type: decision\n  status: proposed\n  confidence: medium\n  valid_until: 2026-08-31`),
    );
    writeFileSync(
      join(projB, "bad-date.md"),
      note(`name: bad-date\ndescription: Unparseable valid_until\nmetadata:\n  type: decision\n  status: proposed\n  valid_until: someday`),
    );
    writeFileSync(
      join(projB, "accepted.md"),
      note(`name: accepted\ndescription: Already ruled on\nmetadata:\n  type: decision\n  status: accepted\n  valid_until: 2026-07-01`),
    );
    writeFileSync(
      join(projB, "not-a-decision.md"),
      note(`name: not-a-decision\ndescription: Proposed but not a decision\nmetadata:\n  type: reference\n  status: proposed\n  valid_until: 2026-07-01`),
    );

    const now = new Date(2026, 7, 11, 12, 0, 0); // 2026-08-11, local
    const got = collect(root, now);

    assert.deepEqual(
      got.map((p) => p.slug),
      ["expired-one", "lapses-today", "live-day", "live-month", "bad-date"],
      "filter + sort: lapsed first, then soonest live, undated last",
    );
    assert.equal(got[0].daysLeft, -41, "2026-07-01 lapsed 41 days before 2026-08-11");
    assert.equal(got[1].daysLeft, 0, "valid_until == today is 0 days left, not lapsed");
    assert.equal(got[2].daysLeft, 20, "2026-08-31 is 20 days out");
    assert.equal(got[3].daysLeft, 50, "2026-09 means 2026-09-30, 50 days out");
    assert.equal(got[4].daysLeft, null, "unparseable valid_until is not a date");
    assert.equal(
      got[0].description,
      "Lapsed proposal, quoted description",
      "CRLF + quoted description parses clean",
    );
    assert.ok(!/[\r"]/.test(got[0].description), "no stray CR or quote survives");
    assert.equal(got[0].confidence, "high");

    const out = render(got);
    assert.ok(
      out.startsWith("5 memory decision notes are still at status: proposed (1 past valid_until)."),
      out.split("\n")[0],
    );
    assert.ok(out.indexOf("expired-one") < out.indexOf("live-day"), "lapsed renders first");
    assert.ok(out.includes("[LAPSED 2026-07-01]") && out.includes("[20d left]"));
    assert.ok(out.includes("[lapses today] P--alpha/lapses-today"), "valid_until == today renders live");
    assert.ok(!out.includes("LAPSED 2026-08-11"), "a note lapsing today never renders as LAPSED");
    // "/accepted", not "accepted": the closing guidance line says the word.
    assert.ok(!out.includes("/accepted") && !out.includes("not-a-decision"), "excluded notes stay out");
    assert.ok(out.split("\n").length < 30, "digest stays under 30 lines");

    assert.equal(render(collect(empty, now)), "", "empty tree renders nothing");
    assert.equal(render(collect(join(root, "nope-does-not-exist"), now)), "", "missing tree renders nothing");

    // render() silence is not the hook process silence: this pins the caller guard.
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--root", empty], { encoding: "utf8" });
    assert.equal(child.stdout, "", "hook process prints NOTHING on an empty tree");
    assert.equal(child.status, 0, "hook process exits 0 on an empty tree");

    // Truncation: 12 proposals show 8 plus a count line.
    const many = Array.from({ length: 12 }, (_, i) => ({ ...got[1], slug: `p${i}` }));
    const manyOut = render(many);
    assert.ok(manyOut.includes("…and 4 more proposed notes not shown."));
    assert.ok(manyOut.split("\n").length <= 20, "truncated digest stays tight");

    // Description truncation is a SECOND, unrelated branch to MAX_SHOWN above, and
    // every other fixture description is far under DESC_MAX, so nothing else reaches
    // it. It is live in production: most real notes render with a trailing ellipsis.
    const longDesc = "x".repeat(DESC_MAX + 40);
    const longOut = render([{ ...got[1], slug: "long-desc", description: longDesc }]);
    const descLine = longOut.split("\n").find((l) => l.includes("x".repeat(20)))!;
    assert.ok(descLine.endsWith("…"), "an over-long description is ellipsized");
    assert.ok(!descLine.includes(longDesc), "the full over-long description never renders");
    assert.equal(descLine.trim().length, DESC_MAX, "ellipsized description is exactly DESC_MAX");

    console.log("PASS memory-proposal-digest: 5 of 8 notes matched, sort/expiry/boundary/CRLF/silence/truncation OK");
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    try { rmSync(empty, { recursive: true, force: true }); } catch {}
  }
}

// --- entry -----------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  selftest(); // throws loudly on failure; this path is not a session start
  process.exit(0);
}

try {
  const i = argv.indexOf("--root");
  // A bare --root, or --root followed by another flag, falls back to the real
  // tree instead of scanning a directory named "--selftest".
  const root = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : join(homedir(), ".claude", "projects");
  const out = render(collect(root, new Date()));
  if (out) process.stdout.write(out + "\n");
} catch {
  // A session start is never worth breaking over a digest.
}
process.exit(0);
