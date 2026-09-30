# ADR 0010: 双包 monorepo 结构与可编程 API

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-29
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

工具目前是单包形态: npm 包 `@iyowei/sweep-node-modules` (版本 0.4.0), 能力 (扫描 / 测体积 / 安全删除 / 配置) 已成型, 九轮安全审计已经收敛, 转写契约套件也已建起。

问题在于能力的通道只有一条: 全部能力只能走 CLI, 没有可编程 API; 程序 (CI 脚本、磁盘监控、编辑器集成等) 要调用这套能力, 只能解析终端输出或复制逻辑。

本次改造把仓库从单包拆成双包 monorepo: 可编程 API 包 (放能力与契约) + CLI 薄壳包 (管终端体验)。要拍板的问题: 仓库结构与任务编排、包边界与包名、API 包的分发形态。CLI 分发形态 (单文件产物 / 三入口 / 白名单 / 产物自证) 已由 [ADR 0009](0009-npm-distribution-form.md) 裁定, 本次不动, 继续有效。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[pnpm / npm workspaces]**

放弃理由: 换包管理器要换锁文件、重验 bunfig 的 linker 与镜像策略、动发布链; 而现有工具链上的工具 (lefthook 走 bunx 兜底、bun test、bun build) 全都以 bun 为中心, 在两个包的规模下, 收益抵不上成本。

**[Nx]**

放弃理由: 平台级工具 (project graph / generators / 插件 / 边界强制), 对单人维护、只有两个包的规模来说, 仪式感过剩; bun 集成也没有 Turborepo 成熟。

**[不引入任务编排器 (纯根目录脚本手排)]**

放弃理由: 本次改造本就重排工程基建, 任务编排趁这一次一并立到位, 也符合项目一贯的取向「工程闸门、机制, 越早立越好」。

## 决策与理由 (Decision & Why)

1. **仓库结构 (双包 monorepo) 用 bun 原生 workspaces**: 根 package.json 声明 `workspaces` 字段, 包间依赖用 `workspace:*` 协议 (依据: bun 官方文档 pm/workspaces); `bun publish` 发布时自动把 `workspace:*` / `workspace:^` / `workspace:~` 替换为目标包的实际版本号 (依据同上)。

   > **补记 (2026-09-30)**: 包间依赖后来改为**精确版本号** (见 CLI 包 devDependencies), `workspace:*` 协议与发布时替换行为不再适用; 原文保留, 记录当初的决策。

2. **任务编排用 Turborepo** (原话「编排上 turbo」): Turborepo 支持 bun 的 lockfile (`bun.lock` 文本锁) 做依赖图解析与 prune, 能和 bun workspaces 组合着用; bun catalogs 在这个组合下还不支持, 本仓不用 catalogs, 不受影响。

3. **切分原则: CLI 薄壳, 业务语义全归 API 包** (原话「cli 应该就是薄壳, 其余应该都是 api 部分」): CLI 包只做「解析 → 调 API → 渲染 → 交互确认」, 不碰业务逻辑。

4. **包名翻转**: `@iyowei/sweep-node-modules` 的内容改为 API 包并继续演进; CLI 另起新包 `@iyowei/sweep-node-modules-cli` (原话「反正 api 部分也跟着整体改进, 所以既有版本号不是问题」)。同名包内容翻转的版本语义变化 (0.x 内), 已明确接受。

5. **API 包以编译产物 + 类型声明分发**: `bun build` 出 JS 产物, `tsc --emitDeclarationOnly` 出类型声明 (`.d.ts`); 分发态的约束跟 CLI 侧一样 (装好后落在 `node_modules` 里, 见 [ADR 0009](0009-npm-distribution-form.md)), 双运行时策略 ([ADR 0006](0006-dual-runtime-bun-first.md)) 对 API 包同样适用。

6. **先定 API 设计**: API 经「使用方视角的场景调研 + 设计草案 + 使用方体验验证 (灵活 / 够用 / 好用)」后定稿; 设计细节另写专门文档, 不在本 ADR 展开。

7. **本地发布走 `bun publish`**: 打包时会执行 `prepublishOnly`, 本仓发布闸门就挂在它下面, 依旧生效 (依据: [ADR 0009](0009-npm-distribution-form.md) 补记第 4 条, 2026-09-26 已联网核验)。`bun publish` 目前未接 npm 的 OIDC Trusted Publishing / provenance (社区现状), 将来 CI 签名发布走 npm 本体。**修订指引 (2026-09-30)**: 「将来」已经兑现: CI 发布链已落地 (environment 人工批准闸门 + npm OIDC Trusted Publishing + provenance, 不设 npm token, 见 `.github/workflows/release.yml`)。

理由: 在两个包的规模下, bun 原生 workspaces 与 Turborepo 的组合能复用现有工具链 (lefthook、bun test、bun build、发布链), 不引入第二套包管理器与平台级工具; 两个包的边界与职责边界重合, 业务语义全部落在 API 包一处实现, CLI 只是它的使用方。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 能力有了可编程入口: CI 脚本、磁盘监控、编辑器集成等程序可直接调用 API 包, 不必解析终端输出或复制逻辑;
- CLI 与 API 用同一份实现: 业务语义 (扫描 / 测体积 / 安全删除 / 配置) 全部落在 API 包一处实现, CLI 只是它的使用方之一;
- 已有成果随能力一起进 API 包: 九轮安全审计的收敛成果、转写契约套件 ([ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)) 的归属随包边界明确, 不在拆包中缩水。

**代价**

