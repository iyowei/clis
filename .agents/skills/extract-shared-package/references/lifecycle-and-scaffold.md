# 新建规格、残余清理与退化回收命令全册

本手册为落盘格式与命令行参数清单的**单一事实来源**, 所有命令均以仓根 (或传 `--repo <dir>`) 调用 [extract-loop.ts](../scripts/extract-loop.ts)。

---

## 一、新建 `"private": true` 共享库规格 (加法模式 `--mode extract`)

### 1. 目录与 `package.json` 标准模板

```text
packages/<name>/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── README.md
├── scripts/build.ts
└── src/
    ├── index.ts
    └── index.test.ts
```

`package.json` 必须包含以下字段 (对齐本仓发布白名单约定):

- `"name"`: `"@iyowei/<name>"`, `"version"`: `"1.0.0"`, `"private": true`, `"clisRole": "shared-lib"`
- `"type"`: `"module"`, `"sideEffects": false`
- `"files"`: `["dist"]` (**必填**: 根 `.gitignore` 忽略 `dist/`, 缺失会导致 `npm pack` 丢弃构建产物)
- `"main"`: `"./dist/index.js"`, `"types"`: `"./dist/index.d.ts"` (不可直接指向 `src/`)
- `"exports"`: `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` (消费方兼容 `"default"` 或 `"import"`)
- `"engines"`: `{ "node": ">=22.18.0" }`
- `"scripts"`: `{ "build": "bun scripts/build.ts", "typecheck": "bun check", "test": "bun test src" }`

### 2. `tsconfig.build.json` 与仓级联动挂载

- `tsconfig.json`: `{ "extends": "../../tsconfig.json", "include": ["src", "scripts"] }`
- `tsconfig.build.json`: **必须显式设置 `"paths": {}` 与 `"noEmitOnError": true`** (`extends: "./tsconfig.json"`, `noEmit: false`, `emitDeclarationOnly: true`, `declaration: true`, `rootDir: "src"`, `outDir: "dist"`, `exclude: ["src/**/*.test.ts"]`)。任何依赖于该新库的现有库包若存在 `tsconfig.build.json`, 也须同步满足这两项以防 `TS6059`。
- `scripts/build.ts`: 参考同仓构建脚本, 清理 `dist/` → `bun build src/index.ts --target=node --outfile=dist/index.js` → `tsc -p tsconfig.build.json` → 将 `dist/**/*.d.ts` 相对 `.ts` 引用归一化为 `.js`。
- **仓级登记与消费切换** (若当前仓库包含以下配置文件):
  1. 根 `tsconfig.json` `compilerOptions.paths` 新增 `"@iyowei/<name>": ["./packages/<name>/src/index.ts"]`;
  2. `packages/create-clis/scripts/template-manifest.ts` 用 `exclInfra('packages/<name>/', '<本质说明>')` 登记;
  3. 根 `README.md`、`README.zh-CN.md` 与 `docs/README.md` 各补一行共享库说明, 且当新包存在 `README.md` (无独立 `docs/README.md`) 时, `docs/README.md` (及公开包的根 `README*.md`) 须包含指向该包 `README` 的 Markdown 链接 (如 `[README](../packages/<name>/README.md)` / `[README](packages/<name>/README.md)`), 防止产生零入链孤儿文档;
  4. 各消费包写精确版本号 `"1.0.0"` (禁止 `workspace:*` / `^` / `~` / `file:`): 由于新抽离共享库标 `"private": true` (`private-lib`), 根据仓库 `docs/designs/dependency-direction.md` 与 `scripts/lint-dependency-direction.ts`, 不仅打包为单文件的 CLI 消费包须写入 `devDependencies` (维持零运行时依赖), **公开库 / 双包 API 主包在构建期打包私有共享库时也必须写入 `devDependencies` (严禁写入运行期 `dependencies` / `peerDependencies` / `optionalDependencies`, 否则发布 npm 后无法解析且会被 `lint:deps` 拦截)**, 仅同为仓内不发布的私有库间引用可按需写入 `dependencies` 或 `devDependencies`; **删净原重复函数**, 执行 `bun install && bun fmt` 后再跑 `verify-round`。

### 3. 加法完整命令序列

