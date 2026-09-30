# 重定位执行与验证 (Collection Relocation)

> 文档类型: 仓库级设计 (执行计划)
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md)

## 范围

本仓从「sweep-node-modules 单产品仓」改为「`iyowei/clis` 集合仓」。分三阶段, 每阶段独立交付、独立验证。

## 阶段 A: 先行重构 (纯本仓收益, 不涉及改名)

下面几步是生成器与裁剪能力的前提, 按顺序做完再进阶段 B:

1. **闸门清单单源化**: `scripts/ci.ts` 成为唯一的步骤清单 (步骤表 + 分组入口 `--verify` / `--conformance` / `--only <step>`); 两个 workflow 与 pre-push 只调用这一个入口; `package.json` 里的单项闸门脚本删除 (跑单项用 `bun scripts/ci.ts --only <step>`)。取舍: 拿 npm script 的 tab 补全换清单唯一性; 补全没了, 用 `ci.ts --help` 列出步骤名弥补;
2. **发布闸门对称化** (已落地 2026-09-30): 判定逻辑与事实读取抽进共享库 `scripts/lib/release-verify.ts` (判定顺序统一: 检出可信 → 产物就位 → 清单对账 → 专属判定 → 面包白名单; 两包的差异用 `VerifyProfile` 参数与专属判定钩子体现), 两包各留一个适配层 (`release-artifact.ts` / `verify-release.ts` 的坐标与白名单) 与薄入口; `git-env` 也跟着下移到共享层 (`scripts/lib/git-env.ts`); 两包的发布闸门测试全部通过 (含端到端「干净检出 + 本提交产物」用例);
3. **领域硬编码改为派生** (已落地 2026-09-30): `make-mutants` 与 `ci.ts` 的两包坐标改由共享的 workspace 解析模块 (`scripts/lib/workspace.ts`) 从根 `package.json` 的 workspaces 派生 (含单测); `tsconfig.json` 的 paths 是静态配置, 没法在运行时派生, 改包名时只需手动同步这一处 (见该模块注释); `run-conformance` 的 `--target` 本来就是必填参数, 没有默认值, 原设计说「默认 target 写死」, 实读代码后确认不成立, 无需改动;
4. 阶段 A 完成标准: `bun run ci` 全绿 + 通用四闸门全绿, 行为零变化 (重构不引入功能改动)。

## 阶段 B: 改名与组织

**依据 (为什么不影响现有两包的发布链)**: 发布链按包各自独立 (multi-release per-package), 跟仓库名无关 (npm 包名 ≠ 仓库名); 仓库改名只涉及一次性的元数据同步, CHANGELOG 里的历史链接是快照, 靠 GitHub 的重定向兜底, 不重写历史。

执行序:

1. 本仓先全绿 (阶段 A 完成标准) 再动改名;
2. GitHub 端: 仓库改名 `sweep-node-modules` → `clis`;
3. 仓内同步 (一次性): 根 `package.json` (name 字段与仓库引用), 两包 `package.json` 的 `repository` / `homepage` / `bugs`, 根与两包 README 的徽章与仓库链接, 两个 workflow 内的仓库引用 (如有), issue 模板, `.vscode/launch.json`, `.gitignorerc.json`, git remote;
4. 文档自称更新 (docs 里所有「sweep-node-modules」的自称, 都改为「集合仓 + 包」的说法): 允许分批慢慢改, 不阻塞改名 (旧称不算错误, 只是说法过时);
5. 生成器包落地 (create-clis: 包骨架 + 快照 build + 契约实现, 见[生成器包](scaffold-package.md))。

## 阶段 C: 生成器闭环

1. 重量冒烟 (生成完整项目 → 跑它的全链) 挂到生成器包的 `prepublishOnly` (见[生成器包](scaffold-package.md)质量闭环);
2. 第二实例验证: 生成一个非 sweep 领域的小项目, 端到端跑通, 作为模板领域无关性的证据;
3. 首个生成器版本发布后的核验: 在真实环境用 `bun create clis` 完整走一遍用户路径。

## 验证清单 (两包发布链零受损)

| 检查                            | 方式                      | 时机                           |
| ------------------------------- | ------------------------- | ------------------------------ |
| 全链全绿 (含双载体 conformance) | `bun run ci`              | 阶段 A 完成 / 改名后本地       |
| 发布链判定不变                  | semrel dry-run (本地预演) | 改名前                         |
| CI 与 Release workflow 照常     | GitHub Actions            | 改名推送后                     |
| 发布产物与 provenance 指向新仓  | npm 上                    | 改名后**下一次真实发布**时核验 |
| CHANGELOG 历史链接仍能打开      | 抽查旧链接 (重定向兜底)   | 改名后                         |

## 回滚

- 阶段 A: 各重构独立提交, 可以单独回退;
- 改名: GitHub 上可以再改回来; 但已发生的 npm 发布 (provenance 的 source 记录) 不可逆, 是公开事实, 无需回滚;
- 阶段 C: 生成器包可以从 npm 撤下, 不影响两包。

## 修订记录

| 日期       | 修订                                               |
| ---------- | -------------------------------------------------- |
| 2026-09-30 | 初稿: 三阶段、改名要同步的位置、验证清单与回滚策略 |
