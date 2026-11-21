# 无 bench 包的基准建设规范

当 `loop.ts status` 或 `next` 发现目标包缺少基准探针或存在 `@perf-loop:stub` 占位时, 必须先通过独立的「基准建设回合」完成搭建并经校验冻结, 再进入自动优化循环。严禁在同一个优化提案里既改业务代码又改基准负载。

## 1. 初始化脚手架

```shell
bun .agents/skills/perf-loop/scripts/loop.ts init-bench --pkg <pkg>
```

若返回 `manifestWarning`, 须同步在 [template-manifest.ts](../../../../packages/create-clis/scripts/template-manifest.ts) 为该包的 `bench/` 登记 `exclude` 条目, 保证 `template-manifest.test.ts` 全仓完备测试绿灯。

## 2. 替换占位骨架的 6 条硬约束

1. **真实核心负载与清理标记**: 替换占位循环为目标包核心热点场景, **完成后必须删除首行 `@perf-loop:stub` 注释**, 否则 `prepare` 阶段会继续硬拦截。
2. **合理标注 `role` (`primary` vs `reference`)**:
   - 线上实际生效的主路径用例标 `role: 'primary'` (参与盈利定级);
   - 仅用于横向对比的历史实现或兜底对照组标 `role: 'reference'` (参与一致性校验但不稀释主路径得分)。
3. **必须产出确定性 `digest`**: 把业务输出摘要 (长度、条数、或相对路径/结果拼接的 SHA-256 前 16 位) 填入 `digest`, 防死代码消除并守住语义底线。注意路径类输出一律转相对路径, 避免临时目录前缀随机导致 `digest` 假不一致。
4. **分档控制耗时 (`--quick` vs `--full`)**: `--quick` 用纯粹合成或隔离临时负载且控制在 `0.3s ~ 3s` 内 (`iterations >= 5`), `--full` 可含长跑压测。
5. **兼容 Bun 与 Node 双运行时**: 禁止使用 `import.meta.dir` 等单端属性, 统一使用 `dirname(fileURLToPath(import.meta.url))` 与 `node:*` 模块, 并遵守 [0003-zero-runtime-deps.md](../../../../packages/sweep/docs/adrs/0003-zero-runtime-deps.md) 与 [.oxlintrc.json](../../../../.oxlintrc.json)。
6. **基准落定双端自证**: 完成后必须依次通过以下全部命令方可冻结 `bench/`:
   - `bun check`
   - `bun x --no-install oxlint packages/<pkg>/bench`
   - `bun packages/<pkg>/bench/run.ts --json --quick`
   - `node packages/<pkg>/bench/run.ts --json --quick`
