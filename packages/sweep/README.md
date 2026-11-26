# @iyowei/sweep

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
![private](https://img.shields.io/badge/npm-private%20workspace%20package-lightgrey)
![node](https://img.shields.io/badge/node-%3E%3D22.18.0-339933)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Programmable API for general-purpose, workspace-level multi-toolchain cleanup: scan, anchor-verify, measure, move to trash, or safely delete artifacts across Node.js, Rust, Python, Java, C/C++, OS junk files, and custom rules, all with zero third-party runtime dependencies. The CLI package ([`@iyowei/sweep-cli`](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/README.md), command `sweep`) is a thin interactive shell over this API.

> **Private workspace package**: `@iyowei/sweep` and `@iyowei/sweep-cli` are currently marked `"private": true` inside this monorepo and are excluded from the public npm release pipeline while the v2 API and cross-platform trash stack mature (see [ADR 0021](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md)). Consume via workspace dependency inside the repository.

## Contents

- [Requirements](#requirements)
- [Workspace usage](#workspace-usage)
- [Quick start](#quick-start)
- [Two export layers](#two-export-layers)
- [Orchestration layer](#orchestration-layer)
- [Built-in presets and custom rules](#built-in-presets-and-custom-rules)
- [Primitive layer](#primitive-layer)
- [Errors and codes](#errors-and-codes)
- [Progress and cancellation](#progress-and-cancellation)
- [Safety model](#safety-model)
- [Data shapes and stability](#data-shapes-and-stability)
- [Development & Documentation](#development--documentation)

## Requirements

- **Dual runtime**: Bun first, Node.js (`>= 22.18.0`) fallback (identical behavior; Bun starts faster; see [ADR 0006](https://github.com/iyowei/clis/blob/main/docs/adrs/0006-dual-runtime-bun-first.md)).
- **Zero third-party runtime dependencies**: built-in `node:` / `bun:` modules only, including cross-platform trash channels (see [ADR 0003](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0003-zero-runtime-deps.md) and [ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md)).
- **Cross-platform**: macOS, Linux, and Windows (see [ADR 0007](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0007-platform-portability.md)). Verification boundary: macOS trash and Linux pure-TypeScript XDG Trash logic are verified locally; Windows host Recycle Bin PowerShell execution and real Linux desktop integration are verified via stub/logic tests and have not yet been executed on target host machines.
- Written in TypeScript; compiled JavaScript and `.d.ts` declarations are built into `dist/`.

## Workspace usage

Within this monorepo (`packages/sweep`), reference `@iyowei/sweep` as a workspace package (`"private": true`, no `bin`). Build artifacts before importing from plain Node.js:

```shell
bun install && bun run build
```

For the command-line tool (`sweep`), see [`@iyowei/sweep-cli`](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/README.md).

## Quick start

```ts
import { createSweeper, formatBytes, summarizeReport } from '@iyowei/sweep';

// The orchestration layer never reads the platform config file: pass what to sweep explicitly.
const sweeper = createSweeper({
  roots: ['/Users/me/workspace/development'], // absolute paths
  presets: { node: {}, rust: {}, 'os-junk': {} }, // key presence activates a preset
  rules: [
    {
      name: 'stale-logs',
      kind: 'file',
      match: '*.log',
      action: 'trash',
      olderThanDays: 14,
    },
  ],
});

// plan(): read-only. Scan + anchor verify + measure + classify + device check + batch construction; zero side effects.
const plan = await sweeper.plan();

for (const entry of plan.entries) {
  const size = entry.bytes === undefined ? '?' : formatBytes(entry.bytes);
  const badge = entry.action === 'trash' ? '[TRASH]' : '[DELETE]';
  const note = entry.inBatch ? '' : `  (${entry.skipNote})`;
  console.log(
    `${entry.inBatch ? '*' : '-'} ${badge} ${size.padStart(9)}  ${entry.target}${note}`,
  );
}
console.log(`${plan.batch.length} target(s) ready to clean`);

// run(): re-decides every fact against live disk state, passes the safety guard, then trashes or deletes.
const report = await sweeper.run({
  expectedBatch: plan.batch, // constrain execution to the approved list
  staleTargets: 'missing', // a target already removed elsewhere is not a failure
});

const summary = summarizeReport(report);
console.log(
  `removed ${summary.counts.removed}, trashed ${summary.counts.trashed}, released ${formatBytes(report.releasedBytes)}`,
);
```

Three things to know before your first call:

- `roots` are absolute paths, and for execution (`run` / `removeBatch` / `removeTargets`) they must be **real paths**: no symlink on any root or ancestor (macOS `tmpdir()` traverses `/var`, so normalize with `await realpath(...)`). The read side (`plan` / `scan`) is not subject to this.
- The orchestration layer never loads the platform config file, and interactive wizards stay in `@iyowei/sweep-cli`. Config v2 loaders and lossless migration primitives are exported below for tools that want matching behavior.
- Nothing in this package writes to `stdout` or `stderr`: all human-readable messages are returned as data.

## Two export layers

| Layer                                                                                                   | What it is                                                                                                                       | Reach for it when                                                                   |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Orchestration: `createSweeper(...).plan()` / `.run()`                                                   | Full chain: scan & anchor verify → measure → classify → device check → batch construction → safety guard → trash/delete → report | Default choice. Declare what to clean and decide what the report means              |
| Primitives: `createScanner` / `createSizer` / `validateTargets` / `removeTargets` / `moveToTrash` / ... | Composable single-purpose modules (presets, rules, guard, trash, config v2, migration, display)                                  | Step-by-step control, custom UIs, or embedding a single link into your own pipeline |

## Orchestration layer

### `createSweeper(options): Sweeper`

Constructs the orchestrator with zero scan/delete IO at construction time.

- `options` `SweepOptions`:
  - `roots` `string[]` (required, non-empty): absolute scan roots.
  - `exclude?` `string[]`: directory names to skip at any depth; defaults to `DEFAULT_EXCLUDE` (32 cross-platform home-directory guardrails).
  - `include?` `string[]`: whitelist directory names; defaults to `[]` (no filtering). `exclude` always wins on overlap.
  - `presets?` `PresetsMap`: active built-in presets (key presence activates; omitting both `presets` and `rules` defaults to `{ node: {} }`).
  - `rules?` `readonly CustomRule[]`: custom cleanup rules; defaults to `[]`.
  - `excludeExplicit?` `boolean`: distinguishes explicit user `exclude` from default guardrails (defaults to `false`, aligned with `ScanOptions.excludeExplicit`; used for project-level `.gradle` resolution under `java`).
  - `nowMs?` `number`: reference epoch ms for `olderThanDays` evaluation (defaults to `Date.now()`; injectable in tests).
  - `home?` `string | null`: home directory used by the home-body guard, `~/.gradle` protection, and hidden-dir install-tree classification; defaults to `os.homedir()`, `null` disables home-based checks.
  - `style?` `PathStyle`: `POSIX_STYLE` / `WIN32_STYLE`; defaults to `nativeStyle()`.
  - `policy?` `SweepPolicy`: `{ releaseSuspects: boolean }`; defaults to `{ releaseSuspects: false }`.
  - `trashDeps?` `TrashDeps`: injectable platform/FS dependencies for deterministic trash testing.
- Returns `Sweeper`:
  - `options` `Readonly<ResolvedSweepOptions>`: resolved read-only snapshot (defaults merged, `exclude`/`include` passed through `mergeNames`).
  - `plan(options?)` / `run(options?)`: read-only and executing passes.

Invalid arguments (empty `roots`, relative or drive-relative roots, empty/non-string items, invalid `home`, non-boolean `policy.releaseSuspects`, invalid `presets` or `rules`) **throw synchronously** with `SweepError('INVALID_ARGUMENT', ..., { field })`.

### `sweeper.plan(options?): Promise<SweepPlan>`

Read-only pass: scan + anchor check + measure + classify + cross-device check + batch construction, zero side effects.

- `SweepEntry` carries full per-target state:
  - `target`, `project`, `root`
  - `entryKind` (`'dir' | 'file'`), `action` (`'delete' | 'trash'`), `source` (`HitSource`: `{ kind: 'preset', name }` or `{ kind: 'rule', name }`)
  - `bytes?`, `basis?` (`'disk-usage' | 'logical-bytes'`)
  - `kind` (`'project' | 'suspect-install-tree'`), `kindReason?`, `crossDevice?` (`'on-path' | 'target-itself'`)
  - `unmeasuredCode?`, `unmeasuredReason?`, `inBatch`, `skipReason?`, `skipNote?`
- `SweepPlan` returns `{ roots, exclude, include, policy, basis?, entries, batch, skipped, trailer?, warnings, nameMatches }`.

### `sweeper.run(options?): Promise<SweepReport>`

Re-runs the live read-only pass against current disk state (never replays stale plans), applies `expectedBatch` intersection if provided, passes targets through the generalized safety guard, and executes each target's resolved `action` (`trash` or `delete`).

- `options?` `SweepRunOptions`: `{ onProgress?, signal?, expectedBatch?, staleTargets?: 'reject' | 'missing' }`.
- `SweepReport`: `{ status, plan, validation?, removal?, entries, stale, releasedBytes, drift? }`.
  - `status` `SweepRunStatus`: `'executed' | 'rejected' | 'nothing-to-do'`.
  - `removal` `RemovalResult`: `{ removed, trashed, missing, failed, aborted? }`.
  - `entries` `SweepOutcomeEntry[]`: `SweepEntry & { outcome: EntryOutcome }`.
  - `EntryOutcome` kinds: `'removed' | 'trashed' | 'missing' | 'stale'` (success side), `'failed'`, `'rejected'`, `'not-attempted'`, `'not-expected'`, `'skipped'`.
  - `releasedBytes`: cumulative measured bytes across the success side (`removed` + `trashed` + `missing` + `stale`).

### `isSuccessOutcome(outcome)` & `summarizeReport(report)`

- `isSuccessOutcome(outcome): boolean`: returns `true` for `'removed' | 'trashed' | 'missing' | 'stale'`, `false` otherwise. Always prefer it over manual `kind` checks so new outcome kinds are classified safely.
- `summarizeReport(report): SweepSummary`: returns `{ counts, succeeded, unprocessed, failed, aborted }`:
  - `succeeded = removed + trashed + missing + stale`
  - `unprocessed = skipped + rejected + not-attempted + not-expected`
  - `failed = counts.failed`
  - `aborted = report.removal?.aborted !== undefined`

## Built-in presets and custom rules

Full specification: [ADR 0022](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md).

### 6 built-in presets (`BUILTIN_PRESETS` / `PRESET_NAMES` / `PRESET_BY_NAME`)

- **Key presence activates** a preset (`PresetsMap = Partial<Record<PresetName, PresetConfig>>`); `enabled` fields are rejected in config v2 (`CONFIG_CORRUPT_SHAPE`). Default action is `'delete'`, overridable via `action?: 'trash' | 'delete'`.
- `node`: `node_modules` directory anchored by sibling `package.json` + install-tree semantic guard (`classifyTarget`).
- `rust`: `target` directory anchored by sibling `Cargo.toml`.
- `python`: `.venv` / `venv` (sibling `pyproject.toml` / `requirements.txt` or inner `pyvenv.cfg`), plus `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`.
- `java`: Maven `target` (sibling `pom.xml`) and Gradle `.gradle` / `build` (sibling `build.gradle*` or `settings.gradle*`). Home-level `~/.gradle` is always protected by `DEFAULT_EXCLUDE`; project-level `.gradle` is only eligible when `java` is active and not explicitly excluded.
- `cpp`: `build` / `cmake-build-*` anchored by sibling `CMakeLists.txt` or inner `CMakeCache.txt`.
- `os-junk`: regular files `.DS_Store`, `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db` (`OS_JUNK_FILES`). Never matches `desktop.ini`, `.directory`, or `._*`.
- Exported helpers: `createDefaultPresets()`, `isPresetName(value)`, `resolvePresetAction(name, config?)`, `matchesAnyActivePresetLeaf(leaf, presets)`.

### Custom rules (`rules`)

- `CustomRuleInput` / `CustomRule`: `{ name, kind: 'file' | 'dir' | 'any', match, action, olderThanDays?, exclude?, include? }`.
- In v2 config loading, omitting `action` **forces `action: 'trash'`**.
- `validateRuleMatch(match)` hard-rejects empty strings, leading/trailing whitespace, `.`, `..`, `.git`, `*`, `**`, wildcard-only patterns (`*.*`, `.*`, `?`, etc.), path separators (`/` / `\`), and ASCII control characters.
- Multi-source collisions on the same realpath deduplicate conservatively: **`'trash'` always wins over `'delete'`**.
- Exported helpers: `MS_PER_DAY`, `validateRuleMatch(match)`, `compileNameMatcher(pattern)`, `compileRules(rules)`, `ruleMatchesKind(ruleKind, kind)`, `isOlderThanDays(mtimeMs, olderThanDays, nowMs?)`, `matchesAnyRuleLeaf(leaf, rules)`.

## Primitive layer

Every primitive is side-effect free at import and writes nothing to stdout/stderr.

### Scanning & Measuring

- `createScanner(): Scanner` → `scanner.scan(options): Promise<ScanResult>`: 32-way bounded-concurrency `readdir` walk with sibling-file anchor verification, preset/rule matching, realpath deduplication, and deterministic `target`-ascending hits carrying `{ project, target, root, entryKind?, action?, source? }`.
- `createSizer(): Sizer` → `sizer.measure(targets, options?): Promise<SizeResult>`: dual-track sizing (`du` fast path with `'disk-usage'` basis on POSIX; pure JS `'logical-bytes'` fallback and always `'logical-bytes'` on Windows). Partitions every input target into exactly one of `entries`, `unmeasured`, or `gone`.

### Classifying, Safety Guard & Device Boundary

- `classifyTarget(target, options?): Classification`: pure path classifier distinguishing `'project'` vs `'suspect-install-tree'`.
- `validateTargets(targets, options): Promise<ValidationResult>`: evaluates the generalized five invariants (safe target leaf via `hasSafeTargetLeaf` or `hasNodeModulesLeaf` / `allowedLeaf`, realpath existence & readability, symlink-free root anchor chain, non-root & non-home body, strict containment via `insideAnyRoot`, realpath dedupe). Returns `{ accepted, rejected, mappings }`.
- Pure path/anchor helpers: `POSIX_STYLE`, `WIN32_STYLE`, `nativeStyle()`, `dedupeKey`, `hasNodeModulesLeaf`, `hasSafeTargetLeaf`, `insideAnyRoot`, `isFilesystemRootBody`, `isHomeBody`, `anchorChainPaths`, `firstSymlinkOnAnchor`, `firstSymlinkOnTarget`, `firstSymlinkOnRoot`.
- Device boundary helpers: `findCrossDeviceTargets(targets, options)`, `crossDeviceIndex(entries)`, `fsDeviceProbe(path, follow)`.

### Removal & Cross-platform Trash ([ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md))

- `moveToTrash(target, deps?): Promise<TrashOutcome>`: zero-dependency trash channel across macOS (`/usr/bin/trash -s`, fallback `/usr/bin/osascript` via `on run argv`), Linux (pure TS Freedesktop XDG Trash 1.0 with atomic `wx` `.trashinfo` + `.2`/`.3` dedupe + `rename`), and Windows (`>= 260` char pre-rejection, `Read-Only` stripping, PowerShell `Microsoft.VisualBasic.FileIO.FileSystem` via env var). **Never falls back to `fs.rm` on failure**: returns `{ ok: false, code: 'TRASH_FAILED', ... }` with the file untouched.
- Trash helpers & constants: `MACOS_TRASH_BIN`, `MACOS_OSASCRIPT_BIN`, `WIN32_TRASH_MAX_PATH`, `resolveXdgTrashDir`, `encodeXdgTrashPath`, `formatTrashDeletionDate`, `resolveWindowsPowerShell`.
- `removeTargets(targets, options): Promise<RemovalResult>`: 4-way bounded concurrency with per-target root-anchor and component-by-component `lstat` re-check before execution; supports per-target `actions?: ReadonlyMap<string, CleanupAction>`, `allowGeneralTargets`, and `trashDeps`. Returns `{ removed, trashed, missing, failed, aborted? }`.
- `toTrustRoots(roots)` & `removeBatch(targets, options): Promise<BatchOutcome>`: recommended write-side primitive combining `validateTargets` + whole-batch rejection + `toTrustRoots` + `removeTargets`.

### Skip Set

- `toSkipCandidates(hits, size, options?)`, `skipsBatch(entry, crossDevice, policy)`, `skipReasonOf(entry, crossDevice, policy)`, `deletionBatch(entries, crossDevice, policy)`, `collectSkips(entries, crossDevice, policy)`, `crossDeviceNote(kind)`.

### Config v2 & Lossless Migration (optional primitives)

- Constants: `CONFIG_VERSION` (`2`), `CONFIG_ENV_VAR` (`'SWEEP_CONFIG'`), `DEFAULT_EXCLUDE` (32 cross-platform home-directory exclusions).
- Path & loaders: `resolveConfigPath(options?)` (`--config` > `SWEEP_CONFIG` > `~/.config/sweep/config.json` or `%APPDATA%\sweep\config.json`), `resolveLegacyConfigPath(options?)` (`sweep-node-modules/config.json`, for migration detection only), `resolveDefaultRoot(home?)`, `createDefaultConfig(options?)`, `loadConfig(path, options?)`, `loadResolvedConfig(resolved, options?)`, `mergeNames(configNames, cliNames)`.
- Migration primitives: `detectMigration(resolved, options?)`, `convertV1ToV2(raw, homedir?)`, `applyMigration(plan, options?)` (creates `config.json.YYYYMMDD_HHMMSS.modified` backup before writing; maps v1 strictly to `presets: { node: {} }`), `buildMigrationBackupPath(sourcePath, date?)`, `formatBackupTimestamp(date?)`, `NEW_PRESET_HINTS`.

### Display Helpers

- `formatBytes(bytes): string`: human-readable size (`B` / `KB` / `MB` / `GB` / `TB`).
- `sanitizeLine(text): string` & `sanitizeOutputLine(text): string`: single-source output sanitization stripping control, bidi, and zero-width characters and folding newlines.

## Errors and codes

**Rule**: expected domain outcomes that can be listed per target are returned; unrecoverable errors (bad arguments, broken/unmigratable config, cancellation) throw `SweepError`.

- `SweepError<Code>`: `{ name: 'SweepError', code, message, details? }` (the sole class exported by the package).
- `isSweepError(value)` & `isSweepErrorCode(value, code)`: cross-realm/multi-instance safe guards that narrow `details` by `code`.
- `SweepErrorCode`: `CONFIG_READ_FAILED` · `CONFIG_CORRUPT_JSON` · `CONFIG_CORRUPT_SHAPE` · `CONFIG_ABSENT` · `CONFIG_NEEDS_MIGRATION` · `CONFIG_MIGRATION_FAILED` · `INVALID_ARGUMENT` · `CANCELLED`.

```text
Guard (validateTargets → rejected[].code)
  GUARD_LEAF_NOT_NODE_MODULES · GUARD_INVALID_LEAF · GUARD_TARGET_MISSING ·
  GUARD_TARGET_UNREADABLE · GUARD_REALPATH_FAILED · GUARD_ROOT_ANCHOR_SYMLINK ·
  GUARD_FILESYSTEM_ROOT_BODY · GUARD_HOME_BODY · GUARD_REAL_LEAF_NOT_NODE_MODULES ·
  GUARD_OUTSIDE_ROOTS · GUARD_DUPLICATE_TARGET

Removal & Trash failures (RemovalResult.failed[].code)
  REMOVE_FAILED · REMOVE_ENOENT_SURVIVOR · TRASH_FAILED · REVIEW_UNVERIFIED ·
  REVIEW_COMPONENT_VANISHED

Batch aborts (RemovalResult.aborted.code)
  REVIEW_NOT_UNDER_ANY_ROOT · REVIEW_HEAD_SYMLINK · REVIEW_COMPONENT_REPLACED

Size, unmeasured (SizeResult.unmeasured[].code)
  SIZE_UNMEASURED_PERMISSION · SIZE_UNMEASURED_NOT_DIR · SIZE_UNMEASURED_LOOP ·
  SIZE_UNMEASURED_UNPARSEABLE · SIZE_UNMEASURED_CONTROL_CHAR · SIZE_UNMEASURED_OTHER

Warnings (SweepWarning.code)
  SCAN_ROOT_MISSING · SCAN_ROOT_UNREADABLE · SCAN_ROOT_NOT_DIR · SCAN_ROOT_UNAVAILABLE ·
  SCAN_DIR_UNREADABLE · SIZE_DU_OUTPUT_MISMATCH · SIZE_DU_LINE_UNATTRIBUTED ·
  SIZE_SUBPATH_FAILED · SIZE_TARGET_VANISHED · SIZE_DU_UNAVAILABLE

Skip reasons (SweepEntry.skipReason / SkippedTarget.reason)
  suspect-install-tree · cross-device:on-path · cross-device:target-itself · unmeasured
```

Always branch on `code` and `details`, never parse `message` (Chinese human text). Codes are frozen once introduced; keep a `default` branch in `switch` statements.

## Progress and cancellation

Pass `onProgress` and/or `signal` to `plan` / `run` or supporting primitives (`scan`, `measure`, `validateTargets`, `removeTargets`, `removeBatch`).

- Events: `phase` (`scan` · `measure` · `classify` · `device` · `plan` · `validate` · `remove`), primitive events (`hit` · `measured` · `unmeasured` · `skipped` · `removed` with `outcome: 'removed' | 'trashed' | 'missing'` · `failed` · `aborted` · `warning`), and terminal events (`plan-done` for `plan()`, `done` for `run()`).
- Callbacks run synchronously and are not awaited; throwing inside a callback aborts the call.
- Cancellation throws `SweepError('CANCELLED')` at item/phase boundaries: single `rm` operations are never aborted mid-flight; `remove` phase cancellation includes `details.partial: RemovalResult`.

## Safety model

> One-line philosophy: when anything is uncertain, do not delete.

- **Importing does nothing; `plan()` has zero disk side effects.** Cleanup only occurs via explicit `run()` / `removeTargets()` / `removeBatch()` / `moveToTrash()`.
- **Mandatory project anchoring & safe custom-rule leaves**: built-in presets verify project anchors before matching generic names (`target`, `build`, `venv`, `node_modules`); custom rules default to `'trash'` and reject dangerous match literals; multi-source collisions resolve conservatively (`'trash'` > `'delete'`).
- **Trash never degrades to permanent delete**: any failure in `moveToTrash` leaves the disk entry untouched (`TRASH_FAILED`, `partialRisk: false`).
- **Real paths required for execution, whole-batch rejection, and per-component re-check**: symlinked root anchor chains reject the entire batch; any single guard rejection results in zero cleanup; right before executing each entry, the root chain and every ancestor component down to the target parent are `lstat`-verified.
- **Suspected install trees, cross-device targets, and unmeasured targets** stay out of the batch by default (`policy.releaseSuspects` only releases suspected install trees).

## Data shapes and stability

- All persisted/audit domain objects (`SweepPlan`, `SweepReport`, `ScanResult`, `SizeResult`, `ValidationResult`, `RemovalResult`, `CrossDeviceEntry[]`) are plain JSON-serializable objects and arrays with no timestamps (only `elapsedMs` on progress events). Lookup views (`SkipBook.hints`, `crossDeviceIndex()`) return `ReadonlyMap`.
- Deterministic ordering: `hits` and the three size buckets sort ascending by `target`; removal buckets and `stale` preserve input order; progress event order is explicitly not promised.

| Tier                      | What                                                                                                   | Promise                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Frozen                    | Domain type field names, `code` values, `SkipReason` values, function signatures, `EntryOutcome` kinds | Breaking change requires a major version     |
| Frozen, additions allowed | Option objects (`SweepOptions`, `SweepRunOptions`, `MeasureOptions`, `RemoveBatchOptions`, etc.)       | New optional fields are a minor              |
| Evolving                  | `message` / `reason` / `note` wording                                                                  | Not stable verbatim                          |
| Not promised              | Progress event order, order inside `warnings`                                                          | Result order is promised, event order is not |

## Development & Documentation

- [Development guide](https://github.com/iyowei/clis/blob/main/docs/development.md) (source directory: `packages/sweep`)
- [Engineering documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [Product docs & ADRs (`0001..0004`, `0007..0008`, `0021..0024`)](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/README.md)
- [API surface design](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/designs/api-surface.md)
- [Safety guardrails](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/designs/safety-guardrails.md)
- [CLI package (`@iyowei/sweep-cli`)](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/README.md)
