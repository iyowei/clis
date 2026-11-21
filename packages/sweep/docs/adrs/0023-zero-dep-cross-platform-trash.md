# ADR 0023: 零第三方依赖的三端回收站 (`trash`) 通道与失败不强删铁律

> **状态**: 已接受 (Accepted), 扩展 [ADR 0003](0003-zero-runtime-deps.md) 与 [ADR 0007](0007-platform-portability.md)
> **日期**: 2026-11-20
> **决策者**: 沈委
> **标签**: [安全, 跨平台, 架构]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

配置 v2 引入了自定义规则 (`rules`, 缺省 `action: "trash"`) 以及预设可覆盖动作 `action: "trash"` ([ADR 0022](0022-config-v2-presets-and-rules.md))。相比永久删除 (`fs.rm`), 回收站为自定义规则与敏感文件提供可撤回的安全缓冲。

核心约束有三条:

1. **零第三方运行时依赖** ([ADR 0003](0003-zero-runtime-deps.md)): 严禁引入 `trash` / `trash-cli` 或任何外部运行时包, 严禁夹带预编译二进制;
2. **数据安全绝对优先**: 当回收站通道在任一平台不可用或执行失败时, 绝不能偷偷降级为永久删除 (`fs.rm`), 否则「默认安全进回收站」的承诺会被直接击穿;
3. **三平台可移植与防注入**: macOS、Linux、Windows 三端回收站协议各异, 且被删路径来自不受信任的磁盘工作区 (可能含空格、引号、控制字符、超长路径或只读属性), 调用系统工具时必须杜绝命令/脚本注入。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[引入 npm 包 `trash` 或封装预编译的 `macos-trash` / `windows-trash` 二进制]**

放弃理由: 直接违背零运行时依赖与零预编译二进制红线, 同时引入多平台供应链与代码签名风险。

**[回收站不可用或失败时自动回退到 `fs.rm({ recursive: true, force: true })`]**

放弃理由: 用户显式配置或默认依赖 `action: "trash"` 的前提是「可从回收站找回」; 在 `catch` 或降级分支悄悄调用永久删除会导致不可逆数据损失, 属于严重安全违约, 永久禁止。

**[Linux 依赖外部 `gio trash` 或 `trash-put` CLI]**

放弃理由: 无头服务器或精简 Linux 发行版通常未预装 `glib2`/`trash-cli`; 而 Freedesktop XDG Trash Specification 1.0 协议简单清晰 (`files/` + `info/*.trashinfo`), 用纯 TypeScript 即可零外部依赖且跨发行版一致落地。

## 决策与理由 (Decision & Why)

1. **macOS (`darwin`) 双级系统通道**:
   - 主通道: 调用系统绝对路径 `/usr/bin/trash -s <path>` (macOS 14+ 原生命令, `-s` 即 `--stopOnError`, 不查 PATH 防劫持);
   - 旧版降级通道: 仅当 `/usr/bin/trash` 不存在时降级到 `/usr/bin/osascript`, 严格使用 `on run argv` + `POSIX file (item 1 of argv)` 通过参数数组传路径令 Finder 执行 `delete`, **严禁将路径拼入 AppleScript 源码字符串**防脚本注入。
2. **Linux (`linux`) 纯 TypeScript Freedesktop XDG Trash 实现**:
   - 回收站根目录按 XDG 规范取 `${XDG_DATA_HOME}/Trash` (未设或非绝对路径时回退 `${HOME}/.local/share/Trash`), 确保 `files/` 与 `info/` 存在;
   - **冲突与并发安全**: 以独占创建 (`O_CREAT | O_EXCL` / `flag: 'wx'`) 抢占 `info/<name>.trashinfo` (同名冲突时按 `<name>.2`, `<name>.3`, ... 递增生成唯一名), 写入符合规范的 `[Trash Info]\nPath=<URI 编码路径>\nDeletionDate=<YYYY-MM-DDTHH:MM:SS>\n` 后执行原子 `rename(target, files/<uniqueName>)`;
   - 若 `rename` 失败 (含跨文件系统 `EXDEV` 或权限不足), 清理刚创建的占位 `.trashinfo` 并上报失败, **不执行跨盘复制+删原文件**, 原文件保持不动。
