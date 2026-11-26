# @iyowei/fan-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/fan-cli)](https://www.npmjs.com/package/@iyowei/fan-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/fan-cli)](https://www.npmjs.com/package/@iyowei/fan-cli)
![node](https://img.shields.io/node/v/%40iyowei%2Ffan-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Command-line tool (`fan`) to inspect and manually control Apple Silicon / Mac fan speeds via AppleSMC IOKit with zero third-party runtime dependencies. **No need to install Macs Fan Control or any GUI fan utility**; just run `fan max` or `fan set 4000` to change system fan speeds directly. Manual speed commands automatically ensure the built-in `LaunchDaemon` is active so fans return to system `auto` (stop spinning) when closing the lid without an external display or entering sleep, and automatically restore your saved speeds on lid open / wake and reboot (pass `--once` for temporary overrides).

This CLI is a thin parsing and rendering shell over [`@iyowei/fan`](https://www.npmjs.com/package/@iyowei/fan). For programmatic use in scripts or automation pipelines, import `@iyowei/fan` directly.

## Requirements

- **Dual runtime**: Bun preferred, Node.js fallback (`>= 22.18.0`).
- **Host platform**: macOS with AppleSMC (`IOKit`) and `/usr/bin/python3`; write subcommands (`set`, `max`, `min`, `auto`, `apply`) and daemon install/uninstall invoke `/usr/bin/sudo` when not already root (`status` and `persist status` are read-only without `sudo`).
- **Zero third-party runtime dependencies**.

## Installation

### 1. One-click script (macOS, no Node / Bun prerequisite)

Detects existing `bun` or `node >= 22.18.0` automatically; falls back to an isolated private Bun runtime under `~/.local/share/clis/runtime`:

```shell
curl -fsSL https://raw.githubusercontent.com/iyowei/clis/main/packages/fan-cli/install.sh | sh
# or with wget
wget -qO- https://raw.githubusercontent.com/iyowei/clis/main/packages/fan-cli/install.sh | sh
# with custom remote URLs (--installer-url / --bun-url / --registry / --from-tarball, or FAN_* env vars):
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/fan-cli/install.sh | \
  sh -s -- \
  --installer-url https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
  --bun-url https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download \
  --registry https://registry.npmmirror.com
```

### 2. Zero install (quick trial)

```shell
# with bun
bunx @iyowei/fan-cli

# with node
npx @iyowei/fan-cli
```

### 3. Global install (recommended)

```shell
npm install -g @iyowei/fan-cli
bun install -g @iyowei/fan-cli

# Optional (recommended): install the boot & sleep/wake restore LaunchDaemon
fan persist install
```

### 4. From source (development or bun-only without node)

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

# Switch display language (defaults to `system`, following macOS preferred language)
fan lang
fan lang en
fan lang zh
fan lang system
fan status --lang en

# Print version / help, or check self-update
fan --version
fan --help
fan update --check
```

> **Language**: `fan` automatically detects your macOS system UI language (`system` by default) and supports independent per-tool customization via `fan lang <system|en|zh>` (`~/.config/fan/lang.json`), per-run `--lang <system|en|zh>`, or `FAN_LANG` / `CLIS_LANG`.

> **Tip**: No third-party fan app (such as `Macs Fan Control`) is required. Running `fan set` / `fan max` / `fan min` automatically keeps the `com.iyowei.fan` `LaunchDaemon` installed and synced: it releases manual fans to `auto` on non-docked lid close, sleep, and `DarkWake` (preserving manual speeds in docked external-display clamshell mode), restores `state.json` on boot and full wake / lid open, and never polls or fights `--once` overrides while awake. If you previously installed a GUI fan controller and left it running in the background with a fixed preset, quit it first so it does not overwrite `fan` CLI targets.

## Exit codes

- `0`: success (`status`, `set`, `max`, `min`, `auto`, `apply`, `persist`, `lang`, `update`, `--version`, `--help`).
- `1`: failure (invalid arguments, unsupported platform, SMC/daemon failure, or `sudo` permission denied).

## Development & Documentation

- [Development guide](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [CLI package docs & surface contract](https://github.com/iyowei/clis/blob/main/packages/fan-cli/docs/README.md)
- [Core API package (`@iyowei/fan`)](https://github.com/iyowei/clis/blob/main/packages/fan/README.md)
- [Repository documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
