# ADR 0010: 双包 monorepo 结构与可编程 API

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-29
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题陈述 (Context & Problem)

工具当前为单包形态: npm 包 `@iyowei/sweep-node-modules` (版本 0.4.0), 能力面 (扫描 / 测体积 / 安全删除 / 配置) 已成型, 并经九轮安全审计收敛与转写契约套件建设。

问题在能力通道的单一: 全部能力只经 CLI 暴露, 没有可编程 API 面; 程序 (CI 脚本、磁盘监控、编辑器集成等) 要调用这套能力, 只能解析终端输出或复制逻辑。

本次改造把仓库从单包拆为双包 monorepo: 可编程 API 包 (承载能力与契约) + CLI 薄壳包 (承载终端体验)。要裁的问题: 仓库结构与任务编排、包边界与包名、API 包的分发形态。CLI 分发形态 (单文件产物 / 三入口 / 白名单 / 产物自证) 已由 [ADR 0009](0009-npm-distribution-form.md) 裁定, 本次不动, 继续有效。

## 被放弃的替代方案 (Options Considered & Rejected)

**[pnpm / npm workspaces]**

放弃理由: 换包管理器要换锁文件、重验 bunfig 的 linker 与镜像策略、动发布链; 而既有链上工具 (lefthook 经 bunx 兜底、bun test、bun build) 全以 bun 为中心, 两个包的规模下收益不匹配成本。

**[Nx]**

放弃理由: 平台级工具 (project graph / generators / 插件 / 边界强制), 对单人维护的两个包规模属仪式感过剩; 其 bun 集成成熟度亦不及 Turborepo。

**[不引入任务编排器 (纯根目录脚本手排)]**

放弃理由: 本次改造本就重排工程基建, 任务编排一步立到位, 呼应项目既有取向「工程闸门、机制, 越早立越好」。

## 决策结论与选择原因 (Decision & Why)

1. **仓库结构 (双包 monorepo) 用 bun 原生 workspaces**: 根 package.json 声明 `workspaces` 字段, 包间依赖用 `workspace:*` 协议 (依据: bun 官方文档 pm/workspaces); `bun publish` 发布时自动把 `workspace:*` / `workspace:^` / `workspace:~` 替换为目标包的实际版本号 (依据同上)。

2. **任务编排用 Turborepo** (原话「编排上 turbo」): Turborepo 支持 bun 的 lockfile (`bun.lock` 文本锁) 做依赖图解析与 prune, 与 bun workspaces 的组合是可行路径; bun catalogs 在该组合下尚无支持, 本仓不用 catalogs, 不受影响。

3. **切分原则: CLI 薄壳, 业务语义全归 API 包** (原话「cli 应该就是薄壳, 其余应该都是 api 部分」): CLI 包只做「解析 → 调 API → 渲染 → 交互确认」, 不承载业务逻辑。

4. **包名翻转**: `@iyowei/sweep-node-modules` 的内容改为 API 包并继续演进; CLI 新起为 `@iyowei/sweep-node-modules-cli` (原话「反正 api 部分也跟着整体改进, 所以既有版本号不是问题」)。同名包内容翻转的版本语义变化 (0.x 内) 被显式接受。

5. **API 包以编译产物 + 类型声明分发**: `bun build` 出 JS 产物, `tsc --emitDeclarationOnly` 出类型声明 (`.d.ts`); 分发态约束与 CLI 侧同源 (安装后位于 `node_modules` 之下, 见 [ADR 0009](0009-npm-distribution-form.md)), 双运行时策略 ([ADR 0006](0006-dual-runtime-bun-first.md)) 对 API 包同样适用。

6. **API 面设计先行**: API 面经「使用方视角场景调研 + 设计草案 + 使用方体验验证 (灵活 / 够用 / 好用)」后定稿; 设计细节另落文档, 不在本 ADR 展开。

7. **本地发布走 `bun publish`**: 打包时会执行 `prepublishOnly`, 本仓发布闸门的挂点在其下依旧生效 (依据: [ADR 0009](0009-npm-distribution-form.md) 补记第 4 条, 2026-09-26 已联网核验)。`bun publish` 目前未接 npm 的 OIDC Trusted Publishing / provenance (社区现状), 将来 CI 签名发布走 npm 本体。

选择原因: 两个包的规模下, bun 原生 workspaces 与 Turborepo 的组合复用既有工具链 (lefthook、bun test、bun build、发布链), 不引第二套包管理器与平台级工具; 包边界与职责边界重合, 业务语义全在 API 包一处实现, CLI 是其消费方。

## 后果与权衡妥协 (Consequences & Trade-offs)

**正面收益**

- 能力获得可编程接入面: CI 脚本、磁盘监控、编辑器集成等程序可直接消费 API 包, 不必解析终端输出或复制逻辑;
- CLI 与 API 同源: 业务语义 (扫描 / 测体积 / 安全删除 / 配置) 全量落在 API 包一处实现, CLI 是它的消费方之一;
- 既有成果随能力进 API 包: 九轮安全审计收敛与转写契约套件 ([ADR 0008](0008-transcription-kit.md)) 的归属随包边界明确, 不在拆包中缩水。

