/**
 * safe-install: 干净重装 — 清掉全部工作区包的可再生构建产物、派生资产、缓存与锁文件,
 * 再按 package.json 重新安装。
 *
 * 为什么: ① dist 与 assets 是构建期派生件, 陈旧产物会让入口跑到与源码不一致的字节;
 * ② 锁文件漂移或依赖树深脏时, 全量清掉可再生面再装回, 能重置回「由 package.json 唯一决定」的干净点。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listWorkspacePackages } from './lib/workspace.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

const targets: string[] = [];
for (const pkg of listWorkspacePackages(root)) {
  for (const sub of ['dist', 'assets', '.turbo']) {
    const rel = `${pkg.dir}/${sub}`;
    if (existsSync(join(root, rel))) targets.push(rel);
  }
}
for (const rootTarget of ['.turbo', 'bun.lock', 'node_modules']) {
  if (existsSync(join(root, rootTarget))) targets.push(rootTarget);
}

for (const target of targets) {
  rmSync(join(root, target), { recursive: true, force: true });
  console.log(`[safe-install] 已清理: ${target}`);
}

console.log('[safe-install] 重新安装依赖 (bun install)…');
const result = spawnSync('bun', ['install'], { cwd: root, stdio: 'inherit' });
const code = result.status ?? 1;
if (code !== 0) {
  console.error(`[safe-install] bun install 失败 (退出码 ${code})`);
  process.exit(code);
}

console.log(
  '[safe-install] 重装完成; 跑测试 / 推送前先执行 bun run build 重建全部包的 dist 与 assets',
);
process.exit(0);
