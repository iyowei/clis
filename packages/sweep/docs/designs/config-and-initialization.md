# 配置与初始化

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-23 (2026-11-20 升级至配置 v2)
> **决策者**: 沈委
> **父文档**: [设计总纲](sweep-design.md)

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-23 | 从总纲拆分而立; 确立平台自适应配置路径 + 三级覆盖、显式来源硬报错、`include` 白名单与排除优先、向导写入轮强制预览                                                                                                                                                                                                                                                                                                                                                              |
| 2026-09-24 | 引入内置默认排除名单 (`DEFAULT_EXCLUDE`)、删除侧 `roots` 真实路径锚点约束与向导三问交互                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-09-25 | 扩展 OF-14 单源净化到向导回显面; 写入侧配置路径增加锚点链符号链接检查 (`firstSymlinkOnTarget`, BC-40)                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-09-27 | 登记 `roots` 声明挂载点以解除 `on-path` 跨设备跳过 (BC-41)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-11-20 | 向导写入侧校准为双阶段目标与锚点检查 (前置拦截既有目录与锚点软链 + 落盘前 TOCTOU 二次复检)                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-11-20 | 依 [ADR 0022](../adrs/0022-config-v2-presets-and-rules.md) 与 [ADR 0024](../adrs/0024-cli-init-migrate-and-summary-display.md) 升级至配置 v2: 路径迁至 `sweep/config.json` 与 `SWEEP_CONFIG`、`roots` 省略默认家目录且空数组硬拒、32 项三端默认排除护栏与 `.gradle` 双重角色裁决、6 大锚定预设 (`presets`, 禁 `enabled`) 与自定义规则 (`rules`, 缺省 `"trash"`)、无损自动迁移 (`migrate`)、非 TTY 无配置拒盲扫、`init --default` 与模板化结构摘要展示 (禁用原始 JSON 全文刷屏) |

## 配置规格 (v2)

配置文件路径采用平台自适应 + 三级覆盖 ([ADR 0007](../adrs/0007-platform-portability.md) / [ADR 0022](../adrs/0022-config-v2-presets-and-rules.md)):

| 平台                 | 默认路径                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Windows              | `%APPDATA%\sweep\config.json` (未设时回退 `%USERPROFILE%\AppData\Roaming\sweep\config.json`) |
| 其余 (macOS / Linux) | `~/.config/sweep/config.json`                                                                |

- **三级覆盖优先级**: `--config <path>` > 环境变量 `SWEEP_CONFIG` > 平台默认。使用 `sweep config` 可查询当前生效来源、完整路径与文件存在状态 (见 [命令面与输出](../../../sweep-cli/docs/designs/cli-surface.md))。
- **旧路径探测**: 旧版单技术栈配置路径 (`sweep-node-modules/config.json`) 仅由 `resolveLegacyConfigPath` / `detectMigration` 在 `platform-default` 来源且新路径缺失时只读探测, 用于触发无损升级。

```json
{
  "version": 2,
  "roots": ["/Users/you/workspace"],
  "exclude": ["my-kits"],
  "include": [],
  "presets": {
    "node": {},
    "rust": {},
    "python": {},
    "java": {},
    "cpp": {},
    "os-junk": {}
  },
  "rules": [
    {
      "name": "stale-logs",
      "kind": "file",
      "match": "*.log",
      "action": "trash",
      "olderThanDays": 14
    }
  ]
}
```

| 字段      | 类型           | 语义                                                                                                                                              |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | `2`            | 权威配置版本号 (`CONFIG_VERSION = 2`); 省略或 `< 2` 时 `loadConfig` 抛 `CONFIG_NEEDS_MIGRATION` 引导迁移; `> 2` 拒绝自动迁移                      |
| `roots`   | `string[]`     | 扫描根目录列表 (按 realpath 去重)。省略时缺省取 `[realpath(os.homedir())]`; **显式写出 `"roots": []` 硬报错 (`CONFIG_CORRUPT_SHAPE`)** 防静默空扫 |
| `exclude` | `string[]`     | 全局排除目录名; 从根到命中点任意一级命中即跳过整棵子树。省略时启用 32 项 `DEFAULT_EXCLUDE`; 显式写出 (含 `[]`) 则由用户列表完全接管               |
| `include` | `string[]`     | 全局白名单目录名; 命中才纳入, 省略等价 `[]` (不过滤); 与 `exclude` 重叠时**排除优先**                                                             |
| `presets` | `PresetsMap`   | 激活的内置预设映射 (**对象内出现键名即激活, 严禁出现 `enabled` 字段**); 未知预设键硬报错 (`CONFIG_CORRUPT_SHAPE`)                                 |
| `rules`   | `CustomRule[]` | 自定义清理规则列表; 省略等价 `[]`; 每条规则缺省 `action: "trash"`                                                                                 |

