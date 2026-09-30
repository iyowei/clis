# 转写双面覆盖: 实施计划

> **给执行体**: 本计划按任务逐条执行, 步骤用 `- [ ]` 勾选跟踪。
> **执行状态 (2026-09-30 回填)**: 全部任务已落地 (波 1 `b15fa96`/`b61c381`, 波 2 `043c113`, 波 3 `1c445ce`, 波 4 随收口批提交); 逐步的执行细节与偏差以 git 历史与各批提交信息为准, 本清单勾选为总览。
> 每任务末尾的提交一律派 `@agent-x:commit` (见全局约束)。

**目标**: 把转写契约套件归位仓库根 `scripts/transcription/`, 补齐 API 面黑盒验收 (会话式 harness 协议 + 冻结面语料), 清偿全项目文档漂移, 形成 CLI + API 双面覆盖。

**架构**: 四波独立落地, 每波自成提交批次、各自可回滚: 波 1 结构 (git mv + 引用 + 文档修复) → 波 2 契约 (behavior-contract 三档口径 + 3 条条款登记) → 波 3 机制 (协议 + schema + 参考 harness + 样例句) → 波 4 语料 (冻结面全批 + 覆盖表 + 变异自证矩阵 + 提示词)。

**技术栈**: TypeScript (bun 直跑 / node 双载体), JSON schema (语料), git, 仓库既有闸门链 (`bun run ci`)。

**设计文档 (随本计划并行阅读)**: `docs/designs/transcription-dual-surface.md`

## 全局约束

- **提交**: 任何 git 提交一律派 `@agent-x:commit` 执行 (仓库物理闸门拦截裸 `git commit`); 派发时注入 shell 命令模板 (rg/fd/bat/eza + 锁文件检测)。不 push, 推送时机由调用方另行安排。
- **闸门**: 每波结束跑 `bun run ci` (build → typecheck → test → lint → format-check → conformance 双 target) 全绿; 落盘中文文档过排版闸门 (`bun /Users/iyowei/lab/dotAI/scripts/lint-zh-typography.ts <file>`) 与 prettier。
- **语料纪律**: 期望必须由条款 + fixture 尺寸推演辩护, 严禁「跑一遍记下来」式捕获; 语料只增不改既有期望; 文件名 = case id; `specRefs` 非空且指向真实条款。
- **双载体**: 所有 conformance 验证在 bun 与 node 两个 runtime 各跑一遍 (node 侧沿用既有 build 前置)。
- **修改前置备份**: 修改现有文件前按宪法创建备份到 `~/tmp/sweep_backups/` (保留相对结构); git 跟踪且可完整回滚的批量机械替换除外。
- **波次顺序锁**: 波 1 的 `git mv` 先于一切 (全部路径以归位后布局为准); 波 2 的条款登记先于波 3/4 (语料 `specRefs` 的背书目标必须先存在)。

---

## 波 1: 结构 (套件归位 + 全项目文档漂移清偿)

### Task 1: 套件 git mv 回仓库根与全引用修正

**文件**:

- 移动: `packages/sweep-node-modules-cli/scripts/transcription/` → `scripts/transcription/`
- 修改: `scripts/transcription/run-conformance.ts` (常量与注释), `scripts/transcription/make-mutants.ts` (常量与注释), `package.json` (根), `scripts/ci.ts`, `packages/sweep-node-modules-cli/tsconfig.json`, 根 `tsconfig.json`, `.gitignore`, `docs/protocol/conformance/corpus/README.md`
- 清理: 旧位置遗留的 `mutants/` 生成物 (过期快照, 波 3 重生于新位置)

**接口**: 归位后套件入口 = `scripts/transcription/run-conformance.ts` (仓库根相对路径); 语料默认目录仍解析到 `docs/protocol/conformance/corpus/`。

- [x] **Step 1: git mv 搬家 (保历史)**

```bash
git mv packages/sweep-node-modules-cli/scripts/transcription scripts/transcription
```

- [x] **Step 2: 清理旧位置遗留的 mutants 生成物**

`git mv` 只带跟踪文件; `mutants/` 是被忽略的过期快照。确认旧路径下只剩它后删除 (波 3 会按现源码重建):

