# Omni Recall — Product Requirements Document

**Status:** Draft for review; basic CLI scaffold only, retrieval not
implemented

**Version:** 0.2

**Date:** 10 September 2026

**Tagline:** Recall conversations across coding assistants.

**Project location:** `/home/scott/repos/omnirecall`

## 1. Product summary

Omni Recall is a local-first, agent-agnostic CLI that retrieves
relevant context from coding-assistant session transcripts. The CLI is
the product; skills and host-specific plugins are thin integrations
that teach an assistant how to use it.

The assistant invoking Omni Recall and the assistant that produced a
transcript are independent. Claude Code can search Pi history, Codex
can search Claude Code history, and a user can search all supported
sources from a terminal.

The proposed first release provides one executable, one shared local
index/search engine, and bundled source adapters for Pi, Claude Code,
and OpenAI Codex. It reuses suitable code and tests from
`../pirecall`, `../ccrecall`, and `../ocrecall`, rather than
permanently delegating retrieval to three executables. Additional
transcript sources, such as Goose and Gemini CLI, should fit the same
adapter boundary.

“Agent-agnostic” does not mean arbitrary transcripts work
automatically. Each source and supported format needs an adapter and
verified fixtures. Neither a hosted backend nor an LLM API is required
for indexing and search; the calling assistant interprets the returned
evidence.

## 2. Problem

Developers switch between coding assistants, projects, and sessions.
Useful decisions, explanations, and unfinished work remain scattered
across local conversation files and databases. Users must remember
where a discussion happened, find the session, and reconstruct its
context.

The existing recall CLIs demonstrate useful retrieval primitives, but
maintaining separate implementations duplicates storage, search,
context retrieval, CLI formatting, and tests. A permanent wrapper
would also need to reconcile different output schemas, freshness
states, and ranking behavior.

## 3. Goals

- Search supported local histories through one consistent CLI from a
  terminal or any coding agent with permitted command execution and
  filesystem access.
- Support on-demand execution through `pnpx` or `npx`, without
  requiring a separate manual binary installation.
- Filter by subject, project, source agent, or session identifier.
- Return bounded evidence with source attribution, not whole
  conversation archives by default.
- Preserve distinctions between conversation text, tool evidence,
  summaries, and abandoned or superseded work where the source makes
  them available.
- Make missing history, unsupported formats, stale indexes, and access
  failures explicit.
- Add a transcript source without creating another CLI or search
  engine.
- Keep installation simple: one user-facing package with bundled
  first-party adapters.

## 4. Non-goals for the first release

- Browser/cloud access to files on the user's computer, a relay, or an
  always-running companion.
- Hosted transcript sync, semantic/vector search, or model-generated
  persistent profiles.
- Universal support for every historical transcript format or ordinary
  ChatGPT web exports.
- Resuming another assistant's session or executing instructions found
  in old conversations.
- Dynamic third-party adapter loading, an adapter marketplace, or
  independently releasing every workspace package.
- A TUI, desktop application, or analytics suite reproducing every
  existing recall-tool command.
- Migrating, modifying, or deprecating the sibling tools and their
  databases as part of the initial implementation.

## 5. Users and primary scenarios

The initial audience is developers with accessible local Pi, Claude
Code, and/or Codex histories and a supported Node.js runtime. The
originating agent need not be running for its stored history to be
searchable.

| Scenario                          | Example request                                 | Expected result                                                                       |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Recover a decision                | “What did we decide about authentication?”      | Relevant evidence, source agent/session, date, and any later correction found.        |
| Search another agent's discussion | “Find the Pi conversation about the migration.” | Matching sessions and enough context to identify the right one.                       |
| Retrieve a named session          | “What happened in Check work device access?”    | Locate via metadata or content, then retrieve bounded detail.                         |
| Continue project context          | “What was left to do on this project?”          | Recorded unfinished work, separated from a fresh assessment of current project state. |
| Verify access                     | “Can you find my previous Claude Code session?” | A short concrete match, not an unsolicited full-session summary.                      |

The CLI returns records and retrieval metadata. Skills guide the
calling assistant to distinguish recorded claims from verified tool
evidence and current state; search alone cannot determine whether a
proposed action actually happened.

## 6. Proposed architecture

