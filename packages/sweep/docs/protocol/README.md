# `sweep` 转写契约套件 (Package Protocol)

> 用途: 为 `sweep` 提供一套语言无关的行为契约、金样本语料、覆盖台账与模糊测试目标清单; 与仓级共享转写基建 ([`docs/transcription/`](../../../../docs/transcription/README.md) + `scripts/transcription/`) 配合, 保证用 Rust / C 或任意语言重写出的实现与 TypeScript 参考实现可机械证明等价。
>
> 权威: 行为语义以包级设计文档为准 (`packages/sweep/docs/designs/` 与 `packages/sweep-cli/docs/designs/`); 本目录只存放 **`sweep` 专属**的协议与语料资产, 跨包通用的转写纪律、对抗评审指令、TS 暗坑核查表与目标语言通用模板统一维护在仓级 [`docs/transcription/`](../../../../docs/transcription/README.md), 避免多包重复维护。

## 套件结构 (仓级共享 × 包级专属)

| 归属     | 组件             | 位置                                                                                                           | 说明                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓级共享 | 通用转写工作流   | [`../../../../docs/transcription/README.md`](../../../../docs/transcription/README.md)                         | 面向全仓所有 packages 的 6 步工作流、[`common-discipline.md`](../../../../docs/transcription/common-discipline.md)、[`adversarial-reviewer.md`](../../../../docs/transcription/adversarial-reviewer.md)、[`ts-porting-pitfalls.md`](../../../../docs/transcription/ts-porting-pitfalls.md) 与 [`target-rust.md`](../../../../docs/transcription/target-rust.md) |
| 仓级共享 | 确定性验收器     | [`../../../../scripts/transcription/run-conformance.ts`](../../../../scripts/transcription/run-conformance.ts) | 确定性、零 AI、语言无关双面验收器; 支持全量水印与 `--emit-failures <dir>` 导出自包含失败诊断单                                                                                                                                                                                                                                                                  |
| 仓级共享 | 差分模糊测试引擎 | [`../../../../scripts/transcription/run-diff-fuzz.ts`](../../../../scripts/transcription/run-diff-fuzz.ts)     | 确定性 PRNG 生成对抗输入, 校验纯函数不变量与双实现等价性                                                                                                                                                                                                                                                                                                        |
| 仓级共享 | 变异生成器       | [`../../../../scripts/transcription/make-mutants.ts`](../../../../scripts/transcription/make-mutants.ts)       | 反向验收自证工具 (语料抓不住的 mutant 即语料盲区)                                                                                                                                                                                                                                                                                                               |
| 包级专属 | 行为契约         | [`behavior-contract.md`](behavior-contract.md)                                                                 | `sweep` 编号条款 (`BC-*` / `OF-*` / `EC-*`); 语料的 `specRefs` 指向此处                                                                                                                                                                                                                                                                                         |
| 包级专属 | 语料 schema      | [`conformance/corpus.schema.json`](conformance/corpus.schema.json)                                             | 金样本各字段的权威定义; 验收器内手写校验为其物化子集                                                                                                                                                                                                                                                                                                            |
| 包级专属 | 金样本语料       | [`conformance/corpus/`](conformance/corpus/)                                                                   | CLI + API 双面全量金样本; 每条期望须能由条款与 fixture 尺寸推导出                                                                                                                                                                                                                                                                                               |
| 包级专属 | 覆盖表           | [`conformance/coverage.md`](conformance/coverage.md)                                                           | 条款 × 语料覆盖矩阵、豁免登记与变异自证结果                                                                                                                                                                                                                                                                                                                     |
| 包级专属 | API harness 协议 | [`conformance/api-harness-protocol.md`](conformance/api-harness-protocol.md)                                   | `sweep` API 用例调用协议 (含具名探针与可选批量模式); 参考实现 [`../../../../scripts/transcription/api-harness.ts`](../../../../scripts/transcription/api-harness.ts)                                                                                                                                                                                            |
| 包级专属 | 模糊测试目标清单 | [`conformance/fuzz-targets.json`](conformance/fuzz-targets.json)                                               | 供 `run-diff-fuzz.ts` 消费的 `sweep` 纯函数、生成器与不变量声明                                                                                                                                                                                                                                                                                                 |
| 包级专属 | Rust 领域补充    | [`prompts/transcribe-rust.md`](prompts/transcribe-rust.md)                                                     | 继承仓级通用模板, 仅补充 `sweep` 专属行为对照、3 文件试跑组合与盲区清单                                                                                                                                                                                                                                                                                         |

## 用本套件将 `sweep` 转写到另一种语言

完整 6 步工作流以仓级 [`docs/transcription/README.md`](../../../../docs/transcription/README.md) 为准, `sweep` 侧执行要点如下:

1. 通读 [`behavior-contract.md`](behavior-contract.md) 与包级设计文档 (`packages/sweep/docs/designs/` 与 `packages/sweep-cli/docs/designs/`);
2. 同时装载仓级 [`docs/transcription/common-discipline.md`](../../../../docs/transcription/common-discipline.md) + 目标语言通用模板 (如 [`target-rust.md`](../../../../docs/transcription/target-rust.md)) + 包级 [`prompts/transcribe-rust.md`](prompts/transcribe-rust.md), 先建 `PORTING_MAP.tsv` 并完成 3 文件试跑;
3. 以「1 写 + 2 对抗审 + 1 修」推进并在 **`release` 优化构建产物**上跑满全量双面验收 (禁用 `--filter` 充全绿, 失败时加 `--emit-failures` 导出单用例诊断单):

   ```bash
   bun scripts/transcription/run-conformance.ts \
     --target "<你的 release CLI 可执行>" \
     --api-target "<你的 release API harness 可执行>" \
     --emit-failures ~/tmp/sweep-conformance-failures
   ```

4. 跑通差分模糊测试, 将目标 harness 与 TS 参考实现逐组深比对:

   ```bash
   bun scripts/transcription/run-diff-fuzz.ts \
     --targets packages/sweep/docs/protocol/conformance/fuzz-targets.json \
     --api-target "<你的 release API harness 可执行>" \
     --emit-failures ~/tmp/sweep-fuzz-failures
   ```

5. 对照 [`conformance/coverage.md`](conformance/coverage.md) 中的豁免条款补齐目标语言原生单测, 连同映射表、缺口清单与双面/模糊验收原文一并交付。

## 维护规则

- 语料**只增不改已有期望**; 确需调整期望时, 先过「三向定责」(修语料 / 修契约 / 修实现) 并写明依据;
- 新增语料: 文件名等于 `id`; `specRefs` 非空且指向真实存在的条款; 期望可由条款与 fixture 尺寸推导;
- 重大改动后重跑反向验收 (`bun scripts/transcription/make-mutants.ts`) 与差分模糊测试 (`bun scripts/transcription/run-diff-fuzz.ts`);
- 体积数字按文件系统块大小计算 (本机 4096); 换平台重跑前需按对应块大小校准;
- 本套件与实现同步演进: 行为契约、语料与设计文档三处保持一致。
