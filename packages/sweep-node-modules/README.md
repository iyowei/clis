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
- Zero third-party runtime dependencies: built-in runtime capabilities only (see [ADR 0003](../../docs/adrs/0003-zero-runtime-deps.md)).
- Windows, macOS, and Linux (see [ADR 0007](../../docs/adrs/0007-platform-portability.md)).
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

Parameter errors (`roots` empty, or not a string array) **throw synchronously** at construction: fail fast, before any IO. Every asynchronous entry point below rejects its promise instead.

- `exclude` / `include` match directory names at any level between a root and a hit; an `exclude` match skips the whole subtree. When a name matches both lists, `exclude` wins.
- `policy.releaseSuspects` is the library-side `--force`: it lets suspected install trees into the delete batch, releases only that category, and relaxes no guard invariant. Cross-device targets are unaffected either way.
- `sweeper.options` is the resolved read-only snapshot (defaults merged), handy for logging and audit.

### `plan()`: the read-only pass

```ts
const plan = await sweeper.plan({ onProgress, signal });
```

Scan + measure + classify + device check + batch construction, zero deletions. `SweepPlan`:

- `entries`: one `SweepEntry` per hit: `target` / `project` / `root` / `bytes?` / `basis?` / `kind` / `kindReason?` / `crossDevice?` / `unmeasuredCode?` / `unmeasuredReason?` / `inBatch`, plus `skipReason` and `skipNote` when out of the batch (the code and the human note travel on the entry, so a review table needs no join).
- `batch`: the targets that would be deleted, in list order.
- `skipped`: every out-of-batch target with its `reason` and `note`.
- `warnings`: non-fatal scan / size warnings (`{ code, message, path?, errno? }`).
- `nameMatches`: per-name hit counts for both lists, so a name that never matched (a typo) is visible before it matters.
- `basis`: the size basis of this run, when anything was measured.

### `run()`: the executing pass

```ts
const report = await sweeper.run({
  onProgress,
  signal,
  expectedBatch,
  staleTargets,
});
```

`run()` re-runs the read-only pass first (an old plan is never replayed: every fact is re-decided against the disk as it is now), then sends the batch through the safety guard and removes it. Two knobs on top of `plan`'s options:

- `expectedBatch`: the list that was approved. The delete surface becomes `expectedBatch` ∩ the live batch: targets that appeared since are not deleted (they show up in `drift.added`, with outcome `{ kind: 'not-expected' }`), and targets that vanished or got blocked since are not deleted either (`drift.removed`). It narrows the scope; it does not skip re-validation.
- `staleTargets: 'reject' | 'missing'` (default `'reject'`): what to do with targets that no longer exist when the guard runs. `'missing'` pulls them out of the batch and counts them as already achieved (success side) without aborting the batch (think: a concurrent cleaner got there first); the default keeps the conservative rule that one rejection aborts the whole batch with zero deletions. Only `GUARD_TARGET_MISSING` is eligible; unreadable targets and every other rejection still reject the batch.

`SweepReport`:

- `status`: `'executed'` | `'rejected'` (whole batch) | `'nothing-to-do'` (empty batch).
- `plan`: the live plan this run actually used. If it differs from an earlier `plan()`, this one wins, and the delta is in `drift`.
- `validation?` / `removal?`: the guard result and the removal buckets (`removed` / `missing` / `failed` / `aborted`); absent when nothing was executed.
- `entries`: one `SweepOutcomeEntry` per plan entry, same order (the entry plus `outcome`).
- `stale`: targets pulled out by `staleTargets: 'missing'`.
- `drift?`: `{ added, removed }`, present when `expectedBatch` was given.
- `releasedBytes`: the measured bytes on the success side (removed + missing + stale).

`outcome.kind` is one of: `removed` / `missing` / `stale` (the success side: deleted, verified already gone, or never reached the delete surface), `failed`, `rejected`, `not-attempted` (a batch abort stopped before it), `not-expected` (outside `expectedBatch`), `skipped` (policy kept it out of the batch).

