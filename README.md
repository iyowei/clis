# clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

**English** | [中文](README.zh-CN.md)

A collection of command-line tools for my day-to-day development, managed as a monorepo — plus the reusable packages they share. All packages live under `packages/`, each with docs starting from its own `README.md`.

## Packages

- **`create-clis`**: the collection's scaffolding generator, turning this repo's skeleton snapshot into a standalone clis collection repository with capability tiers, generic vocabulary, and a green CI out of the box; usage is documented in its [README](packages/create-clis/README.md).
- **`@iyowei/sweep-node-modules-cli`**: the `sweep-nm` command-line tool, a workspace-level cleaner that scans multiple root directories in one pass, lists every `node_modules` with its size, and bulk-deletes them after confirmation; installation, usage, configuration, and safety guardrails live in its [README](packages/sweep-node-modules-cli/README.md).
- **`@iyowei/sweep-node-modules`**: the programmable API package behind `sweep-nm`, for scanning, measuring, and safely removing `node_modules` from your own programs or scripts; usage is documented in its [README](packages/sweep-node-modules/README.md).
- **`@iyowei/codd`**: the `codd` command-line tool, a template-driven MongoDB 9.0 provisioning generator for Podman (Linux & macOS) and Kubernetes (Helm) that derives cache, connection, oplog, and compression settings from hardware specs to emit collision-free deployment bundles; installation and usage live in its [README](packages/codd/README.md).

## Documentation

- [Engineering documentation index](docs/README.md): the repository-level entry to governance and scaffolding design, ADRs, and development docs;
- [Development guide](docs/development.md): environment setup, common commands, dual-runtime verification, and commit hooks;
- [sweep-node-modules docs hub](docs/sweep/README.md): the tool's docs (product designs and the transcription conformance kit);
- [codd docs hub](docs/codd/README.md): the tool's docs (provisioning formulas, Podman & Kubernetes runbooks, and the visual board).