**权衡妥协**

- 迁移面: 代码按切分原则搬家与 import 重连; 工程闸门 (lefthook 两层 / `verify-release` 发布闸门 / `files` 白名单 / `prepublishOnly`) 需在两个包上重落位 (闸门结构与判定不变, 落位点与配置变, 见 [ADR 0005](0005-engineering-gates-and-hooks.md));
- 包名翻转影响既有消费方: `@iyowei/sweep-node-modules` 的既有安装者升级后将拿到 API 包, CLI 需改从 `@iyowei/sweep-node-modules-cli` 安装; 该版本语义变化在 0.x 内被显式接受;
- README 拆家: CLI 包 README 由现根 README 迁移适配, API 包 README 新写 (含包定位变更说明: 同名包内容由 CLI 翻转为 API, CLI 迁至 `-cli` 包), 根 README 瘦身为仓库索引; 三份均维持英文主 + 中文副双版 (沿用 [ADR 0009](0009-npm-distribution-form.md) 补记第 5 条的双语机制);
- 本地发布暂缺签名链路: `bun publish` 未接 npm 的 OIDC Trusted Publishing / provenance, 待将来 CI 签名发布切 npm 本体补齐;
- 文档连带: 设计总纲 / 开发指南 / 文档索引随结构同步更新 (沿用仓库防漂移纪律), 属实施阶段义务。

## 补记 (实施落地, 2026-09-29)

决策 5 与「闸门重落位」落地时定下的三条细则 (均经实测, 非文档推断; 实现见 `packages/sweep-node-modules/scripts/` 与根 `tsconfig.json`):

1. **开发态 / 发布态解析分离**: API 包 `exports` 只写发布态 (dist); monorepo 开发态由根 tsconfig 的 `paths` 直指单源 src。`paths` 优先于 node_modules 解析在 bun 运行时 / tsc / bun build 三处实测成立 (覆盖 tsconfig extends 继承与 node_modules 同名包并存两个场景), CLI 消费方零改动、开发态零构建; bun 官方文档 (Module resolution 页) 明载支持 `compilerOptions.paths` 重映射且解析序先于 node_modules, 与本仓实测互证。**node 不在其列** (2026-09-29 CI 实翻): node 不解析 tsconfig paths, 直跑仓库内消费方源码 (如 `node packages/sweep-node-modules-cli/src/cli.ts`) 时按 exports 解析到 dist, **需先构建**: CI 的 conformance job 因此带 Build 前置, 本地预演入口为 `bun run ci` (pre-push 钩子按同集合执行; bun 直跑无此需要)。
2. **`.d.ts` 需产物层后处理**: `tsc --emitDeclarationOnly` 会把源码的相对 specifier (`'./x.ts'`) 原样写进声明, 消费方 TS 无法解析; `rewriteRelativeImportExtensions` 在 typescript 7.0.2 的 declaration emit 下实测未生效, 故由构建脚本统一改写为 `.js` (确定性、幂等)。
3. **闸门在双包各自重落位**: 结构与判定同源 (干净检出 + 产物自证 + 清单自洽 + 发行面白名单), 配置各包私有; CLI 特有的 launcher 自证不适用于 API 包, API 包另加 d.ts specifier 复查。另: npm 的 `publishConfig` 不支持覆盖 `exports` (npm pack 实测); `"bun"` 条件导出方案亦排除: 官方行为为命中缺失目标不回退 default 直接报错 (修复 PR oven-sh/bun#36637 未合并), 发布包内不得出现指向 src 的 bun 条件。

## 验证方式与关联引用 (Validation & References)

**验证口径 (落地后核验)**

1. 双包各自构建通过; 全量测试 (单元 / 契约 / 双载体 e2e / 冒烟 / 转写 conformance) 全绿;
2. `bun publish` 干跑, 验证 `workspace` 协议在发布时被替换为目标包实际版本号的实际行为;
3. 迁移前后 CLI 对外行为等价 (以既有金样本与 e2e 用例为尺)。

**关联引用**

- 闸门重落位不改结构, 见 [ADR 0005](0005-engineering-gates-and-hooks.md); 双运行时策略见 [ADR 0006](0006-dual-runtime-bun-first.md), 对 API 包同样适用; 转写契约套件随能力进 API 包, 见 [ADR 0008](0008-transcription-kit.md)。
- CLI 分发形态由 [ADR 0009](0009-npm-distribution-form.md) 继续管辖 (单文件产物 / 三入口 / 白名单 / 产物自证不变); `bun publish` 执行 `prepublishOnly` 的依据见其补记第 4 条。
- 修订义务: [ADR 0007](0007-platform-portability.md) / [ADR 0009](0009-npm-distribution-form.md) 等文本中「本包 / `@iyowei/sweep-node-modules`」的指代对象随包名翻转而变, 按既有惯例 (保留原文 + 修订指引) 由实施阶段落地。
- 结构细节见 [设计总纲](../designs/sweep-node-modules-design.md), 操作细节见 [开发指南](../development.md); API 面设计细节另落文档, 本文不复述。
