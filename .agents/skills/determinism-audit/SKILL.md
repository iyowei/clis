---
name: determinism-audit
description: >-
  Audit whether a target skill or agent workflow maximizes deterministic
  engineering. Separates actions that deterministic scripts can complete in one
  second with zero omissions from semantic tasks that belong to AI, and designs
  structured script-to-AI handoff contracts. Use when reviewing or refactoring
  a skill that asks AI to scan files, grep references, compare schemas, check
  dead links, maintain state ledgers, or verify metrics manually.
---

# Skill 确定性工程审计器 (determinism-audit)

本 Skill 专注解决一个工程核心问题: **能由确定性程序 1 秒做完且零遗漏的事, 不交给 AI 肉眼扫描; 程序吐出高信噪比结构化事实, 辅助 AI 专注语义理解与架构裁决**。

本 Skill 自身严格执行「先脚本拍片采样, 再由 AI 语义看诊」双层架构: 全拓扑解包 (含软链与转发薄壳关联的底层 agent、`resources/`、同目录测试与规则文档)、基础设施盘点与指令热区切片, 均由确定性探针 [probe.ts](scripts/probe.ts) 在 1 秒内完成 (输出结构约束见 [probe_report.schema.json](scripts/probe_report.schema.json))。

## 范围与职责边界

- **只审人机算力分工**: 专注判断「哪些动作该下沉为确定性脚本、脚本该吐什么 JSON 给 AI、末尾配什么物理闸门」, 不评价文案润色、提示词风格或触发描述长度。
- **只出审计结论与改造蓝图**: 除非调用方显式要求同时落盘重构, 默认不修改目标 skill、agent 或脚本源码。

## 前置参考 (按需加载)

- A / B / C 三分法、9 大必下沉模式、ROI 分级 (`P0` / `P1` / `P2` / `SKIP`) 与防过度工程红线: [rubric-and-taxonomy.md](references/rubric-and-taxonomy.md)
- 「程序喂骨架 + AI 裁决 + 物理闸门」人机接口契约范式、多平台全局 skill 落盘规范与标准报告模板: [handoff-contract-patterns.md](references/handoff-contract-patterns.md)

---

## 执行工作流 (4 步收敛)

### 第 1 步: 确定性全拓扑探测 (`probe` / `list`)

严禁自己靠目录列举或肉眼猜目标 skill 的文件组成, 必须先跑探针脚本:

- **已指定目标 skill 名称、目录 (含软链) 或 `.md` 路径**:

```shell
bun .agents/skills/determinism-audit/scripts/probe.ts probe <target>
```

- **未指定目标 (需要普查现有技能库找高收益靶子)**:

```shell
bun .agents/skills/determinism-audit/scripts/probe.ts list
```

收到 JSON 体检单后, 立即核对 5 个结构化信号 (完整档案亦同步落盘于 `archivePath`):

1. **`unresolvedTargets`**: 若存在未解析的转发 agent、资源目录或外部文件, 在最终报告中**必须标为 `[证据缺口]`** 并列出未找到路径, 严禁脑补其内部规则。
2. **`skillKind` 与 `architectureShape`**: 核对 `skillKind` (`workflow` / `dispatcher` / `reference-kb`) 与五态架构形态 (`script-backed-loop` / `hybrid-assisted` / `pure-prompt-skill` / `thin-dispatcher` / `unresolved-dispatcher`)。若为 `reference-kb`, 重点识别纯参考手册边界。
3. **`isThinDispatcher`、`documents` 与 `disallowedTools`**: 确认是否已顺着转发薄壳解包出 `forwarded-agent`、`linkedRules` 与 `resource-doc`; 同步比对上下游指令是否与 `disallowedTools` 存在读写契约冲突。
4. **`engineeringFootprint` 与 `inventory`**: 核对 `implScripts`、`sharedInfraScripts` (仓级构建/排版基建)、`testFiles` 与 `schemaFiles`, 警惕「只配通用基建脚本或仅末步校验、主体扫描仍由 AI 手干」的伪覆盖。
5. **`summaryForJudge.topUnbackedHotspots`**: 按精简坐标 (`location`) 与 `totalRawHotspotCount` 定位优先待审热区。

### 第 2 步: 实读热区与现有脚本核验 (严禁只看摘要盲审)

根据探针返回的 `documents`、`linkedRules` 与 `candidateHotspots` 坐标, 使用读文件工具实读:

1. **实读入口与核心执行正文**: 完整阅读 `skill-entry`、解包出的 `forwarded-agent`、必要时的 `linkedRules` 与热区命中行的上下文。
2. **核验现有脚本虚实**: 若目标已有 `inventory.implScripts`, 抽读其关键入口脚本与测试, 确认它到底包揽了多少实质采集/计算/门禁, 同时排查脚本自身是否遗漏了输入契约守卫或输出 Schema 校验。
3. **剔除探针静态误报**: 对探针中标记 `delegatedOrNegated: true` 或仅属示例/背景定位的条目做快速实读核销, 并补充探针未命中的隐性手工步骤。

### 第 3 步: 三分法归类与 ROI 过滤

依 [rubric-and-taxonomy.md](references/rubric-and-taxonomy.md) 对目标 skill 的每个实质步骤拆解贴签:

1. **贴三类归属标签**:
   - **A 类 · 纯确定性 (必须下沉程序)**: 全仓遍历、AST/依赖图采集、精确比对、死链与重号检测、Schema 校验、状态机账本与回滚、统计显著性计算。
   - **B 类 · 人机接力 (程序搭骨架 + AI 做语义填空)**: 程序 1 秒钟做 100% 召回和量化过滤, 吐出精简候选 JSON; AI 只看浓缩信号做语义筛选或本质取舍。
   - **C 类 · 纯语义型 (留给 AI)**: 本质抽象命名、架构选型、复杂因果推理、自然语言融合撰写。
2. **ROI 止损过滤 (`P0` / `P1` / `P2` / `SKIP`)**:
   对每个 A / B 类改造点评估「触发频次 × AI 漏检/幻觉后果 vs 脚本编写与维护脆性」。一次性低频动作、静态知识库或必须靠复杂语义判定的步骤标为 `SKIP`, 明确写明为何不该写脚本。

### 第 4 步: 交付审计报告与人机接口契约

严格按 [handoff-contract-patterns.md](references/handoff-contract-patterns.md) 提供的三节模板交付审计报告, 所有引用必须绑定探针核实或实读确认的 `file:line`:

1. **`1. 确定性工程体检总览`**: 拓扑形态、资产实读定性与缺失坐标 / `[证据缺口]`;
2. **`2. 改造提案清单 (按 P0 → P1 → P2 排序)`**: 每条必须显式标明 `[P0/P1/P2 | A/B 类]` 与 `file:line`, 含 `当前失血点`、`拟建程序职责`、`喂给 AI 的契约 (Output JSON)` 与 `AI 接管后的窄职责 + 收尾闸门`;
3. **`3. 主动克制清单 (C 类纯语义与 SKIP 项)`**: 列出维持由 AI 处理的步骤与依据。
