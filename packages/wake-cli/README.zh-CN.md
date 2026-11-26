# @iyowei/wake-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
![node](https://img.shields.io/node/v/%40iyowei%2Fwake-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

跨平台 Wake-on-LAN 远程唤醒命令行工具 (`wake`), 支持同网段物理网卡定向 UDP 广播、多台 SSH 中继按序故障转移、在线预检与就绪等待、ARP 邻接发现交互向导 (`wake init`) 及严格只读环境体检 (`wake doctor`), 零第三方运行时依赖。

本 CLI 是套在 API 主包 [`@iyowei/wake`](https://www.npmjs.com/package/@iyowei/wake) 外层的薄壳。如需在脚本或自动化管线中编程调用, 请直接使用 `@iyowei/wake`。

## 运行要求

- **双运行时**: 优先使用 Bun, 缺失时回退 Node.js (`>= 22.18.0`)。
- **零第三方运行时依赖**。
- **SSH 中继 (可选)**: 跨网段中继节点需配置免密 SSH 登录 (`BatchMode=yes`), 并在登录 `PATH` 内安装 `wake`。

## 安装

### 1. 一键脚本安装 (macOS / Linux / Windows, 无需预装 Node / Bun)

自动探测本机 `bun` 或 `node >= 22.18.0`; 若均未安装, 默认下载校验后装入 `~/.local/share/clis/runtime` 隔离私有 Bun。支持传 `--installer-url`、`--bun-url`、`--registry`、`--from-tarball`, 或设 `WAKE_INSTALLER_URL` / `WAKE_BUN_URL` / `WAKE_REGISTRY`:

```shell
# macOS / Linux (curl)
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh

# 国内镜像加速示例
curl \
  -fsSL \
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh \
    -s -- \
    --installer-url \
      https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
    --bun-url \
      https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download \
    --registry \
      https://registry.npmmirror.com
```

### 2. 全局安装

```shell
npm install -g @iyowei/wake-cli
bun install -g @iyowei/wake-cli
```

### 3. 免安装体验

```shell
bunx @iyowei/wake-cli --help
npx @iyowei/wake-cli --help
```

## 用法

```shell
# 交互向导新增目标 (自动扫描局域网 ARP 邻接表辅助填写)
wake init

# 非交互快捷写入目标配置
wake init --name workstation --mac 00:11:22:33:44:55 --host 192.0.2.10 --relay bastion-a --default --yes

# 列出已配置目标并只读检查网卡与中继状态
wake list
wake doctor

# 唤醒默认目标或指定别名并等待 TCP 端口就绪
wake
wake workstation

# 无配置文件直接按 MAC 唤醒 (--no-wait 发包后立即退出)
wake --mac 00:11:22:33:44:55 --host 192.0.2.10 --no-wait

# 固定界面语言或检查 CLI 更新
wake lang zh
wake update --check
```

## 文档入口

- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [wake-cli 文档与命令面契约](https://github.com/iyowei/clis/blob/main/packages/wake-cli/docs/README.md)
- [API 主包 (`@iyowei/wake`)](https://github.com/iyowei/clis/blob/main/packages/wake/README.zh-CN.md)
