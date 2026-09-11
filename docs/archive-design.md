# Archive schema and adapter proposal

Status: design reference with an initial implementation in the working
tree; see implementation status below for concrete choices and limits.
It follows the [PRD](omni-recall-prd.md) and
[source mapping](session-record-mapping.md).

## Recommended approach

Archive original session records, extract searchable parts, and retain
the relationships needed to navigate them. Keep agent-specific fields
in the original JSON. Core storage should not need a new table when an
agent adds a tool, event type, or metadata field.

Keep full session revisions for the first implementation. This is easy
to reason about and preserves earlier evidence and references.
Unchanged imports add no revision. Changed sessions repeat records and
search text in a new revision; that storage cost is accepted for now.
There is no delta format, background summarisation, embedding service,
or requirement to implement content deduplication first.

## Additional format checks

Pi's session entry definitions identify compaction references through
`firstKeptEntryId`, branch-summary references through `fromId`, and
label targets through `targetId`. These are distinct from `parentId`.
Custom state entries and custom messages also have different meanings.
Preserve all these payloads; extract summary/custom-message text and
record each recognised relationship under its own kind.
[Pi session definitions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts)
(inspected 2026-09-11).

ccrecall's team importer reads team `config.json` and individual task
JSON files from separate directories. It does not derive those tables
from the ordinary transcript parser. Team/task import can be a later
addition using the same source abstraction; it does not require team
tables in omnirecall now.
[ccrecall team importer](https://github.com/spences10/ccrecall/blob/1d9d0d9e948cf153c929ede221b06d07bab2cec3/src/sync-teams.ts).

Claude documents independent subagent transcripts under a parent
session's `subagents` directory. Treat each subagent transcript as a
separate conversation with a relationship to its containing session.
Do not infer that every subagent file has an independent `sessionId`,
or infer a direct spawning agent solely from the directory hierarchy.
Exact envelope fields still need fixture verification.
[Claude subagent storage](https://code.claude.com/docs/en/sub-agents).

## Database structure

Eight ordinary tables plus one FTS5 index. Sources, resources,
revisions, and input provenance handle importing; records, parts, and
links describe the evidence. Sessions provide identity across imports.

The lists below are proposed columns. `?` means nullable. Archive IDs
are core-generated opaque text identifiers; JSON columns are validated
JSON text. Native IDs and types are text without agent-specific SQL
enums.

| Table             | Columns                                                                                                                                                                                | Key rules                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`         | `source_id`, `agent`, `root`, `config_json`, `status`, `checked_at?`                                                                                                                   | PK `source_id`; agent is an extensible slug, not a Pi/Codex union                                                                      |
| `resources`       | `resource_id`, `source_id`, `locator`, `kind`, `status`, `fingerprint?`, `checkpoint_json?`, `checked_at?`                                                                             | PK `resource_id`; FK source; unique `(source_id, locator)`                                                                             |
| `sessions`        | `session_id`, `source_id`, `session_key`, `native_id?`, `current_revision?`                                                                                                            | PK `session_id`; FK source; unique `(source_id, session_key)`                                                                          |
| `revisions`       | `revision_id`, `session_id`, `input_hash`, `parser_version`, `project?`, `title?`, `started_at?`, `ended_at?`, `metadata_json`, `coverage`, `indexed_at`                               | PK `revision_id`; FK session; unique `(session_id, input_hash, parser_version)`                                                        |
| `revision_inputs` | `revision_id`, `input_key`, `resource_id`, `fingerprint`, `extent_json`                                                                                                                | PK `(revision_id, input_key)`; FKs revision/resource                                                                                   |
| `records`         | `record_id`, `revision_id`, `record_key`, `input_key`, `position_json`, `source_order`, `native_id?`, `native_type?`, `timestamp?`, `turn_key?`, `state`, `interpretation`, `raw_json` | PK `record_id`; unique `(revision_id, record_key)` and `(revision_id, source_order)`; FK `(revision_id, input_key)` to revision inputs |
| `parts`           | `part_id`, `record_id`, `part_key`, `part_order`, `json_pointer`, `kind`, `role?`, `native_id?`, `representation`, `search_text`                                                       | Integer PK `part_id`; FK record; unique `(record_id, part_key)` and `(record_id, part_order)`                                          |
| `links`           | `link_id`, `revision_id`, `evidence_record_id`, `from_json`, `kind`, `to_json`                                                                                                         | PK `link_id`; FK revision and same-revision evidence record; endpoints follow the contract below                                       |

`sessions.current_revision` must point to a revision of that same
session, enforced with a composite foreign key. Insert a new session
with a null pointer, then insert its revision and set the pointer in
one transaction. Use composite constraints wherever a child also
carries a revision ID so it cannot reference a different revision's
data.

`revision_inputs` freezes the input fingerprint and accepted extent;
`resources` reports the most recently observed availability. A changed
resource fingerprint must never rewrite historical input provenance.
Several inputs can contribute to one revision, and one resource can
contribute to several sessions.

`raw_json` contains the complete accepted source record, including the
envelope. Preserve original JSON text when available; SQL-backed
adapters must provide a documented JSON representation of source rows.
This is not a byte-for-byte backup of whole files or invalid input.
Inline content remains in the JSON, while external attachments remain
references for the initial implementation. Retrieval must say when
only a reference is archived.

Do not require a native record ID, timestamp, project, or speaker
role. `record_key` identifies a physical record occurrence within the
revision, not a unique semantic message. Two corrections with the same
native message ID must both fit. `source_order` is a deterministic
ordinal assigned by the adapter; native ordinals/byte positions remain
in `position_json` and the original record.

The proposed common states are:

- Record `state`: `active`, `inactive`, or `unknown`. Inactive
  includes abandoned branches and rolled-back turns, with the precise
  reason retained in source events/relationships.
- Record `interpretation`: `known`, `partial`, or `unknown`.
- Part `representation`: `primary`, `mirror`, or `superseded`.
- Revision `coverage`: `complete` or `partial`, describing
  interpretation and accepted input coverage, not whether the session
  has finished.

An unknown state must not be silently treated as a confirmed active
branch. Ordinary search may include it with that uncertainty visible.

## Searchable parts and relationships

A part is an addressable piece of a record: text, thinking, a tool
call, a result, a completed operation, a summary, or an attachment
reference. Use `json_pointer` to locate the original content; an empty
pointer addresses the entire record. Preserve content-block ordering.

Tool-call search text can include the tool name and textual arguments.
Tool results and recorded summaries are searchable too. Do not index
every metadata key, binary payload, or opaque string by default.
Unknown records remain readable as JSON without claiming full search
coverage. Search uses only stored extracted text; it does not parse
every payload on each query.

Create `parts_fts(search_text)` with external content referencing
`parts.part_id`. Include FTS insert, update, and delete maintenance so
later explicit cleanup cannot leave stale entries. Initial indexes:

- `records(revision_id, source_order)` and
  `records(revision_id, native_id)`.
- `records(revision_id, turn_key)` and `parts(record_id, part_order)`.
- `parts(kind)`; `revisions(project, started_at)`.
- `links(revision_id, kind)` and `links(evidence_record_id)`.

Links use typed JSON endpoints, avoiding dedicated columns for every
agent relationship. Supported endpoint shapes are:

```ts
type Endpoint =
	| { type: 'session'; session_key: string }
	| { type: 'record'; record_key: string }
	| { type: 'part'; record_key: string; part_key: string }
	| { type: 'native'; namespace: string; value: string }
	| { type: 'locator'; locator: string };
```

Record/part endpoints refer to the owning revision. Session endpoints
refer to the configured source namespace. Native endpoints retain
unresolved references, including a referenced turn or call; namespaces
must distinguish those identities. Locator endpoints retain path-based
references such as Pi's parent session.

Core validates JSON endpoint shapes and local references on import.
Resolve native/path references only when unambiguous; retain
unresolved links and expose that state otherwise. No automatic
cross-root identity merging is proposed. Future resolution may find
more information, but must not mutate historical raw records or invent
a relationship.

Initial link kinds include `parent`, `tool_result_for`, `forked_from`,
`child_session`, `summary_of`, `first_retained`, `label_target`,
`corrects`, and `mirrors`. Links are directional and supported by an
evidence record. A session link permits deliberate navigation; it does
not automatically combine separate conversations in a context window.

## Adapter contract

Adapters own source discovery, consistent reading, format recognition,
and interpretation. Core owns archive IDs, transactions, validation,
storage, FTS, query filtering, and output budgets. Adapters neither
write the archive database nor invoke sibling recall CLIs at runtime.

The proposed TypeScript boundary is:

```ts
interface Adapter {
	agent: string;
	parser_version: string;
	discover(source: SourceConfig): Promise<Discovery>;
	read(unit: ImportUnit): Promise<ReadResult>;
}

interface SourceConfig {
	root: string;
	options: Record<string, unknown>;
}

interface Discovery {
	units: ImportUnit[];
	complete: boolean;
	issues: Issue[];
}

interface ImportUnit {
	key: string;
	inputs: { key: string; locator: string; kind: string }[];
}

interface ReadResult {
	inputs: {
		key: string;
		locator: string;
		kind: string;
		fingerprint: string;
		extent: Record<string, unknown>;
	}[];
	sessions: SessionSnapshot[];
	issues: Issue[];
}

interface SessionSnapshot {
	session_key: string;
	native_id: string | null;
	project: string | null;
	title: string | null;
	started_at: string | null;
	ended_at: string | null;
	metadata: Record<string, unknown>;
	coverage: 'complete' | 'partial';
	records: RecordSnapshot[];
	links: LinkSnapshot[];
}
```

`RecordSnapshot` carries the adapter-owned fields listed for `records`
and an ordered array of parts, excluding archive-generated IDs.
`LinkSnapshot` carries an evidence record key, kind, and typed
endpoints. `Issue` contains a code, message, input key, optional
position/session key, and whether it prevented that session from being
imported.

Each emitted snapshot contains the full accepted history of its
session, not just newly appended records. An import unit can group
multiple files or read one database containing multiple sessions.
Shared JSONL reading helpers should remain reusable, but JSONL is not
part of this contract. SQLite-backed reading will need an appropriate
source snapshot when an adapter for it is implemented; none is
promised in the first change.

Session keys are adapter-defined and stable within a configured
source. For Pi and Codex, the native session ID is the starting point.
Claude subagent keys must incorporate the parent conversation and
subagent identity, rather than assuming the envelope's session ID is
sufficient. Do not synthesize a claimed session identity for an
unsupported format; report it and preserve the previously archived
revision.

## Import and revision behaviour

1. Discover units. Mark previously known resources missing only after
   a complete successful enumeration. Missing inputs never delete
   evidence.
2. Read a consistent input set and interpret each session. For JSONL,
   accept complete valid records and leave an unfinished trailing line
   pending. A malformed complete record or ambiguous ordering prevents
   replacement of that session's current revision. Other independent
   sessions can still succeed.
3. Preserve unfamiliar valid records when identity/order remain
   reliable; mark interpretation and coverage accordingly. Unsupported
   semantics that undermine those guarantees block that session's
   update.
4. Core computes `input_hash` from the ordered original records plus
   relevant session metadata and effective adapter configuration,
   using a documented deterministic encoding. Parser version is a
   separate revision-key component. Mere access checks do not change
   this hash.
5. Compare candidate snapshots for the same session before choosing a
   revision. Identical candidates can share one revision and record
   all observed input locations. Divergent candidates are conflicts
   unless the adapter has explicitly assembled them into one coherent
   snapshot.
6. Insert a changed revision, input provenance, records, parts, and
   links; set `current_revision` and persist successful input
   checkpoints in the same transaction. Unchanged imports reuse the
   existing revision and update observed resource availability. Failed
   imports do not advance their successful checkpoints.

Raw records and parts in a published revision are immutable. A parser
change creates a new interpretation revision when that session is next
imported. Reinterpretation solely from archived records can be added
later; initial correctness must not depend on it.

Stable retrieval references encode archive session/revision/record and
optional part identity. Reads resolve the exact revision. References
do not identify “the latest message with this native ID”.

## Retrieval behaviour

Ordinary search selects current revisions and primary parts, excluding
known inactive records. Historical search includes earlier revisions,
inactive work, mirrors, and superseded observations with their status
visible. Add kind filtering so callers can ask specifically for tool
results, reasoning, or dialogue.

Focused read returns the matched part with its source record
reference, and bounded expansion can follow a tool-result link to its
call or a parent link to relevant context. Where only ordering is
known, present nearby records as chronological neighbours, not
inferred ancestors. Stop automatic expansion at ambiguous branches or
unresolved links.

Expose explicit bounded raw-record reading with continuation for large
JSON content. Preserve compact snippets, shared context, byte budgets,
and clear truncation from the current CLI. Exact new flags and output
field names should be settled with the retrieval implementation.

## Implementation sequence and checks

1. Add synthetic fixtures for Pi compaction/custom entries, Claude
   mixed tools and summary/subagent shapes, and Codex
   mirrors/corrections/rollback. Validate still-unverified Claude
   envelopes against representative source records before claiming
   their semantic support.
2. Implement schema and core import types; adapt Pi and Codex to emit
   full records, parts, and relationships. Keep existing CLI retrieval
   functional while its underlying record model changes.
3. Add Claude transcript discovery/import using the verified fixtures.
   Separate team/task JSON ingestion remains outside the initial
   adapter.
4. Extend search/read to tools, events, and raw records with bounded
   output.

Required checks cover identical reimports; same native ID in distinct
scopes; several parts per record; equal timestamps; missing parents;
corrections and rollback; source deletion; partial/invalid input;
multi-input sessions; multi-session units; stable old references; and
FTS consistency. No test needs real private histories.

The main review choice is the intentionally straightforward
full-revision storage. Payload deduplication can be introduced later
if actual archive growth justifies it, without changing what a record
or relationship means.

## Initial implementation status

The working tree now implements the archive/import/retrieval
foundation, including the eight tables, Pi/Codex full-record
retention, an initial Claude transcript adapter, kind-filtered search,
and bounded raw reads. The proposal above remains the design
reference; these are the concrete choices and limits of this
implementation:

- Existing dialogue projections and additional evidence parts share
  the `parts` table. The TypeScript result still calls the dialogue
  array `messages` and the additional array `parts`. Both retain raw
  record keys.
- Resource identity uses `(source_id, path)` rather than a separate
  ID. `path` is a locator for generic adapters. `revision_inputs`
  associates all locations with each revision; individual raw records
  carry their input locator. Multi-session units commit atomically.
- `Adapter.discover(root)` returns complete import units or throws;
  `read(unit)` returns sessions and input observations. The initial
  contract has no partial-enumeration result or incremental read
  protocol. JSONL helpers remain optional. Each adapter supplies a
  parser version.
- Record/link IDs use revision-qualified keys. Links currently
  describe an evidence record, relationship kind, target namespace and
  native target. Full typed endpoints and general cross-session
  resolution are deferred. Unambiguous tool result/call links are used
  for focused reads.
- Dialogue parts have `kind: message`; other kinds include reasoning,
  tool_call, tool_result, summary, and operation. Raw-only records
  remain reachable from session/record references. `unindexed_records`
  reports records without a searchable part, including ordinary
  metadata.
- Changed metadata creates a revision instead of mutating an old
  title. If a Codex title index disappears, the current view uses the
  transcript title again; the previously indexed title remains in its
  old revision.
- Pi and Codex retain strict rejection of unsupported semantic shapes.
  Claude extra envelopes are retained, but compaction and branch
  semantics are not yet fully interpreted. Claude searchable state is
  `unknown`. Missing Claude native identity, mixed session IDs, or
  repeated message UUIDs reject the file. These are initial support
  limits, not a claim that those shapes cannot occur in real
  histories.
- Fixtures cover multi-input/session units, rollback of a failing
  unit, tools, subagent identity, correction provenance, source
  deletion, raw continuation, and FTS maintenance. Broader
  representative Claude format verification remains necessary before
  claiming comprehensive support.

No source migration or cleanup command has been introduced. Schema 1
archives remain untouched and require a separate new schema 2 database
for this implementation.

### Automatic source selection

Plain CLI `sync` now combines stored sources with available standard
Pi, Claude, and Codex locations. Explicit roots replace this automatic
selection for the invocation. Agent/source filters apply to either
mode. Known missing sources remain visible as sync issues. With
nothing to import, an empty database is created and the CLI explains
the empty result. Tests isolate the child process home directory so
automatic discovery cannot import developer histories.
