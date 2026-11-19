# ADR 0014: 全链路宿主资源与路径由单个 FINGERPRINT 派生实现 100% 零命名冲突

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构, 运维]
> **影响范围**: [packages/codd/src/, packages/codd/template/, packages/codd/docs/]

## 上下文与问题 (Context & Problem)

容器编排与多实例托管中若不彻底约束资源与宿主机路径命名, 同机部署第二套数据库或同名逻辑实例时, 极易发生容器/命名卷撞名、备份目录 `BACKUP_DIR` 被另一实例清理策略 (`prune`) 误删, 或移动目录导致 Compose 默认项目前缀变化。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[仅对容器与卷加指纹, 忽略宿主机备份目录与栈目录]**

放弃理由: 一旦备份目录 `BACKUP_DIR` 或栈目录重名, 定时备份清理任务会误删同机另一实例的归档文件。

**[要求用户在配置文件中手填多个独立名称与路径变量]**

放弃理由: 多头手填极易漏改其中某一项导致交叉污染。

## 决策与理由 (Decision & Why)

1. **强制由生成器自动产出 12 位随机十六进制 `FINGERPRINT` 并锁存于 `.codd-state/`**: [validate.ts](../../src/validate.ts) 禁止在 `deploy.json` 手写固定 `fingerprint`, 由 [generate.ts](../../src/generate.ts) 与 [ssh.ts](../../src/ssh.ts) 单源派生全部 7 类宿主级命名实体:
   - Compose 项目名与容器名: `${STACK_PREFIX}-${FINGERPRINT}`、`${STACK_PREFIX}-${FINGERPRINT}-init`;
   - 独立桥接网络: `${STACK_PREFIX}-${FINGERPRINT}-net`;
   - 数据卷与密钥卷: `${STACK_PREFIX}-${FINGERPRINT}-data`、`${STACK_PREFIX}-${FINGERPRINT}-key`;
   - 本地导出目录与远端栈目录: `dist/${STACK_PREFIX}-${name}-${FINGERPRINT}[-${nodeName}]/` 与 `~/srv/stacks/...`;
   - 服务器端备份目录 (`BACKUP_DIR`): `resolveServerBackupDir` 幂等归一为 `<root>/<prefix>-<name>-<fingerprint>[-<node>]`, 由 `make check-env` 自动以 `0700` 创建;
   - macOS LaunchAgent 与日志: `com.codd.mongo-backup-${FINGERPRINT}.plist`;
   - Kubernetes 默认 Release 与 Secret: `${STACK_PREFIX}-${name}-${FINGERPRINT}`。
2. **多实例共宿主仅需错开映射端口 (`port` / `hostPort`), 共网场景可选 `multiNetAlias: true`**。

理由: 单一随机指纹自动贯穿从本地构建产物到远端宿主机目录、容器、卷、网络的全部命名面, 从根源消除人工重名隐患。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 同台服务器并行部署多个同名逻辑实例也 100% 物理隔离。
- 重跑 `codd` 依托 `.codd-state/` 保持幂等, 路径不重复叠加指纹。

**代价**

- 使用 `--new-fingerprint` 迁库时须按[通用运维与灾备手册](../designs/operations-and-recovery.md)成对迁移 `-data` 与 `-key` 两个命名卷。

## 验证方式与关联引用 (Validation & References)

**验证依据**

`packages/codd/src/codd.test.ts` 与 `packages/codd/src/generate.test.ts` 覆盖根目录归一化、二次重跑幂等性及 `--new-fingerprint` 并存零碰撞用例。

**关联引用**

- 包级入口见[包文档](../README.md); 全局索引见 [ADR 索引](../../../../docs/adrs/README.md)。
- 详见 [生成器与科学公式详解](../designs/generator-and-formulas.md) 与 [通用运维与灾备手册](../designs/operations-and-recovery.md)。
