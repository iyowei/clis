/**
 * 逻辑备份: mongodump 全部已配置业务库, 各自压缩归档输出到宿主机挂载的 /backup。
 * 数据库运行时即可执行, 不需要停库。使用 backup 专用只读账号, 多节点优先从 SECONDARY 读取。
 *
 * 保留策略 (按业务库独立计算):
 *   每日备份每库保留 KEEP_DAILY 份; 周日的那份额外复制到 weekly/, 每库保留 KEEP_WEEKLY 份。
 * 失败时以非零退出码结束, 并清理半成品文件。
 */
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  BACKUP_DIR,
  FatalError,
  getConfiguredApps,
  intEnv,
  isSunday,
  listBackups,
  log,
  main,
  needAlnum,
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

const backupOneDb = async (
  db: string,
  confFile: string,
  weeklyDir: string,
  keepDaily: number,
  keepWeekly: number,
  concurrency: number,
): Promise<void> => {
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

    // 完整性校验: 非空且 gzip 流可完整解压
    const { size } = await stat(partial);
    if (size < 100) {
      throw new FatalError(
        `业务库 ${db} 备份文件异常小 (${size} 字节), 判定失败`,
      );
    }
    await verifyGzip(partial);
    await rename(partial, final);
    log(`备份完成 [${db}], ${size} 字节`);
  } finally {
    await rm(partial, { force: true });
  }

  // 周日的备份额外留一份
  if (isSunday()) {
    await copyFile(final, join(weeklyDir, basename(final)));
    log(`已存入 weekly/ [${db}]`);
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

  const keepDaily = intEnv('KEEP_DAILY', 7);
  const keepWeekly = intEnv('KEEP_WEEKLY', 4);
  const concurrency = intEnv('BACKUP_CONCURRENCY', 1);
  const weeklyDir = join(BACKUP_DIR, 'weekly');
  await mkdir(weeklyDir, { recursive: true });

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
      );
    }
  } finally {
    await rm(confFile, { force: true });
  }

  log(`完成 (共 ${dbs.length} 个库)`);
});
