# @iyowei/sweep-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
![private](https://img.shields.io/badge/npm-private%20workspace%20package-lightgrey)
![node](https://img.shields.io/badge/node-%3E%3D22.18.0-339933)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

A general-purpose, workspace-level multi-toolchain cleaner (`sweep`): scan multiple roots in one pass for Node.js, Rust, Python, Java, C/C++ build artifacts and caches, OS junk files, and your own custom rules; preview first with sizes, then safely move to trash or delete in bulk.

> **Private workspace package**: `@iyowei/sweep-cli` and its core library [`@iyowei/sweep`](https://github.com/iyowei/clis/blob/main/packages/sweep/README.md) are currently marked `"private": true` while evolving inside this monorepo and are excluded from the public npm release pipeline (see [ADR 0021](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md)). Install and run from a source checkout below.

The CLI is a thin interactive and rendering shell over `@iyowei/sweep`. For programmatic use inside scripts, editors, or automation pipelines, import `@iyowei/sweep` directly.

## Requirements

- **Dual runtime**: Bun when available, Node.js (`>= 22.18.0`) otherwise (identical behavior; Bun starts faster; see [ADR 0006](https://github.com/iyowei/clis/blob/main/docs/adrs/0006-dual-runtime-bun-first.md)).
- **Zero third-party runtime dependencies**: built-in `node:` / `bun:` modules only, including cross-platform trash channels (see [ADR 0003](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0003-zero-runtime-deps.md) and [ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md)).
- **Cross-platform**: macOS, Linux, and Windows (see [ADR 0007](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0007-platform-portability.md)). Note: macOS trash and Linux pure-TypeScript XDG Trash logic are verified locally; Windows Recycle Bin PowerShell execution and real Linux desktop integration are verified via stub/logic tests and have not yet been executed on target host machines.

## Setup from source

Because `@iyowei/sweep-cli` is currently a private workspace package (`"private": true`), run it directly from a clone of the repository:

**macOS / Linux**:

```shell
cd "<your clone>/clis"
bun install && bun run build

chmod +x packages/sweep-cli/bin/sweep
ln -sf "$PWD/packages/sweep-cli/bin/sweep" ~/.local/bin/sweep
```

**Windows** (PowerShell):

```powershell
# Build once with bun, then add the package bin directory to user PATH
$bin = "$env:USERPROFILE\tools\clis\packages\sweep-cli\bin"
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

- **Bun or Node**: the source launcher (`bin/sweep` / `bin/sweep.cmd`) automatically picks Bun when available and falls back to Node.js (`>= 22.18.0`) using built artifacts (`bun install && bun run build`).

> **One-click script installer**: Once `@iyowei/sweep-cli` is published (or via `--registry` / `SWEEP_REGISTRY` / `--from-tarball <path|url>`), `packages/sweep-cli/install.sh` (macOS / Linux) and `packages/sweep-cli/install.ps1` (Windows) detect `bun` / `node >= 22.18.0` or install an isolated private Bun automatically:
>
> ```shell
> # From a local tarball before public npm release
> ./packages/sweep-cli/install.sh --from-tarball ./sweep-cli.tgz
> # PowerShell: .\packages\sweep-cli\install.ps1 -FromTarball .\sweep-cli.tgz
> ```

## Usage

```shell
# Preview: scan configured roots, list targets with sizes and actions; nothing is touched
sweep

# Execute cleanup after reviewing the preview (moves to trash or deletes per config)
sweep --yes

# Also include suspected install trees in the batch (skipped by default; never relaxes safety guards)
sweep --yes --force

# Add ad-hoc exclusions by directory name (repeatable, merged with config)
sweep --exclude my-kits --exclude archive

# Clean only paths matching the whitelist (repeatable, merged with config)
sweep --include my-workspace

# Interactive setup wizard to create a v2 config
sweep init

# Write a complete best-practice v2 config non-interactively (all 6 presets + default guardrails)
sweep init --default

# Losslessly migrate a v1 config (auto-backs up before writing)
sweep migrate

# Show the config source, resolved path, and file status actually in effect
sweep config

# Override config file path (takes precedence over SWEEP_CONFIG)
sweep --config /abs/path/to/config.json

# Inspect or persist display language (system | en | zh; defaults to system)
sweep lang
sweep lang en
sweep --lang en

# Print version / help
sweep --version
sweep --help
```

> Subcommand `sweep update` / `sweep update --check` is also available for package-manager self-upgrade once published. Display language defaults to `system` (detecting your OS UI language) and can be customized independently via `sweep lang <system|en|zh>` (`~/.config/sweep/lang.json` / `%APPDATA%\sweep\lang.json`), `--lang <system|en|zh>`, or `SWEEP_LANG` / `CLIS_LANG`.

On interactive terminals, the header displays the active runtime (e.g. `bun 1.4.5`); non-TTY output omits it and disables ANSI color (also honoring `NO_COLOR` and `TERM=dumb`).

## Exit codes

- `0`: success (preview, empty result, `init`, `migrate`, `config`, `update`, `--version`, `--help`).
- `1`: failure (removal or trash failure, batch abort, whole-batch guard rejection, skipped/unattempted targets, missing config in non-TTY mode, broken/unmigratable config, or invalid arguments).

## Configuration (v2)

Config path resolution priority: `--config <path>` > `SWEEP_CONFIG` > platform default:

- **macOS / Linux**: `~/.config/sweep/config.json`
- **Windows**: `%APPDATA%\sweep\config.json` (falls back to `%USERPROFILE%\AppData\Roaming\sweep\config.json`)

```json
{
  "version": 2,
  "roots": ["/Users/you/workspace"],
  "presets": {
    "node": {},
    "rust": {},
    "python": {},
    "java": {},
    "cpp": {},
    "os-junk": {}
  },
  "rules": [
    {
      "name": "stale-logs",
      "kind": "file",
      "match": "*.log",
      "olderThanDays": 14
    }
  ]
}
```

### Core config rules ([ADR 0022](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md))

- **`roots`**: scan roots (deduplicated by realpath). Omitting `roots` defaults to `[realpath(os.homedir())]`; explicitly setting `"roots": []` is rejected (`CONFIG_CORRUPT_SHAPE`) to prevent silent empty scans. Delete/trash execution requires every root and its ancestor chain to be symlink-free (including `/tmp` and `/var` on macOS).
- **32 built-in home-directory guardrails (`DEFAULT_EXCLUDE`)**: omitting `exclude` applies 32 cross-platform exclusions covering package/version managers (`.bun`, `.npm`, `.pnpm-store`, `.yarn`, `.nvm`, `nvm`, `.fnm`, `.volta`, `.asdf`, `.n`), editors (`.vscode`, `.vscode-insiders`, `.vscode-server`, `.cursor`, `.antigravity`), system/app data (`Library`, `.local`, `.config`, `.cache`, `.claude`), trash bins (`.Trash`, `Trash`, `$Recycle.Bin`), Windows app roots (`AppData`, `scoop`), and language toolchain caches (`.cargo`, `.rustup`, `.m2`, `.gradle`, `.conda`, `.pyenv`, `.uv`). Writing `exclude` explicitly (including `[]`) overrides defaults.
- **6 built-in presets (`presets`) with mandatory project anchoring**:
  - **Key presence activates** a preset: **`enabled` fields are strictly forbidden** (`CONFIG_CORRUPT_SHAPE`), and unknown preset keys are rejected. Default action is `"delete"`, overridable per preset with `"action": "trash" | "delete"`; per-preset `exclude` / `include` only tighten scope.
  - `node`: `node_modules` directory anchored by sibling `package.json` (plus install-tree semantic classification).
  - `rust`: `target` directory anchored by sibling `Cargo.toml`.
  - `python`: `.venv` / `venv` (anchored by sibling `pyproject.toml` / `requirements.txt` or inner `pyvenv.cfg`), plus `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`.
  - `java`: Maven `target` (sibling `pom.xml`) and Gradle `.gradle` / `build` (sibling `build.gradle*` or `settings.gradle*`). `~/.gradle` at home root stays protected by `DEFAULT_EXCLUDE`; only real project-level `.gradle` with Gradle anchors is eligible when `java` is active and not explicitly excluded.
  - `cpp`: `build` / `cmake-build-*` anchored by sibling `CMakeLists.txt` or inner `CMakeCache.txt`.
  - `os-junk`: regular files `.DS_Store`, `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db` only (**never** matches `desktop.ini`, `.directory`, or `._*`).
- **Custom `rules`**:
  - Fields: `name`, `kind` (`"file" | "dir" | "any"`), `match` (exact name or simple `*`/`?` glob; hard-rejects empty strings, `.`, `..`, `.git`, `*`, `**`, wildcard-only patterns, path separators, and control chars), `action?` (**defaults to `"trash"`**), `olderThanDays?` (positive number checked against `lstat.mtimeMs`), and optional local `exclude` / `include`.
  - Multi-source collisions on the same realpath deduplicate conservatively: **`"trash"` always wins over `"delete"`**.

### Initialization, migration, and structured summary ([ADR 0024](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0024-cli-init-migrate-and-summary-display.md))

- **First run with no config**:
  - **TTY**: launches the `sweep init` wizard automatically; on the run where a config was just written, cleanup is forced to **preview-only** even if `--yes` was passed.
  - **Non-TTY**: **never blocks, never falls back to scanning home or `cwd`, and never accepts `--yes`**, exiting `1` immediately with guidance to run `sweep init`, `sweep init --default`, or `--config <path>`.
- **`sweep init --default`**: writes the complete best-practice v2 config (home root, all 6 presets including `os-junk`, 32 built-in guardrails). Enforces symlink-free config path checks and refuses silent overwrite in non-TTY mode.
- **Lossless migration (`sweep migrate` or automatic on `sweep`)**:
  - Triggered when the new path is absent while the legacy path (`sweep-node-modules/config.json`) exists, or when an existing config has `version < 2` (or omits `version`).
  - Always creates a pre-write backup `config.json.YYYYMMDD_HHMMSS.modified` in the source config directory; aborts immediately if backup fails.
  - Maps v1 strictly to `presets: { node: {} }`, **never silently enabling new presets** (`rust` / `python` / `java` / `cpp` / `os-junk`) and printing a neutral hint instead.
  - In TTY mode, prompts for confirmation before writing; in non-TTY mode, auto-migrates only when 100% lossless and exits `1` on unknown fields, future versions, or corrupt shapes.
- **Structured summary display**: after `init`, `init --default`, or `migrate` writes disk, the terminal displays a compact `▍ SWEEP` summary (config path, roots, active presets with `[DELETE]` / `[TRASH]`, custom rules with retention days, global exclude count, and copy-pasteable view/edit commands for the current platform: `sweep config` / `cat` / `Get-Content` / `${EDITOR:-vi}` / `open -e` / `notepad`); raw JSON is never dumped to stdout.

## Safety guardrails & zero-dependency trash

> One-line philosophy: when anything is uncertain, do not delete.

- **Preview by default**: `--yes` is required to execute any cleanup; `--force` only releases suspected install trees and never relaxes guard invariants or cross-device protection.
- **Zero-dependency cross-platform trash that never downgrades to permanent delete ([ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md))**:
  - **macOS**: `/usr/bin/trash -s <path>` (absolute path); falls back to `/usr/bin/osascript` via `on run argv` (never string-interpolates paths) if `/usr/bin/trash` is absent.
  - **Linux**: pure TypeScript Freedesktop XDG Trash 1.0 (`$XDG_DATA_HOME/Trash` or `~/.local/share/Trash`, atomic `wx` `.trashinfo` reservation with `.2`/`.3` deduplication, atomic `rename`, cleans up placeholder on `EXDEV` without cross-device copy-delete).
  - **Windows**: pre-rejects paths `>= 260` characters (`WIN32_TRASH_MAX_PATH`), strips `Read-Only` attributes, and invokes system `powershell.exe -NoProfile -NonInteractive` with `Microsoft.VisualBasic.FileIO.FileSystem` passing the path via environment variable.
  - **Hard red line**: if any trash channel fails, the original file/directory remains untouched on disk, the entry is recorded under `failed` with `TRASH_FAILED` (`partialRisk: false`), and CLI exits `1` (it **never** falls back to `fs.rm`).
- **Generalized five-invariant guard & per-component re-check**: rejects malformed leaves (empty, `.`, `..`, `.git`, `*`, trailing separators), targets outside declared roots, filesystem roots and home body, symlinked root anchor chains, and duplicate realpaths; a single rejection aborts the whole batch with zero cleanup. Before each deletion or trash move, the owning root chain and every parent component are `lstat`-verified.
- **Output sanitization**: every external path and rule name passes through the single sanitization pipeline (`sanitizeLine` / `sanitizeOutputLine`) before rendering.

For the complete threat model and honest residual-risk ledger, see [Safety Guardrails](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/designs/safety-guardrails.md).

## Development & Documentation

- [Development guide](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [CLI package docs](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/docs/README.md) / [CLI surface design](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/docs/designs/cli-surface.md)
- [Core API package (`@iyowei/sweep`)](https://github.com/iyowei/clis/blob/main/packages/sweep/README.md) / [Product docs & ADRs](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/README.md)
- [Repository documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
