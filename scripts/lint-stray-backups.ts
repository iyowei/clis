/**
 * 仓库卫生闸门: 工作树内不得出现备份文件 (*.modified / *.deleted)。
 *
 * 动机: 备份纪律要求备份落 ~/tmp (ADR 0009 补记), 但 2026-09-30 漂移清偿时实测工作树内
 * 散落 7 个 .modified: 它们被 .gitignore 忽略、git status 看不见, 却不属于仓库; 包目录
 * 下的备份还会借 npm pack 的 README* 强制收录规则混进发行物 (既有的「包根杂质常驻回归」
 * 只兜包目录)。本闸门做全树兜底: 出现即红灯, 把清理成本压回发生的那一刻。
 *
 * 判据: 全树走查中文件名以 .modified / .deleted 收尾者 (共享跳过面之外的任何位置)。
 *
 * 用法: bun scripts/lint-stray-backups.ts
 * 退出码: 0 无散落; 1 有散落 (逐条打印路径)。
 */
import { REPO_ROOT, walkFiles } from './lint-doc-shared.ts';

/** 备份后缀: 与宪法「修改前置备份」的命名收尾一致 */
const BACKUP_SUFFIXES = ['.modified', '.deleted'] as const;

/** 全树找出散落备份 (相对路径, 供测试注入临时根) */
export function findStrayBackups(root: string = REPO_ROOT): string[] {
  return walkFiles(root, BACKUP_SUFFIXES);
}

/** 主流程: 打印散落清单并以退出码收口 (0 无散落 / 1 有散落) */
function main(): void {
  const strays = findStrayBackups();
  if (strays.length === 0) {
    process.stdout.write('仓库卫生闸门全绿 ✓ (无散落 .modified / .deleted)\n');
    return;
  }
  process.stderr.write(
    `检出 ${strays.length} 个散落备份 (备份纪律: 移出仓库至 ~/tmp/sweep_backups/, 保留相对结构):\n`,
  );
  for (const stray of strays) process.stderr.write(`  ${stray}\n`);
  process.exitCode = 1;
}

// 仅作为入口执行时跑主流程 (被 import 时不执行, 供测试)
if (import.meta.main) main();
