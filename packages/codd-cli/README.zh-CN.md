# @iyowei/codd-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/codd-cli)](https://www.npmjs.com/package/@iyowei/codd-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/codd-cli)](https://www.npmjs.com/package/@iyowei/codd-cli)
![node](https://img.shields.io/node/v/@iyowei/codd-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

模板化 MongoDB 9.0 高性能部署装配 CLI (`codd`), 面向 Podman (Linux / macOS) 与 Kubernetes (Helm): 根据服务器 CPU、内存、硬盘与读写特征确定性推导缓存、连接数、oplog、全链路压缩与句柄上限, 一键导出干净、自包含且 100% 零命名冲突的上线部署包。

本包是纯编程 API 包 [`@iyowei/codd`](https://www.npmjs.com/package/@iyowei/codd) 的命令行薄壳 (参数解析、4 步交互式向导与终端排版 UI)。如需在脚本或自动化流水线中以 TypeScript/JavaScript 编程调用, 请直接使用 `@iyowei/codd`。

## 要求

- **双运行时**: 优先使用 Bun, 无 Bun 时回退 Node.js (`>= 22.18.0`, 下限见本包 `engines.node`)。
- 零第三方运行时依赖 (所有模板资产已随包内建在 `assets/template/`)。
- 支持 macOS、Linux 与 Windows (启动器含 PATH 绝对化防劫持、独立 `bin/bunfig.toml` 隔离与 `dist/manifest.json` SHA-256 产物自证)。

## 安装

### 1. 一键脚本安装 (无需预装 Node / Bun)

自动探测系统 `bun` 或 `node >= 22.18.0`; 若均缺失则自动安装隔离私有 Bun。无法直连海外网络时可显式传 `--installer-url`、`--bun-url`、`--registry`、`--from-tarball`, 或设环境变量 `CODD_INSTALLER_URL` / `CODD_BUN_URL` / `CODD_REGISTRY`:

**macOS / Linux**:

```shell
# 使用 curl
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh

# 使用 wget
wget \
  -qO- \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh

# 自定义远程下载地址
curl \
  -fsSL \
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh \
    -s -- \
    --installer-url \
      https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
    --bun-url \
      https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download \
    --registry \
      https://registry.npmmirror.com
```

**Windows (PowerShell)**:

```powershell
# 默认官方源安装
irm `
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.ps1 `
  | iex

# 自定义远程下载地址
$env:CODD_INSTALLER_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.ps1"
$env:CODD_BUN_URL = "https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download"
$env:CODD_REGISTRY = "https://registry.npmmirror.com"
irm `
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.ps1 `
  | iex
```

### 2. 免安装体验

```shell
# 使用 bun
bunx @iyowei/codd-cli

# 使用 node
npx @iyowei/codd-cli
```

### 3. 全局安装 (日常使用推荐)

```shell
npm install -g @iyowei/codd-cli
bun install -g @iyowei/codd-cli
```

### 4. 本地源码运行 (开发或纯 Bun 无 Node 环境)

**macOS / Linux**:

```shell
cd "<克隆位置>/clis"
bun install && bun run build
chmod +x packages/codd-cli/bin/codd packages/codd-cli/bin/codd.mjs
ln -sf "$PWD/packages/codd-cli/bin/codd" ~/.local/bin/codd
```

也可在 shell 配置中设置化名:

```shell
alias codd="/path/to/clis/packages/codd-cli/bin/codd"
```

**Windows** (PowerShell):

```powershell
# 在仓库根执行 bun install && bun run build 后, 把 packages\codd-cli\bin 加入用户 PATH
$bin = "$env:USERPROFILE\tools\clis\packages\codd-cli\bin"
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

## 使用

```shell
# 打开 4 步交互式配置向导 (新手推荐)
codd wizard

# 在当前目录导出 deploy.schema.json、deploy-2c2g.json 与安全 .gitignore
codd init

# 按默认 ./deploy.json 或任意指定 JSON 清单生成部署包
codd
codd deploy-prod.json
codd -c deploy-prod.json -o ./release-bundles

# 仅校验配置并预览公式推导结果, 不写入任何文件
codd deploy-prod.json --dry-run

# 仅轮换业务库与备份账号密码 (FINGERPRINT、root 与 keyFile 保持不变)
codd deploy-prod.json --rotate

# 通过 -- 终止旗标解析, 读取以短横线开头的清单文件名
codd -- -staging.json

# 自更新 (自动识别 bun / npm / pnpm / yarn / volta 等安装器)
codd update --check
codd update
```

## 命令与选项

| 命令 / 旗标                      | 说明                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `codd wizard` / `-i`, `--wizard` | 打开交互式 4 步向导, 引导生成配置清单与部署安装包                                                       |
| `codd init` / `--init-schema`    | 在当前目录导出 `deploy.schema.json`、`deploy-2c2g.json` 与安全 `.gitignore`                             |
| `codd lang [system\|en\|zh]`     | 查看或独立保存显示语言偏好 (`~/.config/codd/lang.json` / `%APPDATA%\codd\lang.json`, 默认 `system`)     |
| `codd update`                    | 自动识别当前安装器升级到最新版 (`--check` 仅检查, 支持 `--pm` / `--registry` / `--force` / `--verbose`) |
| `codd [配置文件.json]`           | 按指定 JSON 清单生成部署包 (不传默认读取 `./deploy.json`)                                               |
| `-c`, `--config <文件路径>`      | 显式指定 JSON 配置文件路径 (与位置参数等效)                                                             |
| `-o`, `--out <输出目录>`         | 指定部署安装包的导出目录 (默认 `./dist`)                                                                |
| `--rotate`                       | 仅轮换业务库与备份账号密码 (`FINGERPRINT`、`root` 与 `keyFile` 保持不变, 线上执行 `make init` 生效)     |
| `--rotate-all`                   | 轮换包含 `root` 与 `keyFile` 在内的全部密钥 (仅限全新部署前使用)                                        |
| `--new-fingerprint`              | 生成全新的 12 位实例唯一指纹 (同台服务器并行部署新实例时使用)                                           |
| `--dry-run`                      | 仅校验配置并预览公式推导结果, 不写入任何文件 (向导模式亦跳过保存清单)                                   |
| `--lang <system\|en\|zh>`        | 单次覆盖当前执行的界面语言 (另支持环境变量 `CODD_LANG` / `CLIS_LANG`)                                   |
| `--`                             | 终止旗标解析, 其后参数均按位置清单路径处理                                                              |
| `-V`, `-v`, `--version`          | 打印当前已安装的 CLI 版本号                                                                             |
| `-h`, `--help`                   | 打印帮助说明                                                                                            |

## 退出码

- `0`: 成功完成 (含 `--help`、`--version`、`init`、`--dry-run` 及 `update` 检查/升级完成)。
- `1`: 参数错误、清单校验失败、`update` 失败、状态文件损坏或磁盘读写失败。
- `130`: 交互式向导被用户取消 (`Ctrl+C` 或输入流提前关闭)。

## 环境变量

- `CODD_THEME`: 显式指定 `light` 或 `dark` 切换浅色/深色终端配色主题 (未设置时自动读取 `COLORFGBG`, 默认深色)。
- `NO_COLOR` / `TERM=dumb`: 禁用终端 ANSI 颜色转义 (`stdout` 与 `stderr` 同时各自独立判定 `isTTY`, 重定向至非 TTY 流时严格降级为纯文本)。
- `CODD_TEMPLATE_DIR`: 覆盖内置 `assets/template/` 模板根目录的自定义路径。
- `NPM_CONFIG_REGISTRY`: `codd update` 在未传 `--registry` 时优先采用的 npm 注册表地址。

## 生成物

- **`./dist/<前缀>-<实例名>-<指纹>/`**: 剔除文档与测试的纯净运行包, 可直接 `rsync` 推至目标 Linux/macOS 服务器执行 `make tune-host && make up`, 或在 K8s 管控机执行内嵌 `chart/` 的 `deploy.sh`。
- **`./.codd-state/`**: 权限 `0700` 的本机状态锁目录 (自动内建 `.gitignore` 防误提交入库), 持久化锁定唯一指纹、高强度口令与开箱即用的数据库连接串 (`*.credentials.txt`)。

## 开发

环境准备、常用命令、双运行时验证与提交钩子, 见 [开发指南](https://github.com/iyowei/clis/blob/main/docs/development.md)。

## 文档

- [命令面与交互契约](https://github.com/iyowei/clis/blob/main/packages/codd-cli/docs/designs/cli-surface.md)
- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [codd 产品文档入口](https://github.com/iyowei/clis/blob/main/packages/codd/docs/README.md)
- [可编程 API 包 (`@iyowei/codd`)](https://github.com/iyowei/clis/blob/main/packages/codd/README.zh-CN.md)
