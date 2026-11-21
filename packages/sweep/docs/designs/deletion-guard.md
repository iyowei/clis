# 删除安全闸

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-23 (2026-11-20 演进升级: 泛化安全闸与零依赖三端回收站)
> **决策者**: 沈委
> **父文档**: [设计总纲](sweep-design.md)

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | 从总纲拆分而立; 补齐组件级复核、整批中止、ENOENT 分阶段判定与残余风险量化登记                                                                                                                                                                                                                                                                         |
| 2026-09-24 | 新增语义闸 (疑似安装树默认不进删除批, `--force` 放行) 与第五道不变量 (根锚点链逐级真目录 + 删除层链头判定, ANCHOR-REANCHOR)                                                                                                                                                                                                                           |
| 2026-09-25 | 写入侧配置路径锚点检查共用同一实现 (`firstSymlinkOnTarget`, BC-40)                                                                                                                                                                                                                                                                                    |
| 2026-09-27 | 新增设备边界闸 (`BC-41` / `OF-15`) 与 rm 阶段 ENOENT 本体复核 (`EC-07`)                                                                                                                                                                                                                                                                               |
| 2026-11-20 | 依 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md) ~ [ADR 0023](../adrs/0023-zero-dep-cross-platform-trash.md) 泛化不变量 ① 以支持多预设锚定目标与自定义规则 (`hasSafeTargetLeaf` / `GUARD_INVALID_LEAF` / `allowedLeaf`), 并引入零依赖三端回收站通道 (`moveToTrash` / `RemovalResult.trashed` / `TRASH_FAILED` 失败严禁降级永久删除铁律) |

## 校验不变量

任一清理目标 (无论最终执行永久删除还是移入系统回收站) 在进入执行面之前, 必须同时满足以下五道不变量, 任一不满足即**整批拒绝、零清理** (保守优先):