- 迁移范围: 代码按切分原则搬家, import 重新接上; 工程闸门 (lefthook 两层 / `verify-release` 发布闸门 / `files` 白名单 / `prepublishOnly`) 要在两个包上重新落位 (闸门结构与判定不变, 落位点与配置变, 见 [ADR 0005](0005-engineering-gates-and-hooks.md));
- 包名翻转影响现有用户: 安装 `@iyowei/sweep-node-modules` 的人升级后会拿到 API 包, CLI 要改从 `@iyowei/sweep-node-modules-cli` 安装; 这一版本语义变化在 0.x 内, 已明确接受;
- README 拆家: CLI 包 README 由现在的根 README 迁移并适配, API 包 README 新写 (含包定位变更说明: 同名包内容由 CLI 翻转为 API, CLI 迁到 `-cli` 包), 根 README 瘦身为仓库索引; 三份都维持英文为主、中文为辅的双版 (沿用 [ADR 0009](0009-npm-distribution-form.md) 补记第 5 条的双语机制);
- 本地发布暂缺签名链路: `bun publish` 未接 npm 的 OIDC Trusted Publishing / provenance, 这个缺口已由 CI 发布链补齐 (2026-09-30; 见决策 7 修订指引);
- 相关文档: 设计总纲 / 开发指南 / 文档索引随结构同步更新 (沿用仓库防漂移纪律), 留到实施阶段完成。

## 补记 (实施落地, 2026-09-29)

决策 5 与「闸门重落位」落地时定下的三条细则 (都是实测出来的, 不是从文档推断的; 实现见 `packages/sweep-node-modules/scripts/` 与根 `tsconfig.json`):

1. **开发态 / 发布态解析分离**: API 包 `exports` 只写发布态 (dist); monorepo 开发态由根 tsconfig 的 `paths` 直接指向单源 src。`paths` 优先于 node_modules 解析, 在 bun 运行时 / tsc / bun build 三处实测成立 (覆盖 tsconfig extends 继承与 node_modules 同名包并存两个场景), CLI 这边零改动、开发态零构建; bun 官方文档 (Module resolution 页) 明确写着支持 `compilerOptions.paths` 重映射, 且解析顺序在 node_modules 之前, 与本仓实测互相印证。**node 不在其列** (2026-09-29 CI 实测发现): node 不解析 tsconfig paths, 直接跑仓库里的使用方源码 (如 `node packages/sweep-node-modules-cli/src/cli.ts`) 时会按 exports 解析到 dist, **必须先构建**: CI 的 conformance job 因此加了 Build 前置步骤, 本地预演的入口是 `bun run ci` (pre-push 钩子按同一套步骤执行; bun 直接跑不需要先构建)。
2. **`.d.ts` 需在产物层再处理一道**: `tsc --emitDeclarationOnly` 会把源码的相对 specifier (`'./x.ts'`) 原样写进声明, 使用方的 TS 解析不了; `rewriteRelativeImportExtensions` 在 typescript 7.0.2 的 declaration emit 下实测未生效, 所以由构建脚本统一改写成 `.js` (确定性、幂等)。
3. **闸门在双包上各自重落位**: 结构与判定两边一致 (干净检出 + 产物自证 + 清单自洽 + 发行面白名单), 配置各包私有; CLI 特有的 launcher 自证不适用于 API 包, API 包另加 d.ts specifier 复查。另: npm 的 `publishConfig` 不支持覆盖 `exports` (npm pack 实测); `"bun"` 条件导出这条路也排除: 官方行为是命中缺失目标时不回退 default, 直接报错 (修复 PR oven-sh/bun#36637 未合并), 发布包内不得出现指向 src 的 bun 条件。

## 验证方式与关联引用 (Validation & References)

**改完后的实测**

1. 双包各自构建通过; 全量测试 (单元 / 契约 / 双载体 e2e / 冒烟 / 转写 conformance) 全绿;
2. `bun publish` 干跑, 验证 `workspace` 协议在发布时会被替换为目标包的实际版本号 (2026-09-30 标注: 已作废, 包间依赖改精确版本后无 `workspace` 协议待替换, 见决策 1 补记; 这项验证不再适用);
3. 迁移前后 CLI 对外行为等价 (以现有金样本与 e2e 用例为尺)。

**延伸阅读**

- 闸门重落位不改结构, 见 [ADR 0005](0005-engineering-gates-and-hooks.md); 双运行时策略见 [ADR 0006](0006-dual-runtime-bun-first.md), 对 API 包同样适用; 转写契约套件随能力一起进 API 包, 见 [ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)。
  > **修订指引 (2026-09-30)**: 套件归属经复审后重新裁定为**仓库根** (`scripts/transcription/` 与 `docs/sweep/protocol/` 都在仓库根下): 归属判据从「随能力」改成「随服务对象」 (套件服务于两个包和未来的多语言重写, 属仓库级设施; 双面验收横跨两个包的职责, 原判据无解), 见 [转写双面覆盖](../sweep/designs/transcription-dual-surface.md)。
- CLI 分发形态由 [ADR 0009](0009-npm-distribution-form.md) 继续管辖 (单文件产物 / 三入口 / 白名单 / 产物自证不变); `bun publish` 执行 `prepublishOnly` 的依据见其补记第 4 条。
- 修订义务: [ADR 0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md) / [ADR 0009](0009-npm-distribution-form.md) 等文本中「本包 / `@iyowei/sweep-node-modules`」的指代对象随包名翻转而变, 按惯例 (保留原文 + 修订指引) 留到实施阶段落地。
- 结构细节见 [设计总纲](../sweep/designs/sweep-node-modules-design.md), 操作细节见 [开发指南](../development.md); API 设计细节另写专门文档, 本文不复述。
