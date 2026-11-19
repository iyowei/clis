# codd 产品设计索引 (按推荐阅读顺序)

> 文档类型: 产品区设计索引 (分层规则见[文档分层协议](../../designs/docs-layering.md); 产品区入口见[上级](../README.md))
>
> 阅读顺序: 先看生成器公式与清单契约 (理解硬件规格怎样折算成数据库与容器参数) → 再按目标部署形态挑选对应的装配分册 (Podman 单机 / Podman 三物理节点 / K8s 单副本 / K8s 三副本) → 最后备查通用日常运维与 `mongosh` 诊断片段。包级 ADR 挂在 [CLI 包文档](../../../packages/codd/docs/README.md)。

| 顺序 | 文档                                                     | 一句话                                                                                |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1    | [生成器与科学公式详解](generator-and-formulas.md)        | 怎么算、怎么配: 硬件推导公式表、`deploy.json` 全量字段规格与零冲突产物结构 (先读)     |
| 2    | [Podman 单副本装配手册](podman-single.md)                | 单台 Linux / macOS 服务器装配: 内核调优、启动验收、WireGuard / Compass 连接与定时备份 |
| 3    | [Podman 三物理节点高可用手册](podman-replica-set.md)     | 3 台独立服务器 PSS 副本集: 私网防火墙、从节点先行引导与自动切主连接串                 |
| 4    | [Kubernetes 单副本部署手册](kubernetes-single.md)        | 单副本 StatefulSet + 自包含 Helm Chart 交付、集群内连串与 PVC 在线扩盘                |
| 5    | [Kubernetes 三副本高可用手册](kubernetes-replica-set.md) | 3 副本硬反亲和 StatefulSet、Headless DNS 发现与礼貌让主维护                           |
| 6    | [通用日常运维与灾备手册](operations-and-recovery.md)     | 日常巡检、同实例增库、口令轮换、升配重算、容器内沙箱演练与安全恢复                    |
| 7    | [mongosh 常用指令速查](mongosh-snippets.md)              | 容器外直连时的账号授权、副本集状态与诊断代码片段                                      |

## 修订记录

| 日期       | 修订                                                               |
| ---------- | ------------------------------------------------------------------ |
| 2026-11-19 | 初稿: 产品设计索引建立, 统一为小写 `kebab-case` 命名与标准分册结构 |
