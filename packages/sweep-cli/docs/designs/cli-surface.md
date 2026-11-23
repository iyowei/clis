# 命令面与输出

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-23 (2026-11-20 演进为 `sweep` 多技术栈命令面)
> **决策者**: 沈委
> **父文档**: [设计总纲](../../../sweep/docs/designs/sweep-design.md)

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | 从总纲拆分独立成篇; 确立紧凑式 + 色块视觉规范与降级语义                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-09-24 | 新增 `config` 子命令与 `--force` 旗标; 重新标定体积档位阈值 (大 ≥ 512 MiB / 中 ≥ 100 MiB); 登记疑似安装树展示形态                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-09-25 | 输出净化全量收口至 OF-14 单源管线; 向导补配置路径锚点检查失败文案                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-09-27 | 登记跨设备行的两种形态与末行说明 (BC-41 / OF-15)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-11-19 | 新增 `update` 自更新子命令 (`@iyowei/cli-updater`)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-11-20 | 重构 `--help` 独立分层布局 (80 列防截断); 新增 `stderr` TTY 实时进度指示器 (`src/progress.ts`); 升级 `update` 子命令异步捕获与 Spinner 体验                                                                                                                                                                                                                                                                                                                                           |
| 2026-11-20 | 依 [ADR 0021](../../../sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md) ~ [ADR 0024](../../../sweep/docs/adrs/0024-cli-init-migrate-and-summary-display.md) 演进为通用清理命令 `sweep` (`@iyowei/sweep-cli`, 当前 `"private": true`): 新增 `init --default` 与 `migrate` 子命令、无配置非 TTY 硬报错拒盲扫、`init`/`migrate` 落盘改用 `▍ SWEEP` 模板化结构摘要 (标注 `[TRASH]`/`[DELETE]`, 严禁吐原始 JSON 全文)、预览与执行清单标注 `[TRASH]` 并在执行汇总统计回收站分桶计数 |

## 命令面

```text
sweep                       预览: 扫描配置根下的目标、体积与生效动作, 零副作用
sweep --yes                 执行清理 (按配置走系统回收站或永久删除)
sweep --force               连同疑似安装树一并纳入清理批 (需配 --yes 执行, 单独使用仍只预览)
sweep --exclude <名字>      临时追加排除目录名, 可重复 (与配置合并)
sweep --include <名字>      仅清理命中白名单目录名的项目, 可重复 (与配置合并)
sweep --config <路径>       指定配置文件路径 (优先于 SWEEP_CONFIG)
sweep init                  初始化向导: 交互式生成 v2 配置文件 (TTY 专属)
sweep init --default        一键生成包含完整最佳实践的默认 v2 配置 (含覆盖与锚点保护)
sweep migrate               无损迁移旧版 v1 配置到 v2 (写前自动备份原配置)
sweep config                查看实际生效的配置: 来源 + 路径 + 文件状态 (恒退 0)
sweep update                自更新: 自动识别安装器升级到最新版 (--check 仅检查)
sweep --version / -V        显示版本号
sweep --help / -h           显示帮助
```

- **包名与唯一命令** ([ADR 0021](../../../sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md)): 集合仓 `iyowei/clis`; CLI 包名 `@iyowei/sweep-cli` (对应 API 主包 `@iyowei/sweep`), 唯一可执行命令为 `sweep`。两包当前标记 `"private": true`, 在仓内演进打磨, 不在公开 npm 发布链。
- **子命令互斥校验 (`args.ts`)**: `--default` 仅允许配合 `init` 使用; `init` / `migrate` / `config` 拒绝混用 `--yes` / `--force` / `--exclude` / `--include`; `update` 必须位于参数首位并把后续参数透传给 `@iyowei/cli-updater`; 重复 `--config` 一律报错。
- **`--force` 边界**: 仅放行「疑似安装树」进入清理批 (见 [删除安全闸](../../../sweep/docs/designs/deletion-guard.md)「语义闸」), 绝不放宽安全闸五不变量, 也不放行跨设备目标或未测到体积的目标。
- **`config` 子命令 vs `--config` 旗标**: `sweep config` 报告当前生效来源 (`--config 指定` / `环境变量 SWEEP_CONFIG` / `平台默认`)、完整路径与存在状态 (恒退 0, 不存在算报告事实); 帮助页的「默认配置」行仅展示平台默认路径并提示覆盖用户运行 `sweep config`。
- 完整配置 v2 规则、初始化与无损迁移细节见 [ADR 0022](../../../sweep/docs/adrs/0022-config-v2-presets-and-rules.md)、[ADR 0024](../../../sweep/docs/adrs/0024-cli-init-migrate-and-summary-display.md) 与 [配置与初始化](../../../sweep/docs/designs/config-and-initialization.md)。