### Workspace and distribution

Use a lightweight pnpm monorepo with one application and internal
library packages:

```text
apps/
  cli/                  # omnirecall executable
packages/
  core/                 # shared types, indexing, search, bounded context
  adapter-pi/
  adapter-claude/
  adapter-codex/
integrations/
  skills/               # instructions for agents invoking the CLI
  ...                   # host-specific packaging when verified
```

Package names and layout are provisional. Workspace boundaries do not
imply separate npm publications or independent release cycles. Bundle
the first-party adapters into one user-facing distribution; avoid
additional build orchestration unless the implementation demonstrates
a need.

### Data flow and ownership

```text
Terminal or coding assistant
          |
          v
Omni Recall CLI <--- optional skill/plugin instructions
          |
          +-- sync --> source adapters --> normalized records
          |                                      |
          |                                      v
          +-- search / recall / sessions --> shared SQLite index
                                                 |
                                                 v
                                  bounded, attributed results
```

| Boundary       | Owns                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI            | Arguments, configuration, adapter registration, source selection, structured output, exit behavior.                                           |
| Source adapter | History discovery, format detection, source-specific update/checkpoint interpretation, metadata extraction, and normalization.                |
| Shared core    | Common record contract, index schema/migrations, transactions, checkpoint persistence, FTS5 search, filtering, and bounded context retrieval. |
| Skill/plugin   | Host setup and retrieval guidance; no duplicate parser, database, or search implementation.                                                   |

Adapters use common types and ingestion APIs rather than writing
directly to core tables. The core must not assume that every source is
an append-only file or that one file equals one session.
Adapter-specific progress state can be persisted by the core, but its
meaning belongs to the adapter.

### Normalization requirements

The exact TypeScript contract and SQL schema remain to be designed
through fixtures. The common contract must preserve:

- Source agent and configured source identity, native session/message
  IDs, and provenance locators sufficient to trace a result back to
  its origin. IDs must not collide across sources.
- Session metadata where available: title, project/cwd, timestamps,
  and parent/fork relationships. Missing values remain unknown rather
  than fabricated.
- Deterministic message order and available parent/turn relationships;
  timestamps alone are insufficient for surrounding context.
- Content kind and role: user text, assistant text, tool call/result,
  and summary must remain distinguishable. Hidden reasoning and tool
  output are not default recall content.
- Source-specific corrections, repeated-message updates, rollbacks,
  and checkpoints where supported. Normalization must not silently
  turn abandoned branches into one apparent conversation.
- Source availability, freshness, unsupported-format diagnostics, and
  truncation/gap information.

Retain source-specific metadata only where justified; the first schema
need not model every agent feature or store complete raw payloads.
Source adapters should not implement their own ranking or retrieval
engine.

### Shared index and existing tools

Use a separate Omni Recall-owned SQLite index, not the sibling tools'
databases. A shared FTS5 corpus avoids merging incomparable raw
relevance scores from independently indexed collections; content
selection and ranking still need fixture-based validation.

Reuse suitable parser logic, ingestion patterns, and tests from the
existing tools. This is not a promise of drop-in extraction: their
current search/import code is not exposed through a common public
library API. Keep their repositories, published APIs, and databases
unchanged in the initial slice.

Whether Omni Recall ultimately succeeds those tools or remains a
companion is an open product decision. Likewise, calling its storage
an “index” does not settle whether it retains content after source
deletion; see section 9.

### Runtime and access

TypeScript, Node.js, `node:sqlite`, citty, pnpm workspaces, and Vitest
are the starting technology choices, consistent with the sibling
projects. Minimum runtime versions and operating systems must be
verified before release. Python is not a runtime requirement.

Detect command and filesystem capabilities, not a presumed local/cloud
flag. A browser or desktop label does not establish history access.
Unreadable data must not be reported as an empty archive.

## 7. CLI surface and functional requirements

These examples describe proposed behavior after publication, not
existing commands or a finalized public API:

```bash
pnpx omnirecall sources --json
pnpx omnirecall sync --json
pnpx omnirecall search "migration" --agent pi --project my-app --json
pnpx omnirecall recall "authentication decision" --project my-app --json
pnpx omnirecall sessions --agent codex --json

# npm alternative when pnpm is not installed
npx omnirecall recall "authentication decision" --json
```

