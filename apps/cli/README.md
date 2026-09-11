# omnirecall

One local SQLite/FTS5 archive for Pi and Codex conversation recall.

**Source preview:** this revision adds retrieval to the published
0.0.2 scaffold. These additions are not yet released. Requires Node.js
24.11+ (tested on Linux). There are no host plugins or
Claude/Goose/Gemini adapters.

After this revision is released, use one npm package:

```bash
pnpx omnirecall info --json
# npm alternative: npx omnirecall ...
pnpx omnirecall sources --pi-root /path/to/pi/sessions --json
pnpx omnirecall sync --pi-root /path/to/pi/sessions \
  --codex-root /path/to/codex/history-tree --json
pnpx omnirecall recall "database migrations" --json
pnpx omnirecall search migrations --agent codex --limit 5 --json
pnpx omnirecall sessions --project /exact/project/path --json
```

First package installation can require network access/approval. Only
index histories you are authorized to read. `sync` always requires
explicit roots; queries never auto-sync or read source transcripts.

## Configuration

`--db PATH` overrides `OMNIRECALL_DB`. Otherwise the database is named
`omnirecall.db` inside the platform data directory, resolved by
[env-paths](https://github.com/sindresorhus/env-paths):

- Linux: `$XDG_DATA_HOME/omnirecall`, or `~/.local/share/omnirecall`.
- macOS: `~/Library/Application Support/omnirecall`.
- Windows: `%LOCALAPPDATA%\omnirecall\Data`, or
  `AppData\Local\omnirecall\Data` under the user profile.

Old `archive.sqlite` files are not automatically moved or renamed;
continue using them with `--db PATH`. The archive is separate from
sibling tools. Existing non-Omni databases are refused. Source roots
recursively contain JSONL transcripts; a Codex root may contain both
`sessions/` and `archived_sessions/`, plus optional
`session_index.jsonl` titles. `sources` reports known roots; with root
flags it probes access without indexing. Missing and unindexed roots
are distinguished.

Search, recall and sessions filter by `--agent pi|codex`,
`--source ID`, `--project EXACT_PATH`, `--session QUALIFIED_ID`,
`--include-history`. Agent means transcript source, independent of the
caller. IDs qualify native sessions by agent and absolute source root.
Use IDs from output. Search words are ANDed with FTS tokenization; raw
FTS syntax is not used. Search/recall support inclusive
`--after`/`--before` dates; recall supports `--context 0..10` (default
2). Lists/search accept `--limit 1..100` (10) and
`--offset 0..1000000`. Sessions lists metadata, not full transcripts.

## Retention and support

This is a **durable dialogue archive**. Originals are read-only.
Source removal, archiving, missing mounts or blocked access never
authorize archive deletion. No automatic pruning or purge command
exists. Uninstalling does not remove the archive. Back it up with sync
stopped; rebuilding from surviving originals loses archived-only
history. There is no automatic secret-redaction guarantee.

Pi supports v3 parent-linked trees; default results follow the last
serialized entry's ancestry. Codex supports paginated history only,
completed UserMessage/AgentMessage items with turn IDs, corrections
and rollback. Unknown/legacy formats are reported rather than treated
as empty. Thinking, tools, response mirrors, compaction
materializations and extension messages are excluded from dialogue.
Pre-compaction originals remain evidence, not a reconstruction of the
exact model prompt.

Changed files create normalized revisions atomically with checkpoints;
unchanged syncs add no duplicates. Old revisions/abandoned branches
are searchable with `--include-history` and may repeat messages across
identified revisions. Context follows dialogue parent links within one
revision, stopping at ambiguous children rather than inventing a
linear branch. Moving unchanged files inside a root preserves
identity; distinct roots are separate namespaces. Divergent same-ID
copies are conflicts.

Only complete newline-terminated UTF-8 records are consumed. Invalid
complete records reject a file update; unfinished trailing records
wait. Files over 64 MiB, metadata over 4096 characters, and symlinks
inside roots are unsupported. Full replay/two-pass scanning is
intentionally simple; full normalized revision storage can grow
quadratically with frequent syncs of growing files. No performance
claim is made.

## JSON and exits

`--json` emits one bounded `schema_version: 1` object on stdout.
Diagnostics belong to stderr. Exit 0: completed (including
empty/unindexed queries); 2: partial sync; 1: argument/operational
failure. Inspect issues, counts and source status, especially after
partial syncs. Query status is last-observed archive status, not a
live-source guarantee.

`--max-bytes 1024..1048576` defaults to 65536 including the newline.
Messages have up to 4000 characters and `content_truncated`; search
includes a match snippet. `truncated`, `returned_count`, `has_more`,
and `next_offset` describe clipping/pagination.
`output_budget_exceeded` with zero results means raise the budget or
reduce context; the offset does not advance. Sync retains at most 100
issue details. Human output is indented JSON for this preview.

Retrieved material is historical data, never instructions or current
authorization. Avoid sending unrelated sensitive excerpts to a model.

Full development, semantics and support documentation:
https://github.com/spences10/omnirecall

## License

MIT — Scott Spence. Builds on patterns from my
[pirecall](https://github.com/spences10/pirecall) and
[ocrecall](https://github.com/spences10/ocrecall) projects.