## 退出码

| 码  | 含义                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0   | 成功 (预览、空结果、`init`、`migrate`、`config`、`update`、`--help` / `-h`、`--version` / `-V`)                                   |
| 1   | 任一失败 (删除或回收站失败 / 整批中止 / 安全闸整批拒绝 / 存在跳过或未尝试目标 / 无配置非 TTY / 配置损坏或无法无损迁移 / 参数错误) |

## 输出规格 (视觉规范: 紧凑式 + 色块)

设计语言: 少线多色块、紧凑排版, 零依赖手写标准 ANSI SGR。清单、`config`、`init` / `migrate` 摘要与 `--help` 共享同一套 `▍ SWEEP` 反色标识与标准 SGR 主题色 (`1;7` 反色加粗、`2` 压暗、`1` 加粗、`36` 青 / `32` 绿 / `33` 黄 / `31` 红, 零硬编码 RGB, 自动融入终端主题)。着色开关由 `cli.ts` 按 TTY、`NO_COLOR`、`TERM=dumb` 统一判定并分流至 stdout / stderr。

### 1. 清单 (预览 / 执行)

```text
▍ SWEEP  预览 · 2 个根: ~/dev · ~/lab · bun 1.4.5
  ░ 排除生效: legacy-demo (2 处)
  █ 4.6 GB  acme-web         ~/dev/acme-web
  ▓ 366 MB  data-pipeline    ~/dev/data-pipeline
  ▒  86 MB  docs-site        ~/lab/docs-site
  █ 合计 3 处 · 5 GB   加 --yes 执行删除
```

> **提示语契约注记**: 预览末行固定文案 `加 --yes 执行删除` 为 [行为契约](../../../sweep/docs/protocol/behavior-contract.md) OF-08 冻结字节契约, 实际执行时仍严格按每条命中的策略 (`trash` 移入回收站或 `delete` 永久删除) 分流。

- **顶栏**: 反色 `▍ SWEEP` + 模式 (预览 / 执行) + 根数 (≤ 3 时列出缩写根路径) + 运行时自述 (如 `bun 1.4.5`, 仅真终端展示, 非 TTY 隐藏)。
- **中性提示行 (`░`, 仅真终端)**: 展示名单命中回执等上下文说明; 名单拼写未命中告警走 stderr 并在顶栏之前呈现以示强调。
- **清单条目与动作辨识**: 按体积降序排列, 每行含体积档位色块 + 右对齐体积 + 目标/项目名 + 路径 (按 CJK 双宽显示宽度对齐); 动作按生效策略区分 (`trash` 与 `delete`), 执行模式逐行以 `✓` / `✗` 报告永久删除、移入回收站或失败原因, 汇总行如实统计释放体积与各分桶计数。
- **保守跳过行与末行说明**:
  - 疑似安装树行: 保留 `node_modules` 末段, 行尾标注 `疑似安装树: <理由>`; 执行模式注 `已跳过 (加 --force 一并清理)`; 末行补中性说明 (`疑似安装树 N 处默认跳过 (加 --force 一并清理)`), 非 TTY 同样输出。
  - 跨设备行: 行尾标注 `跨设备: 根与目标之间有挂载点` 或 `跨设备: 目标本体即挂载点`, 末行按形态补对应解除指引 (非 TTY 同样输出)。
  - 未测到体积行: 保留为占位行 (`?` + 中性色块 + `体积统计失败: <原因>`), 不计入体积合计且绝不进清理批, 执行态计失败。
- **单源净化 (OF-14)**: 所有磁盘路径、项目/目标名、自定义规则名、命令参数与错误原文进入 stdout / stderr 前均统一经 `@iyowei/sweep` 的 `sanitizeLine` / `sanitizeOutputLine` 净化; 名称被净化改写时行尾附「名字已净化显示」; 详规见 [行为契约](../../../sweep/docs/protocol/behavior-contract.md) OF-14。
- **实时进度指示器 (`src/progress.ts`)**: 扫描 / 体积 / 安全复核 / 清理阶段在 `stderr` 实时刷新阶段、命中数与耗时, 告警插队前自动擦除、结束后零残影; 非 TTY / `TERM=dumb` 完全静默。

