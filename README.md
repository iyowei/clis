# clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

**English** | [中文](README.zh-CN.md)

A collection of command-line tools for my day-to-day development, managed as a monorepo — plus the reusable packages they share. All packages live under `packages/`, each with docs starting from its own `README.md`.

## Packages

**sweep-node-modules** — a workspace-level cleaner for `node_modules`: scan several root directories in one pass, list every `node_modules` directory across your projects along with its size, and bulk-delete them after you confirm, reclaiming disk space. It ships as two packages:

- **`@iyowei/sweep-node-modules-cli`**: the `sweep-nm` command-line tool; installation, usage, configuration, and the safety guardrails live in its [README](packages/sweep-node-modules-cli/README.md).
- **`@iyowei/sweep-node-modules`**: the API package, for use in your own programs or scripts; usage is documented in its [README](packages/sweep-node-modules/README.md).

**create-clis** — the collection's scaffolding generator: turn this repo's skeleton snapshot into a standalone clis collection repository of your own, with capability tiers, generic vocabulary, and a green CI out of the box; usage is documented in its [README](packages/create-clis/README.md).

## Documentation

- [Engineering documentation index](docs/README.md): the repository-level entry to governance and scaffolding design, ADRs, and development docs;
- [Development guide](docs/development.md): environment setup, common commands, dual-runtime verification, and commit hooks;
- [sweep-node-modules docs hub](docs/sweep/README.md): the tool's docs (product designs and the transcription conformance kit).
