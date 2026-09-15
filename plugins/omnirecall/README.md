# OmniRecall plugin

Recover decisions, fixes, and commands from past Claude Code, Codex,
and Pi conversations in a local assistant task.

This plugin adds a recall skill around the published OmniRecall CLI.
The retrieval engine remains in the same repository under `apps/cli`
and `packages`; the plugin does not duplicate it or require an MCP
server. The plugin can be installed from its own directory without the
rest of the source checkout: its runtime dependency is the npm CLI.

## Requirements

- Node.js **24.11 or newer** and pnpm or npm.
- A host task with terminal access to the machine containing your
  coding-agent history, such as a local Codex task in the desktop app.
- Read access to the history and write access to OmniRecall's archive
  when syncing.
- Registry access for the initial CLI download unless the tested CLI
  version is already installed or cached.

Installing this skill does not add terminal or local-file access to a
ChatGPT chat that lacks those capabilities. It does not import ChatGPT
account conversations. Browser-only and remote execution require a
separate connection to the history and are outside this version's
scope.

## Install from a local checkout

From the repository root, register the marketplace and install:

```sh
codex plugin marketplace add .
codex plugin add omnirecall@personal
```

The repository marketplace is named `personal`. If another registered
marketplace uses that name, give this repository marketplace a unique
name before registration and use it after `@` in the install command.

Alternatively, after registering the marketplace, open **Plugins** in
the desktop app and install **OmniRecall** from it. Start a new local
task to load the skill.

Once these files have been published to GitHub, the repository can
also be registered with
`codex plugin marketplace add spences10/omnirecall`. That command uses
published files; use the local path to test uncommitted changes.

## Use

Ask naturally or invoke the bundled skill with `$recall` in Codex:

> Use OmniRecall to find where I asked about making a plugin.

> What did we decide about authentication in Claude Code last week?

> Find the command that fixed my earlier build failure.

The skill checks coverage, syncs when a refresh is needed, retrieves
bounded matches, and reads the original context before answering. A
partial sync is reported as incomplete coverage, not a failed search
with no history.

## Data handling

The CLI stores its archive on the user's machine. Sync imports source
records into that archive and may retain them after original session
files disappear. Retrieved excerpts are supplied to the current
assistant conversation. The plugin has no separate hosted backend,
account, or telemetry service; the host assistant's data handling
still applies to text it receives.

Use `OMNIRECALL_DB` or the CLI's `--db` option for a custom archive.
Keep the same archive selection throughout sync and retrieval.

## Development and release

Plugin version **0.1.0** is independent of the CLI release. The skill
pins the tested CLI to **0.0.4** for reproducible commands. When
changing that pin, verify the commands and output fields in the skill
against the new CLI version, then bump the plugin manifest version
too.

Run `pnpm verify` from the repository root. To exercise the plugin
itself, install from the local checkout and start a fresh local task:

1. Ask about a known earlier discussion. Check the returned source,
   date, and quotation against the original conversation.
2. Ask about a recent session requiring sync. Confirm the answer uses
   refreshed evidence and reports any partial sync.
3. Ask for a conversation that is not indexed. Confirm missing access
   or coverage is distinguished from a search with no matches.
4. Ask for a specific command from an older session. Confirm the skill
   reads tool evidence when conversation messages are insufficient.

Use synthetic history and an explicit scratch `--db` for automated
checks. Keep personal archives out of fixtures and plugin packages.

After changing plugin files, bump the manifest version and repeat the
local installation in a new task. For a Git marketplace, first run
`codex plugin marketplace upgrade personal` to fetch the published
changes.

This repository marketplace supports development and sharing. It does
not automatically publish or approve a listing in ChatGPT's public
directory. For submission, package **this directory** as the plugin
root, including `.codex-plugin/plugin.json`, `skills/`, `README.md`,
and `LICENSE`. Review the current
[plugin packaging](https://developers.openai.com/plugins/build/plugins)
and
[submission](https://developers.openai.com/plugins/deploy/submission)
requirements before uploading; public listing assets and review are
separate from this initial implementation.
