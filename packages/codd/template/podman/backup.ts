/**
 * 逻辑备份: mongodump 全部已配置业务库, 各自压缩归档输出到宿主机挂载的 /backup。
 * 数据库运行时即可执行, 不需要停库。使用 backup 专用只读账号, 多节点优先从 SECONDARY 读取。
 *
 * 四重磁盘防爆策略:
 *   1) 自动收尸: 清理超过 6 小时未更新的遗留 .partial 孤儿临时文件;
 *   2) 前置余量门禁: 每次 dump 前校验 /backup 剩余空间 >= BACKUP_MIN_FREE_MB + 1.5x 上次归档体积;
 *   3) 滚动淘汰 + 周备零复制: 每库保留 KEEP_DAILY / KEEP_WEEKLY 份, 周日优先硬链接零额外占位;
 *   4) 总容量硬上限: 全目录物理占用超过 BACKUP_MAX_TOTAL_MB 时按最旧淘汰, 死守每库最新 1 份底线。
 * 失败时以非零退出码结束, 并清理半成品文件。
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  BACKUP_DIR,
  FatalError,
  assertEnoughDiskSpace,
  cleanStalePartials,
  formatBytes,
  getConfiguredApps,
  intEnv,
  isSunday,
  linkOrCopyFile,
  listBackups,
  log,
  main,
  needAlnum,
  pruneByTotalBudget,
  run,
  stamp,
  toolConfigYaml,
  verifyGzip,
} from './lib';

const prune = async (dir: string, db: string, keep: number): Promise<void> => {
  const files = await listBackups(dir, db);
  for (const name of files.slice(keep)) {
    await rm(join(dir, name));
    log(`已清理旧备份 [${db}] ${name}`);
  }
};

const latestBackupSize = async (dir: string, db: string): Promise<number> => {
  const files = await listBackups(dir, db);
  if (files.length === 0) return 0;
  try {
    return (await stat(join(dir, files[0]!))).size;
  } catch {
    return 0;
  }
};

const backupOneDb = async (
  db: string,
  confFile: string,
  weeklyDir: string,
  keepDaily: number,
  keepWeekly: number,
  concurrency: number,
  minFreeMb: number,
): Promise<void> => {
  const prevSize = await latestBackupSize(BACKUP_DIR, db);
  await assertEnoughDiskSpace({
    dir: BACKUP_DIR,
    minFreeMb,
    estimatedNewBytes: Math.ceil(prevSize * 1.5),
  });

  const final = join(BACKUP_DIR, `mongo-${db}-${stamp()}.archive.gz`);
  const partial = `${final}.partial`;

  try {
    log(`开始备份 ${db} -> ${final} (并发集合数=${concurrency})`);
    await run('mongodump', [
      `--config=${confFile}`,
      `--db=${db}`,
      `--archive=${partial}`,
      `--numParallelCollections=${concurrency}`,
      '--gzip',
    ]);

    // 完整性校验: 仅拒绝 0 字节空文件, 结合 verifyGzip 完整解压校验避免空业务库合法归档误报
    const { size } = await stat(partial);
    if (size === 0) {
      throw new FatalError(`业务库 ${db} 备份文件为空 (0 字节), 判定失败`);
    }
    await verifyGzip(partial);
    await rename(partial, final);
    log(`备份完成 [${db}], ${formatBytes(size)} (${size} 字节)`);
  } finally {
    await rm(partial, { force: true });
  }

  // 周日的备份额外留一份 (KEEP_WEEKLY=0 时跳过; 优先硬链接复用物理块零额外占用)
  if (keepWeekly > 0 && isSunday()) {
    const mode = await linkOrCopyFile(final, join(weeklyDir, basename(final)));
    log(
      `已存入 weekly/ [${db}] (${mode === 'link' ? '硬链接零复制' : '副本拷贝'})`,
    );
  }

  await prune(BACKUP_DIR, db, keepDaily);
  await prune(weeklyDir, db, keepWeekly);
};

main(async () => {
  const user = needAlnum('MONGO_BACKUP_USER');
  const password = needAlnum('MONGO_BACKUP_PASSWORD');
  const apps = getConfiguredApps();
  const targetArg = process.argv[2];
  const dbs = targetArg ? [targetArg] : apps.map((a) => a.db);

  if (targetArg && !apps.some((a) => a.db === targetArg)) {
    throw new FatalError(`未在 .env 配置业务库 ${targetArg}`);
  }

  const keepDaily = intEnv('KEEP_DAILY', 7, 1);
  const keepWeekly = intEnv('KEEP_WEEKLY', 4, 0);
  const concurrency = intEnv('BACKUP_CONCURRENCY', 1, 1);
  const minFreeMb = intEnv('BACKUP_MIN_FREE_MB', 1024, 0);
  const maxTotalMb = intEnv('BACKUP_MAX_TOTAL_MB', 0, 0);
  const weeklyDir = join(BACKUP_DIR, 'weekly');
  await mkdir(weeklyDir, { recursive: true });

  const cleanedPartials = await cleanStalePartials(BACKUP_DIR);
  for (const stale of cleanedPartials) {
    log(`已清理过期半成品备份 ${stale}`);
  }

  const confFile = '/tmp/mongodump.yml';
  try {
    // 凭据只写进容器内的临时文件, 仅当前用户可读, 结束后删除
    await writeFile(
      confFile,
      toolConfigYaml(user, password, 'secondaryPreferred'),
      {
        mode: 0o600,
      },
    );
    for (const db of dbs) {
      await backupOneDb(
        db,
        confFile,
        weeklyDir,
        keepDaily,
        keepWeekly,
        concurrency,
        minFreeMb,
      );
    }
  } finally {
    await rm(confFile, { force: true });
  }

  if (maxTotalMb > 0) {
    const budget = await pruneByTotalBudget({
      rootDir: BACKUP_DIR,
      weeklyDir,
      maxTotalMb,
      onDelete: (relPath, size) => {
        log(
          `总容量配额裁剪 (上限 ${maxTotalMb} MiB): 已清理旧备份 ${relPath} (${formatBytes(size)})`,
        );
      },
    });
    if (budget.overBudget) {
      log(
        `警告: 仅保留每库最新 1 份备份后总物理占用仍为 ${formatBytes(budget.totalBytes)} (超过 BACKUP_MAX_TOTAL_MB=${maxTotalMb} MiB), 已保底留存最新备份, 请扩容或调大配额`,
      );
    }
  }

  log(`完成 (共 ${dbs.length} 个库)`);
});
