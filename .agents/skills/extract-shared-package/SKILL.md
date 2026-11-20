---
name: extract-shared-package
description: >-
  Autonomous iterative cross-package essence extraction loop for monorepos.
  Combines deterministic AST/lexical clone detection, capability clustering,
  cut-cost analysis, and Rust-transpilation readiness scoring with semantic
  essence abstraction to extract community-ready single-responsibility private
  libraries until convergence.
---

# 全自动跨包本质复用抽离闭环 (extract-shared-package)

本 Skill 采用「确定性全量工程分析 + 本质行为抽象归约 + 门禁全绿收敛循环」机制: 所有包发现、双包产品域去重、跨包函数结构克隆 (α-归一化 5-gram Shingles)、底层能力聚类、剥离切割代价与 Rust 可转写度评估均由确定性脚本 [extract-loop.ts](scripts/extract-loop.ts) 在亚秒级全量产出; 你只负责在实读相关最新源码后, 提取不沾原业务语境的单一本质模块, 按社区级标准建 `"private": true` 共享库并完成全部消费方重构, 过全仓门禁后再自动进入下一轮重扫, 直至收敛。

## 规范前置阅读 (按需加载)

- 「逐物具象 vs 行为本质」正反判据、四道闸门与 Rust 边界设计: [essence-rubric.md](references/essence-rubric.md)
- 在本仓落盘 `"private": true` 社区规格共享库的完整挂载清单: [package-scaffold.md](references/package-scaffold.md)

---

## 全自动连抽闭环工作流

严格按以下 6 步循环推进。每轮最多抽出 **1 个** 单一职能包; 只要任意一轮触发收敛条件或安全熔断, 立即停止循环并输出全仓模块图谱与豁免清单。

### 第 1 步: 确定性全量盘点 (`scan`)

每轮开始时 (含刚抽出一个新包之后), **必须**重新运行全量扫描脚本以纳入最新工作区状态:

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts scan
```

若要查看全部文件级切割代价与完整聚类, 读取脚本提示写入的 `~/tmp/extract-shared-package/last-scan.json`。重点检查输出 JSON 中的 4 个信号:

1. **`convergence.shouldStop`**: 若为 `true` (全仓已无活跃跨独立域候选簇, 或已达连续抽包安全上限 `maxRoundsAllowed = 5`), **立即终止循环**, 转至文末「收敛收尾汇报」。
2. **`graph.existingViolations`**: 若当前仓库本身已存在依赖方向/环违规, **禁止直接开始新一轮抽包**, 先汇报违规并止损。
3. **`topClusters` (已按优先级排序)**: 留意每个簇的 `distinctDomainCount` (独立产品域数, 已把同产品双包合并计算)、`sharedLayers`、`commonBuiltins`、`cutCost` 与 `rustReadinessScore`。
4. **`suppressedCount`**: 已被否决台账抑制且源码未变的候选已自动过滤, 避免重复评估死循环。

### 第 2 步: 实读源码与本质行为归约

从 `topClusters` 按优先级由高到低逐个审校 (每次只选定 **1 个**最值得抽离的簇, 不满足条件则登记否决并顺延至下一个):

1. **强制实读最新源码**: 使用 `read_file` 完整读取当前候选簇在各个消费包内的源文件及其直接内部引用 (`relativeImports`), 严禁仅靠扫描报告摘要猜测逻辑或依赖记忆。
2. **本质剥离三问** (细节见 [essence-rubric.md](references/essence-rubric.md)):
   - **去掉业务名词后它是什么?** 把 `sweep` / `node_modules` / `codd` / `mongodb` 等具象名词全部抽干, 描述这段代码在数据结构、操作系统原语或终端交互层面的本质行为。
   - **是否满足单一职能?** 必须能用一句话说清它解决的唯一问题, 禁止把两套正交能力塞进 `utils` / `common` / `helpers` / `shared` 垃圾桶包。
   - **是否值得作为一个社区级独立包存在?** 若剥离掉周边胶水后实质复用逻辑太薄 (例如仅仅几行简单封装)、或各处业务差异本质大于共性 (强行抽离会导致入参堆满分支开关), 则**不应为了拆而拆**, 执行 `reject` 记入台账:

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts reject --fingerprint "<cluster-fp>" --status rejected --reason "<不抽离的本质依据>"
```

3. **Rust 可转写友好设计**: 关注 `rustReadiness` 提示。若目标逻辑既含纯计算又混杂多层宿主 I/O (`fs` + `tty` + `process`), 在设计新包公共 API 时**必须分离「纯计算内核」与「可注入宿主边界 (adapter/streams/fs 接口)」**, 避免强类型动态陷阱 (`any` / 动态 `import` / 隐式全局态), 让该包不仅可直接给 TS 社区使用, 未来也能配合 [scripts/transcription/](../../../scripts/transcription/) 一对一确定性转写为 Rust crate。

### 第 3 步: 四道本质闸门预审 (`check-proposal`)

