/**
 * `@iyowei/wake` API 包构建脚本 (由 `package.json` 的 `build` / `prepublishOnly` 调用)。
 * 全量清空 `dist/` 后重建, 剔除内部模块 `relay.d.ts`, 改写相对 `.ts` specifier 为 `.js`, 并写入 `dist/manifest.json`。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

/** 非公开内部实现模块产出的 `.d.ts` (不被公开入口引用, 从发行面剔除) */
const INTERNAL_DTS_FILES: readonly string[] = ['relay.d.ts'];

function collectDtsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectDtsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

rmSync(DIST, { recursive: true, force: true });

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

const types = spawnSync(
  'bun',
  ['x', '--no-install', 'tsc', '-p', join(ROOT, 'tsconfig.build.json')],
  { stdio: 'inherit' },
);
if (types.status !== 0) process.exit(types.status ?? 1);

for (const file of INTERNAL_DTS_FILES) {
  rmSync(join(DIST, file), { force: true });
}

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
  for (const stem of internalStems) {
    if (new RegExp(`['"]\\./${stem}\\.(?:js|ts)['"]`).test(after)) {
      process.stderr.write(
        `构建失败: ${path} 仍引用了被排除的内部模块 ${stem}\n`,
      );
      process.exit(1);
    }
  }
}

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
