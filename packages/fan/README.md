# @iyowei/fan

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/fan)](https://www.npmjs.com/package/@iyowei/fan)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/fan)](https://www.npmjs.com/package/@iyowei/fan)
![node](https://img.shields.io/node/v/%40iyowei%2Ffan)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Programmable API for reading and manually controlling Apple Silicon / Mac fan speeds via AppleSMC IOKit with zero third-party runtime dependencies, requiring no Macs Fan Control installation. Mutating operations (`set`, `max`, `min`, `auto`) automatically persist target configurations to `/Library/Application Support/iyowei-fan/state.json` by default (unless `persist: false`), and manual speed commands (`set`, `max`, `min`) automatically ensure the `com.iyowei.fan` `LaunchDaemon` is installed and up to date—releasing fans back to system `auto` on lid close (without an external display), system sleep, and background `DarkWake`, then restoring saved speeds on lid open / wake and boot.

This package is a **pure programmable library** (no `bin` command). For the CLI tool (`fan`), install [`@iyowei/fan-cli`](https://www.npmjs.com/package/@iyowei/fan-cli) (`fan max`, `fan set 4000`, `fan set 30%`, `fan auto`).

## Requirements

- **Dual runtime**: Bun or Node.js (`>= 22.18.0`, matching `engines.node`).
- **Host platform**: macOS with AppleSMC (`IOKit`) and system `/usr/bin/python3`; write operations (`set`, `max`, `min`, `auto`, `apply`) and daemon installation invoke `/usr/bin/sudo` when not already running as root.
- **Zero third-party runtime dependencies**: uses built-in `node:` modules and macOS system frameworks only.

## Installation

```shell
npm install @iyowei/fan
bun add @iyowei/fan
```

## Quick start

```ts
import { createFanController, isFanError } from '@iyowei/fan';

const fan = createFanController();

try {
  const report = fan.status();
  for (const item of report.fans) {
    console.log(
      `Fan ${item.index}: ${item.actualRpm} RPM (target ${item.targetRpm}, ${item.mode})`,
    );
  }
} catch (error) {
  if (isFanError(error)) {
    console.error(error.code, error.message);
  }
}
```

## Public API surface

| Export                                                                                               | Purpose                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createFanController(options?)`                                                                      | Create controller with `status`, `set`, `max`, `min`, `auto`, and `apply` (injectable `transport`, `stateStore`, `ensureDaemon`, `platform`; pre-validates `state.json` before persisting writes, surfaces `STATE_CORRUPT` warnings on read-only paths, and attempts hardware rollback on non-permission state write errors) |
| `createAppleSmcTransport(overrides?)`                                                                | macOS AppleSMC IOKit transport via `/usr/bin/python3` and `/usr/bin/sudo`                                                                                                                                                                                                                                                    |
| `readPersistedState` / `mergePersistedState` / `createMacOsFanStateStore`                            | Safe symlink-checking `state.json` v1 persistence helpers and macOS root-shared store                                                                                                                                                                                                                                        |
| `ensurePersistDaemon` / `getPersistDaemonStatus` / `installPersistDaemon` / `uninstallPersistDaemon` | Idempotently sync and manage the `com.iyowei.fan` `LaunchDaemon` (clamshell/sleep auto-stop + boot/wake restore; surfaces `stateError` if `state.json` is corrupt)                                                                                                                                                           |
| `parseSpeedSpec(input)` / `resolveTargetRpm(fan, spec)` / `computePercent(...)`                      | Pure RPM and percentage parsing, clamping, and range helpers                                                                                                                                                                                                                                                                 |
| `FanError` / `isFanError(value)`                                                                     | Structured domain error with `FanErrorCode` (`UNSUPPORTED_PLATFORM`, `SMC_UNAVAILABLE`, `SMC_COMMAND_FAILED`, `INVALID_FAN_INDEX`, `INVALID_SPEED`, `PERMISSION_DENIED`, `STATE_CORRUPT`, `DAEMON_FAILED`)                                                                                                                   |

## Documentation

- [Development guide](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [Engineering documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [fan product docs & API surface](https://github.com/iyowei/clis/blob/main/packages/fan/docs/README.md)
- [CLI companion package (`@iyowei/fan-cli`)](https://github.com/iyowei/clis/blob/main/packages/fan-cli/README.md)
