# @iyowei/codd-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/codd-cli)](https://www.npmjs.com/package/@iyowei/codd-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/codd-cli)](https://www.npmjs.com/package/@iyowei/codd-cli)
![node](https://img.shields.io/node/v/@iyowei/codd-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Template-driven MongoDB 9.0 provisioning CLI (`codd`) for Podman (Linux & macOS) and Kubernetes (Helm): derive WiredTiger cache, connection limits, oplog sizing, zstd/snappy compression, and `ulimit` guards deterministically from server hardware specs, and emit self-contained, 100% collision-free deployment bundles.

This package is a thin CLI shell (argument parser, interactive 4-step terminal wizard, and Hig-style terminal UI) over the programmable API package [`@iyowei/codd`](https://www.npmjs.com/package/@iyowei/codd). For programmatic use in scripts or pipelines, import `@iyowei/codd` directly.

## Requirements

- **Dual runtime**: Bun preferred, Node.js fallback (`>= 22.18.0`, matching `engines.node`).
- Zero third-party runtime dependencies (built-in runtime APIs only; template assets are bundled inside `assets/template/`).
- Runs on macOS, Linux, and Windows (standalone launcher scripts with cwd-hijack protection and artifact SHA-256 self-verification).

## Installation

### 1. Zero install (quick trial)

```shell
# with bun
bunx @iyowei/codd-cli

# with node
npx @iyowei/codd-cli
```

### 2. Global install (recommended)

```shell
npm install -g @iyowei/codd-cli
bun install -g @iyowei/codd-cli
```

### 3. From source (development or bun-only without node)

**macOS / Linux**:

```shell
cd "<your clone>/clis"
bun install && bun run build
chmod +x packages/codd-cli/bin/codd packages/codd-cli/bin/codd.mjs
ln -sf "$PWD/packages/codd-cli/bin/codd" ~/.local/bin/codd
```

Or define a shell alias pointing to the launcher:

```shell
alias codd="/path/to/clis/packages/codd-cli/bin/codd"
```

**Windows** (PowerShell):

```powershell
# Add packages\codd-cli\bin to user PATH (after running `bun install && bun run build`)
$bin = "$env:USERPROFILE\tools\clis\packages\codd-cli\bin"
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

## Usage

```shell
# launch the interactive 4-step terminal wizard
codd wizard

# export deploy.schema.json, deploy-2c2g.json, and a safe .gitignore into the current directory
codd init

# generate from ./deploy.json or any specified JSON manifest
codd
codd deploy-prod.json
codd -c deploy-prod.json -o ./release-bundles

# validate manifest and preview sizing formulas without writing files
codd deploy-prod.json --dry-run

# rotate app & backup passwords while keeping FINGERPRINT, root, and keyFile unchanged
codd deploy-prod.json --rotate

# stop option parsing with -- for manifest paths starting with '-'
codd -- -staging.json

# self-update (automatically detects bun / npm / pnpm / yarn / volta)
codd update --check
codd update
```

## Commands and flags

| Command / Flag                   | Description                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `codd wizard` / `-i`, `--wizard` | Launch the interactive 4-step configuration wizard                                                                                     |
| `codd init` / `--init-schema`    | Export `deploy.schema.json`, `deploy-2c2g.json`, and safe `.gitignore` into the current directory                                      |
| `codd lang [system\|en\|zh]`     | Show or save display language preference (`~/.config/codd/lang.json` / `%APPDATA%\codd\lang.json`; defaults to `system`)               |
| `codd update`                    | Self-update via the active package manager (`--check`, `--pm`, `--registry`, `--force`, `--verbose`)                                   |
| `codd [manifest.json]`           | Generate deployment bundle(s) from the specified JSON manifest (defaults to `./deploy.json`)                                           |
| `-c`, `--config <path>`          | Explicit path to the JSON manifest file                                                                                                |
| `-o`, `--out <dir>`              | Output directory for generated deployment bundles (defaults to `./dist`)                                                               |
| `--rotate`                       | Rotate app & backup passwords while keeping `FINGERPRINT`, `root`, and `keyFile` unchanged                                             |
| `--rotate-all`                   | Rotate all credentials including `root` and `keyFile` (fresh deployments only)                                                         |
| `--new-fingerprint`              | Generate a brand-new 12-hex instance fingerprint for side-by-side deployment                                                           |
| `--dry-run`                      | Validate manifest and preview computed sizing formulas without writing any files (in wizard mode, also skips saving the manifest file) |
| `--lang <system\|en\|zh>`        | Override CLI display language for the current invocation (also supports `CODD_LANG` / `CLIS_LANG`)                                     |
| `--`                             | End of flags; treat the following argument as a literal manifest path                                                                  |
| `-V`, `-v`, `--version`          | Print the installed CLI version                                                                                                        |
| `-h`, `--help`                   | Show usage help                                                                                                                        |

## Exit codes

- `0`: Completed successfully (including `--help`, `--version`, `init`, `--dry-run`, and `update` when up-to-date, `--check`, or upgraded).
- `1`: Argument error, manifest validation error, `update` failure, corrupted state file, or I/O error.
- `130`: Interactive wizard cancelled by the user (`Ctrl+C` or closed stdin).

## Environment variables

- `CODD_THEME`: Set `light` or `dark` to explicitly select the terminal color theme (falls back to `COLORFGBG`, defaulting to `dark`).
- `NO_COLOR` / `TERM=dumb`: Disable ANSI color escape sequences (`stdout` and `stderr` also independently fall back to plain text when redirected to non-TTY streams).
- `CODD_TEMPLATE_DIR`: Optional directory overriding the bundled `assets/template/` root.
- `NPM_CONFIG_REGISTRY`: Custom npm registry URL used by `codd update` when `--registry` is not passed.

## Generated artifacts

- **`./dist/<prefix>-<name>-<fingerprint>/`**: Self-contained runtime bundle ready to `rsync` to your target Linux/macOS server or apply to Kubernetes (embedded `chart/`).
- **`./.codd-state/`**: Mode `0700` local state directory (auto-protected with an internal `.gitignore`) locking your instance fingerprint, passwords, and ready-to-use MongoDB connection URIs (`*.credentials.txt`).

## Development

Environment setup, common commands, dual-runtime verification, and commit hooks: see the [development guide](https://github.com/iyowei/clis/blob/main/docs/development.md).

## Documentation

- [CLI surface & contract](https://github.com/iyowei/clis/blob/main/packages/codd-cli/docs/designs/cli-surface.md)
- [Engineering documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [codd product docs hub](https://github.com/iyowei/clis/blob/main/packages/codd/docs/README.md)
- [Programmable API package (`@iyowei/codd`)](https://github.com/iyowei/clis/tree/main/packages/codd)
