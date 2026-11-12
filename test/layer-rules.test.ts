// Pins the layer-rule split (#310). The account rules change-management.md and fix-quality.md each
// had a code-repo half that moved into core/claude/rules. This test proves the move lost and added
// nothing, against fixtures that are the originals at the commit before the move.
//
// Task 14 deletes this file and the fixtures once the account copies are retired.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
});

describe("the split loses and adds nothing", () => {
  for (const [original, split] of Object.entries(SPLITS)) {
    test(original, () => {
      const fixtureText = read(join(fixtures, original));
      const fx = sectionsOf(fixtureText);
      const codeSecs = pick(fx.sections, split.codeSections);
      const kernelSecs = fx.sections.filter((s) => !split.codeSections.some((h) => h === s.heading));

      const codePre = split.preambleStaysIn === "code" ? fx.preamble : split.newPreamble;
      const kernelPre = split.preambleStaysIn === "kernel" ? fx.preamble : split.newPreamble;

      // Core code half: its preamble, then exactly the listed sections in original order.
      const core = sectionsOf(read(join(coreRules, split.codeFile)));
      expect(core.preamble).toBe(trimEnd(codePre));
      expect(core.sections).toEqual(codeSecs);

      // Which side of the cutover is the account tree on.
      const accountOriginal = join(accountRules, original);
      const accountKernel = join(accountRules, split.kernelFile);
      const sourceMoved =
        `account/claude/rules/${original} matches neither the pre-move fixture nor the post-move ` +
        `kernel half. The source changed since the move and must be ported into core.`;

      if (existsSync(accountOriginal) && read(accountOriginal) === fixtureText) {
        return; // Before cutover: the account copy is the original, and the core half is pinned above.
      }
      const absentOk = split.kernelFile !== original;
      if (!existsSync(accountOriginal) && !absentOk) throw new Error(sourceMoved);
      if (existsSync(accountOriginal) && split.kernelFile !== original) throw new Error(sourceMoved);
      if (!existsSync(accountKernel)) throw new Error(sourceMoved);

      // After cutover: kernel half plus code half equal the fixture, section by section.
      const kernel = sectionsOf(read(accountKernel));
      expect(kernel.preamble).toBe(trimEnd(kernelPre));
      expect(kernel.sections).toEqual(kernelSecs);
      const union = [...kernel.sections, ...core.sections].map((s) => s.heading).sort();
      expect(union).toEqual(fx.sections.map((s) => s.heading).sort());
    });
  }
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
