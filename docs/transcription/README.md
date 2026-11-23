# 跨语言转写基建 (Transcription Kit)

> 适用范围: 本仓全部包 (`packages/*`) 共享的跨语言转写方法论、纪律、对抗评审指令、暗坑清单与语言通用模板。
>
> 分层原则:
>
> - **仓库级 (`docs/transcription/` 与 `scripts/transcription/`)**: 跨包共享的通用纪律、评审提示词、TS 跨语言暗坑、目标语言通用模板、确定性验收器 (`run-conformance.ts`) 与差分模糊测试引擎 (`run-diff-fuzz.ts`), 所有包共用一套, 不在每个包里重复维护。
> - **包级 (`packages/<pkg>/docs/protocol/`, 按需创建)**: 仅存放该包独有的行为契约 (`behavior-contract.md`)、金样本语料 (`conformance/corpus/`)、覆盖表 (`conformance/coverage.md`)、API harness 协议、模糊测试目标声明 (`conformance/fuzz-targets.json`) 以及可选的目标语言领域补充。

## 仓级资产目录

| 文件                                                                   | 定位                 | 说明                                                                                    |
| ---------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| [`common-discipline.md`](common-discipline.md)                         | 通用实施纪律         | 角色边界、反敷衍三条红线、映射表与 3 文件试跑闸门、双面 `release` 终验与并行写盘纪律    |
| [`adversarial-reviewer.md`](adversarial-reviewer.md)                   | 对抗评审指令         | 独立上下文的「只挑刺不写码」评审提示词, 专抓形似神异语义暗差、空壳 stub、借口注释与缩水 |
| [`ts-porting-pitfalls.md`](ts-porting-pitfalls.md)                     | TS 跨语言暗坑核查表  | 汇总 TS/JS 转写到系统/静态语言时「写法相似、语义相反」的高频陷阱                        |
| [`target-rust.md`](target-rust.md)                                     | Rust 通用转写模板    | 面向任意包的 Rust 转写通用基线 (`#![forbid(unsafe_code)]`、stdout 刷盘、零依赖与试跑单) |
| [`run-conformance.ts`](../../scripts/transcription/run-conformance.ts) | 确定性双面黑盒验收器 | 语言无关验收 CLI 与 API 双面行为; 支持 `--emit-failures <dir>` 导出自包含失败诊断单     |
| [`run-diff-fuzz.ts`](../../scripts/transcription/run-diff-fuzz.ts)     | 通用差分模糊测试引擎 | 按包级 `fuzz-targets.json` 用确定性种子生成对抗输入, 校验纯函数不变量与双实现等价性     |

## 标准转写 6 步工作流

1. **基线验绿**: 先对参考实现跑满该包的全量双面验收 (`bun scripts/transcription/run-conformance.ts --target ... --api-target ...`) 与变异自证 (`bun scripts/transcription/make-mutants.ts`); 基线不绿先修套件, 不开始转写。
2. **建映射表 + 3 文件试跑 (`Trial Run`)**: 按 [`common-discipline.md`](common-discipline.md) 产出 `PORTING_MAP.tsv`, 挑 3 个具代表性的源模块 (纯函数 + 校验/解析 + 系统 IO) 完成「写 -> 对抗审 -> 修 -> 编译过测」闭环, 确认接口口径与依赖策略无误后再全量铺开。
3. **1 写 + 2 对抗审 + 1 修**:
   - **实现者**: 持 [`common-discipline.md`](common-discipline.md) + 目标语言模板 (如 [`target-rust.md`](target-rust.md)) + 包级契约与专属补充实施;
   - **对抗评审者 A & B (独立干净上下文)**: 各持 [`adversarial-reviewer.md`](adversarial-reviewer.md) + [`ts-porting-pitfalls.md`](ts-porting-pitfalls.md), 分别聚焦「行为语义与契约对齐」与「内存/错误/边界/反敷衍红线」, 只挑刺不写代码;
   - **修复者**: 综合两份阻断清单修复, 严禁以注释为 workaround 辩解。
4. **双面 `release` 全量验收**: 必须在**优化后的最终构建产物** (如 Rust `cargo build --release`) 上无 `--filter` 跑满全量语料, 确认输出含 `全量核验通过` (`skipped = 0`) 且连续 3 次结果一致; 若有失败, 配合 `--emit-failures <dir>` 导出自包含诊断单逐条定责修复:

   ```bash
   bun scripts/transcription/run-conformance.ts \
     --target "<目标 release 可执行路径>" \
     --api-target "<目标 release harness 路径>" \
     --emit-failures ~/tmp/conformance-failures
   ```

5. **差分模糊测试兜底**: 对包内纯函数、解析器与校验器跑确定性随机对抗输入, 将目标 harness 与参考实现逐组深比对:

   ```bash
   bun scripts/transcription/run-diff-fuzz.ts \
     --targets "<包路径>/docs/protocol/conformance/fuzz-targets.json" \
     --api-target "<目标 release harness 路径>" \
     --emit-failures ~/tmp/fuzz-failures
   ```

6. **盲区补测与交付**: 对照包级 `conformance/coverage.md` 的不可黑盒豁免项 (如 TTY 交互、真机跨设备挂载、非本机平台路径), 补齐目标语言原生单测并交付映射表、缺口清单与双面验收原文。

## 为新包接入转写基建

新增一个需要支持跨语言转写的包时, **不需要**复制任何 `prompts/` 通用提示词, 只需在该包下新建 `packages/<pkg>/docs/protocol/` 并补齐 5 类包专属资产:

1. `behavior-contract.md`: 编号条款 (`BC-*` / `OF-*` / `EC-*`);
2. `conformance/corpus/*.json` (及可选 `conformance/corpus.schema.json` / `conformance/api-harness-protocol.md`): 期望可由条款推导的金样本语料;
3. `conformance/coverage.md`: 条款 × 语料覆盖矩阵与豁免登记;
4. `conformance/mutants.json` 与 `conformance/fuzz-targets.json`: 变异自证锚点表与需差分模糊测试的公开纯函数及不变量清单;
5. (可选) `prompts/transcribe-<lang>.md`: 仅写该包特有的领域行为对照表与试跑模块组合, 开头直接继承仓级 `docs/transcription/`。
