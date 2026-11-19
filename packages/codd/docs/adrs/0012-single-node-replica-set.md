# ADR 0012: 默认采用单节点副本集 (oplog 990MB) 而非单机模式

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构]
> **影响范围**: [packages/codd/template/, packages/codd/docs/]

## 上下文与问题 (Context & Problem)

面向轻量起步至高并发通用容器化部署时, MongoDB 默认最轻的形态是不开启副本集的单机模式 (Standalone), 不维护 `oplog`, 也无需配置 `keyFile` 内部认证与 `rs.initiate()`。

但在实际业务开发中, 多文档 ACID 事务 (`session.withTransaction`)、实时变更订阅 (Change Streams) 以及常见 ORM / 驱动的事务封装都硬性依赖副本集 `oplog`, 在 Standalone 模式下调用会直接报错失败。若上线初期采用 Standalone, 后续引入事务时必须停机修改 `mongod.conf`、补建并分发 `keyFile`、执行副本集初始化并同步改造客户端连接串, 停机与改造成本远高于部署伊始即按副本集装配。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[Standalone 单机无副本集模式]**

放弃理由: 无法使用多文档事务与 Change Streams; 后续业务需要事务时无法零中断在线升级为副本集。

**[单机强起三节点副本集]**

放弃理由: 违背单机轻量化定位, 成倍消耗 CPU / 内存与同盘写放大且零硬件容灾收益; 跨机高可用应按[三物理节点高可用分册](../designs/podman-replica-set.md)部署在 3 台独立服务器上。

## 决策与理由 (Decision & Why)

1. **默认启用名为 `rs0` 的单节点副本集与自动密钥初始化**: [mongod.conf.tmpl](../../template/podman/mongod.conf.tmpl) 固定声明 `replication.replSetName` 与 `security.keyFile`; 首次启动时 [podman-compose.yml.tmpl](../../template/podman/podman-compose.yml.tmpl) 在命名卷内自动生成 756 字节 base64 `keyfile` (`400` 权限), 随后由 `mongo-init` 执行幂等的 [init.js](../../template/podman/init.js) 完成 `replSetInitiate`。
2. **为 `oplogSizeMB` 设 `990` MB 官方保底下限并随磁盘/负载公式扩展**: [formulas.ts](../../src/formulas.ts) 按磁盘容量与负载系数为 `mongod.conf.tmpl` 注入 `oplogSizeMB` (`990`..`51200` MB), 同时为 2 核及以上主机开启 `zstd` 块压缩。
3. **副本集成员地址固定为可解析服务名, 宿主机访问显式声明 `directConnection=true`**: 同桥接网络内的业务容器通过服务名 `mongo:27117` 直连; 宿主机本地进程连入 `127.0.0.1:27117` 时显式附加 `directConnection=true` ([Makefile.tmpl](../../template/podman/Makefile.tmpl) 与 [lib.ts](../../template/podman/lib.ts) 均遵循该约定)。

理由: 初始化逻辑全部在容器编排内自动完成, 使用者无需手工生成密钥或手动跑 `rs.initiate()`, 上线第一天即可直接使用多表事务与 Change Streams。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 多文档事务与 Change Streams 原生可用, 消除事后从 Standalone 迁副本集的停机窗口。
- `oplogSizeMB` 保底可控, 配合 `FINGERPRINT` 隔离可安全同机多开。

**代价**

- 单节点副本集仍只有一个数据副本, 不抵御单盘或整机故障。
- 迁移数据卷时必须按[通用运维与灾备手册](../designs/operations-and-recovery.md)连同 `-key` 密钥卷成对导出导入。

## 验证方式与关联引用 (Validation & References)

**验证依据**

`packages/codd/src/generate.test.ts` 对生成的 `mongod.conf`、`podman-compose.yml` 与 `.env` 进行静态断言, 确认 `replSetName`、`oplogSizeMB`、`keyFile` 与 `directConnection=true` 连接串均按契约落盘。

**关联引用**

- 包级入口见[包文档](../README.md); 全局索引见 [ADR 索引](../../../../docs/adrs/README.md)。
- 部署与运维见 [Podman 单副本分册](../designs/podman-single.md) 与 [通用运维与灾备手册](../designs/operations-and-recovery.md)。
