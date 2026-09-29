# sweep-node-modules

[![CI](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/sweep-node-modules/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/release.yml)

**English** | [中文](README.zh-CN.md)

A workspace-level cleaner for `node_modules`: scan several root directories in one pass, list every `node_modules` directory across your projects along with its size, and bulk-delete them after you confirm, reclaiming disk space.

> Where this sits: single-project cleaners handle "go into one project and clean its own artifacts"; this tool handles "stand at the workspace level and clean many projects in one pass". The two layers coexist; see [ADR 0001](docs/adrs/0001-workspace-level-cleaner.md).

## Packages

The tool ships as two packages:

- **`@iyowei/sweep-node-modules-cli`**: the `sweep-nm` command-line tool; installation, usage, configuration, and the safety guardrails live in its [README](packages/sweep-node-modules-cli/README.md).
- **`@iyowei/sweep-node-modules`**: the API package, for use in your own programs or scripts; usage is documented in its [README](packages/sweep-node-modules/README.md).

## Documentation

- [Engineering documentation index](docs/README.md): decisions, designs, protocol, and development docs.
- [Development guide](docs/development.md): environment setup, common commands, dual-runtime verification, and commit hooks.
