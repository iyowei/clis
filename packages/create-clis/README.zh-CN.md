# create-clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)

[English](README.md) | **中文**

从本仓骨架的泛化快照生成一个独立的新 clis 集合仓: 带能力档位与通用词汇, 开箱就是一条全绿的 CI。

> 状态: 仅结构占位。双语正文由写作编排填入; 下列每节都带 `TODO(writer)` 标记, 写明该节要覆盖的内容。npm 徽章随首个发布版本补上 (包尚未发布到 registry)。

## 要求

> TODO(writer): 运行时要求 (node / bun) 与免安装路径。

## 使用

> TODO(writer): 三种分发入口 (`npm create clis` / `pnpm create clis` / `bun create clis`) 与直接 `bunx create-clis`; 交互问答与旗标零交互两种形态; 目标目录规则 (已存在且非空即拒绝)。

## 变量与旗标

> TODO(writer): 五个变量 (项目名 / scope / bin 名 / owner / 仓库地址) 的旗标与默认值, 以及 `--tier` / `--no-git` / `--no-install` / `--yes`; 经 `npm create` 调用时的 `--` 透传说明。

## 档位

> TODO(writer): core / standard / full 三档与各档装备。

## 生成物

> TODO(writer): 生成物自带什么 (闸门链、发布闭环、文档骨架), 生成流程一瞥, 以及结尾打印的 next steps。

## 开发

> TODO(writer): 包脚本 (`build` / `verify:release` / `heavy-smoke`) 与设计文档位置。

---

- 生成器包设计: [scaffold-package.md](../../docs/designs/scaffold-package.md);
- 包级文档入口: [docs/README.md](docs/README.md)。
