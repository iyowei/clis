# sweep-node-modules-cli

[![CI](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/sweep-node-modules-cli)](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/sweep-node-modules-cli)](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)
![node](https://img.shields.io/node/v/@iyowei/sweep-node-modules-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fsweep-node-modules%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

A workspace-level cleaner for `node_modules`: scan several root directories in one pass, list every `node_modules` directory across your projects along with its size, and bulk-delete them after you confirm, reclaiming disk space.

> Where this sits: single-project cleaners handle "go into one project and clean its own artifacts"; this tool handles "stand at the workspace level and clean many projects in one pass". The two layers coexist; see [ADR 0001](../../docs/adrs/0001-workspace-level-cleaner.md).

## Requirements

- **Dual runtime** for the actual work: bun when available, node otherwise (identical behavior; bun starts faster).
- Modern runtime APIs only: any recent bun; for node, a version that runs TypeScript natively (the same version floor applies to the source install and the package install; version snapshot and test records in [ADR 0006](../../docs/adrs/0006-dual-runtime-bun-first.md)).
- Zero third-party runtime dependencies (built-in runtime capabilities only).
- Runs on Windows, macOS, and Linux (see [ADR 0007](../../docs/adrs/0007-platform-portability.md)).

## Installation

Three options; pick by the runtime your machine already has. **The `Requires` line under each option is a hard requirement:**

> **Only bun on the machine, no node?** Use option 1 or 3. Global installs (option 2) require node, whether you go through npm or bun.

Options 1 and 2 both pull the package from a registry. If your machine is configured with a mirror that has not synced the version you want yet, append `--registry=https://registry.npmjs.org` to the command to hit the official registry directly.

### 1. No install (for a quick trial)

```shell
# with bun
bunx @iyowei/sweep-node-modules-cli

# with node (npx ships with npm, which itself requires node)
npx @iyowei/sweep-node-modules-cli
```

- **Requires**: bun or node, matching the command you pick
- Zero install; the package is resolved once per run
- Note: `bunx` and `npx` are not interchangeable; each is tied to one runtime: a bun-only machine has no `npx`, and a node-only machine has no `bunx`

### 2. Global install via a package manager (recommended for regular use)

```shell
npm install -g @iyowei/sweep-node-modules-cli
bun install -g @iyowei/sweep-node-modules-cli
```

- **Requires**: **node**, for both commands. npm itself runs on node, and `bun install -g` only creates a symlink to the entry file; at execution time the OS kernel reads that file's shebang (node) to pick the interpreter, and the application layer never gets a say
- Install once, then run `sweep-nm` directly; when bun is present, the actual work still prefers bun

### 3. From source (for development, or machines without node)

**macOS / Linux**:

```shell
# clone, then cd into the repo root (adjust the path to your clone location)
cd "<your clone>/sweep-node-modules"

chmod +x packages/sweep-node-modules-cli/bin/sweep-nm

# symlink it into ~/.local/bin (usually already on PATH); the launcher picks the runtime
ln -sf "$PWD/packages/sweep-node-modules-cli/bin/sweep-nm" ~/.local/bin/sweep-nm
```

**Windows** (PowerShell):

```powershell
# add the repo's bin directory to your user PATH; one-time, effective after reopening the terminal
# adjust the path to your actual clone location (the launcher locates src relative to itself, so the script cannot be copied out on its own)
$bin = "$env:USERPROFILE\tools\sweep-node-modules\packages\sweep-node-modules-cli\bin"
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

> Or skip the command line: add the `bin` directory to your user `Path` under System Properties → Environment Variables.

- **Requires**: bun or node, either works (the launcher is a shell / cmd script run by the OS; it does not depend on node)
- The most direct entry point; afterwards just run `sweep-nm` (on Windows via `packages\sweep-node-modules-cli\bin\sweep-nm.cmd`)

> The tool also ships an API package, [`@iyowei/sweep-node-modules`](https://www.npmjs.com/package/@iyowei/sweep-node-modules), for use in your own programs or scripts (usage is documented in that package).

## Usage

```shell
# preview: list every node_modules under the configured roots with its size; nothing is touched
sweep-nm

# once the list checks out, delete for real
sweep-nm --yes

# also delete "suspected install trees" (package manager / version manager / editor extension trees; skipped by default)
sweep-nm --yes --force

# add exclusions on the fly (repeatable)
sweep-nm --exclude my-kits --exclude url-tool

# clean only directories matched by the include list (repeatable, merged with config)
sweep-nm --include my-kits

# show the config file actually in effect (source / path / existence)
sweep-nm config

# init wizard: generate a config file interactively
sweep-nm init
```

The end of the header line reports the runtime actually in use for this run (e.g. `bun 1.4.2`); it appears on interactive terminals only, keeping non-TTY output noise-free.

## Configuration

The config file lives at a platform-appropriate path: `%APPDATA%\sweep-node-modules\config.json` on Windows, `~/.config/sweep-node-modules/config.json` everywhere else. Override it with `--config` or the `SWEEP_NM_CONFIG` environment variable; `sweep-nm config` reports the path and file status actually in effect for the current run. **The write side requires real paths**: if the config path or any of its ancestors involves a symlink (system links such as `/tmp` and `/var` included), `sweep-nm init` refuses to write before touching disk and points at the link; follow the prompt to rewrite the path in real form (e.g. `/private/tmp/x`) and it goes through.

```json
{
  "roots": [
    "/Users/iyowei/workspace/development",
    "/Users/iyowei/self/development"
  ],
  "exclude": ["my-kits"],
  "include": []
}
```

- `roots`: the scan roots, any number of them; duplicate or nested roots are deduplicated by real path. **The delete side requires real paths**: no symlink may sit on a root or any of its ancestors (system links such as `/tmp` and `/var` included); if one is hit, `--yes` rejects the whole batch and tells you to rewrite the path in real form (e.g. `/private/tmp/x`), which clears it. Scanning is not subject to this: a root that is itself a symlink still gets scanned.
- `exclude`: the exclusion list; a name match at any directory level between a root and a `node_modules` skips it (more exclusions, less deletion: the safe direction). **Omit this field and a built-in default list applies** (package manager / version manager install trees, editor extension directories, system and application data roots; the list and its rationale are in the [design doc](../../docs/designs/config-and-initialization.md), section "Default exclusions"). These names never warn when they match nothing, since they vary by platform. Write the field explicitly (an empty array counts) and your own list takes over completely.
- **Suspected install trees stay out of the delete batch by default**: targets that look like install trees (e.g. `~/.bun/install/global/node_modules`, `<version dir>/lib/node_modules`, editor extension directories) are flagged in the list as `疑似安装树: <reason>` (suspected install tree, plus the reason) and keep their `node_modules` suffix; `--yes` does not delete them (reported as a failure, with an explanation of the skip). Cleaning them takes an explicit `--force`, which releases only this batch of targets and relaxes no deletion guard.
- **Cross-device targets stay out of the delete batch by default**: when a target and its owning root are not on the same filesystem (a cloud drive, network share, or container volume is mounted under the root and the entry lands on that volume), it is likewise not deleted; the list line notes the form at its end, `跨设备: 根与目标之间有挂载点` (a mount point lies between root and target) or `跨设备: 目标本体即挂载点` (the target itself is the mount point). For the first form, add that mount point as its own root and it cleans as usual; for the second, unmount the volume first; `--force` does not release this category.
- `include`: the inclusion list (a whitelist); only matches are included, matched the same way as `exclude`. Omitted or empty means no filtering (more inclusions, more deletion); when a name matches both lists, `exclude` wins. A misspelled name would leave the result empty, so unmatched names warn on stderr.
- `node_modules` and `.git` are always stripped from either list: the former is the tool's very target (under `exclude` it would rule out the only thing this tool does, under `include` it can never match), the latter is a directory the scan always skips. If stripping leaves `include` empty, that means no filtering, not "scan only `node_modules`".
- First run with no config: on an interactive terminal the init wizard starts automatically (the scan root defaults to your home directory); in non-interactive environments (scripts and the like) it falls back to the current working directory as the root and says so, without asking. Re-enter the wizard any time with `sweep-nm init`.

> Field definitions are authoritative in the [design doc](../../docs/designs/config-and-initialization.md).

## Safety guardrails

Deletion is the only irreversible action this tool performs, and a whole discipline of guards has grown around it. Below are the heavyweight ones; the full set, including an honest account of the known residual risks, lives in [the safety guardrails document](../../docs/safety-guardrails.md) (in Chinese).

> The tool's character in one line: when anything is uncertain, the default is not to delete.

**Nothing happens by default.** Preview is the default mode, and deletion requires an explicit `--yes`. With no config file, `--yes` is hard-rejected and nothing is deleted. On the run right after the wizard writes a config, preview is forced even if `--yes` was passed. `--force` releases only suspected install trees; it relaxes no deletion guard.

**What gets deleted is decided by both name and location.** Only directories named exactly `node_modules` are eligible, and only under the roots you declared; whether a target sits under a root is judged by path hierarchy rather than string prefixes, so `..` traversal and lookalike paths are rejected outright. Targets whose size cannot be measured are never deleted: keep rather than guess. Two categories are held back by default: suspected install trees (reinstalling them is painful or impossible; released only by an explicit `--force`) and cross-device targets that live on a different filesystem (`--force` does not release these either). A built-in default exclusion list (install-tree and system-data-root names from package managers, version managers, and editors) keeps the scan away from those trees.

**One failure stops the whole batch, and every path is re-checked first.** If a single target fails a check, the entire batch is abandoned with zero deletions, rather than letting the rest through; right before removal, the path from the root down to the target's parent is re-verified component by component, and a swap mid-way stops the batch. If a configured root, or any of its ancestors, has been swapped for a symlink, the delete batch is rejected with rewrite instructions; system links such as `/tmp` and `/var` count too, and rewriting to the real path clears it.

**Symlinks: the threshold follows reversibility.** For the same config, the read-only scan follows a symlinked root and still lists results, the irreversible delete rejects the batch, and `init` refuses to write a single byte through a link. The split is deliberate: a link's origin cannot be judged, so the irreversible step does not get the benefit of the doubt.

**Nothing in the output can be forged.** Every piece of external data (directory names from disk, command errors, list spellings) is sanitized before it reaches the output: control bytes stripped, newlines folded, so nothing can inject terminal control sequences or split a line into a fake trusted row; names that were rewritten get a note on the line. Skipped targets stay in the list with their markers, and the list ends with a skip count. A name that never matches warns on stderr, and a whitelist with zero matches states outright that the result must be empty. Errors carry an error code, plain language, the target, and a partial-deletion re-check hint; "nothing was deleted" and "deletion failed" are shown separately.

**The distribution chain proves itself.** Zero third-party runtime dependencies and no network calls on the run path. The artifact an npm installer gets verifies itself against a bundled manifest before use and is refused on mismatch; the release side passes a four-part gate: a clean checkout, an artifact built from this commit, manifest consistency, and a whitelist of files allowed into the published package, so stray files (say, a backup of the README) cannot slip in.

## Development

Environment setup, common commands, dual-runtime verification, and commit hooks: see the [development guide](../../docs/development.md).

## Documentation

- [Engineering documentation index](../../docs/README.md)
