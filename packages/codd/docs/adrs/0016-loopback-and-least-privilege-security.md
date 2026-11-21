# ADR 0016: 安全边界采用本机回环隔离、运行时自建密钥与最小权限三账号

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构, 安全]
> **影响范围**: [packages/codd/template/, packages/codd/src/, packages/codd/docs/]

## 上下文与问题 (Context & Problem)

容器化数据库在易用性与安全性上常踩四类坑: 默认 `27017` 暴露公网遭全网扫库、静态 `keyFile` 提交入库泄露凭证、业务与备份共用 `root` 放大泄露半径或因特殊符号引发 URI 转义故障、以及 `Makefile` 提供一键删卷导致误删生产库。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[直接暴露公网端口并维护自签 TLS 证书]**

放弃理由: 单机与内网数据库无需公网直连; 为内网或本机通信维护一套 CA 与证书续期徒增运维复杂度, 采用回环绑定配合 SSH 隧道或内网白名单更稳妥。

**[在仓库预置静态 keyfile 或允许任意特殊符号口令]**

放弃理由: 静态密钥入库违背凭据安全底线; 含 `@`、`:`、`/`、`$` 的密码在 Shell、环境变量与 URI 拼接间极易引发转义故障, 十六进制高熵口令可用等价熵强度彻底消除转义缺陷。

## 决策与理由 (Decision & Why)

1. **默认非标准端口 `27117` 且单机默认绑定 `127.0.0.1`**: [podman-compose.yml.tmpl](../../template/podman/podman-compose.yml.tmpl) 默认映射 `${MONGO_BIND_IP:-127.0.0.1}:${MONGO_HOST_PORT:-27117}:${MONGO_PORT:-27117}`; 远程图形工具优先使用 MongoDB Compass 内置 SSH 隧道, 仅家庭 NAT 内网或已配云安全组白名单时按需改填 `0.0.0.0` 或私网 IP。
2. **运行时落盘 `keyfile` 与 `.codd-state/` 自动隔离**: 密钥由容器入口或生成器动态注入, 绝不入库; [state.ts](../../src/state.ts) 在创建 `.codd-state/` 时自动收紧 `0700` 权限并写入内建 `.gitignore` (`*`), 防止在任何外部仓库调用 `codd` 时误提交明文口令。
3. **三账号最小权限与字母数字口令**: [init.js](../../template/podman/init.js) 严格划分业务账号 (单库 `readWrite`)、备份账号 (`admin` 只读 `backup`) 与 `root`; 工具凭据仅写入容器内 `0600` 临时文件并在 `finally` 销毁。
4. **归档完整性校验与禁删卷防呆**: [backup.ts](../../template/podman/backup.ts) 拒绝 `0` 字节空文件并对归档执行完整 `verifyGzip` 解压校验; [Makefile.tmpl](../../template/podman/Makefile.tmpl) 不提供删卷快捷目标。

理由: 把默认配置收紧在最小攻击面上, 让任何误提交、越权访问与误删数据卷都在物理机制层被挡下。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 交付物与用户业务仓库零密钥泄露风险, 业务库与备份权限严格隔离。

**代价**

- `make backup` 放行合法空库归档 (需通过 `verifyGzip`), 但 `make drill` 恢复后仍要求存在至少 1 个实体集合; 全新空库全链路演练前需先写入至少 1 条探测文档。

## 验证方式与关联引用 (Validation & References)

**验证依据**

`packages/codd/src/generate.test.ts` 验证 `.env` 与凭证文件权限均为 `0600`、`.codd-state/.gitignore` 自动落盘, 且非法口令与未知配置字段均被 `ConfigError` 拦截。

**关联引用**

- 关联决策见 [ADR 0014](0014-fingerprint-resource-isolation.md) 与 [ADR 0018](0018-profile-engine-separation-and-bundle-generator.md)。
- 实操见 [Podman 单副本分册](../designs/podman-single.md) 与 [通用运维与灾备手册](../designs/operations-and-recovery.md)。
