# ADR 0015: 以 2C2G 紧缩基线为锚点动态推算 MongoDB 9.0 全套配额

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构, 性能]
> **影响范围**: [packages/codd/src/, packages/codd/template/, packages/codd/docs/]

## 上下文与问题 (Context & Problem)

容器化 MongoDB 9.0 面对从 `2C/2G` 入门机到大内存主机的巨大跨度: 静态参数在小机上易触发 OOM, 在大机上则浪费热缓存或因刷盘超时被强杀; 同时 MongoDB 9.0 默认启用 `tcmalloc-google` 需要宿主机开启 THP, 高频 `mongosh` 健康探针与同实例恢复演练也会带来不必要的 CPU 开销与生产 `oplog` 污染。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[按 2c2g / 4c8g 维护多套静态配置目录]**

放弃理由: 多目录必然引发模板漂移, 且无法覆盖任意非标硬件档位。

**[继续高频拉起 mongosh 探针并在生产实例内直接恢复演练]**

放弃理由: `mongosh` 反复派生 V8 进程消耗额外 CPU 与内存尖峰; 在生产实例内导入演练临时库会冲刷热缓存并污染线上 `oplog`。

## 决策与理由 (Decision & Why)

1. **在 [formulas.ts](../../src/formulas.ts) 沉淀自适应硬件与负载公式**:
   - **WiredTiger 缓存 (`WT_CACHE_GB`)**: 按 `workload` 差异化推导——`balanced` 遵循官方 `0.5 x (RAM - 1G)`, `write-heavy` 收紧至 `0.45 x (RAM - 1G)` 为脏页刷盘与 OS Page Cache 留余量, `read-heavy` 在 `>8G` 大机提升至 `0.55 x (RAM - 1G)` 放大热索引命中; K8s 强制 `requests.memory == limits.memory` 防节点内存压力下优先驱逐数据库;
   - **连接上限、句柄与优雅停机**: 非缓存富余内存按 `80` 连接/GB 推导安全连接数 (`100..5000`); `nofile` 保底 `65536` (满足官方 `>=64000` 零告警要求并对齐 `2^16`; `nproc` 保留推算参考值不硬写以兼容 rootless Podman); 停机窗口按 `clamp(memoryGb x 8, 30, 300)s` 伸缩; 备份并发按 `clamp(floor(cpuCores / 2), 1, 8)` 缩放;
   - **全链路压缩与零双写慢日志**: `write-heavy` 优先低 CPU 开销 `snappy`, `balanced`/`read-heavy` 在 `>=2` 核启用 `zstd` 块压缩, 统一开启 `journalCompressor: snappy`、`prefixCompression: true` 与网络协议压缩 `snappy,zstd,zlib`; `operationProfiling.mode` 默认设为 `off` (慢操作仍由 `slowOpThresholdMs` 写入标准日志, 避免 `system.profile` 写放大).
2. **零抖动探针、跨平台内核调优与容器内沙箱演练**:
   - Podman 采用 `/dev/tcp` 探针 (日志固定 `k8s-file` + `max-file=3` + `log-rotate=true`), K8s 采用内核级 `tcpSocket` 三层探针;
   - [tune-linux-host.sh](../../template/podman/tune-linux-host.sh) 与 `make tune-host` 支持在 Linux 宿主机及 macOS `podman machine` Linux 虚拟机内一键开启并持久化 THP、`vm.swappiness=1`、`vm.overcommit_memory=1`、`vm.force_cgroup_v2_swappiness=1` 与 `vm.zone_reclaim_mode=0`;
   - [drill.ts](../../template/podman/drill.ts) 在工具容器内基于 `0700` 私有目录 Unix Domain Socket (`--bind_ip <sockPath>`, 零 TCP 端口占用与暴露, `0.25GB` 缓存上限) 拉起独立沙箱 `mongod` 验证归档, 对线上生产库零写入。

理由: 用确定性数学公式与零副作用运维探针替代经验拍脑袋配置, 一套模板即可覆盖全规格硬件。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 单一模板精准适配全规格硬件, `startupWarnings` 清零, 演练零污染线上。

**代价**

- `blockCompressor` 仅影响新建集合; 存量库调大 `oplogSizeMB` 需配合在线 `replSetResizeOplog` 生效。

## 验证方式与关联引用 (Validation & References)

**验证依据**

`packages/codd/src/codd.test.ts` 对 `2C2G`、`4C8G`、`8C16G` 及连接溢出封顶边界执行精确数值断言。

**关联引用**

- 前置决策见 [ADR 0012](0012-single-node-replica-set.md) 与 [ADR 0018](0018-profile-engine-separation-and-bundle-generator.md)。
- 公式全表见 [生成器与科学公式详解](../designs/generator-and-formulas.md)。
