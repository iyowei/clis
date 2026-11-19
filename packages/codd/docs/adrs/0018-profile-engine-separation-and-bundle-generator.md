# ADR 0018: 消除规格目录分叉, 统一为模板资产 + CLI 输出自包含零冲突部署包

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构, 工程]
> **影响范围**: [packages/codd/, packages/codd-cli/]

## 上下文与问题 (Context & Problem)

按硬件规格拆分子目录 (`2c2g/`、`4c8g/`) 极易导致配置模板漂移, 将研发文档与测试带入生产主机也会造成冗余污染; 此外把模板封装为通用 CLI 包分发时, 包管理器在打包环节会按文件名剔除或改写以点号开头的隐藏文件 (`.dockerignore`、`.helmignore`、`.env.tmpl`)。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[保留各规格静态目录, 仅外挂参数替换脚本]**

放弃理由: 底层模板与文档依然分散多处, 违背单一事实来源原则。

**[以原始隐藏点文件名直接随 npm 包分发模板]**

放弃理由: `.dockerignore`、`.helmignore` 等隐藏点文件会被包管理器打包规则剔除或误当作忽略规则解析, 导致用户安装后生成物残缺。

## 决策与理由 (Decision & Why)

1. **单一参数化模板 + 构建期无点载体封装**:
   - 全部 Podman、Helm 与 JSON Schema 模板单源维护于 [`packages/codd/template/`](../../template);
   - 构建脚本 [build-assets.ts](../../scripts/build-assets.ts) 将模板同步至发行目录 `assets/template/`, 并将 `.dockerignore`、`.env.tmpl`、`.helmignore` 映射为无点载体名 (`_dockerignore`、`env.tmpl`、`_helmignore`) 写入 `assets/manifest.json`, 由 [assets.ts](../../src/assets.ts) 在生成用户部署包时精确还原真实文件名, 确保四大包管理器安装产物 100% 完整一致。
2. **工作目录解耦与纯净自包含 `dist/` 产物**:
   - `codd` 在任意设备、任意工作目录执行时, 从包内 `assets/template/` 读取模板, 而在用户当前目录读写 `deploy*.json`、`dist/` 与 `.codd-state/`, 并在 Bun 运行时显式隔离工作目录配置 (`--config` 与 `--no-env-file`);
   - Podman 产物目录仅含运行所需最小文件集; Kubernetes 产物目录内嵌完整 `chart/` 子目录并将全部口令收敛至 `create-secret.sh`, 确保 `values.generated.yaml` 零明文密码且整包可复制到任意管控机独立执行 `./deploy.sh`。

理由: 实现单源模板维护、跨包管理器无损分发与目标服务器纯净交付的闭环统一。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 唯一模板源覆盖 Podman 与 Kubernetes 全拓扑, 四大包管理器安装产物字节级对齐。

**代价**

- 仓库开发态改动模板后须执行 `bun run build` 重新同步 `assets/template/` 与产物清单, 由发布前置闸门 [verify-release.ts](../../scripts/verify-release.ts) 兜底校验。

## 验证方式与关联引用 (Validation & References)

**验证依据**

`packages/codd/scripts/verify-release.test.ts` 验证无点载体转换、`assets/manifest.json` 对账、Bun / Node 双运行时 CLI 执行以及损坏 `bunfig.toml` 工作目录隔离。

**关联引用**

- 关联决策见 [ADR 0014](0014-fingerprint-resource-isolation.md) 与 [ADR 0015](0015-compact-2c2g-resource-budget.md)。
- 生成器规范见 [生成器与科学公式详解](../designs/generator-and-formulas.md)。
