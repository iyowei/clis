# sweep-node-modules

[![CI](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/sweep-node-modules/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/release.yml)

**English** | [中文](README.zh-CN.md)

A workspace-level cleaner for `node_modules`: scan several root directories in one pass, list every `node_modules` directory across your projects along with its size, and bulk-delete them after you confirm, reclaiming disk space.

## Packages

The tool ships as two packages:

- **`@iyowei/sweep-node-modules-cli`**: the `sweep-nm` command-line tool; installation, usage, configuration, and the safety guardrails live in its [README](packages/sweep-node-modules-cli/README.md).
- **`@iyowei/sweep-node-modules`**: the API package, for use in your own programs or scripts; usage is documented in its [README](packages/sweep-node-modules/README.md).

## Documentation

- [Engineering documentation index](docs/README.md): decisions, designs, protocol, and development docs.
- [Development guide](docs/development.md): environment setup, common commands, dual-runtime verification, and commit hooks.
