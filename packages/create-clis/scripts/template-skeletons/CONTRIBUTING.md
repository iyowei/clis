# Contributing to {{NAME}}

**English** | [中文](CONTRIBUTING.zh-CN.md)

Thanks for taking the time to contribute. Bug reports, feature requests, documentation fixes, and pull requests are all welcome.

Everyone taking part in this project is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- Report a bug: open an issue with the bug report form.
- Request a feature: open an issue with the feature request form.
- Send a change: open a pull request. For anything beyond a small fix, open an issue first, so the approach can be settled before work starts.
- Report a security problem: do not open a public issue; follow [SECURITY.md](SECURITY.md).

<!-- 模板骨架: 示例包是占位实现; 换成自己的工具后, 同步下面「Repository layout」与两条命令示例。 -->

## Repository layout

The repository is a monorepo managed with turbo, and every tool lives under `packages/`:

- `packages/{{NAME}}-cli`: the `{{BIN_NAME}}` command-line tool, published as `{{SCOPE}}/{{NAME}}-cli`;
- `packages/{{NAME}}`: the programmable API package, published as `{{SCOPE}}/{{NAME}}`.

## Development setup

Prerequisites: bun and node.

- bun is the development toolchain and package manager; the repository pins its version through `packageManager`.
- node, >= 22.18.0, is required as well.
- `.nvmrc` pins the node major for version managers, and `.gitattributes` enforces LF line endings in the repository.

```shell
# Install dependencies; in a clone this also installs the git hooks (lefthook)
bun install
```

The hooks check code on the way in (pre-commit: a project-wide type check, plus prettier and oxlint over the staged files) and re-run the full checks before a push (pre-push runs `bun scripts/ci.ts`, the single source of the gate list). Where lefthook is not installed, the hook chain falls back to a pinned version fetched through bunx. Configuration: [lefthook.yml](lefthook.yml).

## Common commands

Run from the repository root:

```shell
# Type check (tsc --noEmit, through turbo)
bun run typecheck

# Lint (oxlint); `bun run lint:fix` applies the automatic fixes
bun run lint

# Format (prettier --write .)
bun run format

# Tests (through turbo; `bun test` runs the test runner directly)
bun run test

# Bundle the release artifacts of every package
bun run build

# Local CI rehearsal (the same gate list GitHub Actions runs)
bun run ci
```

The [development guide](docs/development.md) covers environment setup, the commit hooks, and the release chain.

## Commits

- Use a Conventional Commits type prefix (`feat`, `fix`, `chore`, `test`, `refactor`,...) with a short description.
- Keep each commit to a single topic, and split unrelated changes into separate commits.
- Breaking changes must carry both markers: the `!` after the type (`feat!: ...`) drives the version bump, and an English `BREAKING CHANGE: <description>` footer is what the release-notes generator recognizes. A `!` commit without a recognizable footer is dropped from the generated CHANGELOG entirely.

## Pull requests

- Fill in the pull request template and keep the pull request focused on one topic.
- Link the issue it addresses; for larger changes, that issue is where the approach was discussed.
- CI runs the full check suite on every pull request: build, typecheck, tests, lint, and the formatting check.
- Do not bump versions or edit changelogs; releases are automated from `main` (semantic-release, behind a maintainer approval gate).

## Documentation

Engineering docs live under `docs/`; the index is [docs/README.md](docs/README.md). New documents must be registered in the index they belong to (the README under `adrs/` or `designs/`, or the top-level index for everything else); orphan documents are not accepted. If a change alters behavior or a documented contract, update the matching document in the same pull request.

## Questions

Open an issue, or mention @{{OWNER}} in an existing thread.
