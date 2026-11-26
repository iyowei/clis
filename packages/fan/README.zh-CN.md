# @iyowei/fan

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/fan)](https://www.npmjs.com/package/@iyowei/fan)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/fan)](https://www.npmjs.com/package/@iyowei/fan)
![node](https://img.shields.io/node/v/%40iyowei%2Ffan)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

用于读取与手动控制 Apple Silicon / Mac 风扇转速的可编程 API, 通过 AppleSMC IOKit 实现且零第三方运行时依赖, 无需安装 Macs Fan Control 等软件。变更操作 (`set` / `max` / `min` / `auto`) 默认预检并自动将目标写入 `/Library/Application Support/iyowei-fan/state.json` (若持久化文件已损坏则快速失败且不改写硬件, 写入失败则在非权限拒绝错误时尝试回滚硬件状态; 传入 `persist: false` 则仅临时调速并通过 `STATE_CORRUPT` 告警提示损坏), 手动调速 (`set` / `max` / `min`) 默认自动确保内置 `LaunchDaemon` (`com.iyowei.fan`) 安装并保持最新: 在无外接显示器合盖、进入系统睡眠与后台 `DarkWake` 期间自动将风扇交还系统 `auto` 停转 (外接屏合盖办公保留手动转速), 开盖/唤醒与重启后自动恢复。

本包是**纯编程 API 库** (不提供 `bin` 命令); 如需直接使用 `fan` 命令行工具 (`fan max`、`fan set 4000`、`fan set 30%` 或 `fan auto`), 请安装配套包 [`@iyowei/fan-cli`](https://www.npmjs.com/package/@iyowei/fan-cli)。

## 运行要求

- **双运行时**: 支持 Bun 或 Node.js (`>= 22.18.0`)。
- **宿主机**: 具备 AppleSMC (`IOKit`) 与系统 `/usr/bin/python3` 的 macOS; 写入操作 (`set` / `max` / `min` / `auto` / `apply`) 与守护安装会在非 root 下调用 `/usr/bin/sudo` 提权。
- **零第三方运行时依赖**: 仅使用 `node:` 内置模块与 macOS 系统框架。

## 安装

```shell
npm install @iyowei/fan
bun add @iyowei/fan
```

## 快速上手

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

## 文档入口

- [开发指南](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [fan 产品文档与 API 面设计](https://github.com/iyowei/clis/blob/main/packages/fan/docs/README.md)
- [CLI 薄壳包 (`@iyowei/fan-cli`)](https://github.com/iyowei/clis/blob/main/packages/fan-cli/README.zh-CN.md)
