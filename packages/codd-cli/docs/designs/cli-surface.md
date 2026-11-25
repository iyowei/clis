# codd CLI 命令面与交互契约

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-19
> **架构范式**: 对称双包 (`@iyowei/codd` 纯 API + 模板资产, `@iyowei/codd-cli` CLI 薄壳, 对齐 ADR 0010 / ADR 0019)
> **关联文档**: [codd 主包文档入口](../../../codd/docs/README.md) · [生成器与科学公式详解](../../../codd/docs/designs/generator-and-formulas.md)

## 命令面

```text
codd wizard                    打开 4 步交互式配置向导 (等效于 -i / --wizard)
codd init                      导出 deploy.schema.json、deploy-2c2g.json 与安全 .gitignore (等效于 --init-schema)
codd lang [system|en|zh]       查看或独立持久化显示语言偏好 (默认 system 自动跟随操作系统语言)
codd update                    自动识别当前安装器 (bun/npm/pnpm/yarn/volta) 升级到最新版 (支持 --check / --pm / --registry / --force / --verbose)
codd [配置文件.json]            按指定 JSON 清单生成部署包 (缺省读 ./deploy.json)
codd -c, --config <路径>       显式指定 JSON 清单文件路径 (与位置参数互斥)
codd -o, --out <目录>          指定部署包输出目录 (缺省 ./dist)
codd --rotate                  仅轮换业务库与备份账号密码 (保留指纹、root 与 keyFile)
codd --rotate-all              轮换包括 root 与 keyFile 在内的全部凭证 (仅限全新部署前)
codd --new-fingerprint         重新生成 12 位十六进制唯一实例指纹 (同机并行部署新实例)
codd --dry-run                 只校验清单并预览公式推导结果, 零磁盘落盘
codd --lang <语言>             单次覆盖显示语言 (system | en | zh; 优先级高于 CODD_LANG / CLIS_LANG / ~/.config/codd/lang.json)
codd -- <文件路径>             终止旗标解析, 其后 token 按位置清单路径处理
codd -V, -v, --version         输出当前 @iyowei/codd-cli 版本号
codd -h, --help                输出帮助说明
```

### 参数解析规则 (`src/args.ts`)

- `update` 首位透传与帮助兼容: `argv[0] === 'update'` 时将其后参数原样透传给 `@iyowei/cli-updater` 独立解析 (`--check` / `--force` / `--pm <name>` / `--registry <url>` / `--verbose` / `-h, --help`); 非首位出现 `update` 时, 若 `--` 前携带 `-h` / `--help` (如 `codd --help update`) 友好返回 `help: true` 并退出码 `0`, 否则报错提示 `codd update [--check | --force | --pm <name> | --registry <url> | --verbose]` 并退出码 `1`。
- `init` (`--init-schema`) 互斥规则: 仅用于导出 Schema 与参考清单, 禁止与 `wizard` (`-i` / `--wizard`)、清单路径、`--dry-run`、`--out`、`--rotate` / `--rotate-all`、`--new-fingerprint` 同时使用 (携带 `-h` / `--help` 或 `-V` / `--version` 时优先输出帮助/版本)。
- `-c` / `--config` 与 `-o` / `--out` 必须携带非空且不以 `-` 开头的取值; 缺值或紧跟另一旗标 (如 `codd -c --dry-run`) 立即报错并退出码 `1`。
- `--config=` 与 `--out=` 若等号后为空串同样报错拒绝。
- 遇到 `--` 后进入纯位置参数模式, 其后以 `-` 开头的 token 不再按旗标解析。
- 仅允许指定一份清单文件: 重复提供多个位置参数或同时用 `-c` 和位置参数均判错拒绝。
- 未指定清单路径参数、`./deploy.json` 不存在且 `stdin` / `stdout` 均为 TTY 时自动进入向导 (`codd wizard`); 非 TTY 环境缺 `./deploy.json` 时明确报错并提示执行 `codd init` 或指定路径。

