# `sweep` 专属 Rust 转写补充

> 通用基线 (全量继承, 不在此重复):
>
> - [仓级跨语言转写总入口](../../../../../docs/transcription/README.md)
> - [转写实施纪律 (角色边界 / 反敷衍红线 / 试跑闸门 / `release` 全量验收)](../../../../../docs/transcription/common-discipline.md)
> - [对抗评审指令 (1 写 + 2 审 + 1 修)](../../../../../docs/transcription/adversarial-reviewer.md)
> - [TS 跨语言「形似神异」暗坑核查表](../../../../../docs/transcription/ts-porting-pitfalls.md)
> - [Rust 通用转写模板](../../../../../docs/transcription/target-rust.md)
>
> 本文件只补充 **`sweep` 独有的领域行为对照、试跑模块组合与变异自证清单**。与 [行为契约](../behavior-contract.md) 冲突时, 一律以行为契约为准。

## 一、`sweep` 专属工程参数与试跑组合

- 二进制与子命令: `{{BINARY_NAME}}` (唯一命令 `sweep`; 子命令 `init` [支持 `--default`] / `migrate` / `config` / `update` 由 `main` 分派; 参数面与互斥校验见 `BC-27` / `BC-29` / `BC-30` / `BC-35` / `BC-45` / `BC-49`)
- 推荐 **3 文件试跑组合 (`Trial Run`)**:
  1. `packages/sweep/src/display.ts` (`formatBytes` / `sanitizeLine` / `sanitizeOutputLine` — 纯函数与控制字符/宽字符净化)
  2. `packages/sweep/src/rules.ts` (`validateRuleMatch` / `compileNameMatcher` / `isOlderThanDays` — 校验与确定性通配解析)
  3. `packages/sweep/src/trash.ts` (`encodeXdgTrashPath` / `moveToTrash` — 跨平台系统 IO 与失败不降级红线)
- `sweep` 专属验收基线:
  - 双面验收: `bun scripts/ci.ts --conformance` (须全集零跳过 `fullRunVerified: true`, 连续 3 次一致)
  - 差分模糊测试: `bun scripts/transcription/run-diff-fuzz.ts --targets packages/sweep/docs/protocol/conformance/fuzz-targets.json --api-target "<release harness>"`
  - 变异自证清单 (`make-mutants.ts` 当前 8 个 mutant): `prune-negated` / `exit-swallowed` / `sort-missing` / `exclude-silent` / `message-removed` / `size-unit-wrong` / `size-gone-dropped` / `terminal-event-dropped`

## 二、`sweep` 领域行为面对照表 (逐条实施, 不得留空)

