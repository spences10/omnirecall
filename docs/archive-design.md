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

## Format support

Pi, Claude Code and Codex currently use JSONL readers. Future adapters
can read JSON documents or databases and produce the same core import
result. A resume checkpoint is optional; an adapter can simply reread
a changed session. Agent-specific ordering, content and identity
belong in adapters.

Schema baseline and future migration registration are described beside
[the migration runner](../packages/core/src/migrations/README.md).
