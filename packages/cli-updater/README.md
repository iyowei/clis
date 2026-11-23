# `@iyowei/cli-updater`

> 仓内私有共享库 (`"private": true`, `"clisRole": "shared-lib"`, 不单独发布到 npm)。

零外部依赖的跨包管理器自更新引擎, 由本仓全部 CLI 包 (`@iyowei/sweep-cli`、`@iyowei/codd-cli`、`create-clis`) 通过 `devDependencies` 引入并在构建期全量内联进各自单文件产物 (`dist/cli.js` / `dist/create-clis.js`), 统一承载 `update` 子命令。

## 核心能力与安全防线

- **跨安装器识别**: 按磁盘真实落位路径自动识别全局安装 (`bun`、`npm`、`pnpm`、`yarn`、`volta`)、临时执行源 (`npx` / `bunx` / `pnpm dlx` / `yarn dlx` / `deno`)、业务项目本地依赖 (`local-project`: 宿主目录含 `package.json` 的本地 `node_modules` 依赖, 默认拒绝静默改写业务项目锁文件并按锁文件给出项目级升级命令) 及本地源码工作树;
- **家目录源配置按管理器分流**: 严格按目标包管理器读取家目录源与同源鉴权配置 (`bun` 优先读取 `~/.bunfig.toml` 并回退 `~/.npmrc`; `npm` / `pnpm` / `yarn` / `volta` 仅读取 `~/.npmrc`, 绝不混读 `~/.bunfig.toml`; 未确定管理器时优先 `~/.npmrc` 回退 `~/.bunfig.toml`), 且绝不读取当前工作目录配置防劫持;
- **隔离执行与子进程环境净化**: 子进程强制在独立临时空目录执行 (隔绝当前工作目录的 `.npmrc` / `.yarnrc.yml` / `bunfig.toml` / `package.json` 污染), 并通过 `buildIsolatedEnv` 剥离 `npm_execpath`、`npm_lifecycle_event`、`npm_lifecycle_script`、`npm_package_json`、`INIT_CWD` 等宿主生命周期残留变量 (探测子进程额外注入 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` 防阻塞挂起); PATH 仅按绝对目录解析防 cwd 劫持; Windows 优先直调 `node.exe` + JS 入口规避 `.cmd` 壳层风险;
- **静默捕获与进度接管**: 默认异步捕获 (64 KiB 环形尾部防 OOM) + TTY 旋转指示器, 失败展开净化后的底层日志, 传 `--verbose` 实时透传原始输出。

## 主要导出

入口为 `src/index.ts` (编译产物 `dist/index.js` + `dist/index.d.ts`, 完整公开导出符号与常量以 `src/index.ts` 为准):

- `runSelfUpdate(options)` / `readPackageMeta`: `update` 子命令主编排入口与包元数据解析;
- `parseUpdateArgs` / `formatUpdateHelp`: `update` 参数解析与帮助文案;
- `detectInstallOriginFromPath` / `probeGlobalRoots` / `buildUpgradePlan` / `buildIsolatedEnv` / `executeUpgradePlan` / `executeUpgradePlanAsync`: 来源探测、全局根实查与隔离升级原语;
- `fetchLatestVersion` / `resolveRegistry` / `resolveRegistryAuthToken` / `compareSemver`: 远端版本查询、同源鉴权凭据提取与 SemVer 比较。

## 环境变量

- `NPM_CONFIG_REGISTRY` (空串或未设时自动回退 `npm_config_registry`): 覆盖默认 npm 注册表地址 (优先级低于显式 `--registry`, 高于目标包管理器对应的家目录配置);
- `VOLTA_HOME` / `BUN_INSTALL` (`BUN_INSTALL_GLOBAL_DIR`) / `PNPM_HOME` / `NPM_CONFIG_PREFIX` (空串或未设时自动回退 `npm_config_prefix`): 自定义包管理器全局安装根目录探测线索;
- `PATH` / `Path` 与 `ComSpec` / `COMSPEC` (Windows): 首选变量为空串或纯空白时自动回退备选大小写变量或默认 `cmd.exe`;
- `NO_COLOR` / `TERM=dumb`: 禁用终端 ANSI 颜色转义 (`TERM=dumb` 同时关闭 `stderr` 动态旋转指示器, 严格降级为纯文本)。
