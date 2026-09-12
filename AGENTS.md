# Agent support

OmniRecall imports session history into SQLite for search and
retrieval. This is our support inventory, not a copy of another tool's
connector count.

Format research last checked: 12 September 2026. Storage can change
between agent versions. A researched format does not mean OmniRecall
supports it.

## Implemented

| Agent       | History read by OmniRecall                                       | Coverage                                                                                              |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Claude Code | JSONL under `~/.claude/projects`                                 | Transcripts and separate subagent files. Team/task JSON is not imported; branch state is unknown.     |
| Codex CLI   | JSONL under `~/.codex/sessions` and `~/.codex/archived_sessions` | Paginated histories, including completed text and realtime records. Legacy histories are unsupported. |
| Pi          | JSONL under `~/.pi/agent/sessions`                               | Version 3 session trees, including messages, tools and branch relationships.                          |

The implementation and tests define supported shapes:
[Claude adapter](packages/adapter-claude/src/index.ts),
[Codex adapter](packages/adapter-codex/src/index.ts),
[Pi adapter](packages/adapter-pi/src/index.ts). Unknown event types
can be retained without searchable text; malformed known records can
still prevent an import.

## Candidates with researched storage

These have no OmniRecall adapter yet. Formats below come from
[CASS's connector documentation](https://github.com/Dicklesworthstone/coding_agent_session_search#-universal-connectors)
and its linked connector implementations. Verify against the target
agent version and synthetic fixtures before implementing support.

| Agent                            | Reported history format                                                                                              | Import consideration                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode                         | SQLite `opencode.db`; older versions use separate session/message/part JSON files                                    | One session can span multiple files or database tables. [Connector](https://github.com/Dicklesworthstone/franken_agent_detection/blob/main/src/connectors/opencode.rs). |
| Antigravity CLI (`agy`)          | `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`, with conversation SQLite databases | Keep CLI and IDE stores distinct.                                                                                                                                       |
| Gemini CLI (historical sessions) | Chat JSON under `~/.gemini/tmp`                                                                                      | Retain as a separate format target from Antigravity CLI.                                                                                                                |
| OpenHands                        | Conversation directories with `base_state.json` and individual event JSON files                                      | Assemble metadata and ordered events.                                                                                                                                   |
| Cline                            | Task directories with `ui_messages.json`, `api_conversation_history.json` and metadata                               | UI and API histories can overlap. [Connector](https://github.com/Dicklesworthstone/franken_agent_detection/blob/main/src/connectors/cline.rs).                          |
| Goose                            | SQLite `sessions.db`; older per-session JSONL files                                                                  | Detect the storage generation.                                                                                                                                          |
| Aider                            | `.aider.chat.history.md` Markdown logs                                                                               | Extract conversation text without assuming JSON records.                                                                                                                |
| Crush                            | SQLite `crush.db`, including per-project locations                                                                   | Discover both global and project stores.                                                                                                                                |
| Qwen Code                        | `~/.qwen/tmp/*/chats/session-*.json`                                                                                 | Read chat JSON documents.                                                                                                                                               |
| Grok Build (`grok`)              | `updates.jsonl`, `summary.json` and a `chat_history.jsonl` fallback                                                  | Identify the authoritative stream and avoid importing fallback duplicates.                                                                                              |
| Copilot CLI                      | JSONL/JSON in `~/.copilot/session-state` and legacy locations                                                        | Keep CLI histories distinct from Copilot Chat editor storage.                                                                                                           |

Google announced the
[transition from Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).
That product transition does not make their historical storage formats
interchangeable.

## Candidates needing storage verification

These are real projects, but we have not established their session
storage contract or tested an importer. Do not label their formats
JSONL by assumption.

| Agent                    | Starting reference                                                                                                           | Still to establish                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| DeepSeek Harness (`dsh`) | [Official project](https://www.deepseek.com/harness/en/)                                                                     | Session persistence and the effect of configurable storage plugins.                               |
| CodeWhale                | [Project site](https://www.codewhale.ai/)                                                                                    | History location, format and record identities.                                                   |
| Continue (`cn`)          | [CLI documentation](https://docs.continue.dev/cli/quickstart)                                                                | CLI history persistence and its relationship to extension storage.                                |
| Reasonix                 | [Repository](https://github.com/hardylab/Reasonix)                                                                           | History location, format and update behaviour.                                                    |
| Kilo Code CLI            | [CLI documentation](https://kilo.ai/docs/code-with-ai/platforms/cli)                                                         | CLI history format and its relationship to editor histories.                                      |
| Cursor CLI               | [Cursor connector research](https://github.com/Dicklesworthstone/franken_agent_detection/blob/main/src/connectors/cursor.rs) | CASS's documented `state.vscdb` support covers editor storage; verify CLI persistence separately. |

## Adding an agent

Before marking an agent implemented:

- Verify its history locations, format versions, session identities
  and ordering.
- Determine how histories grow, change, or span multiple inputs.
- Add synthetic fixtures for import, repeat sync, session growth,
  malformed input and retrieval after source removal.
- Preserve original records and extract useful searchable content
  through an adapter. Keep source-specific parsing out of core storage
  and queries.
- Record supported versions and known gaps in this inventory.

See [archive design](docs/archive-design.md) for storage and sync
behaviour.
