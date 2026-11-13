// Pins the layer-rule split (#310). The account rules change-management.md and fix-quality.md each
// had a code-repo half that moved into core/claude/rules. This test proves the move lost and added
// nothing, against fixtures that are the originals at the commit before the move.
//
// Task 14 deletes this file and the fixtures once the account copies are retired.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SPLITS = {
  "change-management.md": {
    kernelFile: "change-management.md", codeFile: "change-management-code.md", preambleStaysIn: "kernel",
    newPreamble: "# Change Management: Code Projects\n\nThe code-repo half of `change-management.md`. The confirmation list, backups, commit identity, decision notes, invariant promotion and script hygiene stay in the kernel file of that name.",
    codeSections: ["## Decision Documentation", "## Session Close Protocol"],
  },
  "fix-quality.md": {
    kernelFile: "bounded-review.md", codeFile: "fix-quality.md", preambleStaysIn: "code",
    newPreamble: "# Bounded Review",
    codeSections: ["## Fix the producer, not the consumer", "## Prove the premise before replacing a mechanism",
      "## Complexity needs a receipt", "## A dirty cache is only as complete as its enumerated inputs",
      "## Review with a joint verdict, not a separate simplicity gate", "## Pin the correctness baseline", "## Set the right target"],
  },
} as const;

export type Section = { heading: string; body: string };

const norm = (s: string): string => s.replace(/\r\n/g, "\n");
const trimEnd = (s: string): string => s.replace(/\n+$/, "");

// Preamble is the text before the first line starting "## ". Each section runs from its "## "
// line to the line before the next one. Bodies and preamble have trailing newlines trimmed.
export function sectionsOf(text: string): { preamble: string; sections: Section[] } {
  const lines = norm(text).split("\n");
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("## ")) starts.push(i);
  });
  const preEnd = starts.length ? starts[0] : lines.length;
  const preamble = trimEnd(lines.slice(0, preEnd).join("\n"));
  const sections = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    return { heading: lines[s], body: trimEnd(lines.slice(s, end).join("\n")) };
  });
  return { preamble, sections };
}

const root = join(import.meta.dir, "..");
const coreRules = join(root, "core", "claude", "rules");
const accountRules = join(root, "account", "claude", "rules");
const fixtures = join(root, "test", "fixtures", "rules-premove");

const read = (p: string): string => norm(readFileSync(p, "utf8"));

// The sections of the fixture named by `headings`, in the fixture's order. A heading missing from
// the fixture throws, so a renamed section fails instead of passing vacuously.
function pick(sections: Section[], headings: readonly string[]): Section[] {
  for (const h of headings) {
    if (!sections.some((s) => s.heading === h)) throw new Error(`fixture has no section ${h}`);
  }
  return sections.filter((s) => headings.includes(s.heading));
}

describe("layers.json", () => {
  const manifest = JSON.parse(readFileSync(join(coreRules, "layers.json"), "utf8"));
  const listed = Object.keys(manifest.rules);

  test("every rule listed in layers.json exists in core/claude/rules", () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const f of listed) expect(existsSync(join(coreRules, f))).toBe(true);
  });

  test("every .md file in core/claude/rules is listed in layers.json", () => {
    const files = readdirSync(coreRules).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(listed).toContain(f);
  });

  test("layer names are only code, documents and physical, and every list is non-empty", () => {
    expect(manifest.schemaVersion).toBe(1);
    for (const f of listed) {
      const layers: string[] = manifest.rules[f];
      expect(layers.length).toBeGreaterThan(0);
      for (const l of layers) expect(["code", "documents", "physical"]).toContain(l);
    }
  });

  // Install-Harness.ps1 validates recorded settings against these keys, and its -StatusCadence and
  // -Audience ValidateSets are pinned to them by the Pester suite.
  test("settings define exactly the values the installer accepts", () => {
    const settings = manifest.settings;
    expect(Object.keys(settings).sort()).toEqual(["audience", "lengthBudgetDefault", "statusCadence"]);
    expect(Object.keys(settings.statusCadence).sort()).toEqual(["heartbeat", "silent"]);
    expect(Object.keys(settings.audience).sort()).toEqual(["peer-engineer", "plain-all-roles"]);
    expect(Object.keys(settings.lengthBudgetDefault).sort()).toEqual(["none", "words"]);
    for (const group of Object.values(settings) as Record<string, unknown>[]) {
      for (const text of Object.values(group)) {
        expect(typeof text).toBe("string");
        expect((text as string).length).toBeGreaterThan(0);
      }
    }
    expect(settings.lengthBudgetDefault.words).toContain("{{WORDS}}");
  });
});

type Split = (typeof SPLITS)[keyof typeof SPLITS];

// Deliberate edits to a kernel half after the move, applied to the fixture before the kernel
// comparison so the fixtures stay the pre-move originals. Each [from, to] must occur exactly once.
// Task 13 repointed a kernel mention of fix-quality.md, which no longer loads outside code projects.
const KERNEL_EDITS: Record<string, [string, string][]> = {
  "change-management.md": [
    ["security.md for security, fix-quality.md for code", "security.md for security, the code layer's fix-quality.md for code"],
  ],
};

