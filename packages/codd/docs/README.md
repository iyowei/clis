# codd (CLI 包) 文档

> 文档类型: 包级文档入口 (三级分层的规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/codd` 提供 `codd` 命令行工具: 根据硬件规格推导全套缓存、连接、oplog 与压缩参数, 输出 Podman (单机 / 3 物理节点) 与 Kubernetes (单副本 / 3 副本 Helm) 的零冲突自包含部署包。用法见[包 README](../README.md)。

## 包内文档

(无: 本包的完整公式与各拓扑运维分册统一收录在产品区 `docs/codd/designs/` 下。)

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

## 仓库级关联

- [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md);
- 本包相关的产品区设计: [产品区入口](../../../docs/codd/README.md) / [产品设计索引](../../../docs/codd/designs/README.md) / [生成器与科学公式详解](../../../docs/codd/designs/generator-and-formulas.md) / [通用运维与灾备手册](../../../docs/codd/designs/operations-and-recovery.md)。