### 2. 体积档位与阈值

| 档位 | 阈值      | 色块     |
| ---- | --------- | -------- |
| 大   | ≥ 512 MiB | `█` (红) |
| 中   | ≥ 100 MiB | `▓` (黄) |
| 小   | < 100 MiB | `▒` (青) |

阈值基于真实工作区分布标定 (512 MiB 使红块保持稀有醒目), 保留后续按样本重标定空间。

### 3. `config` 子命令

```text
▍ SWEEP  配置 · 来源: --config 指定
  ░ 配置路径: /path/to/custom-config.json
  ░ 文件状态: 存在
```

- 来源三档标签: `--config 指定`、`环境变量 SWEEP_CONFIG`、`平台默认`;
- 路径照实展示不做家目录缩写 (经 OF-14 净化), 退出码恒为 `0` (BC-35)。

### 4. `init` / `init --default` / `migrate` 与模板化配置摘要

依据 [ADR 0024](../../../sweep/docs/adrs/0024-cli-init-migrate-and-summary-display.md), `init`、`init --default`、`migrate` 写盘后**严禁在终端打印原始 JSON 全文**, 统一由 `packages/sweep-cli/src/config-summary.ts` 的 `renderConfigSummary` 渲染结构化摘要:

```text
▍ SWEEP  初始化配置
  配置已写入: ~/.config/sweep/config.json  ✓
  ░ 扫描根 (1 个): ~
  ░ 激活预设 (6 项): node [DELETE] · rust [DELETE] · python [DELETE] · java [DELETE] · cpp [DELETE] · os-junk [DELETE]
  ░ 自定义规则: 0 条
  ░ 全局排除: 32 条 (内置安全护栏)
  ░ 快捷指令:
    查看生效配置  sweep config
    查看原始配置  cat ~/.config/sweep/config.json
    手动编辑配置  ${EDITOR:-vi} ~/.config/sweep/config.json
    图形界面编辑  open -e ~/.config/sweep/config.json
  ░ 运行 sweep 查看预览
```

- **迁移场景补充行**: `migrate` 落盘后额外输出 `原配置已备份: <backupPath>` (家目录缩写 + OF-14 净化) 与中性提示 `新增可用预设: rust · python · java · cpp · os-junk (可手动编辑配置按需启用)`, 绝不替用户自动开启新预设;
- **规则动作与保留期**: 自定义规则存在时逐条展示 `<name> [TRASH]` / `[DELETE]` 及可选 `· > N 天`;
- **平台快捷指令**:
  - POSIX (Linux): `sweep config` / `cat <quoted>` / `${EDITOR:-vi} <quoted>`;
  - macOS (`darwin`): 在 POSIX 基础上附加 `open -e <quoted>`;
  - Windows (`win32`): `sweep config` / `Get-Content "<escaped>"` / `notepad "<escaped>"`;
- **校验失败与取消态**: 双阶段配置路径锚点检查 (BC-40) 与逐根校验失败行以红色 `✗` 置行首; 取消/拒绝分支保持无色块中性终态 (`已取消, 未写入配置` / `已取消, 未迁移配置` / `配置未变更`)。
- **非 TTY 保护**: 无配置且非 TTY 时拒绝盲扫并报错退出码 `1`; 非 TTY 触发 `migrate` 且判定 100% 无损时, 主清理流程输出 `[info]` 日志继续, 显式 `sweep migrate` 输出无色结构化摘要并退 `0`; 非无损或结构损坏则报错退 `1`。

### 5. 降级

- 非 TTY / `NO_COLOR` / `TERM=dumb` → 纯文本 (空格对齐, 零 ANSI), `▍` / `░` / 档位块字符与行结构逐字保留 (仅剥离 SGR 色码);
- 仅真终端专属元素 (清单顶栏运行时自述与名单回执、`stderr` 实时进度指示器、`init` 交互问答) 在非 TTY 下不以降级形式混入输出 (见 [ADR 0007](../../../sweep/docs/adrs/0007-platform-portability.md)、[行为契约](../../../sweep/docs/protocol/behavior-contract.md) 与 [覆盖表](../../../sweep/docs/protocol/conformance/coverage.md))。
