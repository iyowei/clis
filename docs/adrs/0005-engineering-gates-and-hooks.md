# ADR 0005: 工程闸门与提交钩子

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

本仓需要一套工程闸门, 跟我其他的项目保持一致: 格式、Lint、类型检查挂在提交这一步自动执行, 不靠人记着自己跑; 本地钩子还要覆盖到 push 之前的全量兜底。参考的是我已有的项目, 都采用 lefthook + 「pre-commit 增量 / pre-push 全量只读」的分层结构。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[纯手动跑校验, 不装钩子]**

放弃理由: 靠的是人的自觉, 而自觉不是常态, 格式与 Lint 债务会在「先欠着」里累积; 我已有项目的实践正是把校验挂上提交这一步。

**[husky + lint-staged]**

放弃理由: 我已有的项目统一用 lefthook (单二进制、并行控制、`stage_fixed` 原语、glob 过滤), 没必要再引入第二套钩子体系, 造成生态分裂。

**[只设 pre-commit, 不设 pre-push]**

放弃理由: rebase / merge / cherry-pick 重放的提交不会触发 pre-commit, 而 base 带来的改动会让代码产生「语义冲突」(如 import 失配); push 是代码离开本机的唯一必经闸门, 必须有一道全量只读兜底。

## 决策与理由 (Decision & Why)

1. **钩子框架 lefthook**, 分「装钩子」与「钩子执行」两段把守 (安全审计 C9 及其补修):
   - **装钩子**经守卫脚本 `scripts/install-git-hooks.mjs` (prepare 入口): 只在本包自己的 git 仓库根 (当前工作目录所在的 git 根与包根一致) 执行 `lefthook install`, 在 CI 里直接跳过, 装钩子失败不阻断依赖安装。被当依赖装进别的仓库时不往使用方仓库里写钩子: git 依赖的临时克隆态照样装 (落在一次性克隆里, 没有副作用), vendor / 解包进使用方仓库, 或经 `install-links` 落进使用方 `node_modules` 时, 一律跳过; 原形态 (`prepare` 直接 `lefthook install`) 会把钩子写进使用方仓库的 `.git/hooks` (实测见下方「验证方式与关联引用」第 4 条)。
   - **钩子执行**由 `lefthook.yml` 的两个官方配置键兜住: `lefthook: bunx lefthook@2.1.14` 与 `assert_lefthook_installed: true`。理由: 官方 `lefthook install` 生成的钩子模板, 探测顺序是 `LEFTHOOK_BIN` → 本键 (`lefthook:`) → PATH → install 当时的二进制绝对路径 → `node_modules` 扫描 → 各包管理器 / 工具运行器探测, 整条链里都**不含 bunx**; 而且 `assert_lefthook_installed` 默认 false 时, 整条链找不到 lefthook, 只会 echo 一行 `Can't find lefthook in PATH`, 然后以 0 退出。于是「钩子装上了、执行时却找不到 lefthook」= 门禁静默失效, 这正是「装 ≠ 可执行」的验收教训: 只验「装没装上」会漏掉执行链空转, 必须验「没有全局 lefthook 的机器上也能真正跑起来」。配上这两个键之后, 没有全局 lefthook 的机器经 bunx 照样跑; 就算整条链真的都失败, 也会以非零码退出 (响亮), 不再静默放行。
   - **lefthook 不列为依赖**: 它自带 postinstall, 且被包管理器默认信任 (bun 的内置信任名单里就有 lefthook), 以本地路径 / vendor 形态安装时会被装进使用方 `node_modules`, 还会把钩子写进使用方仓库。获取方式改为: 安装期优先用 PATH 上的 `lefthook` (如 `brew install lefthook`), 没有就取 `lefthook.yml` 里 `lefthook:` 配置的值 (安装期与执行期读的是同一行, 版本只有一个来源); 执行期锁定的版本也只在 `lefthook.yml` 这一处, 没有第二份写死的版本号。
   - **另有登记 (2026-09-27)**: 守卫脚本在 win32 上以 `shell: true` 直接用命令名 (不带路径) 执行 `git` / `lefthook` / `bunx` (Node 在 Windows 上执行 `.cmd` / `.bat` 必须经 shell 解析), 这个解析范围包含当前工作目录 (官方 path 文档: the current directory is always searched before the directories specified in the command path); 而它执行时所在的目录是本包自己或包副本的目录 (属于开发工具链范围), 不在 [ADR 0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md) 决策第 4 条定下的 EC-08 三个入口解析防御范围之内。
2. **Lint 用 oxlint, 格式用 prettier** (配 `@trivago/prettier-plugin-sort-imports` 的 import 排序); `.oxlintrc.json` 继承我已有项目的严格规则集 (max-depth / max-lines / import 族 / unicorn 族等)。
3. **分层门禁**: pre-commit 增量 (prettier `--write` 后自动重暂存 + oxlint 只扫暂存文件; type-check 是例外, 不传 `{staged_files}`, 直接全项目跑 `tsc --noEmit`); pre-push 全量只读 (typecheck / test / oxlint / prettier `--check`, 不设 `stage_fixed`)。
   > **修订指引 (2026-09-30)**: pre-push 现在是六步 (typecheck / build / test / oxlint / prettier `--check` / conformance 双 target), 与 `bun scripts/ci.ts` 是同一套步骤、逐项执行 (lefthook 里逐条列命令, 只有 conformance 一步经 ci.ts); 其中 `build` 会写产物, 原来说的「全量只读」只对检查类步骤成立。
