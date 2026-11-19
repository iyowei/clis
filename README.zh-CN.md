# clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

[English](README.md) | **中文**

我自己日常开发用的 CLI 工具集合 (以 monorepo 方式管理), 以及这些工具共用的复用包。所有的包都在 `packages/` 下, 文档从各自的 `README.md` 看起。

## 包

- **`create-clis`**: 集合仓生成器, 从本仓骨架快照生成一个独立的新集合仓 (带能力档位、通用词汇与开箱全绿的 CI); 用法见 [README](packages/create-clis/README.zh-CN.md)。
- **`@iyowei/sweep-node-modules-cli`**: `sweep-nm` 命令行工具, 工作区级 `node_modules` 清理器 (一次扫描多个根目录, 列出各项目里的 `node_modules` 与体积, 确认后批量删除, 回收磁盘空间); 安装、使用、配置与安全防护见 [README](packages/sweep-node-modules-cli/README.zh-CN.md)。
- **`@iyowei/sweep-node-modules`**: `sweep-nm` 背后的可编程 API 包, 供自己的程序或脚本调用以扫描、统计与安全清理 `node_modules`; 用法见 [README](packages/sweep-node-modules/README.zh-CN.md)。
- **`@iyowei/codd`**: `codd` 命令行工具, 面向 Podman (Linux / macOS) 与 Kubernetes (Helm) 的模板化 MongoDB 9.0 部署装配器 (按硬件规格确定性推导缓存、连接数、oplog 与压缩配额, 一键导出零命名冲突的上线部署包); 安装与用法见 [README](packages/codd/README.zh-CN.md)。

## 文档

- [工程技术文档总索引](docs/README.md): 仓库级入口 (集合仓治理与脚手架设计、ADR 与开发文档);
- [开发指南](docs/development.md): 环境准备、常用命令、双运行时验证与提交钩子;
- [sweep-node-modules 文档入口](docs/sweep/README.md): 这个工具的文档 (产品设计与转写契约套件);
- [codd 文档入口](docs/codd/README.md): 这个工具的文档 (公式设计、部署运维分册与可视化看板)。
