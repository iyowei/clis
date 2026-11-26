# clis

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

[English](README.md) | **中文**

我自己日常开发用的 CLI 工具集合 (以 monorepo 方式管理): 每个独立工具默认拆成「可编程 API 主包 (`@iyowei/<name>`) + CLI 薄壳包 (`@iyowei/<name>-cli`)」对称双包。所有的包都在 `packages/` 下, 文档从各自的 `README.md` 看起。

## 包

- **`create-clis`**: 集合仓生成器, 从本仓骨架快照生成一个独立的新集合仓 (带能力档位、通用词汇与开箱全绿的 CI); 用法见 [README](packages/create-clis/README.zh-CN.md)。
- **`@iyowei/sweep-cli`** _(待首发, `private: true`)_: `sweep` 命令行工具, 通用多技术栈工作区清理器 (内置 6 大带锚点校验预设 `node` / `rust` / `python` / `java` / `cpp` / `os-junk` 与自定义 `rules`, 支持零依赖三端回收站、配置 v2 `SWEEP_CONFIG` / 默认 `~/.config/sweep/config.json` 及自动 `init` / `migrate`); 安装、使用、配置与安全防护见 [README](packages/sweep-cli/README.zh-CN.md) (可编程 API 见 [`@iyowei/sweep`](packages/sweep/README.zh-CN.md))。
- **`@iyowei/codd-cli`**: `codd` 命令行工具, 面向 Podman (Linux / macOS) 与 Kubernetes (Helm) 的模板化 MongoDB 9.0 部署装配 CLI (带交互式终端向导, 一键导出零命名冲突的上线部署包); 用法见 [README](packages/codd-cli/README.zh-CN.md) (可编程 API 见 [`@iyowei/codd`](packages/codd/README.zh-CN.md))。
- **`@iyowei/fan-cli`**: `fan` 命令行工具, 通过 AppleSMC IOKit 查看与手动控制 Apple Silicon / Mac 风扇转速 (默认记住并支持开机及睡眠唤醒自动恢复), 零第三方运行时依赖; 用法见 [README](packages/fan-cli/README.zh-CN.md) (可编程 API 见 [`@iyowei/fan`](packages/fan/README.zh-CN.md))。
- **`@iyowei/wake-cli`**: `wake` 命令行工具, 支持本机子网定向 Wake-on-LAN 广播、SSH 中继按序故障转移与就绪轮询, 零第三方运行时依赖; 用法见 [README](packages/wake-cli/README.zh-CN.md) (可编程 API 见 [`@iyowei/wake`](packages/wake/README.zh-CN.md))。

## 一键安装

各 CLI 均支持跨平台一键脚本安装 (**macOS / Linux / Windows**), 无需用户预先安装 Node.js 或 Bun: 脚本优先探测系统 `bun` 或 `node >= 22.18.0`, 未满足时默认下载并校验 (SHA-256) 官方 Bun 至隔离目录 (`~/.local/share/clis/runtime` 或 `%LOCALAPPDATA%\clis\runtime`), 不污染全局环境, 并支持通过 `<cli> update` 在线升级或 `--uninstall` 清理卸载。

**macOS / Linux (`curl` 或 `wget`)**:

默认仅连接官方源; 无直连海外网络时可显式传 `--installer-url`、`--bun-url`、`--registry`、`--from-tarball`, 或设置对应工具前缀环境变量 (`CODD_*` / `CREATE_CLIS_*` / `SWEEP_*` / `FAN_*`):

```shell
# 使用 curl 直接安装单工具 (codd | create-clis | fan | sweep | wake)
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh

# 或使用 wget
wget \
  -qO- \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh

# 或调用根目录统一安装脚本
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
  | sh \
    -s -- \
    --tool codd

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

支持各工具专属前缀环境变量 (`CODD_*` / `CREATE_CLIS_*` / `SWEEP_*` / `FAN_*`), 本地调用亦支持 `-InstallerUrl`、`-BunUrl`、`-Registry`、`-FromTarball`:

```powershell
# 直接安装单工具
irm `
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.ps1 `
  | iex

# 或通过 CLIS_TOOL 调用统一安装脚本
$env:CLIS_TOOL = "codd"
irm `
  https://raw.githubusercontent.com/iyowei/clis/main/install.ps1 `
  | iex

# 自定义远程下载地址
$env:CODD_INSTALLER_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.ps1"
$env:CODD_BUN_URL = "https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download"
$env:CODD_REGISTRY = "https://registry.npmmirror.com"
irm `
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.ps1 `
  | iex
```

## 文档

- [工程技术文档总索引](docs/README.md): 仓库级入口 (集合仓治理、脚手架设计、仓级 ADR 与全部包文档入口);
- [开发指南](docs/development.md): 环境准备、常用命令、双运行时验证、发布链与提交钩子;
- [sweep 文档入口](packages/sweep/docs/README.md): API 契约、产品设计、安全防护总账、转写契约套件与产品 ADR;
- [codd 文档入口](packages/codd/docs/README.md): 公式设计、Podman / Kubernetes 部署运维分册、可视化看板 (`BOARD.html`) 与产品 ADR;
- [fan 文档入口](packages/fan/docs/README.md): AppleSMC 键值契约、API 面设计与 CLI 命令面 ([fan-cli 文档](packages/fan-cli/docs/README.md))。
- [wake 文档入口](packages/wake/docs/README.md): 网络传输设计、架构 ADR 0025 与 CLI 命令面 ([wake-cli 文档](packages/wake-cli/docs/README.md))。
