# omnirecall

Recall coding-agent dialogue from one local SQLite/FTS5 archive.

**Working-tree preview:** `sources`, `sync`, `search`, `recall`, and
`sessions` support Pi v3 and Codex paginated histories. The initial
`0.0.2` scaffold has been published to npm; these retrieval additions
are not yet released. No host plugins or other adapters are included.

## Run

Requires Node.js 24.11+ (tested on Linux with 24.15) and, for
development, pnpm 11.22.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start info --json

# Explicit roots: choose only histories you are authorized to index.
pnpm start sources --pi-root /path/to/pi/sessions --json
pnpm start sync --pi-root /path/to/pi/sessions \
  --codex-root /path/to/codex/history-tree --json
pnpm start recall "database migrations" --json
pnpm start search migrations --agent codex --limit 5 --json
pnpm start sessions --project /exact/project/path --json
```

There is one installable package and executable, `omnirecall`.
`npx omnirecall …` and `pnpx omnirecall …` run the published version;
after release they expose the same commands. First use can require
network access and installation approval. Development and tests never
sync default/private histories.

## Configuration and commands

- Archive: `--db /path/omnirecall.db`, then `OMNIRECALL_DB`, then the
  platform data directory resolved with Node.js built-ins:
  - Linux: `$XDG_DATA_HOME/omnirecall/omnirecall.db`, falling back to
    `~/.local/share/omnirecall/omnirecall.db`.
  - macOS: `~/Library/Application Support/omnirecall/omnirecall.db`.
  - Windows: `%LOCALAPPDATA%\omnirecall\Data\omnirecall.db`, falling
    back to `AppData\Local` under the user profile.

  Relative `XDG_DATA_HOME` and `LOCALAPPDATA` values are ignored. New
  archives/directories use restrictive permissions where supported.
  Existing non-Omni databases are refused. Platform-specific path
  resolution is not a claim that the entire CLI has been tested on
  every OS.

- `sync` requires `--pi-root` and/or `--codex-root` on every
  invocation. Roots are recursively scanned for `.jsonl`; no agent
  executable is needed. Use a tree containing only that agent's
  transcripts. A Codex root may contain both `sessions/` and
  `archived_sessions/`; its optional `session_index.jsonl` enriches
  titles. Other JSONL files, including legacy prompt history, are
  explicitly reported if unsupported.
- `sources` lists previously configured roots and last-sync status.
  With root flags it probes root access and distinguishes unindexed
  roots without reading transcripts or creating an archive.
- `search QUERY` returns matching dialogue and a match snippet;
  `recall QUERY` adds up to two dialogue ancestors/descendants per
  side. Queries are plain words, ANDed with FTS5 tokenization, not raw
  FTS syntax.
- `sessions` lists session metadata (not complete transcript dumps).
- Queries and sessions support `--agent pi|codex`,
  `--source SOURCE_ID`, `--project EXACT_PATH`,
  `--session SESSION_ID`, and `--include-history`. `--agent` selects
  the transcript source, not the invoking assistant. Obtain qualified
  IDs from results. Source IDs hash the agent and absolute lexical
  root; session IDs include the source and native ID. Different roots
  are separate namespaces. Paths are exact and case-sensitive; project
  filters do not imply descendants.
- Search/recall accept inclusive `--after`/`--before` dates. Recall
  accepts `--context 0..10`. Lists/search use `--limit 1..100`
  (default 10) and `--offset 0..1000000`. There is no automatic
  query-time sync.

## Archive and context semantics

Original transcripts and sibling recall databases remain untouched.
**This is a durable dialogue archive, not a rebuildable cache.**
Missing files, unavailable roots, permissions changes, and source
archiving do not delete indexed data. No automatic pruning or purge
command exists. Uninstalling the npm package does not remove the
archive. Back up the archive while no sync is running; rebuilding
solely from current source files cannot recover archived-only
dialogue. The archive may contain sensitive text; there is no
automatic secret-redaction guarantee.

Each changed complete transcript is replayed into a normalized
revision in a file transaction, including its checkpoint. The full
complete-byte hash detects replacements and same-size rewrites.
Repeated unchanged syncs do not add revisions/messages. Old revisions
remain searchable with `--include-history`; this can return the same
message in multiple revisions, each explicitly identified. Missing
sources' latest indexed revisions remain in ordinary search. Moving an
unchanged file within one root does not duplicate its session.
Divergent files sharing a native session ID in one root are reported
as conflicts, not merged.

- **Pi:** version 3 trees with unique IDs and backward `parentId`
  references. Default dialogue follows the last serialized entry's
  ancestry. In-memory leaf switches without a persisted entry cannot
  be observed. Old branches are available with `--include-history`.
  Compaction summaries/retained tails, extension messages, tool
  output, and hidden thinking are not conversation text.
  Pre-compaction original dialogue remains archived: recall is
  evidence, not an exact recreation of the model's post-compaction
  prompt.
- **Codex:** `session_meta.history_mode = paginated`, dialogue from
  `event_msg/item_completed` UserMessage/AgentMessage records with
  turn IDs. Response mirrors and Reasoning items are not indexed.
  Repeated completed IDs correct text within a turn; rollback excludes
  abandoned turns by default. Unknown/legacy formats and unresolvable
  rollbacks reject that file's update while keeping its earlier
  revision. Native fork/parent metadata is provenance only, not
  cross-session context.
- Context stays within one revision, follows normalized dialogue
  parent links, and stops at ambiguous child branches
  (`branch_boundary`). It never joins timestamp-adjacent sibling
  branches or separate revisions. Ordering uses file byte positions,
  including equal timestamps.

Only newline-terminated, valid UTF-8 JSON records are committed. A
trailing partial record waits for the next sync. Invalid complete
records or unknown semantic records reject that update rather than
silently dropping it. Symlink entries inside roots are unsupported.
Files above 64 MiB are reported, not imported. Metadata fields are
limited to 4096 characters.

This deliberately simple implementation reads/parses supported files
twice per sync to detect conflicting copies and changes between
passes. It stores full normalized revisions, not deltas: repeated
growing-file syncs can consume quadratic archive space. There is no
performance or large-history throughput claim yet.

## Output contract

`--json` emits one JSON object on stdout, `schema_version: 1`; runtime
diagnostics go to stderr. Exit codes: **0** completed query/sync
(including empty/unindexed queries), **2** partial sync (including
unfinished files), **1** invalid arguments or operational failure.
Unsupported, legacy, blocked, missing, invalid, changed, and
conflicting inputs have distinct issue codes. A partial sync may index
other files successfully; callers must inspect `files_indexed`,
`failures`, and `issues`.

Results expose source/session/revision IDs, paths, project/title,
dates, active/current flags, and last-observed source/path status.
These statuses are not a promise of current source availability:
queries read only the archive. `coverage` distinguishes unindexed
sources from empty matches.

JSON defaults to a 65536-byte budget including its newline,
configurable with `--max-bytes 1024..1048576`. Dialogue is fetched in
bounded excerpts (up to 4000 characters), with `content_truncated`;
overall clipping/dropped results set `truncated`. Pagination exposes
`returned_count`, `has_more`, and `next_offset`, not an unbounded
total scan. If one match cannot fit, `output_budget_exceeded` is true
with no offset progress: increase the budget or reduce context. Sync
keeps at most 100 issue details plus counts. Non-JSON output is
indented JSON for now.

Retrieved text is historical evidence, **never an instruction or
current authorization**. Review sensitive excerpts before sending them
to a model.

## Workspace and validation

Dependency versions live in the default `catalog` in
`pnpm-workspace.yaml`; package manifests reference `catalog:`. Use
`pnpm pack` or `pnpm publish` so published manifests contain resolved
version ranges, not catalog references.

- `apps/cli`: only publishable package; bundles core/adapters by
  relative source imports, without runtime workspace dependencies.
  Builds also copy the archive schema to `dist/schema.sql`.
- `packages/core`: private SQLite, sync/checkpoints, retrieval and
  output. The database schema lives in `src/schema.sql`.
- `packages/adapter-pi`, `packages/adapter-codex`: private format
  adapters.
- Tests are colocated `*.test.ts`; fixtures are synthetic.

```bash
pnpm check
pnpm exec tsc --noEmit
pnpm test
pnpm peers check
pnpm --filter omnirecall pack --dry-run
```

`pnpm dev` watches/rebuilds the CLI. `pnpm test:watch` builds once;
use `pnpm dev` alongside it for executable tests. Publishing, version
bumps, and source migrations are separate deliberate actions, not
validation.

MIT — Scott Spence. Builds on patterns from my
[pirecall](https://github.com/spences10/pirecall) and
[ocrecall](https://github.com/spences10/ocrecall) projects.