### 扫描根与名单规则

- **排除与包含**: 按目录名精确匹配 (区分大小写, 任意一级命中); 多排除 = 少清理, 多包含 = 多清理; 重叠时**排除优先**, 但白名单命中计数 (`includeMatches`) 独立于排除优先, 避免被排除截走的白名单项误报未匹配。未命中任何目录的显式名单项会在 stderr 告警; 内置默认护栏项 (及用户显式写出与默认护栏同名的项) 零命中不告警 (BC-09)。
- **`.git` 静默剔除**: `mergeNames` 在合并配置与 CLI `--exclude` / `--include` 时去重保首见序, 并静默剔除扫描层恒定跳过的 `.git` (避免结构性假未命中告警)。
- **`roots` 执行侧真实路径约束**: 删除与回收站执行要求每个配置根及其完整祖先链 (自文件系统根一级子目录至根自身) 逐级 `lstat` 均为真目录, 不得包含任何符号链接 (包括 macOS 的 `/tmp`、`/var`), 否则整批拒绝并给出改写指引; 只读预览扫描不受此限 (见 [删除安全闸](deletion-guard.md))。
- **跨设备 `on-path` 解除路径**: 若目标与所属根之间存在挂载点, 可将该挂载点声明为独立 `roots` 项; 若目标本体即挂载点, 声明根无效, 需先卸载对应卷 (BC-41)。

### 六大内置预设 (`presets`) 与强制锚定

内置预设规格由 `packages/sweep/src/presets.ts` 的 `BUILTIN_PRESETS` 声明式注册表统一管理 ([ADR 0022](../adrs/0022-config-v2-presets-and-rules.md)):

| 预设键    | 匹配目标                                                                                    | 强制锚定条件                                                                                                                    | 默认动作   |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `node`    | 目录 `node_modules`                                                                         | 同级存在普通文件 `package.json` (并继续受安装树语义闸 `classifyTarget` 保护)                                                    | `"delete"` |
| `rust`    | 目录 `target`                                                                               | 同级存在普通文件 `Cargo.toml`                                                                                                   | `"delete"` |
| `python`  | 目录 `.venv`、`venv`; 固有缓存 `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache` | `.venv`/`venv` 须同级含 `pyproject.toml`/`requirements.txt` 或内含 `pyvenv.cfg`; 固有缓存名强特征直接命中                       | `"delete"` |
| `java`    | 目录 `target`、`.gradle`、`build`                                                           | `target` 须同级 `pom.xml`; `.gradle`/`build` 须同级 `build.gradle*` 或 `settings.gradle*` (且项目 `.gradle` 严禁位于家目录本体) | `"delete"` |
| `cpp`     | 目录 `build`、`cmake-build-*`                                                               | 同级存在 `CMakeLists.txt` 或目录内含普通文件 `CMakeCache.txt`                                                                   | `"delete"` |
| `os-junk` | 仅普通文件 `.DS_Store`、`Thumbs.db`、`ehthumbs.db`、`ehthumbs_vista.db`                     | 强白名单普通文件; **严禁纳入** `desktop.ini`、`.directory` 与 `._*`                                                             | `"delete"` |

- 每个预设可配置 `{ action?: "trash" | "delete", exclude?: string[], include?: string[] }`: 局部 `exclude`/`include` 仅在全局名单之上收紧范围, 绝不削弱全局护栏; 出现 `enabled` 字段或未知键直接报 `CONFIG_CORRUPT_SHAPE`。

### 自定义规则 (`rules`)

每条自定义规则由 `packages/sweep/src/rules.ts` 校验与编译:

