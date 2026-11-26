# @iyowei/sweep-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
![private](https://img.shields.io/badge/npm-private%20workspace%20package-lightgrey)
![node](https://img.shields.io/badge/node-%3E%3D22.18.0-339933)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

通用工作区级多技术栈清理工具 (`sweep`): 一次扫描多个工作区根目录, 统一识别 Node.js、Rust、Python、Java、C/C++ 构建与依赖产物、系统元数据垃圾文件以及你的自定义规则, 先预览体积与动作, 确认后再安全移入回收站或批量删除。

> **仓内私有演进包声明**: `@iyowei/sweep-cli` 及其 API 主包 [`@iyowei/sweep`](https://github.com/iyowei/clis/blob/main/packages/sweep/README.zh-CN.md) 当前显式标记 `"private": true`, 处于仓内独立演进打磨阶段, 不在公开 npm 自动发布链中 (详见 [ADR 0021](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md))。请通过下方源码检出方式配置和使用。

本 CLI 是套在 API 主包 `@iyowei/sweep` 外面的渲染与交互薄壳。若需在自己的脚本、编辑器插件或自动化流程中编程调用, 请直接使用 `@iyowei/sweep`。

## 运行要求

- **双运行时**: 有 Bun 优先走 Bun, 否则回退 Node.js (`>= 22.18.0`, 行为一致, Bun 启动更快; 见 [ADR 0006](https://github.com/iyowei/clis/blob/main/docs/adrs/0006-dual-runtime-bun-first.md))。
- **零第三方运行时依赖**: 仅使用 `node:` / `bun:` 运行时内置能力, 含三端回收站通道在内无任何外部依赖或预编译二进制 (见 [ADR 0003](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0003-zero-runtime-deps.md) 与 [ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md))。
- **跨平台**: 支持 macOS、Linux 与 Windows (见 [ADR 0007](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0007-platform-portability.md))。实测边界说明: macOS 回收站与 Linux 纯 TypeScript XDG Trash 协议逻辑已在本机实测; Windows 宿主机真机 PowerShell 回收站执行与真实 Linux 桌面集成仅经桩/逻辑测试验证, 尚未在目标宿主机真机实测。

## 从源码使用

当前 `@iyowei/sweep-cli` 为仓内私有包 (`"private": true`), 直接从仓库检出使用:

**macOS / Linux**:

```shell
cd "<克隆位置>/clis"
bun install && bun run build

chmod +x packages/sweep-cli/bin/sweep
ln -sf "$PWD/packages/sweep-cli/bin/sweep" ~/.local/bin/sweep
```

**Windows** (PowerShell):

```powershell
# 先用 bun 构建一次 (bun install && bun run build), 再把 bin 目录加入用户 PATH
$bin = "$env:USERPROFILE\tools\clis\packages\sweep-cli\bin"
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

- 源码启动器 (`bin/sweep` / `bin/sweep.cmd`) 会优先选用 Bun; 仅安装 Node.js (`>= 22.18.0`) 时需先执行 `bun install && bun run build` 以产出已构建产物。

> **一键脚本安装入口**: 包内已预置 `packages/sweep-cli/install.sh` (macOS / Linux) 与 `packages/sweep-cli/install.ps1` (Windows PowerShell), 自动探测本机 `bun` / `node >= 22.18.0` 或下载隔离私有 Bun; 当前包未公开发布 (`private: true`) 时支持经 `--from-tarball <path|url>` 或私有 `--registry` / `SWEEP_REGISTRY` 安装, 发布后可直接 `curl ... | sh` / `irm ... | iex`:
>
> ```shell
> # macOS / Linux (公开发布前通过本地压缩包安装)
> ./packages/sweep-cli/install.sh \
>   --from-tarball \
>     ./sweep-cli.tgz
> ```
>
> ```powershell
> # Windows PowerShell
> .\packages\sweep-cli\install.ps1 `
>   -FromTarball `
>     .\sweep-cli.tgz
> ```

## 使用

```shell
# 预览: 扫描配置根下的目标并展示体积与生效动作, 零副作用
sweep

# 复核无误后执行清理 (按配置走回收站或永久删除)
sweep --yes

# 连同「疑似安装树」一并纳入清理批 (默认跳过; 不放宽任何安全闸)
sweep --yes --force

# 按目录名临时追加排除 (可重复, 与配置合并)
sweep --exclude my-kits --exclude archive

# 仅清理命中白名单目录名的项目 (可重复, 与配置合并)
sweep --include my-workspace

# 交互式向导: 引导生成 v2 配置文件
sweep init

# 一键写入完整最佳实践 v2 配置 (含全部 6 大预设与默认安全护栏)
sweep init --default

# 无损迁移旧版 v1 配置到 v2 (写盘前强制自动备份原配置)
sweep migrate

# 查看本次实际生效的配置来源、路径与文件状态
sweep config

# 显式指定配置文件路径 (优先于 SWEEP_CONFIG)
sweep --config /abs/path/to/config.json

# 查看或持久化设置显示语言 (system | en | zh, 默认 system 自动跟随系统语言)
sweep lang
sweep lang en
sweep --lang en

# 查看版本 / 完整帮助
sweep --version
sweep --help
```

> 另提供 `sweep update` / `sweep update --check` 自更新子命令 (待公开分发后用于自动识别包管理器升级)。显示语言默认 `system` 自动跟随操作系统语言, 支持通过 `sweep lang <system|en|zh>` 独立持久化 (`~/.config/sweep/lang.json` / `%APPDATA%\sweep\lang.json`) 或经 `--lang`、`SWEEP_LANG`、`CLIS_LANG` 覆盖。

交互终端下顶栏尾部会标注当前实际运行时 (如 `bun 1.4.5`); 非 TTY、设置 `NO_COLOR` 或 `TERM=dumb` 时自动降级为无着色纯文本。

## 退出码

- `0`: 成功 (预览、空结果、`init`、`migrate`、`config`、`update`、`--version`、`--help`)。
- `1`: 失败 (删除或回收站失败、整批中止、安全闸整批拒绝、存在跳过或未尝试条目、无配置非 TTY 拒绝执行、配置损坏或无法无损迁移、参数错误)。

## 配置 (v2)

配置路径三级优先级: `--config <path>` > 环境变量 `SWEEP_CONFIG` > 平台默认路径:

- **macOS / Linux**: `~/.config/sweep/config.json`
- **Windows**: `%APPDATA%\sweep\config.json` (未设时回退 `%USERPROFILE%\AppData\Roaming\sweep\config.json`)

```json
{
  "version": 2,
  "roots": ["/Users/you/workspace"],
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
      "olderThanDays": 14
    }
  ]
}
```

### 核心配置规范 ([ADR 0022](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md))

- **`roots`**: 扫描根目录列表 (按真实路径去重)。省略 `roots` 时缺省取 `[realpath(os.homedir())]`; 显式写出 `"roots": []` 一律硬报错拒绝 (`CONFIG_CORRUPT_SHAPE`), 防止静默空扫。执行清理要求每个根及其完整祖先链不含任何符号链接 (包括 macOS 的 `/tmp`、`/var`)。
- **32 项三端家目录默认安全护栏 (`DEFAULT_EXCLUDE`)**: 省略 `exclude` 时自动启用 32 项跨平台默认排除, 覆盖包管理器与版本管理器 (`.bun` / `.npm` / `.pnpm-store` / `.yarn` / `.nvm` / `nvm` / `.fnm` / `.volta` / `.asdf` / `.n`)、编辑器扩展 (`.vscode` / `.vscode-insiders` / `.vscode-server` / `.cursor` / `.antigravity`)、系统与应用数据根 (`Library` / `.local` / `.config` / `.cache` / `.claude`)、三端回收站本体 (`.Trash` / `Trash` / `$Recycle.Bin`)、Windows 应用根 (`AppData` / `scoop`) 以及各语言全局工具链缓存 (`.cargo` / `.rustup` / `.m2` / `.gradle` / `.conda` / `.pyenv` / `.uv`)。显式写出 `exclude` (含 `[]`) 即由用户列表接管。
- **6 大内置预设 (`presets`) 与强制项目锚定**:
  - **键存在即激活**, **严禁出现 `enabled` 字段** (`CONFIG_CORRUPT_SHAPE`), 未知预设键直接报错拒绝。预设默认动作为 `"delete"`, 可局部覆写 `"action": "trash" | "delete"`; 局部 `exclude` / `include` 仅在全局护栏之上进一步收紧。
  - `node`: 清理 `node_modules` 目录, 强制校验同级 `package.json` 锚点及安装树语义分类。
  - `rust`: 清理 `target` 目录, 强制校验同级 `Cargo.toml`。
  - `python`: 清理 `.venv` / `venv` (强制校验同级 `pyproject.toml` / `requirements.txt` 或内含 `pyvenv.cfg`), 以及固有缓存 `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`。
  - `java`: Maven `target` (校验同级 `pom.xml`) 与 Gradle `.gradle` / `build` (校验同级 `build.gradle*` 或 `settings.gradle*`)。家目录本体 `~/.gradle` 受 `DEFAULT_EXCLUDE` 严格保护, 仅当 `java` 激活且位于真实项目目录下 (含 Gradle 锚点且未被用户显式排除) 时才清理项目级 `.gradle`。
  - `cpp`: 清理 `build` / `cmake-build-*`, 强制校验同级 `CMakeLists.txt` 或内含 `CMakeCache.txt`。
  - `os-junk`: 仅匹配普通文件 `.DS_Store`、`Thumbs.db`、`ehthumbs.db`、`ehthumbs_vista.db`, **严禁纳入** `desktop.ini`、`.directory` 与 `._*`。
- **自定义规则 (`rules`)**:
  - 支持 `name`、`kind` (`"file" | "dir" | "any"`)、`match` (精确名或简单 `*`/`?` 通配, 硬拒绝空串、`.`、`..`、`.git`、`*`、`**`、纯通配符、路径分隔符与控制字符)、`action?` (**缺省强制为 `"trash"`**)、`olderThanDays?` (按 `lstat.mtimeMs` 判定保留天数) 及可选局部 `exclude` / `include`。
  - 同一真实路径同时命中多条预设或规则时按保守策略去重: **`"trash"` 永远优先于 `"delete"`**。

### 自动初始化、无损迁移与结构化摘要展示 ([ADR 0024](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0024-cli-init-migrate-and-summary-display.md))

- **首次运行且新旧位置均无配置**:
  - **TTY**: 自动拉起 `sweep init` 交互式向导; 向导写盘当轮即使带 `--yes` 也**强制仅预览**, 绝不直接清理。
  - **非 TTY**: **严禁阻塞等待, 严禁回退盲扫家目录或 `cwd`, 严禁接受 `--yes` 执行**, 直接报错退出码 `1` 并指引运行 `sweep init`、`sweep init --default` 或 `--config <path>`。
- **`sweep init --default`**: 按完整最佳实践生成默认 v2 配置 (默认根 `~`、全部 6 大预设含 `os-junk`、默认安全护栏); 仍强制校验配置路径无符号链接, 非 TTY 下已有配置时拒绝静默覆盖并返回退出码 `1`。
- **无损自动迁移 (`sweep migrate` 或主流程自动触发)**:
  - 新默认路径不存在而旧路径 (`sweep-node-modules/config.json`) 存在, 或既有配置 `version < 2` (含省略 `version` 的 v1) 时自动探测并触发迁移。
  - **写前必备份**: 落盘前必在源配置目录创建 `config.json.YYYYMMDD_HHMMSS.modified`, 备份失败立即中止。
  - **严禁越权扩删**: v1 严格等价映射为 `presets: { node: {} }`, 绝不替用户悄悄激活新版预设 (`rust` / `python` / `java` / `cpp` / `os-junk`), 仅输出一行中性提示告知新增可用预设。
  - TTY 展示迁移摘要并请用户确认; 非 TTY 仅在 100% 无损等价升版时自动备份落盘并输出 info 日志继续, 含未知字段、高版本或结构损坏时直接报错退出码 `1`。
- **结构化配置摘要 (严禁原始 JSON 刷屏)**:
  - `init`、`init --default`、`migrate` 落盘后不打印原始 JSON 全文, 统一复用 `▍ SWEEP` 视觉模板输出配置路径、扫描根、激活预设 (`[DELETE]` / `[TRASH]`)、自定义规则 (含保留天数)、全局排除计数, 以及适配当前平台的快捷查看/编辑指令 (`sweep config` / `cat` / `Get-Content` / `${EDITOR:-vi}` / `open -e` / `notepad`)。

## 安全防护与零依赖三端回收站

> 这套工具的性格, 一句话: 看不准的时候, 默认不删。

- **默认只预览**: 必须显式传入 `--yes` 才执行清理; `--force` 仅放行疑似安装树, 不放宽安全闸不变量也不放行跨设备目标。
- **零依赖三端回收站, 失败绝不降级永久删除 ([ADR 0023](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md))**:
  - **macOS**: 优先调用系统绝对路径 `/usr/bin/trash -s <path>`; 缺失时降级 `/usr/bin/osascript` 通过 `on run argv` 传参通知 Finder (严禁字符串插值防注入)。
  - **Linux**: 纯 TypeScript 实现 Freedesktop XDG Trash 1.0 (`$XDG_DATA_HOME/Trash` 或 `~/.local/share/Trash`, `wx` 独占创建 `.trashinfo` 防并发碰撞并按 `.2`/`.3` 避让重名, 原子 `rename` 移入 `files/`, 跨设备 `EXDEV` 失败清理占位且绝不跨盘复制再删)。
  - **Windows**: 前置拦截长度 `>= 260` 字符路径 (`WIN32_TRASH_MAX_PATH`), 递归剥离只读属性后经系统绝对路径 `powershell.exe -NoProfile -NonInteractive` 调用 `Microsoft.VisualBasic.FileIO.FileSystem`, 通过环境变量传参防注入。
  - **铁律红线**: 任一平台回收站失败时原文件 100% 保持不动, 记入失败桶 `TRASH_FAILED` (`partialRisk: false`) 且 CLI 退出码为 `1`, **严禁在任何分支静默降级为 `fs.rm`**。
- **泛化五不变量安全闸与删前逐级复核**: 拦截非法末段 (空段 / `.` / `..` / `.git` / `*` / 尾斜杠)、越出根范围、文件系统根与家目录本体、符号链接根锚点链及重复 realpath; 任一目标被拒即整批零清理; 执行每条清理前自根向下逐级 `lstat` 复核防中途替换。
- **统一输出净化**: 所有磁盘路径、目录名与自定义规则名在渲染前统一经过单源净化管线 (`sanitizeLine` / `sanitizeOutputLine`), 防止控制字符与换行伪造。

完整安全模型与残余风险账目见 [安全防护保障](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/designs/safety-guardrails.md)。

## 开发与文档

- [开发指南](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [CLI 包文档入口](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/docs/README.md) / [命令面与输出设计](https://github.com/iyowei/clis/blob/main/packages/sweep-cli/docs/designs/cli-surface.md)
- [API 主包 (`@iyowei/sweep`)](https://github.com/iyowei/clis/blob/main/packages/sweep/README.zh-CN.md) / [产品文档与包级 ADR](https://github.com/iyowei/clis/blob/main/packages/sweep/docs/README.md)
- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