`--agent` selects the transcript source, not the calling assistant. A
bounded session-read operation is also required; its syntax and
pagination contract remain to be specified.

| ID    | Requirement                           | Acceptance condition                                                                                                                                                                            |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-01 | Discover sources and index state.     | Distinguish available, missing, blocked, unsupported, and unindexed sources, with freshness reported separately. One failed source does not hide healthy sources.                               |
| FR-02 | Honor source/project restrictions.    | Explicit filters are applied and responses identify sources searched, skipped, or failed.                                                                                                       |
| FR-03 | Sync on demand.                       | Initial indexing and subsequent refreshes use the same explicit operation, with no background scheduler required.                                                                               |
| FR-04 | Find sessions by metadata or content. | Titles need not appear in message text. Session identity remains unambiguous across agents and roots.                                                                                           |
| FR-05 | Retrieve bounded context.             | Limits apply to matches, surrounding messages, and output size. Pagination, truncation, and incomplete context are explicit.                                                                    |
| FR-06 | Prefer conversation text.             | Default recall favors user/assistant dialogue; relevant tool evidence can be requested without treating it as ordinary dialogue.                                                                |
| FR-07 | Attribute results.                    | Include source agent, session/message identity, provenance, and dates/titles where available. No invented links or metadata.                                                                    |
| FR-08 | Preserve source semantics.            | Supported updates, ordering, branches, rollbacks, and summaries are represented without duplicate or misleading dialogue. Unsupported cases are visible.                                        |
| FR-09 | Report failures predictably.          | Empty results, malformed records, incompatible schemas, blocked access, and partial success are distinguishable in machine-readable output. Exit-code details must be specified before release. |
| FR-10 | Provide reliable JSON.                | `--json` produces a documented, versioned output contract on stdout; diagnostics/progress use stderr. Results expose limits and freshness.                                                      |
| FR-11 | Make ingestion repeatable.            | Repeated sync does not duplicate records; failed ingestion does not advance its checkpoint past uncommitted data. Source-specific rewrites and partial writes have tests.                       |
| FR-12 | Keep host integrations thin.          | The same CLI works without a plugin. Integration tests verify retrieval guidance and attribution, not a second implementation of retrieval.                                                     |

## 8. Retrieval workflow

1. Identify the subject, requested sources, project, and desired level
   of detail.
2. Inspect relevant source/index availability and freshness; reuse
   that information within a task.
3. Sync explicitly when the index is absent or freshness matters,
   within granted permissions. Ordinary-query automatic refresh
   remains an open policy decision.
4. Search with small limits, using session metadata for named-session
   requests.
5. Inspect bounded surrounding messages, including later corrections
   when evaluating a decision or outcome.
6. Return evidence to the caller, which answers with attribution and
   relevant limitations.

Skills must treat retrieved content as historical data, never
instructions or present-day authorization. They should scale answers
to the request and distinguish recorded unfinished work from the
current repository's condition. An unrestricted SQL API is outside the
MVP.

## 9. Data handling and retention

- Source transcripts and agent-owned databases are read-only inputs.
  Do not trigger source migrations or delete, compact, or relocate
  existing archives.
- Omni Recall writes only its own local index/configuration. Keep
  private indexes and transcripts outside the distributable
  repository; public tests use synthetic or approved/redacted
  fixtures.
- Indexing and search do not require an Omni Recall hosted service.
  Package installation may require network access, and excerpts
  supplied to a remotely hosted model leave the machine under the
  calling product's policies.
- Return only relevant context. Do not promise automatic secret
  removal; transcripts and derived indexes may contain sensitive
  information. Skills must avoid reproducing credentials or unrelated
  private material.
- Configured source roots and index permissions must respect
  user/account boundaries. Missing mounts and blocked access are not
  evidence of intentional deletion.

### Unresolved: cache or durable archive

Two possible product behaviors remain under discussion:

| Choice            | Consequence                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebuildable cache | Search reflects retained source history. Confirmed source deletion eventually removes indexed content under a defined reconciliation policy.                                           |
| Durable archive   | Indexed content can survive source deletion. Users need explicit retention, purge, backup, and uninstall expectations; rebuilding from current sources may lose archived-only history. |

