# omnirecall

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
