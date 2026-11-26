# @iyowei/wake

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/wake)](https://www.npmjs.com/package/@iyowei/wake)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/wake)](https://www.npmjs.com/package/@iyowei/wake)
![node](https://img.shields.io/node/v/%40iyowei%2Fwake)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

Zero-dependency, dual-runtime Wake-on-LAN programmable API featuring subnet-aware local IPv4 UDP broadcast selection, ordered SSH relay failover (using strict argument allowlisting with zero shell interpolation), TCP readiness polling, and cross-platform ARP neighbor discovery.

This package is a **pure programmable library** (no `bin` command). For the `wake` CLI (`wake workstation`, `wake init`, `wake doctor`), install [`@iyowei/wake-cli`](https://www.npmjs.com/package/@iyowei/wake-cli).

## Requirements

- **Dual runtime**: Bun or Node.js (`>= 22.18.0`, matching `engines.node`).
- **Zero third-party runtime dependencies**: built exclusively on `node:` standard modules.
- **Cross-subnet SSH relay (optional)**: requires system `ssh` with key-based non-interactive auth (`BatchMode=yes`) and `@iyowei/wake-cli` installed on relay hosts.

## Installation

```shell
npm install @iyowei/wake
bun add @iyowei/wake
```

## Quick start

```ts
import { isWakeError, wakeTarget } from '@iyowei/wake';

try {
  const report = await wakeTarget({
    target: 'workstation',
  });
  console.log(report.status, report.method, report.packetsSent);
} catch (error) {
  if (isWakeError(error)) {
    console.error(error.code, error.message);
  }
}
```

## Public API surface

| Export                                                                                                               | Purpose                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `wakeTarget(options, deps?)`                                                                                         | Resolve target config/overrides, probe readiness, fail over across SSH relays or broadcast locally, and poll until online |
| `diagnoseWake(options?, deps?)`                                                                                      | Strictly read-only diagnostic snapshot for config, local LAN vs tunnel interfaces, SSH relays, and target reachability    |
| `loadWakeConfig` / `tryLoadWakeConfig` / `saveWakeConfig` / `upsertWakeTarget` / `removeWakeTarget`                  | Safe JSON v1 config management with `0o600` permissions and symlink guards                                                |
| `buildMagicPacket` / `normalizeMac` / `computeBroadcastIpv4` / `sameIpv4Subnet`                                      | Pure WoL packet builder (`102` bytes) and arithmetic IPv4 subnet helpers                                                  |
| `listLocalLanInterfaces` / `resolveBroadcastTargets` / `sendUdpMagicBurst` / `probeTcpPort` / `discoverArpNeighbors` | Native IPv4 NIC filtering, UDP broadcast, TCP readiness probing, and ARP neighbor parsing                                 |
| `WakeError` / `isWakeError`                                                                                          | Structured domain errors (`CONFIG_ABSENT`, `INVALID_MAC`, `RELAY_FAILED`, `NETWORK_FAILED`, and more)                     |

## Documentation

- [Development guide](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [Engineering documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [wake product docs & architecture ADR](https://github.com/iyowei/clis/blob/main/packages/wake/docs/README.md)
- [CLI companion package (`@iyowei/wake-cli`)](https://github.com/iyowei/clis/blob/main/packages/wake-cli/README.md)
