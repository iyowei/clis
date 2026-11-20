# 新抽共享库包落盘规格与仓级挂载点清单

每次决定从多包中抽离出一个名为 `@iyowei/<name>` 的本质共享库时, 须在本仓按以下规范完整建立 `packages/<name>/` 并同步全部仓级挂载点。

## 一、包目录最小完备结构

```text
packages/<name>/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── README.md
├── scripts/
│   └── build.ts
└── src/
    ├── index.ts
    └── <module>.test.ts
```

### 1. `package.json` 关键字段

参考仓内已有共享库 [cli-updater/package.json](../../../../packages/cli-updater/package.json):

- `"name"`: `"@iyowei/<name>"`
- `"private": true` (默认暂不发 npm, 等人工审校社区文档与 Trusted Publisher 准备就绪后手动移除 `private`)
- `"clisRole": "shared-lib"`
- `"type": "module"`
- `"sideEffects": false`
- `"exports"`: 指向 `"./dist/index.d.ts"` 与 `"./dist/index.js"`
- `"engines"`: `{ "node": ">=22.18.0" }`
- `"scripts"`: 必须齐备 `build` (`bun scripts/build.ts`)、`typecheck` (`bun check`)、`test` (`bun test src`)

### 2. TypeScript 配置与构建脚本

- `tsconfig.json`: 继承 `../../tsconfig.json`, `include: ["src", "scripts"]`;
- `tsconfig.build.json`: 继承 `./tsconfig.json`, `emitDeclarationOnly: true`, `declaration: true`, `rootDir: "src"`, `outDir: "dist"`, 排除 `src/**/*.test.ts`;
- `scripts/build.ts`: 参考 [cli-updater/scripts/build.ts](../../../../packages/cli-updater/scripts/build.ts), 清理 `dist/` → `bun build src/index.ts --target=node --outfile=dist/index.js` → `tsc -p tsconfig.build.json` → 将 `dist/**/*.d.ts` 中相对 `.ts` 后缀归一化为 `.js`。

### 3. 包源码、测试与文档红线

- `src/index.ts` 只导出经过本质命名与最小契约裁剪的公开类型和函数;
- 严禁出现原产品专有名词, 通过 `verify-round` 自动体检兜底;
- 至少包含 1 个只依赖抽象夹具的 `src/*.test.ts` (不在测试里反向依赖消费方产品包);
- `README.md` 面向独立社区开发者撰写安装说明、核心概念与纯调用示例, 严禁出现跨出包根 (`../`) 的相对链接 (避免触发 [lint-doc-references.ts](../../../../scripts/lint-doc-references.ts) npm 404 拦截)。

---

## 二、仓级联动挂载点 (缺一不可)

1. **根 [tsconfig.json](../../../../tsconfig.json)**: 在 `compilerOptions.paths` 新增 `"@iyowei/<name>": ["./packages/<name>/src/index.ts"]`, 保持 monorepo 开发态零构建直跑消费。
2. **模板清单 [template-manifest.ts](../../../../packages/create-clis/scripts/template-manifest.ts)**: 新增 `excl('packages/<name>/', '<一句话本质说明>')`, 保证脚手架全仓文件覆盖体检全绿。
3. **包清单登记**: 按 [package-classification.md](../../../../docs/designs/package-classification.md) 在根 [README.md](../../../../README.md)、[README.zh-CN.md](../../../../README.zh-CN.md) 与 [docs/README.md](../../../../docs/README.md) 登记一行包说明 (标明为仓内待首发/私有共享库)。
4. **消费方改造**: 在各消费包 `package.json` 添加依赖 (`"@iyowei/<name>": "workspace:*"` 或仓内一致版本格式, 若为 CLI 薄壳打包可放 `devDependencies`, 若为库对外运行时依赖则放 `dependencies`), 替换原有重复代码并清理死代码。

---

## 三、落盘后必须全绿的验证入口

通过以下指令完成包级本质闸门检查与仓库唯一权威 CI 验证:

```shell
bun .agents/skills/extract-shared-package/scripts/extract-loop.ts verify-round --round "<roundId>" --dir "packages/<name>"
```
