---
name: change-repo-tooling
description: Use when changing OmniRecall tooling or dependencies.
---

# Change repository tooling

Read the root and affected package manifests, `pnpm-workspace.yaml`,
`tsconfig.json`, and relevant `vite.config.ts` before choosing
commands or introducing dependencies. Resolve these paths from the
repository root. The installed versions and active configuration take
precedence over commands remembered from another project.

## Make the change

- Write maintained Node tooling in `.ts`. This repository uses Node
  24; use its native TypeScript execution for compatible scripts. Keep
  the scripts within the TypeScript check. Do not introduce an extra
  runner merely to execute erasable TypeScript.
- Put dependency versions in the workspace catalog and reference them
  from the package that uses them. Determine runtime versus
  development placement from actual usage and packaging, including
  bundled code.
- Check the installed command's `--help` before using unfamiliar
  flags. A catalog workflow from another pnpm version is not evidence
  that a particular flag works here.
- Configure lint through the active Vite Plus configuration. A
  separate Oxlint config can be ignored when Vite Plus supplies its
  own config. Reuse the existing formatter, linter, and verification
  entry points.
- Keep the change proportional to the requested behaviour. Add a
  helper or dependency when it solves that requirement, rather than
  building a general framework around a single check.

## Prove the result

For a new check, exercise both a valid case and a deliberately invalid
case through the command developers actually run. Assert the intended
failure diagnostic as well as a nonzero exit, so an unrelated tool
failure cannot masquerade as enforcement. Remove temporary probes.

For example, an adapter import from production core code must fail
`pnpm check`; an allowed core import must pass. Cover relevant import
forms, such as re-exports and dynamic imports, when implementing a
boundary rule.

For packaging changes, exercise the installed tarball outside the
checkout. Checkout dependencies can hide missing runtime dependencies
or assets. Use the existing `pnpm test:package` smoke test where it
covers the change.

Finish implementation with `pnpm verify`. Report what changed, the
observed validation result, and any remaining limitation. Keep
internal investigation history out of the product README.
