# 装置分档 (Capability Tiers)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md)

## 概念

集合的工程能力按「装置」组织。「装置」= 一组文件集 + 一组挂载点 (闸门链 / hooks / CI)。分三档, 生成新项目时按档组装 (见[生成器契约](scaffold-contract.md)); 每个装置可独立裁剪。

## 三档

### 核心档 (每个成员仓默认全带)

工程骨架与发布闭环, 缺任何一项都属未完工:

- **仓骨架**: workspaces / turbo / 根 tsconfig (双态 paths) / 五个配置件 (oxlint / prettier / editorconfig / gitattributes / gitignorerc) / nvmrc / 版本 pin (`packageManager`) / bunfig / 双运行时纪律的文档位;
- **提交与钩子链**: lefthook + `install-git-hooks` (无 lefthook 环境降级) + `safe-install`;
- **闸门链单源**: `scripts/ci.ts` 为唯一步骤清单 (workflows / hooks / 文档一律指代它);
- **通用闸门**: 引用一致性 / 示例可编译 / 散落备份 (`lint:refs` / `lint:examples` / `lint:backups`);
- **发布闭环**: `.releaserc` (semrel) + release workflow (OIDC + environment 人工闸门) + 发布自证 (`verify:release`, 按包) + 启动器自证 (有 bin 的包);
- **文档体系**: docs 索引 / designs 最小单元组织 (本组文档即其范例) / ADR 模板 / CONTRIBUTING / SECURITY / 行为准则;
- **AI 协作件**: AGENTS.md (turbo 托管块, 自动再生成) / `.vscode` 推荐件。

### 标准档 (推荐, 默认开)

- **多包分层**: 工具 + 库 (薄壳模式); 单包工具可跳过本档的包结构部分;
- **依赖方向闸门**: [依赖方向纪律](dependency-direction.md)的物理执行;
- **测试体系**: 契约测试 + e2e (双载体参数化) + 冒烟 (node-smoke 直跑);
- **技术债登记册**: [技术债登记](tech-debt.md)的载体。

### 强装置档 (按需)

- **转写契约套件 (conformance)**: 行为契约 + 金样本语料 + 确定性验收器 + 变异自证 (机制文件随模板, 语料与条款是项目自填内容);
- **台账对账闸门** (`lint:coverage`): 契约 × 语料 × 豁免三角对账 (只对启用 conformance 的项目有意义)。

## 裁剪点约定

每个装置的裁剪 = 删除其文件集 + 删除其在 `ci.ts` 的步骤声明。**前提**: 闸门清单单源化 (现状清单散布于 package.json / ci.ts / lefthook / 两个 workflow 五处, 属先行重构, 见[重定位执行与验证](collection-relocation.md))。单源化之前, 裁剪点按当时的实际挂载处逐一列出。

## 档位选择

- 新项目生成时经[生成器契约](scaffold-contract.md)问询选定;
- 生成后升降档: 按「裁剪点约定」人工增删 (升档 = 从本仓搬入装置文件 + 挂载; 降档 = 裁剪点反向操作);
- 档位不落进任何配置文件 (无 `tier` 字段): 档位是生成时刻的组装箱单, 不是长期状态字段, 避免制造需要同步的第二事实源。

## 修订记录

| 日期       | 修订                                                 |
| ---------- | ---------------------------------------------------- |
| 2026-09-30 | 初稿: 三档清单、裁剪点约定 (含单源化前提) 与档位策略 |
