# 转写双面覆盖: 套件归位仓库根, 补齐 API 面黑盒验收

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-30
> **决策者**: 沈委
> **父文档**: [设计总纲](sweep-node-modules-design.md)
>
> 用途: 讲清两件事: 转写契约套件的归位 (从 CLI 包迁回仓库根 `scripts/transcription/`, 恢复 [ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 的原始套件结构; [ADR 0010](../adrs/0010-dual-package-monorepo.md) 的「随能力进 API 包」表述经补记重新裁定), 以及 API 面黑盒验收机制的落地设计 (会话式 harness 协议、语料 schema 扩展、契约与覆盖体系升级), 由此与 CLI 面构成双面覆盖。
> 范围: 本文只管「套件归位、API 面验收机制与双面覆盖落地」; 行为语义的权威在 [行为契约](../protocol/behavior-contract.md), API 面形状见 [可编程 API 面](../../packages/sweep-node-modules/docs/designs/api-surface.md); 其 §3.4 的 3 条「新增条款 (待登记)」的登记义务由本设计承接。

## 修订记录

| 日期       | 修订                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | 初稿: 套件归位 API 包、API 面验收机制 (会话式 harness 协议)、契约三档口径、四波执行                           |
| 2026-09-30 | 套件归位位置经复审修订: 由 API 包改为仓库根 (归属判据改「随服务对象」; ADR 0010 表述转补记处置), 其余设计不变 |

---

## 1. 动机: 归属岔口、单面覆盖与悬空的待登记条款

仓库为双包 monorepo: `packages/sweep-node-modules` = 可编程 API 包, `packages/sweep-node-modules-cli` = CLI 包。本设计的由来如下 (事实已核对):

### 1.1 归属岔口: ADR 0010 明说进 API 包, 迁移提交落在了 CLI 包

[ADR 0010](../adrs/0010-dual-package-monorepo.md) (09-29 10:24 落盘) 明文写「既有成果随能力进 API 包: 九轮安全审计收敛与转写契约套件的归属随包边界明确」与「转写契约套件随能力进 API 包」; 但约 33 分钟后的迁移提交 4fec13f (10:57) 把套件落在了 `packages/sweep-node-modules-cli/scripts/transcription/`, 执行与决策不符且此后无人察觉。2026-09-30 复审时该岔口重新裁定: 归属随「服务对象」而非「被验能力的位置」, 套件归位仓库根 (见 §2 拍板第 1 条)。

### 1.2 覆盖缺口: 57 条语料只验收 CLI 黑盒面

[转写契约套件](../protocol/README.md) ([ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 定义, 为未来多语言重写保行为等价的设施) 目前只验收 CLI 黑盒面 (57 条语料, argv/env → stdout/stderr/退出码/文件系统终态); API 包作为可编程库的对外面 (函数调用 → 返回值/错误码) 无任何语言中立验收 (**设计时点陈述**; 该缺口已由本设计落地, 见 §4 与覆盖表的 API 面登记)。

### 1.3 待登记悬空: 3 条「新增条款 (待登记)」未进契约

[可编程 API 面](../../packages/sweep-node-modules/docs/designs/api-surface.md) §3.4 已做「平移为 API 契约底稿」的逐条映射表 (27 个条款编号 → API 表达), 并留有 3 条标注为「新增条款 (待登记)」的条款 (A: stale 窄例外 / B: SizeResult 三桶完备性恒等式 / C: 进度事件终结契约), 但 [行为契约](../protocol/behavior-contract.md) 里一条都没有 (**已由本设计落地**: 登记为 BC-42 / BC-43 / BC-44)。

## 2. 已拍板决策 (2026-09-30)

决策者 2026-09-30 拍板:

1. 套件归位仓库根 `scripts/transcription/`: 归属判据是「服务对象」(套件服务两包与未来多语言重写, 属仓库级设施) 而非「被验能力的位置」(双面验收横跨两包职责, 该判据无解);
2. 补 API 面验收 (机制与冻结面语料一次到位; 「冻结面」对应 [可编程 API 面](../../packages/sweep-node-modules/docs/designs/api-surface.md) §2.8 稳定性分级中「冻结」与「冻结但允许新增可选字段」两档的定位, 与「允许演化」面 (中文措辞类, 不铺语料) 相对);
3. 双面覆盖 (套件一份、机制单源, CLI 面 57 条语料照跑不缩水, API 面新增);
4. 全项目文档漂移修复并入执行波次。

## 3. 套件归位: 整体 `git mv` 回仓库根

### 3.1 搬迁动作: 整体迁移 (逻辑零改动, 单处路径常量收窄)

- 套件整体 `git mv` 从 `packages/sweep-node-modules-cli/scripts/transcription/` 迁回仓库根 `scripts/transcription/` (保 git 历史), 与 `docs/protocol/` 重新对齐为 [ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 的原始套件结构 (两部分同在仓库根);
- 脚本内部路径计算: 回根后上溯仓库根的级数由 4 级收为 2 级 (单处常量改动), 其余零逻辑改动;
- mutant 生成器照旧复制两包源码 (仅 REPO_ROOT 上溯级数随归位收窄)。

### 3.2 连带点: 四处引用与文档注释

- 根 `package.json` 的 conformance 脚本;
- `scripts/ci.ts` 的 `conformance()`;
- CLI 包 `tsconfig.json` 的 exclude 条目 (改挂仓库根 tsconfig);
- `.gitignore` 的 mutants 忽略路径;
- 另加搬迁期间被改成包路径的少数文档与注释引用 (`docs/protocol/` 等处大量「指向根」的引用随归位自愈)。

## 4. API 面验收机制: 会话式 harness 协议

### 4.1 协议形状: `steps` 输入与 `ok` / `value` / `error` 输出

协议为会话式 (核心点): API 有「创建对象 → 调方法」的流式用法, 单发调用不够。

- 输入 (stdin JSON): `{ "steps": [ ... ] }`, 每步二选一:
  - 创建步: `{ "as": "<句柄名>", "call": { "export": "<包顶层导出名>", "args": [ ... ] } }`, 返回值存为句柄;
  - 方法步: `{ "call": { "on": "<句柄名>", "method": "<方法名>", "args": [ ... ] }, "collectEvents": true }` (collectEvents 时收集进度回调为事件数组);
- args 值: JSON 值; 字符串内 `$FIXTURE` 变量替换 (与 CLI case 同款契约); 注入式参数以 `{ "$probe": "<探针名>" }` 标记;
- 输出 (stdout JSON): `{ "ok": true, "value": <JSON> }` 或 `{ "ok": false, "error": { "name", "code", "message", "details"? } }`, collectEvents 时附 `"events": [...]`;
- 会话内崩溃: harness 非零退出 + stderr 诊断, 验收器按环境错误处置 (与 CLI 面退出码 2 同款分流)。

### 4.2 具名探针目录: 能模拟的走探针, 模拟不了的登记豁免

- 套件规范一组确定性探针 (如 pathops.posix / pathops.win32 模拟 / deviceProbe stub 等), 参考 harness 内置实现, 语料按名引用;
- 探针表达不了的复杂面 (真实跨设备挂载 / 竞态时序缝) 沿用既有豁免机制登记到覆盖表, 不硬造。

### 4.3 事件断言: 集合成员、存在性与末事件

[可编程 API 面](../../packages/sweep-node-modules/docs/designs/api-surface.md) §2.8 定性「事件序不承诺」, 故断言形态为集合成员 / 关键事件存在性 / 末事件 (恰好对应条款 C 的终结契约)。

### 4.4 参考 harness: 与「被测命令是参数」同构

- 参考 harness (TS) 随套件提供 (`api-harness.ts` 形态), 开发态 import API 包 src, mutant 场景 import 副本 src;
- 未来 Rust 实现者按同一协议自制 harness, 套件零改动, 与 [ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)「被测命令是参数」同构。

### 4.5 双载体纪律延续: bun / node 都跑

bun / node 两个 runtime 都跑 (与 CLI 面同款; node 载体按现有解析链需 build 前置, 与现状一致)。

### 4.6 语料 schema 扩展: kind 判别与新断言族

- case 判别字段 `kind: "cli" | "api"` (缺省兼容既有 57 条);
- api case 的 fixture / setup / fs 断言与 cli case 同款复用;
- 新增 `steps` 与 `expect` 的 `result` (精确 / 子集两档) / `error.code` / `events` / `fs` 断言族;
- 期望必须由条款 + fixture 尺寸推演辩护, 严禁「跑一遍记下来」式捕获 (沿用套件纪律)。

## 5. 契约与覆盖体系: 三档口径与条款正式登记

### 5.1 契约单源与三档可验收口径

- 契约保持唯一文件 (同一语义不做双源): [行为契约](../protocol/behavior-contract.md);
- 「可验收」列口径从两档 (✓ / 模块级) 升级为三档: CLI 黑盒 / API 黑盒 / 模块级。

### 5.2 平移表落地与 3 条条款正式编号 (承接 [可编程 API 面](../../packages/sweep-node-modules/docs/designs/api-surface.md) §3.4)

- 承接 [可编程 API 面](../../packages/sweep-node-modules/docs/designs/api-surface.md) §3.4 的义务: 平移表全部 27 个条款编号的 API 表达全量落进契约标注;
- 3 条待登记条款正式编号登记: 编入 BC 族续号, 按 A / B / C 顺序为 BC-42 (stale 窄例外) / BC-43 (三桶完备性恒等式) / BC-44 (事件终结契约)。

### 5.3 模块级条款: 借 API 黑盒面升级与不可黑盒面钉死

- 一批既标「模块级」的条款借 API 黑盒面升级可验 (如安全闸不变量 BC-21/22 的静态可造部分);
- 真正不可黑盒的 (竞态缝 / win32 宿主 / 真实挂载) 维持模块级钉死。

### 5.4 覆盖表登记与变异自证三态

- [覆盖表](../protocol/conformance/coverage.md) 登记 API 条款 × 语料覆盖与豁免; 可追溯 jq 台账校验延续;
- 变异自证: mutant 清单的 `expectCaughtBy` 更新为三态 (CLI 语料抓 / API 语料抓 / 双抓), 按需增补 API 面 mutant (如完备性恒等式破坏)。

## 6. 执行波次: 四波独立提交

每波独立提交, 各自可回滚:

1. **结构**: `git mv` 搬家 + 四处引用 + 全项目文档修复到「搬家后现状」(含全项目漂移审计的全量清单; ADR 类按仓库自陈惯例「保留原文 + 修订指引行」处置)。
   检查点: `bun run ci` 全绿, CLI 面 57 条照跑。
2. **契约**: behavior-contract.md 三档口径 + 平移表标注 + 3 条新增条款编号; protocol 区文档骨架更新。
   检查点: coverage 台账无悬空引用。
3. **机制**: harness 协议规范 + schema 扩展 + 参考 harness + 样例句跑通 + 变异自证抽样。
   检查点: 样例句 bun/node 双载体全绿, mutant 被样例句抓住。
4. **语料**: 冻结面语料全批 + 覆盖表登记 + mutant 对撞矩阵更新 + [实施提示词 transcribe-rust](../protocol/prompts/transcribe-rust.md) 加 API 面指引。
   检查点: 全量双载体绿 + 每个 mutant 明确「被谁抓」。

## 7. 完工判据

- conformance 双载体全绿 (CLI 57 条 + API 新增条数; 条数不写死, 以实时输出为准);
- 变异自证矩阵每格有结论, 抓不住的登记语料盲区;
- coverage.md: API 条款 × 语料对齐, 不可黑盒面逐条写明理由;
- 文档: 漂移审计复核归零 (无死链、结构描述与现状一致); 全链闸门 (build/typecheck/test/lint/prettier/conformance) 全绿。

## 8. 决策文档处置

- 设计文档 = 本次沉淀的这一份;
- [ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 补记记录本轮决策 (API 面验收机制 + harness 协议 + 排除备选的理由, 见 §9「取舍与排除备选」); 其套件结构描述 (`docs/protocol/` + `scripts/transcription/`) 随归位恢复正确, 无需改动;
- [ADR 0010](../adrs/0010-dual-package-monorepo.md) 补记: 套件归属重新裁定为仓库根 — 判据从「随能力」更新为「随服务对象」(双面验收横跨两包职责, 原判据无解), 前提变更原因写清。

## 9. 取舍与排除备选

被排除的两条备选与理由如下 (由 [ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 补记记录):

- 排除「runner 直接 import TS」: 因绑死 TS 而与转写使命脱节;
- 排除「CLI 加 `--json` 模式间接验」: 因属产品功能变更, 且覆盖不了 CLI 不消费的 API 面。

## 10. 明确不做 (YAGNI)

- 不做 CLI `--json` 机器模式 (产品功能变更, 已排除);
- 不铺「允许演化」面 (中文措辞类) 的语料;
- 不为 API 面验收新建第二套件 (机制单源, 一份套件双面覆盖);
- 不硬造探针表达不了的不可黑盒面 (登记豁免)。

## 11. 遗留归口

以下各项在此归口, 不在本文档执行:

- 全项目文档漂移清单 (审计全量) → 波 1 范围;
- ~~`scripts/install-git-hooks.test.ts` import 断链~~ (已修复, 见提交 `cd2476c`);
- mutants 快照过期 → 波 3/4 重生;
- `bun.lock` 记录滞后与散落的 `.modified` 备份 → 随批清理。
