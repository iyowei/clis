# clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

[English](README.md) | **中文**

我自己日常开发用的 CLI 工具集合 (以 monorepo 方式管理), 以及这些工具共用的复用包。所有的包都在 `packages/` 下, 文档从各自的 `README.md` 看起。

## 包

**sweep-node-modules**: 工作区级 `node_modules` 清理工具, 一次扫描多个根目录, 把各个项目里的 `node_modules` 连同体积一起列出来, 确认后批量删除, 回收磁盘空间。分成两个包发布:

- **`@iyowei/sweep-node-modules-cli`**: `sweep-nm` 命令行工具; 安装、使用、配置与安全防护见 [README](packages/sweep-node-modules-cli/README.zh-CN.md)。
- **`@iyowei/sweep-node-modules`**: 可编程 API 包, 可以在程序或脚本里调用; 用法见 [README](packages/sweep-node-modules/README.zh-CN.md)。

**create-clis**: 集合仓生成器, 从本仓骨架快照生成一个独立的新集合仓 (带能力档位、通用词汇与开箱全绿的 CI); 用法见 [README](packages/create-clis/README.zh-CN.md)。

## 文档

- [工程技术文档总索引](docs/README.md): 仓库级入口 (集合仓治理与脚手架设计、ADR 与开发文档);
- [开发指南](docs/development.md): 环境准备、常用命令、双运行时验证与提交钩子;
- [sweep-node-modules 文档入口](docs/sweep/README.md): 这个工具的文档 (产品设计与转写契约套件)。