## 4 步交互式向导 (`src/wizard.ts` & `src/ui/`)

向导分 4 个有序步骤收集最小必要信息, 并实时校验与展示公式卡片:

1. **拓扑与实例名**: 选择 `single` / `replica-set` / `k8s-single` / `k8s-rs`, 填写合规 DNS-1123 标签项目名 (`<= 32` 字符) 与监听端口 (交互向导动态推荐数根为 `3 / 6 / 9` 的 5 位安全端口, 提示中说明常规默认 `27117`; 非交互清单省略 `port` 时保持确定性默认 `27117`)。
2. **硬件与负载**: 选用预设 (`2c2g` / `4c8g` / `8c16g`) 或自定义 CPU/内存/磁盘与负载特征 (`balanced` / `write-heavy` / `read-heavy`), 立即调用 `computeSizing()` 渲染参数配比卡片。
3. **业务库与最小权限账号**: 以 `db:user` 逗号分隔格式录入业务库, 禁止系统保留库 (`admin` / `local` / `config`) 与重复库名。
4. **目标位置与落盘**:
   - Podman 拓扑收集节点操作系统 (`linux` / `macos`)、绑定 IP、安全绝对备份目录 (禁止 `..` 与 Shell 元字符, 采用系统核心目录黑名单拦截 `/proc`、`/sys`、`/dev`、`/etc`、`/usr/bin` 及 macOS `/System`、`/Applications` 等, 放行 `/Users`、`/Volumes`、`/opt`、`/var` 等任意数据路径) 与可选 SSH 目标;
   - K8s 拓扑收集合规 DNS 标签 Namespace 与可选 StorageClass。
   - **预览与覆写保护**: `--dry-run` 下明确提示跳过保存清单而不提问; 非 `--dry-run` 保存清单前自动递归创建父目录, 目标文件已存在时增加覆写二次确认 (默认不覆盖)。

### 终端交互与降级纪律

- **宽字符与零宽字符**: `charWidth` 对 CJK / Emoji 计 2 列, 对 `\p{Mn}` 组合标记、变体选择符与零宽控制符计 0 列; `widgets` 在落框前统一按 `\r?\n` 拆行, 杜绝多行值撑裂圆角框。
- **色彩主题与双流降级**: 支持 `CODD_THEME=light|dark` 显式切换浅色/深色主题 (未设时参考 `COLORFGBG`, 默认深色); `Apple_Terminal` (仅 256 色) 不走 24-bit TrueColor; `stdout` 与 `stderr` 独立判定 `isTTY` (`hasColor` / `hasStderrColor`), `printAlert('err', ...)` 在 `stderr` 重定向为非 TTY 时严格降级为无 ANSI 纯文本; 设 `NO_COLOR`、对应流非 TTY 或 `TERM=dumb` 时均输出零 ANSI 纯文本。
- **信号与异常清理**: Raw mode 全程监听 `stdin` 的 `end`/`close` 与 `stdout` 的 `resize`, 任一退出/取消 (`Ctrl+C`) 路径均立即关闭 raw mode、恢复默认光标并抛出 `PromptCancelledError` 交上层统一收口返回退出码 `130`, 严禁底层静默挂起或裸调 `process.exit`。
- **非交互单选/确认**: 输入无效值 (如非数字序号) 报错重问, 不静默回退默认项。

## 退出码

| 退出码 | 含义                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| `0`    | 成功完成 (`--help`、`--version`、`init`、`--dry-run`、`update` 检查/升级完成、正常生成部署包) |
| `1`    | 任一错误 (参数解析错误、清单校验/注入拦截、`update` 失败、状态文件损坏、模板缺失或 I/O 失败)  |
| `130`  | 交互向导被用户取消 (`Ctrl+C` 或 stdin 提前关闭)                                               |

## 环境变量