- 字段: `name` (非空名称)、`kind` (`"file" | "dir" | "any"`)、`match` (单段名称精确匹配或简单 `*` / `?` 通配)、`action?` (**解析时缺省强制补为 `"trash"`**)、`olderThanDays?` (正有限数, 依 `lstat.mtimeMs` 判断 `nowMs - mtimeMs >= olderThanDays * 86_400_000`)、可选局部 `exclude` / `include`。
- `match` 硬拒绝清单 (`validateRuleMatch`): 空串、首尾空白、`.`、`..`、`.git`、`*`、`**`、纯 `*`/`?`/`.` 组合 (`*.*` / `.*` / `?` 等)、路径分隔符 (`/` 或 `\`) 及 ASCII 控制字符。
- **多源碰撞裁决**: 同一真实路径被多个预设或自定义规则同时命中时按 `realpath` 去重, 若生效动作冲突则**保守优先 (`"trash"` 优先于 `"delete"`)**。

### 32 项三端默认排除护栏 (`DEFAULT_EXCLUDE`)

`exclude` 省略时启用 32 项保守安全护栏 (单一事实来源: `packages/sweep/src/config.ts` 的 `DEFAULT_EXCLUDE`):

| 分组                  | 目录名                                                                        | 保护理由                                                  |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| 包管理器 / 版本管理器 | `.bun` `.npm` `.pnpm-store` `.yarn` `.nvm` `nvm` `.fnm` `.volta` `.asdf` `.n` | 全局工具与版本管理器安装树, 删除后无法通过项目级重装恢复  |
| 编辑器 / IDE          | `.vscode` `.vscode-insiders` `.vscode-server` `.cursor` `.antigravity`        | 编辑器扩展自身携带的依赖目录, 非用户项目构建产物          |
| 系统 / 应用数据根     | `Library` `.local` `.config` `.cache` `.claude`                               | macOS `Library` 与 XDG/应用私有配置与插件数据根目录       |
| 三端回收站本体        | `.Trash` `Trash` `$Recycle.Bin`                                               | 避免家目录扫描钻入 macOS / Linux XDG / Windows 回收站内部 |
| Windows 应用与工具根  | `AppData` `scoop`                                                             | Windows 用户应用数据与 Scoop 工具链安装目录               |
| 语言全局工具链与缓存  | `.cargo` `.rustup` `.m2` `.gradle` `.conda` `.pyenv` `.uv`                    | Rust / Maven / Gradle / Python 全局工具链与包仓库缓存     |

- **`.gradle` 双重角色裁决** ([ADR 0022](../adrs/0022-config-v2-presets-and-rules.md)): `~/.gradle` (位于家目录本体下) 是全局 Gradle 缓存树, 恒受 `DEFAULT_EXCLUDE` 保护跳过不下钻; 当 `java` 预设激活且 `.gradle` 位于非家目录本体的真实项目目录 (同级含 `build.gradle*` / `settings.gradle*`, 且用户未在配置 `exclude` 或 `presets.java.exclude` 中显式排除 `.gradle`) 时, 允许将该项识别为 `java` 预设清理目标并剪枝, 其余 `.gradle` 一律跳过。

## 初始化、无损迁移与摘要展示模型

由 [ADR 0024](../adrs/0024-cli-init-migrate-and-summary-display.md) 修订并局部取代 [ADR 0004](../adrs/0004-config-initialization-wizard.md):

### 1. 无配置首次运行分流

- **TTY (交互终端)**: 自动拉起 `sweep init` 初始化向导; 本轮向导落盘后, **即使命令行携带 `--yes` 也强制降级为仅预览** (stderr 说明), 复核清单后再运行方可执行。
- **非 TTY (脚本 / CI / 管道)**: **严禁阻塞等待, 严禁静默回退扫描家目录或 `cwd`, 严禁接受 `--yes` 执行**, 直接报错并返回退出码 `1`, 指引运行 `sweep init`、`sweep init --default` 或 `--config <path>`。

### 2. `sweep init` 与 `sweep init --default`

- **`sweep init`** (TTY 专属; 非 TTY 直接报错退 1 并提示可改用 `sweep init --default`): 交互式向导依次执行: ① **前置配置目标与锚点校验** (拦截既有目录与锚点链符号链接, 含悬空链接, 命中即用红色 `✗` 直接取消退出) → ② **覆盖保护** (`配置已存在 (<path>), 是否覆盖? (y/N)`, 默认否) → ③ 交互收集扫描根 (默认 `~`、逐根校验存在性/目录类型/无软链锚点)、启用预设与排除/包含名单 → ④ 人话摘要确认 → ⑤ **落盘前 TOCTOU 二次复检** (仍复用 `firstSymlinkOnTarget`, BC-40; 若期间变为目录或软链则拒写并重问 `确认写入? (y/N)` 防死循环) → ⑥ 落盘并展示结构化配置摘要。
- **`sweep init --default`**: 按完整最佳实践生成默认 v2 配置 (`createDefaultConfig`: 默认根 `[realpath(os.homedir())]`、激活全部 6 大预设含 `os-junk`、省略 `exclude` 以继承 32 项内置安全护栏、`rules: []`)。同样执行配置目标与锚点检查及覆盖保护: 配置已存在时 TTY 询问是否覆盖, 非 TTY 拒绝静默覆盖并返回退出码 `1`。

### 3. 自动与显式无损迁移 (`sweep migrate`)

- **触发条件** (`detectMigration`): ① 来源为 `platform-default`、新路径 `sweep/config.json` 不存在而旧路径 `sweep-node-modules/config.json` 存在; ② 或目标配置已存在但 `version < 2` (含省略 `version` 的 v1)。
- **写前必备份红线**: `applyMigration` 先对目标路径与备份路径执行 `firstSymlinkOnTarget` 锚点校验 (BC-40), 再以独占模式 (`flag: 'wx'`) 在源配置目录创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份; 备份失败立即中止 (`CONFIG_MIGRATION_FAILED`), 绝不覆写原配置。
- **严禁越权扩删**: `convertV1ToV2` 仅把 v1 等价映射为 `{ version: 2, roots, ...原exclude/include, presets: { node: {} }, rules: [] }`, **绝不自动启用 `rust` / `python` / `java` / `cpp` / `os-junk`**, 仅在迁移后附一行中性提示告知新增可用预设名 (`NEW_PRESET_HINTS`)。
- **TTY vs 非 TTY 分流**:
  - **TTY**: 展示迁移来源、目标路径、写前备份承诺与仅启 `node` 的等价映射说明, 经 `确认执行配置迁移? (Y/n)` 确认后落盘并输出结构化摘要;
  - **非 TTY**: 仅在判定为 100% 无损等价升版 (`lossless: true`) 时自动备份落盘并输出 `[info]` 日志继续; 若含未知字段、未来版本 (`version > 2`) 或结构损坏, 拒绝自动迁移并报错退 `1`。

### 4. 模板化配置摘要展示 (严禁原始 JSON 全文刷屏)

`init`、`init --default`、`migrate` 写盘后**严禁输出完整格式化原始 JSON**, 统一调用 `renderConfigSummary` 套用 `▍ SWEEP` 视觉模板输出: 配置文件路径 (家目录缩写 + OF-14 净化)、备份路径 (迁移场景)、扫描根列表、激活预设及动作标签 (`[DELETE]` / `[TRASH]`)、自定义规则及保留天数、全局排除计数、新增可用预设提示 (迁移场景) 以及当前平台可直接复制执行的快捷指令 (`sweep config`、POSIX `cat` / `${EDITOR:-vi}` / macOS `open -e` 或 Windows `Get-Content` / `notepad`), 视觉详规见 [命令面与输出](../../../sweep-cli/docs/designs/cli-surface.md)。

## 错误与边界

| 场景                                                                | 处置                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 显式来源 (`--config` / `SWEEP_CONFIG`) 指向不存在的文件             | 硬报错 `CONFIG_ABSENT` (`配置不存在 (<path>)`) + 退出码 `1`             |
| 平台默认来源缺失且旧路径亦不存在                                    | TTY 自动进入 `init` 向导 (写入轮强制预览); 非 TTY 硬报错退 `1` 拒盲扫   |
| 新路径缺失而旧路径存在, 或现存配置为 v1                             | 触发无损 `migrate` 流程 (写前强制备份); 含未知字段或高版本时中止退 `1`  |
| 配置损坏 (非法 JSON / 空 `roots: []` / 含 `enabled` / 非法 `match`) | 抛 `CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` 精确报错 + 退出码 `1` |
| 配置路径或备份路径锚点链含符号链接 (含悬空链接) 或为目录            | 写前阻断 (`BC-40`), 不写入任何字节, 退出码 `1` (或交互取消)             |
