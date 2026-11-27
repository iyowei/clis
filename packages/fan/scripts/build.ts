/**
 * `@iyowei/fan` API 包构建脚本:
 * 清 `dist/` -> `bun build` 出 `dist/index.js` -> `tsc` 出 `.d.ts` -> 剔除内部 `smc-script.d.ts` -> 改写 `.ts` specifier -> 写 `dist/manifest.json`。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

const INTERNAL_DTS_FILES: readonly string[] = [
  'daemon-script.d.ts',
  'daemon-thermal-script.d.ts',
  'smc-script.d.ts',
];

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
  { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60_000 },
);
if (bundle.error !== undefined || bundle.status !== 0) {
  if (bundle.error !== undefined) {
    process.stderr.write(`bun build 失败: ${bundle.error.message}\n`);
  }
  process.exit(bundle.status ?? 1);
}

const types = spawnSync(
  'bun',
  ['x', '--no-install', 'tsc', '-p', join(ROOT, 'tsconfig.build.json')],
  { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60_000 },
);
if (types.error !== undefined || types.status !== 0) {
  if (types.error !== undefined) {
    process.stderr.write(`tsc 失败: ${types.error.message}\n`);
  }
  process.exit(types.status ?? 1);
}

for (const file of INTERNAL_DTS_FILES) {
  rmSync(join(DIST, file), { force: true });
}

const internalStems = INTERNAL_DTS_FILES.map((f) =>
  f.slice(0, -'.d.ts'.length),
);
for (const path of collectDtsFiles(DIST)) {
  const before = readFileSync(path, 'utf8');
  const after = before
    .replace(/(from\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
  if (after !== before) writeFileSync(path, after);
  for (const stem of internalStems) {
    if (
      new RegExp(`['"]\\.(?:\\.|[^'"]*)?/${stem}\\.(?:js|ts)['"]`).test(after)
    ) {
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
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    env: cleanGitEnv(),
  });
  return result.error === undefined && result.status === 0
    ? result.stdout.trim()
    : null;
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
