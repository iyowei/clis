# Contributing to sweep-node-modules

**English** | [中文](CONTRIBUTING.zh-CN.md)

Thanks for taking the time to contribute. Bug reports, feature requests, documentation fixes, and pull requests are all welcome.

Everyone taking part in this project is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- Report a bug: open an issue with the bug report form.
- Request a feature: open an issue with the feature request form.
- Send a change: open a pull request. For anything beyond a small fix, open an issue first, so the approach can be settled before work starts.
- Report a security problem: do not open a public issue; follow [SECURITY.md](SECURITY.md).

Look for issues labeled `good first issue` to get started.

## Repository layout

The repository is a monorepo with two packages:

- `packages/sweep-node-modules-cli`: the `sweep-nm` CLI, published as `@iyowei/sweep-node-modules-cli`.
- `packages/sweep-node-modules`: the programmable API, published as `@iyowei/sweep-node-modules`.

turbo orchestrates the build, typecheck, and test tasks across both packages. The code treats bun and node as first-class runtimes (bun when available, node otherwise, identical behavior), runs on Windows, macOS, and Linux, and keeps zero third-party runtime dependencies.

## Development setup

Prerequisites: bun and node.

- bun is the development toolchain and package manager; the repository pins its version through `packageManager`.
- node, >= 22.18.0, is required as well. The test suite runs against both runtimes, and a runtime that is not installed is skipped silently, so a one-runtime setup leaves half of that suite unexercised.

```shell
# Install dependencies; in a clone this also installs the git hooks (lefthook)
bun install
```

The hooks check code on the way in (pre-commit: a project-wide type check, plus prettier and oxlint over the staged files) and re-run the full read-only checks before a push (pre-push: typecheck, tests, oxlint, formatting check). Where lefthook is not installed, the hook chain falls back to a pinned version fetched through bunx. Configuration: [lefthook.yml](lefthook.yml).

## Common commands

Run from the repository root:

```shell
# Type check (tsc --noEmit, through turbo)
bun run typecheck

# Lint (oxlint); `bun run lint:fix` applies the automatic fixes
bun run lint

# Format (prettier --write .)
bun run format

# Unit tests: contracts, robustness, dual-runtime e2e, and smoke tests
bun test

# Benchmarks
bun run bench

# Bundle the single-file CLI artifact and its manifest
bun run build
```

The [development guide](docs/development.md) covers the rest: the conformance suite, the release gate, and runtime details. Like the rest of the engineering docs, it is written in Chinese.

## Dual-runtime discipline

Behavior must be identical on bun and node; a change that works on only one of them is not done. Two things to know:

- `bun test` registers the e2e cases once per runtime, but only for runtimes installed on the machine; the missing side skips silently. Install both runtimes to actually cover both.
- The conformance suite checks the CLI output against byte-level golden samples, and the suite is not part of the local hooks. CI runs it against both runtimes; if a change touches the CLI output, run the suite locally against both targets too:

```shell
# Conformance on the bun runtime
bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"

# Conformance on the node runtime
bun run conformance -- --target "node packages/sweep-node-modules-cli/src/cli.ts"
```

To try the CLI itself while working on it, run it straight from source with either runtime:

```shell
# Run the CLI from source on bun
bun packages/sweep-node-modules-cli/src/cli.ts

# Run the same file on node
node packages/sweep-node-modules-cli/src/cli.ts
```

## Commits

- Use a Conventional Commits type prefix (`feat`, `fix`, `chore`, `test`, `refactor`,...) with a short description; the existing history writes descriptions in Chinese.
- Keep each commit to a single topic, and split unrelated changes into separate commits.
- No hook enforces the message format here; the lefthook hooks enforce typecheck, lint, and formatting.

## Pull requests

- Fill in the pull request template and keep the pull request focused on one topic.
- Link the issue it addresses; for larger changes, that issue is where the approach was discussed.
- CI runs the full check suite on every pull request: build, typecheck, tests, lint, and the formatting check on Ubuntu, plus the conformance suite on macOS against both bun and node.
- Do not bump versions or edit changelogs; releases are automated from `main` (semantic-release, behind a maintainer approval gate).

## Documentation

Engineering docs live under `docs/`; the index is [docs/README.md](docs/README.md). New documents must be registered in the index they belong to (the README under `adrs/`, `designs/`, or `protocol/`, or the top-level index for everything else); orphan documents are not accepted. If a change alters behavior or a documented contract, update the matching document in the same pull request.

## Questions

Open an issue, or mention @iyowei in an existing thread.
