// The one parser for the `writeScope` key in an agent definition's frontmatter. The scratch-scope
// gate (agent-write-scope.ts) and the worktree gate (agent-worktree-gate.ts) both ask the same
// question of the same file, and two parsers would give two answers the first time a definition
// carries a duplicate key or CRLF line endings. This file sits flat beside the hooks, like
// agent-name.ts, because the installer copies that directory file by file and not recursively.

export type WriteScopeParser = (text: string) => string | null;

/**
 * The value of the first `writeScope:` key in the frontmatter, or null.
 *
 * Frontmatter is the text between a leading `---` line and the next `---` line, and nothing else
 * counts: a `writeScope:` line in the body is prose, not a declaration. Lines split on a CRLF-
 * agnostic pattern, since a Windows checkout without a `.gitattributes` rule leaves a `\r` on every
 * line and a `$` anchor sits behind it. There is no length cap on the frontmatter. The first key
 * wins, so a definition that repeats the key reads the same everywhere this parser is used.
 */
export function parseWriteScope(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? "")) return null;
  let value: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) return value;
    value ??= lines[i].match(/^writeScope:\s*(\S+)\s*$/)?.[1] ?? null;
  }
  // No closing delimiter: not frontmatter, so no declaration.
  return null;
}
