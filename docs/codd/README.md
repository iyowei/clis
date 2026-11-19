# codd (产品区)

> 文档类型: 产品区入口 (三级分层的规则见[文档分层协议](../designs/docs-layering.md))

codd 是集合里的第二个 CLI 工具 (`@iyowei/codd`), 面向 Podman 与 Kubernetes 的模板化 MongoDB 9.0 高性能部署装配。产品整体设计与各拓扑运维手册都收录在这里:

## 产品设计

生成器公式与清单规格 / Podman 单机与三物理节点分册 / Kubernetes 单副本与三副本分册 / 日常运维灾备手册 / mongosh 指令速查, 入口见[设计索引](designs/README.md)。

## 可视化看板

8 列等宽全息导读看板 (含架构原理、拓扑决策与 Monaco 代码卡), 见[看板页](BOARD.html)。

## 关联

- 仓库级: [文档总索引](../README.md) / [设计文档索引](../designs/README.md) / [ADR 索引](../adrs/README.md);
- 包级: [CLI 包文档](../../packages/codd/docs/README.md)。

## 修订记录

| 日期       | 修订                                                                |
| ---------- | ------------------------------------------------------------------- |
| 2026-11-19 | 初稿: 产品区建立 (落实文档分层协议的三级结构与 `designs/` 子区组织) |
