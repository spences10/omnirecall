# omnirecall

An agent-agnostic conversation recall CLI, built with the same tooling
as [pirecall](https://github.com/spences10/pirecall).

**Early scaffold:** help, version, and package information work.
Transcript indexing, search, and agent adapters are not implemented.
No transcripts are read or indexed by this version.

## Try locally

Requires Node.js 24.11+ and pnpm 11.22.

```bash
pnpm install
pnpm build
pnpm start --help
pnpm start info --json
```

After publication, the equivalent commands are:

```bash
pnpx omnirecall --help
pnpx omnirecall info --json
npx omnirecall info --json
```

The package manager downloads/caches the package as needed. First use
may require network access and installation approval.

## Workspace

- `apps/cli`: the publishable `omnirecall` package, with tests
  colocated beside source files in `src/`.
- Root: shared TypeScript, Vite+, Vitest, and Changesets tooling.
- `packages/*`: reserved workspace pattern for future core/adapters;
  no empty packages or placeholder implementations yet.
- `omni-recall-prd.md`: proposed product architecture and open
  decisions.

## Development

```bash
pnpm dev          # Watch and rebuild the CLI
pnpm check        # Formatting, lint, and types
pnpm check:fix    # Apply supported automatic fixes
pnpm test         # Build, then test the executable
```

`pnpm test:watch` builds once before starting tests; run `pnpm dev` in
another terminal when changing CLI source during watch mode.

## Release

The workspace root is private. Only `apps/cli` is published; its
allowlist includes the built executable, with package metadata,
README, and MIT licence included by npm. Indexes and local transcripts
must never be packaged.

```bash
pnpm check
pnpm test
pnpm --filter omnirecall exec npm pack --dry-run
```

Before the first publication, confirm npm name availability,
repository URLs, account access, and the package contents. For
subsequent releases, run `pnpm changeset` and `pnpm run version`, then
review the version/changelog.

When ready to publish deliberately:

```bash
pnpm release
```

This runs checks/tests and `changeset publish`, which requires npm
publishing access. The package's `prepack` hook rebuilds its
executable. Do not run a version bump for the initial `0.0.1` just to
publish it.

## License

MIT — Scott Spence.
