# `@iyowei/cli-updater`

> 仓内私有共享库 (`"private": true`, `"clisRole": "shared-lib"`, 不单独发布到 npm)。

零外部依赖的跨包管理器自更新引擎, 由本仓全部 CLI 包 (`@iyowei/sweep-cli`、`@iyowei/codd-cli`、`create-clis`) 通过 `devDependencies` 引入并在构建期全量内联进各自单文件产物 (`dist/cli.js` / `dist/create-clis.js`), 统一承载 `update` 子命令。

## 核心能力与安全防线

- **跨安装器识别**: 自动识别 `bun`、`npm`、`pnpm`、`yarn`、`volta` 与临时执行源 (`npx`/`bunx`/`pnpm dlx`/`yarn dlx`/`deno`) 及本地源码工作树;
- **隔离执行**: 子进程强制在独立临时空目录执行, 隔绝当前工作目录的 `.npmrc` / `.yarnrc.yml` / `bunfig.toml` 污染; PATH 仅按绝对目录解析防 cwd 劫持; Windows 优先直调 `node.exe` + JS 入口规避 `.cmd` 壳层风险;
- **静默捕获与进度接管**: 默认异步捕获 (64 KiB 环形尾部防 OOM) + TTY 旋转指示器, 失败展开净化后的底层日志, 传 `--verbose` 实时透传原始输出。

## 主要导出

入口为 `src/index.ts` (编译产物 `dist/index.js` + `dist/index.d.ts`):

- `runSelfUpdate(options)`: `update` 子命令主编排入口;
- `parseUpdateArgs` / `formatUpdateHelp`: `update` 参数解析与帮助文案;
- `detectInstallOrigin` / `buildUpgradePlan` / `executeUpgradePlan` / `executeUpgradePlanAsync`: 探测与升级原语;
- `fetchLatestVersion` / `resolveRegistry` / `compareSemver`: 远端版本查询与 semver 比较。