### Success and exit codes

`isSuccessOutcome(outcome)` and `summarizeReport(report)` carry the library's own definition of the success side (`removed` / `missing` / `stale`) and the per-kind counts. Use them instead of hand-rolling `kind !== 'x' && kind !== 'y'`: the hand-rolled version silently misjudges the day a new kind ships, while the library function moves with the version.

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

`SweepSummary` fields: `counts` (per `EntryOutcome` kind, always present, 0 by default), `succeeded`, `unprocessed`, `failed`, `aborted`.

## Primitive layer

Every primitive stands alone, imports without side effects, and prints nothing; async entries reject on failure. A read-only snapshot is just `scan` → `measure` → `classifyTarget`, and nothing on that path can delete.

### Scanning

```ts
const scan = await createScanner().scan({
  roots,
  exclude: [...DEFAULT_EXCLUDE], // required here: pass [] to disable
  include: [],
  signal,
  onProgress: (event) => ..., // one 'hit' event per hit
});
```

- `Scanner.name`: the candidate's neutral id (`'parallel'`).
- `ScanResult.hits`: `{ project, target, root }[]`, ascending by `target`, deduped by real path. `root` is the first root (in input order) that reaches the hit, so grouping by root is deterministic and reproducible.
- `excludeMatches` / `includeMatches`: `{ name, hits }[]`, always present (unmatched names are listed with `hits: 0`).

### Measuring

```ts
const size = await createSizer().measure(targets, { signal, onProgress });
```

- `Sizer.basis` / `SizeResult.basis`: `'disk-usage'` (the `du` fast path reports what the disk actually holds) or `'logical-bytes'` (the pure implementation reports logical bytes). One call, one basis; read it instead of guessing, before or after the call. Windows always measures `logical-bytes`.
- Every input target lands in exactly one bucket, and there is no fourth case: `entries` (measured: `{ target, bytes }`, ascending), `unmeasured` (exists but cannot be measured: `{ target, code, reason }`), `gone` (no longer exists at measure time). That identity is a contract, so no `'unknown'` fallback branch is needed.

### Classifying

```ts
const { kind, reason } = classifyTarget(target, options?);
// kind: 'project' | 'suspect-install-tree'
```

Pure path judgment, no IO, the same semantics as the CLI's list markers.

### Safety guard

```ts
const { accepted, rejected, mappings } = await validateTargets(targets, {
  roots,
  home,
  style,
  signal,
});
```

- `accepted`: the removable targets: realpath-normalized, deduped, input order kept.
- `rejected`: `{ target, code, message, details? }` per refusal, aligned one-to-one with the input.
- `mappings`: `{ original, real }` pairs positionally aligned with `accepted`; show `original`, delete `real`, and stop aligning by index position by hand.

```ts
const crossDevice = await findCrossDeviceTargets(targets, { roots });
const index = crossDeviceIndex(crossDevice); // the lookup view, for the skip family
```

`findCrossDeviceTargets` returns an array rather than a `Map` so it survives `JSON.stringify` into an audit; `crossDeviceIndex` gives the `has` / `get` view where you need one.

### Removal

```ts
const removal = await removeTargets(accepted, {
  roots: await toTrustRoots(roots),
  signal,
  onProgress,
});
```

