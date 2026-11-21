---
name: extract-shared-package
description: >-
  Autonomous iterative cross-package essence extraction and degeneration
  re-absorption loop for monorepos. Combines deterministic AST/lexical clone
  detection, transitive domain reachability, cut-cost analysis, and
  Rust-transpilation readiness scoring with semantic essence abstraction to
  extract or retire single-responsibility private libraries until convergence.
---

# 跨包本质抽离与退化回收闭环 (`extract-shared-package`)

本 Skill 由 [extract-loop.ts](scripts/extract-loop.ts) 承担全部确定性扫描、拓扑校验、台账事务锁定与包规范体检 (输出结构定义见 [output-contract.schema.json](schemas/output-contract.schema.json)); AI 专注实读源码执行「本质行为抽象」与边界重构。

## 按需加载参考

- C 类语义裁决与 Rust 纯核拆解规范: [essence-rubric.md](references/essence-rubric.md)
- 新建包规格、迁移残余清理与 `reabsorb` 全参数手册: [lifecycle-and-scaffold.md](references/lifecycle-and-scaffold.md)

## 执行铁律

1. **单轮单动作**: 每轮只处置 1 项动作 (到期回收、残余清理或新建 1 个 `"private": true` 社区规格库); 事务检查点会锁定同一时刻仅 1 个活跃轮次, 动工先传完整 `--touch` (含待改消费包 `package.json` 与源码), 中途新增改动调 `backup-file`。
2. **禁止脑补源码与忽略启动器**: 任何裁决前必先实读完整源码; 刻意保持零依赖的入口启动器 (`bin/*.mjs`) 与纯脚手架不抽进共享运行时包, 直接 `reject`。
3. **遵循 `nextAction` 优先路由**: 减法回收与残余清理优先于加法新建。

## 闭环调度 (按 `scan` 路由推进)

每轮从确定性全量扫仓开始 (状态/快照按仓隔离于 `~/tmp/extract-shared-package/<repo-hash>/`):

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts scan
```

按返回的 `nextAction.kind` 路由推进 (全命令与必填参数见 [lifecycle-and-scaffold.md](references/lifecycle-and-scaffold.md)):

- **`fix-graph-violations`**: 工作区存在依赖方向/环违规, 停止自动操作并向用户报告违规链路。
- **`reabsorb` / `cleanup-unused`**: 有私库连续冷却满期且无新产品接回 (`cooling-down` 中的库暂不处理)。走 `begin-round --mode reabsorb` → 整块迁为消费包内**独立子模块** (含门面、单测、禁反向引用; 零消费者跳过迁入传 `--unused`) → `verify-reabsorb` → `commit-round --mode reabsorb` (失败 `rollback-round` 自动清理半成品并恢复旧库), 回到 `scan`。
- **`cleanup-residue`**: 有新共享库已建立但业务源码仍留有同构旧代码。走 `begin-round --mode residue` (仅备份消费包文件) → 删残余并切换导入 → `verify-round --mode residue` → `commit-round --mode residue` (误报则 `reject --status rejected`), 回到 `scan`。
- **`extract-or-triage`**: 对高优 `topClusters` 按序实读源码, 依 [essence-rubric.md](references/essence-rubric.md) 评估:
  - 不值得或属故意隔离 (如无依赖 `bin/*.mjs` 启动器): `reject --fingerprint "<fp>" --status rejected --reason "<依据>"`, 换下一簇;
  - 值得抽离: 提炼单一社区命题与纯核/宿主 I/O 边界 → `check-proposal` → `begin-round --mode extract` → 落盘并执行 `bun install && bun fmt` → `verify-round` → `commit-round` (失败修一次仍挂则 `rollback-round` + `reject --status deferred`), 回到 `scan`。
- **`stop`**: 运行汇总脚本直接生成收尾汇报素材:

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts summary
```

依 `summary` 输出向用户汇总: 本轮抽离的新库 (`extractedPackages`)、已完成回收的退化私库 (`reabsorbedPackages`)、观察中未到期私库 (`coolingDownLibs`)、公开孤立库警示 (`orphanedPublicLibs`)、合理否决记录 (`rejectedOrDeferred`) 与低 Rust 就绪度重构备忘 (`rustReadinessAlerts`)。
