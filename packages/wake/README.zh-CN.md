# @iyowei/wake

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/wake)](https://www.npmjs.com/package/@iyowei/wake)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/wake)](https://www.npmjs.com/package/@iyowei/wake)
![node](https://img.shields.io/node/v/%40iyowei%2Fwake)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

零第三方依赖的双运行时 Wake-on-LAN 可编程 API, 内置真实局域网 IPv4 子网过滤广播、按序故障转移的无 shell 注入 SSH 中继、TCP 就绪轮询及跨平台 ARP 邻接表发现。

本包为**纯编程 API 库** (不提供 `bin` 命令); 若需使用 `wake` 命令行工具 (`wake workstation`、`wake init`、`wake doctor`), 请安装配套包 [`@iyowei/wake-cli`](https://www.npmjs.com/package/@iyowei/wake-cli)。

## 运行要求

- **双运行时**: 支持 Bun 或 Node.js (`>= 22.18.0`)。
- **零第三方运行时依赖**: 仅依赖 `node:` 标准库。
- **跨网段 SSH 中继 (可选)**: 需本机系统 `ssh` 已配置免密密钥 (`BatchMode=yes`), 且中继节点已安装 `@iyowei/wake-cli`。

## 安装

```shell
npm install @iyowei/wake
bun add @iyowei/wake
```

## 快速上手

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

## 文档入口

- [开发指南](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [wake 产品文档与架构设计](https://github.com/iyowei/clis/blob/main/packages/wake/docs/README.md)
- [CLI 薄壳包 (`@iyowei/wake-cli`)](https://github.com/iyowei/clis/blob/main/packages/wake-cli/README.zh-CN.md)
