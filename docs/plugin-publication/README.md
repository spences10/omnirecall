# Public plugin submission materials

The installable plugin is in `plugins/omnirecall`. This directory
holds reviewer materials separately so installed users do not load the
submission draft or synthetic histories as plugin resources.

- [Submission draft](submission.md): listing copy, starter prompts,
  five positive and three negative optional evaluation cases, and
  release notes.
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
`README.md`, `assets/`, and `LICENSE`; do not wrap them in an
additional parent directory. Keep synthetic fixtures in a separate
reviewer bundle with `submission.md` and `fixtures/` at its root.

## Readiness

The plugin has passed repository verification and an installed-plugin
test in a fresh local task. Synthetic fixtures have also been imported
and recalled using the pinned published CLI. These checks do not mean
all eight assistant evaluation prompts have been run.

The package includes a square SVG logo and composer icon. Before
public submission, select the verified publisher identity and country
availability, then resolve required portal validation issues. Privacy
and terms URLs are not required by skills-only metadata validation;
MCP review test cases and a demo recording are also not required for
this skills-only plugin. The optional assistant evaluations remain
useful quality checks and have not all been run.

Create the upload ZIP from the repository root:

```sh
(cd plugins/omnirecall && zip -r /tmp/omnirecall-0.2.1.zip .codex-plugin skills README.md LICENSE assets)
```

Open https://platform.openai.com/plugins, select the owning
organization/project, choose **Upload new or existing plugin**, select
your verified developer identity, and upload the ZIP. Check **Metadata
& Skills** and use **Copy issues** for findings. Resolve required
issues before submitting for review. After approval, select **Publish
plugin** to make the listing public. Uploading a draft does not
publish it. Keep the optional evaluation bundle separate from the
plugin ZIP.

Public submission follows OpenAI's
[submission process](https://developers.openai.com/plugins/deploy/submission).
GitHub installation does not depend on public-directory approval.
