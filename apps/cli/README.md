# omnirecall

Search a durable local archive of Pi, Codex, and Claude Code session
evidence. This working-tree preview preserves original JSON alongside
searchable dialogue, reasoning, tool calls/results, and summaries.

```bash
pnpx omnirecall sync
# Optional explicit locations:
pnpx omnirecall sync --pi-root /path/to/pi/sessions \
  --codex-root /path/to/codex/history-tree \
  --claude-root /path/to/claude/projects --json
pnpx omnirecall search "database failure" --kind tool_result --json
pnpx omnirecall read '<ref>' --context 1 --json
pnpx omnirecall read '<ref>' --raw --chars 1200 --json
```

These commands describe the next release. For the working tree, use
`pnpm build` and `pnpm start` from the repository root. Requires
Node.js 24.11+.

Search first and expand selected results. `read --raw` pages through
the original record; follow `next_char_offset` for longer content.
`sessions` returns a `first_record_ref` for walking raw history,
including records without searchable text. Raw excerpts may be
fragments of JSON.

Plain sync prints a short summary of processed/unchanged files,
revisions, and grouped issue counts. Use `--verbose` to include
individual issue paths and errors, or `--json` for quiet, structured
results. Detailed issues are capped at 100; grouped counts include
every issue. Partial syncs retain exit code 2, and operational
failures retain exit code 1.

Interactive terminals also show discovery, checking and import
progress with elapsed time on stderr. Captured output contains only
the summary. Counts are per source and phase; checking and importing
are separate phases. Unchanged inputs reuse a persistent cache and are
counted in `files_skipped` (also included in `files_indexed`). The
first sync populates this cache.

Cache checks include file identity, size, nanosecond
modification/change times, permissions, parser version and source
title metadata. Changed files are fully reprocessed to preserve
rewrites, branches and rollback history. Parsed imports are staged in
a private temporary directory, then ingested after checking that their
inputs are still unchanged; temporary data is removed when sync
finishes or reports an error.

Plain sync discovers standard Pi/Claude/Codex locations and reuses
stored roots. Explicit root flags override that selection. Queries use
only the archive. Missing source histories do not erase archived
evidence. Full revisions retain changed content; `--include-history`
exposes earlier revisions and inactive/superseded work. External
attachment files are not copied.

The Claude adapter covers an initial set of transcript shapes, keeps
subagent files separate, and reports branch state as unknown. It does
not yet import team/task files or fully interpret Claude compaction.
Pi v3 and Codex paginated histories retain their format validation.

See the
[repository documentation](https://github.com/spences10/omnirecall)
for filters, output budgets, database paths, design notes, and
validation.
