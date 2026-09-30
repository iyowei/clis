# 重定位执行与验证 (Collection Relocation)

> 文档类型: 仓库级设计 (执行计划)
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md)

## 范围

从「sweep-node-modules 单产品仓」落地为「`iyowei/clis` 集合仓」。分三阶段, 每阶段独立交付、独立验证。

## 阶段 A: 先行重构 (纯本仓收益, 不涉改名)

生成器与裁剪能力的前提, 按序做完再进阶段 B:

1. **闸门清单单源化**: `scripts/ci.ts` 升为唯一步骤清单 (步骤表 + 分组入口 `--verify` / `--conformance` / `--only <step>`); 两个 workflow 与 pre-push 只调入口; `package.json` 的单项闸门脚本移除 (单项入口走 `bun scripts/ci.ts --only <step>`)。取舍: 以 npm script 的 tab 补全直觉换清单唯一性, 用 `ci.ts --help` 列步骤名缓解;
2. **发布闸门对称化**: 两包的发布自证抽共用判定库 + 每包薄入口 (现 CLI 包为「判定库 468 行 + 薄壳 72 行」, API 包为单文件 256 行, 判定对等而结构不对称);
3. **领域硬编码派生化**: `make-mutants` (两包路径写死 34 处) / `tsconfig.json` paths / `run-conformance` 默认 target, 改为从根 `package.json` 的 workspaces 与包名派生 (一个共享的 workspace 解析模块);
4. 阶段 A 收口标准: `bun run ci` 全绿 + 通用四闸门全绿, 行为零变化 (重构不引入功能改动)。

## 阶段 B: 改名与组织

**依据 (为何不影响既有两包闭环)**: 发布链按包独立 (multi-release per-package) 且与仓库名解耦 (npm 包名 ≠ 仓库名); 仓库改名面属一次性元数据同步, CHANGELOG 历史链接为快照, 由 GitHub 的重定向兜底, 不重写历史。

执行序:

1. 本仓先全绿 (阶段 A 收口标准) 再动改名;
2. GitHub 端: 仓库 rename `sweep-node-modules` → `clis`;
3. 仓内同步 (一次性): 根 `package.json` (name 字段与仓库引用), 两包 `package.json` 的 `repository` / `homepage` / `bugs`, 根与两包 README 的徽章与仓库链接, 两个 workflow 内的仓库引用 (如有), issue 模板, `.vscode/launch.json`, `.gitignorerc.json`, git remote;
4. 文档自称更新 (docs 全量「sweep-node-modules」自称改为「集合 + 成员包」口径): 允许分批渐进, 不阻塞改名 (旧称不构成错误, 只是叙事过时);
5. 生成器包落地 (create-clis: 包骨架 + 快照 build + 契约实现, 见[生成器包](scaffold-package.md))。

## 阶段 C: 生成器闭环

1. 重量冒烟 (生成完整项目 → 跑其全链) 挂生成器包 `prepublishOnly` (见[生成器包](scaffold-package.md)质量闭环);
2. 第二实例验证: 生成一个非 sweep 领域的小项目端到端跑通, 作为模板领域无关性的证据;
3. 首个生成器版本发布后的核验: 在真实环境以 `bun create clis` 完整走一遍用户路径。

## 验证清单 (两包闭环零受损)

| 检查                            | 通道                      | 时机                           |
| ------------------------------- | ------------------------- | ------------------------------ |
| 全链全绿 (含双载体 conformance) | `bun run ci`              | 阶段 A 收口 / 改名后本地       |
| 发布链判定不变                  | semrel dry-run (本地预演) | 改名前                         |
| CI 与 Release workflow 照常     | GitHub Actions            | 改名推送后                     |
| 发布产物与 provenance 指向新仓  | npm 侧                    | 改名后**下一次真实发布**时核验 |
| CHANGELOG 历史链接可达          | 抽查旧链接 (重定向兜底)   | 改名后                         |

## 回滚

- 阶段 A: 各重构独立提交, 可单独回退;
- 改名: GitHub 可再改回; 但已发生的 npm 发布 (provenance 的 source 记录) 不可逆, 属公开事实, 无需回滚;
- 阶段 C: 生成器包可撤下 npm, 不影响两包。

## 修订记录

| 日期       | 修订                                         |
| ---------- | -------------------------------------------- |
| 2026-09-30 | 初稿: 三阶段、改名同步面、验证清单与回滚策略 |
