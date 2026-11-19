# codd (API 主包与产品文档)

> 文档类型: 包级文档入口 (两级分层的规则见[文档分层协议](../../../docs/designs/docs-layering.md))

codd 是面向 Podman 与 Kubernetes 的模板化 MongoDB 9.0 高性能部署装配工具, 采用「API 主包 + CLI 薄壳包」双包架构:

- **API 主包 (`@iyowei/codd`)**: 本包维护硬件推导公式、严格配置校验、状态锁、Podman / Kubernetes 渲染引擎与唯一参数化模板源 ([包 README](../README.md) / [中文 README](../README.zh-CN.md));
- **CLI 薄壳包 (`@iyowei/codd-cli`)**: 提供 `codd` 命令行、交互式向导与双运行时启动器 ([CLI 文档](../../codd-cli/docs/README.md) / [CLI README](../../codd-cli/README.zh-CN.md))。

## 产品设计

生成器公式与清单规格 / Podman 单机与三物理节点分册 / Kubernetes 单副本与三副本分册 / 日常运维灾备手册 / mongosh 指令速查, 入口见[产品设计索引](designs/README.md)。

## 可视化看板

8 列等宽全息导读看板 (含架构原理、拓扑决策与 Monaco 代码卡), 见[看板页](BOARD.html)。

## 包级 ADR

| 编号                                                                | 标题                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| [0012](adrs/0012-single-node-replica-set.md)                        | 默认采用单节点副本集 (oplog 990MB) 而非单机模式                 |
| [0013](adrs/0013-containerized-bun-tools-and-single-version.md)     | 工具脚本采用容器化 Bun + TypeScript 与版本单点管控              |
| [0014](adrs/0014-fingerprint-resource-isolation.md)                 | 全链路宿主资源与路径由单个 FINGERPRINT 派生实现 100% 零命名冲突 |
| [0015](adrs/0015-compact-2c2g-resource-budget.md)                   | 以 2C2G 紧缩基线为锚点动态推算 MongoDB 9.0 全套配额             |
| [0016](adrs/0016-loopback-and-least-privilege-security.md)          | 安全边界采用本机回环隔离、运行时自建密钥与最小权限三账号        |
| [0017](adrs/0017-single-replica-set-multi-db-isolation.md)          | 同副本集按业务库与独立账号隔离多业务                            |
| [0018](adrs/0018-profile-engine-separation-and-bundle-generator.md) | 消除规格目录分叉, 统一为模板资产 + CLI 输出自包含零冲突部署包   |

## 关联入口

- 仓库级: [文档总索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md) / [仓级 ADR 索引](../../../docs/adrs/README.md);
- CLI 薄壳包: [codd-cli 文档](../../codd-cli/docs/README.md) / [命令面设计](../../codd-cli/docs/designs/cli-surface.md)。
