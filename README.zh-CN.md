# clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

[English](README.md) | **中文**

我自己日常开发用的 CLI 工具集合 (以 monorepo 方式管理): 每个独立工具默认拆成「可编程 API 主包 (`@iyowei/<name>`) + CLI 薄壳包 (`@iyowei/<name>-cli`)」对称双包。所有的包都在 `packages/` 下, 文档从各自的 `README.md` 看起。

## 包

- **`create-clis`**: 集合仓生成器, 从本仓骨架快照生成一个独立的新集合仓 (带能力档位、通用词汇与开箱全绿的 CI); 用法见 [README](packages/create-clis/README.zh-CN.md)。
- **`@iyowei/sweep-node-modules-cli`**: `sweep-nm` 命令行工具, 工作区级 `node_modules` 清理器 (一次扫描多个根目录, 列出各项目里的 `node_modules` 与体积, 确认后批量删除, 回收磁盘空间); 安装、使用、配置与安全防护见 [README](packages/sweep-node-modules-cli/README.zh-CN.md)。
- **`@iyowei/sweep-node-modules`**: `sweep-nm` 背后的可编程 API 包, 供自己的程序或脚本调用以扫描、统计与安全清理 `node_modules`; 用法见 [README](packages/sweep-node-modules/README.zh-CN.md)。
- **`@iyowei/codd-cli`**: `codd` 命令行工具, 面向 Podman (Linux / macOS) 与 Kubernetes (Helm) 的模板化 MongoDB 9.0 部署装配 CLI (带交互式终端向导, 一键导出零命名冲突的上线部署包); 用法见 [README](packages/codd-cli/README.zh-CN.md)。
- **`@iyowei/codd`**: `codd` 背后的可编程 API 与模板资产包, 暴露硬件配额公式、清单校验、状态管理与部署包生成接口, 便于被其他程序编程集成; 用法见 [README](packages/codd/README.zh-CN.md)。
- **`@iyowei/cli-updater`** _(仓内私有共享库)_: 零外部依赖的跨包管理器自更新引擎 (`bun` / `npm` / `pnpm` / `yarn` / `volta`), 内联打包进仓内每个 CLI 的 `update` 子命令。

## 文档

- [工程技术文档总索引](docs/README.md): 仓库级入口 (集合仓治理、脚手架设计、仓级 ADR 与全部包文档入口);
- [开发指南](docs/development.md): 环境准备、常用命令、双运行时验证、发布链与提交钩子;
- [sweep-node-modules 文档入口](packages/sweep-node-modules/docs/README.md): API 契约、产品设计、安全防护总账、转写契约套件与产品 ADR;
- [codd 文档入口](packages/codd/docs/README.md): 公式设计、Podman / Kubernetes 部署运维分册、可视化看板 (`BOARD.html`) 与产品 ADR。
