/**
 * safe-install: 干净重装 — 清掉可再生的构建产物与锁文件, 再按 package.json 重新安装。
 *
 * 为什么: ① dist 是带"身份绑定"的构建产物 (见 ADR 0009), 陈旧产物会让入口优先跑到
 * 与源码不一致的字节; ② 锁文件漂移或手改后, 声明与实装可能脱钩。两步合起来把依赖态
 * 重置回"由 package.json 唯一决定"的干净点。
 * 形态参考个人项目 buffett 的 `safe-install` (`clean report dist bunlock && bun i`);
 * 这里以仓库内实现替代其全局 `clean` 工具, 保持本仓库对贡献者零私有依赖。
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * 本仓的可再生面: 构建产物、锁文件与依赖树本身
 * (与 buffett `clean` 的 `dist` / `bunlock` / `modules` 任务对应; 树小, 连树清才修得掉
 * bun install 只对齐、修不了的深脏: 被改过的包内容、平台错配残留等)
 */
for (const target of ['dist', 'bun.lock', 'node_modules']) {
  rmSync(`${root}${target}`, { recursive: true, force: true });
  console.log(`[safe-install] 已清理: ${target}`);
}

console.log('[safe-install] 重新安装依赖 (bun install)…');
const result = spawnSync('bun', ['install'], { cwd: root, stdio: 'inherit' });

console.log(
  '[safe-install] dist 已清; 跑测试 / 推送前先 bun run build 重建产物',
);
process.exit(result.status ?? 1);
