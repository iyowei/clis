/**
 * Node 侧删除层直跑冒烟: `node src/delete.node-smoke.ts` (Node ≥ 22.6 类型剥离直跑 TS)。
 * 钉住 rm 阶段 ENOENT 的分桶行为 (双运行时语义分叉, 本机实测 2026-09-27):
 *   ① 顶层缺失 (父链完好、目标从未存在): rm 抛 ENOENT, 复核确认已消失 → missing (成功侧);
 *   ② 正常删除 → removed;
 *   ③ 竞态压测 (递归途中内部条目被并发删除): 不变量「missing 桶 ⟹ 目标本体真已消失」必须
 *      成立: Node 侧实测 rm 把内部条目 ENOENT 归一为成功 (不冒泡), 结果应为 removed 且
 *      目标确实消失; Bun 侧同一场景会冒泡为顶层 ENOENT 并由复核兜底归 failed (由 bun test 承载)。
 * 全通 exit 0; 有失败项则逐条打印后 exit 1 (失败响亮, 不中断以便一次看清)。
 * 命令路径为 POSIX, 只在类 Unix 环境可跑, 本机 macOS 实测。
 */
import { mkdtemp, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type RemovalResult, removeTargets } from './delete.ts';
import {
  makeWideTree,
  removeDirResilient,
  startChildRacer,
} from './fixtures.ts';

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

/** 只探存在性, 不抛 */
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const root = await realpath(
  await mkdtemp(join(tmpdir(), 'sweep-lab-node-del-')),
);

try {
  // ① 顶层缺失: 父链为真目录、目标从未存在 → missing (成功侧)
  const bare = join(root, 'bare');
  await makeWideTree(bare, 1);
  const neverHad = join(bare, 'node_modules');
  const missingRun = await removeTargets([neverHad], {
    roots: [{ configured: root, real: root }],
  });
  check(
    missingRun.missing.length === 1 && missingRun.removed.length === 0,
    '顶层缺失归 missing (成功侧)',
  );
  check(missingRun.failed.length === 0, '顶层缺失不产生 failed');

  // ② 正常删除
  const okTarget = join(root, 'app', 'node_modules');
  await makeWideTree(okTarget, 8);
  const okRun = await removeTargets([okTarget], {
    roots: [{ configured: root, real: root }],
  });
  check(okRun.removed.length === 1, '正常删除归 removed');
  check(!(await exists(okTarget)), '正常删除后目标确实不在了');

  // ③ 竞态压测: 递归途中内部条目持续消失, 不变量必须成立
  const rounds = 6;
  const buzz = { removed: 0, missing: 0, failed: 0, falseSuccess: 0 };
  for (let round = 0; round < rounds; round += 1) {
    const target = join(root, `race-${round}`, 'node_modules');
    await makeWideTree(target, 120);
    const stop = startChildRacer(target);
    let result: RemovalResult;
    try {
      result = await removeTargets([target], {
        roots: [{ configured: root, real: root }],
      });
    } finally {
      // 等跑者真正退出 (含 in-flight rm 落定): 不等就进入后续清理, 并发会让 rm 静默半途而废
      await stop();
    }

    if (result.removed.length > 0) buzz.removed += 1;
    if (result.missing.length > 0) buzz.missing += 1;
    if (result.failed.length > 0) buzz.failed += 1;
    // 不变量: missing 是成功侧 (计 ✓ 与退出码 0), 只有目标本体真已消失才可归入
    for (const item of result.missing) {
      if (await exists(item)) {
        buzz.falseSuccess += 1;
        console.error(`  伪成功样本: ${item} 仍存在却归 missing`);
      }
    }
  }
  console.log(
    `[竞态观测·node] ${rounds} 轮: removed ${buzz.removed} / missing ${buzz.missing} / failed ${buzz.failed}`,
  );
  check(
    buzz.falseSuccess === 0,
    '竞态压测: 无「目标仍在却归 missing」的伪成功',
  );
  check(
    buzz.failed === 0,
    'Node 侧竞态不产生 failed (rm 内部归一为成功, 实测形态)',
  );
} finally {
  // 自愈式清理: 残留降级为警告, 不抛断收尾 (见 removeDirResilient)
  await removeDirResilient(root);
}

if (failures.length > 0) {
  console.error(`node delete smoke: ${failures.length} 项失败`);
  process.exit(1);
}

console.log('node delete smoke: 全部通过');
