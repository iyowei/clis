<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 仓库导航 (供 AI Agent 与人类读者)

> 本仓库是 CLI 工具集合仓 (仓库名 `iyowei/clis`; 边界与结构见 [集合仓定位](docs/designs/collection-positioning.md))。文档采用极简两级结构 (见 [文档分层协议](docs/designs/docs-layering.md) 与 [ADR 0019](docs/adrs/0019-two-tier-package-owned-docs.md))。

## 文档分层与读取路径

- **仓库级文档 (`docs/`)**: 纯工程治理与脚手架机制, 从 [文档总索引](docs/README.md) 进; 仓库级设计入口是 [设计文档索引](docs/designs/README.md), 仓库级工程 ADR 入口是 [docs/adrs/README.md](docs/adrs/README.md);
- **包级 / 产品文档 (`packages/<pkg>/docs/`, 按需创建)**: 每个工具产品的整体设计、协议套件与产品 ADR 全部内聚在其主包 (API 包) 下 (`packages/sweep/docs/README.md`、`packages/codd/docs/README.md`); CLI 薄壳从包按需仅保留命令面契约 (`packages/sweep-cli/docs/README.md`、`packages/codd-cli/docs/README.md`), 无独立包内文档的包 (如 `create-clis`) 不建空壳目录;
- **ADR 编号全局唯一、永不重编**: 仓库级工程 ADR 留在 `docs/adrs/`, 产品 ADR 随主包住在 `packages/<pkg>/docs/adrs/`, 引用闸门联合扫描两级并拦截重号;
- **读取顺序**: 总索引 (`docs/README.md`) → 仓库级设计或对应产品主包 `packages/<pkg>/docs/README.md` → 明细。

## 结构事实

- 默认双包范式与三类包判定见 [包分类与发布协议](docs/designs/package-classification.md); 包间依赖方向由 `scripts/lint-dependency-direction.ts` 物理强制 ([依赖方向纪律](docs/designs/dependency-direction.md));
- 通用多技术栈清理器双包为 `packages/sweep` (`@iyowei/sweep`) 与 `packages/sweep-cli` (`@iyowei/sweep-cli`, 命令 `sweep`, 配置环境变量 `SWEEP_CONFIG`, 默认路径 `~/.config/sweep/config.json`, 当前均标 `"private": true` 隔离于自动发布链之外);
- **工程闸门链**: 只有一份步骤清单, 就是 `scripts/ci.ts` (本地全链、pre-push、CI 与 Release 前置门禁共用; Release 获批后额外经 `--only npm-trust` 跑 OIDC 凭据预检, 见 [开发指南](docs/development.md)「发布」章);
- **仓内确定性工程技能 (`.agents/skills/`)**: [determinism-audit](.agents/skills/determinism-audit/SKILL.md) (技能确定性审计)、[extract-shared-package](.agents/skills/extract-shared-package/SKILL.md) (跨包共享库提炼与退化回收闭环) 与 [perf-loop](.agents/skills/perf-loop/SKILL.md) (多维度性能调优闭环);
- 提交信息与发布链约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## GitHub Actions 跨平台稳定性防线 (AI Agent 必守)

> 本地 `pre-push` 仅在单一开发宿主机 (常驻热缓存的 macOS) 执行, 而远端 CI (`.github/workflows/ci.yml`) 同时在 `ubuntu-latest`、`windows-latest`、`macos-latest` 冷启动虚拟机与隔离空 `HOME` 下并发验证。所有代码与测试改动提交前必须逐条自检以下五道红线:

1. **禁止隐式绑定宿主机路径风味与平台门控 (防本地 macOS 绿、Windows/Linux 红)**:
   - 纯函数与单测一旦构造固定路径样例 (如 `/Users/demo/...` 或 `C:\Users\demo\...`), 必须显式传入对应的路径风味 (`POSIX_STYLE` / `WIN32_STYLE` 或 `path.posix` / `path.win32`), 严禁依赖宿主默认 `process.platform` 或裸调 `path.normalize` 处理跨平台字符串;
   - 仅特定 OS 支持的硬件或守护能力 (如 macOS AppleSMC / `LaunchDaemon`), 业务入口必须允许通过参数注入 (`platform` / `transport` / `persistOps`) 解耦宿主平台判定, 真实宿主机黑盒测试须按平台条件守卫 (`process.platform === 'darwin'`);
2. **隔离家目录必须覆盖 Windows 全套环境变量与大小写回退**:
   - Windows 下 `os.homedir()` 读 `USERPROFILE`, 应用配置读 `APPDATA` / `LOCALAPPDATA`, 且环境变量名存在 `PATH`/`Path`、`ComSpec`/`COMSPEC` 差异 (空串不得阻断备选变量回退);
   - 任何单测或 E2E 子进程重写 `HOME` 隔离配置状态时, 必须同步设置 `USERPROFILE: home`、`APPDATA: join(home, 'AppData', 'Roaming')`、`LOCALAPPDATA: join(home, 'AppData', 'Local')` 与 `XDG_CONFIG_HOME: join(home, '.config')`, 严防穿透 runner 真实目录或跨测试文件串扰;
3. **敬畏 CI 冷启动 VM 与高并发 I/O 开销 (严禁裸奔 5000ms 默认超时)**:
   - GitHub Actions 虚拟机无热缓存且 `turbo run test` 多包并发争抢 3~4 核 CPU: macOS `/usr/bin/make` 等 `xcrun` 代理壳层在隔离空 `HOME` 下首次冷启动扫描 Xcode 可能超过 `5s`, `hdiutil`、`npm pack`、多轮子进程 E2E 同样存在秒级波动;
   - 测试调用系统工具时优先直调原生二进制 (如存在时优先取 `/Library/Developer/CommandLineTools/usr/bin/make`) 或注入内存桩; 凡派生外部进程的单测与钩子必须显式声明充裕超时 (`20_000`~`60_000ms`), `spawnSync` 必须带 `timeout` 与非交互 `stdio` (`stdin: 'ignore'`) 防止挂死;
4. **消除环境隐式状态依赖 (Locale / TTY / 外网 / 本机配置)**:
   - CI runner 默认无 TTY、英文或 `C.UTF-8` locale 且公网受限: 涉及多语言文案或系统命令输出 (`du` 等) 的测试必须显式固定语言环境 (如 `CLIS_TEST_OS_LOCALE` / `LC_ALL`), 屏蔽开发者本机 `~/.config/<tool>/` 真实配置干扰, 且单测严禁依赖真实外网请求;
5. **严守 `--frozen-lockfile` 与脚手架清单联动**:
   - CI 全任务强制执行 `bun install --frozen-lockfile`: 每次新增/修改任意 `package.json` 或拉取 `semantic-release` 自动回推的 `chore(release): ... [skip ci]` 版本提交后, 必须执行 `bun install` 校验并同步提交 `bun.lock`;
   - 新增仓内包、顶层配置或文档时, 必须同步登记 `packages/create-clis/scripts/template-manifest.ts` 与 `docs/README.md` 入链, 并遵守仓库中文工程文档半角标点规范 (跑通 `bun scripts/lint-doc-references.ts`)。