```bash
fd . packages/sweep-node-modules-cli/scripts 2>/dev/null
# 若 transcription 目录只剩 mutants/, 整个删除
rm -rf packages/sweep-node-modules-cli/scripts/transcription
```

- [x] **Step 3: 修正 run-conformance.ts 的路径常量与注释**

`DEFAULT_CORPUS_DIR` 的上溯级数由 4 级收为 2 级 (自 HERE 即 `scripts/transcription/` 上溯到仓库根); 文件头与 `--help` 的用法注释路径改为 `scripts/transcription/...` 形态。

- [x] **Step 4: 修正 make-mutants.ts 的路径常量与注释**

`REPO_ROOT` 上溯级数 4 → 2; 注释同理。

- [x] **Step 5: 修正四处配置引用**

- 根 `package.json` 的 `conformance` 脚本: `bun scripts/transcription/run-conformance.ts`;
- `scripts/ci.ts` 的 `conformance()`: 同上路径, target 保持 `bun packages/sweep-node-modules-cli/src/cli.ts` (双 runtime 循环不变);
- CLI 包 `tsconfig.json` 的 `exclude` 条目 (`scripts/transcription/mutants`) 移除, 改挂根 `tsconfig.json` 的等价 exclude;
- `.gitignore` 的 mutants 忽略路径改为 `scripts/transcription/mutants/`。

- [x] **Step 6: 修正 corpus/README.md 的命令区**

`docs/protocol/conformance/corpus/README.md` 运行命令统一为「从仓库根执行」的完整路径形态; mutant target 改为 `bun scripts/transcription/mutants/gen-<id>/packages/sweep-node-modules-cli/src/cli.ts`; 示例中单 token 相对路径 (如 `./sweep-nm-rs`) 改为完整路径形态 (不动 runner 的 argv[0] 解析逻辑, 属文档侧修正)。

- [x] **Step 7: 验证 conformance 双载体**

```bash
bun scripts/ci.ts --conformance
```

预期: bun 与 node 两个 target 各 `57 通过, 0 失败`。

- [x] **Step 8: 提交**

派 `@agent-x:commit`, 主题「套件归位仓库根」, 含: git mv 结果 + 常量/注释/配置/命令修正。

### Task 2: docs/protocol 区自愈验证与残余修正

**文件**: `docs/protocol/README.md`, `docs/protocol/conformance/corpus.schema.json`, `docs/protocol/conformance/coverage.md`, `docs/protocol/prompts/*`

**背景**: 该区大量引用本来就是「指向根」的写法, 归位后应自愈; 本任务只验证 + 修残余。

- [x] **Step 1: 验证自愈**: 逐文件实读以下引用是否已正确 (指向 `scripts/transcription/...` 且文件存在): README.md 验收器/变异生成器两行与两处命令; corpus.schema.json description; coverage.md 的 fixture.ts 提及。

- [x] **Step 2: 修残余**: 凡仍不正确处按实际路径修正; `docs/protocol/README.md` 的「维护规则」与「用本套件转写一门新语言」两节命令过一遍 (改后须与 Task 1 Step 6 的形态一致)。

- [x] **Step 3: 闸门**: 排版 lint + prettier 过。

- [x] **Step 4: 提交**: 主题「protocol 区路径自愈与残余修正」(若与 Task 1 改动同批更自然, 可并入 Task 1 提交; 由提交代理按单一主题判定)。

### Task 3: 全项目文档漂移清偿 (审计清单, 按载体分三批)

**输入**: 全项目漂移审计发现清单 (56 条, 高 2 / 中 29 / 低 25)。高 2 与套件路径相关性已在 Task 1/2 覆盖; 本任务处理其余。

**裁定纪律**: 涉及「文档承诺 vs 实现行为」冲突的条目, 以设计文档裁定契约、以代码为行为事实基准: 实现符合设计原意 → 改文档; 实现偏离既定契约 → 提请决策者后动代码。拿不准的一律先提请, 不硬改。

