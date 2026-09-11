# omnirecall — Product requirements

Status: revised product direction; schema and adapter design pending.

## Purpose

omnirecall lets a coding assistant find useful evidence from previous
coding sessions, including sessions recorded by a different assistant.
The user should be able to say:

> There was a previous session where this was discussed. Use
> `pnpx omnirecall` to find the information.

The assistant can then search a local archive, identify relevant
records, and retrieve enough detail to answer the question or continue
the work. The archive must capture both what was discussed and what
actually happened: commands, edits, tool outputs, failures, and other
recorded session context.

The project grows from
[pirecall](https://github.com/spences10/pirecall),
[ccrecall](https://github.com/spences10/ccrecall), and
[ocrecall](https://github.com/spences10/ocrecall). Those projects are
useful references for source formats and existing import behaviour.
omnirecall provides a common retrieval interface across agents.

## Primary use cases

- Recover a previous decision, its rationale, and the evidence behind it.
- Find a command, implementation, edit, error, or successful fix from
  earlier work.
- Continue investigating work started with another coding assistant.
- Retrieve archived information after the original session files have
  been removed or become unavailable.
- Start with a small search result and expand only the relevant detail,
  keeping unnecessary text out of the calling model's context.

## Agreed requirements

### A durable local archive

SQLite is the main local store. Import copies session information into
omnirecall's archive; subsequent search and retrieval operate on that
archive. They must not depend on following a path back to a live source
file or a sibling recall database.

Source paths remain useful provenance and availability information.
Missing files, inaccessible roots, or deleted original sessions must
not automatically remove previously archived information. Import must
leave original histories and sibling recall stores untouched.

Repeated imports of unchanged input must not duplicate archived data.
Changes to an existing source must be handled deliberately without
silently losing previously retained evidence. The exact representation
of changes and revisions is a design question, not a requirement to
retain the current full-revision implementation.

### Session content beyond dialogue

The archive must accommodate the following information where the
source provides it:

- User and assistant messages, including structured content blocks.
- Tool calls, their inputs, associated results, and reported errors.
- Recorded reasoning or thinking content.
- Session and project metadata, native identifiers, timestamps, and
  source ordering.
- Message ancestry, turns, branches, forks, and child-session links.
- Compaction summaries and events, model changes, usage, and other
  agent-specific session records.

These are content requirements, not a prescribed list of database
tables. A source need not provide every category. Missing information
must remain distinguishable from information that the importer does
not yet understand.

Retrieval must preserve the distinction between an assistant's claim
and the tool evidence available to support it. It must also avoid
presenting separate branches or rolled-back work as one uninterrupted
sequence. Reconstructing the exact prompt seen by a historical model
is outside the initial scope.

### Extensible source support

The shared structure must accommodate configured coding assistants
beyond Pi, Codex, and Claude Code. Cline, Goose, Gemini, and future
agents are examples of potential additions, not promised initial
integrations.

Agent-specific discovery and interpretation belong in adapter
packages. Core storage and retrieval should work with a common
representation rather than accumulating special cases for each agent.

JSONL is the immediate focus. The shared data model must not assume
that every assistant uses JSONL, that one file always equals one
session, or that native identifiers are globally unique. The next
design step will determine how far the adapter interface needs to
change to support these requirements.

### Focused retrieval

Archive completeness and response size are separate concerns. Keep
the available evidence locally while returning small, useful excerpts
to the calling assistant.

The retrieval workflow is:

1. Search across the archive, optionally filtering by agent, project,
   source, session, or time.
2. Receive compact matches with provenance and references to the
   archived evidence.
3. Read a selected match and expand into relevant surrounding records,
   including tool inputs and results when needed.
4. Continue through longer content using explicit pagination or
   continuation references.

Responses must make truncation and remaining content visible, avoid
repeating overlapping context unnecessarily, and allow callers to
control output size. Retrieval limits must not discard content from
the archive. References must resolve to the intended archived evidence
even after later imports.

The CLI must provide structured output suitable for coding assistants.
The agent running the CLI need not be the agent that created a session.
Historical transcript content is evidence, not a new instruction to
the assistant retrieving it.

### Simple, observable importing

Import should discover configured sources, retain their records, and
extract the fields needed for useful search and retrieval. It should
not require an LLM, embeddings, generated summaries, or a separate
processing service.

Import results must distinguish successful indexing, unavailable
sources, incomplete input, invalid records, and unsupported formats.
An empty search result must be distinguishable from an archive that
has not indexed the requested source.

Unknown record content should be preservable without inventing a
meaning for it. Where an unknown format prevents reliable session
identity or ordering, report that limitation rather than claiming a
complete import. Exact fallback behaviour remains to be designed.

## Evidence informing the design

Inspection of the existing recall CLIs and local archive schemas
showed that the source projects already accommodate substantial detail:

| Project  | Relevant existing structures                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| pirecall | Structured message content, thinking, tool calls and results, message parents, parent-session paths, model changes, and usage |
| ccrecall | Structured content, thinking, tool calls and results, message parents, session summaries, and team/task tables                |
| ocrecall | Turns, tool calls and results, usage, compaction events, source ordering, and fork/spawn relationships                        |

This establishes useful starting points, not a guarantee that every
source record is already preserved by those implementations. Schema
support also does not establish coverage: for example, the inspected
Claude archive had empty tool and team tables.

The current omnirecall implementation supports a narrower dialogue
representation for Pi and Codex. Its schema and adapter contract are
implementation history, not constraints on this redesign.

The review of `coding_agent_session_search` provided broader questions
to consider. Its architecture is not a blueprint for this project.

## Proposed design direction — not yet final

Use a small common set of queryable fields for identity, session
membership, record type, ordering, relationships, timestamps, and
searchable text. Retain original record payloads as JSON so
agent-specific fields and unfamiliar record types have somewhere to
live without requiring a dedicated column for every variation.

Before adopting that structure, map representative records from the
three existing recall projects. Check whether the proposal preserves
their content and relationships and whether it supports the retrieval
questions above. Do not choose table boundaries solely to match the
two current omnirecall adapters.

Open decisions include:

- Which fields need common columns, and which can remain in JSON?
- How are mixed content blocks and tool call/result links represented?
- How are native identities scoped across sources and sessions?
- How are turns, branches, forks, and child sessions linked and exposed
  during retrieval?
- How are corrections, compaction, rollback, and repeated imports
  represented while retaining earlier evidence?
- What is indexed for text search, and what is available through
  focused expansion or raw-record retrieval?
- How are attachments and external artifact references retained, and
  what remains available if their original files disappear?
- What does an adapter return when one source contains several
  sessions or a session spans several sources?
- Which source records are retained directly, and how are duplicate
  representations of the same event identified?

## Scope and priorities

The immediate priority is a sound common representation, followed by
adapting the existing Pi and Codex support and adding Claude Code.
Additional agents should be possible without redesigning the archive
around each one.

SQLite remains the chosen store. Database growth is not a current
optimisation priority. Use appropriate indexes and bounded retrieval;
measure actual performance before adding storage machinery. Optional
cleanup scripts or commands can be considered later. There must be no
automatic retention policy that silently removes archived evidence.

The redesign has no migration or backward-compatibility requirement.
Existing schema and output choices can change as needed. This is a
development decision, not a claim about npm publication history.

Host-specific plugins, a hosted service, semantic search, usage
dashboards, and a general analytics pipeline are outside the immediate
scope. The standalone CLI is sufficient for the primary workflow.

## Acceptance criteria for the redesign

- A caller can find a prior discussion and retrieve its related tool
  evidence without reading the complete session into context.
- Records from the initial supported agents fit a documented common
  model with agent-specific content preserved.
- Native identity collisions and equal timestamps do not merge or
  misorder unrelated records.
- Branches and related sessions remain identifiable; retrieval does
  not silently blend their histories.
- Repeated unchanged imports are idempotent, and source changes do
  not silently erase retained evidence.
- Archived content remains retrievable after original sources vanish.
- Output limits, truncation, continuation, provenance, and import
  coverage are explicit to the caller.
- Representative fixtures verify messages, tools, relationships,
  unfamiliar records, and changed or incomplete input.

## Next step

Produce a source-record mapping for Pi, Claude Code, and Codex, using
their existing recall implementations and representative records.
Use that mapping to propose the database schema and adapter contract
for review before implementation.
