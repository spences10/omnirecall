# Session archive design

Omni Recall imports coding-agent session history into SQLite so it can
be searched and read after the original files disappear.

## Storage

- `sources`: configured agent roots and last observed availability.
- `sessions`: one stored session, its metadata and last import hash.
- `records`: original JSON envelopes in source order.
- `parts`: extracted searchable text, roles, kinds and relationships.
- `parts_fts`: SQLite full-text index maintained with the parts.
- `links`: references extracted from original records.
- `resources` and `session_inputs`: input locations and availability.
- `sync_cache`: successful input fingerprints, offsets and session
  IDs.

There are no revision snapshots. A session has a stable internal
`archive_id` used in record/message references. Its public
`session_id` is qualified by source, import-unit key and native
conversation identity. Two files sharing a native ID remain
independent, including after either file changes. A moved file is a
new import unit; its earlier archived copy remains available. We do
not infer file moves or merge copies.

Session selectors accept exact `session_id`/`archive_id` values or a
unique native/archive ID prefix. Exact archive identities take
precedence; other matches must identify one session within the
supplied agent/source/project scope. Title, date, query and pagination
filters are applied only after resolution and cannot hide ambiguity.
An unmatched selector returns no results. Native identifiers and
prefixes are case-sensitive and literal, including `%` and `_`.

Session listings include `short_id`: an archive-ID prefix of at least
12 characters, extended as needed to avoid native/archive collisions
anywhere in the archive, not just the displayed page. Full archive IDs
remain the fallback. New imports may make an older prefix ambiguous;
full archive identities remain stable.

## Import

Each adapter discovers import units and reads them into sessions with
original records and extracted parts. Units may contain several inputs
or sessions; the core does not require a JSONL file per session.

Sync handles one unit at a time:

1. Compare its fingerprint, parser version and title metadata with the
   successful checkpoint. Skip unchanged inputs.
2. Read and validate changed inputs. A JSONL adapter may use its saved
   offset and previously archived records. Verify the complete
   imported prefix before resuming; only decode new source lines.
   Incomplete final lines wait for the next sync. Current parsers
   still interpret the full session using the stored prefix to resolve
   branches and turns.
3. Verify that the input did not change during import. Adapters
   without a fingerprint contract retain a second-read consistency
   check.
4. In one SQLite transaction, update the session, insert new raw
   records, reconcile searchable parts and links, and persist the
   checkpoint. Unchanged parts are not rewritten. On a rewrite,
   replace the stored records and parts instead. Any failure rolls
   back the whole unit.

Prefix verification reads earlier bytes for hashing; this is a
correctness check, not constant-time append detection. Memory is
bounded by the largest accepted import unit rather than the entire
source tree. JSONL inputs currently have a 64 MiB limit.

Missing files retain their stored content. Discovery failures retain
known locations and report unavailable sources. Malformed complete
JSON or malformed known agent shapes retain the last successful
import. Unfamiliar Pi/Codex event types remain in raw records even
when they have no searchable text. Unfamiliar Codex semantics expose
unknown state.

## Search and reading

Search uses SQLite FTS over extracted text with agent, source,
project, session, title, kind and date filters. Title matching is a
literal substring with SQLite's ASCII case-insensitive comparison;
non-ASCII characters match exactly. Session listing dates filter the
stored session timestamp, while search/recall dates filter message
timestamps. CLI date-only bounds span the whole UTC day; explicit
timestamps retain their exact inclusive boundaries. Normal search uses
primary active parts. `--include-history` additionally includes
inactive parts and alternative representations present in the imported
records, not previous imports.

Codex sessions explicitly marked as approval reviewers classify their
user-role prompts as `kind: review_context`, `role: context`, not
human dialogue. Detection recognizes `source.subagent.other` values
`guardian` and `approval_reviewer`, `source.internal: guardian`, or
`thread_source: guardian_review`. It does not infer provenance from
filenames, titles, duplicated text, or AGENTS.md markers. Reviewer
answers remain dialogue; all original envelopes retain their native
roles. CLI default searches omit reviewer context;
`--kind review_context` or `--kind all` includes it. Unknown reviewer
metadata remains ordinary dialogue rather than risking removal of
genuine user messages.