- [x] **Step 1 (批 b): designs/ 与 adrs/ 载体**: 双包坐标补前缀 (src/_、bin/_ 等裸引用); api-surface.md 自身漂移 (计数、类型块补 `drift` 字段、单包时代结构描述加时代标注); scan-and-size.md 四桶口径; install-tree-hardening.md 第五不变量; architecture-overview.md 幽灵引文; ADR 0010 的 workspace 协议补记、ADR 类逐条加「修订指引行」(注明现包坐标, 保留原文)。
- [x] **Step 2 (批 c): 根文档与包 README**: 发布链/闸门叙事五处统一 (「CI 与 pre-push 均已按双 target 自动执行」); pre-push 六步枚举; CLI README 平台承诺加限定语、node-only 构建指令改述、「零删除」语义限定到预检拒绝路径、配置示例换中性路径; API README 的 `plan().basis` 条件与 gone 顺序等口径修正; 英中两版同批。
      其中「measure 取消检查点」与「gone 顺序」两条先查设计原意定责, 结论写入修改说明。
- [x] **Step 3 (批 d): 源码注释与低组**: 两包 src 的跨包路径指代补前缀; benches 命令形态; codes.ts 域列表; size-du.ts 中文转写口径; corpus.ts 示例零填充; cli.ts 幽灵章节名; init.ts 权威指代; 低组其余 (历史计数类改「以实时输出为准」或更新值)。cli.ts「本轮未执行删除」文案与「零删除」裁定同批。
- [x] **Step 4: 闸门**: 全部修改过的 .md 过排版 lint + prettier; 抽查死链 (改动涉及的链接逐条实测)。
- [x] **Step 5: 提交**: 批发三个提交 (按载体群), 或经提交代理判定合并。

### Task 4: install-git-hooks 测试断链修复 (独立小批)

**文件**: `scripts/install-git-hooks.test.ts` (import 修正) 或测试迁移

- [x] **Step 1: 复现**: `bun test` 直通形态当前 547 过 / 1 挂 / 1 error; 确认断链点在 `import { cleanGitEnv } from './git-env.ts'` (该文件已迁至 CLI 包 `scripts/git-env.ts`)。

- [x] **Step 2: 修复**: 最小修法 = import 路径改为跨包相对路径; 若该测试的执行位置 (仓库根 scripts/) 与 turbo/CI 通道不匹配, 一并纳入 test 通道或迁移测试文件。修后 `bun test` 全绿。

- [x] **Step 3: 提交**: 主题「修复 install-git-hooks 测试断链」。

**波 1 检查点**: `bun run ci` 全绿 (CLI 面 57 条照跑); 文档修改处死链抽查通过; `bun test` 直通形态全绿。

---

## 波 2: 契约 (behavior-contract 三档口径 + 条款登记)

### Task 5: 契约三档口径与平移表标注

**文件**: `docs/protocol/behavior-contract.md`

**接口**: 「可验收」列取值域 = `CLI 黑盒` / `API 黑盒` / `API 黑盒 + CLI 黑盒` / `模块级 (理由)` / `成本性未覆盖 (理由)` / TTY 专属面等既有豁免形态。

- [x] **Step 1: 改表头说明**: 「可验收性列」的判据说明从两档扩为三档, 写明三档定义 (CLI 黑盒面 / API 黑盒面 (经由 harness 协议) / 模块级钉死) 与豁免纪律不变。
- [x] **Step 2: 逐条标注**: 对 27 个平移表条款编号 (BC-04 / BC-06 / BC-07 / BC-08 / BC-09 / BC-12 / BC-13 / BC-14 / BC-15 / BC-20 / BC-21 / BC-22 / BC-24 / BC-25 / BC-26 / BC-33 / BC-34 / BC-37 / BC-38 / BC-39 / BC-41 / EC-01 / EC-02 / EC-03 / EC-04 / EC-05 / EC-07) 逐条更新可验收列: 能经 API 黑盒验的加 `API 黑盒`, 与 api-surface.md §3.4 平移表逐一对齐。
- [x] **Step 3: 升级判定**: BC-21 / BC-22 等原标「模块级」的条款, 静态可造部分 (转写 / 逃逸 / 重复目标等预检拒绝路径) 升级为 `API 黑盒`; 真不可黑盒的 (竞态缝 / win32 宿主 / 真实挂载) 维持模块级并保留理由。
- [x] **Step 4: 闸门 + 提交**: 排版 lint; 提交主题「契约三档口径与平移表标注」。

### Task 6: 3 条新增条款正式登记 (BC-42 / BC-43 / BC-44)

