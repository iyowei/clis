# @iyowei/wake-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
![node](https://img.shields.io/node/v/%40iyowei%2Fwake-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Cross-platform CLI (`wake`) to power on LAN and cross-subnet hosts via Wake-on-LAN magic packets and ordered SSH relay failover, with readiness polling, interactive ARP-assisted setup (`wake init`), and read-only diagnostics (`wake doctor`). Zero third-party runtime dependencies.

This CLI is a thin parsing and rendering shell over [`@iyowei/wake`](https://www.npmjs.com/package/@iyowei/wake). For programmatic integration, import `@iyowei/wake` directly.

## Requirements

- **Dual runtime**: Bun preferred, Node.js fallback (`>= 22.18.0`).
- **Zero third-party runtime dependencies**.
- **SSH relays (optional)**: relay hosts require key-based SSH (`BatchMode=yes`) and `wake` installed in their login `PATH`.

## Installation

### 1. One-click script (macOS / Linux / Windows, no Node / Bun prerequisite)

Detects existing `bun` or `node >= 22.18.0`; falls back to an isolated private Bun runtime under `~/.local/share/clis/runtime`. Supports `--installer-url`, `--bun-url`, `--registry`, `--from-tarball`, or `WAKE_*` environment variables:

```shell
# macOS / Linux (curl)
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh

# Custom mirrors (e.g. mainland China)
curl \
  -fsSL \
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh \
    -s -- \
    --installer-url \
      https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
    --bun-url \
      https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download \
    --registry \
      https://registry.npmmirror.com
```

### 2. Global install

```shell
npm install -g @iyowei/wake-cli
bun install -g @iyowei/wake-cli
```

### 3. Zero install

```shell
bunx @iyowei/wake-cli --help
npx @iyowei/wake-cli --help
```

## Usage

```shell
# Configure a target interactively (discovers LAN ARP neighbors)
wake init

# Or save non-interactively
wake init --name workstation --mac 00:11:22:33:44:55 --host 192.0.2.10 --relay bastion-a --default --yes

# List saved targets and inspect environment without waking anything
wake list
wake doctor

# Wake default target or a named alias, waiting for TCP readiness
wake
wake workstation

# Ad-hoc wake by MAC without a config file, or exit immediately via --no-wait
wake --mac 00:11:22:33:44:55 --host 192.0.2.10 --no-wait

# Switch language or check for CLI updates
wake lang en
wake update --check
```

## Documentation

- [Engineering documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [wake-cli docs & CLI surface contract](https://github.com/iyowei/clis/blob/main/packages/wake-cli/docs/README.md)
- [Core API package (`@iyowei/wake`)](https://github.com/iyowei/clis/blob/main/packages/wake/README.md)
