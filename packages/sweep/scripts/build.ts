/**
 * `@iyowei/sweep` API 包构建脚本 (由 `package.json` 的 `build` / `prepublishOnly` 调用)。
 * 上下游: 依赖根仓 `scripts/lib/git-env.ts` 隔离 git 环境变量; 产出的 `dist/` 与 `dist/manifest.json` 交由 `scripts/verify-release.ts` 验收。
 * 核心红线: 全量清空 `dist/` 后重建, 剔除 14 个内部 `.d.ts` 并拦截引用泄漏, 确定性改写相对 `.ts` specifier 为 `.js` (兼容消费方 TS)。
 * 说明: typescript 7.0.2 的 `rewriteRelativeImportExtensions` 在本配置 declaration emit 下未生效, 故第 4 步对
 * `from '...'` / `import '...'` / `import('...')` 三种相对 `.ts` specifier 做幂等后处理。
 *
 * ### 数据流转示例
 * - Input: `src/index.ts` + `tsconfig.build.json` + git HEAD/status
 * - 流程: 1. 清 `dist/` -> 2. `bun build` 出 `dist/index.js` -> 3. `tsc` 出 `.d.ts` -> 3.5 删 14 个内部 `.d.ts`
 *   -> 4. 改写三种 `.ts` specifier 为 `.js` 并校验零内部模块泄漏 -> 5. 算 `index.js` sha256 写 `dist/manifest.json`
 * - Output: 仅含 `index.js`、`manifest.json` 与 18 个公开 `.d.ts` 的纯净 `dist/` 目录 (任一步失败即非零退出)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

/** 14 个非公开内部实现模块产出的 .d.ts (不被 index.d.ts 链引用, 清理出发行面) */
const INTERNAL_DTS_FILES: readonly string[] = [
  'config-validate.d.ts',
  'delete-review.d.ts',
  'guard-device.d.ts',
  'runtime.d.ts',
  'scan-match.d.ts',
  'scan-native.d.ts',
  'scan-parallel.d.ts',
  'scan-prune.d.ts',
  'scan-roots.d.ts',
  'size-du-parse.d.ts',
  'size-du.d.ts',
  'size-js.d.ts',
  'stale.d.ts',
  'sweep-options.d.ts',
];

/** 递归收集目录下全部 .d.ts 文件的绝对路径 */
function collectDtsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectDtsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

// 1. 清产物: 整目录重建, 防上一轮构建的残留文件混进发布包 (files 白名单整目录进包)
rmSync(DIST, { recursive: true, force: true });

// 2. JS 产物: 单文件 bundle, node 目标 (标准 ESM, bun 与 node 双运行时均可)
const bundle = spawnSync(
  'bun',
  [
    'build',
    join(ROOT, 'src/index.ts'),
    '--target=node',
    `--outfile=${join(DIST, 'index.js')}`,
  ],
  { stdio: 'inherit' },
);
if (bundle.status !== 0) process.exit(bundle.status ?? 1);

// 3. 类型声明: 独立 tsconfig (emitDeclarationOnly; 测试 / smoke / fixtures 已在 exclude)
const types = spawnSync(
  'bun',
  ['x', '--no-install', 'tsc', '-p', join(ROOT, 'tsconfig.build.json')],
  {
    stdio: 'inherit',
  },
);
if (types.status !== 0) process.exit(types.status ?? 1);

// 3.5 清理 14 个内部实现 .d.ts (公开模块直接 import 的内部实现仍会被 tsc 跟随 emit, 但公开类型面零引用)
for (const file of INTERNAL_DTS_FILES) {
  rmSync(join(DIST, file), { force: true });
}

// 4. d.ts specifier 后处理 (递归覆盖 dist/ 全树, 匹配 from / import / import('...') 三种形态)
const dtsFiles = collectDtsFiles(DIST);
const internalStems = INTERNAL_DTS_FILES.map((f) =>
  f.slice(0, -'.d.ts'.length),
);
for (const path of dtsFiles) {
  const before = readFileSync(path, 'utf8');
  const after = before
    .replace(/(from\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
  if (after !== before) writeFileSync(path, after);
  // 防御自检: 确认剩余公开 .d.ts 未引用任何已被清理的内部模块
  for (const stem of internalStems) {
    if (new RegExp(`['"]\\./${stem}\\.(?:js|ts)['"]`).test(after)) {
      process.stderr.write(
        `构建失败: ${path} 仍引用了被排除的内部模块 ${stem}\n`,
      );
      process.exit(1);
    }
  }
}

// 5. 自证清单: 记录入口产物摘要与 git 事实, 发布闸门据此核对「产物出自本提交」。
//    非 git 检出时如实记 null (不拒绝构建); env 经 cleanGitEnv 防 git 钩子坐标劫持。
const gitText = (args: string[]): string | null => {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  return result.status === 0 ? result.stdout.trim() : null;
};
const head = gitText(['rev-parse', 'HEAD']);
const status = gitText(['status', '--porcelain']);
writeFileSync(
  join(DIST, 'manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      entry: 'index.js',
      entrySha256: createHash('sha256')
        .update(readFileSync(join(DIST, 'index.js')))
        .digest('hex'),
      commit: head,
      dirty: status === null ? null : status.length > 0,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

process.exit(0);
