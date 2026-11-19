# ADR 0013: 工具脚本采用容器化 Bun + TypeScript 与版本单点管控

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构, 工具]
> **影响范围**: [packages/codd/template/, packages/codd/src/, packages/codd/docs/]

## 上下文与问题 (Context & Problem)

MongoDB 部署伴随初始化 (`init.js`)、逻辑备份 (`backup.ts`)、恢复演练 (`drill.ts`) 与真实恢复 (`restore.ts`)。若要求目标宿主机安装 Bun / Node 与 MongoDB Database Tools, 会污染宿主环境且易产生主库与工具链版本脱节; 而官方镜像内置的 `mongosh` 仅直接执行原生 JavaScript。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[纯 Bash 脚本实现备份清理与演练校验]**

放弃理由: 归档命名正则校验、保留周期清理、gzip 流式完整性校验与索引对比用 Bash 编写脆弱且缺少静态类型检查。

**[要求目标服务器预装 Bun 与 Database Tools]**

放弃理由: 破坏容器化部署包即拿即走的边界, 增加每台目标服务器的预装负担。

**[初始化脚本也改用 TypeScript]**

放弃理由: `mongo-init` 直接运行官方 `mongo` 镜像内的 `mongosh`, 为单个初始化文件引入 TS 转译徒增额外镜像构建链路。

## 决策与理由 (Decision & Why)

1. **按运行时天然边界分层**: [init.js](../../template/podman/init.js) 保留纯 JavaScript 直跑 `mongosh`; 备份、演练与恢复写在 [backup.ts](../../template/podman/backup.ts)、[drill.ts](../../template/podman/drill.ts)、[restore.ts](../../template/podman/restore.ts) 与 [lib.ts](../../template/podman/lib.ts), 由 [tools.package.json](../../template/podman/tools.package.json) 与 [tools.bun.lock](../../template/podman/tools.bun.lock) 锁定 `mongodb@7.9.0` 与 `bun >= 1.4.2`。
2. **工具镜像以同版本 `mongo` 为底并拷入 Bun**: [Dockerfile](../../template/podman/Dockerfile) 从 `${BUN_IMAGE}` 拷入 `/usr/local/bin/bun`, 基础镜像复用 `${MONGO_IMAGE}`, 宿主机零额外客户端依赖。
3. **镜像版本坐标单点管控**: 生成器与 `.env` 中的 `MONGO_IMAGE_NAME` / `MONGO_IMAGE_TAG` (默认 `9.0.8`) 作为唯一版本源同步驱动主容器、初始化容器与工具容器。

理由: 让目标服务器仅依赖 `podman`、`podman-compose`、`make` 与 `openssl`, 同时保障复杂备份演练逻辑享有静态类型约束且与主库同版本演进。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 目标服务器免装 Bun 与数据库客户端工具链。
- 主库与 `mongodump` / `mongorestore` 严格同版本推进。

**代价**

- 首次运行 `make backup` / `make drill` 需在目标机本地构建一次 `mongo-tools` 镜像。
- 升级 `MONGO_IMAGE_TAG` 后需同步重建工具镜像。

## 验证方式与关联引用 (Validation & References)

**验证依据**

`packages/codd/src/generate.test.ts` 验证生成目录中的 `package.json`、`bun.lock`、`Dockerfile` 与 `Makefile` 零未替换占位符, 且 `engines.bun` 约束与模板单源一致。

**关联引用**

- 包级入口见[包文档](../README.md); 全局索引见 [ADR 索引](../../../../docs/adrs/README.md)。
- 编排模板见 [Dockerfile](../../template/podman/Dockerfile)、[podman-compose.yml.tmpl](../../template/podman/podman-compose.yml.tmpl) 与 [Makefile.tmpl](../../template/podman/Makefile.tmpl)。
