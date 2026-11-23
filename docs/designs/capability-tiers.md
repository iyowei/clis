# 能力分档 (Capability Tiers)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md)

## 概念

集合的工程能力按「装备」组织。「装备」= 一组文件 + 一组挂载点 (闸门链 / hooks / CI)。装备分三档, 生成新项目时按档组装 (见[生成器契约](scaffold-contract.md)); 每套装备的裁剪点都有明文约定 (见下文「裁剪点约定」)。

## 三档

### 核心档 (集合里的每个仓库默认全带)

工程骨架与发布闭环, 缺任何一项都算没完工:

- **仓骨架**: workspaces / turbo / 根 tsconfig (双态 paths) / 五个配置文件 (oxlint / prettier / editorconfig / gitattributes / gitignorerc) / nvmrc / 版本 pin (`packageManager`) / bunfig / 双运行时纪律的文档位;
- **提交与钩子链**: lefthook + `install-git-hooks` (没装 lefthook 时降级) + `safe-install`;
- **闸门链单源**: `scripts/ci.ts` 是唯一的步骤清单 (workflows / hooks / 文档都以它为准);
- **通用闸门**: 引用一致性 / 示例可编译 / 散落备份 (`lint:refs` / `lint:examples` / `lint:backups`);
- **发布闭环**: `.releaserc` (semrel) + release workflow (OIDC + environment 人工闸门) + 发布凭据预检 (`npm-trust-guard` + Release 的 `release` job 预检步, 2026-10-01 增) + 发布自证 (`verify:release`, 按包) + 启动器自证 (有 bin 的包);
- **文档体系**: docs 索引 / designs 最小单元组织 (本组文档就是范例) / ADR 模板 / CONTRIBUTING / SECURITY / 行为准则;
- **AI 协作文件**: AGENTS.md (turbo 托管块, 自动再生成) / `.vscode` 推荐配置。

### 标准档 (推荐, 默认开)

- **多包分层**: 工具 + 库 (薄壳模式); 单包工具可跳过本档的包结构部分 (该条的解读见「裁剪点约定」);
- **依赖方向闸门**: [依赖方向纪律](dependency-direction.md)由工具强制执行;
- **测试体系**: 契约测试 + e2e (双载体参数化) + 冒烟 (node-smoke 直跑);
- **技术债登记册**: [技术债登记](tech-debt.md)里说的那本册子。

### 增强档 (按需)

- **转写契约套件 (conformance)**: 仓级通用纪律 (`docs/transcription/`) + 通用引擎 (`scripts/transcription/`) + 包级行为契约/金样本语料/模糊目标/变异清单 (`packages/<api>/docs/protocol/`); 包含跨平台便携验证 (`conformance:portable`) 与 macOS 全量双运行时验收 (`conformance:bun` / `conformance:node`);
- **台账对账、变异锚点与差分模糊闸门**: `lint:coverage` (契约 / 语料 / 覆盖表 / 双面 / 豁免替代测试 / 变异表深度对账)、`lint:mutants` (`make-mutants.ts --check-anchors` 锚点守卫) 与 `fuzz` / `fuzz:diff` (纯函数不变量与跨运行时差分模糊测试)。

## 裁剪点约定

有独立载体的装备, 裁剪 = 删除它的文件 (增强档含 `scripts/transcription/`、`docs/transcription/` 与 `packages/{{NAME}}/docs/`) + 删除它在 `ci.ts` 里的步骤声明 (含已空壳的分组与 CLI 旗标分支) + 删除它在根 `package.json` 里的脚本挂载 (`conformance` / `fuzz` / `fuzz:diff`) + 删除它在 `.github/workflows/ci.yml` 里的对应 job (`conformance` job 仅定义于 `.github/workflows/ci.yml`, `release.yml` 经 `workflow_call` 复用 `ci.yml`; 裁剪该处即可避免 PR 与发布双路径白跑 macOS runner) + 同步摘除生成物模板 `docs/README.md` 的「转写协议」章节与 PR 模板中的 conformance checklist 行。

标准档中**依赖方向闸门 (`scripts/lint-dependency-direction.ts` + `lint:deps`) 与技术债登记册 (`docs/designs/tech-debt.md`)** 均已具备独立裁剪载体 (`core` 档完整摘除, `standard` 默认档保留); 其余两套结构性装备为形状选择 / 豁免 (不落文件删除):

- **多包分层**: 生成器的定位就是产出独立的新集合仓 (双包形态), 单包化要生成期重写而非删文件; core 档保留双包形态;
- **测试体系**: 三类测试的实现件全在各包 `src/` 槽位 (该槽位已判 reset, 本就不进模板); 模板内剩余测试皆为核心档闸门 / 发布链各自的配套测试, 不落删除。

## 档位选择

- 生成新项目时默认采用 `standard` 标准档 (交互模式聚焦收集五个基础身份变量, 不额外提问档位; 需 `core` 或 `full` 档时经 `--tier <core|standard|full>` 显式指定, 见[生成器契约](scaffold-contract.md));
- 生成后升降档: 按「裁剪点约定」人工增删 (升档 = 从本仓搬入该档的文件并接上挂载点; 降档 = 按裁剪点反向操作);
- 档位不写进任何配置文件 (没有 `tier` 字段): 它只是生成那一刻的装箱单, 不是一个需要长期保存的字段, 免得同一件事得在两个地方同步。

## 修订记录

| 日期       | 修订                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | 初稿: 三档清单、裁剪点约定 (含单源化前提) 与档位策略                                                                                                                                          |
| 2026-10-01 | 发布闭环补发布凭据预检装备; 裁剪点约定的单源化前提随落地更新为既成                                                                                                                            |
| 2026-10-01 | 裁剪点约定补结构性装备的形状选择 / 豁免口径                                                                                                                                                   |
| 2026-10-01 | 裁剪点约定补根 package.json 脚本挂载面 (conformance 悬空脚本修复随动)                                                                                                                         |
| 2026-11-20 | 裁剪点约定同步: `conformance` job 仅定义于 `.github/workflows/ci.yml` (`release.yml` 经 `workflow_call` 复用), 补齐 `ci.ts` 空壳分组与 `--conformance` 分支同步摘除口径                       |
| 2026-11-22 | 增强档与裁剪点同步: 纳入 `docs/transcription/`、`packages/<api>/docs/protocol/`、`lint:mutants`、`fuzz` / `fuzz:diff`、`conformance:portable` 与生成物模板 `docs/README.md` / PR 模板联动摘除 |
| 2026-11-22 | 档位选择口径对齐实现与 `scaffold-contract.md`: 默认采用 `standard` 档 (交互模式仅收集五项身份变量, 其余档位经 `--tier` 显式指定)                                                              |
