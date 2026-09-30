# clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

[English](README.md) | **中文**

服务我自己日常开发流的 CLI 工具集合 (monorepo 管理), 以及这些工具共享的复用包。成员在 `packages/` 下, 各自的文档从其 `README.md` 进入。

## 成员

**sweep-node-modules**: 工作区级 `node_modules` 清理工具, 一次扫描多个根目录, 跨项目列出各处 `node_modules` 与体积, 确认后批量删除, 回收磁盘空间。以两个包发布:

- **`@iyowei/sweep-node-modules-cli`**: `sweep-nm` 命令行工具; 安装、使用、配置与安全防护见 [README](packages/sweep-node-modules-cli/README.zh-CN.md)。
- **`@iyowei/sweep-node-modules`**: 可编程 API 包, 供在程序或脚本中调用; 用法见其 [README](packages/sweep-node-modules/README.zh-CN.md)。

## 文档

- [工程技术文档总索引](docs/README.md): 仓库级入口 (集合仓治理与脚手架设计、ADR 与开发文档);
- [开发指南](docs/development.md): 环境准备、常用命令、双运行时验证与提交钩子;
- [sweep-node-modules 文档入口](docs/sweep/README.md): 该成员的文档 (产品设计与转写契约套件)。
