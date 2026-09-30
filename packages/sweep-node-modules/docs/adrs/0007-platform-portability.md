# ADR 0007: 三平台可移植性与配置定位

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题陈述 (Context & Problem)

工具需要在 Windows / macOS / Linux 三平台顺利执行; 配置文件位置不得写死 (原规格写死 `~/.config/...`, Windows 无此约定); 原体积统计方案依赖 `/usr/bin/du` (POSIX 专属), 在 Windows 缺席。平台差异不得散落进业务代码。

## 被放弃的替代方案 (Options Considered & Rejected)

**[维持单平台, 不扩三平台]**

放弃理由: 需求明确要求三平台; 单平台实现对路径与命令的隐含假设会在跨平台时集中爆发。

**[依赖平台命令完成核心功能]**

放弃理由: Windows 无 `du` / `rm` / `readlink` 等对应物; 核心功能必须由运行时 API 纯实现, 平台命令最多作「可用时的优化快路径」。

**[用单一 shell 启动器统管三平台入口]**

放弃理由: Windows 无 `/bin/sh`; 入口必须分轨或借包管理器 shim。

**[配置位置写死单一路径]**

放弃理由: 三平台家目录约定不同 (Windows 无 `~/.config`); 写死即在 Windows 直接失效。

## 决策结论与选择原因 (Decision & Why)

