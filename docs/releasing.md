# npm 发布与新包首发操作指南

> 文档类型: 仓库级维护者实操手册 (Release Runbook)
> 适用对象: 本仓维护者与 AI Agent
> 机制背景与设计依据见 [开发指南](development.md)「发布」章、[包分类与发布协议](designs/package-classification.md) 与 [ADR 0009](adrs/0009-npm-distribution-form.md)。

---

## 1. 两条发布路径总览

本仓使用 `.github/workflows/release.yml` + `@lidofinance/multi-semantic-release` + npm **OIDC Trusted Publishing** 免密钥自动发布 (不长期存放 `NPM_TOKEN`), 在每次发布前先复用 `.github/workflows/ci.yml` 的全套三平台门禁 (`verify` Linux / `verify-windows` Windows / `conformance` macOS), 通过后需人工在 GitHub Actions `environment: release` 批准才会触发发版。

按包是否已经在 npm 上存在过, 分两条路径:

- **路径 A (日常迭代发布)**: 包已发过至少一版 (如已发过 `1.0.0` 且 Trusted Publisher 已对齐 `iyowei/clis`), 只需按 Conventional Commits 提交并推送 `main`, 批准 GitHub Actions 即可。
- **路径 B (新包或双包首次公开发布)**: 包从未发上 npm (`npm view <pkg>` 返回 `E404`)。由于 npm 不允许对尚不存在的包预登记 Trusted Publisher, 且 `semantic-release` 首次发布固定取 `1.0.0`, 必须先手工发一次 `0.0.0-stage` 起步版 + 登记 Trusted Publisher, 再交由自动链发出正式 `1.0.0`。

> **重要**: `@iyowei/cli-updater` 这类标有 `"private": true` 与 `"clisRole": "shared-lib"` 的仓内私有共享库永远不走本指南, 不得移除 `"private": true`。

---

## 2. 前置条件与环境检查

开始发布前确认以下条件:

1. **双运行时就绪**: 本机已安装 `bun` (版本与根 `package.json` 的 `packageManager` 一致) 与 `node >= 22.18.0`。
2. **本地全绿**: 仓库工作树改动通过 `bun run ci` (或分步完成 `build` / `typecheck` / `lint` / `format-check` / `lint:refs` / `lint:examples` / `lint:deps` / `test`)。
3. **npm 账号权限 (路径 B 或修复 OIDC 时需要)**: 具备 `@iyowei` scope 发布权限与交互式浏览器 2FA / Passkey 验证环境。
4. **GitHub 审批权限**: 具备 `iyowei/clis` 仓库 `environment: release` 的部署审批权限。

---

## 3. 路径 A: 日常版本迭代发布

适用于已经在 npm 上完成首发的非 `private` 包 (例如 `@iyowei/codd`、`@iyowei/codd-cli`、`create-clis` 及完成首发后的 `@iyowei/fan` / `@iyowei/fan-cli`):

1. **按 Conventional Commits 编写提交**:
   - `fix(...)`: 触发 patch 升级 (`1.0.0 -> 1.0.1`)
   - `feat(...)`: 触发 minor 升级 (`1.0.0 -> 1.1.0`)
   - `feat!:` 或正文含 `BREAKING CHANGE:`: 触发 major 升级 (`1.0.0 -> 2.0.0`)
   - `chore:` / `docs:` / `test:` / `refactor:`: 不触发版本号递增
2. **本地预演检查 (push 前必过)**:
   ```shell
   bun run format
   bun run ci
   ```
3. **推送至 `main`**:
   ```shell
   git push origin main
   ```
   (本仓 `lefthook.yml` 会在 `pre-push` 自动再跑一遍 `bun scripts/ci.ts`。)