1. **末段合法性**:
   - **默认严格 `node_modules` 模式** (直接调用 `validateTargets` 且未显式启用泛化开关): 原始输入与 realpath 两侧末段均须恰好为 `node_modules` (`hasNodeModulesLeaf`, 违约报 `GUARD_LEAF_NOT_NODE_MODULES` / `GUARD_REAL_LEAF_NOT_NODE_MODULES`);
   - **泛化多预设 / 自定义规则模式** (`allowGeneralTargets: true` 或提供 `allowedLeaf`, 编排层 `createSweeper` 按激活预设与规则自动装配): 对原始输入与 realpath 两侧执行 `hasSafeTargetLeaf` 硬拒绝空串、尾分隔符 (`/` 或 `\`)、`.`、`..`、`.git`、`*` 与文件系统根 (`GUARD_INVALID_LEAF`), 并可按 `allowedLeaf` (`matchesAnyActivePresetLeaf` / `matchesAnyRuleLeaf`) 校验末段属于本次激活预设或规则允许的形态;
2. **严格归属声明根**: realpath 之后必须严格位于某个声明 `roots` 之下 (`insideAnyRoot`, 按 `path.relative` 语义判定, 禁止字符串前缀比较; win32 折叠大小写);
3. **禁止系统根与家目录本体**: realpath 不能是文件系统根本体 (`/` 或 Windows 盘根, `isFilesystemRootBody`), 也不能是家目录本体 (`isHomeBody`);
4. **realpath 去重**: 按 `dedupeKey` (realpath + win32 大小写折叠) 去重后不得存在重复目标 (`GUARD_DUPLICATE_TARGET`);
5. **根锚点链**: 配置里的根 (按原始拼写) 及其祖先链 (自文件系统根下一级子目录起至根自身, 文件系统根不入链), 逐级均须经 `lstat` 确认是真目录; 任一级是符号链接 (含 macOS 系统链接 `/tmp`、`/var` 与悬空链接) → 该根下目标一律拒收并给出真实路径改写指引 (`GUARD_ROOT_ANCHOR_SYMLINK`)。同一套实现 (`firstSymlinkOnTarget`) 亦用于 `init` 与 `migrate` 写盘前的目标与备份路径锚点检查 (BC-40)。

**为何第 5 条判在拼写而非 realpath**: `realpath(root)` 只报告此刻的解析结果, 无法反映「配置拼写 → 真实目录」的映射是否已被掉包; 若攻击者离线把根移走并原地换上符号链接, `insideAnyRoot` 与复核链两侧同时漂移而恒为真。拼写形态是唯一能识破根锚点替换的证据。

**与 BC-11 的分工**: 扫描侧「根自身为符号链接照常跟进」仅适用于只读预览; 执行侧 (`--yes` / `run`) 门槛随可逆性收紧, 同一配置下预览有清单、执行整批拒绝属预期行为。

## 语义闸: 疑似安装树默认不进清理批

`classifyTarget` (`packages/sweep/src/classify.ts`, 纯路径判定, 零 IO, 不区分大小写, 独立于用户配置 `exclude`) 针对 `node_modules` 类目标守住「删后能否项目级重装恢复」的边界, 三级短路判定:

1. 目标上方任一级目录名命中安装树容器名 (内置排除集合 ∪ `extensions` / `_npx`);
2. `node_modules` 的父目录名为 `lib` (版本管理器 `<版本目录>/lib/node_modules`);
3. `node_modules` 位于家目录下的隐藏目录内 (兜住未枚举的应用私有安装树)。

- **默认行为**: 判为 `suspect-install-tree` 的目标默认不进清理批, 预览保留 `node_modules` 末段并标注理由, 执行模式按跳过/未处理呈报 (`退出码 1`), 与「清理失败」严格区分;
- **放行边界**: `--force` (`policy.releaseSuspects: true`) 仅放行疑似安装树进入清理批, 绝不放宽五不变量, 也不放行跨设备或未测体积目标;
- **保守代价**: 名为 `lib` / `extensions` 的子包或家目录点目录中的项目可能被保守标为疑似, 需显式加 `--force`。

## 设备边界: 跨设备目标默认不进清理批

`findCrossDeviceTargets` (`packages/sweep/src/guard.ts` + `guard-device.ts`) 逐条比对目标 (`lstat` 语义) 与其最具体所属根 (`insideAnyRoot` 最内层根, `stat` 语义) 的 `st_dev`:

- **`on-path`** (挂载点夹在根与目标之间): 默认逐条跳过; 解除路径是将该挂载点声明为独立 `roots` 项;
- **`target-itself`** (目标本体即挂载点): 默认逐条跳过; 声明根无效, 须先卸载对应卷;
- **逐条跳过而非整批拒绝**: 挂载点是单目标局部事实, 不影响同根下其他合法目标; 不受 `--force` 放行 (设备边界属授权范围而非可重装语义)。

## 零依赖三端回收站通道 (`trash`) 与不降级铁律

依据 [ADR 0023](../adrs/0023-zero-dep-cross-platform-trash.md), 自定义规则默认 `action: "trash"`, 预设亦可覆写 `action: "trash"`; `packages/sweep/src/trash.ts` 提供零第三方依赖、零预编译二进制的三端实现:

| 平台            | 执行通道                                                                                                                                         | 安全与防注入约束                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS `darwin`  | 优先绝对路径 `/usr/bin/trash -s <path>`; 缺失时降级 `/usr/bin/osascript` 通知 Finder                                                             | 不查 `PATH`; `osascript` 严格用 `on run argv` + `POSIX file (item 1 of argv)` 传参, 严禁字符串插值                                                      |
| Linux `linux`   | 纯 TypeScript 实现 Freedesktop XDG Trash 1.0 (`$XDG_DATA_HOME/Trash`, 缺省 `~/.local/share/Trash`)                                               | `flag: 'wx'` 独占创建 `info/<name>.trashinfo` (冲突按 `.2`/`.3` 递增), 原子 `rename` 至 `files/`; 遇 `EXDEV` 或失败立即删空占位并报错, 绝不跨盘复制再删 |
| Windows `win32` | 绝对路径 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive` 调用 `Microsoft.VisualBasic.FileIO.FileSystem` | **前置拦截长度 `>= 260` 字符路径** (`WIN32_TRASH_MAX_PATH`); 递归剥离只读位 (不跟随软链); 通过环境变量 `$env:SWEEP_TRASH_TARGET` 传参防脚本注入         |

- **绝对红线 (失败绝不降级永久删除)**: 任一平台回收站通道失败、命令缺失、路径超限、跨文件系统 `EXDEV` 或抛异常时, `moveToTrash` 返回 `{ ok: false, code: 'TRASH_FAILED', ... }`, `removeTargets` 将其记入 `RemovalResult.failed` (`code: 'TRASH_FAILED'`, `partialRisk: false`), **磁盘原文件 100% 保持不动, 严禁在任何 catch / 降级分支调用 `fs.rm`**; CLI 返回退出码 `1`。
- **纵深安全前置**: `action === 'trash'` 同样完整经过安全闸五不变量、完整根祖先链复核与目标父链逐级 `lstat` 复核。

## 执行语义

- 清理动作仅在 `--yes` (CLI) 或 `run()` / `removeBatch()` / `removeTargets()` (API) 下发生 (默认仅预览, 见 [命令面与输出](../../../sweep-cli/docs/designs/cli-surface.md));
- **入口形态校验与完整根祖先链复核 (`delete-review.ts`)**: 每条执行前同步拦截尾分隔符、相对段 `.` / `..`、非法末段 (或非泛化模式下的非 `node_modules` 末段) 以及不在任何 `roots[].real` 之下的目标 → **整批中止** (`REVIEW_NOT_UNDER_ANY_ROOT`); 随后对归属信任根的 `configured` 与 `real` 完整祖先链 (去重) 逐级 `lstat` 复核: 非真目录 (含符号链接) → **整批中止** (`REVIEW_HEAD_SYMLINK`), 消失或不可核验 → fail-closed 记单条 `failed` (`REVIEW_COMPONENT_VANISHED` / `REVIEW_UNVERIFIED`, `partialRisk: false`, 未触碰目标);
- **组件级安全复核 (TOCTOU 防线)**: 从 `root.real` 至目标父目录逐级 `lstat`, 任一级被替换成符号链接或非目录即**整批中止** (`REVIEW_COMPONENT_REPLACED`, 停止派发新条, 已在途并发条目跑完并如实报告, 未派发条目一条不动);
- **4 路有界并发 (`REMOVAL_CONCURRENCY = 4`)**: 顺序派发、结果按批次索引重排保输入顺序; 多条并发同时检出中止时取批次序最前条作为 `aborted` (确定性); 取消检查仅落在条目之间, 绝不在单条 `rm` 中途打断;
- **双动作分流与四桶结果 (`RemovalResult`)**:
  - `action === 'trash'`: 调 `moveToTrash` → 成功归 `trashed`, 失败归 `failed` (`TRASH_FAILED`, `partialRisk: false`, 原文件不动);
  - `action === 'delete'`: 调 `fs.rm(target, { recursive: true, force: false })` → 成功归 `removed`; 抛 `ENOENT` 时不靠错误对象定论 (规避 Bun 将内部子项消失冒泡为顶层 `ENOENT` 的双运行时分叉, EC-07), 必经 `lstat` 复核目标本体: 确认已消失归 `missing` (成功侧), 仍在或复核不可达归 `failed` (`REMOVE_ENOENT_SURVIVOR`, `partialRisk: true`); 其他错误归 `failed` (`REMOVE_FAILED`, `partialRisk: true`, 附部分删除复查提示);
  - 符号链接作为删除目标时 `fs.rm` 依 `lstat` 语义仅删链接本体、不跟随。
- 单条删除或回收站失败不中断整批, 末尾如实分桶汇总; 存在失败、整批中止、跳过或未尝试条目时 CLI 返回退出码 `1`。

## 残余风险 (定量与平台边界)

- **复核 `lstat` 与删除/移入回收站之间的微秒窗口**: 实测 `δ < 1.4µs` vs 攻击者最小周期 `~195µs` (系统调用级振荡 322 次零越界); 彻底关闭需运行时暴露 `openat`/`O_NOFOLLOW`, 登记为可接受残余风险。
- **同形态真实目录换位**: `lstat` 无法区分同型真目录替换, 假成功危害由 ENOENT 分阶段复核兜底。
- **持续振荡触发整批中止**: 约 4% 概率触发 fail-safe 中止 (无数据损失), 登记为已知 DoS 边界。
- **目标内部子挂载点与秒级挂载窗口**: 设备边界闸检查「目标与所属根不同设备」; 目标内部嵌子挂载点时 Bun 与 Node 行为分叉 (Node 不下探, Bun 会删卷内内容并以 `EBUSY` 收尾), 批次构造与执行间也存在秒级挂载窗口, 均登记为已知残留。
- **回收站平台边界与 `[证据缺口]`**:
  - 旧版 macOS 降级 `/usr/bin/osascript` 依赖图形会话与 Finder 自动化权限, 无头环境会失败并安全保留原文件;
  - Windows 下长度 `>= 260` 字符的路径无法经传统 Shell `FileSystem` 进回收站, 须改为 `action: "delete"` 或缩短路径;
  - **真机实测边界**: macOS 回收站与 Linux 纯 TS XDG Trash 协议逻辑已在本机实测; **Windows 宿主机真机回收站行为 (PowerShell / `Microsoft.VisualBasic.FileIO.FileSystem` / 只读剥离 / 260 字符边界) 以及真实 Linux 桌面集成仅经桩/逻辑测试验证, 尚未在目标宿主机真机实测**。
- **`rm` 阶段 ENOENT 的 Bun 内部归因**: 已用本体 `lstat` 复核彻底兜底 (EC-07), Bun 内部为何把子项消失记成顶层 `lstat` 未查证运行时源码, 登记为未核事实。

## 错误与边界

| 场景                                 | 处置                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 永久删除失败 (`REMOVE_FAILED`)       | 逐条报错 +「内容可能已被部分或全部删除, 请复查」(`partialRisk: true`), 退出码 `1`                                      |
| 回收站通道失败 (`TRASH_FAILED`)      | 逐条报错 +「已保留原文件, 未执行永久删除」(`partialRisk: false`, 绝不降级 `fs.rm`), 退出码 `1`                         |
| 安全闸拒绝 (含非法末段与根锚点软链)  | 逐条列出目标、错误码与改写指引, 整批零清理, 退出码 `1`                                                                 |
| 复核检出组件或根祖先被替换为符号链接 | 整批中止 (`REVIEW_HEAD_SYMLINK` / `REVIEW_COMPONENT_REPLACED`), 未派发条目注明未执行, 退出码 `1`                       |
| 复核阶段组件消失或不可核验           | 单条 fail-closed 记 `failed` (`REVIEW_COMPONENT_VANISHED` / `REVIEW_UNVERIFIED`, `partialRisk: false`), 退出码 `1`     |
| `rm` 阶段 `ENOENT`                   | 先 `lstat` 复核目标本体: 已消失归 `missing` (成功侧); 仍在或不可核验归 `failed` (`REMOVE_ENOENT_SURVIVOR`), 退出码 `1` |
