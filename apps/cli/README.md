# omnirecall

Search a durable local archive of Pi, Codex, and Claude Code session
evidence. This working-tree preview preserves original JSON alongside
searchable dialogue, reasoning, tool calls/results, and summaries.

```bash
pnpx omnirecall sync --pi-root /path/to/pi/sessions \
  --codex-root /path/to/codex/history-tree \
  --claude-root /path/to/claude/projects --json
pnpx omnirecall search "database failure" --kind tool_result --json
pnpx omnirecall read '<ref>' --context 1 --json
pnpx omnirecall read '<ref>' --raw --chars 1200 --json
```

These commands describe the next release. For the working tree, use
`pnpm build` and `pnpm start` from the repository root. Requires
Node.js 24.11+. Schema 2 needs a fresh database; existing schema 1
archives are refused without modification. Choose a new `--db` path
for the redesign.

Search first and expand selected results. `read --raw` pages through
the original record; follow `next_char_offset` for longer content.
`sessions` returns a `first_record_ref` for walking raw history,
including records without searchable text. Raw excerpts may be
fragments of JSON.

Sync requires explicit roots. Queries use only the archive. Missing
source histories do not erase archived evidence. Full revisions retain
changed content; `--include-history` exposes earlier revisions and
inactive/superseded work. External attachment files are not copied.

The Claude adapter covers an initial set of transcript shapes, keeps
subagent files separate, and reports branch state as unknown. It does
not yet import team/task files or fully interpret Claude compaction.
Pi v3 and Codex paginated histories retain their format validation.

See the
[repository documentation](https://github.com/spences10/omnirecall)
for filters, output budgets, database paths, design notes, and
validation.
