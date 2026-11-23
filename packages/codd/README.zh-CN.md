# @iyowei/codd

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/codd)](https://www.npmjs.com/package/@iyowei/codd)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/codd)](https://www.npmjs.com/package/@iyowei/codd)
![node](https://img.shields.io/node/v/@iyowei/codd)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

模板化 MongoDB 9.0 部署装配的可编程 API 与模板资产包, 面向 Podman (Linux / macOS) 与 Kubernetes (Helm): 根据硬件规格确定性推算 WiredTiger 缓存、连接数、oplog、全链路压缩与句柄上限, 输出 100% 零命名冲突的自包含部署包。

本包是**纯编程 API 库** (不提供 `bin` 命令); 交互式终端向导与 `codd` 命令行工具请安装配套包 [`@iyowei/codd-cli`](https://www.npmjs.com/package/@iyowei/codd-cli)。

## 要求

- **双运行时**: Bun 与 Node.js 均可直接导入 (`engines.node >= 22.18.0`)。
- 零第三方运行时依赖 (仅使用运行时内置能力)。
- 随包提供完整 TypeScript 类型声明 (`.d.ts`) 与模板资产 (`assets/template/`)。

## 安装

```shell
npm install @iyowei/codd
bun add @iyowei/codd
```

## 快速上手 (TypeScript)

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

// 1. 严格清单校验 (拦截未知字段、路径穿越与 Shell/YAML/XML 注入)
const warnings = validateManifest(manifest);

// 2. 确定性公式推导
const sizing = computeSizing(manifest.hardware!);
console.log(sizing.formulaSummary, warnings);

// 3. 输出带唯一指纹的部署包并锁存状态至 .codd-state/
const result = generateBundle({
  workDir: process.cwd(),
  manifest,
  outDir: './dist',
});

console.log('实例指纹:', result.fingerprint);
console.log('部署包目录:', result.bundleDirs);
console.log('本机凭证文件 (0600):', result.credentialsFile);
```

## 公共 API 一览

| 导出符号                                                                            | 用途                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateBundle(options)`                                                           | 主编排入口: 校验清单、推导公式、锁存指纹与凭证、渲染 Podman 或 Kubernetes (Helm) 自包含部署包                                                           |
| `validateManifest(manifest)`                                                        | 严格白名单与 DNS-1123 校验器 (拦截未知字段、路径穿越及 Shell/YAML/XML 注入)                                                                             |
| `computeSizing(hardware)`                                                           | 硬件与负载公式推导引擎 (计算 `WT_CACHE_GB`、最大连接数、`oplogSizeMB`、压缩算法与 `ulimit`)                                                             |
| `recommendSafePort(rng?)` / `digitalRoot(n)`                                        | 随机推荐数根为 `3 / 6 / 9` 的 5 位安全监听端口 (`10002-29997`), 自动排除扫描段与系统保留段                                                              |
| `renderTemplate(name, raw, vars)`                                                   | 严格 `{{TOKEN}}` 模板渲染器, 缺参或残留花括号立即抛 `TemplateRenderError`                                                                               |
| `parseSshInput(raw)` / `resolveServerBackupDir(...)` / `resolveServerStackDir(...)` | SSH 连接串净化提取器与幂等指纹路径归一化工具                                                                                                            |
| `loadOrUpdateState(...)` / `prepareStateDir(...)`                                   | `.codd-state/` 幂等状态机与凭证权限落盘工具                                                                                                             |
| `resolveTemplateRoot(...)` / `copyTemplateFile(...)` / `readTemplateFile(...)`      | 内置模板资产定位 (优先级 `overrideDir` > `CODD_TEMPLATE_DIR` > `assets/template/`) 与隐藏载体名 (`_dockerignore` / `env.tmpl` / `_helmignore`) 自动还原 |
| `assertBunEngineCompatible(range, current)`                                         | 纯校验辅助函数, 显式核对当前 Bun 版本是否满足目标语义化版本范围 (支持 `>=` / `^` / `~` 及默认按 `>=` 处理的无前缀下限)                                  |
| `ConfigError` / `SizingError` / `TemplateRenderError`                               | 结构化领域错误类型                                                                                                                                      |

> 其余细粒度校验与辅助符号 (`HARDWARE_BOUNDS`、`withStateLock`、`randomAlnumSecret`、`validateAppInput` 等) 同样从根入口导出, 完整类型签名以随包 `dist/index.d.ts` 为准。

## 环境变量

- `CODD_TEMPLATE_DIR`: 未显式传入 `templateDir` / `overrideDir` 时, 用于覆盖内置 `assets/template/` 模板根目录的自定义路径。

## 开发

环境准备、常用命令、双运行时验证与提交钩子, 见 [开发指南](https://github.com/iyowei/clis/blob/main/docs/development.md)。

## 文档

- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [codd 产品文档与包级 ADR (0012–0018)](https://github.com/iyowei/clis/blob/main/packages/codd/docs/README.md)
- [生成器与科学公式详解](https://github.com/iyowei/clis/blob/main/packages/codd/docs/designs/generator-and-formulas.md)
- [配套命令行包 (`@iyowei/codd-cli`)](https://github.com/iyowei/clis/blob/main/packages/codd-cli/README.zh-CN.md)