**文件**: `docs/protocol/behavior-contract.md`

- [x] **Step 1: 登记三行**: 按既有表格结构追加:

| 编号  | 条款 (要点)                                                                                                                      | 权威出处                                   | 可验收   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------- |
| BC-42 | 安全闸整批拒绝的窄例外: 显式 `staleTargets: 'missing'` 仅放行 `GUARD_TARGET_MISSING` 改判 `stale` 计成功侧, 其余拒绝码维持零删除 | api-surface.md §3.4 待登记条款 A; sweep.ts | API 黑盒 |
| BC-43 | `SizeResult` 三桶 (measured / unmeasured / gone) 构成入参的全划分且两两不相交                                                    | api-surface.md §3.4 待登记条款 B; size.ts  | API 黑盒 |
| BC-44 | 进度事件流终结契约: `plan()` 末事件恒为 `plan-done`, `run()` 末事件恒为 `done`, 之后无事件                                       | api-surface.md §3.4 待登记条款 C; sweep.ts | API 黑盒 |

(编号已由设计文档定死; 条款全文按 api-surface.md §3.4 三条原文与代码实读对齐后落笔。)

- [x] **Step 2: 同步 api-surface.md**: §3.4 三条「待登记」标注改为已登记 (注明 BC-42/43/44), 修订记录加行。
- [x] **Step 3: 闸门 + 提交**: 主题「登记 BC-42/43/44 三条新增条款」。

### Task 7: coverage.md 骨架更新

**文件**: `docs/protocol/conformance/coverage.md`

- [x] **Step 1: 加 API 面章节骨架**: 说明 API 面覆盖将随波 3/4 的语料落位; 台账结构预留 API case 引用列。
- [x] **Step 2: 台账校验说明更新**: jq 可追溯校验脚本/说明覆盖两类语料 (cli + api)。
- [x] **Step 3: 提交**: 主题「覆盖表 API 面骨架」。

**波 2 检查点**: behavior-contract 的可验收列无遗漏条款 (64 + 3 = 67 条逐条有值); coverage 台账说明与两类语料兼容; 排版闸门全绿。

---

## 波 3: 机制 (协议 + schema + 参考 harness + 样例句)

### Task 8: harness 协议规范文档

**文件**: 新建 `docs/protocol/conformance/api-harness-protocol.md`

- [x] **Step 1: 落协议全文** (按设计文档 §4.1-4.4 展开为规范性文本, 含): 输入 `{ steps: [...] }` 的形状与两步骤型 (创建步 `{as, call:{export, args}}` / 方法步 `{call:{on, method, args}, collectEvents}`); `$FIXTURE` 替换契约; `{"$probe": "<名>"}` 标记与初版探针目录 (pathops.posix / pathops.win32 / deviceProbe 的确定性 stub, 命名集合本任务定稿); 输出 `{ok, value}` / `{ok, error:{name, code, message, details?}}` + `events`; 崩溃语义 (非零退出 + stderr 诊断, 验收器按环境错误分流); 语言实现者契约 (任何语言按此协议提供 harness 可执行, 套件零改动)。
- [x] **Step 2: 与 docs/protocol/README.md 挂钩**: 套件结构表加「API harness 协议」行; 转写流程节补 API 面一句话。
- [x] **Step 3: 闸门 + 提交**: 主题「API harness 协议规范」。

### Task 9: 语料 schema 扩展 (kind 判别 + api case)

**文件**: `docs/protocol/conformance/corpus.schema.json`, `scripts/transcription/corpus.ts` (类型与手写校验)

- [x] **Step 1: schema 扩展**: 顶层加 `kind: "cli" | "api"` (缺省 cli, 兼容既有 57 条); api case 定义: `fixture` / `setup` 与 cli 共用; 新增 `steps` (协议指令数组) 与 `expect` 的 `result` (exact / subset 两档) / `error` (`code` 必选, `name` 可选) / `events` (mustInclude / lastIs) / `fs` (复用 cli 断言族)。
- [x] **Step 2: corpus.ts 同步**: 类型定义 + 手写校验 (schema 的物化子集) 支持 kind 判别与 api 字段; 报错文案给出可读定位。
- [x] **Step 3: 验证兼容**: 既有 57 条语料照常加载 (无 kind 字段按 cli 走), `bun scripts/ci.ts --conformance` 仍全绿。
- [x] **Step 4: 提交**: 主题「语料 schema 支持 api case」。

