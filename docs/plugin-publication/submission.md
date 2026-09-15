# OmniRecall public submission draft

Submission type: Skills only. Initial plugin version: 0.1.0.

## Listing

- Name: OmniRecall
- Short description: Recall past coding conversations across agents
- Category: Productivity
- Publisher: Scott Spence (select the matching verified identity)
- Website: https://github.com/spences10/omnirecall
- Support: https://github.com/spences10/omnirecall/issues
- Privacy policy: pending public document
- Terms: pending publisher decision; the software is MIT licensed
- Logo: pending
- Countries: pending publisher selection

Search local Claude Code, Codex, and Pi conversations for earlier
decisions, fixes, and commands. OmniRecall refreshes a local SQLite
archive, retrieves bounded matches, and reads their original context.
Requires a local task with terminal access, Node.js 24.11 or newer,
and permission to read coding-agent history and write the archive.
Retrieved excerpts enter the current assistant conversation. Does not
search ChatGPT account conversations or provide remote access to
files.

## Starter prompts

- Find where we discussed making a plugin.
- What did I decide about authentication last week?
- Find the command that fixed my earlier build failure.

## Reviewer setup

Use the supplied synthetic fixtures, never personal histories. These
fixtures contain invented dialogue; strings such as
`private-tool-output` are synthetic test markers.

With Node.js 24.11+ and pnpm, extract the reviewer bundle and run from
its root:

```sh
pnpx omnirecall@0.0.4 sync --pi-root ./fixtures/pi --codex-root ./fixtures/codex --db ./review.db --json
```

Run each prompt in a fresh local task with the plugin enabled. Supply
the absolute path to review.db in place of REVIEW_DB. For retrieval
cases, explicitly request no sync so the reviewer archive remains
isolated from personal history. No account or demo credentials needed.

## Five positive cases

1. Prompt: "Use OmniRecall with REVIEW_DB, without syncing. Find the
   café migrations discussion across agents." Expected: recall/search
   then read; evidence from both Codex and Pi, with agent, date,
   source references, and the text "Use café migrations safely".
   Preserve distinct source identities.
2. Prompt: "Use REVIEW_DB without syncing. What did I ask before the
   Pi migration advice?" Expected: find Pi evidence and read
   surrounding messages. Identify the user message "Prepare the
   database"; distinguish it from the assistant's migration
   suggestion.
3. Prompt: "Use REVIEW_DB without syncing. Find private-tool-output in
   the earlier execution evidence." Expected: broaden to tool results
   when necessary, read the match, and report the literal synthetic
   marker with its source context.
4. Prompt: "Use REVIEW_DB without syncing. Find the migration advice
   in /synthetic/project on 1 September 2026." Expected: filter by the
   exact project and date; return verified migration excerpts and
   source-qualified session references.
5. Prompt: "Refresh REVIEW_DB using only the supplied fixtures/pi and
   fixtures/codex roots, then find the migration advice." Expected:
   explicit-root sync, inspect status and coverage, then bounded
   recall and read. Repeat sync preserves retrievable evidence without
   duplicating messages. Do not discover personal roots.

## Three negative cases

1. Prompt: "Use REVIEW_DB without syncing. What did I decide about
   quantum gardening?" Expected: bounded searches find no relevant
   evidence; report no matches in the supplied archive, without
   inventing a decision or claiming the discussion never happened
   elsewhere.
2. Prompt: "Use OmniRecall to search my ChatGPT account chats."
   Expected: explain that this plugin imports local Claude Code,
   Codex, and Pi histories, not ChatGPT account chats. Do not imply
   that installing the plugin grants account-history access.
3. Scenario: use a task with no local terminal or source-file access.
   Prompt: "Sync my laptop's agent histories with OmniRecall."
   Expected: explain the missing local execution/access requirement;
   do not claim a sync succeeded or that no history exists.

## Release notes

Initial skills-only submission. Adds a recall workflow around
OmniRecall CLI 0.0.4 for local Claude Code, Codex, and Pi histories.
Supports coverage checks, explicit refresh, bounded search, context
reading, and partial-sync reporting. No hosted backend or MCP server.
Review requires a local execution environment and synthetic fixtures.

## Validation status

- Repository verification: 143 tests passed; package smoke test
  passed.
- Plugin manifest and skill structure validators passed.
- Publisher confirmed a successful installed-plugin recall in a fresh
  local task.
- The eight reviewer cases above are prepared evaluation cases, not a
  claim that all eight have been run through the assistant.
- Publisher identity, policy links, logo, availability, portal scan,
  and final attestations remain to be completed.
