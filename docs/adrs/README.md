# 架构决策记录索引

这里按编号顺序列出本仓全部 ADR。新增决策顺延编新编号; 已接受的记录不回头改, 要修订, 就写新 ADR 或补充说明。编号全局唯一, 仓库级和包级共用一套编号; 怎么分层、链接怎么指, 见 [ADR 0011](0011-docs-and-adr-layering.md)。全部编号都在表里; 包级 ADR 的链接指向包内实际位置。

| 编号                                                                                           | 标题                                                            | 状态   | 日期       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------ | ---------- |
| [0001](../../packages/sweep-node-modules/docs/adrs/0001-workspace-level-cleaner.md)            | 工作区级清理工具定位                                            | 已接受 | 2026-09-23 |
| [0002](../../packages/sweep-node-modules/docs/adrs/0002-fixed-config-and-preview-execution.md) | 固定配置与预览执行模型                                          | 已接受 | 2026-09-23 |
| [0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md)                  | 零运行时依赖                                                    | 已接受 | 2026-09-23 |
| [0004](../../packages/sweep-node-modules/docs/adrs/0004-config-initialization-wizard.md)       | 配置初始化向导                                                  | 已接受 | 2026-09-23 |
| [0005](0005-engineering-gates-and-hooks.md)                                                    | 工程闸门与提交钩子                                              | 已接受 | 2026-09-23 |
| [0006](0006-dual-runtime-bun-first.md)                                                         | 双运行时支持与 Bun 优先的 API 策略                              | 已接受 | 2026-09-23 |
| [0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md)               | 三平台可移植性与配置定位                                        | 已接受 | 2026-09-23 |
| [0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)                  | 转写契约套件                                                    | 已接受 | 2026-09-23 |
| [0009](0009-npm-distribution-form.md)                                                          | npm 分发形态                                                    | 已接受 | 2026-09-23 |
| [0010](0010-dual-package-monorepo.md)                                                          | 双包 monorepo 结构与可编程 API                                  | 已接受 | 2026-09-29 |
| [0011](0011-docs-and-adr-layering.md)                                                          | 文档与 ADR 的仓库级 / 包级两级分层                              | 已接受 | 2026-09-30 |
| [0012](../../packages/codd/docs/adrs/0012-single-node-replica-set.md)                          | 默认采用单节点副本集 (oplog 990MB) 而非单机模式                 | 已接受 | 2026-11-18 |
| [0013](../../packages/codd/docs/adrs/0013-containerized-bun-tools-and-single-version.md)       | 工具脚本采用容器化 Bun + TypeScript 与版本单点管控              | 已接受 | 2026-11-18 |
| [0014](../../packages/codd/docs/adrs/0014-fingerprint-resource-isolation.md)                   | 全链路宿主资源与路径由单个 FINGERPRINT 派生实现 100% 零命名冲突 | 已接受 | 2026-11-18 |
| [0015](../../packages/codd/docs/adrs/0015-compact-2c2g-resource-budget.md)                     | 以 2C2G 紧缩基线为锚点动态推算 MongoDB 9.0 全套配额             | 已接受 | 2026-11-18 |
| [0016](../../packages/codd/docs/adrs/0016-loopback-and-least-privilege-security.md)            | 安全边界采用本机回环隔离、运行时自建密钥与最小权限三账号        | 已接受 | 2026-11-18 |
| [0017](../../packages/codd/docs/adrs/0017-single-replica-set-multi-db-isolation.md)            | 同副本集按业务库与独立账号隔离多业务                            | 已接受 | 2026-11-18 |
| [0018](../../packages/codd/docs/adrs/0018-profile-engine-separation-and-bundle-generator.md)   | 消除规格目录分叉, 统一为模板资产 + CLI 输出自包含零冲突部署包   | 已接受 | 2026-11-18 |
