# sweep-node-modules

[![CI](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/sweep-node-modules)](https://www.npmjs.com/package/@iyowei/sweep-node-modules)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/sweep-node-modules)](https://www.npmjs.com/package/@iyowei/sweep-node-modules)
![node](https://img.shields.io/node/v/@iyowei/sweep-node-modules)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fsweep-node-modules%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Programmable API to sweep `node_modules` across workspace roots: scan, measure, and safely remove them from your own scripts and tools. The CLI package is a thin shell over this same API.

> **Package repositioning**: up to 0.4.0, `@iyowei/sweep-node-modules` was the command-line tool. From 0.5.0 on, the name carries the API package (a pure library, no `bin`), and the CLI lives in its own package: **[@iyowei/sweep-node-modules-cli](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)**. If you came here for the `sweep-nm` command, install that package; the command name, its flags, and the config file carry over. If you had the old name installed as a CLI, upgrading it yields this library and no command: uninstall the old global install and switch to the `-cli` package. The release notes carry the details.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Two export layers](#two-export-layers)
- [Orchestration layer](#orchestration-layer)
- [Primitive layer](#primitive-layer)
- [Errors and codes](#errors-and-codes)
- [Progress and cancellation](#progress-and-cancellation)
- [Safety model](#safety-model)
- [Data shapes and stability](#data-shapes-and-stability)
- [Development](#development)
- [Documentation](#documentation)

## Requirements

- **Dual runtime**: bun first, node fallback (identical behavior; bun starts faster). Node floor: `>= 22.18.0` (this package's `engines` field).
- Zero third-party runtime dependencies: built-in runtime capabilities only (see [ADR 0003](docs/adrs/0003-zero-runtime-deps.md)).
- Windows, macOS, and Linux (see [ADR 0007](docs/adrs/0007-platform-portability.md)).
- Written in TypeScript; type declarations ship with the package.

## Installation

```shell
npm install @iyowei/sweep-node-modules
bun add @iyowei/sweep-node-modules
```

This package installs no command: it is a library. For the command-line tool, install [@iyowei/sweep-node-modules-cli](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli).

## Quick start

```ts
import {
  createSweeper,
  formatBytes,
  summarizeReport,
} from '@iyowei/sweep-node-modules';

// The orchestration layer never reads the platform config file: pass what to sweep yourself.
const sweeper = createSweeper({
  roots: ['/Users/me/workspace/development'], // absolute paths
});

// plan(): read-only. Scan + measure + classify + device check + batch construction; zero deletions.
const plan = await sweeper.plan();

for (const entry of plan.entries) {
  const size = entry.bytes === undefined ? '?' : formatBytes(entry.bytes);
  const note = entry.inBatch ? '' : `  (${entry.skipNote})`;
  console.log(
    `${entry.inBatch ? '*' : '-'} ${size.padStart(9)}  ${entry.target}${note}`,
  );
}
console.log(`${plan.batch.length} target(s) ready to remove`);

// run(): re-decides every fact against the disk as it is now, passes the safety guard, then deletes.
const report = await sweeper.run({
  expectedBatch: plan.batch, // keep the delete surface to the list just approved
  staleTargets: 'missing', // a target someone else already removed is not a failure
});

const summary = summarizeReport(report);
console.log(
  `removed ${summary.counts.removed}, released ${formatBytes(report.releasedBytes)}`,
);
```

Three things worth knowing before the first call:

- `roots` are absolute paths, and for deletion they must be **real paths**: no symlink on a root or any of its ancestors. macOS `tmpdir()` goes through `/var` (a system link), so normalize before using it as a root: `const root = await realpath(await mkdtemp(...))`. The read side is not subject to this.
- The orchestration layer never loads the platform config, and the interactive wizard stays in the CLI package. The config loaders further down are optional primitives for callers who want the same behavior inside their own tool.
- Nothing in this package writes to stdout or stderr: every piece of human-readable text is returned as a string, and where it goes is your call.

## Two export layers

| Layer                                                                                   | What it is                                                                                                       | Reach for it when                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Orchestration: `createSweeper(...).plan()` / `.run()`                                   | The whole chain: scan → measure → classify → device check → batch construction → safety guard → removal → report | You want the default. You say what to sweep and decide what the report means          |
| Primitives: `createScanner` / `createSizer` / `validateTargets` / `removeTargets` / ... | Single-point capabilities, each usable on its own                                                                | You need step-by-step control, or one link of the chain inside a pipeline of your own |

The CLI package is a thin shell over the orchestration layer: parse → call → render → confirm. Business semantics live here in one place; the CLI is a consumer, not a second implementation of the same logic.

## Orchestration layer

### `createSweeper(options): Sweeper`

Creates the orchestrator: the whole chain behind one object. A second instance costs next to nothing (factories do no scan- or delete-level IO).

- `options` `SweepOptions`:
  - `roots` `string[]` (required, non-empty): scan roots, absolute paths.
  - `exclude?` `string[]`: directory names to skip; a match at any level between a root and a hit skips the whole subtree. Defaults to `DEFAULT_EXCLUDE` (the same built-in list the CLI applies).
  - `include?` `string[]`: allow list; a hit is taken only when one of these names appears between a root and the `node_modules`. Defaults to `[]` (no filtering). When a name matches both lists, `exclude` wins.
  - `home?` `string | null`: the home directory (one shared semantics for list abbreviation and the hidden-dir classification). Defaults to `os.homedir()`; `null` turns off the home-body guard and the hidden-dir classification.
  - `style?` `PathStyle`: path flavor; native by default (for tests).
  - `policy?` `SweepPolicy`: `{ releaseSuspects: boolean }`. Defaults to `{ releaseSuspects: false }`.
- Returns: `Sweeper`:
  - `options` `Readonly<ResolvedSweepOptions>`: the resolved read-only snapshot (defaults merged), handy for logging and audit.
  - `plan(options?)`: the read-only pass, see below.
  - `run(options?)`: the executing pass, see below.

Parameter errors (`roots` empty, or not a string array) **throw synchronously** at construction: fail fast, before any IO. Every asynchronous entry point below rejects its promise instead.

- The name lists take the same merge the CLI applies (`mergeNames`): duplicates dropped, and `node_modules` / `.git` silently removed since a name can never take effect there.
- `policy.releaseSuspects` is the library-side `--force`: it lets suspected install trees into the delete batch, releases only that category, and relaxes no guard invariant. Cross-device targets are unaffected either way.

```ts
const sweeper = createSweeper({
  roots, // required, non-empty: scan roots, absolute paths
  exclude, // default: DEFAULT_EXCLUDE (the same built-in list the CLI applies)
  include, // default: [] (no filtering)
  home, // default: os.homedir(); null turns off the home-body guard and the hidden-dir classification
  style, // posix / win32 path flavor; native by default (for tests)
  policy: { releaseSuspects: false },
});
```

### `sweeper.plan(options?): Promise<SweepPlan>`

The read-only pass: scan + measure + classify + device check + batch construction, zero deletions.

- `options?` `SweepPlanOptions`:
  - `onProgress?` `(event: SweepProgressEvent) => void`: progress callback; phase events plus every primitive event passed through.
  - `signal?` `AbortSignal`: cancellation signal, passed to each layer.
- Returns: `Promise<SweepPlan>`:
  - `roots` / `exclude` / `include` / `policy`: the effective inputs, echoed for audit (the names have already been through `mergeNames`).
  - `basis?` `SizeBasis`: the size basis of this run, present whenever the plan has any entries (it may differ from the per-entry bases when nothing was measured).
  - `entries` `SweepEntry[]`: one entry per hit that still exists at measure time (a hit gone by then produces no entry; see `gone` in `SizeResult`): `target` / `project` / `root` / `bytes?` / `basis?` / `kind` / `kindReason?` / `crossDevice?` / `unmeasuredCode?` / `unmeasuredReason?` / `inBatch`, plus `skipReason` and `skipNote` when out of the batch (the code and the human note travel on the entry, so a review table needs no join).
  - `batch` `string[]`: the targets that would be deleted, in list order.
  - `skipped` `SkippedTarget[]`: every out-of-batch target with its `reason` and `note`.
  - `warnings` `SweepWarning[]`: non-fatal scan / size warnings (`{ code, message, path?, errno? }`); `code` is a `SweepWarningCode`, the union of `ScanWarningCode` and `SizeWarningCode`.
  - `nameMatches`: `{ exclude: NameMatch[]; include: NameMatch[] }`, per-name hit counts for both lists, so a name that never matched (a typo) is visible before it matters.

```ts
const plan = await sweeper.plan({ onProgress, signal });
```

### `sweeper.run(options?): Promise<SweepReport>`

Runs the read-only pass first (an old plan is never replayed: every fact is re-decided against the disk as it is now), then sends the batch through the safety guard and removes it.

- `options?` `SweepRunOptions` (extends `SweepPlanOptions`, so `onProgress` and `signal` carry over):
  - `expectedBatch?` `readonly string[]`: the list that was approved. The delete surface becomes `expectedBatch` ∩ the live batch: targets that appeared since are not deleted (they show up in `drift.added`, with outcome `{ kind: 'not-expected' }`), and targets that vanished or got blocked since are not deleted either (`drift.removed`). It narrows the scope; it does not skip re-validation.
  - `staleTargets?` `'reject' | 'missing'` (default `'reject'`): what to do with targets that no longer exist when the guard runs. `'missing'` pulls them out of the batch and counts them as already achieved (success side) without aborting the batch (think: a concurrent cleaner got there first); the default keeps the conservative rule that one rejection aborts the whole batch with zero deletions. Only `GUARD_TARGET_MISSING` is eligible; unreadable targets and every other rejection still reject the batch.
- Returns: `Promise<SweepReport>`:
  - `status` `SweepRunStatus`: `'executed'` | `'rejected'` (whole batch) | `'nothing-to-do'` (empty batch).
  - `plan` `SweepPlan`: the live plan this run actually used. If it differs from an earlier `plan()`, this one wins, and the delta is in `drift`.
  - `validation?` `ValidationResult`: present once the run entered the guard (a whole-batch rejection has it, with zero deletions). `removal?` `RemovalResult`: the removal buckets (`removed` / `missing` / `failed` / `aborted`); absent when no removal was executed.
  - `entries` `SweepOutcomeEntry[]`: one per plan entry, same order (the entry plus `outcome`).
  - `stale` `string[]`: targets pulled out by `staleTargets: 'missing'`.
  - `drift?` `SweepDrift`: `{ added, removed }`, present when `expectedBatch` was given.
  - `releasedBytes` `number`: the measured bytes on the success side (removed + missing + stale).

`outcome` is the `EntryOutcome` discriminated union. Its `kind` is one of: `removed` / `missing` / `stale` (the success side: deleted, verified already gone, or never reached the delete surface), `failed`, `rejected`, `not-attempted` (a batch abort stopped before it), `not-expected` (outside `expectedBatch`), `skipped` (policy kept it out of the batch).

```ts
const report = await sweeper.run({
  onProgress,
  signal,
  expectedBatch,
  staleTargets,
});
```

### `isSuccessOutcome(outcome): boolean`

- `outcome` `EntryOutcome`
- Returns: `boolean`: `true` for the success side (`removed` / `missing` / `stale`), `false` for everything else (real failures and unprocessed entries).

Use it instead of hand-rolling `kind !== 'x' && kind !== 'y'`: the hand-rolled version silently misjudges the day a new kind ships, while the library function moves with the version.

### `summarizeReport(report): SweepSummary`

- `report` `SweepReport`
- Returns: `SweepSummary`:
  - `counts` `Record<EntryOutcomeKind, number>`: per-kind counts, always present, `0` by default.
  - `succeeded` `number`: `removed` + `missing` + `stale`.
  - `unprocessed` `number`: `skipped` + `rejected` + `not-attempted` + `not-expected`.
  - `failed` `number`: real failures.
  - `aborted` `boolean`: whether a batch abort happened (a `removal.aborted` exists).

### Success and exit codes

What counts as a failed run is a product decision, not a data fact, so there is no `ok` field to read; the library hands you the numbers and three common recipes:

```ts
const summary = summarizeReport(report);

// Strict (the CLI package's posture): anything unprocessed or failed makes the run a failure
const strict =
  summary.failed === 0 &&
  summary.unprocessed === 0 &&
  !summary.aborted &&
  report.status !== 'rejected';

// Relaxed (interactive tools): only real failures and a batch abort count
const relaxed =
  summary.failed === 0 && !summary.aborted && report.status !== 'rejected';

// Read-only pass: nothing counts as a failure, just report the numbers
```

## Primitive layer

Every primitive stands alone, imports without side effects, and prints nothing; async entries reject on failure. A read-only snapshot is just `scan` → `measure` → `classifyTarget`, and nothing on that path can delete.

### Scanning

#### `createScanner(): Scanner`

- Returns: `Scanner`:
  - `name` `string`: the candidate's neutral id (`'parallel'`), for benchmarks and logs to tell implementations apart.
  - `scan(options)`: see below.

#### `scanner.scan(options): Promise<ScanResult>`

- `options` `ScanOptions`:
  - `roots` `string[]` (required): scan roots (the caller guarantees absolute paths).
  - `exclude` `string[]` (required here: pass `[]` to disable): directory names; a match at any level between a root and a hit skips the whole subtree.
  - `include` `string[]` (required here): allow list; an empty array means no filtering; `exclude` wins when both match.
  - `signal?` `AbortSignal`: checked before each walk task starts; an abort rejects with `SweepError('CANCELLED')`.
  - `onProgress?` `(event: ScanProgressEvent) => void`: one `hit` event per hit.
- Returns: `Promise<ScanResult>`:
  - `hits` `ScanHit[]`: `{ project, target, root }[]`, ascending by `target`, deduped by real path. `root` is the first root (in input order) that reaches the hit, so grouping by root is deterministic and reproducible.
  - `warnings` `SweepWarning[]`: non-fatal scan warnings (`code` is a `ScanWarningCode`); a root that is missing or unreadable does not stop the walk.
  - `excludeMatches` / `includeMatches` `NameMatch[]`: `{ name, hits }[]`, always present (unmatched names are listed with `hits: 0`), so a name that never matched is visible before it matters.

```ts
const scan = await createScanner().scan({
  roots,
  exclude: [...DEFAULT_EXCLUDE], // required here: pass [] to disable
  include: [],
  signal,
  onProgress: (event) => ..., // one 'hit' event per hit
});
```

### Measuring

#### `createSizer(): Sizer`

- Returns: `Sizer`:
  - `name` `string`: the candidate's neutral id (`'du'` for the `du` fast path, `'js'` for the pure implementation), for benchmarks and logs.
  - `basis` `SizeBasis`: this instance's size basis, readable before the call.
  - `measure(targets, options?)`: see below.

#### `sizer.measure(targets, options?): Promise<SizeResult>`

- `targets` `string[]`: the paths to measure (typically `scan.hits.map((hit) => hit.target)`).
- `options?` `MeasureOptions`:
  - `signal?` `AbortSignal`: checked between targets (the `du` batch path checks before and after the batch).
  - `onProgress?` `(event: MeasureProgressEvent) => void`: one event per target (`measured` / `unmeasured` / `gone`).
- Returns: `Promise<SizeResult>`:
  - `entries` `SizeEntry[]`: measured targets (`{ target, bytes }`), ascending by `target`.
  - `basis` `SizeBasis`: `'disk-usage'` (the `du` fast path reports what the disk actually holds) or `'logical-bytes'` (the pure implementation reports logical bytes). One call, one basis; read it instead of guessing, before or after the call. Windows always measures `logical-bytes`.
  - `warnings` `SweepWarning[]`: non-fatal size warnings (`code` is a `SizeWarningCode`).
  - `unmeasured` `UnmeasuredEntry[]`: exists but cannot be measured (`{ target, code, reason }`, with `code` an `UnmeasuredCode`), ascending by `target`.
  - `gone` `string[]`: no longer exists at measure time, ascending by `target` (all three buckets order this way).

Every input target lands in exactly one bucket, and there is no fourth case: `entries` (measured), `unmeasured` (exists but cannot be measured), `gone` (no longer exists at measure time). That identity is a contract, so no `'unknown'` fallback branch is needed.

```ts
const size = await createSizer().measure(targets, { signal, onProgress });
```

### Classifying

#### `classifyTarget(target, options?): Classification`

- `target` `string`: a `node_modules` path.
- `options?` `ClassifyOptions`:
  - `style?` `PathStyle`: path flavor; native by default.
  - `home?` `string | null`: the home directory, for the hidden-dir form below. Defaults to `os.homedir()`; `null` turns that form off.
- Returns: `Classification`:
  - `kind` `TargetKind`: `'project'` | `'suspect-install-tree'`.
  - `reason?` `string`: the human phrase for a suspected install tree.

Pure path judgment, no IO, the same semantics as the CLI's list markers. The suspect forms, in order: an ancestor segment on the built-in list (plus `extensions` and `_npx`), a parent directory named `lib` (version managers keep global packages at `<version>/lib/node_modules`), and a `node_modules` under a hidden directory of the home directory. Comparisons fold case on every platform: an extra false positive lands on the safe side.

```ts
const { kind, reason } = classifyTarget(target, options?);
// kind: 'project' | 'suspect-install-tree'
```

### Safety guard

#### `validateTargets(targets, options): Promise<ValidationResult>`

- `targets` `string[]`: candidate targets.
- `options` `ValidateOptions`:
  - `roots` `string[]` (required): scan roots spelled as configured; the anchor check reads the spelling, not the real path.
  - `home?` `string | null`: the home-body guard; defaults to `os.homedir()`, `null` turns it off.
  - `style?` `PathStyle`: path flavor; native by default.
  - `signal?` `AbortSignal`: checked between targets.
- Returns: `Promise<ValidationResult>`:
  - `accepted` `string[]`: the removable targets: realpath-normalized, deduped, input order kept.
  - `rejected` `RejectedTarget[]`: `{ target, code, message, details? }` per refusal, aligned one-to-one with the input; `code` is a `GuardCode`, and `details?` a `RejectionDetails` (`{ errno?, root?, symlink? }`).
  - `mappings` `PathMapping[]`: `{ original, real }` pairs positionally aligned with `accepted`; show `original`, delete `real`, and stop aligning by index position by hand.

The invariants are judged per target with early exit: the leaf must be exactly `node_modules`; the target must exist and be readable (realpath); a root whose configured spelling chain carries a symlink rejects targets under it; filesystem root bodies and the home directory itself are refused; the real path must still end in `node_modules`, sit under a declared root, and be unique by real path. Rejections are **returned, not thrown**: the whole list is always processed, and every refusal carries a `code` to branch on.

### Device boundary

#### `findCrossDeviceTargets(targets, options): Promise<CrossDeviceEntry[]>`

- `targets` `string[]`
- `options` `CrossDeviceOptions`:
  - `roots` `string[]` (required): the owning root of a target is the most specific root that contains it.
  - `style?` `PathStyle`: path flavor; native by default.
  - `probe?` `DeviceProbe`: the device-number probe; defaults to `fsDeviceProbe` (inject to test cross-device flows on one filesystem).
- Returns: `Promise<CrossDeviceEntry[]>`: `{ target, kind }` entries in input order; an empty array when nothing is cross-device.

`kind: CrossDeviceKind` is `'on-path' | 'target-itself'`: either the mount point sits between the root and the target, or the target itself is the mount point. The two forms have different remedies (declare the mount point as its own root, or unmount the volume), so they are reported apart, and neither is released by policy. The result is an array rather than a `Map` so it survives `JSON.stringify` into an audit.

#### `crossDeviceIndex(entries): ReadonlyMap<string, CrossDeviceKind>`

- `entries` `readonly CrossDeviceEntry[]`
- Returns: `ReadonlyMap<string, CrossDeviceKind>`: the lookup view (the `has` / `get` shape the skip family takes as its second parameter).

```ts
const crossDevice = await findCrossDeviceTargets(targets, { roots });
const index = crossDeviceIndex(crossDevice); // the lookup view, for the skip family
```

#### `fsDeviceProbe(path, follow): Promise<number | null>`

- `path` `string`
- `follow` `boolean`: `true` takes `stat` semantics (resolve a final symlink), `false` takes `lstat` semantics (do not).
- Returns: `Promise<number | null>`: the `st_dev` of the path, or `null` when it cannot be read (the path is gone, or unreadable).

The default implementation of `DeviceProbe` (`(path: string, follow: boolean) => Promise<number | null>`). Both semantics exist because the two call sites need opposite readings: a root is read with `follow: true` (its resolved directory is the reference), a target with `follow: false` (aligned with `fs.rm`, which deletes a link, not through it).

### Path flavor and anchor checks

The guard's path layer, exposed for tests and custom flows. Every predicate takes its `PathStyle` explicitly and does no IO.

#### `POSIX_STYLE` / `WIN32_STYLE`

- `PathStyle` constants, ready for injection: `WIN32_STYLE` folds case before every comparison; `POSIX_STYLE` does not.
- `PathStyle`: `{ name: 'posix' | 'win32', ops: PathOps, caseInsensitive: boolean }`, where `PathOps` is the minimal path capability set (`sep` / `basename` / `relative` / `isAbsolute` / `parse` / `join` / `resolve` / `dirname`), satisfied by both `node:path` flavors.

#### `nativeStyle(): PathStyle`

- Returns: `PathStyle`: the flavor of the current platform; the default wherever a `style` option is omitted.

#### `dedupeKey(realPath, style): string`

- `realPath` `string`, `style` `PathStyle`
- Returns: `string`: the dedupe key of a real path (case-folded on win32).

#### `hasNodeModulesLeaf(target, style): boolean`

- `target` `string`, `style` `PathStyle`
- Returns: `boolean`: whether the last segment is exactly `node_modules` (case-insensitive on win32).

#### `insideAnyRoot(realPath, roots, style): boolean`

- `realPath` `string`, `roots` `string[]`, `style` `PathStyle`
- Returns: `boolean`: whether the path sits strictly under one of the roots, by `path.relative` semantics rather than string prefixes. Equal to a root, an escape (`..`) and an absolute result (a cross-drive path on win32) all count as outside.

#### `isFilesystemRootBody(realPath, style): boolean`

- `realPath` `string`, `style` `PathStyle`
- Returns: `boolean`: whether the path is the filesystem root itself (posix `/`, a drive root on win32).

#### `isHomeBody(realPath, home, style): boolean`

- `realPath` `string`, `home` `string | null`, `style` `PathStyle`
- Returns: `boolean`: whether the path is the home directory itself; `home: null` turns the check off.

#### `firstSymlinkOnAnchor(links): string | null`

- `links` `AnchorLink[]`: `{ path, symlink }` per chain level, `symlink` judged by `lstat` (a link to anywhere counts, dangling included: the fact of a link on the chain is the evidence).
- Returns: `string | null`: the path of the first symlink level, or `null` when every level is a real directory.

Anchors are judged on the configured spelling, not on realpath: realpath always reports the current resolution, so a name swapped for a link leaves no trace in it, while the spelling is where the swap shows. A system link (macOS `/var`, `/tmp`) hits the same check, on purpose: on the spelling layer, a user environment and an attack are indistinguishable, so both are rejected, and the fix is to spell the real path.

#### `anchorChainPaths(root, style): string[]`

- `root` `string`: a scan root or any write target; the endpoint itself is included, and the filesystem root is not (it cannot be a symlink).
- Returns: `string[]`: the level-by-level prefixes from the filesystem root's first child down to the endpoint. A relative spelling is first absolutized under the given style (the same frame the `lstat` calls read).

```ts
anchorChainPaths('/Users/x/ws/app', POSIX_STYLE);
// ['/Users', '/Users/x', '/Users/x/ws', '/Users/x/ws/app']
```

#### `firstSymlinkOnTarget(target): Promise<string | null>`

- `target` `string`
- Returns: `Promise<string | null>`: the first symlink on the chain, or `null` when the chain is all real directories or no level can be verified.

Collection (a per-level `lstat` walk) and detection in one call. The write side uses it before a write: a write follows a link and rewrites its target, so the same chain reading the delete side applies here, under one shared implementation.

#### `firstSymlinkOnRoot(root): Promise<string | null>`

- `root` `string`
- Returns: `Promise<string | null>`: the same implementation as `firstSymlinkOnTarget`, kept under its own name because the call site reads it as the trust anchor of a scan root.

### Removal

#### `removeTargets(targets, options): Promise<RemovalResult>`

- `targets` `string[]`: guard-validated targets (realpath form).
- `options` `RemovalOptions`:
  - `roots` `TrustRoot[]` (required): the trust roots that own the targets; a target under none of them aborts the batch.
  - `signal?` `AbortSignal`: checked between entries (the mid-`rm` rule is in [Progress and cancellation](#progress-and-cancellation)).
  - `onProgress?` `(event: RemovalProgressEvent) => void`: one event per entry leaving its bucket (`removed` / `missing` / `failed` / `aborted`).
- Returns: `Promise<RemovalResult>`:
  - `removed` `string[]`: deleted, input order kept.
  - `missing` `string[]`: `rm` reported ENOENT and a re-check confirmed the target itself is gone (counted as success, input order kept).
  - `failed` `TargetFailure[]`: `{ target, code, errno?, message, partialRisk }`, with `code` a `RemoveFailureCode`; `partialRisk: true` means content may be partially deleted, so flag it for human review (a `partialRisk: false` failure never attempted a deletion).
  - `aborted?` `AbortedBatch`: the guard's re-check failed mid-batch (`{ target, code, message, path? }`, with `code` an `AbortCode`); nothing from the abort point on was attempted.

Right before removing each target, the chain from the root down to the target's parent is re-verified component by component; a swap found mid-way stops the whole batch.

```ts
const removal = await removeTargets(accepted, {
  roots: await toTrustRoots(roots),
  signal,
  onProgress,
});
```

#### `toTrustRoots(roots): Promise<TrustRoot[]>`

- `roots` `string[]`: configured spellings.
- Returns: `Promise<TrustRoot[]>`: `{ configured, real }` pairs, one per root; `real` falls back to the spelling when realpath fails.

Pairs each configured root with its real path. The pairing is half of the anchor defense; do not hand-roll it.

#### `removeBatch(targets, options): Promise<BatchOutcome>`

The recommended write-side entry: safety guard + whole-batch rejection rule + trust pairing + removal in one call, and the caller never needs to know `TrustRoot` exists.

- `targets` `string[]`
- `options` `RemoveBatchOptions`:
  - `roots` `string[]` (required): scan roots spelled as configured; the guard judges containment and anchors on them, and the pairing helper feeds the delete side.
  - `home?` / `style?` / `signal?` / `onProgress?`: as in `validateTargets` and `removeTargets`.
  - `staleTargets?` `'reject' | 'missing'`: the same narrow tolerance as `sweeper.run`.
- Returns: `Promise<BatchOutcome>`: `{ status: 'rejected', rejected }` (zero deletions) or `{ status: 'executed', accepted, mappings, stale, removal }`.

```ts
const outcome = await removeBatch(targets, { roots, staleTargets });
```

### Skip set

For assembling the "what will not be deleted, and why" list yourself:

| You have / want                                   | Use                                           |
| ------------------------------------------------- | --------------------------------------------- |
| hits + size + classification, need candidates     | `toSkipCandidates(hits, size, options?)`      |
| "does this one enter the batch?" (single boolean) | `skipsBatch(entry, crossDevice, policy)`      |
| "why doesn't it?" (single code)                   | `skipReasonOf(entry, crossDevice, policy)`    |
| only the batch target list                        | `deletionBatch(entries, crossDevice, policy)` |
| the whole book: codes + notes + trailer           | `collectSkips(entries, crossDevice, policy)`  |
| the human label for a cross-device form           | `crossDeviceNote(kind)`                       |

#### `toSkipCandidates(hits, size, options?): SkipCandidate[]`

- `hits` `readonly ScanHit[]`: scan hits.
- `size` `SizeResult`: the size result for those hits.
- `options?` `ClassifyOptions`: classification options passed through.
- Returns: `SkipCandidate[]`: `{ target, bytes?, unmeasuredReason?, suspect }`, in hit order (targets in `size.gone` are produced as well, with `bytes` undefined).

#### `skipsBatch(entry, crossDevice, policy): boolean`

- `entry` `SkipCandidate`; `crossDevice` `ReadonlyMap<string, CrossDeviceKind>` (build it with `crossDeviceIndex`); `policy` `SweepPolicy`.
- Returns: `boolean`: whether the entry is held out of the delete batch.

#### `skipReasonOf(entry, crossDevice, policy): SkipReason | null`

- Same parameters.
- Returns: `SkipReason | null`, where `null` means the entry is in the batch. The check order is the priority: cross-device (both forms, unaffected by policy), then unmeasured, then suspected install tree (released only by `policy.releaseSuspects`).

#### `deletionBatch(entries, crossDevice, policy): string[]`

- Same parameters.
- Returns: `string[]`: the batch targets, in list order.

#### `collectSkips(entries, crossDevice, policy): SkipBook`

- Same parameters.
- Returns: `SkipBook`:
  - `entries` `ReadonlyArray<SkippedTarget>`: `{ target, reason, note }`, the code and the human note in one place (same source and values as `plan.skipped`).
  - `trailer` `string[]`: the closing lines, one per category, present only when that category appears.
  - `hints` `ReadonlyMap<string, string>`: target to trailing note, measured entries only.

`SkipCandidate.suspect` is required by design: it carries the entire "will the semantic gate stop this?" information, so that a bare size entry cannot slip into the write side and have the safety semantics silently default away. `toSkipCandidates` fills the field for you.

#### `crossDeviceNote(kind): string`

- `kind` `CrossDeviceKind`
- Returns: `string`: the human label for a cross-device form.

### Config (optional primitives)

The library never reads the platform config file on its own; these loaders exist for callers who want the CLI's config behavior inside their own tool:

#### `resolveConfigPath(options): ResolvedConfigPath`

- `options` `ResolveConfigPathOptions`:
  - `flag?` `string`: the `--config` flag value, the highest priority.
  - `platform?` `string`: platform id; defaults to `process.platform` (inject `'win32'` in tests).
  - `homedir?` `string`: defaults to `os.homedir()`.
  - `env?` `EnvTable`: environment-variable table; defaults to `process.env` (it carries `SWEEP_NM_CONFIG` and, on win32, `APPDATA` / `USERPROFILE`).
- Returns: `ResolvedConfigPath`: `{ path, source }` with `source: ConfigSource` being `'flag' | 'env' | 'platform-default'`.

Priority: the `--config` flag > the `SWEEP_NM_CONFIG` env > the platform default. The platform default is `~/.config/sweep-node-modules/config.json`; on win32, `%APPDATA%\sweep-node-modules\config.json`, falling back to `USERPROFILE\AppData\Roaming` when `APPDATA` is unset.

#### `loadConfig(path): Promise<LoadConfigResult>`

- `path` `string`
- Returns: `Promise<LoadConfigResult>`: `{ state: 'ok', config }` or `{ state: 'absent' }`. A missing file is a normal state (the wizard branches on it); a corrupted file or a read failure throws `SweepError` (`CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_READ_FAILED`).

In the `ok` case, `Config` carries `roots` (required) / `exclude` / `include`: an omitted `exclude` field defaults to `DEFAULT_EXCLUDE`, an omitted `include` to `[]`, while an explicitly written empty array stands for taking over the list.

#### `loadResolvedConfig(resolved): Promise<LoadConfigResult>`

- `resolved` `ResolvedConfigPath`
- Returns: the same shape as `loadConfig`.
- Stricter when the source is explicit: an `--config` flag or `SWEEP_NM_CONFIG` path that does not exist throws (`SweepError('CONFIG_ABSENT')`) instead of returning `absent`, so a mistyped path cannot silently degrade into "no config". The platform-default source keeps the soft behavior.

#### `mergeNames(configNames, cliNames): string[]`

- `configNames` `string[]`, `cliNames` `string[]`
- Returns: `string[]`: config names first, CLI names appended, deduped across sources (first occurrence wins), with `node_modules` and `.git` silently dropped (neither can ever take effect in a name list).

#### `DEFAULT_EXCLUDE`

- `readonly string[]`: the built-in exclusion list: package-manager and version-manager install trees, editor extension directories, and system / application data roots.

### Display helpers

#### `formatBytes(bytes): string`

- `bytes` `number`
- Returns: `string`: the list's human-readable size, stepping through `B` / `KB` / `MB` / `GB` / `TB` by 1024; one decimal, dropped for integer values.

#### `sanitizeLine(text): string`

- `text` `string`
- Returns: `string`: control characters stripped (C0 incl. ESC and DEL, C1, bidi controls, zero-width and BOM), remaining whitespace (newlines included) folded to single spaces, ends trimmed.

#### `sanitizeOutputLine(text): string`

- `text` `string`
- Returns: `string`: `sanitizeLine` except that the indentation at the very start of the input is kept (call it once per line to preserve per-line indentation, the tool's own hierarchy device); inner whitespace folds as usual.

`sanitizeLine` / `sanitizeOutputLine` are the single shared implementation of output sanitization. Run external data (paths, names) through these before it reaches any output surface; the CLI does, and no second implementation should exist.

## Errors and codes

One rule decides the channel: **failures that can be listed are returned; failures that stop everything are thrown.**

| Channel      | What goes there                                                                                                | Where it shows up                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Return value | Expected domain outcomes: guard rejections, removal failures, batch aborts, unmeasurable targets, policy skips | `rejected` / `failed` / `aborted` / `unmeasured` / `gone` / `skipped` |
| Throw        | Cannot start or cannot continue: bad arguments, broken config, cancellation                                    | Sync entries throw; async entries reject                              |

### `SweepError`

- `class SweepError extends Error`: `{ name: 'SweepError', code, message, details? }`.
  - `code` `SweepErrorCode`: `CONFIG_READ_FAILED` / `CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_ABSENT` / `INVALID_ARGUMENT` / `CANCELLED`.
  - `message` `string`: the readable text (see the code rules below).
  - `details?` `SweepErrorDetails`: a discriminated union keyed by `code`: `{ path, errno? }`, `{ path }`, `{ path, field }`, `{ path, source }`, `{ field }`, `{ phase, partial? }`.
- Constructor: `new SweepError(code, message, details?)`.
- The only class in the package: every other instance comes from a `createXxx()` factory, and every domain datum is a plain object.

### `isSweepError(value): value is SweepError`

- `value` `unknown`
- Returns: `value is SweepError`: a shape-based check (a `name` of `SweepError` plus a known `code`; the `Error` shape itself is not required), not a class check.

In packaged or multi-instance environments (where two copies of the library can coexist in one process), `instanceof SweepError` gives false negatives; use the shape-based guard there. Unexpected internal exceptions are not wrapped: they bubble unchanged.

### Code families

Domain codes by family (the full trigger table per code lives in the [API surface design](docs/designs/api-surface.md)):

```text
Guard (validateTargets → rejected[].code)
  GUARD_LEAF_NOT_NODE_MODULES · GUARD_TARGET_MISSING · GUARD_TARGET_UNREADABLE ·
  GUARD_REALPATH_FAILED · GUARD_ROOT_ANCHOR_SYMLINK · GUARD_FILESYSTEM_ROOT_BODY ·
  GUARD_HOME_BODY · GUARD_REAL_LEAF_NOT_NODE_MODULES · GUARD_OUTSIDE_ROOTS ·
  GUARD_DUPLICATE_TARGET

Removal failures (RemovalResult.failed[].code)
  REMOVE_FAILED · REMOVE_ENOENT_SURVIVOR · REVIEW_UNVERIFIED · REVIEW_COMPONENT_VANISHED

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

Rules that matter:

- **Branch on `code` and `details`; never parse `message`.** `message` is plain language for humans (currently Chinese). To localize, drop `message` and build your own text from `code` + `details`.
- The three realpath rejection codes share one `message` on purpose; they are told apart by `code` and `details.errno` (`ENOENT` / `EACCES` / the rest), because their handling points in opposite directions: "no longer exists" is tolerable, "unreadable" is not.
- Codes are frozen once shipped: new ones are added, none are re-pointed, no value is recycled. Keep a `default` branch in a `switch` and record the raw value rather than folding it into "other".

## Progress and cancellation

Pass `onProgress` and / or `signal` to `plan` / `run`, or to any primitive that supports them (`scan`, `measure`, `validateTargets`, `removeTargets`, `removeBatch`).

Event kinds: `phase` (start / done per pipeline phase, `SweepPhase`: `scan` · `measure` · `classify` · `device` · `plan` · `validate` · `remove`), the primitive events (`hit` · `measured` · `unmeasured` · `skipped` · `removed` · `failed` · `aborted` · `warning`), and a terminal event: a `plan()` stream always ends with `plan-done` (carrying the full plan), a `run()` stream always ends with `done` (carrying the run status). Nothing follows a terminal event; on cancellation the stream ends with a throw instead.

- Callbacks run synchronously and are not awaited; a throwing callback bubbles and aborts the call (no swallowing).
- Events are high-frequency and not order-bound (concurrent completion order); results are order-bound (hits and the three size buckets ascending by `target`; removal buckets and `stale` keep input order).
- Do not call the same `Sweeper` instance from inside a callback, and do not run two calls on one instance at once (reentrancy is undefined). Factories do no scan- or delete-level IO (a size factory probes for `du` once), so a second instance costs next to nothing.
- Cancellation is checked between items and at phase boundaries; the call rejects with `SweepError('CANCELLED')`. Removal never interrupts a single `rm` midway (that would only manufacture a new half-deleted state): cancellation lands between targets, and the error carries `details.partial` with what was already done. Other phases carry `details.phase` and no partial results.

The library has no `watch()` async iterator: the CLI consumes callbacks directly, and that is the common case. The design doc carries a ~20-line bridge reference for editor-style hosts that want a `for await` loop.

## Safety model

> The character of this package in one line: when anything is uncertain, the default is not to delete.

- **Importing does nothing; `plan()` deletes nothing.** Deletion only happens through an explicit `run()` / `removeTargets()` / `removeBatch()` call.
- **Name and location both decide.** Only directories named exactly `node_modules` are eligible, and only under the roots you declared; containment is judged by path hierarchy, not string prefixes, so `..` traversal and lookalike paths are rejected. Filesystem root bodies and the home directory itself are refused outright.
- **Real paths, or the batch is refused.** The delete side requires roots (and their ancestors) to be symlink-free; hitting one rejects the whole batch and points at the link. The read side still scans through a symlinked root. The threshold follows reversibility: the irreversible step gets no benefit of the doubt.
- **One rejection stops the whole batch** (zero deletions) rather than letting the rest through; right before removal, the path from the root down to the target's parent is re-verified component by component, and a swap mid-way halts the remaining deletions. The single narrow exception is an explicit `staleTargets: 'missing'`, and it only tolerates "the target is already gone": it relaxes no invariant and never adds a target to the delete surface.
- **Two categories stay out of the batch**: suspected install trees (released only by an explicit `policy.releaseSuspects`) and cross-device targets (not released by policy at all; fix the layout instead: declare the mount point as its own root, or unmount the volume). Targets whose size cannot be measured are never deleted: keep rather than guess.
- **External data is sanitized before it reaches output.** `sanitizeLine` / `sanitizeOutputLine` are the single implementation every output surface shares; use them, not a copy.

## Data shapes and stability

- All **persisted / audit** domain data is plain objects and arrays: `JSON.stringify` is lossless (no classes, no `Map` / `Set`, no functions). Query helpers (`SkipBook.hints`, `crossDeviceIndex()`) return `ReadonlyMap`; they are lookup surfaces, not audit data. The one class in the package is `SweepError`.
- Time-free by design: no timestamps on domain data (the only clock reading is `elapsedMs` on progress events). A shape written into today's JSONL audit reads back as tomorrow's decision input.
- Deterministic results: `hits` and the three size buckets ascending by target; removal buckets and `stale` keep input order; scan dedupes by real path. Event order is explicitly not promised.
- No side effects at import; no stdout / stderr writes; no TTY probing (the interactive wizard is a CLI-only surface).

| Tier                      | What                                                                                                   | The promise                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Frozen                    | Domain type field names, `code` values, `SkipReason` values, function signatures, `EntryOutcome` kinds | A breaking change takes a major version      |
| Frozen, additions allowed | Option objects (`SweepOptions`, `SweepRunOptions`, `MeasureOptions`, etc.)                             | New fields are a minor                       |
| Evolving                  | `message` / `reason` / `note` wording                                                                  | Not stable verbatim                          |
| Not promised              | Progress event order, order inside `warnings`                                                          | Result order is promised, event order is not |

## Development

Environment setup, common commands, dual-runtime verification, and commit hooks: see the [development guide](../../docs/development.md). This package lives in the `packages/sweep-node-modules` directory of that repository.

## Documentation

- [Engineering documentation index](../../docs/README.md)
- [API surface design](docs/designs/api-surface.md): the authoritative export surface, error codes, and behavior contracts behind this page
- [Safety guardrails](../../docs/safety-guardrails.md), the full account (in Chinese)