### Task 10: 参考 harness 实现 (TS)

**文件**: 新建 `scripts/transcription/api-harness.ts` (+ 探针实现, 可同文件或 `api-probes.ts`)

- [x] **Step 1: 实现**: 读 stdin JSON → 依 `steps` 顺序执行 (动态 import API 包 src 的导出; `$probe` 标记替换为探针实现的函数对象; `$FIXTURE` 替换) → 输出 `{ok, value}` / `{ok, error}` (+ events 收集)。开发态 import 用相对路径指向 `packages/sweep-node-modules/src/index.ts`; mutant 场景同一套代码在副本内解析近邻源码 (路径策略写入文件头注释)。
- [x] **Step 2: 手测**: 构造一条最小指令 (如 `createScanner` + `scan`) 从 stdin 喂入, 双载体 (bun / node) 各跑一遍, 人工核对输出 JSON。
- [x] **Step 3: 提交**: 主题「参考 harness 实现」。

### Task 11: runner 与比对层扩展 (api case 执行路径)

**文件**: `scripts/transcription/run-conformance.ts`, `scripts/transcription/fixture.ts` (如需), `scripts/transcription/compare.ts`, `scripts/transcription/report.ts`

- [x] **Step 1: 执行路径**: api case 走 fixture 建树 (复用) → 以最小白名单 env + fixture cwd 启动 harness 命令 (target 参数化的「API harness 可执行」, 默认 = 参考 harness 的 bun/node 直跑形态) → stdin 喂指令 JSON → 收 stdout 结果 JSON 与退出码。
- [x] **Step 2: 比对层**: `result.exact` 深比较 / `result.subset` 子集包含; `error.code` / `name`; `events.mustInclude` 集合包含 / `events.lastIs` 末事件; `fs` 复用既有断言; 失败项进报告 (既有 FailureItem 结构)。
- [x] **Step 3: 报告**: 人读与 JSON 报告兼容 api case (标注 kind)。
- [x] **Step 4: 验证**: 既有 57 条 cli 用例全绿不变; 提交主题「runner 支持 api case」。

### Task 12: 样例句跑通 + 变异自证抽样

**文件**: 新建 `docs/protocol/conformance/corpus/` 下 4 条 api 语料 (id 初定: `api-scan-hits-sorted` / `api-config-corrupt-throws` / `api-sweep-plan-terminal-event` / `api-guard-reject-batch`)

- [x] **Step 1: 写 4 条样例句**: 分别覆盖: 创建+方法调用+返回值子集断言 (含排序); 抛错 code 断言; 事件收集与末事件断言; 安全闸拒绝面 (整批零删除)。期望逐条由条款 + fixture 推演辩护 (specRefs 指向波 2 登记后的条款)。
- [x] **Step 2: 双载体跑通**: `bun scripts/ci.ts --conformance` 全绿 (含新 4 条)。
- [x] **Step 3: 变异自证抽样**: `bun scripts/transcription/make-mutants.ts` 重生 mutants (新位置, 按现源码); 对 `prune-negated` / `sort-missing` 两个 mutant 跑样例句子集, 确认被抓住 (预期失败)。
- [x] **Step 4: 提交**: 主题「API 面样例句与变异自证抽样」。

**波 3 检查点**: 样例句 bun/node 双载体全绿; mutant 被样例句抓住 (预期失败出现); 协议文档 + schema + 实现三处互洽 (字段名逐一对齐)。

---

## 波 4: 语料 (冻结面全批 + 覆盖表 + 矩阵 + 提示词)

### Task 13: 语料清单编制

**文件**: 计划性产物 (写入 Task 13 提交的说明或 coverage.md 的待覆盖列)

- [x] **Step 1: 盘条款**: 以 behavior-contract 的 API 黑盒标注条款为全集, 逐条给出语料映射 (条款 → 拟定 case id 列表), 覆盖: 27 个平移编号 + BC-42/43/44 + 编排层面 (createSweeper 的 plan/run 主流程、错误通道) 与读侧原语面 (scan/size/config 的 API 表达)。
- [x] **Step 2: 定豁免**: 表达不了的边角 (探针无法模拟的注入面 / 事件序 / 成本性面) 登记豁免候选, 逐条写理由。
- [x] **Step 3: 提交**: 清单并入 coverage.md 的待覆盖列 (同 Task 14 首步), 或单独提交。

