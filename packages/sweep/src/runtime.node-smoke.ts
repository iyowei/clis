/**
 * Node 侧直跑冒烟脚本 (验证 runtime.ts 在 Node >= 22.18 类型剥离直跑下全部行为一致, 不进发行包)。
 * 上下游: 消费 `./runtime.ts`, 手动或 CI 执行 `node packages/sweep/src/runtime.node-smoke.ts`。
 * 验证项: `isBun === false` / 临时文件读写往返 / `spawnCapture` (经 `process.execPath` 测正常输出、非零退出码与命令不存在)。
 * 核心红线: 全通 exit 0; 有失败项不提前中止, 全部打印后统一 exit 1, 临时文件在 finally 清理。
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isBun, readTextFile, spawnCapture, writeTextFile } from './runtime.ts';

const failures: string[] = [];

/** 记录单条检查结果; 不中断执行, 收尾统一判定退出码 */
function check(ok: boolean, label: string): void {
  if (ok) {
    console.log(`ok: ${label}`);
    return;
  }

  failures.push(label);
  console.error(`FAIL: ${label}`);
}

check(!isBun, 'isBun 为 false (Node 运行时)');

const path = join(tmpdir(), `sweep-lab-node-smoke-${process.pid}.txt`);
const text = '第一行\n第二行: 中文\n';
try {
  await writeTextFile(path, text);
  check((await readTextFile(path)) === text, '读写往返一致');
} finally {
  await rm(path, { force: true });
}

const echo = await spawnCapture(process.execPath, [
  '-e',
  'process.stdout.write("hi\\n")',
]);
check(
  echo.stdout === 'hi\n' && echo.exitCode === 0,
  'spawnCapture 正常命令 (stdout 与 exit 0)',
);

const failed = await spawnCapture(process.execPath, ['-e', 'process.exit(3)']);
check(failed.exitCode === 3, 'spawnCapture 非零退出码原样返回, 不抛错');

let missingThrew = false;
try {
  await spawnCapture('sweep-lab-no-such-cmd-xyz', []);
} catch (err) {
  missingThrew =
    err instanceof Error && err.message.includes('sweep-lab-no-such-cmd-xyz');
}
check(missingThrew, 'spawnCapture 命令不存在抛含命令名的错误');

if (failures.length > 0) {
  console.error(`node smoke: ${failures.length} 项失败`);
  process.exit(1);
}

console.log('node smoke: 全部通过');
