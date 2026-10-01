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

**依据 (改名对发布链的影响面)**: 发布链按包各自独立 (multi-release per-package), 包名与版本判定跟仓库名无关 (npm 包名 ≠ 仓库名); 但 npm 侧的 Trusted Publisher 登记与仓库名强相关: 换证时 npm 拿 GitHub OIDC 令牌与登记逐字段核对 (repository / workflow 文件名 / environment), 改名不会自动跟改, 已存登记不支持就地修改, 只能 revoke 后重建。2026-09-30 改名后, 两包登记未同步, 发布链每轮在 npm 认证处失败, 报的是误导性的 `ENONPMTOKEN`; 事故全貌与防线见[开发指南](../development.md)「发布」章。仓库改名只涉及一次性的元数据同步 (仓内引用 + npm 侧登记), CHANGELOG 里的历史链接是快照, 靠 GitHub 的重定向兜底, 不重写历史。

执行序:

1. 本仓先全绿 (阶段 A 完成标准) 再动改名;
2. GitHub 端: 仓库改名 `sweep-node-modules` → `clis`;
3. 仓内同步 (一次性): 根 `package.json` (name 字段与仓库引用), 两包 `package.json` 的 `repository` / `homepage` / `bugs`, 根与两包 README 的徽章与仓库链接, 两个 workflow 内的仓库引用 (如有), issue 模板, `.vscode/launch.json`, `.gitignorerc.json`, git remote;
4. npm 侧同步 (仓库外, 必做): 重建两包的 Trusted Publisher 登记 (改名不会自动跟改, 不同步则发布链在 npm 认证处失败, 见上方「依据」段); 自动化入口 `scripts/npm-trust-guard.ts` (`check` 只读对账 / `fix` 自动 revoke + 重建, 需 npm 登录态与交互式终端); CI 侧 Release 的 `release` job (人工批准后) 已挂 `npm-trust` 预检, 改名后的第一次发布在此当场点名 (预检须与发布同 job: 换证核对的 environment 声明来自 job 的 environment, 无 environment 的 job 换证会被 npm 以误导性的 404 拒绝);
5. 文档自称更新 (docs 里所有「sweep-node-modules」的自称, 都改为「集合仓 + 包」的说法): 允许分批慢慢改, 不阻塞改名 (旧称不算错误, 只是说法过时);
6. **生成器包落地** (已落地 2026-10-01): create-clis 的包骨架、快照构建链、档位裁剪、变量与旗标、生成主流程与发行面自证全部就位 (见[生成器包](scaffold-package.md))。

## 阶段 C: 生成器闭环

1. **重量冒烟** (已落地 2026-10-01): 生成完整项目 → 跑它的全链, 已挂到生成器包的 `prepublishOnly` (见[生成器包](scaffold-package.md)质量闭环);
2. **第二实例验证** (已执行 2026-10-01): 以发布形态 (bin → dist 产物自证) 生成完整集合仓实例 (`iyowei/toolkit` 格局, standard 档, 落 `~/tmp/toolkit`), 载体名 / 占位符 / 复合形态三项残留扫描零命中, `bun run ci` 开箱全绿 (8 步 / 137 测试), 失败路径抽查合契约 — 模板领域无关性证据成立;
3. **发布后核验** (待首个版本发布后): 在真实环境用 `bun create clis` 完整走一遍用户路径。

## 验证清单 (两包发布链零受损)

| 检查                              | 方式                                                                 | 时机                           |
| --------------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| 全链全绿 (含双载体 conformance)   | `bun run ci`                                                         | 阶段 A 完成 / 改名后本地       |
| 发布链判定不变                    | semrel dry-run (本地预演)                                            | 改名前                         |
| CI 与 Release workflow 照常       | GitHub Actions                                                       | 改名推送后                     |
| 发布产物与 provenance 指向新仓    | npm 上                                                               | 改名后**下一次真实发布**时核验 |
| npm 侧 Trusted Publisher 登记一致 | 本地 `check` (或 Release 的 `release` job 获批后的 `npm-trust` 预检) | 改名后                         |
| CHANGELOG 历史链接仍能打开        | 抽查旧链接 (重定向兜底)                                              | 改名后                         |

## 回滚

- 阶段 A: 各重构独立提交, 可以单独回退;
- 改名: GitHub 上可以再改回来; 但已发生的 npm 发布 (provenance 的 source 记录) 不可逆, 是公开事实, 无需回滚;
- 阶段 C: 生成器包可以从 npm 撤下, 不影响两包。

## 修订记录

| 日期       | 修订                                                 |
| ---------- | ---------------------------------------------------- |
| 2026-09-30 | 初稿: 三阶段、改名要同步的位置、验证清单与回滚策略   |
| 2026-10-01 | 修正「跟仓库名无关」的依据 + 补 npm 侧登记同步与核对 |
| 2026-10-01 | 阶段 B 第 6 步标完成; 阶段 C 余两项列为待一次性执行  |