### Task 14: 冻结面语料全批编写

**文件**: `docs/protocol/conformance/corpus/api-*.json` (批量新增)

- [x] **Step 1-N: 分批编写**: 按 Task 13 清单逐条落语料; 每条: id = 文件名、specRefs 指向真实条款、期望推演辩护、fixture 尺寸最小化; 关键条款多分支 (正常 / 边界)。建议按条款族分批 (读侧 / 判定件 / 写侧 / 编排 / 配置), 每批写完即双载体跑一遍增量验证。
- [x] **Step 末: 全量验证**: `bun scripts/ci.ts --conformance` 双载体全绿 (CLI 57 + api 全批)。
- [x] **提交**: 按批提交或一批一提交 (主题「API 面冻结语料 <族名>」)。

### Task 15: coverage.md 全量登记

- [x] **Step 1**: 条款 × 语料覆盖表补齐 (api 全批); 未被覆盖条款逐条落豁免区, 理由按既有纪律 (竞态缝 / 宿主 / 成本 / 探针不可达)。
- [x] **Step 2**: jq 台账校验跑通 (无悬空引用; 未被引用者恰为豁免项)。
- [x] **Step 3**: 提交。

### Task 16: 变异自证矩阵与快照重生

- [x] **Step 1**: 对全部 mutants 跑全量语料 (cli + api), 记录每个 mutant 的抓获情况; 清单 `expectCaughtBy` 更新为三态 (CLI 抓 / API 抓 / 双抓)。
- [x] **Step 2**: 抓不住的 mutant: 判「语料盲区 (补语料)」还是「mutant 定义过弱 (修 mutant)」; 按需增补 API 面 mutant (如完备性恒等式破坏)。
- [x] **Step 3**: mutants 快照按现源码重生, 一致性确认 (旧 759 行 cli.ts 快照问题消除)。
- [x] **Step 4**: 提交。

### Task 17: 实施提示词更新

**文件**: `docs/protocol/prompts/transcribe-rust.md`, `docs/protocol/prompts/common-discipline.md`

- [x] **Step 1**: transcribe-rust.md 补 API 面: Rust 实现需同时提供 (a) CLI 可执行 (b) 按协议实现的 API harness; 交付物含两面的 conformance 报告。
- [x] **Step 2**: common-discipline.md 同步「双面验收」纪律 (未覆盖处停手报缺口不变)。
- [x] **Step 3**: 闸门 + 提交。

### Task 18: 收口终验 (完工判据逐条核对)

- [x] **Step 1**: `bun run ci` 全链全绿。
- [x] **Step 2**: 完工判据四条逐条核对 (设计文档 §7): 双载体全绿 / 矩阵每格有结论 / coverage 对齐 + 豁免有理由 / 文档漂移复核归零。
- [x] **Step 3**: 全项目文档漂移抽查 (审计清单逐条核销)。
- [x] **Step 4**: 收口提交 (或标记完成, 由调用方决定推送时机)。

**波 4 检查点**: 全部完工判据条目有证据 (命令输出 / 台账 / 矩阵表); 遗留项清零或显式登记。

---

## 自审记录

- **spec 覆盖核对**: 设计文档 §3 (归位) → 波 1 T1/T2; §4 (机制) → 波 3 T8-T12; §5 (契约与覆盖) → 波 2 T5-T7 + 波 4 T15/T16; §6 (波次) → 本计划四波结构; §8 (决策文档) → 波 1 T3 (ADR 类修订指引行) + 待办的 ADR 补记 (落盘时机: 波 2 或随设计文档提交批, 由调用方定); §11 (遗留归口) → 波 1 T3/T4 + 波 3/4。无缺口。
- **占位符扫描**: 波 3/4 的语料文案与协议文本属执行产物, 本计划给形状与判据; 无 TBD/TODO 遗留。
- **术语一致性**: 三档口径 (CLI 黑盒 / API 黑盒 / 模块级)、BC-42/43/44、`kind: "api"`、`$probe` / `$FIXTURE` 在全文统一。
