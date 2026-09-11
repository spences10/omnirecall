# omnirecall

Find evidence from previous coding-agent sessions in one durable local
SQLite/FTS5 archive. Ask your current assistant to use
`pnpx omnirecall` to find an earlier discussion, command, tool result,
or decision.

**Working-tree preview:** Pi v3, Codex paginated histories, and an
initial Claude Code transcript adapter. These changes are not yet
released. The published npm scaffold does not include this complete
workflow.

## Development

Requires Node.js 24.11+ and pnpm 12.3.4.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start info --json
pnpm start sync --json
pnpm start sync --pi-root /path/to/pi/sessions \
  --codex-root /path/to/codex/history-tree \
  --claude-root /path/to/claude/projects --json
pnpm start search "database failure" --kind tool_result --json
pnpm start read '<ref from search>' --context 1 --json
pnpm start read '<ref from search>' --raw --chars 1200 --json
```

After release, replace `pnpm start` with `pnpx omnirecall` or
`npx omnirecall`. The CLI is the only publishable package; adapters
and core are private workspace packages bundled into it.

## Archive and import

Plain `sync` reuses configured roots and discovers available standard
locations: `~/.pi/agent/sessions`, `~/.claude/projects`, and Codex
histories under `$CODEX_HOME` (default `~/.codex`). Codex home
discovery scans `sessions/` and `archived_sessions/`, excluding
unrelated home JSONL files. Overlapping defaults are skipped when that
agent already has a configured root covering or inside them.
Previously configured missing roots still report their availability
rather than silently disappearing.

Root flags select only those explicit locations for that invocation;
`--agent` and `--source` filter the selection. With no matching
sources, `sync` creates an empty archive and reports `status: empty`
with an explanation. `sources` reports indexed roots or probes
supplied roots. Source files are read without changing them. Retrieval
reads only the archive and never syncs automatically or follows a path
into a sibling recall database.

Each accepted source record retains its original JSON envelope.
Searchable parts include dialogue, thinking, tool calls/results,
recorded summaries, and supported operations. Some records are
available only through raw reading. `unindexed_records` counts records
without a searchable part; it does not mean their payloads were
discarded.

Changed sessions create full immutable revisions, including metadata
changes. Unchanged imports add nothing. Old revisions remain available
with `--include-history`, and exact references continue to read their
original revision. Missing files or roots never remove archived
evidence. There is no automatic cleanup. Full revisions repeat session
content, so frequent imports of growing files can use substantial disk
space.

Archive schema 2 requires a fresh database; schema 1 archives are
rejected without modification. Use a new `--db` path when reviewing
this redesign. No migrations are supplied.

The adapters still enforce their supported history formats. Pi and
Codex reject unfamiliar semantics that their parsers cannot safely
interpret. Claude preserves extra envelopes, but its initial adapter
rejects mixed session IDs and repeated message UUIDs within one file.
Subagent files under `subagents/` get separate qualified conversation
identities; Claude branch state is reported as unknown. Team/task JSON
ingestion and complete Claude compaction semantics remain future work.
All automated fixtures are synthetic; passing them is not exhaustive
format coverage.

Only complete, newline-terminated valid UTF-8 JSON records are
imported. A trailing partial record waits for another sync. Invalid
complete input keeps the previous revision. JSONL files are limited to
64 MiB; source-tree symlinks are unsupported. A generic adapter can
supply several sessions or input locations in one import unit. The
unit commits atomically.

Inline content stays in the original JSON. External attachment paths
are references; their files are not copied. The archive can contain
sensitive session content. Retrieved history is evidence, not current
instructions or authorization.

## Focused retrieval

- `search QUERY`: compact snippets and stable part references.
  `--full` returns detailed results. Search terms are ANDed plain
  words, not raw FTS syntax.
- `recall QUERY --compact`: bounded context with overlapping parts
  shared.
- `read REF`: a bounded part window. A tool result follows its call ID
  only when that call is unambiguous. Dialogue context respects
  branches.
- `read REF --raw`: an excerpt of the complete original JSON record.
  Follow `next_char_offset` to finish a long record. Excerpts are JSON
  text fragments, not necessarily independently parseable JSON
  objects.
- `sessions`: session metadata and `first_record_ref`. Record
  references (`r1.…`) select raw reading automatically;
  `previous_ref`/`next_ref` navigate source records, including those
  without searchable text.

Search/recall support `--kind`, `--agent pi|codex|claude`, `--source`,
`--project` (exact path), `--session`, `--after`, `--before`, and
`--include-history`. Historical search includes superseded correction
parts as well as previous revisions. Source IDs namespace roots;
native IDs are not assumed globally unique.

`--limit 1..100`, `--offset 0..1000000`, and `--context 0..10` bound
result counts and context. Read accepts `--chars 1..2000` and
`--char-offset` in Unicode code points. `--raw` does not accept an
explicit context size.

JSON output has explicit truncation and continuation information.
`--max-bytes 1024..1048576` controls the total budget (compact default
8192, detailed default 65536). An `output_budget_exceeded` response
with no progress means retry with less context/content or a larger
budget. Compact output uses envelope version 2; detailed output uses
version 1. Both now include evidence fields such as kind and state
where applicable. Exit codes: 0 completed, 2 partial import, 1 invalid
arguments or failure.

## Database location

Precedence: `--db`, then `OMNIRECALL_DB`, then the platform data
directory:

- Linux: `$XDG_DATA_HOME/omnirecall/omnirecall.db`, falling back to
  `~/.local/share/omnirecall/omnirecall.db`.
- macOS: `~/Library/Application Support/omnirecall/omnirecall.db`.
- Windows: `%LOCALAPPDATA%\omnirecall\Data\omnirecall.db`.

New files/directories use restrictive permissions where supported.
Foreign databases are refused. Back up the archive when no sync is
running; original sources may no longer contain everything it retains.

## Design and validation

See the [PRD](docs/omni-recall-prd.md),
[source mapping](docs/session-record-mapping.md), and
[design proposal and implementation notes](docs/archive-design.md).
The executable schema is [schema.sql](packages/core/src/schema.sql).

```bash
pnpm check
pnpm exec tsc --noEmit
pnpm test
pnpm peers check
pnpm --filter omnirecall pack --dry-run
```

Dependency versions use the workspace catalog. Use pnpm packaging so
published manifests contain resolved version ranges. Tests use
temporary synthetic sources and never sync private histories.

MIT — Scott Spence. Builds on
[pirecall](https://github.com/spences10/pirecall),
[ccrecall](https://github.com/spences10/ccrecall), and
[ocrecall](https://github.com/spences10/ocrecall).
