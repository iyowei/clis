# 生成器包 (Scaffold Package)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md); 模板来源见[模板快照机制](scaffold-template-snapshot.md)

## 定位

生成器是集合的一个成员包, 类属为 CLI 工具 (有 `bin`)。它把[模板快照](scaffold-template-snapshot.md)实例化为一个**独立的新集合仓** (不是往本仓加包)。

## 命名与分发

- 包名: `create-clis` (unscoped, 见[技术债登记](tech-debt.md));
- 分发渠道: 复用生态的 create 约定 (已核实各官方文档): `npm create clis`→`npm exec create-clis`; `pnpm create clis`; `bun create clis`≡`bunx create-clis`; 直接 `bunx create-clis` 亦可;
- 生成物是独立目录 (可 `git init` 为独立仓库), 与本仓无持续关系 (生成即脱离)。

## 构建

生成器包有两个构建产物, 在同一条 build 链上:

1. **模板资产**: `scripts/build-template.ts` 按快照机制产出的 `assets/template/` (见[模板快照机制](scaffold-template-snapshot.md));
2. **可执行产物**: 对生成器源码做 bundle (分发到 npm 后由用户的 bun / node 直跑; node 不读 TS, 单文件 bundle 是既有 CLI 包的成熟方案, 落地时对齐其构建与自证模式)。

构建自检 (构建即闸门): 模板资产完整性 (清单文件齐) + 泛化零残留 (模板内不得再出现原项目名, 出现即构建失败, 见快照机制)。

## 交互

生成器是一个会话式 CLI: 无参数时交互问答, 有旗标时零交互。变量表、旗标、生成后收尾 (git init / install / 自检) 的完整契约见[生成器契约](scaffold-contract.md)。

## 质量闭环

- **轻量冒烟 (单测层)**: 生成产物结构断言 (文件集齐、变量零残留、档位裁剪正确);
- **重量冒烟 (发布层)**: 生成一个完整项目 → 跑其完整闸门链 (install + ci) → 全绿才放行发布。挂点提议为生成器包的 `prepublishOnly` (与既有发布自证同层): 发布出去的生成器版本, 必须自证「它生成的项目是绿的」;
- **第二实例验证 (一次性)**: 用生成器产出一个与 sweep 领域不同的真实小项目做端到端验证, 作为模板正确性的最强证据 (领域无关性检验)。

## 边界

生成器只管「从零生成」: 不提供已生成项目的升级 / 同步功能 (生成即脱离; 模板的演进不回流到既有项目)。

## 修订记录

| 日期       | 修订                                               |
| ---------- | -------------------------------------------------- |
| 2026-09-30 | 初稿: 定位、命名与分发、双产物构建、质量闭环与边界 |
