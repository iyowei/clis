# ADR 0007: 三平台可移植性与配置定位

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

包需要能在 Windows / macOS / Linux 三平台正常运行; 配置文件位置不能写死 (最初的规格写死了 `~/.config/...`, 但 Windows 没有这个约定); 最初的体积统计方案依赖 `/usr/bin/du` (POSIX 专属), 而 Windows 上没有这个命令。平台差异不能散落进业务代码。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[维持单平台, 不扩三平台]**

放弃理由: 需求明确要三平台; 单平台实现里那些对路径和命令的默认假设, 一到跨平台就会集中爆发。

**[依赖平台命令完成核心功能]**

放弃理由: Windows 上没有 `du` / `rm` / `readlink` 的对应命令; 核心功能必须完全用运行时 API 实现, 平台命令最多能当个「可用时的优化快路径」。

**[用单一 shell 启动器统管三平台入口]**

放弃理由: Windows 上没有 `/bin/sh`; 入口必须分轨, 或者借包管理器的 shim。

**[配置位置写死单一路径]**

放弃理由: 三平台的家目录约定不同 (Windows 没有 `~/.config`); 写死就是在 Windows 上直接失效。

## 决策与理由 (Decision & Why)

1. **路径全面可移植**: 只用 `node:path` 拼装与比较路径; 家目录用 `os.homedir()` 获取 (不要用 `$HOME` 拼字符串); 判断一个目录是否包含另一个目录, 以 `path.relative` 的结果为准 (不要用字符串前缀比较), win32 下按大小写不敏感比较; 不要硬编码 `/` 与 `\` 分隔符。
2. **配置定位 (平台自适应 + 可覆盖)**: 默认路径 Windows 是 `%APPDATA%\sweep-node-modules\config.json`, macOS / Linux 是 `~/.config/sweep-node-modules/config.json`; 优先级 `--config <path>` > 环境变量 `SWEEP_NM_CONFIG` > 平台默认 (这条覆盖通道同时也是给测试与受控环境用的)。
3. **核心不假设 POSIX 环境**: 扫描 / 体积 / 删除 / 配置全走运行时 API; 平台命令只允许在可用时当快路径用, 而且必须有一条等价的纯实现基线 (不依赖平台命令的那套实现); 体积统计的两个候选及其裁定见 [扫描与体积](../../../../docs/sweep/designs/scan-and-size.md)。补记 (2026-09-27): 快路径探测的平台问题收口: du 的探测路径是 POSIX 绝对路径 (`/usr/bin/du` / `/bin/du`), 在 win32 上会被解析成「当前盘根」下的 `usr\bin\du`, 那个盘上如果有同名的外来程序, 它就会被启动 (与被扫目录同盘时, 构成一条可被劫持的执行链); 基线本来就是「没有 du 的平台走纯 JS 候选」, 所以把守卫放到 `size-du.ts` 的 `findDu` (win32 一律返回 null), 与行为契约 EC-03 的「du 快路径仅 unix」对齐。
4. **入口分轨 (三入口)**: 三个入口做的是同一件事 (挑选运行时: Bun 优先 / Node 回退), 差别只在宿主环境和入口选择上: 仓库内 macOS / Linux 用 `bin/sweep-nm` (sh); 仓库内 Windows 用 `bin/sweep-nm.cmd` (cmd 包装, 不用 `readlink`); npm 安装用 `bin/sweep-nm.mjs` (package.json 的 `bin` 目标, 同时兼顾 Unix 与 Windows, shebang 固定 node, 包管理器生成的 shim 也指向它), 这个入口还多一道判断: 优先跑编译产物 `dist/cli.js`, 没有产物就回退源码 `src/cli.ts` (包内只有产物, 开发态通常无产物, 见 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md))。Windows 相关的几项 (cmd 启动器实跑 / shim 兼容) 都还没经过真机验证 `[证据缺口]`, 等真机测试时补验; 这个缺口的适用范围现在也包括 npm 安装路径 (`bin/sweep-nm.mjs` 在 Windows 上由 npm 的 cmd-shim 负责调起); 补记 (2026-09-26): 本条的「优先跑 `dist/cli.js`」现在加了一道产物自证 (必须和随附 `dist/manifest.json` 里的摘要对得上, 缺失或对不上就拒收产物并给出指引, 不会悄悄回退到源码), 判定与构建侧的清单见 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md) 补记。补记 (2026-09-27): 三个入口在找运行时 (bun / node) 时, 统一把「当前工作目录」排除在外: Windows 上 CreateProcessW 的搜索序把当前目录排在 PATH 之前 (官方文档: 搜索序第 2 位即 the current directory for the parent process), Node 走的 libuv 同样受 NeedCurrentDirectoryForExePathW 控制, 先试 cwd 再扫 PATH, 而本包恰好就在被扫目录里跑, 目录里放一个同名的 `bun.exe` / `bun.com`, 就能顶替真实运行时。具体做法: `bin/sweep-nm.mjs` 在 win32 下先按 PATH 解析出绝对路径 (空条目和相对条目会跳过, 这两者在 Windows 上都代表当前目录), 然后再探测和执行; `bin/sweep-nm.cmd` 改用 for 的 PATH 展开修饰符 (只搜 PATH); `bin/sweep-nm` (sh) 的 `command -v` 与 `exec` 本来就只按 PATH。这次审计还带出了同类修复, 见决策第 3 条补记 (du 探测的平台守卫)。win32 解析防御的实跑验证, 也还落在本条「真机未验」缺口 `[证据缺口]` 的适用范围内。另登记 (2026-09-27): npm 在 Windows 上生成的 cmd-shim (`.bin` 下的 `.cmd`, 由 npm 内置的 cmd-shim 模板生成) 在同目录没有 `node.exe` 时, 会用不带路径的 `node` 去调起本包入口, 这属于包管理器的产物 (不是本仓的三个入口), 也不在本仓的解析防御范围内。另登记 (2026-09-27): 三个入口搜索候选名的粒度在 win32 上并不一致: `bin/sweep-nm.cmd` 是扩展名优先 (`.com` 扫完全部 PATH 目录后再试 `.exe`), libuv 与 `bin/sweep-nm.mjs` 在 win32 上的解析是目录优先 (逐目录内先 `.com` 再 `.exe`); 两边候选集 (`.com` / `.exe`) 与扩展名的先后顺序都一致, 只有多个 PATH 目录里分别放着不同扩展名的 bun / node 时, 两个入口才可能选到不同的二进制 (cmd 侧的注释已同步改准)。
5. **终端能力降级**: 颜色在非 TTY / `NO_COLOR` / 能力不足的终端上降级为纯文本, 着色与行结构不丢失 (清单与 `config` 子命令的 `▍` / `░` 字符保留, 只去掉色码); 按设计只在真终端出现的内容 (顶栏的运行时自述与名单回执、`init` 向导的整条交互路径) 不属于降级范围: 非 TTY 下不会以降级形态出现; 向导这边更严: 入口就要求 TTY, 非 TTY 下 `init` 报错退出, 退出码 1, 所以「非 TTY 零 ANSI」对向导实际上是「非 TTY 没有这个形态」; 补记 (2026-09-24): 向导视觉规范升级没有新增降级分支, 与既有承诺的边界就到这里。视觉规范见 [命令面与输出](../../../sweep-node-modules-cli/docs/designs/cli-surface.md)。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 一次实现, 三平台可用; 平台差异集中在少数适配点 (路径解析 / 包含关系判定 / 入口 / 颜色), 可审查、可测试;
- 纯实现基线让核心逻辑不依赖任何平台命令, 跨平台行为可预测。

**代价**

- 体积统计失去了「平台命令」的免费加速, 得接受纯实现的性能, 或者维护双轨 (已裁定为策略 A 双轨, 见 [扫描与体积](../../../../docs/sweep/designs/scan-and-size.md));
- 入口和颜色这两层多出一档平台分支。

## 验证方式与关联引用 (Validation & References)

**验证口径 (落地后核验)**

1. 平台路径矩阵的单元测试: win32 / darwin (linux 走 unix 轨) 两套路径样本下, 配置定位与包含关系判定全绿;
2. 在非 TTY 与 `NO_COLOR` 环境下, 输出是纯文本;
3. 体积统计两个候选的基准数据已经产出 (在合成场景下, du 快路径约是纯实现的 11 倍, 两个候选的行为契约全绿); 裁定为**策略 A 双轨**, 已回写 [扫描与体积](../../../../docs/sweep/designs/scan-and-size.md)。

**关联引用**

- 双运行时与入口基线见 [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md); npm 分发入口与编译产物见 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md)。
- 视觉规范见 [命令面与输出](../../../sweep-node-modules-cli/docs/designs/cli-surface.md); 配置定位的落点见 [配置与初始化](../../../../docs/sweep/designs/config-and-initialization.md)。

> **修订指引 (2026-09-30)**: 本文 `bin/sweep-nm*` 与 `size-du.ts` 等路径还是单包时代的坐标: 启动器现在在 CLI 包 `packages/sweep-node-modules-cli/bin/` 下, `size-du.ts` 等模块在 API 包 `packages/sweep-node-modules/src/` 下 (见 [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md))。
