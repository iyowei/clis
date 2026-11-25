# @iyowei/fan-cli

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/fan-cli)](https://www.npmjs.com/package/@iyowei/fan-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/fan-cli)](https://www.npmjs.com/package/@iyowei/fan-cli)
![node](https://img.shields.io/node/v/%40iyowei%2Ffan-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

用于查看与手动控制 Apple Silicon / Mac 风扇转速的命令行工具 (`fan`), 直接通过 AppleSMC IOKit 读写风扇键, 零第三方运行时依赖。**无需安装 Macs Fan Control 等第三方 GUI 软件**, 只需直接执行 `fan max`、`fan set 4000` 或 `fan auto` 即可改动并恢复系统风扇转速。手动调速操作默认自动记住配置 (`--once` 可临时生效不保存) 并自动确保内置守护服务就绪: **无外接屏合盖或进入睡眠时自动交还系统 `auto` 停转 (外接显示器合盖办公保留手动转速), 开盖/唤醒与开机重启后自动恢复**。

本 CLI 是套在 API 主包 [`@iyowei/fan`](https://www.npmjs.com/package/@iyowei/fan) 外层的参数解析与终端渲染薄壳。若需在脚本或自动化中编程调用, 请直接使用 `@iyowei/fan`。

## 运行要求

- **双运行时**: 有 Bun 优先走 Bun, 否则回退 Node.js (`>= 22.18.0`)。
- **宿主机**: 具备 AppleSMC (`IOKit`) 与 `/usr/bin/python3` 的 macOS; 写入子命令 (`set` / `max` / `min` / `auto` / `apply`) 与守护安装卸载在非 root 下会调用 `/usr/bin/sudo` 提权 (`status` 与 `persist status` 只读无需 `sudo`)。
- **零第三方运行时依赖**。

## 安装

### 1. 免安装体验

```shell
# 使用 bun
bunx @iyowei/fan-cli

# 使用 node
npx @iyowei/fan-cli
```

### 2. 全局安装 (日常使用推荐)

```shell
npm install -g @iyowei/fan-cli
bun install -g @iyowei/fan-cli

# 推荐: 安装开机及睡眠唤醒自动恢复守护服务 (LaunchDaemon)
fan persist install
```

### 3. 本地源码运行 (开发或纯 Bun 无 Node 环境)

```shell
cd "<克隆位置>/clis"
bun install && bun run build

chmod +x packages/fan-cli/bin/fan packages/fan-cli/bin/fan.mjs
ln -sf "$PWD/packages/fan-cli/bin/fan" ~/.local/bin/fan
```

## 用法

```shell
# 查看所有风扇当前转速、目标转速、可用区间与模式
fan
fan status

# 每 1 秒持续刷新实时转速 (Ctrl+C 退出)
fan status -w 1

# 以 JSON 格式输出状态
fan status --json

# 修改转速并默认记住配置 (开机与睡眠唤醒后自动恢复)
fan set 4000
fan set 60%
fan set --fan 0 60%
fan max
fan min
fan auto

# 仅本次生效, 不改写持久化配置 (唤醒前不会被守护覆写)
fan set 50% --once
fan max --no-save

# 立即应用已记住的配置, 或管理开机/唤醒恢复守护
fan apply
fan persist status
fan persist install
fan persist uninstall

# 查看或设置显示语言 (默认 system 自动跟随 macOS 系统语言, 支持自定义固定为 en 或 zh)
fan lang
fan lang en
fan lang zh
fan lang system
fan status --lang en

# 查看版本 / 帮助或检查更新
fan --version
fan --help
fan update --check
```

> **中英双语支持**: `fan` 默认按操作系统首选语言自动展示 (`system`), 也支持通过 `fan lang <system|en|zh>` 独立持久化语言偏好 (`~/.config/fan/lang.json`), 或通过 `--lang <system|en|zh>`、`FAN_LANG`、`CLIS_LANG` 单次覆盖。

> **说明**: 使用本工具无需安装 `Macs Fan Control` 等第三方风扇软件; 只需直接执行 `fan set 4000`、`fan set 30%`、`fan max` 或 `fan auto` 即可改写并自动记住系统风扇转速。执行 `set` / `max` / `min` 时会自动确保内置 `LaunchDaemon` (`com.iyowei.fan`) 已安装并同步至最新脚本: 无外接屏合盖、系统睡眠及后台 `DarkWake` 期间自动将风扇切回 `auto` 停转 (连接外接显示器的合盖桌面模式保留手动转速), 开机与真实唤醒/开盖时按 `state.json` 恢复转速, 醒着开盖期间边沿驱动零轮询、不覆盖 `--once` 临时设定。如果本机之前装过并仍在后台运行固定预设, 先退出对应软件即可避免它定时覆写手动目标值。

## 退出码

- `0`: 成功 (`status` / `set` / `max` / `min` / `auto` / `apply` / `persist` / `update` / `--version` / `--help`)
- `1`: 失败 (参数非法、非 macOS 平台、SMC/守护异常或 `sudo` 提权被拒)

## 开发与文档

- [开发指南](https://github.com/iyowei/clis/blob/main/docs/development.md)
- [CLI 包文档与命令面契约](https://github.com/iyowei/clis/blob/main/packages/fan-cli/docs/README.md)
- [API 主包 (`@iyowei/fan`)](https://github.com/iyowei/clis/blob/main/packages/fan/README.zh-CN.md)
- [仓库文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
