# 转写契约套件 (transcription kit)

> 用途: 除了 TypeScript 参考实现, 还提供一套「精准转写工具包」: 将来用 Rust / C 或任何语言重写时, 靠一份语言无关的契约、一组金样本语料和一个确定性验收器, 保证重写出来的实现与参考实现等价, 且这一点可以机械验收; AI 只负责「按契约实施」, 有验收器兜底。
> 权威: 行为语义以各级设计文档为准 (仓库级 `docs/designs/` 与包级 `docs/`); 本目录是这些设计文档面向「转写与验收」的视图, 把相关内容按条款编号重新组织。

## 套件结构

| 组件             | 位置                                                                                                     | 说明                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行为契约         | [`behavior-contract.md`](behavior-contract.md)                                                           | 编号条款 (BC-* / OF-* / EC-*); 语料的 `specRefs` 就指向这里                                                                                                     |
| 语料 schema      | [`conformance/corpus.schema.json`](conformance/corpus.schema.json)                                       | 金样本各字段的含义以这份 schema 为准; 验收器里手写的校验, 只是这份 schema 落到代码里的一个子集                                                                  |
| 金样本语料       | [`conformance/corpus/`](conformance/corpus/)                                                             | 每条期望都要能从条款和 fixture 尺寸推导出来, 且说得清理由                                                                                                       |
| 覆盖表           | [`conformance/coverage.md`](conformance/coverage.md)                                                     | 条款和语料的覆盖对照, 加上变异自证结果                                                                                                                          |
| 验收器           | [`../../../scripts/transcription/run-conformance.ts`](../../../scripts/transcription/run-conformance.ts) | 确定性、无 AI 参与、语言无关 (被测命令通过参数传入)                                                                                                             |
| API harness 协议 | [`conformance/api-harness-protocol.md`](conformance/api-harness-protocol.md)                             | API 用例的调用协议 (指令 / 输出 / 探针 / 实现者契约); 参考实现 [`../../../scripts/transcription/api-harness.ts`](../../../scripts/transcription/api-harness.ts) |
| 变异生成器       | [`../../../scripts/transcription/make-mutants.ts`](../../../scripts/transcription/make-mutants.ts)       | 反向验收的自证工具 (语料抓不住的 mutant, 就是语料盲区)                                                                                                          |
| 实施提示词       | [`prompts/`](prompts/)                                                                                   | 给实施者的纪律 (不偏不倚): 你的角色就是实施者; 条款没覆盖到的地方, 停手报缺口; 只许等价, 不许「更优」; conformance 全绿才算完                                   |

## 用本套件转写成另一种语言

1. 通读 [`behavior-contract.md`](behavior-contract.md) 和对应的设计文档 (仓库级 `docs/designs/` 与包级 `docs/`, 行为以它们为准);
2. 按 [`prompts/common-discipline.md`](prompts/common-discipline.md) 和目标语言模板实施 ([`prompts/transcribe-rust.md`](prompts/transcribe-rust.md) 是范例);
   交付物: 条款到代码的映射表、缺口清单、conformance 原始报告;
3. 用验收器考验你的实现 (被测命令就是你的可执行入口, 比如写成绝对路径的 `/path/to/sweep-nm-rs`):

   ```bash
   bun scripts/transcription/run-conformance.ts --target "<你的可执行命令>"
   ```

   如果实现同时提供库, 还有 API 一侧: 按 [API harness 协议](conformance/api-harness-protocol.md) 提供 harness 可执行文件, 用 `--api-target "<你的 harness 命令>"` 一并验收;

   验收全绿, 且快照类用例逐字节一致, 才算等价;

4. 语料抓不住你实现里的哪块, 不代表「没问题」, 那是语料盲区: 对照 [`conformance/coverage.md`](conformance/coverage.md) 里的豁免理由逐条核对。

## 维护规则

- 语料**只增不改已有期望**; 要改期望, 先过「三向定责」(修语料 / 修契约 / 修实现), 并写明依据;
- 新增语料: 文件名就是 `id`; `specRefs` 非空, 且要指向真实存在的条款; 期望要能推导出来, 且说得清理由;
- 重大改动后重跑反向验收: `bun scripts/transcription/make-mutants.ts` 生成 mutant, 逐个过验收器 (预期有失败);
- 体积数字按文件系统块大小计算 (本机是 4096); 换平台重跑前, 要先按那边的块大小重新校准;
- 本套件跟实现一起改: 行为契约的条款变了, 语料和设计文档要跟着同步 (同一件事, 三处保持一致)。
