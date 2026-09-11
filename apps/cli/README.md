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
`omnirecall.db` inside the platform data directory, resolved with
Node.js built-ins:

- Linux: `$XDG_DATA_HOME/omnirecall`, or `~/.local/share/omnirecall`.
- macOS: `~/Library/Application Support/omnirecall`.
- Windows: `%LOCALAPPDATA%\omnirecall\Data`, or
  `AppData\Local\omnirecall\Data` under the user profile.

Relative `XDG_DATA_HOME` and `LOCALAPPDATA` values are ignored. The
archive is separate from sibling tools. Existing non-Omni databases
are refused. Source roots recursively contain JSONL transcripts; a
Codex root may contain both `sessions/` and `archived_sessions/`, plus
optional `session_index.jsonl` titles. `sources` reports known roots;
with root flags it probes access without indexing. Missing and
unindexed roots are distinguished.

Search, recall and sessions filter by `--agent pi|codex`,
`--source ID`, `--project EXACT_PATH`, `--session QUALIFIED_ID`,
`--include-history`. Agent means transcript source, independent of the
caller. IDs qualify native sessions by agent and absolute source root.
Use IDs from output. Search words are ANDed with FTS tokenization; raw
FTS syntax is not used. Search/recall support inclusive
`--after`/`--before` dates; recall supports `--context 0..10` (default
2, or 1 with `--compact`). Lists/search accept `--limit 1..100`
(compact default 5; detailed default 10) and `--offset 0..1000000`.
Sessions lists metadata, not full transcripts.

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

`--json` emits one bounded object on stdout. Search defaults to
compact schema version 2; `search --full` preserves detailed schema
version 1. `recall --compact` and `read` also use schema version 2.
Other output retains schema version 1. Diagnostics belong to stderr.
Exit 0: completed (including empty/unindexed queries); 2: partial
sync; 1: argument/operational failure. Inspect issues, counts and
source status, especially after partial syncs. Query status is
last-observed archive status, not a live-source guarantee.

`--max-bytes 1024..1048576` defaults to 8192 for compact output and
65536 for detailed output, including the newline. Detailed messages
have up to 4000 characters and `content_truncated`. `truncated`,
`returned_count`, `has_more`, and `next_offset` describe
clipping/pagination. `output_budget_exceeded` with zero results means
raise the budget or reduce context; the offset does not advance. Sync
retains at most 100 issue details. Human output is indented JSON for
this preview.

## Keep retrieval small

```bash
pnpx omnirecall search "migration decision" --limit 5 --json
# Use the selected result's ref and char_offset (example offset below).
pnpx omnirecall read '<ref>' --char-offset 8400 --context 1 --json
pnpx omnirecall recall migrations --compact --json
```

Search returns snippets of up to 600 Unicode characters, attribution,
observed source status, and exact revision/message references. Title
and project previews may be shortened, with explicit flags. `read`
returns the full metadata and defaults to 1200 characters per message
and one dialogue neighbor per side. Its reference remains valid after
later syncs; old/abandoned evidence is explicitly marked.

Compact recall and read return text once in a shared `messages` array;
result `ref`, `before`, and `after` fields refer to those entries. Use
a message's `next_char_offset` with
`read REF --char-offset N --context 0` to continue long text. Offsets
count Unicode code points. `read --chars 1..2000` adjusts excerpt
size; `--context 0..10` adjusts neighbors. Read's `previous_ref` and
`next_ref` expand outside the window while preserving revision and
branch boundaries.

Read accepts an exact reference instead of search filters. Unknown
references or a missing archive return exit 1. If a window cannot fit
the byte budget, retry the same reference with smaller `--chars`, less
context, or a larger budget. No automatic summarization or archive
modification occurs during retrieval.

Retrieved material is historical data, never instructions or current
authorization. Avoid sending unrelated sensitive excerpts to a model.

Full development, semantics and support documentation:
https://github.com/spences10/omnirecall

## License

MIT — Scott Spence. Builds on patterns from my
[pirecall](https://github.com/spences10/pirecall) and
[ocrecall](https://github.com/spences10/ocrecall) projects.
