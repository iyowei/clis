---
name: perf-loop
description: >-
  Autonomous multi-dimension performance optimization loop for monorepo packages.
  Use when the user asks to optimize package performance iteratively across
  architecture, implementation, GC, and interpreter dimensions with deterministic
  benchmark gating, dual-queue tracking, P0/P1/P2 prioritization, and live docs
  distillation.
---

# 确定性性能闭环调优 (perf-loop)

本 Skill 将性能优化拆为「确定性脚本裁判 + 认知探索调优」两层: 所有基准对比、统计显著性校验、双运行时保护、历史失败指纹解封、20 提案滑动窗口收敛核算与工作区快照回退, 均由 [loop.ts](scripts/loop.ts) 在百毫秒内完成 (输出结构定义见 [output-contract.schema.json](schemas/output-contract.schema.json)); 你只负责以高野心挖掘系统极限、读最新源码与剖析摘要、写合规代码以及当场提炼 `P0`/`P1` 文档。

## 规范前置阅读 (按需加载)

- 极限压榨与辩证平衡检查表、`P0`/`P1`/`P2` 标定: [dimensions-and-rubric.md](references/dimensions-and-rubric.md)
- 无 `bench` 包的基准建设与隔离规范: [bench-harness-spec.md](references/bench-harness-spec.md)
- 保留优化后当场融合沉淀 `docs/` 的体裁与层级判据: [docs-distillation-guide.md](references/docs-distillation-guide.md)

## 执行工作流

### 第 0 步: 全景探测与自动排期 (`status` / `next`)

未指定 package 时, 由脚本自动推荐下一跳 (优先核心主包, 薄壳 CLI 排后):

```shell
bun .agents/skills/perf-loop/scripts/loop.ts status
bun .agents/skills/perf-loop/scripts/loop.ts next
```

按脚本返回的 `next.action` 处理:

1. **`INIT_BENCH`**: 目标包尚无 `bench/run.ts`, 禁止空转, 立即运行 `init-bench --pkg <pkg>` 建立骨架;
2. **`COMPLETE_BENCH_STUB`**: `bench/run.ts` 已存在但仍含 `@perf-loop:stub` 标记或缺少 `--json` 协议输出 (或 `package.json` 缺 `scripts.bench`), 切勿运行 `init-bench`, 须先依 [bench-harness-spec.md](references/bench-harness-spec.md) 补齐真实业务热点负载与 `--json` 协议输出、标定 `role` (`primary` / `reference`)、删掉 `@perf-loop:stub` 并双端实测通过后才可进优化循环;
3. **`OPTIMIZE`**: 进入第 1 步;
4. **`ALL_CONVERGED`**: 全部目标包已达收敛判据, 直接进入第 5 步终局收口。

### 第 1 步: 冻结基线与采集现场 (`prepare`)

每次构思优化点前**必须**跑一次 `prepare`, 拿最新基准、源码结构地图、已剥离 setup 噪音的真实业务热点及历史队列重评状态:

```shell
bun .agents/skills/perf-loop/scripts/loop.ts prepare --pkg <pkg> --suite quick
```

认真检查返回 JSON 中的 4 个信号:

1. **`stopping.decision`**: 为 `STOP_DIMINISHING_RETURNS` 或 `STOP_STREAK_EXHAUSTED` 时停止当前包并运行 `next` 切下一包; 为 `PIVOT_REQUIRED` 时本轮**严禁**微调代码或 GC 细节, 必须做架构/数据流/算法级跃迁 (`P0`)。
2. **`profile.ioDominatedHint` 与 `targetHotFunctions`**: `targetHotFunctions` 已过滤 `bench/` 与 `fixtures` 搭建噪音; `ioDominatedHint: true` 说明瓶颈在系统调用 (`readdir`/`lstat`/子进程等待), 优先改 `arch` 与 `io` 批处理/并发水位。
3. **`reeligibleProposals` vs `lockedProposals`**: 仅当直接关联文件改动、`bench/` 变更、运行时升级、上次因噪声未定论, 或期间落地了 `P0`/`P1` 优化时, 历史失败才解封为 `reeligible`; 仍处 `locked` 的条目**禁止原样重提**。
4. **`sourceMap` 与最新源码**: 结合 `sourceMap` 和热点函数, 使用 `read_file` 重新实读最新源码与上游调用链 (`PIVOT_REQUIRED` 时通读全包边界), 禁止凭上轮记忆盲改。

### 第 2 步: 压榨极限的单一精准变更

按 [dimensions-and-rubric.md](references/dimensions-and-rubric.md) **优先攻击 `P0` / `P1` 级高野心方案**, 同时保持辩证适度:

1. **入口严防死守, 内核极致裸奔**: 参数校验与边界防护收拢在公开 API 入口一次做完; 热路径内部信任已建立的不变量, 砍掉重复的 `existsSync`/`typeof`/防御性拷贝与小对象分配;
2. 单次只验证一个正交假设; 严禁改动 `bench/`; 如架构级重构确须双包协同 (例如 API 主包与 CLI 薄壳联动), 评估时须显式传 `--allow-cross-pkg`;
3. 严守仓内静态与运行时契约: [.oxlintrc.json](../../../.oxlintrc.json) (`no-bitwise`, `no-plusplus`, `max-depth <= 4`, `max-lines <= 450`), `tsconfig.json` (`erasableSyntaxOnly`, `strict`) 与目标包零依赖约束 (如 [0003-zero-runtime-deps.md](../../../packages/sweep/docs/adrs/0003-zero-runtime-deps.md))。

### 第 3 步: 确定性裁定与自动留退 (`evaluate`)

```shell
bun .agents/skills/perf-loop/scripts/loop.ts evaluate --pkg <pkg> --run <runId> --proposal "<一句话提案>" --dimension <arch|impl|gc|interp|io> --expected-tier <P0|P1|P2> --rationale "<机制依据>"
```

脚本自动执行: 策略越界校验 -> `bun check` + `oxlint` + 隔离 `HOME` 下的 `bun test` -> Bun + Node **A/B 交替原位采样** -> 围绕 `primary` 主路径用例算加权降幅与显著性 (`reference` 仅作对照与一致性校验) -> 仅在触发 `CROSS_RUNTIME_REGRESSION` 时按需采一次 Node V8 CPU Top-8 热点 (`nodeProfileHints`) 供下次修正 -> 留存或精确快照回退 -> 更新双队列并复算收敛状态。

若执行中断留下脏状态, 执行:

```shell
bun .agents/skills/perf-loop/scripts/loop.ts recover --run <runId>
```

### 第 4 步: 留存后当场融合沉淀文档

若 `evaluate` 返回 `record.verdict: "KEEP"` 且 `record.docActionRequired: true` (`P0` / `P1`):

- 直接读取结果中随附的 `docHints` (`nextGlobalAdrNumber`、`existingDesigns`、`pkgDesignsDir`), 依 [docs-distillation-guide.md](references/docs-distillation-guide.md) **当场融合更新**对应 `docs/` 后跑通文档门禁再继续下一轮:

```shell
bun scripts/lint-doc-references.ts && bun scripts/lint-doc-examples.ts
```

- 实测 `P2` 只记入账本和源码行内注释, 不污染 `docs/`。

### 第 5 步: 收口与终局预演

全部目标包触发停止条件 (`STOP_DIMINISHING_RETURNS` 或 `STOP_STREAK_EXHAUSTED`) 后, 跑一次全仓工程验证与双端验收确认没有遗漏任何契约回归:

```shell
bun run ci
```
