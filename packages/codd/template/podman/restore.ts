/**
 * 真实恢复: 把备份恢复进正在运行的数据库。会先删除对应业务库内同名集合再导入, 请谨慎。
 * 目标库自动从备份文件名 (mongo-<库名>-YYYYMMDD_HHMMSS.archive.gz) 识别, 不会覆盖同实例其它库。
 * 多节点副本集模式下自动通过 replicaSet 拓扑发现路由至当前活跃 PRIMARY 节点。
 * 恢复前请先用 drill 演练。使用 root 账号 (恢复需要 restore 权限)。
 *
 * 用法: bun run restore.ts <备份文件名 | weekly/备份文件名> --yes
 * 支持根目录文件名或 weekly/<文件名> (仅传文件名且根目录无时自动回退查找 weekly/)。
 */
import { rm, writeFile } from 'node:fs/promises';

import {
  FatalError,
  log,
  main,
  needAlnum,
  resolveBackupArchivePath,
  run,
  toolConfigYaml,
  verifyGzip,
} from './lib';

main(async () => {
  const [arg, confirm] = process.argv.slice(2);
  if (!arg)
    throw new FatalError(
      '用法: restore <备份文件名 | weekly/备份文件名> --yes',
    );
  if (confirm !== '--yes') {
    throw new FatalError(
      '这会先删除目标业务库内的同名集合, 再用备份覆盖。确认请加 --yes',
    );
  }

  const { file, relPath, db } = await resolveBackupArchivePath(arg);
  await verifyGzip(file);

  const user = needAlnum('MONGO_INITDB_ROOT_USERNAME');
  const password = needAlnum('MONGO_INITDB_ROOT_PASSWORD');
  const confFile = '/tmp/mongorestore.yml';

  try {
    await writeFile(confFile, toolConfigYaml(user, password), { mode: 0o600 });
    log(`恢复 ${relPath} -> 目标库 ${db}`);
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
