# Install the OmniRecall plugin

OmniRecall adds a recall skill for searching local Claude Code, Codex,
and Pi conversations. Install it from this GitHub marketplace in the
ChatGPT desktop app or Codex CLI. No source checkout is needed for the
GitHub installation.

## Requirements

- Node.js 24.11 or newer and pnpm or npm on the machine running the
  task.
- A local task with terminal access to your coding-agent histories.
- Permission to read those histories and write the local archive.
- Internet access for the initial plugin and CLI downloads.

The plugin does not search ChatGPT account chats. Installing it in a
remote chat does not expose the files on your laptop.

## Install in the desktop app

1. Open **Plugins**.
2. Select **Add → Add plugin marketplace**.
3. Enter these values:

   | Field        | Value                  |
   | ------------ | ---------------------- |
   | Source       | `spences10/omnirecall` |
   | Git ref      | `main`                 |
   | Sparse paths | Leave empty            |

4. Select **Add marketplace**. The repository's marketplace is named
   **Personal**.
5. Find **OmniRecall** and install it using its plus/install control.
6. Start a new local task and ask:

   > Use OmniRecall to find a previous discussion about this project.

Adding the marketplace makes the plugin available to browse.
Installing it makes the skill available to new tasks. If the app does
not show the marketplace after adding it, fully quit and reopen the
desktop app.

## Install with Codex CLI

```sh
codex plugin marketplace add spences10/omnirecall --ref main
codex plugin add omnirecall@personal
```

Start a new session, then ask naturally or invoke `$recall`.

## Update a GitHub installation

```sh
codex plugin marketplace upgrade personal
codex plugin add omnirecall@personal
```

Start a new task after reinstalling. The plugin pins its CLI version;
refreshing the marketplace does not independently upgrade that pin.

These commands apply to a marketplace registered from GitHub. A
marketplace registered from a local checkout reads that checkout;
update the checkout before reinstalling.

## Troubleshooting

- **Marketplace named personal already exists:** run
  `codex plugin marketplace list` and inspect its root. If it already
  points to this repository or its Git snapshot, use the existing
  entry. If it belongs to another catalog, keep that catalog and use
  the [direct CLI workflow](../README.md#run-commands-directly) while
  resolving the name conflict. Do not replace unrelated catalogs.
- **Installed but the skill is missing:** start a new local task;
  check the plugin is enabled in that environment.
- **No history found:** ask the skill to check source coverage. A
  missing archive or inaccessible source is different from a search
  with no matches.
- **Partial sync:** some histories may still be searchable. The skill
  should report the relevant gaps and use available evidence.
- **No terminal or local-file access:** use a local task on the
  machine holding the histories.

## Data handling and support

Sync imports records into a local SQLite archive, which can retain
them after the original files disappear. Retrieved excerpts enter the
current assistant conversation and are subject to the host's data
handling. OmniRecall has no separate hosted backend or account.

Report problems through
[GitHub issues](https://github.com/spences10/omnirecall/issues).
Include versions, command names, and redacted error output. Do not
upload your personal archive or raw conversation histories.

## Share with other users

Share this guide's GitHub URL. Each recipient adds the marketplace and
installs the plugin in their environment. This GitHub distribution is
separate from a listing in the universal public Plugins Directory.

See OpenAI's
[marketplace documentation](https://developers.openai.com/plugins/build/plugins)
and
[submission process](https://developers.openai.com/plugins/deploy/submission)
for the distinction between repository distribution and reviewed
public publishing.
