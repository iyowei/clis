# {{NAME}}

[![CI]({{REPO_URL}}/actions/workflows/ci.yml/badge.svg)]({{REPO_URL}}/actions/workflows/ci.yml)
[![Release]({{REPO_URL}}/actions/workflows/release.yml/badge.svg)]({{REPO_URL}}/actions/workflows/release.yml)

**English** | [中文](README.zh-CN.md)

<!-- 模板骨架: 用一句话说清这个集合仓是什么、装有哪些工具; 落地时替换本节与「Packages」。 -->

A collection of command-line tools, managed as a monorepo: every tool lives under `packages/`, each with docs starting from its own `README.md`.

## Packages

<!-- 模板骨架: 示例包 {{NAME}} 与 {{NAME}}-cli 是占位实现 (一个 greet 示例), 替换为自己的工具后同步本节。 -->

- **`{{SCOPE}}/{{NAME}}-cli`**: the `{{BIN_NAME}}` command-line tool; installation, usage, and configuration live in its [README](packages/{{NAME}}-cli/README.md).
- **`{{SCOPE}}/{{NAME}}`**: the API package, for use in your own programs or scripts; usage is documented in its [README](packages/{{NAME}}/README.md).

## Documentation

- [Engineering documentation index](docs/README.md): the repository-level entry to design docs, ADRs, and development docs;
- [Development guide](docs/development.md): environment setup, common commands, and commit hooks.