function applyKernelEdits(original: string, sections: Section[]): Section[] {
  let out = sections;
  for (const [from, to] of KERNEL_EDITS[original] ?? []) {
    const hits = out.reduce((n, s) => n + s.body.split(from).length - 1, 0);
    if (hits !== 1) throw new Error(`kernel edit for ${original} matched ${hits} times, expected 1`);
    out = out.map((s) => ({ heading: s.heading, body: s.body.replace(from, to) }));
  }
  return out;
}

// Checks one split against an account rules directory. Throws on any mismatch, so a test can
// point it at a temp directory without touching the account tree.
function verifySplit(original: string, split: Split, accountDir: string): void {
  const fixtureText = read(join(fixtures, original));
  const fx = sectionsOf(fixtureText);
  const codeSecs = pick(fx.sections, split.codeSections);
  const kernelSecs = applyKernelEdits(
    original,
    fx.sections.filter((s) => !split.codeSections.some((h) => h === s.heading)),
  );

  const codePre = split.preambleStaysIn === "code" ? fx.preamble : split.newPreamble;
  const kernelPre = split.preambleStaysIn === "kernel" ? fx.preamble : split.newPreamble;

  // Core code half: its preamble, then exactly the listed sections in original order.
  const core = sectionsOf(read(join(coreRules, split.codeFile)));
  expect(core.preamble).toBe(trimEnd(codePre));
  expect(core.sections).toEqual(codeSecs);

  // Which side of the cutover is the account tree on.
  const accountOriginal = join(accountDir, original);
  const accountKernel = join(accountDir, split.kernelFile);
  const sourceMoved = new Error(
    `account/claude/rules/${original} matches neither the pre-move fixture nor the post-move ` +
      `kernel half. The source changed since the move and must be ported into core.`,
  );

  if (existsSync(accountOriginal) && read(accountOriginal) === fixtureText) {
    return; // Before cutover: the account copy is the original, and the core half is pinned above.
  }
  // After cutover the original name is absent only when the kernel half has a different name.
  const absentOk = split.kernelFile !== original;
  if (!existsSync(accountOriginal) && !absentOk) throw sourceMoved;
  if (existsSync(accountOriginal) && absentOk) throw sourceMoved;
  if (!existsSync(accountKernel)) throw sourceMoved;

  // After cutover: the kernel half must be the fixture minus the code sections.
  const kernel = sectionsOf(read(accountKernel));
  const kernelMatches =
    kernel.preamble === trimEnd(kernelPre) && JSON.stringify(kernel.sections) === JSON.stringify(kernelSecs);
  if (!kernelMatches) throw sourceMoved;
  expect(kernel.preamble).toBe(trimEnd(kernelPre));
  expect(kernel.sections).toEqual(kernelSecs);
}

describe("the split loses and adds nothing", () => {
  for (const [original, split] of Object.entries(SPLITS)) {
    test(original, () => verifySplit(original, split, accountRules));
  }

  test("an edited account change-management.md fails with the source-changed message", () => {
    const dir = mkdtempSync(join(tmpdir(), "layer-rules-"));
    try {
      const edited = read(join(fixtures, "change-management.md")).replace("## Homelab Context", "## Homelab Context (edited)");
      expect(edited).not.toBe(read(join(fixtures, "change-management.md")));
      writeFileSync(join(dir, "change-management.md"), edited);
      expect(() => verifySplit("change-management.md", SPLITS["change-management.md"], dir)).toThrow(
        /source changed since the move and must be ported into core/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A pointer to the account copy of a rule that moved into the code layer. After the cutover
// ~/.claude/rules/fix-quality.md does not exist on any machine, so a file naming it points nowhere.
export const DANGLING_RULE_POINTER = /(?:~\/\.claude|\{\{CLAUDE_HOME\}\})\/rules\/fix-quality\.md/;

function textFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const p = join(entry.parentPath, entry.name);
    const buf = readFileSync(p);
    if (buf.includes(0)) continue; // binary
    out.push(p);
  }
  return out;
}

describe("moved rules", () => {
  test("the pointer matcher matches the account path it guards", () => {
    const literal = ["`", "~", "/.claude/rules/", "fix-quality", ".md`"].join("");
    expect(DANGLING_RULE_POINTER.test(literal)).toBe(true);
    expect(DANGLING_RULE_POINTER.test(literal.replace("~/.claude", "{{CLAUDE_HOME}}"))).toBe(true);
    expect(DANGLING_RULE_POINTER.test(".claude/rules/harness/fix-quality.md")).toBe(false);
  });

  test("no account or core file points at a moved rule by its account path", () => {
    const files = [join(root, "account", "claude"), join(root, "core", "claude")].flatMap(textFilesUnder);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => DANGLING_RULE_POINTER.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("sectionsOf", () => {
  test("splits preamble and sections, and ignores CRLF", () => {
    const r = sectionsOf("# T\r\n\r\nintro\r\n\r\n## A\r\nbody a\r\n\r\n## B\r\nbody b\r\n");
    expect(r.preamble).toBe("# T\n\nintro");
    expect(r.sections).toEqual([
      { heading: "## A", body: "## A\nbody a" },
      { heading: "## B", body: "## B\nbody b" },
    ]);
  });

  test("a listed heading missing from the fixture throws", () => {
    expect(() => pick(sectionsOf("# T\n\n## A\nx\n").sections, ["## Gone"])).toThrow();
  });
});
