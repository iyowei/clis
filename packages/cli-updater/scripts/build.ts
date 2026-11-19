/**
 * 仓内共享自更新私有库构建脚本: 清产物 → bun build 出 ESM 产物 → tsc 出类型声明 → d.ts .ts 后缀归一化。
 * 供 Node 直跑 CLI 源码 (conformance:node) 与 TypeScript 跨包类型解析消费。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

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
  'bunx',
  ['tsc', '-p', join(ROOT, 'tsconfig.build.json')],
  { stdio: 'inherit' },
);
if (types.status !== 0) process.exit(types.status ?? 1);

for (const path of collectDtsFiles(DIST)) {
  const before = readFileSync(path, 'utf8');
  const after = before
    .replace(/(from\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
  if (after !== before) writeFileSync(path, after);
}

process.exit(0);
