# 包分类与发布协议 (Package Classification)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md)

## 三类包

本仓每个包都恰好属于下面三类之一 (全部由 `package.json` 确定性字段推导, 无人工维护分类表):

| 类别           | 判定依据 (确定性字段)                                  | 发布              | 例子                                                                  |
| -------------- | ------------------------------------------------------ | ----------------- | --------------------------------------------------------------------- |
| **CLI 工具**   | `package.json` 有 `bin` 字段                           | 非 private 发 npm | `create-clis` / `@iyowei/sweep-node-modules-cli` / `@iyowei/codd-cli` |
| **公开库**     | 没有 `bin`, 且非 `"private": true`                     | 发 npm            | `@iyowei/sweep-node-modules` / `@iyowei/codd`                         |
| **仓内私有库** | 没有 `bin`, 且自身 `package.json` 标 `"private": true` | 不发 npm          | `@iyowei/cli-updater` (及未来待首发新包)                              |

> **待首发隔离边界**: 任何准备未来发往 npm 但尚未首发的包 (无论是带 `bin` 的 CLI 还是不带 `bin` 的 API 主包) 均通过 npm 原生字段 `"private": true` 隔离于 `multi-semantic-release` (`ignorePrivate` 默认开启) 与 `scripts/npm-trust-guard.ts` 之外; 首发时移除 `"private": true` 并按[开发指南](../development.md)「发布」章完成首次发布、补打首发 tag 与 Trusted Publisher 登记。

## 默认双包工具范式 (ADR 0010 / ADR 0019)

集合内面向日常研发的独立 CLI 工具默认拆成一对对称双包:

1. **主包 / 可编程 API 包 (`@iyowei/<name>`, 无 `bin`)**: 承载全部核心业务逻辑、模板资产、类型声明 (`dist/index.js` + `dist/index.d.ts`, `sideEffects: false`) 及全套产品文档 (`packages/<name>/docs/`), 方便被其他程序或更大格局的工具直接编程集成;
2. **从包 / CLI 薄壳包 (`@iyowei/<name>-cli`, 有 `bin`)**: 只负责命令行参数解析、交互向导、终端渲染与防劫持/隔离启动器 (`bin/*`), 通过 `devDependencies` 精确依赖对应 API 包并在构建期打成单文件产物 (`dist/cli.js`), 保持 CLI 分发零外部运行时依赖。

例外: 仅服务集合仓自身骨架生成的脚手架工具 (`create-clis`) 可保持单包形态。

## 各类包的工程要求

| 要求                                     | CLI 工具                       | 公开库                         | 仓内私有库 |
| ---------------------------------------- | ------------------------------ | ------------------------------ | ---------- |
| 双语 README (英文为主, 禁逃逸外链)       | 必须                           | 必须                           | 按需       |
| 发布自证闸门 (`verify:release`)          | 必须 (非 private / 待首发皆备) | 必须 (非 private / 待首发皆备) | 不需要     |
| 启动器隔离 (`bin/bunfig.toml`)           | 必须                           | 不适用                         | 不适用     |
| 金样本语料 (conformance 档)              | 按产品需要                     | 按对外暴露面                   | 不需要     |
| 契约测试 + 双运行时测试                  | 必须                           | 必须                           | 必须       |
| 通用闸门 (引用 / 示例 / 依赖方向 / 卫生) | 仓库统一跑, 不用按包配置       |                                |            |

## 新增一个工具的最低门槛

1. 在 `packages/` 下建主包 `@iyowei/<name>` 与薄壳包 `@iyowei/<name>-cli`, 并在根 `tsconfig.json` `paths` 补齐 API 包开发态映射;
2. 按上表配齐 `build`、`verify:release`、启动器 `bin/bunfig.toml` 隔离与测试;
3. 依赖方向满足[依赖方向纪律](dependency-direction.md) (由 `scripts/lint-dependency-direction.ts` 物理校验);
4. 未首发前在 `package.json` 标 `"private": true`;
5. 在根中英文 README 包列表及 [docs/README.md](../README.md) 登记一行。

## 修订记录

| 日期       | 修订                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| 2026-09-30 | 初稿: 三类包字段判定、工程要求与入仓门槛                                                     |
| 2026-10-01 | 改判据: 包隔离字段改为 npm 原生 `"private": true`                                            |
| 2026-11-19 | 确立默认双包工具范式 (API 主包 + CLI 薄壳包), 泛化待首发包边界, 去除对特定产品的反向外链耦合 |
