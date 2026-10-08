# omnirecall

## 0.0.7

### Patch Changes

- 522a03a: List and sync source roots in one consistent agent order:
  Pi, Codex, Claude, then OpenCode.
- a4e38c8: Report malformed OpenCode rows with the same field-path
  error messages as the other session adapters.

## 0.0.6

### Patch Changes

- 689ce22: Make recall compact by default; use `--full` for detailed
  schema v1 rows.
- 6478671: Make sessions compact by default; use `--full` for detailed
  schema v1 rows.
- c66300b: Point `info` agent instructions at session-first retrieval:
  by-session search, outline, recall, evidence, read.
- 5a73da4: Add `search --by-session`: one row per matching session
  with hit count and best snippet.
- b621875: Add `outline`: list a session's user prompts and summaries
  with refs to read.
- 4e6ca5e: Print short `m2`/`r2` refs in compact output; `read`
  accepts short and canonical refs.
- 6478671: Slim `read` to one message plus navigation refs; `--full`
  restores context and provenance.
- 1ba566f: Add `evidence`: list tool calls, results and operations in
  a message's turn.

## 0.0.5

### Patch Changes

- 6017e48: Reduce compact retrieval duplication, share repeated
  metadata, expose source paths, and add concise session listings.
- 2eeb2be: Add read-only OpenCode v2 SQLite imports with searchable
  conversations, tool evidence, and automatic source discovery.
- 89a077d: Restore Claude context across tool records and include
  entire days in date-only upper search bounds.
- 394afd8: Exclude Codex reviewer context from dialogue searches and
  automatically quote punctuated terms within FTS expressions.
- e27f1e7: Add session title and date filters plus concise identifiers
  with scoped resolution and ambiguity checks.

## 0.0.4

### Patch Changes

- d67007a: Add README preview image illustrating shared session recall
  across Pi, Codex, and Claude Code conversations.
- e25234d: Enable FTS5 phrases, alternatives, prefixes, and exclusions
  with actionable query errors and updated command help.
- 772bc6d: Generate reproducible README previews from synthetic
  session evidence, highlighting inline recall through familiar npx
  commands.

## 0.0.3

### Patch Changes

- 635a45b: Show live sync progress with phases, counts and elapsed
  time while keeping JSON mode quiet.
- 5a4653c: Add repository skills for consistent TypeScript tooling
  changes and reproducible sync benchmarks across coding agents.
- bd9f1f0: Replace env-paths with native Node.js utilities, preserving
  platform-specific database locations, overrides, and persistent
  archive storage.
- 157c295: Clarify package benefits and usage while allowing expected
  SQLite runtime warnings in CLI verification tests.
- b891937: Support Codex assistant text and realtime records with
  precise schema validation.
- 74f5183: Use platform-specific application data directories and
  rename the default archive to omnirecall.db while preserving
  overrides.
- 02e7b0b: Automatically discover available coding agent histories and
  reuse configured sources when syncing without explicit roots.
- 69dc930: Add compact search, focused message retrieval, stable
  references, character pagination, and deduplicated context for
  recall.
- 5ef760d: Add Valibot schema validation for imported records,
  preserving raw evidence and reporting malformed fields clearly.
- afdf37c: Optimize source lookups, default searches to conversations,
  and replace standalone guidance with focused command help.
- 4e53ccf: Speed up sync by caching unchanged inputs and reusing
  validated imports.
- 988b95e: Show concise sync summaries with grouped issues and
  optional verbose details.
- 65d0e8e: Establish the release schema baseline and transactional
  migrations with read-only safeguards.
- 8a146a8: Simplify session storage and resume imports without
  revision snapshots.
- 7cc1414: Refactor archive storage with extracted SQL, typed queries,
  cached statements, and consistent source provenance reporting.
- 24f87b2: Enforce package boundaries, verify packaged CLI behaviour,
  automate repository checks, and consolidate agent support
  documentation.
- 354ec48: Preserve original session records, add Claude support, and
  enable focused retrieval of coding agent evidence.
- 8d64993: Reject unknown dialogue blocks while preserving archived
  conversations and correctly reporting truncated sync issue details.
- 9fe552d: Add durable cross-agent recall for Pi and Codex with SQLite
  indexing, bounded context, and filtering.

## 0.0.2

### Patch Changes

- a2ffb3b: Scaffold omnirecall CLI with pnpm workspaces, TypeScript
  tooling, colocated tests, editor settings, and release
  configuration.