- `CODD_THEME`: 显式指定 `light` 或 `dark` 切换浅色/深色终端配色主题 (未设置时自动参考 `COLORFGBG`, 默认深色)。
- `NO_COLOR` / `TERM=dumb`: 禁用终端 ANSI 颜色转义 (`stdout` 与 `stderr` 同时各自独立判定 `isTTY`, 重定向至非 TTY 流时严格降级为纯文本)。
- `CODD_TEMPLATE_DIR`: 覆盖内置 `assets/template/` 模板根目录的自定义路径。
- `NPM_CONFIG_REGISTRY`: `codd update` 在未传 `--registry` 时优先采用的 npm 注册表地址 (兼容小写 `npm_config_registry`)。

## `.codd-state/` 状态与凭证契约

- 默认落盘于 `<workDir>/.codd-state/` (目录权限 `0700`, 内置 `.gitignore` 内容为 `*`, 防明文凭证误提交业务 Git 仓)。
- `<mode>-<name>.state.json` (`0600`): 幂等锁存 `fingerprint`、三类账号密码与 `keyFile`; 损坏 JSON 或非对象结构时包装为 `ConfigError` 明确报错, 不覆盖或静默重建。
- `<mode>-<name>.credentials.txt` (`0600`): 输出各业务库最小权限开箱即连连接串 (省略可选 `compressors` 以兼容 Compass 与零三方依赖驱动, 注释注明按需追加 `zlib`/`zstd`; 仅留存本机, 严禁同步到目标服务器)。
- `codd init` / `--init-schema` 在 `<workDir>` 写入 `deploy.schema.json`、`deploy-2c2g.json` (已存在不覆盖) 与 `.gitignore` (已存在跳过并明确提醒核对 `dist/` 与 `.codd-state/` 忽略规则)。

## 双运行时与产物自证规则

1. **三入口分工**:
   - `bin/codd.mjs`: npm / bun / pnpm / yarn 唯一分发目标 (`package.json` `bin.codd`), shebang 固定 `#!/usr/bin/env node`;
   - `bin/codd` 与 `bin/codd.cmd`: 源码直连辅助启动器 (不进 npm `files` 白名单), 均经由 `bin/codd.mjs` 执行统一产物自证。
2. **工作目录隔离 (`bin/bunfig.toml`)**:
   - 独立极简配置仅含 `env = false` 与 `preload = []`, 彻底解耦模板资产目录, 防止调用方目录中损坏的 `bunfig.toml` 或 `.env` 干扰启动; 缺失该文件时 `bin/codd.mjs` 直接拒绝执行。
3. **运行时解析与防劫持**:
   - 按 PATH 绝对目录解析运行时 (跳过空与相对条目, 杜绝 Windows/POSIX 当前目录同名可执行文件劫持);
   - Bun 优先, Node 回退且硬性要求 Node `>= 22.18.0`; Windows `bin/codd.cmd` 仅在成功命中 Bun 后置 `IS_BUN=1`, 不污染 Node 回退;
   - 若当前进程已是最终运行时 (如经 `bin/codd` 以 Bun 隔离模式拉起, 或无 Bun 且当前 Node 满足下限), `bin/codd.mjs` 在完成自证后直接同进程 `import()` 加载 `dist/cli.js`, 消除双重子进程派生。
4. **构建与发布自证闸门**:
   - 产物 `dist/cli.js` 在执行前必须与 `dist/manifest.json` (`schemaVersion: 1`, `cliSha256`) SHA-256 校验一致, 不符即拒收;
   - `bun run build` 先经 `scripts/sync-assets.ts` 从 `@iyowei/codd` 同步 `assets/template/` 与 `assets/manifest.json`, 再打包 `dist/cli.js` 并落盘 `dist/manifest.json`, 保证发包后 100% 自包含、零外部运行时依赖;
   - `bun run verify:release` 校验干净检出、commit 对账、产物 SHA-256、资产清单完整且零不可发隐藏名, 以及 `npm pack` 实际文件清单与动态白名单集合完全相等。
