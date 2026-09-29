# sweep-node-modules

[![CI](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/sweep-node-modules/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/release.yml)

[English](README.md) | **中文**

工作区级 `node_modules` 清理工具: 一次扫描多个根目录, 跨项目列出各处 `node_modules` 与体积, 确认后批量删除, 回收磁盘空间。

> 分层说明: 单项目清理工具管「进入某个项目, 清它自己的产物」; 本工具管「站在工作区层面, 一次清理很多个项目」。两者分层共存, 见 [ADR 0001](docs/adrs/0001-workspace-level-cleaner.md)。

## 包

本工具以两个包发布:

- **`@iyowei/sweep-node-modules-cli`**: `sweep-nm` 命令行工具; 安装、使用、配置与安全防护见 [README](packages/sweep-node-modules-cli/README.zh-CN.md)。
- **`@iyowei/sweep-node-modules`**: 可编程 API 包, 供在程序或脚本中调用; 用法见其 [README](packages/sweep-node-modules/README.zh-CN.md)。

## 文档

- [工程技术文档总索引](docs/README.md): 决策、设计、协议与开发文档的总入口。
- [开发指南](docs/development.md): 环境准备、常用命令、双运行时验证与提交钩子。
