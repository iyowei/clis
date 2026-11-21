/**
 * 仓内共享自更新私有库构建脚本: 清产物 → bun build 出 ESM 产物 → tsc 出类型声明 → d.ts .ts 后缀归一化。
 * 供 Node 直跑 CLI 源码 (conformance:node) 与 TypeScript 跨包类型解析消费。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

function runOrExit(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error !== undefined) {
    process.stderr.write(
      `cli-updater build: 执行 ${command} 失败: ${result.error.message}\n`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(DIST, { recursive: true, force: true });

runOrExit('bun', [
  'build',
  join(ROOT, 'src/index.ts'),
  '--target=node',
  `--outfile=${join(DIST, 'index.js')}`,
]);

runOrExit('bun', [
  'x',
  '--no-install',
  'tsc',
  '-p',
  join(ROOT, 'tsconfig.build.json'),
]);

const INTERNAL_DTS_FILES: readonly string[] = [
  'config-parse.d.ts',
  'update-flow.d.ts',
  'update-helpers.d.ts',
  'windows-exec.d.ts',
];

for (const file of INTERNAL_DTS_FILES) {
  rmSync(join(DIST, file), { force: true });
}

const internalStems = INTERNAL_DTS_FILES.map((f) => f.replace(/\.d\.ts$/, ''));
const leaked: string[] = [];

for (const path of collectDtsFiles(DIST)) {
  const before = readFileSync(path, 'utf8');
  const after = before
    .replace(/(from\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
  if (after !== before) writeFileSync(path, after);
  for (const stem of internalStems) {
    if (
      after.includes(`./${stem}.js`) ||
      after.includes(`./${stem}'`) ||
      after.includes(`./${stem}"`)
    ) {
      leaked.push(`${path} -> ${stem}`);
    }
  }
}

if (leaked.length > 0) {
  process.stderr.write(
    `cli-updater build: 公开 .d.ts 泄漏内部模块引用:\n  ${leaked.join('\n  ')}\n`,
  );
  process.exit(1);
}

process.exit(0);
