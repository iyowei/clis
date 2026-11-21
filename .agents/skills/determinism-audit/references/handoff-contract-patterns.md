# 人机接口契约范式、多平台落盘规范与标杆对照

改造一个重度依赖 AI 扫描的 skill, 本质上是重划一条**「程序预处理 → 精简 JSON 信号 → AI 语义裁决 → 物理闸门收口」**的数据管道。

---

## 一、标准四段式闭环管道

```text
[用户任务]
   │
   ▼
1. 确定性采集与计算层 (scripts/<tool>.ts scan / prepare)
   │  • 1 秒全量遍历、AST/图计算、特征打分、历史台账过滤
   │  • 输出紧凑 JSON (全量落 ~/tmp/, stdout 只打高信噪比摘要)
   ▼
2. AI 语义裁决层 (SKILL.md 核心指令)
   │  • 按 JSON 坐标实读关键源码/文档 (不盲信摘要, 也不全仓瞎搜)
   │  • 只做命名抽象、方案取舍、语义相关性过滤与源码改写
   ▼
3. 确定性校验与留退层 (scripts/<tool>.ts evaluate / verify)
   │  • 编译 / Lint / 单测 / 统计显著性 / Schema 契约 / 死链闸门
   │  • 失败自动快照还原并锁定失败指纹, 通过才允许进入下一轮
   ▼
[收敛交付]
```

---

## 二、脚本与契约落盘规范 (分场景选型)

根据被审计 skill 的归属范围给出明确的脚本落盘与引用路径建议:

1. **仓内独立 Skill (`.agents/skills/<name>/`)**: 脚本、`.test.ts` 与 `.schema.json` 直接内聚在 `.agents/skills/<name>/scripts/` 下, `SKILL.md` 用相对路径调用。
2. **跨项目全局 / 多平台分发 Skill (`dotAI` 体系)**: 严禁把脚本只塞进单一平台产物目录 (如只放 `targets/codex/`), 也不应与无共享测试的全局 `scripts/` 混堆。脚本、配套测试与 Schema 契约应统一沉淀在单源 `src/resources/<skill>/` 下, 由转写链同步各平台, 并在提示词中通过 `${RESOURCES_ROOT}/<skill>/<tool>.ts` 跨端调用。

---

## 三、本仓现成标杆参照

在设计具体改造方案时, 可直接对照本仓两个高度确定性化的范例:

1. **图计算 + 本质裁决双层架构**: [extract-shared-package/SKILL.md](../../extract-shared-package/SKILL.md)
   - **程序包揽**: 包发现、跨包 AST/词法克隆聚类、传递可达域计算、剥离代价、Rust 可转写风险打标、历史否决台账与原子快照回滚, 全部收口在 [extract-loop.ts](../../extract-shared-package/scripts/extract-loop.ts)。
   - **AI 只干**: 按 `topClusters` 坐标实读源码, 用「逐物具象 vs 行为本质」判据提炼本质行为名称与接口设计, 再把提案交回 `check-proposal` 物理闸门过审。

2. **基准统计裁判 + 极限探索双层架构**: [perf-loop/SKILL.md](../../perf-loop/SKILL.md)
   - **程序包揽**: 基准基线冻结、CPU 热点剖析过滤噪音、Bun + Node A/B 交替采样、Mann-Whitney U 显著性校验、20 提案滑动窗口收敛核算与自动回退, 全部收口在 [loop.ts](../../perf-loop/scripts/loop.ts)。
   - **AI 只干**: 读取 `prepare` 给出的 `targetHotFunctions` 与 `reeligibleProposals`, 专注构思 `P0` / `P1` 级算法与内存架构优化并沉淀设计文档。

---

## 四、待审计 Skill 标准报告模板

向调用方交付审计结果时, 严格按以下三节骨架输出 (所有证据必须来自探针 JSON 与实读文件):

```markdown
## 1. 确定性工程体检总览

- **目标**: `<skillName>` (`<resolvedEntryPath>`)
- **拓扑与资产定性**: `<skillKind>` / `<architectureShape>` (是否转发薄壳 / 解包下游 agent、领域脚本数、基建脚本数、测试数与 Schema 数; 简述脚本虚实核验结论)
- **缺失坐标 / 证据缺口**: 无, 或逐条标 `[证据缺口]` 说明未解析路径

## 2. 改造提案清单 (按 P0 → P1 → P2 排序)

### [P0 | A 类或 B 类] <改造点标题> (`<file>:<lineStart>-<lineEnd>`)

- **当前失血点**: 目前如何让 AI 手工扫描/比对/计数, 导致什么漏检或高耗时风险
- **拟建程序职责**: 脚本落盘位置、输入参数、1 秒内完成的确定性计算逻辑
- **喂给 AI 的契约 (Output JSON)**: 列出核心摘要字段与档案隔离方式 (说明如何防撑爆上下文)
- **AI 接管后的窄职责 + 收尾闸门**: AI 只看摘要后做什么语义判断, 用什么 Schema 或物理门禁收口

## 3. 主动克制清单 (C 类纯语义与 SKIP 项)

- `<步骤或文件位置>`: 维持由 AI 处理 (说明为何不脚本化, 如依赖深层语义、静态知识库或低频高脆性)
```
