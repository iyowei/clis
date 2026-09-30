# ADR 0005: 工程闸门与提交钩子

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题陈述 (Context & Problem)

项目需要一套与既有个人项目一致的工程闸门: 格式、Lint、类型检查挂在提交路径上自动执行, 不依赖人记着手动跑; 且本地钩子要覆盖到 push 前的全量兜底。参考实现: 既有个人项目, 均采用 lefthook + 「pre-commit 增量 / pre-push 全量只读」的分层结构。

## 被放弃的替代方案 (Options Considered & Rejected)

**[纯手动跑校验, 不装钩子]**

放弃理由: 依赖纪律而非常态, 格式与 Lint 债务会在「先欠着」中累积; 参考项目的实践正是把校验挂上提交路径。

**[husky + lint-staged]**

放弃理由: 参考项目统一用 lefthook (单二进制、并行控制、`stage_fixed` 原语、glob 过滤), 不引第二套钩子体系制造生态分裂。

**[只设 pre-commit, 不设 pre-push]**

放弃理由: rebase / merge / cherry-pick 重放的提交不触发 pre-commit, base 的改动会让代码产生「语义冲突」(如 import 失配); push 是代码外流的唯一必经闸门, 必须有全量只读兜底。

## 决策结论与选择原因 (Decision & Why)

1. **钩子框架 lefthook**, 分「装钩子」与「钩子执行」两段把守 (安全审计 C9 及其补修):
   - **装钩子**经守卫脚本 `scripts/install-git-hooks.mjs` (prepare 入口): 只在本包自身的 git 仓库根 (cwd 所在 git 根与包根一致) 执行 `lefthook install`, CI 下短路, 装钩子失败不阻断依赖安装。被作为依赖安装时不写宿主仓库: git 依赖的临时克隆态照装 (落在一次性克隆里, 无副作用), vendor / 解包进宿主仓库或经 `install-links` 落进宿主 `node_modules` 时整支跳过; 原形态 (`prepare` 直接 `lefthook install`) 会把钩子写进宿主仓库的 `.git/hooks` (实测见下方「验证方式与关联引用」第 4 条)。
   - **钩子执行**由 `lefthook.yml` 两个官方配置键兜住: `lefthook: bunx lefthook@2.1.14` 与 `assert_lefthook_installed: true`。理由: 官方 `lefthook install` 生成的钩子模板, 探测顺序是 `LEFTHOOK_BIN` → 本键 (`lefthook:`) → PATH → install 当时的二进制绝对路径 → `node_modules` 扫描 → 各包管理器 / 工具运行器探测, 全链**不含 bunx**; 且 `assert_lefthook_installed` 默认 false 时, 全链找不到 lefthook 只 echo 一行 `Can't find lefthook in PATH` 后按 0 退出。于是「钩子装上了、执行时却找不到 lefthook」= 门禁静默失效, 这正是「装 ≠ 可执行」的验收教训: 只验「装没装上」会漏掉执行链空转, 必须验「无全局 lefthook 的机器上也能真正跑起来」。置这两个键后, 无全局 lefthook 的机器经 bunx 照跑, 确实全链失败时退非零 (响亮), 不再静默放行。
   - **lefthook 不列为依赖**: 它自带 postinstall 且被包管理器默认信任 (bun 内置信任名单含 lefthook), 本地路径 / vendor 形态下会被装进宿主 `node_modules` 并把钩子写进宿主仓库。取用改为: 安装期按 PATH 上的 `lefthook` (如 `brew install lefthook`) → `lefthook.yml` 的 `lefthook:` 配置值 (同读一行, 单一事实来源); 执行期 pin 只有 `lefthook.yml` 一处, 无第二份常量。
   - **另登记 (2026-09-27)**: 守卫脚本在 win32 上以 `shell: true` 裸名执行 `git` / `lefthook` / `bunx` (Node 在 Windows 上执行 `.cmd` / `.bat` 须经 shell 解析), 该解析面含当前工作目录 (官方 path 文档: the current directory is always searched before the directories specified in the command path); 其执行现场是本包自身或包副本目录 (开发工具链面), 不在 [ADR 0007](0007-platform-portability.md) 决策第 4 条所立 EC-08 的三入口解析防御面内。
2. **Lint 用 oxlint, 格式用 prettier** (配 `@trivago/prettier-plugin-sort-imports` 的 import 排序); `.oxlintrc.json` 继承既有项目的严档规则集 (max-depth / max-lines / import 族 / unicorn 族等)。
3. **分层门禁**: pre-commit 增量 (prettier `--write` 后自动重暂存 + oxlint 只扫暂存文件; type-check 例外, 不传 `{staged_files}` 全项目 `tsc --noEmit`); pre-push 全量只读 (typecheck / test / oxlint / prettier `--check`, 不设 `stage_fixed`)。
   > **修订指引 (2026-09-30)**: pre-push 现为六步 (typecheck / build / test / oxlint / prettier `--check` / conformance 双 target), 由 `bun scripts/ci.ts` 统一承载; 其中 `build` 会写产物, 原「全量只读」定性仅对检查类步骤成立。
