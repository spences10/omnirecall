# Session record mapping

Status: design evidence and proposal for review. No schema or adapter
changes have been implemented. Read alongside the
[PRD](omni-recall-prd.md).

## Evidence and limits

This mapping examines the source formats consumed by the existing
recall implementations, their parsers and storage, and omnirecall's
current adapters. It is not an exhaustive specification of every
version of each agent's history format.

Pinned implementation references:

- Pi:
  [parser](https://github.com/spences10/pirecall/blob/cb24203edef7311ccc954b9a1ca2b39942a1f55e/src/parser.ts),
  [schema](https://github.com/spences10/pirecall/blob/cb24203edef7311ccc954b9a1ca2b39942a1f55e/src/schema.sql),
  and
  [parser tests](https://github.com/spences10/pirecall/blob/cb24203edef7311ccc954b9a1ca2b39942a1f55e/src/parser.test.ts).
- Claude Code:
  [parser](https://github.com/spences10/ccrecall/blob/1d9d0d9e948cf153c929ede221b06d07bab2cec3/src/parser.ts),
  [database](https://github.com/spences10/ccrecall/blob/1d9d0d9e948cf153c929ede221b06d07bab2cec3/src/db.ts),
  and
  [sync](https://github.com/spences10/ccrecall/blob/1d9d0d9e948cf153c929ede221b06d07bab2cec3/src/sync.ts).
- Codex paginated histories:
  [normalizer](https://github.com/spences10/ocrecall/blob/a52ba451e8f62d4fd985c4c25f3106ae10cdf1c1/src/normalize.ts),
  [sync](https://github.com/spences10/ocrecall/blob/a52ba451e8f62d4fd985c4c25f3106ae10cdf1c1/src/sync.ts),
  and
  [synthetic fixtures](https://github.com/spences10/ocrecall/blob/a52ba451e8f62d4fd985c4c25f3106ae10cdf1c1/src/fixtures.ts).
- Current omnirecall:
  [Pi adapter](../packages/adapter-pi/src/index.ts),
  [Codex adapter](../packages/adapter-codex/src/index.ts), and
  [shared types](../packages/core/src/types.ts).

Earlier `pnpx` schema and SELECT queries ran against copies of local
recall databases. They demonstrated real Pi tool-result and bash
records, Claude attachment/system records, and Codex compaction, fork,
and spawn records. The small Claude sample did not exercise tools or
teams. CLI versions resolved to pirecall 0.1.3, ccrecall 0.0.3, and
ocrecall 0.0.6; cloned source revisions and local database schemas are
separate evidence, not assumed to be identical releases.

No private transcript text is reproduced here. Examples below are
synthetic illustrations. Source archives were not synced or compacted.

## Source-to-common mapping

The common concepts below describe information to retain, not a table
per row. Full source records must accompany extracted fields.

| Common concept                     | Pi                                                                        | Claude Code                                                                          | Codex paginated history                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Session identity                   | `session.id` in header                                                    | `sessionId` on transcript records                                                    | `session_meta.payload.id`; separate recording ID in `payload.session_id`                     |
| Project and metadata               | Header `cwd`, version, timestamp; `session_info.name`                     | Record `cwd`, `gitBranch`; summary records                                           | Header `cwd`, `git`, originator, source, CLI version; title index                            |
| Record identity                    | Entry `id`; header is separate                                            | Record `uuid` when present                                                           | Optional ordinal and source position; item IDs and call IDs identify different entities      |
| Ordering                           | Serialized entry order plus `parentId` tree                               | Serialized record order plus `parentUuid` where present                              | Serialized order/ordinal plus turn membership; timestamps alone are insufficient             |
| Dialogue                           | `message.role` and `message.content`                                      | Record type and `message.role`; string or block-array content                        | Completed `UserMessage`/`AgentMessage` items; response/event mirrors also exist              |
| Thinking                           | `thinking` blocks inside message content                                  | `thinking` blocks inside message content                                             | Completed `Reasoning.summary_text`; response reasoning records are a separate representation |
| Tool invocation                    | `toolCall` block: `id`, `name`, `arguments`                               | `tool_use` block: `id`, `name`, `input`                                              | Response `function_call`/`custom_tool_call`: `call_id`, name, arguments/input                |
| Tool result                        | Separate `toolResult` message: `toolCallId`, content, `isError`, details  | `tool_result` block: `tool_use_id`, content, `is_error`; can be inside a user record | Response call output linked by `call_id`; completed operations may contain output too        |
| Completed operation                | Tool-result data; also message roles such as `bashExecution`              | Tool content; no separate universal operation type established by this parser        | Completed items such as `CommandExecution`, `FileChange`, `McpToolCall`, `WebSearch`         |
| Turns and execution status         | No explicit shared turn ID established by inspected parser                | No explicit shared turn ID established by inspected parser                           | `turn_context`, task start/complete/abort, completed item `turn_id`                          |
| In-session ancestry                | `parentId` can target a non-message entry                                 | `parentUuid` is retained; completeness needs further fixtures                        | Turn rollback and serialized order; do not invent native message parents                     |
| Related sessions                   | Header `parentSession` is a path                                          | Subagent/session relationship extraction remains unverified by inspected parser      | `forked_from_id`; source subagent parent metadata; operation child-thread fields             |
| Compaction and other events        | `compaction`, `branch_summary`, model/thinking changes, extension entries | Summary records, system and other runtime record types; parser coverage is partial   | `compacted`, completed `ContextCompaction`, rollback and settings events                     |
| Usage                              | Message `usage`, provider/model, cost                                     | Message `usage` and model                                                            | Dedicated `token_usage_record`, response/recording/thread IDs, turn context                  |
| Attachments and unfamiliar content | Content blocks and extension payloads                                     | Content blocks and attachment records                                                | Structured item content, image operations, other payloads                                    |

Two distinctions matter throughout: a record's native type is not its
speaker role, and its physical position is not its ancestry. For
example, a Claude user record can carry a tool result, and a Pi
message can descend from a model-change entry.

## What the recall stores currently preserve

### Pi

The parser extracts session metadata, session names, model changes,
messages, tools, and selected usage fields. `content_json` preserves
the message content array, including blocks not extracted as text. It
is not the entire entry or message envelope.

Consequently, fields such as tool-result `details`, response metadata,
and other envelope fields are not all carried into its parsed message.
The text projection selects the first thinking block. Compaction,
branch-summary, thinking-level, and other unhandled entries return
`null`. Parent IDs can therefore refer to entries absent from the
recall store.

Mapping implication: retain every accepted entry's full payload and
actual parent reference. Extract searchable text without flattening
away block order or assuming every parent is another dialogue message.

### Claude Code

The parser retains message content JSON, extracts text and the first
thinking block, and separates tool-use and tool-result blocks into
queryable records. Tool result extraction keeps text from nested
blocks. The original full envelope is not retained.

Parsing requires `uuid`, `sessionId`, type, and a valid timestamp. A
record missing those fields returns `null`, including any summary
shape that lacks them. Although `leafUuid` appears in the input type,
it is not carried into the parsed result. An unfamiliar runtime type
can pass those checks without having its payload understood.

Team/task tables in ccrecall are not evidence that ordinary transcript
records encode those relationships. Their ingestion and representative
subagent records need separate inspection before defining that part of
the Claude adapter.

Mapping implication: preserve the envelope, content blocks, and native
relationship fields. Keep tool identity separate from enclosing
message identity. Do not make ccrecall's required message fields
mandatory for every possible source record.

### Codex

ocrecall distinguishes low-level invocations (`call:` IDs) from
completed operations (`item:` IDs). A wrapper invocation and the
command it runs can both appear. Their coexistence is not sufficient
evidence that they are duplicates or that a one-to-one relationship
exists.

Completed message IDs can update existing content. Response message
mirrors are excluded from the dialogue projection. Usage records can
refer to a recording/thread other than the containing session, and
forks can carry inherited material.

The `records` table stores identity, type, timestamp, and ordering,
not the full payload. Normalization retains selected details, ignores
some types, and records some unfamiliar events by type only. Its JSON
helper also replaces encrypted content and data-URL strings in values
that pass through it. The resulting archive is not a raw transcript
backup.

Mapping implication: archive source records separately from the
preferred searchable representation. Retain invocation and operation
identities independently, preserve corrections, and only link or
collapse representations when the source provides sufficient evidence.

## Proposed common representation

Use three basic concepts: sessions, source records, and relationships.
Searchable excerpts are derived from records. Source locations and
import checkpoints remain bookkeeping. This does not require a table
for every agent event, usage subtype, or tool name.

| Concept         | Common fields worth considering                                                                                              | Keep in original payload initially                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Session         | Qualified archive ID, agent, native ID, project, title, source provenance                                                    | Agent version, environment, provider-specific metadata                 |
| Source record   | Archive reference, session, source locator, native type/ID if available, source order, timestamp if available, original JSON | All original envelope fields and nested content                        |
| Searchable part | Owning record, block/item position, broad kind, optional role, text                                                          | Structured arguments, media blocks, detailed usage and status payloads |
| Relationship    | Kind, source endpoint, target endpoint or unresolved native reference, evidence record                                       | Agent-specific relationship details                                    |

These are proposed logical fields. Physical tables, indexes, and the
representation of revisions remain open. Common kinds could include
message, reasoning, tool call, tool result, operation, and event;
native types must remain available when those labels are insufficient.

Preserving a parsed JSON value preserves its structure, but does not
preserve original whitespace, duplicate JSON keys, or invalid bytes.
Byte-for-byte source retention is a separate decision. Likewise,
retaining a local image path does not archive the image itself.

Do not require a native ID, timestamp, role, or resolved parent for
every valid JSON record. Generate archive identity from explicit
import provenance when necessary, and report what could not be
interpreted. An unresolved relationship should remain available for
later resolution.

## Representative mapping walkthroughs

### Pi: a tool call through a non-dialogue parent

Synthetic sequence: model-change entry `e1`; assistant entry `e2` with
parent `e1`, text and tool-call block `c1`; tool-result entry `e3`
with parent `e2` and `toolCallId: c1`.

Retain all three records, their original parents, and block positions.
Index the assistant text, call name/input text, and result text as
separately addressable parts. Link the result to call `c1`. Expanding
a matching result can retrieve its invocation and relevant dialogue
without requiring the complete session.

### Claude: several tools in one message

Synthetic assistant record `m1` contains a text block and tool-use
blocks `c1` and `c2`. A later user record `m2` contains results for
both.

Retain two source records and the four tool blocks at their original
positions. Link each result through `tool_use_id`, not through
timestamp proximity or the enclosing record's user role. A result can
contain several content blocks; its text excerpt must still lead back
to those original blocks.

### Codex: an invocation, an operation, and a correction

The ocrecall synthetic fixture contains an `exec` invocation `call-1`,
a completed command item `operation-1`, and a response output for
`call-1`. Retain each source record. Link invocation to output using
the call ID; do not merge it with the command item solely because the
output text matches.

If a completed message item is later recorded with corrected content,
retain both observations while letting ordinary retrieval select the
appropriate current representation. If its turn is rolled back, retain
the evidence with that state visible. The revision mechanism must make
earlier references stable; its exact storage design is still open.

## Decisions this mapping supports

- Preserve complete source JSON records and derive small searchable
  parts from them. `content_json` alone is insufficient.
- Keep native type, speaker role, and searchable kind distinct.
- Preserve native relationships; use source order for ordering, not as
  a substitute for parent or tool links.
- Allow one record to contain several independently retrievable parts.
- Keep source-record identity separate from message, call, and
  operation identity so mirrors and corrections can be handled
  deliberately.
- Let adapters emit records and relationships for one or more
  sessions. Discovery should expose source locators without requiring
  the core model to equate files with sessions.
- Keep specialised metadata in JSON until a concrete query justifies
  additional indexed fields.

## Remaining checks before implementation

The broad representation fits the inspected message and tool shapes.
Before fixing the schema and adapter contract, resolve these bounded
questions with representative fixtures:

1. Claude summary, compaction, attachment, and subagent envelopes:
   which identities and relationship fields are actually present?
2. Pi compaction, branch summaries, and extension entries: which
   references and text should focused retrieval expose?
3. Codex mirrors, inherited fork records, and repeated item IDs: what
   evidence identifies the preferred view without losing originals?
4. Source changes: how will retained observations, current state, and
   stable references work without copying an entire growing session on
   every import?
5. Attachments: retain inline payloads and external references as-is,
   or also copy external files? No external-file copying is assumed.

The [schema and adapter proposal](archive-design.md) develops this
mapping, records additional format checks, and identifies the
remaining implementation fixtures. No additional processing service is
needed.
