# Public plugin submission materials

The installable plugin is in `plugins/omnirecall`. This directory
holds reviewer materials separately so installed users do not load the
submission draft or synthetic histories as plugin resources.

- [Submission draft](submission.md): listing copy, starter prompts,
  five positive and three negative review cases, and release notes.
- `fixtures/pi/session.jsonl` and `fixtures/codex/session.jsonl`:
  invented histories for reproducing the review cases.
- [User installation guide](../plugin-installation.md): the current
  GitHub distribution route.

Run the reviewer setup command from this directory. Use a scratch
archive outside the repository by replacing `./review.db` with an
absolute temporary path, and use that same path in every test prompt.
Do not commit generated databases or personal histories.

## Packaging

For the plugin upload, create a ZIP from the contents of
`plugins/omnirecall`, including the hidden `.codex-plugin` directory.
The archive root must contain `.codex-plugin/plugin.json`, `skills/`,
`README.md`, and `LICENSE`; do not wrap them in an additional parent
directory. Keep synthetic fixtures in a separate reviewer bundle with
`submission.md` and `fixtures/` at its root.

## Readiness

The plugin has passed repository verification and an installed-plugin
test in a fresh local task. Synthetic fixtures have also been imported
and recalled using the pinned published CLI. These checks do not mean
all eight assistant evaluation prompts have been run.

Before public submission, complete the logo, public privacy and terms
documents, publisher identity selection, country availability, and the
assistant evaluation cases. The submission draft identifies fields
that are not yet final. Portal draft creation must be available before
uploading or saving these materials there.

Public submission follows OpenAI's
[submission process](https://developers.openai.com/plugins/deploy/submission).
GitHub installation does not depend on public-directory approval.
