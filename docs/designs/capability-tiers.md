# 能力分档 (Capability Tiers)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md)

## 概念

集合的工程能力按「装备」组织。「装备」= 一组文件 + 一组挂载点 (闸门链 / hooks / CI)。装备分三档, 生成新项目时按档组装 (见[生成器契约](scaffold-contract.md)); 每套装备都能单独裁剪。

## 三档

### 核心档 (集合里的每个仓库默认全带)

工程骨架与发布闭环, 缺任何一项都算没完工:

- **仓骨架**: workspaces / turbo / 根 tsconfig (双态 paths) / 五个配置文件 (oxlint / prettier / editorconfig / gitattributes / gitignorerc) / nvmrc / 版本 pin (`packageManager`) / bunfig / 双运行时纪律的文档位;
- **提交与钩子链**: lefthook + `install-git-hooks` (没装 lefthook 时降级) + `safe-install`;
- **闸门链单源**: `scripts/ci.ts` 是唯一的步骤清单 (workflows / hooks / 文档都以它为准);
- **通用闸门**: 引用一致性 / 示例可编译 / 散落备份 (`lint:refs` / `lint:examples` / `lint:backups`);
- **发布闭环**: `.releaserc` (semrel) + release workflow (OIDC + environment 人工闸门) + 发布自证 (`verify:release`, 按包) + 启动器自证 (有 bin 的包);
- **文档体系**: docs 索引 / designs 最小单元组织 (本组文档就是范例) / ADR 模板 / CONTRIBUTING / SECURITY / 行为准则;
- **AI 协作文件**: AGENTS.md (turbo 托管块, 自动再生成) / `.vscode` 推荐配置。

### 标准档 (推荐, 默认开)

- **多包分层**: 工具 + 库 (薄壳模式); 单包工具可跳过本档的包结构部分;
- **依赖方向闸门**: [依赖方向纪律](dependency-direction.md)由工具强制执行;
- **测试体系**: 契约测试 + e2e (双载体参数化) + 冒烟 (node-smoke 直跑);
- **技术债登记册**: [技术债登记](tech-debt.md)里说的那本册子。

### 增强档 (按需)

- **转写契约套件 (conformance)**: 行为契约 + 金样本语料 + 确定性验收器 + 变异自证 (机制文件随模板, 语料与条款是项目自填内容);
- **台账对账闸门** (`lint:coverage`): 契约 / 语料 / 豁免三方对账 (只对启用 conformance 的项目有意义)。

## 裁剪点约定

每套装备的裁剪 = 删除它的文件 + 删除它在 `ci.ts` 里的步骤声明。**前提**: 闸门清单先单源化 (现状清单散落在 package.json / ci.ts / lefthook / 两个 workflow 五处, 属于要先做的重构, 见[重定位执行与验证](collection-relocation.md))。单源化之前, 裁剪点按当时的实际挂载处逐一列出。

## 档位选择

- 生成新项目时, 生成器问一遍、当场选定 (见[生成器契约](scaffold-contract.md));
- 生成后升降档: 按「裁剪点约定」人工增删 (升档 = 从本仓搬入该档的文件并接上挂载点; 降档 = 按裁剪点反向操作);
- 档位不写进任何配置文件 (没有 `tier` 字段): 它只是生成那一刻的装箱单, 不是一个需要长期保存的字段, 免得同一件事得在两个地方同步。

## 修订记录

| 日期       | 修订                                                 |
| ---------- | ---------------------------------------------------- |
| 2026-09-30 | 初稿: 三档清单、裁剪点约定 (含单源化前提) 与档位策略 |
