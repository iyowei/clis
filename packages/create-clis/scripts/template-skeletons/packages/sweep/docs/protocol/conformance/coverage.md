# 覆盖表与变异自证 (示例骨架)

> **派生声明**: 本表由 `corpus/*.json` 机械汇总对齐, 由 `bun scripts/transcription/validate-coverage.ts` 执行深度对账。

## 一、条款 × 语料覆盖

| 条款  | 用例数 | 覆盖用例                        |
| ----- | ------ | ------------------------------- |
| BC-01 | 2      | api-greet-basic, cli-greet-basic |
| OF-01 | 1      | cli-version-basic               |

## 二、未覆盖条款与子面豁免

| 条款 | 状态 | 理由与替代护栏 |
| ---- | ---- | -------------- |

## 三、变异自证 (CLI / API 三态矩阵)

经 `bun scripts/transcription/make-mutants.ts` 从包级 `conformance/mutants.json` 驱动生成独立副本并注入单点缺陷; 锚点唯一性由 `lint:mutants` 纳入 CI 门禁。

| mutant (注入缺陷)                      | 预期面 | 锚点文件   |
| -------------------------------------- | ------ | ---------- |
| greet-wrong-prefix (问候语前缀被篡改) | both   | `index.ts` |