| 行为面                 | `sweep` 参考实现既定行为                                                                                                                                                                                                                                                                                                                                                                                                                  | Rust 领域落点与待定项                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 视觉输出与退出码       | 逐行打印 (`▍ SWEEP` 视觉语言), 非 TTY / `NO_COLOR` / `TERM=dumb` 零 ANSI, 行尾 `\n` (`OF-01..OF-14`); 退出码 `0` (预览、空结果、`config`、`init --default` 新建、`migrate` 无损/无需、`update`、`--version`、`--help`) vs `1` (参数/配置错、无配置非 TTY 拒盲扫 [无论 `--yes`]、迁移非无损/备份失败、整批拒/中止、清理或 `TRASH_FAILED` 失败、跳过疑似安装树/跨设备/未测体积, 见 `BC-18` / `BC-26` / `BC-28` / `BC-48` / `BC-49`)         | 汉字/宽字符按显示列宽对齐 (`OF-06`), 诊断前缀 (`✗` / `[info]`) 经单源净化 (`OF-12` / `OF-14`)                                                                                        |
| 配置 v2 与无损迁移     | 三级覆盖 `--config` > `SWEEP_CONFIG` > `~/.config/sweep/config.json` (`%APPDATA%\sweep\config.json`); `roots` 省略取 `[realpath(home)]`, 显式 `[]` 硬报错; 32 项默认排除护栏; `presets` 键存在即激活、禁 `enabled`; 旧路径 `sweep-node-modules/config.json` 或 `version < 2` 触发迁移前必须 `wx` 写 `config.json.YYYYMMDD_HHMMSS.modified` 备份且仅激活 `{ node: {} }`, 绝不自动启用其余 5 个预设 (`BC-16` / `BC-20` / `BC-36` / `BC-49`) | `OpenOptions::create_new(true)` 对应 `wx` 排他备份; 写前校验目标与备份路径锚点链无软链 (`BC-40`); 非 TTY 无配置直接报红退 `1` 严禁盲扫 (`BC-18`)                                     |
| 初始化与迁移摘要       | `init` / `init --default` / `migrate` 写盘后渲染 `▍ SWEEP` 模板化人话摘要与平台可复制查看/编辑命令, 严禁输出原始 JSON 全文, 路径统一经 `OF-14` 净化 (`BC-50` / `OF-14`)                                                                                                                                                                                                                                                                   | 按 `#[cfg(target_os = ...)]` 生成对应平台查看/编辑指令 (`cat`/`Get-Content`, `${EDITOR:-vi}`/`open -e`/`notepad`), 并对含空格/引号路径安全引用                                       |
| 多预设锚定与自定义规则 | 6 大预设 (`node`/`rust`/`python`/`java`/`cpp`/`os-junk`) 强制项目锚定 (`package.json`/`Cargo.toml`/`pyproject.toml`/`requirements.txt`/`pyvenv.cfg`/`pom.xml`/`build.gradle*`/`settings.gradle*`/`CMakeLists.txt`/`CMakeCache.txt`), `java` 保护 `~/.gradle` 全局缓存, `os-junk` 仅认 4 个普通文件; `rules` 拦高危 `match`、缺省 `action: "trash"`, 多源碰撞动作取 `'trash'` 优先 (`BC-46` / `BC-47`)                                     | 读同级文件名集合一次完成锚定校验; 锚定未过的普通目录须回压栈继续下钻 (但绕过护栏的项目 `.gradle` 未命中时严禁下钻); `rules` 时间过滤用 `metadata.modified()` 并安全处理未来时间戳    |
| 体积统计双轨           | 探测 `/usr/bin/du` 与 `/bin/du` (win32 一律禁用 `EC-03`), 按 128 KiB 参数预算分批跑 `du -sk --` 并校验输出集合一致性; 不可用时走纯实现递归统计, 普通文件直接 `lstat` 取 `len()` (`BC-12` / `BC-43`)                                                                                                                                                                                                                                       | `Command` 直传 `argv` 并固定 `LC_ALL=C`/`LANG=C`; 解析边界与非 UTF-8 路径策略待定: `{{DU_PARSE_STRATEGY}}`                                                                           |
| 并发遍历与安全闸       | 有界并发 (上限 32, 严禁缩水占位), 跨多根按 `realpath` 去重, 结果按 `target` 升序 (`BC-04` / `BC-06`); 五道删除安全闸含根祖先链无软链 (`BC-21` / `BC-39`) 与设备边界 (`BC-41`)                                                                                                                                                                                                                                                             | `std::thread` + 有界 channel 或先串行保等价 (不得改变输出与并发上限常量); 绝不误用跟进软链的 `Path::is_dir()`                                                                        |
| 清理执行与跨平台回收站 | `delete` 走递归永久删除 (不跟进符号链接, 删前逐项复核 `BC-21` / `EC-04` / `EC-07`); `trash` 零外部依赖三端实现 (macOS `/usr/bin/trash -s` -> `osascript`, Linux 纯代码 XDG Trash `files/` + `info/*.trashinfo` + `EXDEV` 清理占位, Windows PowerShell `FileIO.FileSystem` 剥只读并拦 `>= 260` 字符路径); **回收站失败严禁静默降级永久删除**, 原文件不动并记 `TRASH_FAILED` (`BC-24` / `BC-48`)                                            | 区分文件 `remove_file` 与目录 `remove_dir_all`; 三端回收站通道须隔离参数防注入 (macOS `on run argv`, Windows 环境变量传路径), `Err` 分支严禁触碰删除 API; 待定: `{{TRASH_STRATEGY}}` |
| API 面探针注册表       | 参考 harness 暴露 `@iyowei/sweep` 全部公开导出 + 具名探针 (`pathops.posix` / `pathops.win32` / `deviceProbe.uniform`), 支持单步 `{ steps }` 及可选批量 `{ batch }`                                                                                                                                                                                                                                                                        | 按 [API harness 协议](../conformance/api-harness-protocol.md) 提供同名探针与公开导出分发; 待定: `{{API_HARNESS_BINARY}}`                                                             |

## 三、`sweep` 专属盲区与缺口起手式

验收全绿后, 须对照 [覆盖表](../conformance/coverage.md) 第二节的不可黑盒豁免项, 逐条补齐 Rust 原生测试并登记在缺口清单:

- TTY 交互向导 (`init` 交互配置、`BC-18` / `BC-29` / `BC-40`);
- 真机跨设备挂载 (`BC-41`, 可用可注入 `DeviceProbe` + 真机挂载脚本验证);
- Windows `>= 260` 字符路径拦截、只读属性剥离与 PowerShell 回收站 (`BC-48` / `EC-03`);
- 大体积目录 `>= 512 MiB` 与非 UTF-8 Unix 字节路径 (`EC-06`)。
