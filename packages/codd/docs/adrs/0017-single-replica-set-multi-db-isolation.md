# ADR 0017: 同副本集按业务库与独立账号隔离多业务

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构, 安全, 运维]
> **影响范围**: [packages/codd/template/, packages/codd/src/, docs/codd/]

## 上下文与问题 (Context & Problem)

单台服务器承载多套业务系统时, 若并排启动多套独立 MongoDB 容器会重复消耗多份 WiredTiger 缓存与 `990MB` `oplog`; 若同机起 3 个节点组副本集则零硬件容灾收益却产生 3 倍同盘写放大。需要在单机单实例内安全隔离多套业务的账号权限与备份留存周期。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[单物理机并排起多套独立 MongoDB 容器]**

放弃理由: 多个 `mongod` 各自占用独立缓存与 `oplog`, 对轻量服务器造成无谓的内存与磁盘浪费。

**[单物理机同盘起 3 个节点组成 PSS 副本集]**

放弃理由: 同机掉电或坏盘时 3 个节点同时离线, 零硬件容灾价值却白白放大 3 倍写入与存储开销。

## 决策与理由 (Decision & Why)

1. **以 `apps[]` 与 `MONGO_EXTRA_APPS` 声明多业务库**: 第 1 项作为主业务库, 其余项自动编码为 `库名:用户名:密码` 注入 `MONGO_EXTRA_APPS`, 拒绝 `admin`、`local`、`config` 系统保留库名。
2. **按库授权与按库独立备份生命周期**:
   - [init.js](../../template/podman/init.js) 为每个业务库创建仅限该库的 `readWrite` 专属账号, 互不越权;
   - [backup.ts](../../template/podman/backup.ts) 逐库输出归档并按各库独立执行 `KEEP_DAILY` / `KEEP_WEEKLY` 清理, 避免不同业务库互相挤占备份配额;
   - [drill.ts](../../template/podman/drill.ts) 与 [restore.ts](../../template/podman/restore.ts) 从归档名自动识别目标库, 恢复时限定 `--nsInclude=<目标库>.*`, 绝不波及同实例其它业务库。

理由: 单机单进程承载多业务库内存效率最高, 同时权限与备份清理互不干扰。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 内存与缓存利用率最高, 账号权限与备份恢复粒度精确到单库。

**代价**

- 同实例多库共享内存池与维护重启窗口; 追加新库后需在线上执行一次 `make init` 生效。

## 验证方式与关联引用 (Validation & References)

**验证依据**

`packages/codd/src/generate.test.ts` 验证多 `apps` 在 Podman `.env` 与 Kubernetes `create-secret.sh` 中均正确编码且不泄露至公开 `values.generated.yaml`。

**关联引用**

- 前置安全决策见 [ADR 0016](0016-loopback-and-least-privilege-security.md)。
- 扩库流程见 [通用运维与灾备手册](../../../../docs/codd/designs/operations-and-recovery.md)。