在动手建目录或改源码之前, 先把拟定的新包名、社区级英文/双语 `description`、全部独立消费包清单与公开导出符号交给确定性闸门预审:

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts check-proposal --name "@iyowei/<essence-name>" --description "<single-sentence community essence>" --consumers "<pkgA,pkgB>" --exports "<fn1,fn2>"
```

若命令非零退出, 根据报错修正抽象边界或放弃该候选并执行 `reject` 入账。预审通过后进入第 4 步。

### 第 4 步: 开启原子检查点与备份 (`begin-round`)

**严禁裸改现有文件**。先调用 `begin-round` 在 `~/tmp/extract-shared-package/` 创建本轮孤立快照 (默认自动备份根 `tsconfig.json`、模板清单与文档索引, 可通过 `--touch` 追加拟改写的消费方源文件):

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts begin-round --name "@iyowei/<essence-name>" --dir "packages/<essence-name>" --touch "<consumerFile1,consumerFile2>"
```

记下返回的 `roundId`。若后续编辑途中新增要修改的已有文件, 改前必须先补备份:

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts backup-file --round "<roundId>" --file "<relPath>"
```

### 第 5 步: 建包落地、重构消费方与门禁验证 (`verify-round`)

按照 [package-scaffold.md](references/package-scaffold.md) 完成新建包落盘与仓级联动:

1. 创建 `packages/<essence-name>/`:
   - `package.json`: 强制标 `"private": true` (暂不发布 npm)、`"type": "module"`、`"sideEffects": false`、完整 `exports` 与 `build` / `typecheck` / `test` 脚本;
   - `tsconfig.json` 与 `tsconfig.build.json`;
   - `scripts/build.ts` (参考 [cli-updater build.ts](../../../packages/cli-updater/scripts/build.ts), 确保输出干净的 `dist/index.js` + `dist/index.d.ts` 且相对导入后缀归一为 `.js`);
   - `src/index.ts` 与实现模块 (严禁残留任何原产品领域词; 遵守仓库 [.oxlintrc.json](../../../.oxlintrc.json) 与 [tsconfig.json](../../../tsconfig.json));
   - `src/*.test.ts`: 独立于任何原业务场景的纯正交单元测试 (使用抽象夹具, 覆盖边界条件与错误码);
   - `README.md`: 面向社区读者的纯净用法说明 (不含任何仓内相对逃逸链接, 不含原业务专有名词)。
2. 同步仓级挂载点:
   - 在根 [tsconfig.json](../../../tsconfig.json) `paths` 添加新包源路径映射;
   - 在 [template-manifest.ts](../../../packages/create-clis/scripts/template-manifest.ts) 将 `packages/<essence-name>/` 登记到 `exclude` (附带本质描述 note), 确保脚手架全仓覆盖体检通过;
   - 按 [package-classification.md](../../../docs/designs/package-classification.md) 在根中英文 README 及 [docs/README.md](../../../docs/README.md) 补齐一行登记。
3. 改写所有消费方包的 `package.json` 依赖与源码调用, 删除重复旧代码, 并执行 `bun fmt` 排版格式化。
4. 运行确定性轮次验证 (先后跑包级本质泄漏体检与仓库单一工程入口 `bun scripts/ci.ts --verify`):

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts verify-round --round "<roundId>" --dir "packages/<essence-name>"
```

### 第 6 步: 留退裁决与下一轮循环

- **若 `verify-round` 全绿通过**: 执行 `commit-round` 将本轮成果写入台账并递增已执行轮次, 随后**立即回到第 1 步重新运行 `scan`**, 基于包含新包在内的最新全部源码继续下一轮寻找!

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts commit-round --round "<roundId>" --fingerprint "<cluster-fp>" --name "@iyowei/<essence-name>" --reason "<一句话本质定位>"
```

- **若 `verify-round` 失败**: 只允许针对明确的构建/类型/格式/引用小报错尝试修复 1 次并重跑 `verify-round`; 若依然失败或出现架构性契约破坏, **禁止带病继续**, 立即调用 `rollback-round` 精确还原修改并清理新包目录 (绝不伤及用户原有未提交更改), 登记 `reject` 后顺延或停止循环:

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts rollback-round --round "<roundId>"
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts reject --fingerprint "<cluster-fp>" --status deferred --reason "<回滚原因>"
```

---

## 收敛收尾汇报

当 `convergence.shouldStop === true` 结束全自动连抽循环时, 向用户汇报三件事:

1. **已抽离并全绿落盘的新包清单**: 包名 (`"private": true`)、本质定位、复用的独立产品域及对应替除的旧重复模块;
2. **明确保留未拆的候选及依据**: 说明为何某些跨包相似代码因净值过低、领域耦合过深或复用域不足而被台账否决 (证明不是"为了拆而拆");
3. **社区发布与转写提示**: 列出已达到社区就绪状态、只需后续移除 `"private": true` 即可走发布流程的包, 以及需补齐测试/边界解耦才能更平滑转写为 Rust crate 的模块。
