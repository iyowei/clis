# @iyowei/fan-cli

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/fan-cli)](https://www.npmjs.com/package/@iyowei/fan-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/fan-cli)](https://www.npmjs.com/package/@iyowei/fan-cli)
![node](https://img.shields.io/node/v/%40iyowei%2Ffan-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Command-line tool (`fan`) to inspect and manually control Apple Silicon / Mac fan speeds via AppleSMC IOKit with zero third-party runtime dependencies. **No need to install Macs Fan Control or any GUI fan utility**; just run `fan max` or `fan set 4000` to change system fan speeds directly. Changes persist automatically across reboots and sleep/wake cycles once the built-in `LaunchDaemon` is installed (pass `--once` for temporary overrides).

This CLI is a thin parsing and rendering shell over [`@iyowei/fan`](https://www.npmjs.com/package/@iyowei/fan). For programmatic use in scripts or automation pipelines, import `@iyowei/fan` directly.

## Requirements

- **Dual runtime**: Bun preferred, Node.js fallback (`>= 22.18.0`).
- **Host platform**: macOS with AppleSMC (`IOKit`) and `/usr/bin/python3`; write subcommands (`set`, `max`, `min`, `auto`, `apply`) and daemon install/uninstall invoke `/usr/bin/sudo` when not already root (`status` and `persist status` are read-only without `sudo`).
- **Zero third-party runtime dependencies**.

## Installation

### 1. Zero install (quick trial)

```shell
# with bun
bunx @iyowei/fan-cli

# with node
npx @iyowei/fan-cli
```

### 2. Global install (recommended)

```shell
npm install -g @iyowei/fan-cli
bun install -g @iyowei/fan-cli

# Optional (recommended): install the boot & sleep/wake restore LaunchDaemon
fan persist install
```

### 3. From source (development or bun-only without node)

```shell
cd "<your clone>/clis"
bun install && bun run build

chmod +x packages/fan-cli/bin/fan packages/fan-cli/bin/fan.mjs
ln -sf "$PWD/packages/fan-cli/bin/fan" ~/.local/bin/fan
```

## Usage

```shell
# Show current speed, target RPM, allowed range, and mode for all fans
fan
fan status

# Poll live speeds every 1 second (Ctrl+C to exit)
fan status -w 1

# Emit structured JSON
fan status --json

# Set and remember targets across reboots/wakes (default behavior)
fan set 4000
fan set 60%
fan set --fan 0 60%
fan max
fan min
fan auto

# Temporary override without modifying the saved configuration
fan set 50% --once
fan max --no-save

# Re-apply saved configuration immediately, or manage the persistence daemon
fan apply
fan persist status
fan persist install
fan persist uninstall

# Print version / help, or check self-update
fan --version
fan --help
fan update --check
```

> **Tip**: No third-party fan app (such as `Macs Fan Control`) is required. While awake, `fan`'s `LaunchDaemon` does not poll or fight manual `--once` overrides; it only restores `state.json` on system boot (`RunAtLoad`) and sleep wake (`kIOMessageSystemHasPoweredOn`). If you previously installed a GUI fan controller and left it running in the background with a fixed preset, quit it first so it does not overwrite `fan` CLI targets.

## Exit codes

- `0`: success (`status`, `set`, `max`, `min`, `auto`, `apply`, `persist`, `update`, `--version`, `--help`).
- `1`: failure (invalid arguments, unsupported platform, SMC/daemon failure, or `sudo` permission denied).

## Development & Documentation

- [Development guide](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [CLI package docs & surface contract](https://github.com/iyowei/clis/blob/main/packages/fan-cli/docs/README.md)
- [Core API package (`@iyowei/fan`)](https://github.com/iyowei/clis/blob/main/packages/fan/README.md)
- [Repository documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
