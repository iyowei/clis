# ADR 0006: 双运行时支持与 Bun 优先的 API 策略

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

工具是我自己在几台机器上用的: 有的机器只有 Node, 有的机器只有 Bun, 所以要能做到「装任一运行时即可使用」(适用范围: 业务逻辑与从源码使用的入口; npm 分发通道的入口由 node 启动, 需要有 node, 见 [ADR 0009](0009-npm-distribution-form.md)「适用边界」)。另外定下两条硬要求: 不考虑旧版本兼容 (直接用各运行时最新一代的 API); 性能不能差。API 上优先用 Bun 的 (文件操作这类性能更强), 但不能为此牺牲 Node 上的可用性。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[只支持 Bun]**

放弃理由: 只装 Node 的机器直接不可用, 和「装任一运行时即可使用」冲突。

**[只支持 Node]**

放弃理由: 会丢掉主力运行时的启动性能和原生文件 API; 本机日常跑的是 Bun, 主路径应该是快的那条。

**[双实现分叉 (Bun 版 / Node 版各写一份)]**

放弃理由: 同一份逻辑要维护两份实现, 时间一长两边走样的风险会越积越大, 和「单一事实来源」相悖。

**[构建产物分发 (`bun build --compile` 或转译 JS)]**

放弃理由: 等于引入构建步骤和产物管理, 和 [ADR 0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md)「零构建、源码直跑、改完即生效」相悖。

(这条弃用判断后来被 [ADR 0009](0009-npm-distribution-form.md) 局部取代: 当时说的「构建」是为运行而构建, 现在只有 npm 分发态才为分发而构建, 开发运行路径没变。)

## 决策与理由 (Decision & Why)

1. **单源码双运行时**: 同一份 TypeScript 源码在 Bun 和 Node 上都直接跑 (两边都原生支持 TS 类型剥离, 已实测)。
2. **Bun 优先的薄适配层**: 有实质差异的能力只有两处, 子进程 spawn (`Bun.spawn` / `node:child_process`) 与文件读写 (`Bun.file` / `Bun.write` / `node:fs/promises`), 都由 `src/runtime.ts` 集中封装; 判断方式是功能检测 `typeof Bun !== 'undefined'`: 有 Bun 能力就先走 Bun 实现, 没有就回退 Node 实现 (分支都收在适配层内部, 调用方感觉不到)。其余一律走 `node:` 兼容 API, 不搞「为 Bun 而 Bun」的双份代码 (Bun 对 `node:fs` 的实现本身就是原生加速, 不用另写分支)。
3. **语法约束 (为 Node 的类型剥离而设)**: 只用可擦除的 TS 语法 (不能用 `enum` / `namespace` / 参数属性这类需要真正产出代码的特性); tsconfig 打开 `erasableSyntaxOnly`, 让类型检查把这个约束钉死。
4. **入口形态**: `src/cli.ts` 不再自带 shebang, 也不再被直接软链; 新增 `bin/sweep-nm` 启动器 (用 sh 写的), 先按「Bun 优先, Node 回退」挑好运行时, 再 `exec` 真实入口; `~/.local/bin/sweep-nm` 软链指向启动器 (这一步修订了 [ADR 0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md) 的安装形态与运行时要求; 其零依赖与零构建策略不变, 只是「零构建」的适用范围后来被 [ADR 0009](0009-npm-distribution-form.md) 收窄为开发运行路径)。
5. **版本要求**: 两侧都要「最新一代」: Bun 用任意近期版本; Node 要用原生支持直接跑 TypeScript 的版本, 下限为 `>= 22.18.0` (从这一版起类型剥离默认启用, 见 nodejs.org/api/typescript.html 的 History 表: v23.6.0 / v22.18.0「Type stripping is enabled by default」), 已经落到 package.json 的 `engines.node`。这个下限对两条获取方式一视同仁: 从源码运行需要直接跑 TS 的能力, npm 装到的是编译产物 JS, 跑 JS 本身不需要这个能力, 但两种获取方式取同一个数值下限, 不因为是哪种方式而放宽 (分发形态见 [ADR 0009](0009-npm-distribution-form.md))。本机实测: bun 1.4.2 和 node 26.7.0 跑同一个入口都通过。
6. **性能取向**: 热路径 (目录遍历) 按 [扫描与体积](../sweep/designs/scan-and-size.md) 的「性能要点」执行 (withFileTypes 省掉逐个 lstat、命中就剪枝、跳过 `.git`、不跟进符号链接; 体积统计的候选与裁定见该分册)。

理由: 装哪个运行时都能用; Bun 主路径能拿到启动和 spawn 的性能; 只有一份源码, 没有分叉; 约束落在能自动校验的闸门 (tsconfig 选项) 上。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 装 Bun 或装 Node 都能用; 主力机器走 Bun 快路径 (npm 安装的路径也一样, 见 [ADR 0009](0009-npm-distribution-form.md))。
- 实现没有分叉, 开发运行路径没有构建步骤。

**代价**

- 回归要在两种运行时下各跑一遍 (测试命令双跑; 修订 (2026-09-23): 单测侧后来做了参数化, e2e 按两个载体各注册一遍, 跑一次 `bun test` 就覆盖两侧 (前提是机器上两个运行时都装了, 缺哪一侧, 那一侧的用例就静默 skip, 整体仍然全绿), 所以「双跑」现在只对**转写验收**通道成立, 它的 `--target` 是单值, 也不在任何闸门内);
- TS 语法受可擦除约束 (对本项目要用的特性没有损失);
- 入口多了一层 sh 启动器的跳转 (开销可以忽略)。

## 验证方式与关联引用 (Validation & References)

**验证口径 (本次落地核验)**

1. `bun src/cli.ts` 与 `node src/cli.ts` 各跑一遍, 输出和退出码一致;
2. 通过软链实跑启动器, 运行时挑选正确; PATH 里没有 bun 时回退到 Node;
3. `bunx tsc --noEmit` (带 `erasableSyntaxOnly`) 通过。

> **修订指引 (2026-09-30)**: 本文的路径是单包时代的坐标 (现在落 `packages/sweep-node-modules{,-cli}`); 决策 2 里那个适配层已经没有生产使用方了 (实测 Bun 和 Node 在 `node:` 兼容 API 上行为已经一致), `runtime.ts` 现在只剩自测在用它; 「转写验收须手动双跑」这条权衡也不再成立 (conformance 的双 target 已经进了 CI 与 pre-push)。见 [ADR 0010](0010-dual-package-monorepo.md)。

**关联引用**

- 安装形态与运行时要求被本文修订的地方见 [ADR 0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md); npm 分发形态 (编译产物与入口) 见 [ADR 0009](0009-npm-distribution-form.md)。
- 性能手册见 [扫描与体积](../sweep/designs/scan-and-size.md); 代码结构与运行时基座见 [设计总纲](../sweep/designs/sweep-node-modules-design.md)。
