# Obsidian / Memory Sync

Memory mechanics and maintenance (write policy, frontmatter schema, retrieval discipline, Lint procedure) live in the `memory-system` skill. Invoke it when writing, recalling, or maintaining memory notes, or when running a Lint pass.

Obsidian sync is automatic. The `Sync-MemoryToObsidian.ps1` PostToolUse hook copies `~/.claude/projects/<project>/memory/` to the vault after every Write and Edit. The same hook also syncs council transcripts and worktree memory to their matching vault folders. Each project's vault folder is named after the last folder of its checkout path, the name its plans and specs already use, so one project checked out at different paths shares one folder. Folders named by path slug from before that scheme merge into it once, the first time the hook resolves them. No manual vault interaction is needed.

Never write directly into the Obsidian vault. Write memory notes to `~/.claude/projects/<project>/memory/` and the hook syncs them. The hook is the only write path.