- `toTrustRoots(roots)`: pairs each configured root with its real path. The pairing is half of the anchor defense; do not hand-roll it.
- `RemovalResult`: `removed` / `missing` (verified already gone, counted as success) / `failed` (`{ target, code, errno?, message, partialRisk }`; `partialRisk: true` means content may be partially deleted, so flag it for human review) / `aborted?` (the guard's re-check failed mid-batch; nothing from the abort point on was attempted).

```ts
const outcome = await removeBatch(targets, { roots, staleTargets });
```

`removeBatch` is the recommended write-side entry: safety guard + whole-batch rejection rule + trust pairing + removal in one call, and the caller never needs to know `TrustRoot` exists. `BatchOutcome` is either `{ status: 'rejected', rejected }` (zero deletions) or `{ status: 'executed', accepted, mappings, stale, removal }`.

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

`SkipCandidate.suspect` is required by design: it carries the entire "will the semantic gate stop this?" information, so that a bare size entry cannot slip into the write side and have the safety semantics silently default away. `toSkipCandidates` fills the field for you.

### Config (optional primitives)

The library never reads the platform config file on its own; these loaders exist for callers who want the CLI's config behavior inside their own tool:

- `resolveConfigPath(options)` → `{ path, source }` with `source: 'flag' | 'env' | 'platform-default'`.
- `loadConfig(path)` / `loadResolvedConfig(resolved)` → `{ state: 'ok', config }` or `{ state: 'absent' }`; a corrupted file throws `SweepError`.
- `mergeNames(configNames, cliNames)`: the same merge the CLI applies (dedupe, and drop names that can never apply).
- `DEFAULT_EXCLUDE`: the built-in exclusion list.

### Path flavor and display helpers

- `POSIX_STYLE` / `WIN32_STYLE` / `nativeStyle()` and the pure predicates (`dedupeKey`, `hasNodeModulesLeaf`, `insideAnyRoot`, `isFilesystemRootBody`, `isHomeBody`, `firstSymlinkOnAnchor`, etc.): the guard's path layer, exposed for tests and custom flows.
- `formatBytes(bytes)`: the list's human-readable size (`1.2 MB`; integer values drop the decimal).
- `sanitizeLine(text)` / `sanitizeOutputLine(text)`: the single shared implementation of output sanitization (strip control bytes, fold whitespace; the multi-line variant keeps per-line indentation). Run external data (paths, names) through these before it reaches any output surface; the CLI does, and no second implementation should exist.

## Errors and codes

One rule decides the channel: **failures that can be listed are returned; failures that stop everything are thrown.**

| Channel      | What goes there                                                                                                | Where it shows up                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Return value | Expected domain outcomes: guard rejections, removal failures, batch aborts, unmeasurable targets, policy skips | `rejected` / `failed` / `aborted` / `unmeasured` / `gone` / `skipped` |
| Throw        | Cannot start or cannot continue: bad arguments, broken config, cancellation                                    | Sync entries throw; async entries reject                              |

Errors the library reports are `SweepError`: `{ name: 'SweepError', code, message, details? }`. In packaged or multi-instance environments (where two copies of the library can coexist in one process), use the shape-based `isSweepError(value)` instead of `instanceof`. Unexpected internal exceptions are not wrapped: they bubble unchanged.

- `SweepErrorCode`: `CONFIG_READ_FAILED` / `CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_ABSENT` / `INVALID_ARGUMENT` / `CANCELLED`.
- `details` is a discriminated union keyed by `code`: `{ path, errno? }`, `{ path }`, `{ path, field }`, `{ path, source }`, `{ field }`, `{ phase, partial? }`.

Domain codes by family (the full trigger table per code lives in the [API surface design](../../docs/designs/api-surface.md)):

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
  SIZE_SUBPATH_FAILED · SIZE_TARGET_VANISHED

Skip reasons (SweepEntry.skipReason / SkippedTarget.reason)
  suspect-install-tree · cross-device:on-path · cross-device:target-itself · unmeasured
```

Rules that matter:

- **Branch on `code` and `details`; never parse `message`.** `message` is plain language for humans (currently Chinese). To localize, drop `message` and build your own text from `code` + `details`.
- The three realpath rejection codes share one `message` on purpose; they are told apart by `code` and `details.errno` (`ENOENT` / `EACCES` / the rest), because their handling points in opposite directions: "no longer exists" is tolerable, "unreadable" is not.
- Codes are frozen once shipped: new ones are added, none are re-pointed, no value is recycled. Keep a `default` branch in a `switch` and record the raw value rather than folding it into "other".

## Progress and cancellation

Pass `onProgress` and / or `signal` to `plan` / `run`, or to any primitive that supports them (`scan`, `measure`, `validateTargets`, `removeTargets`).

Event kinds: `phase` (start / done per pipeline phase: `scan` · `measure` · `classify` · `device` · `plan` · `validate` · `remove`), the primitive events (`hit` · `measured` · `unmeasured` · `skipped` · `removed` · `failed` · `aborted` · `warning`), and a terminal event: a `plan()` stream always ends with `plan-done` (carrying the full plan), a `run()` stream always ends with `done` (carrying the run status). Nothing follows a terminal event; on cancellation the stream ends with a throw instead.

- Callbacks run synchronously and are not awaited; a throwing callback bubbles and aborts the call (no swallowing).
- Events are high-frequency and not order-bound (concurrent completion order); results are order-bound (hits ascending, buckets keep input order).
- Do not call the same `Sweeper` instance from inside a callback, and do not run two calls on one instance at once (reentrancy is undefined). Factories do no IO, so a second instance costs nothing.
- Cancellation is checked between items and at phase boundaries; the call rejects with `SweepError('CANCELLED')`. Removal never interrupts a single `rm` midway (that would only manufacture a new half-deleted state): cancellation lands between targets, and the error carries `details.partial` with what was already done. Other phases carry `details.phase` and no partial results.

The library has no `watch()` async iterator: the CLI consumes callbacks directly, and that is the common case. The design doc carries a ~20-line bridge reference for editor-style hosts that want a `for await` loop.

## Safety model

> The character of this package in one line: when anything is uncertain, the default is not to delete.

- **Importing does nothing; `plan()` deletes nothing.** Deletion only happens through an explicit `run()` / `removeTargets()` / `removeBatch()` call.
- **Name and location both decide.** Only directories named exactly `node_modules` are eligible, and only under the roots you declared; containment is judged by path hierarchy, not string prefixes, so `..` traversal and lookalike paths are rejected. Filesystem root bodies and the home directory itself are refused outright.
- **Real paths, or the batch is refused.** The delete side requires roots (and their ancestors) to be symlink-free; hitting one rejects the whole batch and points at the link. The read side still scans through a symlinked root. The threshold follows reversibility: the irreversible step gets no benefit of the doubt.
- **One rejection stops the whole batch** (zero deletions) rather than letting the rest through; right before removal, the path from the root down to the target's parent is re-verified component by component, and a swap mid-way stops the batch. The single narrow exception is an explicit `staleTargets: 'missing'`, and it only tolerates "the target is already gone": it relaxes no invariant and never adds a target to the delete surface.
- **Two categories stay out of the batch**: suspected install trees (released only by an explicit `policy.releaseSuspects`) and cross-device targets (not released by policy at all; fix the layout instead: declare the mount point as its own root, or unmount the volume). Targets whose size cannot be measured are never deleted: keep rather than guess.
- **External data is sanitized before it reaches output.** `sanitizeLine` / `sanitizeOutputLine` are the single implementation every output surface shares; use them, not a copy.

## Data shapes and stability

- All domain data is plain objects and arrays: `JSON.stringify` is lossless (no classes, no `Map` / `Set`, no functions). The one class in the package is `SweepError`.
- Time-free by design: no timestamps on domain data (the only clock reading is `elapsedMs` on progress events). A shape written into today's JSONL audit reads back as tomorrow's decision input.
- Deterministic results: `hits` ascending by target, buckets keep input order, scan dedupes by real path. Event order is explicitly not promised.
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
- [API surface design](../../docs/designs/api-surface.md): the authoritative export surface, error codes, and behavior contracts behind this page
- The CLI package: [@iyowei/sweep-node-modules-cli](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)
- [Safety guardrails](../../docs/safety-guardrails.md), the full account (in Chinese)
