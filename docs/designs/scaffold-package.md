# 生成器包 (Scaffold Package)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md); 模板来源见[模板快照机制](scaffold-template-snapshot.md)

## 定位

生成器是集合里的一个包, 属于 CLI 工具一类 (有 `bin`)。这个包用[模板快照](scaffold-template-snapshot.md)产出一个**独立的新集合仓** (不是往本仓加包)。

## 命名与分发

- 包名: `create-clis` (不带 scope, 见[技术债登记](tech-debt.md));
- 分发渠道: 复用生态现成的 create 约定 (已核实各官方文档): `npm create clis`→`npm exec create-clis`; `pnpm create clis`; `bun create clis`≡`bunx create-clis`; 直接 `bunx create-clis` 亦可;
- 生成物是独立目录 (可 `git init` 为独立仓库), 与本仓无持续关系 (生成即脱离)。

## 构建

生成器包有两个构建产物, 都出自同一条构建链:

1. **模板资产**: `scripts/build-template.ts` 按快照机制产出的 `assets/template/` (见[模板快照机制](scaffold-template-snapshot.md));
2. **可执行产物**: 把生成器源码打包 (分发到 npm 后由用户的 bun / node 直跑; node 不读 TS, 单文件打包是既有 CLI 包的成熟方案, 落地时沿用其构建与自证模式)。

构建自检 (构建即闸门): 模板资产完整性 (清单文件齐全) + 泛化零残留 (模板内不得再出现原项目名, 出现即构建失败, 见快照机制)。

## 交互

生成器是一个交互式 CLI: 无参数时挨个提问, 有旗标时零交互。变量表、旗标、生成流程 (自检前置于收尾) 与收尾动作 (git init / install) 的完整契约见[生成器契约](scaffold-contract.md)。

## 质量闭环

- **轻量级冒烟 (单测层)**: 生成产物结构断言 (文件齐全、变量零残留、档位裁剪正确);
- **重量级冒烟 (发布层)**: 先对生成器自身执行 `npm pack` 并在独立临时目录隔离装包 (`npm install --omit=dev`), 再通过装好的入口验证三场景: `standard` 默认档与 `full` 增强档跑通生成物依赖安装 + 完整 `bun run ci` (`full` 档另跑 `bun run fuzz:diff`) 全绿, `core+scope` 场景 (`--no-install`) 校验裁剪完整性与 `@scope/pkg` 派生。挂载点位于生成器包的 `prepublishOnly` (`verify:release` 之后, 见 `packages/create-clis/scripts/heavy-smoke.ts`): 发布出去的生成器版本均已自证「它生成的项目开箱全绿」;
- **第二实例验证 (一次性)**: 用生成器产出一个与 sweep 领域不同的**完整集合仓实例** (非玩具项目), 做端到端验证, 作为模板正确性的最强证据 (领域无关性检验)。

## 边界

生成器只管「从零生成」: 不提供已生成项目的升级 / 同步功能 (生成即脱离; 模板的演进不回流到既有项目)。

## 修订记录

| 日期       | 修订                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| 2026-09-30 | 初稿: 定位、命名与分发、双产物构建、质量闭环与边界                                            |
| 2026-11-22 | 校准 `heavy-smoke` 三场景验收口径: `standard` / `full` 隔离装包跑全链 CI, `core+scope` 验结构 |
