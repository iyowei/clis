/**
 * 仓库卫生闸门: 工作树内不得出现备份文件 (*.modified / *.deleted)。
 * 触发方: `scripts/ci.ts` (`lint:backups` 并行只读闸门) 或手动执行。
 *
 * 动机与判据: 备份文件被 .gitignore 忽略、git status 看不见, 落入包目录还会借 npm pack 的
 * README* 强制收录规则混进发行物 (ADR 0009 补记); 本闸门全树扫描除 SKIP_DIRS 外的所有位置
 * (含模板源码目录), 出现 .modified / .deleted 即红灯拦截。
 *
 * 用法: bun scripts/lint-stray-backups.ts
 * 退出码: 0 无散落; 1 有散落 (逐条打印路径)。
 */
import { REPO_ROOT, walkFiles } from './lint-doc-shared.ts';

/** 备份后缀: 与宪法「修改前置备份」的命名收尾一致 */
const BACKUP_SUFFIXES = ['.modified', '.deleted'] as const;

/**
 * 全树找出散落备份 (相对路径, 供测试注入临时根)。
 * 刻意传 skipPaths: []: 模板目录 (template / template-skeletons) 属源码区, 同样禁止残留备份,
 * 仅跳过 node_modules / .git / .turbo / dist / mutants 等 SKIP_DIRS。
 */
export function findStrayBackups(root: string = REPO_ROOT): string[] {
  return walkFiles(root, BACKUP_SUFFIXES, { skipPaths: [] });
}

/** 主流程: 打印散落清单并以退出码收口 (0 无散落 / 1 有散落) */
function main(): void {
  const strays = findStrayBackups();
  if (strays.length === 0) {
    process.stdout.write('仓库卫生闸门全绿 ✓ (无散落 .modified / .deleted)\n');
    return;
  }
  process.stderr.write(
    `检出 ${strays.length} 个散落备份 (备份纪律: 移出仓库至 ~/tmp/repo_backups/, 保留相对结构):\n`,
  );
  for (const stray of strays) process.stderr.write(`  ${stray}\n`);
  process.exitCode = 1;
}

// 仅作为入口执行时跑主流程 (被 import 时不执行, 供测试)
if (import.meta.main) main();
