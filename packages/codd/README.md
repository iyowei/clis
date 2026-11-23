# @iyowei/codd

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/codd)](https://www.npmjs.com/package/@iyowei/codd)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/codd)](https://www.npmjs.com/package/@iyowei/codd)
![node](https://img.shields.io/node/v/@iyowei/codd)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Programmable API and template assets for template-driven MongoDB 9.0 provisioning on Podman (Linux / macOS) and Kubernetes (Helm): deterministic hardware sizing formulas, strict manifest validation, and 100% collision-free fingerprint isolation.

This package is a **pure programmable library** (no `bin` command). For the interactive terminal wizard and `codd` CLI command, install [`@iyowei/codd-cli`](https://www.npmjs.com/package/@iyowei/codd-cli).

## Requirements

- **Dual runtime**: Bun or Node.js (`>= 22.18.0`, matching `engines.node`).
- Zero third-party runtime dependencies (built-in runtime APIs only).
- Full TypeScript declarations shipped alongside the ESM bundle.

## Installation

```shell
npm install @iyowei/codd
bun add @iyowei/codd
```

## Quick start (TypeScript)

```ts
import {
  type DeployManifest,
  computeSizing,
  generateBundle,
  validateManifest,
} from '@iyowei/codd';

const manifest: DeployManifest = {
  mode: 'single',
  name: 'shop',
  hardware: {
    cpuCores: 4,
    memoryGb: 8,
    diskGb: 100,
    workload: 'balanced',
  },
  apps: [
    { db: 'orders', user: 'ordersu' },
    { db: 'billing', user: 'billu' },
  ],
  nodes: [
    {
      name: 'main',
      os: 'linux',
      bindIp: '127.0.0.1',
      backupDir: '/home/ops/srv/backups',
    },
  ],
};

// 1. Validate manifest strictly (throws ConfigError on invalid input or injection)
const warnings = validateManifest(manifest);

// 2. Preview deterministic hardware sizing formulas
const sizing = computeSizing(manifest.hardware!);
console.log(sizing.formulaSummary, warnings);

// 3. Emit collision-free deployment bundle(s) and lock state in .codd-state/
const result = generateBundle({
  workDir: process.cwd(),
  manifest,
  outDir: './dist',
});

console.log('Fingerprint:', result.fingerprint);
console.log('Bundles:', result.bundleDirs);
console.log('Credentials (0600):', result.credentialsFile);
```

## Public API surface

| Export                                                                              | Purpose                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateBundle(options)`                                                           | End-to-end orchestrator: validate manifest, derive sizing, lock state/credentials, render Podman or Kubernetes (Helm) bundle(s)                                                         |
| `validateManifest(manifest)`                                                        | Strict whitelist & DNS-1123 validator (rejects unknown fields, path traversal, and Shell/YAML/XML injection)                                                                            |
| `computeSizing(hardware)`                                                           | Deterministic formula engine deriving WiredTiger cache, connection ceiling, oplog, zstd/snappy compression, and `ulimit`                                                                |
| `recommendSafePort(rng?)` / `digitalRoot(n)`                                        | Recommend a 5-digit safe port (`10002-29997`) whose digital root is `3 / 6 / 9`, excluding common scan and system port ranges                                                           |
| `renderTemplate(name, raw, vars)`                                                   | Strict `{{TOKEN}}` template renderer rejecting missing keys or leftover braces                                                                                                          |
| `parseSshInput(raw)` / `resolveServerBackupDir(...)` / `resolveServerStackDir(...)` | SSH command sanitizer and idempotent fingerprint-scoped path builders                                                                                                                   |
| `loadOrUpdateState(...)` / `prepareStateDir(...)`                                   | Idempotent `.codd-state/` credential & fingerprint state machine                                                                                                                        |
| `resolveTemplateRoot(...)` / `copyTemplateFile(...)` / `readTemplateFile(...)`      | Bundled template asset locator (honors `overrideDir` > `CODD_TEMPLATE_DIR` > `assets/template/`, and transparently restores carrier names `_dockerignore` / `env.tmpl` / `_helmignore`) |
| `assertBunEngineCompatible(range, current)`                                         | Pure helper to explicitly check Bun version compatibility against a target semver range (`>=`, `^`, `~`, or bare floor treated as `>=`)                                                 |
| `ConfigError` / `SizingError` / `TemplateRenderError`                               | Structured domain errors                                                                                                                                                                |

> Fine-grained helpers and validation constants (`HARDWARE_BOUNDS`, `withStateLock`, `randomAlnumSecret`, `validateAppInput`, etc.) are exported from the same root entry; see the bundled `dist/index.d.ts` for the complete typed signature list.

## Environment variables

- `CODD_TEMPLATE_DIR`: Optional absolute or relative directory overriding the bundled `assets/template/` root when `generateBundle({ templateDir })` / `resolveTemplateRoot(overrideDir)` is not explicitly passed.

## Development

Environment setup, monorepo scripts, and CI gates: see the [development guide](https://github.com/iyowei/clis/blob/main/docs/development.md).

## Documentation

- [Engineering documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [codd documentation & ADRs](https://github.com/iyowei/clis/blob/main/packages/codd/docs/README.md)
- [Generator & formulas design](https://github.com/iyowei/clis/blob/main/packages/codd/docs/designs/generator-and-formulas.md)
- [CLI companion package (`@iyowei/codd-cli`)](https://github.com/iyowei/clis/tree/main/packages/codd-cli)
