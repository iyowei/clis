/**
 * 本地 CI 预演 (单一入口): 与 .github/workflows/ 的 verify + conformance 两个 job 同集合 ——
 * build → typecheck → test → lint → format-check → conformance (bun + node 双 target)。
 *
 * 由来 (2026-09-29 CI 实翻): conformance 的 node target 直跑 CLI 源码时按 package.json 的
 * exports 解析到 API 包的 dist, 而 node 不读 tsconfig paths (bun 独有) —— 缺构建产物时
 * 57 条用例全数 ERR_MODULE_NOT_FOUND, 且本地此前只跑过 bun target, 直到推送后 CI 才暴露。
 * 本脚本把「推前必跑」固化为可执行入口: 手动预演即 `bun run ci`, lefthook 的 pre-push
 * 亦按同集合逐项调用 (conformance 步通过 --conformance 复用本文件)。
 *
 * 用法: bun scripts/ci.ts               # 全链
 *       bun scripts/ci.ts --conformance # 只跑 conformance 双 target (pre-push 复用)
 * 退出码: 0 全绿; 其余为首个失败步骤的退出码。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

process.chdir(join(import.meta.dir, '..'));

/** 跑一步 (stdio 透传), 失败即携其退出码终止 */
const step = (label: string, command: string, args: string[]): void => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

/** conformance 双 target: bun 与 node 的解析链不同 (node 不读 tsconfig paths), 两者都要跑 */
const conformance = (): void => {
  for (const runtime of ['bun', 'node']) {
    step(`conformance (${runtime})`, 'bun', [
      'scripts/transcription/run-conformance.ts',
      '--target',
      `${runtime} packages/sweep-node-modules-cli/src/cli.ts`,
    ]);
  }
};

if (process.argv.includes('--conformance')) {
  conformance();
} else {
  step('build', 'bun', ['run', 'build']);
  step('typecheck', 'bunx', ['turbo', 'run', 'typecheck']);
  step('test', 'bunx', ['turbo', 'run', 'test']);
  step('lint', 'bunx', ['oxlint']);
  step('format-check', 'bunx', ['prettier', '--check', '.']);
  conformance();
}
process.stdout.write('\nCI 预演全绿 ✓\n');
