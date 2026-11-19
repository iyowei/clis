/**
 * 真实恢复: 把备份恢复进正在运行的数据库。会先删除对应业务库内同名集合再导入, 请谨慎。
 * 目标库自动从备份文件名 (mongo-<库名>-YYYYMMDD_HHMMSS.archive.gz) 识别, 不会覆盖同实例其它库。
 * 多节点副本集模式下自动通过 replicaSet 拓扑发现路由至当前活跃 PRIMARY 节点。
 * 恢复前请先用 drill 演练。使用 root 账号 (恢复需要 restore 权限)。
 *
 * 用法: bun run restore.ts <备份文件名> --yes
 * 备份文件名只取文件名部分, 必须位于 /backup 下。
 */
import { rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  BACKUP_DIR,
  FatalError,
  log,
  main,
  needAlnum,
  parseBackupDb,
  run,
  toolConfigYaml,
  validateDbName,
  verifyGzip,
} from './lib';

main(async () => {
  const [arg, confirm] = process.argv.slice(2);
  if (!arg) throw new FatalError('用法: restore <备份文件名> --yes');
  if (confirm !== '--yes') {
    throw new FatalError(
      '这会先删除目标业务库内的同名集合, 再用备份覆盖。确认请加 --yes',
    );
  }

  const name = basename(arg);
  const parsedDb = parseBackupDb(name);
  if (!parsedDb) throw new FatalError(`不是合法的备份文件名: ${name}`);
  const db = validateDbName(parsedDb, '归档库名');

  const file = join(BACKUP_DIR, name);
  await stat(file).catch(() => {
    throw new FatalError(`找不到备份文件 ${file}`);
  });
  await verifyGzip(file);

  const user = needAlnum('MONGO_INITDB_ROOT_USERNAME');
  const password = needAlnum('MONGO_INITDB_ROOT_PASSWORD');
  const confFile = '/tmp/mongorestore.yml';

  try {
    await writeFile(confFile, toolConfigYaml(user, password), { mode: 0o600 });
    log(`恢复 ${name} -> 目标库 ${db}`);
    await run('mongorestore', [
      `--config=${confFile}`,
      `--archive=${file}`,
      '--gzip',
      '--drop',
      `--nsInclude=${db}.*`,
      '--quiet',
    ]);
  } finally {
    await rm(confFile, { force: true });
  }
  log(`恢复完成 [${db}]`);
});
