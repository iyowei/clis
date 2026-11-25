# clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

[English](README.md) | **中文**

我自己日常开发用的 CLI 工具集合 (以 monorepo 方式管理): 每个独立工具默认拆成「可编程 API 主包 (`@iyowei/<name>`) + CLI 薄壳包 (`@iyowei/<name>-cli`)」对称双包。所有的包都在 `packages/` 下, 文档从各自的 `README.md` 看起。

## 包

- **`create-clis`**: 集合仓生成器, 从本仓骨架快照生成一个独立的新集合仓 (带能力档位、通用词汇与开箱全绿的 CI); 用法见 [README](packages/create-clis/README.zh-CN.md)。
- **`@iyowei/sweep-cli`** _(待首发, `private: true`)_: `sweep` 命令行工具, 通用多技术栈工作区清理器 (内置 6 大带锚点校验预设 `node` / `rust` / `python` / `java` / `cpp` / `os-junk` 与自定义 `rules`, 支持零依赖三端回收站、配置 v2 `SWEEP_CONFIG` / 默认 `~/.config/sweep/config.json` 及自动 `init` / `migrate`); 安装、使用、配置与安全防护见 [README](packages/sweep-cli/README.zh-CN.md) (可编程 API 见 [`@iyowei/sweep`](packages/sweep/README.zh-CN.md))。
- **`@iyowei/codd-cli`**: `codd` 命令行工具, 面向 Podman (Linux / macOS) 与 Kubernetes (Helm) 的模板化 MongoDB 9.0 部署装配 CLI (带交互式终端向导, 一键导出零命名冲突的上线部署包); 用法见 [README](packages/codd-cli/README.zh-CN.md) (可编程 API 见 [`@iyowei/codd`](packages/codd/README.zh-CN.md))。
- **`@iyowei/fan-cli`**: `fan` 命令行工具, 通过 AppleSMC IOKit 查看与手动控制 Apple Silicon / Mac 风扇转速 (默认记住并支持开机及睡眠唤醒自动恢复), 零第三方运行时依赖; 用法见 [README](packages/fan-cli/README.zh-CN.md) (可编程 API 见 [`@iyowei/fan`](packages/fan/README.zh-CN.md))。

## 文档

- [工程技术文档总索引](docs/README.md): 仓库级入口 (集合仓治理、脚手架设计、仓级 ADR 与全部包文档入口);
- [开发指南](docs/development.md): 环境准备、常用命令、双运行时验证、发布链与提交钩子;
- [sweep 文档入口](packages/sweep/docs/README.md): API 契约、产品设计、安全防护总账、转写契约套件与产品 ADR;
- [codd 文档入口](packages/codd/docs/README.md): 公式设计、Podman / Kubernetes 部署运维分册、可视化看板 (`BOARD.html`) 与产品 ADR;
- [fan 文档入口](packages/fan/docs/README.md): AppleSMC 键值契约、API 面设计与 CLI 命令面 ([fan-cli 文档](packages/fan-cli/docs/README.md))。
