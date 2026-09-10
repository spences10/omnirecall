# omnirecall

Agent-agnostic conversation recall CLI — **early scaffold**.

This version provides help, version, and package information only.
Transcript indexing, search, and agent adapters are not implemented.
It does not read transcripts or create an index.

Requires Node.js 24.11+.

```bash
pnpx omnirecall --help
pnpx omnirecall --version
pnpx omnirecall info --json

# npm alternative
npx omnirecall info --json
```

`info --json` reports `status: "scaffold"` and an empty `capabilities`
array. Package managers may need network access and installation
approval on first use.

Source and development instructions:
https://github.com/spences10/omnirecall

## License

MIT — Scott Spence.