```shell
# 1) 本质预审 (--signatures 支持分号 `;` 分隔含多参数签名)
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts check-proposal --name "@iyowei/<name>" --description "<single-sentence community essence>" --consumers "<@scope/cli-a,@scope/cli-b>" --exports "<fn1,fn2>" --signatures "fn1(a: string, b: number); propA: boolean"

# 2) 开启事务检查点 (如需中途加改其他文件, 用 backup-file 补备份)
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts begin-round --mode extract --name "@iyowei/<name>" --dir "packages/<name>" --touch "<file1,file2>"
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts backup-file --round "<roundId>" --file "<extraRelPath>"

# 3) 落地建包 + bun install + bun fmt 后整仓与打包验证
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts verify-round --dir "packages/<name>" --round "<roundId>"

# 4a) 全绿后提交关闭轮次
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts commit-round --fingerprint "<clusterFp>" --name "@iyowei/<name>" --reason "<本质定位>" --mode extract --round "<roundId>"

# 4b) 验证失败无法修复时精确回滚并暂缓
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts rollback-round --round "<roundId>"
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts reject --fingerprint "<clusterFp>" --status deferred --reason "<失败依据>"
```

---

## 二、迁移残余清理流程 (`--mode residue`)

当 `nextAction.kind === 'cleanup-residue'` 时 (严禁使用 `--mode extract` 借道备份, 否则回滚会删掉健康的新库):

```shell
# 1) 开启 residue 检查点 (仅备份待清理消费包文件, 不碰共享库目录)
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts begin-round --mode residue --name "residue-<clusterFp>" --dir "packages/<consumer>" --touch "<consumerFile1,consumerFile2>"

# 2) 删除消费包残余实现并改导新库, 跑 bun fmt 后执行残余校验
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts verify-round --dir "packages/<consumer>" --round "<roundId>" --mode residue

# 3a) 通过后提交 (清理完成后下一轮重扫会自动消除该残余项)
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts commit-round --fingerprint "<clusterFp>" --name "<@iyowei/shared-pkg>" --reason "清理迁移残余并切换导入" --mode residue --round "<roundId>"

# 3b) 若核实属非同源误报, 先 rollback-round (如有改动) 再直标 reject
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts rollback-round --round "<roundId>"
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts reject --fingerprint "<clusterFp>" --status rejected --reason "<误报说明>"
```

---

## 三、退化私库独立模块回收 (`--mode reabsorb`)

当 `nextAction.kind` 为 `reabsorb` 或 `cleanup-unused` 时:

- **单消费者回收 (`reabsorb`)**:
  - 含多文件或内部相对引用时, 必须整棵迁为独立子目录 `packages/<consumer>/src/<old-stem>/` (带统一出口 `index.ts` 与随包测试 `*.test.ts`), 外部仅从门面导入, 内部禁任何 `../` 反向逃逸;
  - 仅单文件且零相对依赖时, 可落盘为 `packages/<consumer>/src/<old-stem>.ts` + 同级 `<old-stem>.test.ts`;
  - 严禁把源码打散混入 `cli.ts`/`index.ts`/`utils.ts` 或夹带消费方业务词汇;
  - 开启 `begin-round --mode reabsorb` 时务必传 `--into "<目标路径>"`, 失败执行 `rollback-round` 时会自动连带清掉消费包内半成品子模块。
- **零消费者退役 (`cleanup-unused`)**: 跳过源码迁入, 校验时传 `--unused`。

```shell
# 1) 开启 reabsorb 原子备份 (单域回收带 --into, 零消费清理可省略 --into)
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts begin-round --mode reabsorb --name "@iyowei/<old>" --dir "packages/<old>" --into "packages/<consumer>/src/<old-stem>" --touch "<packages/consumer/package.json,consumerFiles>"

# 2) 迁入独立模块、清消费方与根级注册项 (tsconfig.json / template-manifest.ts / README*)、删除 packages/<old>/、执行 bun install && bun fmt

# 3) 独立边界与全仓门禁验证 (单文件注意路径须带 .ts; 零消费改传 --unused)
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts verify-reabsorb --name "@iyowei/<old>" --dir "packages/<old>" --into "packages/<consumer>/src/<old-stem>" --round "<roundId>"

# 4a) 全绿后提交关闭轮次
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts commit-round --fingerprint "<degenFp>" --name "@iyowei/<old>" --reason "冷却满期独立内联回收至 <consumer>" --mode reabsorb --round "<roundId>"

# 4b) 验证失败无损复原整座旧库并清除消费包半成品
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts rollback-round --round "<roundId>"
```