1. **路径全面可移植**: 只用 `node:path` 拼装与比较路径; 家目录经 `os.homedir()` (禁 `$HOME` 字符串拼接); 目录包含性判定以 `path.relative` 结果为准 (禁用字符串前缀比较), win32 下按大小写不敏感比较; 禁硬编码 `/` 与 `\` 分隔符。
2. **配置定位 (平台自适应 + 可覆盖)**: 默认路径 Windows 为 `%APPDATA%\sweep-node-modules\config.json`, macOS / Linux 为 `~/.config/sweep-node-modules/config.json`; 优先级 `--config <path>` > 环境变量 `SWEEP_NM_CONFIG` > 平台默认 (覆盖通道亦服务测试与受控环境)。
3. **核心零 POSIX 假设**: 扫描 / 体积 / 删除 / 配置全走运行时 API; 平台命令仅允许作可用时的快路径, 且必须存在等价的纯实现基线 (体积统计的两候选与裁定落点见 [扫描与体积](../../../../docs/sweep/designs/scan-and-size.md))。补记 (2026-09-27): 快路径探针的平台面收口: du 的探针是 POSIX 绝对路径 (`/usr/bin/du` / `/bin/du`), 在 win32 上会被解析为「当前盘根」下的 `usr\bin\du`, 该盘存在同名外来程序时即被 spawn (与被扫目录同盘时构成执行链劫持面); 基线的语义本就是「无 du 平台走纯 JS 候选」, 故把守卫落到 `size-du.ts` 的 `findDu` (win32 一律返回 null), 与行为契约 EC-03 的「du 快路径仅 unix」对齐。
4. **入口分轨 (三入口)**: 三者职责同逻辑 (挑选运行时, Bun 优先 / Node 回退), 差异在宿主与入口选择: 仓库内 macOS / Linux 用 `bin/sweep-nm` (sh); 仓库内 Windows 用 `bin/sweep-nm.cmd` (cmd 包装, 不用 `readlink`); npm 安装用 `bin/sweep-nm.mjs` (package.json 的 `bin` 目标, 同时承担 Unix 与 Windows, shebang 固定 node, 也是包管理器 shim 的落点), 它多加一条入口选择: 优先跑编译产物 `dist/cli.js`, 无产物则回退源码 `src/cli.ts` (包内只有产物, 开发态通常无产物, 见 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md))。Windows 相关项 (cmd 启动器实跑 / shim 兼容) 均未经真机验证 `[证据缺口]`, 待真机轮补验; 该缺口的适用面现已含 npm 安装路径 (`bin/sweep-nm.mjs` 在 Windows 上经 npm 的 cmd-shim 承载); 补记 (2026-09-26): 本条的「优先跑 `dist/cli.js`」现附产物自证前置 (须与随附 `dist/manifest.json` 的摘要一致, 缺失或不符即拒收产物并给指引, 不静默回退源码), 判定与构建侧清单见 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md) 补记。补记 (2026-09-27): 三入口的运行时解析统一排除「当前工作目录」: Windows 上 CreateProcessW 的搜索序把当前目录排在 PATH 之前 (官方文档: 搜索序第 2 位即 the current directory for the parent process), Node 走的 libuv 同样以 NeedCurrentDirectoryForExePathW 门控先试 cwd 再扫 PATH, 而本工具恰在被扫目录里执行, 目录内放一个同名 `bun.exe` / `bun.com` 即可顶替真实运行时。落法: `bin/sweep-nm.mjs` 在 win32 下先按 PATH 解析绝对路径 (空条目与相对条目跳过, 两者在 Windows 上都意为当前目录) 再探测与执行; `bin/sweep-nm.cmd` 改用 for 的 PATH 展开修饰符 (只搜 PATH); `bin/sweep-nm` (sh) 的 `command -v` 与 `exec` 本就只按 PATH。同一审计带出的同型修复见决策第 3 条补记 (du 探针的平台守卫)。win32 解析防御的实跑仍属本条「真机未验」缺口 `[证据缺口]` 的适用面。另登记 (2026-09-27): npm 在 Windows 上生成的 cmd-shim (`.bin` 下的 `.cmd`, 由 npm 内置的 cmd-shim 模板生成) 在同目录无 `node.exe` 时以裸名 `node` 调起本包入口, 属包管理器产物面 (非本仓三入口), 不在本仓的解析防御面内。另登记 (2026-09-27): 三入口的候选名搜索粒度在 win32 面并不一致: `bin/sweep-nm.cmd` 是扩展名优先 (`.com` 扫完全部 PATH 目录后再试 `.exe`), libuv 与 `bin/sweep-nm.mjs` 的 win32 解析是目录优先 (逐目录内先 `.com` 再 `.exe`); 扩展名相对序与候选集 (`.com` / `.exe`) 一致, 仅当多个 PATH 目录分别存在不同扩展名的 bun / node 时, 两入口可能选中不同二进制 (cmd 侧注释已同步收窄)。
5. **终端能力降级**: 颜色在非 TTY / `NO_COLOR` / 能力不足终端降级为纯文本, 着色与行结构不丢失 (清单与 `config` 子命令的 `▍` / `░` 字符保留, 仅去色码); 按设计仅真终端出现的内容 (顶栏运行时自述与名单回执、`init` 向导整条交互路径) 不在此列, 非 TTY 不降级出现; 向导面更严: 入口即要求 TTY, 非 TTY 下 `init` 报错退 1, 故「非 TTY 零 ANSI」对向导实为「非 TTY 无此形态」; 补记 (2026-09-24): 向导视觉规范升级未新增降级分支, 与既有承诺的边界即此。视觉规范见 [命令面与输出](../../../sweep-node-modules-cli/docs/designs/cli-surface.md)。

## 后果与权衡妥协 (Consequences & Trade-offs)

**正面收益**

- 一次实现三平台可用, 平台差异集中在少数适配点 (路径解析 / 包含性判定 / 入口 / 颜色), 可审可测;
- 纯实现基线让核心逻辑不依赖任何平台命令, 跨平台行为可预测。

**权衡妥协**

- 体积统计失去「平台命令」的免费加速, 需接受纯实现性能或维护双轨 (已裁定为策略 A 双轨, 见 [扫描与体积](../../../../docs/sweep/designs/scan-and-size.md));
- 入口与颜色层多一档平台分支。

## 验证方式与关联引用 (Validation & References)

**验证口径 (落地后核验)**

1. 平台路径矩阵单测: win32 / darwin (linux 同 unix 轨) 两套路径样本下, 配置定位与包含性判定全绿;
2. 非 TTY 与 `NO_COLOR` 环境下输出为纯文本;
3. 体积统计两候选的基准数据已产出 (du 快路径合成场景约 11× 于纯实现, 双候选行为契约全绿); 裁定为**策略 A 双轨**, 已回写 [扫描与体积](../../../../docs/sweep/designs/scan-and-size.md)。

**关联引用**

- 双运行时与入口基线见 [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md); npm 分发入口与编译产物见 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md)。
- 视觉规范见 [命令面与输出](../../../sweep-node-modules-cli/docs/designs/cli-surface.md); 配置定位落点见 [配置与初始化](../../../../docs/sweep/designs/config-and-initialization.md)。

> **修订指引 (2026-09-30)**: 本文 `bin/sweep-nm*` 与 `size-du.ts` 等路径为单包时代坐标: 启动器现落 CLI 包 `packages/sweep-node-modules-cli/bin/`, `size-du.ts` 等模块落 API 包 `packages/sweep-node-modules/src/` (见 [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md))。
