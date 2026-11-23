# 模板快照机制 (Template Snapshot)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [生成器包](scaffold-package.md)

## 一句话说清

模板**不是**需要维护的副本, 而是本仓骨架的**泛化快照**: 由生成器包的构建步骤直接从本仓产出。仓库改了, 模板就跟着改, 不需要人工同步。

## 骨架清单 (快照取哪些文件)

快照**只取清单里列出的文件**, 不整个仓库照搬。清单里的文件分四类处置:

| 类       | 内容                                                                                                                                                                                                                                                                            | 处置                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 直接快照 | 纯通用配置文件 (editorconfig / gitattributes / nvmrc / npmrc / prettierrc / releaserc / lefthook) / workflows / 无原项目词面的通用脚本与转写基建 (`ci` / `install-git-hooks` / `safe-install` / `lint-dependency-direction` / `lint-stray-backups` / `docs/transcription/*` 等) | 原样进模板                                                                                           |
| 泛化替换 | 含原项目复合词面的骨架文件 (如 `CODE_OF_CONDUCT.md`、`LICENSE`、`lint-doc-examples`、`lint-doc-references`、`npm-trust-guard`、启动器与发布自证脚本等, 逐条登记在 `packages/create-clis/scripts/template-manifest.ts` 的 `generalize` 条目里; 数量随清单走, 不在此写死)         | 按词汇表替换后进模板                                                                                 |
| 重置     | 含本仓多产品排除项的根配置 (oxlint / prettierignore / gitignorerc / gitignore / bunfig / turbo / tsconfig / lint-doc-shared) / 根与包 README / docs 骨架 / 示例双包源码与最小增强档协议语料骨架 (`packages/<name>/docs/protocol/`)                                              | 换成干净的模板化骨架 (无私有产品路径与区域镜像污染, 使包含 `full` 在内的三档生成物开箱全绿) 再进模板 |
| 排除     | 领域与私有内容: 各非骨架包 (`codd` / `codd-cli` / `create-clis` / `cli-updater`)、仓内 AI 技能 (`.agents/`)、`.mailmap`、`bun.lock`、本仓产品专属设计与基准及历史 ADR                                                                                                           | 不进模板                                                                                             |

这份清单 (`packages/create-clis/scripts/template-manifest.ts`) 是这套机制唯一需要登记的地方: 本仓新增骨架文件时, 判断它的分类, 往清单加一行就行。

## 泛化词汇表

| 变量           | 含义                                | 出现位置 (全部替换)                 |
| -------------- | ----------------------------------- | ----------------------------------- |
| `{{NAME}}`     | 项目名 (如 `sweep` 或 `my-tool`)    | 包名 / 目录名 / 文档标题            |
| `{{SCOPE}}`    | npm scope (如 `@iyowei`)            | 包名前缀                            |
| `{{BIN_NAME}}` | 主 bin 名 (如 `sweep` 或 `my-tool`) | bin 字段 / 启动器 / 帮助页          |
| `{{OWNER}}`    | 仓库所有者                          | LICENSE / package.json author       |
| `{{REPO_URL}}` | 仓库地址                            | repository / homepage / bugs / 徽章 |

## 构建自检 (构建即闸门)

快照产出后, 构建步骤必须检查:

1. 清单内每个文件都成功产出, 并透传源文件/骨架原有权限位 (保持 `bin/` 启动器 `+x`);
2. 泛化后模板内**不再出现原项目词汇** (无歧义复合形态, 见 `packages/create-clis/src/render.ts`);
3. **排除包路径与区域镜像零泄漏**: 自动从清单中全部 `exclude` 的 `packages/<pkg>/` 派生路径禁词 (如 `packages/codd`、`packages/codd-cli`、`packages/create-clis`、`packages/cli-updater`) 并加上 `registry.npmmirror.com`、`sweep-lab`、`docs/sweep/`, 仅对业务产品包 (`leakScope !== 'infra'`) 额外派生裸短名边界禁词 (共享基础设施库如 `cli-updater` 记为 `infra` 以避免误杀英文常用词), 任一产出文件内容或路径命中即构建失败。

## 生成器怎么用模板

生成器 (详见[生成器契约](scaffold-contract.md)) 以 `assets/template/` 为唯一输入, 按档裁剪 (见[能力分档](capability-tiers.md)) 并代入用户变量, 产出新项目。

## 修订记录

| 日期       | 修订                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | 初稿: 四类处置清单、泛化词汇表、构建自检与生成器用法                                                    |
| 2026-10-01 | 占位符拼写改为双花括号大写形态 (`{{NAME}}` 式): 单花括号 `{name}` 是 JS 插值 `${name}` 的真子串, 会撞车 |
| 2026-10-01 | 骨架清单去掉写死的泛化计数 (改指构建清单文件); 构建自检口径与裸词收窄后的词面一致                       |
| 2026-11-20 | 同步词汇表示例为 `sweep`                                                                                |
| 2026-11-21 | 排除包禁词按 `leakScope` 分流: `infra` 通用共享库仅拦截完整包路径, 避免短名误伤英文常用词               |