4. **GitHub Actions 批准**:
   - 打开仓库 GitHub **Actions** -> 找到本次推送对应的 `CI & Release` run;
   - 等待 `checks` (`verify` / `verify-windows` / `conformance`) 全部通过;
   - 进入 `release` job -> 点击 **Review deployments** -> 勾选 `release` -> **Approve and deploy**;
   - 批准后自动完成: `npm-trust` OIDC 预检 -> `prepublishOnly` (`build && verify:release`) -> npm 发布 (带 provenance 签名) -> 打 `<pkg>@<version>` git tag -> 建 GitHub Release -> 回写 `CHANGELOG.md`。

---

## 4. 路径 B: 新包 (或双包) 首次公开发布

以双包产品 `@iyowei/<name>` + `@iyowei/<name>-cli` 为例 (单包 CLI 同理, 只需操作单个包)。

### 4.1 解除仓内待首发隔离并同步文档

1. 编辑两个包的 `package.json`:
   - 移除 `"private": true`;
   - 保留 `"version": "1.0.0"` 与:
     ```json
     "publishConfig": {
       "access": "public",
       "registry": "https://registry.npmjs.org/"
     }
     ```
2. 补齐两个包的 `README.md` / `README.zh-CN.md`:
   - 添加 `npm version` 与 `npm downloads` 徽章;
   - 去掉待首发 `private: true` 声明, 补全 `npm install` / `bun add` / `bunx` / `npx` 安装命令;
   - 严禁出现逃出包目录的相对链接 (`../`), 引用仓内深层文档一律使用 `https://github.com/iyowei/clis/blob/main/...` 绝对 URL (`lint:refs` 会拦截)。
3. 同步仓级清单文档:
   - [README.md](../README.md) / [README.zh-CN.md](../README.zh-CN.md)
   - [CONTRIBUTING.md](../CONTRIBUTING.md) / [CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md)
   - [SECURITY.md](../SECURITY.md)
   - [docs/README.md](README.md)

### 4.2 本地验证并将目标改动干净提交到 `main`

确认格式、门禁与打包白名单全部通过, 再提交到本地 `main` (先不要 `git push`):

```shell
bun run format
bun run ci
git status --short
git add .
git commit -m "feat(<name>): prepare public npm release"
```

### 4.3 交互登录 npm

```shell
npm adduser --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

> 说明: npm CLI 默认官方源域名就是 `https://registry.npmjs.org/` (`www.npmjs.com` 是网页站点域名)。各包 `publishConfig.registry` 与 [npm-trust-guard.ts](../scripts/npm-trust-guard.ts) 的 OIDC audience 均绑定 `registry.npmjs.org`, 请直接按该地址登录。

### 4.4 通过临时干净 Worktree 发布 `0.0.0-stage` 起步版

为什么必须这样做:

- `semantic-release` 首次发布固定发布 `1.0.0` (不支持自定义起始版本)。如果人工先发 `1.0.0` 且不打 tag, 自动链会因 npm 拒绝覆盖已发布的 `1.0.0` 而失败; 如果先发 `0.0.0-stage` 到 `stage` dist-tag, 既让包名在 npm 上建档成功, 又不会占用 `1.0.0` 与 `latest`!
- 各包的 `prepublishOnly` 会执行 `verify:release`, 严格要求当前 git 工作树彻底干净且 `dist/manifest.json` 与当前 `HEAD` 一致。直接在 `main` 临时改版本号会导致工作树变脏被拒发, 改用临时分离 `worktree` 最稳妥:

```shell
# 1. 基于当前干净的 main HEAD 创建临时 worktree
git worktree add --detach /tmp/clis-stage HEAD
cd /tmp/clis-stage
bun install --frozen-lockfile

# 2. 仅在该临时 worktree 中把待首发包的 version 改为 0.0.0-stage 并做本地临时提交
#    以 <pkg1> 与 <pkg2> 替换为实际包目录, 例如 packages/fan 与 packages/fan-cli
node -e '
const fs = require("node:fs");
for (const p of ["packages/<api-pkg>/package.json", "packages/<cli-pkg>/package.json"]) {
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  pkg.version = "0.0.0-stage";
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
}
'
git commit -am "chore: temp 0.0.0-stage bootstrap"

# 3. 依次发布起步版 (触发各自 prepublishOnly 全套验证), 不打任何 git tag
(cd packages/<api-pkg> && npm publish --tag stage --access public --registry=https://registry.npmjs.org/)
(cd packages/<cli-pkg> && npm publish --tag stage --access public --registry=https://registry.npmjs.org/)

# 4. 删除临时 worktree, 回到干净的 main
cd /Users/iyowei/workspace/self/development/clis
git worktree remove --force /tmp/clis-stage
```

