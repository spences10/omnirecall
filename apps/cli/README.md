# omnirecall

[![Verify](https://github.com/spences10/omnirecall/actions/workflows/verify.yml/badge.svg)](https://github.com/spences10/omnirecall/actions/workflows/verify.yml)
[![built with vite+](https://img.shields.io/badge/built%20with-Vite+-646CFF?logo=vite&logoColor=white)](https://viteplus.dev)
[![tested with vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest)](https://vitest.dev)

Find answers in your past coding conversations—even when they happened
in a different agent.

OmniRecall searches Pi, Codex, and Claude Code session histories in
one local archive. Recover a decision, find a command that worked, or
give your current assistant the context it needs to continue earlier
work.

![Example coding assistant conversation using OmniRecall to recover a fix from a previous Pi session](https://raw.githubusercontent.com/spences10/omnirecall/main/assets/omnirecall-package-preview.png)

- Search across agents without remembering which one you used.
- Read the conversation around a match and inspect original tool
  output.
- Keep imported history searchable after its source files disappear.
- Keep your archive on your machine; no account or hosted service
  needed.

## Use in your coding assistant

Ask directly in your current CLI conversation:

> Use pnpx omnirecall to find that session where we changed the
> database queries and fixed slow search. What did we change?

Or use `npx omnirecall` in the same request. Your assistant runs the
commands, searches earlier sessions, and reads the relevant context
without you leaving the conversation.

> Use npx omnirecall to find how we fixed the authentication bug last
> week, and use that context to help with this issue.

Requires Node.js 24.11 or newer.

## Run commands directly

```bash
pnpx omnirecall sync
pnpx omnirecall search "database migration"
pnpx omnirecall read '<ref from search>' --context 2
```

Run `sync` to pick up new conversations. Add `--json` for structured
results. Search defaults to conversation messages; use `--kind all` to
include tool activity. Each command's `--help` lists its options.

Supports Pi v3, Codex paginated histories, and Claude Code
transcripts, including separate subagent sessions. Claude team/task
files and legacy Codex histories are not currently supported.
