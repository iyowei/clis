# @iyowei/sweep

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
![private](https://img.shields.io/badge/npm-private%20workspace%20package-lightgrey)
![node](https://img.shields.io/badge/node-%3E%3D22.18.0-339933)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

通用工作区级多技术栈清理器的可编程 API: 扫描、项目锚定核验、体积核算、三端零依赖回收站与安全删除, 覆盖 Node.js、Rust、Python、Java、C/C++ 构建与缓存产物、系统元数据垃圾文件以及自定义规则, 且全程零第三方运行时依赖。CLI 包 ([`@iyowei/sweep-cli`](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/README.zh-CN.md), 命令 `sweep`) 只是套在这套 API 外面的渲染与交互薄壳。

> **仓内私有演进包声明**: `@iyowei/sweep` 与 `@iyowei/sweep-cli` 当前显式标记 `"private": true`, 在仓内演进打磨阶段不纳入公开 npm 自动发布链 (详见 [ADR 0021](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md))。在仓库内作为 workspace 依赖直接引用。

## 目录

- [运行要求](#运行要求)
- [仓内使用](#仓内使用)
- [快速上手](#快速上手)
- [两级导出面](#两级导出面)
- [编排层](#编排层)
- [内置预设与自定义规则](#内置预设与自定义规则)
- [原语层](#原语层)
- [错误与代码](#错误与代码)
- [进度与取消](#进度与取消)
- [安全模型](#安全模型)
- [数据形态与稳定性](#数据形态与稳定性)
- [开发与文档](#开发与文档)

## 运行要求

- **双运行时**: 有 Bun 优先走 Bun, 否则回退 Node.js (`>= 22.18.0`, 行为一致, Bun 启动更快; 见 [ADR 0006](https://github.com/iyowei/clis/blob/main/docs/adrs/0006-dual-runtime-bun-first.md))。
- **零第三方运行时依赖**: 仅使用 `node:` / `bun:` 运行时内置能力, 含三端回收站通道在内无任何第三方包或预编译二进制 (见 [ADR 0003](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0003-zero-runtime-deps.md) 与 [ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md))。
- **跨平台**: 支持 macOS、Linux 与 Windows (见 [ADR 0007](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0007-platform-portability.md))。实测边界说明: macOS 回收站与 Linux 纯 TypeScript XDG Trash 协议逻辑已在本机实测; Windows 宿主机真机 PowerShell 回收站执行与真实 Linux 桌面集成仅经桩/逻辑测试验证, 尚未在目标宿主机真机实测。
- 源码为 TypeScript, 构建产物含编译后 JS 与 `.d.ts` 类型声明 (`dist/`)。

## 仓内使用

本包位于 monorepo 的 `packages/sweep` 目录 (`"private": true`, 纯库无 `bin`)。在纯 Node.js 环境中导入前先执行构建:

```shell
bun install && bun run build
```

如需交互式命令行工具 (`sweep`), 见 [`@iyowei/sweep-cli`](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/README.zh-CN.md)。

## 快速上手

```ts
import { createSweeper, formatBytes, summarizeReport } from '@iyowei/sweep';

// 编排层不读平台配置文件: 扫什么、启哪些预设与规则由调用方显式传入
const sweeper = createSweeper({
  roots: ['/Users/me/workspace/development'], // 绝对路径
  presets: { node: {}, rust: {}, 'os-junk': {} }, // 键存在即激活
  rules: [
    {
      name: 'stale-logs',
      kind: 'file',
      match: '*.log',
      action: 'trash',
      olderThanDays: 14,
    },
  ],
});

// plan(): 只读面。扫描 + 锚定校验 + 体积 + 类别 + 设备 + 批次构造, 零副作用
const plan = await sweeper.plan();

for (const entry of plan.entries) {
  const size = entry.bytes === undefined ? '?' : formatBytes(entry.bytes);
  const badge = entry.action === 'trash' ? '[TRASH]' : '[DELETE]';
  const note = entry.inBatch ? '' : `  (${entry.skipNote})`;
  console.log(
    `${entry.inBatch ? '*' : '-'} ${badge} ${size.padStart(9)}  ${entry.target}${note}`,
  );
}
console.log(`待清理 ${plan.batch.length} 处`);

// run(): 按此刻磁盘现场重跑判定链, 过安全闸后按目标动作移入回收站或删除
const report = await sweeper.run({
  expectedBatch: plan.batch, // 把执行面锁在上一步刚批准的清单内
  staleTargets: 'missing', // 已被外部删掉的目标计为成功侧而非整批拒绝
});

const summary = summarizeReport(report);
console.log(
  `已删 ${summary.counts.removed} 处, 已移入回收站 ${summary.counts.trashed} 处, 释放 ${formatBytes(report.releasedBytes)}`,
);
```

上手前值得先知道的三件事:

- `roots` 为绝对路径; 执行面 (`run` / `removeBatch` / `removeTargets`) 要求每个根及其祖先链均为**真实路径** (不能含符号链接; macOS 的 `tmpdir()` 经过 `/var`, 用前请先 `await realpath(...)`), 只读面 (`plan` / `scan`) 不受此限。
- 编排层不会读取平台配置文件, 交互式向导留在 `@iyowei/sweep-cli`; 下文导出的配置 v2 装载与无损迁移原语仅供需要复刻同一套行为的宿主调用。
- 本包不向 `stdout` / `stderr` 打印任何内容, 所有给人看的文本都以数据字段返回。

## 两级导出面

| 层                                                                                                  | 是什么                                                                         | 什么时候用                               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| 编排层: `createSweeper(...).plan()` / `.run()`                                                      | 整条链: 扫描锚定 → 体积 → 类别 → 设备 → 批次构造 → 安全闸 → 回收站/删除 → 报告 | 默认选它。声明清理策略并自行消费报告     |
| 原语层: `createScanner` / `createSizer` / `validateTargets` / `removeTargets` / `moveToTrash` / ... | 独立可组合模块 (预设、规则、安全闸、回收站、配置 v2、迁移、净化)               | 逐步控制流程或把单环嵌入你自己的自动化链 |

## 编排层

### `createSweeper(options): Sweeper`

构造编排器, 构造期不做扫描或删除 IO。

- `options` `SweepOptions`:
  - `roots` `string[]` (必填, 非空): 绝对路径扫描根。
  - `exclude?` `string[]`: 任意层级目录名排除列表; 缺省取 `DEFAULT_EXCLUDE` (32 项三端家目录安全护栏)。
  - `include?` `string[]`: 白名单目录名; 缺省 `[]` (不过滤); 与 `exclude` 重叠时 `exclude` 优先。
  - `presets?` `PresetsMap`: 激活的内置预设表 (键存在即激活; 与 `rules` 同时省略时缺省 `{ node: {} }`)。
  - `rules?` `readonly CustomRule[]`: 自定义清理规则; 缺省 `[]`。
  - `excludeExplicit?` `boolean`: 区分默认护栏与用户显式排除 (用于 `java` 预设下项目级 `.gradle` 判定)。
  - `nowMs?` `number`: `olderThanDays` 判定时间基准 (毫秒, 缺省 `Date.now()`, 便于测试注入)。
  - `home?` `string | null`: 家目录 (用于 home 本体防护、`~/.gradle` 保护与隐藏目录形态判定; 缺省 `os.homedir()`, `null` 关闭)。
  - `style?` `PathStyle`: `POSIX_STYLE` / `WIN32_STYLE`; 缺省 `nativeStyle()`。
  - `policy?` `SweepPolicy`: `{ releaseSuspects: boolean }`, 缺省 `{ releaseSuspects: false }`。
  - `trashDeps?` `TrashDeps`: 可注入平台与文件系统依赖 (供三端确定性桩测试)。
- 返回 `Sweeper`:
  - `options` `Readonly<ResolvedSweepOptions>`: 合并缺省并经 `mergeNames` 收口后的只读快照。
  - `plan(options?)` / `run(options?)`: 只读与执行两段入口。

非法参数 (`roots` 为空或含相对/盘根相对路径、空串或非字符串元素、非法 `home`、非布尔 `policy.releaseSuspects`、非法 `presets` / `rules`) 在**构造期同步抛出** `SweepError('INVALID_ARGUMENT', ..., { field })`。

### `sweeper.plan(options?): Promise<SweepPlan>`

只读遍历 + 锚定校验 + 体积核算 + 类别与跨设备判定 + 批次构造, 零副作用。

- `SweepEntry` 携带单目标完整状态:
  - `target`、`project`、`root`
  - `entryKind` (`'dir' | 'file'`)、`action` (`'delete' | 'trash'`)、`source` (`HitSource`: `{ kind: 'preset', name }` 或 `{ kind: 'rule', name }`)
  - `bytes?`、`basis?` (`'disk-usage' | 'logical-bytes'`)
  - `kind` (`'project' | 'suspect-install-tree'`)、`kindReason?`、`crossDevice?` (`'on-path' | 'target-itself'`)
  - `unmeasuredCode?`、`unmeasuredReason?`、`inBatch`、`skipReason?`、`skipNote?`
- `SweepPlan` 返回 `{ roots, exclude, include, policy, basis?, entries, batch, skipped, trailer?, warnings, nameMatches }`。

### `sweeper.run(options?): Promise<SweepReport>`

先按此刻磁盘现场重跑实时计划 (绝不重放旧计划), 若提供 `expectedBatch` 则取交集, 经泛化安全闸复核后按每条目标的生效 `action` 执行移入回收站或永久删除。

- `options?` `SweepRunOptions`: `{ onProgress?, signal?, expectedBatch?, staleTargets?: 'reject' | 'missing' }`。
- `SweepReport`: `{ status, plan, validation?, removal?, entries, stale, releasedBytes, drift? }`。
  - `status` `SweepRunStatus`: `'executed' | 'rejected' | 'nothing-to-do'`。
  - `removal` `RemovalResult`: `{ removed, trashed, missing, failed, aborted? }`。
  - `entries` `SweepOutcomeEntry[]`: `SweepEntry & { outcome: EntryOutcome }`。
  - `EntryOutcome` 取值: `'removed' | 'trashed' | 'missing' | 'stale'` (成功侧)、`'failed'`、`'rejected'`、`'not-attempted'`、`'not-expected'`、`'skipped'`。
  - `releasedBytes`: 成功侧 (`removed` + `trashed` + `missing` + `stale`) 的累计实测字节数。

### `isSuccessOutcome(outcome)` 与 `summarizeReport(report)`

- `isSuccessOutcome(outcome): boolean`: `'removed' | 'trashed' | 'missing' | 'stale'` 返回 `true`, 其余返回 `false`。请优先使用本函数而非手写 `kind` 判断, 确保未来新增结果类型时不静默漏判。
- `summarizeReport(report): SweepSummary`: 返回 `{ counts, succeeded, unprocessed, failed, aborted }`:
  - `succeeded = removed + trashed + missing + stale`
  - `unprocessed = skipped + rejected + not-attempted + not-expected`
  - `failed = counts.failed`
  - `aborted = report.removal?.aborted !== undefined`

## 内置预设与自定义规则

权威决策见 [ADR 0022](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md)。

### 6 大内置预设 (`BUILTIN_PRESETS` / `PRESET_NAMES` / `PRESET_BY_NAME`)

- **键存在即激活** (`PresetsMap = Partial<Record<PresetName, PresetConfig>>`), v2 配置中出现 `enabled` 字段直接报 `CONFIG_CORRUPT_SHAPE`; 默认动作为 `'delete'`, 可通过 `action?: 'trash' | 'delete'` 局部覆盖。
- `node`: `node_modules` 目录, 校验同级 `package.json` 及安装树语义分类 (`classifyTarget`)。
- `rust`: `target` 目录, 校验同级 `Cargo.toml`。
- `python`: `.venv` / `venv` (同级 `pyproject.toml` / `requirements.txt` 或内含 `pyvenv.cfg`), 以及 `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`。
- `java`: Maven `target` (同级 `pom.xml`) 与 Gradle `.gradle` / `build` (同级 `build.gradle*` 或 `settings.gradle*`)。家目录本体 `~/.gradle` 恒受 `DEFAULT_EXCLUDE` 保护; 仅当 `java` 激活且位于真实项目目录下且未被用户显式排除时清理项目级 `.gradle`。
- `cpp`: `build` / `cmake-build-*`, 校验同级 `CMakeLists.txt` 或内含 `CMakeCache.txt`。
- `os-junk`: 仅匹配普通文件 `.DS_Store`、`Thumbs.db`、`ehthumbs.db`、`ehthumbs_vista.db` (`OS_JUNK_FILES`), 严禁匹配 `desktop.ini`、`.directory` 与 `._*`。
- 导出辅助: `createDefaultPresets()`、`isPresetName(value)`、`resolvePresetAction(name, config?)`、`matchesAnyActivePresetLeaf(leaf, presets)`。

### 自定义规则 (`rules`)

- `CustomRuleInput` / `CustomRule`: `{ name, kind: 'file' | 'dir' | 'any', match, action, olderThanDays?, exclude?, include? }`。
- 在配置 v2 装载时, 省略 `action` **强制补为 `'trash'`**。
- `validateRuleMatch(match)` 硬拒绝空串、首尾空白、`.`、`..`、`.git`、`*`、`**`、纯通配符组合 (`*.*` / `.*` / `?` 等)、路径分隔符 (`/` / `\`) 与 ASCII 控制字符。
- 同一真实路径被多条预设或规则同时命中时按保守策略去重: **`'trash'` 永远优先于 `'delete'`**。
- 导出辅助: `MS_PER_DAY`、`validateRuleMatch(match)`、`compileNameMatcher(pattern)`、`compileRules(rules)`、`ruleMatchesKind(ruleKind, kind)`、`isOlderThanDays(mtimeMs, olderThanDays, nowMs?)`、`matchesAnyRuleLeaf(leaf, rules)`。

## 原语层

所有原语导入零副作用, 不向 stdout/stderr 打印。

### 扫描与测体积

- `createScanner(): Scanner` → `scanner.scan(options): Promise<ScanResult>`: 32 路有界并发 `readdir` 遍历, 利用内存同级文件表完成预设锚定校验并支持自定义规则匹配、realpath 去重, 按 `target` 升序产出 `{ project, target, root, entryKind?, action?, source? }`。
- `createSizer(): Sizer` → `sizer.measure(targets, options?): Promise<SizeResult>`: 双轨体积统计 (POSIX 上优先 `du` 快路径报 `'disk-usage'`, 降级与 Windows 恒用纯 JS 报 `'logical-bytes'`)。将全部入参严格划分为互不相交的 `entries`、`unmeasured`、`gone` 三桶。

### 类别、安全闸与设备边界

- `classifyTarget(target, options?): Classification`: 纯路径判定 `'project'` 与 `'suspect-install-tree'`。
- `validateTargets(targets, options): Promise<ValidationResult>`: 执行泛化五不变量校验 (安全叶名 `hasSafeTargetLeaf` / `hasNodeModulesLeaf` / `allowedLeaf`、realpath 存在与可读性、根锚点链无符号链接、非文件系统根与非家目录本体、严格路径包含 `insideAnyRoot`、realpath 去重), 返回 `{ accepted, rejected, mappings }`。
- 纯路径与锚点辅助: `POSIX_STYLE`、`WIN32_STYLE`、`nativeStyle()`、`dedupeKey`、`hasNodeModulesLeaf`、`hasSafeTargetLeaf`、`insideAnyRoot`、`isFilesystemRootBody`、`isHomeBody`、`anchorChainPaths`、`firstSymlinkOnAnchor`、`firstSymlinkOnTarget`、`firstSymlinkOnRoot`。
- 设备边界辅助: `findCrossDeviceTargets(targets, options)`、`crossDeviceIndex(entries)`、`fsDeviceProbe(path, follow)`。

### 删除与三端零依赖回收站 ([ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md))

- `moveToTrash(target, deps?): Promise<TrashOutcome>`: 零第三方依赖的三端回收站通道 —— macOS (`/usr/bin/trash -s`, 缺失时经 `on run argv` 降级 `/usr/bin/osascript`)、Linux (纯 TS Freedesktop XDG Trash 1.0, `wx` 独占占位 `.trashinfo` + `.2`/`.3` 避让 + 原子 `rename`)、Windows (`>= 260` 字符前置拦截 + 只读剥离 + 环境变量传参调用 PowerShell `Microsoft.VisualBasic.FileIO.FileSystem`)。**失败绝不降级 `fs.rm`**, 返回 `{ ok: false, code: 'TRASH_FAILED', ... }` 且磁盘原文件完好不动。
- 回收站常量与辅助: `MACOS_TRASH_BIN`、`MACOS_OSASCRIPT_BIN`、`WIN32_TRASH_MAX_PATH`、`resolveXdgTrashDir`、`encodeXdgTrashPath`、`formatTrashDeletionDate`、`resolveWindowsPowerShell`。
- `removeTargets(targets, options): Promise<RemovalResult>`: 4 路有界并发执行器, 逐条执行前先复核信任根完整祖先链与目标父链 `lstat`; 支持 `actions?: ReadonlyMap<string, CleanupAction>`、`allowGeneralTargets`、`trashDeps`, 返回 `{ removed, trashed, missing, failed, aborted? }`。
- `toTrustRoots(roots)` 与 `removeBatch(targets, options): Promise<BatchOutcome>`: 推荐写侧原语, 一次串联 `validateTargets` + 整批拒绝 + `toTrustRoots` + `removeTargets`。

### 跳过集册

- `toSkipCandidates(hits, size, options?)`、`skipsBatch(entry, crossDevice, policy)`、`skipReasonOf(entry, crossDevice, policy)`、`deletionBatch(entries, crossDevice, policy)`、`collectSkips(entries, crossDevice, policy)`、`crossDeviceNote(kind)`。

### 配置 v2 与无损迁移 (可选原语)

- 常量: `CONFIG_VERSION` (`2`)、`CONFIG_ENV_VAR` (`'SWEEP_CONFIG'`)、`DEFAULT_EXCLUDE` (32 项三端家目录默认安全护栏)。
- 定位与装载: `resolveConfigPath(options?)` (`--config` > `SWEEP_CONFIG` > `~/.config/sweep/config.json` 或 `%APPDATA%\sweep\config.json`)、`resolveLegacyConfigPath(options?)` (`sweep-node-modules/config.json`, 仅供自动迁移探测)、`resolveDefaultRoot(home?)`、`createDefaultConfig(options?)`、`loadConfig(path, options?)`、`loadResolvedConfig(resolved, options?)`、`mergeNames(configNames, cliNames)`。
- 迁移原语: `detectMigration(resolved, options?)`、`convertV1ToV2(raw, homedir?)`、`applyMigration(plan, options?)` (写盘前强制在源目录创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份; v1 严格等价映射为 `presets: { node: {} }`)、`buildMigrationBackupPath(sourcePath, date?)`、`formatBackupTimestamp(date?)`、`NEW_PRESET_HINTS`。

### 展示辅助

- `formatBytes(bytes): string`: 人类可读体积格式化 (`B` / `KB` / `MB` / `GB` / `TB`)。
- `sanitizeLine(text): string` 与 `sanitizeOutputLine(text): string`: 单源输出净化管线, 剥除控制字符、双向控制符与零宽字符并折叠换行。

## 错误与代码

**通道分界**: 能按目标逐条列出的域结果走返回值; 无法开始或无法继续的异常 (参数错误、配置损坏/待迁移/迁移失败、取消) 抛 `SweepError`。

- `SweepError<Code>`: `{ name: 'SweepError', code, message, details? }` — 包内导出的唯一类。
- `isSweepError(value)` 与 `isSweepErrorCode(value, code)`: 跨实例安全守卫, 按 `code` 精确收窄 `details`。
- `SweepErrorCode`: `CONFIG_READ_FAILED` · `CONFIG_CORRUPT_JSON` · `CONFIG_CORRUPT_SHAPE` · `CONFIG_ABSENT` · `CONFIG_NEEDS_MIGRATION` · `CONFIG_MIGRATION_FAILED` · `INVALID_ARGUMENT` · `CANCELLED`。

```text
安全闸 (validateTargets → rejected[].code)
  GUARD_LEAF_NOT_NODE_MODULES · GUARD_INVALID_LEAF · GUARD_TARGET_MISSING ·
  GUARD_TARGET_UNREADABLE · GUARD_REALPATH_FAILED · GUARD_ROOT_ANCHOR_SYMLINK ·
  GUARD_FILESYSTEM_ROOT_BODY · GUARD_HOME_BODY · GUARD_REAL_LEAF_NOT_NODE_MODULES ·
  GUARD_OUTSIDE_ROOTS · GUARD_DUPLICATE_TARGET

删除与回收站失败 (RemovalResult.failed[].code)
  REMOVE_FAILED · REMOVE_ENOENT_SURVIVOR · TRASH_FAILED · REVIEW_UNVERIFIED ·
  REVIEW_COMPONENT_VANISHED

整批中止 (RemovalResult.aborted.code)
  REVIEW_NOT_UNDER_ANY_ROOT · REVIEW_HEAD_SYMLINK · REVIEW_COMPONENT_REPLACED

体积未测到 (SizeResult.unmeasured[].code)
  SIZE_UNMEASURED_PERMISSION · SIZE_UNMEASURED_NOT_DIR · SIZE_UNMEASURED_LOOP ·
  SIZE_UNMEASURED_UNPARSEABLE · SIZE_UNMEASURED_CONTROL_CHAR · SIZE_UNMEASURED_OTHER

告警 (SweepWarning.code)
  SCAN_ROOT_MISSING · SCAN_ROOT_UNREADABLE · SCAN_ROOT_NOT_DIR · SCAN_ROOT_UNAVAILABLE ·
  SCAN_DIR_UNREADABLE · SIZE_DU_OUTPUT_MISMATCH · SIZE_DU_LINE_UNATTRIBUTED ·
  SIZE_SUBPATH_FAILED · SIZE_TARGET_VANISHED · SIZE_DU_UNAVAILABLE

跳过原因 (SweepEntry.skipReason / SkippedTarget.reason)
  suspect-install-tree · cross-device:on-path · cross-device:target-itself · unmeasured
```

程序分支一律看 `code` 与 `details`, 严禁解析 `message` (人话中文文案); `code` 一经引入即冻结, `switch` 语句务必保留 `default` 分支。

## 进度与取消

`onProgress` 与 `signal` 可传入 `plan` / `run` 及各支持的原语 (`scan`、`measure`、`validateTargets`、`removeTargets`、`removeBatch`)。

- 事件覆盖 `phase` (`scan` · `measure` · `classify` · `device` · `plan` · `validate` · `remove`)、原语事件 (`hit` · `measured` · `unmeasured` · `skipped` · `removed` 携带 `outcome: 'removed' | 'trashed' | 'missing'` · `failed` · `aborted` · `warning`) 与终结事件 (`plan-done` / `done`)。
- 回调同步触发、不被 await, 回调抛错会直接中止当前调用。
- 取消检查落在条目与阶段边界, 抛 `SweepError('CANCELLED')`; 删除阶段绝不中断单条 `rm`, 取消时经 `details.partial` 返回已完成部分结果。

## 安全模型

> 本包的性格, 一句话: 看不准的时候, 默认不删。

- **导入零动作, `plan()` 零磁盘副作用**: 仅显式调用 `run()` / `removeTargets()` / `removeBatch()` / `moveToTrash()` 才触碰磁盘写侧。
- **强制项目锚定与自定义规则安全词表**: 内置预设对通用名 (`target`/`build`/`venv`/`node_modules`) 强制校验项目锚点; 自定义规则默认 `'trash'` 且硬拒高危通配; 多源冲突 `'trash'` 优先于 `'delete'`。
- **回收站失败绝不降级永久删除**: `moveToTrash` 失败时原文件 100% 保持不动 (`TRASH_FAILED`, `partialRisk: false`)。
- **执行侧真实路径、整批拒绝与逐级复核**: 根锚点链含符号链接或任一目标被安全闸拒绝即整批零清理; 执行前逐条对信任根与目标父链执行 `lstat` 复核防中途替换。
- **三类保守跳过**: 疑似安装树 (仅 `policy.releaseSuspects` 放行)、跨设备目标 (策略不放行)、体积未测到目标默认均不进清理批。

## 数据形态与稳定性

- 所有落盘/审计域对象 (`SweepPlan`、`SweepReport`、`ScanResult`、`SizeResult`、`ValidationResult`、`RemovalResult`、`CrossDeviceEntry[]`) 均为无损可 `JSON.stringify` 的普通对象与数组且不含时间戳 (仅进度事件含 `elapsedMs`); 查询辅助 (`SkipBook.hints`、`crossDeviceIndex()`) 返回 `ReadonlyMap`。
- 结果确定有序: `hits` 与体积三桶按 `target` 升序, 删除分桶与 `stale` 保输入序; 进度事件顺序不作承诺。

| 分级                   | 内容                                                                                    | 承诺                       |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| 冻结                   | 域类型字段名、`code` 取值、`SkipReason` 取值、函数签名、`EntryOutcome` 的 kind 取值     | 破坏性改动须走主版本       |
| 冻结但允许新增可选字段 | 选项对象 (`SweepOptions`、`SweepRunOptions`、`MeasureOptions`、`RemoveBatchOptions` 等) | 新增可选字段走 minor       |
| 允许演化               | `message` / `reason` / `note` 中文措辞                                                  | 不承诺逐字稳定             |
| 不承诺                 | 进度事件顺序、`warnings` 内部次序                                                       | 结果序有承诺, 事件序无承诺 |

## 开发与文档

- [开发指南](https://github.com/iyowei/clis/blob/main/docs/development.md) (源码目录: `packages/sweep`)
- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [产品文档与包级 ADR (`0001..0004`、`0007..0008`、`0021..0024`)](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/README.md)
- [可编程 API 面设计](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/designs/api-surface.md)
- [安全防护保障](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/designs/safety-guardrails.md)
- [CLI 包 (`@iyowei/sweep-cli`)](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/README.zh-CN.md)