3. **Windows (`win32`) PowerShell + VisualBasic FileSystem 通道**:
   - **超 260 字符路径前置拦截**: `target.length >= 260` (传统 Win32 Shell / `FileSystem` 的 `MAX_PATH` 上限) 时直接拒绝并报错跳过, 不调用 PowerShell, 也不降级删除;
   - **剥离 `Read-Only` 属性**: 移入回收站前清理目标 (文件或目录树内项) 的只读位, 防止 `FileSystem` 报权限拒绝;
   - **安全调用 PowerShell**: 使用绝对路径/系统定位的 `powershell.exe -NoProfile -NonInteractive -Command`, 通过环境变量安全传参 (不把路径直接插值进 PowerShell 命令字符串), 调用 `Microsoft.VisualBasic.FileIO.FileSystem` 的 `DeleteFile` / `DeleteDirectory(..., 'OnlyErrorDialogs', 'SendToRecycleBin')`。
4. **失败严禁降级永久删除 (红线)**:
   - 任何平台 `trash` 通道失败、超时、命令缺失、路径超限或抛异常时, **必须保留磁盘原文件不动**, 记入 `RemovalResult.failed` (错误码 `TRASH_FAILED`, `partialRisk: false`), 最终以退出码 1 收尾;
   - `trash` 执行前同样经过与 `delete` 完全一致的安全闸五不变量、根锚点链复核与逐级组件 `lstat` 复核。
5. **依赖注入与实测边界登记**:
   - 全部系统调用 (`spawn`、文件系统操作、平台与环境变量) 均经 `TrashDeps` 可注入, 供三端确定性单测覆盖;
   - **`[证据缺口]` 登记**: macOS 路径与 Linux 纯 TS XDG Trash 协议逻辑可在本机实测; **Windows 宿主机真机回收站行为 (PowerShell / `Microsoft.VisualBasic.FileIO.FileSystem` / 只读剥离 / 260 字符边界) 以及真实 Linux 发行版宿主机桌面集成, 仅经桩/逻辑测试, 未在目标宿主机真机实测**。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 零第三方运行时依赖与零预编译二进制, 完整守住供应链安全底线;
- 回收站故障时磁盘数据 100% 完整保留, 彻底杜绝静默永久删错的风险;
- 全通道参数隔离传递, 免疫路径中特殊字符引发的命令/脚本注入。

**代价**

- 旧版 macOS 降级 `osascript` 通知 Finder 时依赖图形会话与自动化权限, 无头环境或未授权限时会失败报错 (符合失败响亮、不强删原则);
- Windows 下长于 260 字符的路径无法经该 API 进回收站, 需用户显式改为 `action: "delete"` 或缩短路径后处理。

## 验证方式与关联引用 (Validation & References)

**验证方式**

1. macOS 本机集成测试: 验证 `/usr/bin/trash -s` 与 `osascript` 降级分支 (经桩) 及特殊字符路径安全;
2. Linux XDG Trash 端到端文件系统测试: 验证 `files/` 移动、`info/*.trashinfo` 格式与 URL 编码、重名 `.2`/`.3` 冲突处理、`EXDEV` 失败清理占位且原文件不动;
3. Windows 桩测试: 验证 `>= 260` 字符前置拦截、只读属性剥离、`FileSystem` 文件/目录分流与环境变量传参防注入 (显式标注未在 Windows 真机实测);
4. **红线反证测试**: 注入三端 `trash` 失败, 断言磁盘原文件依然存在、零调用 `fs.rm`、结果落 `failed` (`TRASH_FAILED`) 且 CLI 退出码为 1。

**关联引用**

- 零运行时依赖底线: [ADR 0003](0003-zero-runtime-deps.md);
- 三平台可移植基线: [ADR 0007](0007-platform-portability.md);
- 动作分流与配置 v2: [ADR 0022](0022-config-v2-presets-and-rules.md)。