4. **`.editorconfig`** 与两个参考项目一致: 2 空格 / LF / UTF-8 / 去行尾空格 / 文件末换行, `*.md` 例外不去尾空格。
5. **依赖版本精确锁定**: 全部 devDependencies 无 `^` / `~` 范围符号, 安装后从 `node_modules` 回读实装版本校准 (见配置治理规范)。

选择原因: 与参考项目同一套闸门结构与心智; `stage_fixed` 让「格式化 → 重暂存」自动化; pre-push 只读全量补齐 rebase 盲区。

## 后果与权衡妥协 (Consequences & Trade-offs)

**正面收益**

- 提交路径自动挡下格式 / Lint / 类型问题; push 前全量兜底防重放提交的语义冲突。
- 与参考项目同构, 维护心智一致, 配置可直接对照。

**权衡妥协**

- 每次提交多几秒检查耗时 (项目规模小, 可忽略)。
- **开发机取 lefthook 的通道变了** (原经 devDependencies 自动落到 `node_modules/.bin`): 现取 PATH 上的全局安装, 无则经 `bunx` 兜底 (需 bun 且首次联网); 两者都不可用时 `bun install` 照常完成, 但没有 git 钩子 (脚本给一行提示), 需手动补装。
- 继承既有项目的严档规则集 (max-lines 450 / max-depth 4 等), 实现代码须按此规模切分。
- **闸门只覆盖本机已装的运行时** (本仓无 CI): pre-push 跑的 `bun test` 中, e2e 用例按运行时可用性 skip: 缺 node 时 node 侧静默跳过而整体仍全绿; 转写验收不在任何闸门内, 亦须手动双跑。故 bun-only 机器上 node 侧回归无本地履行路径, 此为显式接受 (补 CI 或他法等真实需要出现时再议)。
  > **修订指引 (2026-09-30)**: 「本仓无 CI」与「转写验收不在任何闸门内」均已不成立: CI 已接入, conformance 双 target 入 CI 与 pre-push 自动执行 (见 `scripts/ci.ts`); 「补 CI」的再议条件已兑现。

## 验证方式与关联引用 (Validation & References)

**验证口径 (本次落地核验)**

1. `bun install` 触发 `prepare` (守卫脚本), 本包仓库检出态下 pre-commit / pre-push 钩子安装到位;
2. 守卫脚本的落点判定有模块级单测覆盖 (`scripts/install-git-hooks.test.ts`): 包根即 git 根 / 临时克隆态 → 装; vendor 进宿主仓库 / 落进宿主 `node_modules` / 非 git 目录 / CI 在场 → 跳过; lefthook 取不到 → 跳过而不阻断;
3. `bunx tsc --noEmit`、`bunx oxlint`、`bunx prettier --check` 全绿; `bun test` 全量全绿 (含双载体 e2e 与伪终端冒烟);
4. **依赖安装面实测 (C9 闭环, 2026-09-27)**: 临时消费者仓库三形态实测: npm + `file:./vendor/<pkg>` (vendor 无独立 `.git`, 旧版被写宿主 `.git/hooks/pre-commit`, 证据: 守卫前的 prepare 探针记录 cwd 在 vendor 子目录而 `git rev-parse --show-toplevel` 为宿主根)、bun + `file:<pkg>` 绝对路径 (旧版被写宿主钩子且宿主 `node_modules` 被装入本包全部 devDependencies, 含 lefthook)、npm + `git+file://<pkg>`; 修复后三形态宿主 hooks 均保持基线干净, 且本包仓库检出态装钩子功能不变。环境事实: npm 11 默认以 `allowScripts` 拦下依赖的 prepare / postinstall (需显式放行才执行); bun 对依赖 postinstall 默认整体拦截, 但内置信任名单含 lefthook, 故 lefthook 的 postinstall 照跑 (官方名单见 bun 源码 `src/install/default-trusted-dependencies.txt`);
5. devDependencies 实装版本与 lock 声明逐一吻合;
6. **执行链实测 (C9 补修, 2026-09-27)**: 净化 PATH (剔除全局 lefthook, 仅留 bun 与系统基础命令) 下执行生成的 `pre-commit`: lefthook 由 `bunx lefthook@2.1.14` 兜底拉起 (输出 `lefthook v2.1.14 hook: pre-commit`), 配置内 marker 命令实跑成功 (`✔️ marker (0.02 seconds)` 且产物文件落盘), 退 0; 对照: 未配兜底命令时钩子打印 `Can't find lefthook in PATH` 后退 1 (不再静默放行)。执行链判定有单测覆盖 (`scripts/install-git-hooks.test.ts`): 生成钩子的探测顺序 (`LEFTHOOK_BIN` → bunx 兜底 → PATH)、净化 PATH + 注入假 bunx 时确实落兜底分支并执行、无任何 lefthook 时退非零; 另断言 `lefthook.yml` 的兜底键与响亮失败键存在 (防配置漂移)。

**关联引用**

- 依赖与构建策略见 [ADR 0003](0003-zero-runtime-deps.md)。
- 门禁的操作级细节以仓库根 `lefthook.yml`、`.oxlintrc.json`、`.prettierrc`、`.editorconfig` 为准, 本条不复述。