> 切勿在 git 仓库为 `0.0.0-stage` 创建或推送任何 git tag (`docs/development.md` §发布 已验证补 tag 交接会干扰版本计算)。

### 4.5 登记 npm Trusted Publisher (OIDC)

包在 npm 存在之后, 立即为每个新包绑定 GitHub Actions Trusted Publisher (按提示回车并在浏览器完成一次性验证):

```shell
npm trust github @iyowei/<api-pkg> \
  --file release.yml \
  --repo iyowei/clis \
  --env release \
  --allow-publish \
  --registry=https://registry.npmjs.org/

npm trust github @iyowei/<cli-pkg> \
  --file release.yml \
  --repo iyowei/clis \
  --env release \
  --allow-publish \
  --registry=https://registry.npmjs.org/
```

全部登记完成后, 用仓内对账脚本核对仓内所有非 `private` 包是否均已对齐:

```shell
bun scripts/npm-trust-guard.ts check
```

### 4.6 推送 `main` 并批准 `release` 完成 `1.0.0` 正式首发

```shell
git push origin main
```

推送后到 GitHub Actions `CI & Release` 观察:

1. `checks` 三个前置 job (`verify` / `verify-windows` / `conformance`) 全绿;
2. 在 `release` job 处点击 **Review deployments -> Approve and deploy**;
3. 等待 `npm-trust` 与 `Release (multi-semantic-release, OIDC)` 完成;
4. 验证正式版本已切换为 `1.0.0`:

```shell
npm view @iyowei/<api-pkg> version dist-tags --registry=https://registry.npmjs.org/
npm view @iyowei/<cli-pkg> version dist-tags --registry=https://registry.npmjs.org/
```

---

## 5. 常见故障与排查

| 现象 / 报错                                       | 真因                                                                           | 处置方式                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `npm trust github` 报 404                         | 目标包名还从未在 npm 发布过                                                    | 先按 `4.4` 发一版 `0.0.0-stage` 再执行 `npm trust github`                                                      |
| `verify:release` 拒发: `工作树不干净` / 摘要不符  | 工作区有未提交改动或 `dist/manifest.json` 指向旧 commit                        | 保证发布前所有改动已提交, 或使用 `4.4` 临时干净 `worktree` 方案                                                |
| `npm adduser` 后 `npm publish` 仍报 `ENEEDAUTH`   | 登录时的 `--registry` 与包 `publishConfig.registry` 域名不一致 (`.com`/`.org`) | 统一使用 `--registry=https://registry.npmjs.org/` 登录并确认 `~/.npmrc` 存在对应条目                           |
| `release` job 报 `npm-trust` 失败或 `ENONPMTOKEN` | 仓库改名、workflow 文件名或 `environment` 与 npm 侧登记不一致, 或漏配包登记    | 在本机跑 `bun scripts/npm-trust-guard.ts check` 查看差异, 或按提示跑 `bun scripts/npm-trust-guard.ts fix` 修复 |
| 推送 `main` 后 `release` job 被跳过未进审批       | `.github/workflows/release.yml` 的 `checks` (`verify-windows` 等) 未全绿       | 点进失败的 `checks` job 查看具体报错 (即使是其它 workspace 包的兼容用例挂红也会阻塞整条发布链)                 |
| `npm pack` 打包多出 `README*.bak` 或备份文件      | npm 会强制打包包根目录的 `README*` / `LICENSE*` 文件                           | 备份一律放在仓库外 `~/tmp/repo_backups/`, 切勿留在 `packages/*/` 下 (`bun run lint:backups` 会拦截)            |
