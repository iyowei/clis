# 金样本语料 (corpus)

> 状态: 金样本条数、bun / node 双载体全绿情况, 以验收器实时输出为准; 变异自证结果, 以变异生成器实时输出为准
> (覆盖与自证结果详见 [`../coverage.md`](../coverage.md))。

## 写用例的约定

- 一个文件一条用例, 文件名必须为 `<id>.json` (与用例的 `id` 字段一致); 字段语义见
  [`../corpus.schema.json`](../corpus.schema.json)。三条设计原则: fixture 声明式 / env 白名单 / expect 断言族 (按用例取舍)。
- 每条 `specRefs` 非空且指向 `../../behavior-contract.md` 契约里的真实条款 (形如 `BC-03` / `OF-01` / `EC-02`);
  期望必须能从条款原文 + fixture 尺寸推导出来, **严禁把「跑一遍记下来」当作期望** (忠于规则不忠于实现)。
- 字符串字段内用 `$FIXTURE` 引用 fixture 根 (realpath 形态绝对路径), 例: `"SWEEP_NM_CONFIG": "$FIXTURE/config.json"`。
  验收器会把被测进程的 `HOME` 指向 `$FIXTURE/home`:
  - 想让路径在清单里显示为 `~` 前缀, 把项目放进 `$FIXTURE/home/` 下 (见 `render-path-tilde`);
  - 其余位置 (如 `$FIXTURE/zone/a`) 不会被缩写, 期望文本里可以直接写 `$FIXTURE`。
- 非 TTY 路径下, 输出 100% 逐字节确定: 格式类用例首选 `stdoutExact` (体积数字按 du 块口径推演);
  行为类用例可用 `stdoutContains` + `stdoutMustNotContain` 组合, 少受环境差异影响。
- 要抓的缺陷表现为「多出一条 stderr 告警」时 (即正确行为下不该出这条告警), 单靠正向断言抓不住,
  必须配 `stderrMustNotContain`; 语料 `scan-include-exclude-priority` 与
  `scan-node-modules-and-git-in-lists-noop` 即此形态。
- 体积数字依赖文件系统块大小 (本机 APFS 块大小 4096 字节: 文件向上取整、目录不计); **跨平台重跑必须按块口径重新校准**,
  已登记为已知风险。
- 空语料 (一个 `.json` 用例都没有) 不算「全绿」: 验收器直接报错退出 (runner 级错误, 退出码 2), 不假绿。
- api 用例 (`kind: "api"`) 的字段 (`steps` / `expect.result | error | events`) 见 [`../corpus.schema.json`](../corpus.schema.json) 与 [API harness 协议](../api-harness-protocol.md); `--api-target` 不指定时, 默认用套件自带的参考 harness。

## 运行

在仓库根目录执行:

```bash
bun scripts/transcription/run-conformance.ts --target "bun packages/sweep-node-modules-cli/src/cli.ts"                  # bun 载体全量
bun scripts/transcription/run-conformance.ts --target "node packages/sweep-node-modules-cli/src/cli.ts"                 # node 载体全量
bun scripts/transcription/run-conformance.ts --target "bun packages/sweep-node-modules-cli/src/cli.ts" --filter scan-   # 按 id 子串筛选
bun scripts/transcription/run-conformance.ts --target "bun packages/sweep-node-modules-cli/src/cli.ts" --api-target "bun scripts/transcription/api-harness.ts"   # 双面全量 (cli + api; api 用例经 harness 验收)
bun scripts/transcription/run-conformance.ts --target "bun scripts/transcription/mutants/gen-<id>/packages/sweep-node-modules-cli/src/cli.ts"   # 变异自证 (预期有失败)
bun scripts/transcription/run-conformance.ts --target "bun packages/sweep-node-modules-cli/src/cli.ts" --api-target "bun scripts/transcription/mutants/gen-<id>/scripts/transcription/api-harness.ts" --filter api-   # 变异自证 · api 面 (预期有失败)
```