The existing `ocrecall` retains indexed history after source removal.
Gemini's current documentation describes automatic session cleanup
after 30 days. Neither behavior implicitly decides Omni Recall's
policy.

Resolve this before real-history retention/deletion behavior is
implemented or advertised. The initial synthetic-fixture experiment
does not need to choose a production default.

## 10. First-use experience

With a supported Node.js runtime and npm or pnpm available, invoke the
published package through `npx` or `pnpx`. The package manager
downloads/caches the package as needed; first use can require network
access and installation approval. Neither command eliminates
dependency requirements, filesystem permissions, or initial indexing.

Inspect accessible sources and run an explicit initial sync. Missing
agents do not require installing their executables if supported stored
history is already accessible. Explain initial indexing work and
report inaccessible or unsupported sources rather than silently
skipping them.

Optional skills/plugins make the CLI discoverable from a coding
assistant, but terminal use must work independently. Setup
documentation must state supported platforms and versions,
configurable history/index locations, refresh behavior, retention
policy, and what uninstalling does and does not remove.

## 11. Research evidence and support limits

### Local code review for this revision

| Project       | Checked-out package version | Relevant findings                                                                                                                                                                                                       |
| ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../pirecall` | 0.1.3                       | SQLite FTS5, parser and metadata-backfill tests, source-specific messages/tool results; public exports concern resumable sessions.                                                                                      |
| `../ocrecall` | 0.0.6                       | Complete-record streaming, file transactions, source replacement/checkpoints, rollback-aware recall, and optional read-only metadata enrichment. Supports paginated history only; legacy history is explicitly skipped. |
| `../ccrecall` | 0.0.15                      | Overlapping CLI/database mechanics with Claude-specific content/tool parsing and team support; no public library exports. Team analytics are not an Omni Recall MVP requirement.                                        |

Pi and Claude index text/thinking differently from Codex, and their
context ordering and output contracts differ. Code reuse requires
behavioral review, not simply copying one schema. These findings are
code inspection, not a new test run or performance benchmark.

### Upstream extension evidence

- [Goose storage documentation](https://github.com/block/goose/blob/618d41ee2e01032e6c2874b1da467259ac3229af/documentation/docs/guides/logs.md)
  and
  [session manager](https://github.com/block/goose/blob/618d41ee2e01032e6c2874b1da467259ac3229af/crates/goose/src/session/session_manager.rs):
  sessions/messages are stored in SQLite; legacy JSONL migration must
  be considered separately.
- [Gemini recording implementation](https://github.com/google-gemini/gemini-cli/blob/ed2ac40df67a319bf348bd7e3d10494696b31b38/packages/core/src/services/chatRecordingService.ts):
  writes JSONL, supports legacy JSON, updates repeated message IDs,
  and applies metadata/conversation checkpoints.
  [Session-management documentation](https://geminicli.com/docs/cli/session-management)
  describes retention and project-local history discovery.
- [cass](https://github.com/Dicklesworthstone/coding_agent_session_search)
  documents a multi-agent connector/normalized-index approach. It is a
  research reference, not a selected dependency or a locally
  benchmarked alternative.

These observations justify a source adapter rather than a universal
append-only JSONL parser. They do not establish released Omni Recall
support for Goose, Gemini, or every upstream format. Pin supported
versions and verify fixtures before claiming compatibility.

### Earlier exploration, carried forward from v0.1

The previous session reported an `ocrecall` 0.0.6 known-session
retrieval, a `pirecall` 0.1.3 import of 2,138 sessions with a
tool-result search match, and a `ccrecall` 0.0.3 import of seven
messages. These were not rerun for this revision; the older Claude
version is not the current checkout version. The Codex comparison
reused a known session ID, so it does not establish independent
discovery or a speed advantage.

The research above preceded implementation. A basic CLI scaffold now
provides help, version, and package information. No transcript
adapters, indexing, search, or host plugins are implemented; the
package has not been published.

## 12. Validation and release criteria

### Smallest implementation experiment — separate approval required

Use synthetic Pi and supported paginated Codex fixtures, with a
temporary Omni Recall index. Prove that two adapters feed one core and
that one bounded cross-source query returns correctly attributed
matches and surrounding context.

Acceptance criteria:

- One meaningful match from each source, with source-qualified
  identities and deterministic context order.
- Source/project restrictions, unsupported input, and partial source
  failure are visible and correct.
- Repeating sync produces no duplicate records; incomplete input and
  transaction failure do not lose committed progress or skip
  uncommitted records.
- Output is valid bounded JSON with explicit truncation and source
  status.
- Source fixtures remain unchanged, and sibling repositories/databases
  are untouched.

Do not scaffold every future adapter, publish packages, or change the
existing tools to prove this boundary.

### First-release gate

- Complete meaningful retrieval and adapter-contract tests for Pi,
  Claude Code, and explicitly supported Codex formats.
- Test title lookup, project filters, cross-source identity
  collisions, equal timestamps, named sessions, and paginated session
  reads.
- Test later corrections, tool-only matches, branches/rollbacks where
  supported, repeated-message updates, source replacement, partial
  writes, malformed records, and unsupported versions.
- Test missing history/indexes, blocked access, unavailable roots,
  empty results, partial success, and package-install failure
  handling.
- Decide and test retention/reconciliation policy, including the
  distinction between unavailable and deleted sources.
- Verify source-read-only behavior, private-data packaging exclusions,
  clean stdout JSON, documented exit codes, and bounded output on
  large sessions.
- Verify on-demand execution through both `pnpx` and `npx` in clean
  supported environments, plus any advertised host integration.
  Validate manifests only for integrations actually shipped.
- Verify that integration instructions treat retrieved content as
  data, not executable instructions or authorization.

Measure cold indexing separately from warm retrieval, including time
to useful evidence, command count, content volume, attribution
accuracy, and fixture retrieval success. Set numeric targets after
baselines; prior exploration is not a service-level commitment.

## 13. Roadmap

1. **Resolve product boundaries:** settle retention and the intended
   relationship to the sibling tools; refine the normalization
   contract through fixtures.
2. **Prove the shared engine:** separately approve and implement the
   small Pi/Codex experiment in section 12.
3. **Ship the focused CLI:** complete the three initial adapters,
   stable retrieval output, source diagnostics, setup docs, and
   verified thin integrations.
4. **Extend sources:** add Goose or Gemini with format/version
   fixtures, changing the core only when concrete evidence
   demonstrates a missing general capability.

Remote access remains a separately assessed future possibility, not a
prerequisite or committed release phase. It would require its own
authentication, pairing, revocation, source permissions, connectivity,
and data-handling design.

## 14. Distribution and positioning

“Pick up a previous decision without remembering which assistant you
used.”

Position Omni Recall as a focused, agent-friendly CLI with reliable
local evidence retrieval. A useful distribution advantage is on-demand
execution through Node.js package tooling commonly available in
coding-agent environments. This is not unique to TypeScript: a Rust
executable can also be distributed through an npm wrapper. Cross-agent
search already exists elsewhere; differentiation must come from
workflow and demonstrated behavior, not claims of novelty or
unmeasured speed.

Publish one user-facing package if release validation succeeds. Verify
executable/package-name availability, licensing and attribution for
reused code, supported runtime versions, and installation routes
before publication. Document version pinning for reproducible agent
use. Host-specific plugin packaging is optional distribution, not the
architecture.

## 15. Open decisions

- **Existing tools:** eventual successor or long-term companion?
  Initial work leaves them unchanged either way.
- **Retention:** cache or durable archive; defaults, source-deletion
  reconciliation, purge, backup, and uninstall behavior.
- **Compatibility:** supported source versions/formats, especially
  Codex legacy history and future Goose/Gemini variants.
- **Core contract:** normalized record/update API, branch/context
  semantics, provenance locators, and minimal retained metadata.
- **CLI contract:** JSON schema/versioning, session-read syntax,
  pagination, output budgets, partial-failure exit codes, and project
  matching rules.
- **Operations:** ordinary-query freshness policy, source-root
  configuration, index location, minimum Node.js/pnpm versions, and
  supported operating systems.
- **Release:** final package/executable names, licence, and which host
  integrations to verify first.

Approval of this PRD revision does not authorize code implementation,
migration, deprecation, publishing, or any retention default.
