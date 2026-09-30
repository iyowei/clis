# {{NAME}}

[![CI]({{REPO_URL}}/actions/workflows/ci.yml/badge.svg)]({{REPO_URL}}/actions/workflows/ci.yml)
[![Release]({{REPO_URL}}/actions/workflows/release.yml/badge.svg)]({{REPO_URL}}/actions/workflows/release.yml)

[English](README.md) | **中文**

<!-- 模板骨架: 用一句话说清这个集合仓是什么、装有哪些工具; 落地时替换本节与「包」一节。 -->

CLI 工具集合仓: 每个工具都住在 `packages/` 下, 文档从各自的 `README.md` 读起。

## 包

<!-- 模板骨架: 示例包 {{NAME}} 与 {{NAME}}-cli 是占位实现 (一个 greet 示例), 替换为自己的工具后同步本节。 -->

- **`{{SCOPE}}/{{NAME}}-cli`**: 命令行工具 `{{BIN_NAME}}`; 安装、用法与配置见其 [README](packages/{{NAME}}-cli/README.md);
- **`{{SCOPE}}/{{NAME}}`**: 可编程 API 包, 供自己的程序或脚本调用; 用法见其 [README](packages/{{NAME}}/README.md)。

## 文档

- [工程技术文档总索引](docs/README.md): 仓库级设计与 ADR、开发文档的入口;
- [开发指南](docs/development.md): 环境准备、常用命令与提交钩子。