4. **`.editorconfig`** 与我另外两个项目一致: 2 空格 / LF / UTF-8 / 去行尾空格 / 文件末换行, `*.md` 例外不去尾空格。
5. **依赖版本精确锁定**: 全部 devDependencies 不带 `^` / `~` 范围符号, 安装后从 `node_modules` 读回实际装到的版本做校准 (见配置治理规范)。

理由: 跟我已有的项目是同一套闸门结构、一样的思路; `stage_fixed` 让「格式化 → 重暂存」自动完成; pre-push 的全量只读补上了 rebase 的盲区。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 提交这一步自动挡下格式 / Lint / 类型问题; push 前的全量兜底防住重放提交的语义冲突。
- 跟我已有的项目结构相同, 维护思路一致, 配置可以直接对照。

**代价**

- 每次提交多出几秒检查时间 (项目规模小, 可以忽略)。
- **开发机获取 lefthook 的方式变了** (原来由 devDependencies 自动装到 `node_modules/.bin`): 现在用 PATH 上的全局安装, 没有就靠 `bunx` 兜底 (需要 bun, 且第一次要联网); 两者都不可用时, `bun install` 照常完成, 但不会有 git 钩子 (脚本会打一行提示), 需要手动补装。
- 继承我已有项目的严格规则集 (max-lines 450 / max-depth 4 等), 实现代码必须按这个规模切分。
- **闸门只能覆盖本机装了的运行时** (本仓没有 CI): pre-push 跑的 `bun test` 里, e2e 用例按运行时是否可用来决定跑不跑: 缺 node 时 node 侧静默跳过, 而整体仍然全绿; 转写验收不在任何闸门里, 也得手动跑两遍。所以只装 bun 的机器上, node 侧的回归在本地没有地方跑, 这是明确接受的取舍 (补 CI 或别的办法, 等真实需要出现时再议)。
  > **修订指引 (2026-09-30)**: 「本仓无 CI」与「转写验收不在任何闸门内」都已经不成立: CI 已接入, conformance 双 target 在 CI 和 pre-push 里自动执行 (见 `scripts/ci.ts`); 「补 CI」的再议条件已经兑现。

## 验证方式与关联引用 (Validation & References)

**验证口径 (本次落地核验)**

1. `bun install` 触发 `prepare` (守卫脚本); 在本包仓库的检出状态下, pre-commit / pre-push 钩子安装到位;
2. 守卫脚本判定「装还是跳过」的逻辑有模块级单测覆盖 (`scripts/install-git-hooks.test.ts`): 包根即 git 根、临时克隆态 → 装; vendor 进使用方仓库、落进使用方 `node_modules`、非 git 目录、在 CI 里 → 跳过; 取不到 lefthook → 跳过而不阻断依赖安装;
3. `bunx tsc --noEmit`、`bunx oxlint`、`bunx prettier --check` 全绿; `bun test` 全量全绿 (含双载体 e2e 与伪终端冒烟);
4. **依赖安装环节实测 (C9 闭环, 2026-09-27)**: 用临时使用方仓库, 把三种依赖形态各实测一遍: npm + `file:./vendor/<pkg>` (vendor 里没有独立的 `.git`, 旧版会把钩子写进使用方的 `.git/hooks/pre-commit`; 证据: 加守卫之前的 `prepare` 探针显示, 当前工作目录在 vendor 子目录, 而 `git rev-parse --show-toplevel` 指向使用方仓库的根)、bun + `file:<pkg>` 绝对路径 (旧版会把钩子写进使用方的钩子, 而且使用方的 `node_modules` 会被装入本包全部 devDependencies, 含 lefthook)、npm + `git+file://<pkg>`; 修复后, 三种形态下使用方仓库的 hooks 都保持干净 (与基线一致), 而本包仓库检出时装钩子的功能不变。环境事实: npm 11 默认用 `allowScripts` 拦下依赖的 prepare / postinstall (要显式放行才会执行); bun 默认会拦下依赖的 postinstall, 但它的内置信任名单里有 lefthook, 所以 lefthook 的 postinstall 照跑 (官方名单见 bun 源码 `src/install/default-trusted-dependencies.txt`);
5. devDependencies 实际装到的版本与 lock 里的声明逐一吻合;
6. **执行链实测 (C9 补修, 2026-09-27)**: 把 PATH 净化 (拿掉全局 lefthook, 只留 bun 和系统基础命令) 后执行生成的 `pre-commit`: lefthook 由 `bunx lefthook@2.1.14` 兜底拉起 (输出 `lefthook v2.1.14 hook: pre-commit`), 配置里的 marker 命令实跑成功 (`✔️ marker (0.02 seconds)`, 产物文件落盘), 以 0 退出; 对照: 没配兜底命令时, 钩子打印 `Can't find lefthook in PATH` 后以 1 退出 (不再静默放行)。执行链的判定有单测覆盖 (`scripts/install-git-hooks.test.ts`): 生成钩子的探测顺序 (`LEFTHOOK_BIN` → bunx 兜底 → PATH)、净化 PATH 并注入假 bunx 时确实走兜底分支并执行、没有任何 lefthook 时以非零码退出; 另外断言了 `lefthook.yml` 里兜底键与失败时报错的键都存在 (防配置漂移)。

**关联引用**

- 依赖与构建策略见 [ADR 0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md)。
- 门禁的具体操作细节以仓库根的 `lefthook.yml`、`.oxlintrc.json`、`.prettierrc`、`.editorconfig` 为准, 本文不重复。