The native metadata shapes are documented in Codex's
[session protocol](https://github.com/openai/codex/blob/2739e828581c3deee59a270cd740675dc278ed14/codex-rs/protocol/src/protocol.rs)
and
[Guardian setup](https://github.com/openai/codex/blob/2739e828581c3deee59a270cd740675dc278ed14/codex-rs/core/src/guardian/review_session_setup.rs).
Fixtures use synthetic content, not developer transcripts.

References address a stored session and part or record key. They
survive append imports. After rewriting a session, a reference may
return updated content or no longer exist. They are not immutable
historical citations. Raw JSON and contextual reads work entirely from
the archive.

## Compact output

Default search, default recall, and `sessions --compact` use
`schema_version: 3`. This replaces the previous compact search/recall
schema v2; consumers must check the version. Detailed search and
recall (`--full`) and ordinary sessions remain schema v1. Focused and
raw `read` responses remain schema v2. Canonical `m1`/`r1` references
remain valid input to `read`.

Compact output prints short references: `m2.<short_id>.<digest>` for
messages and `r2.<short_id>.<record key>` for records. The digest is a
truncated SHA-256 of the message's native ID, resolved within the
session at read time. Short references share `short_id` semantics: a
later import may make one ambiguous, which fails with an explicit
error instead of selecting a message. Repeat the search for a current
reference.

Metadata identical across at least two returned rows is stored once in
optional `shared.results` or `shared.messages` objects. A missing
shared object means no inherited fields. Decode each table
independently:

```js
const results = response.results.map((row) => ({
	...response.shared?.results,
	...row,
}));
const messages = (response.messages ?? []).map((row) => ({
	...response.shared?.messages,
	...row,
}));
```

Only equal, present metadata is shared. Mixed agents, locations,
freshness, missing-source status, unknown/inactive state and
alternative representations retain their distinct values. Null and
false values are preserved, not treated as absent. Sharing is
recalculated after pagination and byte-budget pruning, and
unreferenced messages are removed. Continuation offsets/counts
describe the rows actually returned. If no result fits,
`output_budget_exceeded` remains explicit.

`search --by-session` returns one row per matching session, ordered by
its best hit: `short_id`, `hits`, `last_hit`, agent, title, project
and the best hit's `ref` and snippet. It omits source paths, statuses
and message state to stay small; follow up with
`search --session <short_id>` or read the `ref`.

`outline <session>` returns one session's shape: a `session` header
with per-kind part counts, then its user prompts and stored summaries
in source order. Each row carries a `ref`, kind, timestamp and the
first non-empty line (up to 160 characters); `text_truncated` marks
rows with more content to `read`. It returns up to 50 rows by default
and paginates like other commands.

`evidence <ref>` lists tool calls, tool results and operations in the
turn containing the referenced message. A turn runs from the user
prompt at or before the message to the next user prompt, in source
order on the message's branch. `turn.prompt_ref` and
`turn.next_prompt_ref` identify its bounds. Rows carry a `ref`, kind,
timestamp and one whitespace-collapsed line of up to 160 characters;
`read` a row's `ref` for the full input or output.

Search results include `source_path` alongside snippets. Compact
recall results carry provenance, match offsets and context references;
role, kind, timestamp, state and content live only in `messages`,
addressed by `ref`. Recall omits a snippet when the returned content
covers it, but keeps one when a truncated message excerpt may omit the
hit. For such hits, pass the result's `char_offset` to `read`; message
continuation still uses `next_char_offset`.

Compact sessions keep `short_id`, title/project, timestamp, source
path and status, parent identity, unindexed-record count and
`first_record_ref`. They omit internal hashes, parser versions,
duplicate paths and long canonical identifiers; use ordinary
`sessions` for full metadata. Titles/projects remain bounded with
explicit truncation flags; source paths and references are never
shortened. All retrieval remains archive-only and reports the last
explicit sync, not a live source check.

## Format support

Pi, Claude Code and Codex use JSONL readers; OpenCode uses read-only
SQLite snapshots. Both produce the same core import result. A resume
checkpoint is optional; an adapter can simply reread a changed
session. Agent-specific ordering, content and identity belong in
adapters.

Schema baseline and future migration registration are described beside
[the migration runner](../packages/core/src/migrations/README.md).

### OpenCode storage

The OpenCode adapter reads `session_v2` and `session_message`
projections from `opencode.db`, verified against OpenCode **2.0.22**.
The contract comes from the pinned upstream
[SQLite tables](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/sql.ts),
[message schema](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/session-message.ts),
and
[history reader](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/history.ts).
Legacy `session`/`message`/`part` tables and per-record JSON
directories are explicitly unsupported. The adapter does not migrate
source stores.

One import unit represents one session within one database path.
Read-only transactions provide consistent views including committed
WAL data. Content fingerprints cover the complete session row and all
its message rows; they detect appends, same-sequence streaming
updates, title changes and deletions even without timestamp changes.
Sync checks the fingerprint again before storing and retains the prior
import if the source changed. Unchanged sessions skip parsing/storage,
but still require reading their projected rows for hashing; this is
not a constant-time scan. Each session is limited to 64 MiB of
serialized rows and 100,000 message records.

Messages are ordered by native `seq`, with dialogue context linked
across intervening tool-only/control records. User/assistant text is
searchable by default; reasoning, tool calls/results, shell
operations, summaries and injected context are separate evidence
kinds. Running assistant/tool evidence has `state: in_progress`;
revert metadata or unfamiliar semantics produce `state: unknown`.
Fork/subagent parent links are retained without inferring
cross-session active branches or reconstructing a model's compacted
context window.

Raw records retain every selected row column. A message's SQLite
`data` column is unpacked into its native JSON object, preserving its
JSON bytes so pointers such as `/data/content` address the archived
record. Attachments and unfamiliar content remain raw rather than
being guessed into conversation text. The adapter does not read
account/credential tables, replay the event log, or import pending
inbox entries.

Reimports replace the stored projection, not a revision history.
Removed message rows disappear from the next successful session
import; a session removed entirely from the source retains its last
archived copy. Database removal likewise leaves imported content
retrievable. File counters count per-session import inputs, so
multiple sessions can refer to the same physical database path.
