/**
 * 零污染恢复演练: 在工具容器内部基于 0700 私有目录 Unix Domain Socket 拉起独立临时沙箱 mongod,
 * 将备份归档恢复至沙箱实例后逐表统计文档数与索引数, 并通过只读 backup 账号与线上库比对索引结构。
 * 全程零 TCP 端口占用/暴露, 对线上生产库零写入, 零 oplog 膨胀, 零 WiredTiger 缓存冲刷。
 *
 * 用法: bun run drill.ts [备份文件名]   不带参数则按全部已配置业务库各自抽最新备份演练
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { MongoClient } from 'mongodb';

import {
  BACKUP_DIR,
  FatalError,
  buildDrillDbName,
  buildMongoUri,
  getConfiguredApps,
  listBackups,
  log,
  main,
  needAlnum,
  parseBackupDb,
  run,
  verifyGzip,
} from './lib';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const buildSocketUri = (sockPath: string): string =>
  `mongodb://${encodeURIComponent(sockPath)}/?directConnection=true`;

const startSandboxMongod = async (
  dbPath: string,
  sockPath: string,
  sandboxUri: string,
): Promise<ChildProcess> => {
  await mkdir(dbPath, { recursive: true, mode: 0o700 });
  const stderrChunks: string[] = [];
  const proc = spawn(
    'mongod',
    [
      '--dbpath',
      dbPath,
      '--bind_ip',
      sockPath,
      '--noauth',
      '--wiredTigerCacheSizeGB',
      '0.25',
      '--quiet',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderrChunks.length < 20) stderrChunks.push(chunk.toString('utf8'));
  });

  const probe = new MongoClient(sandboxUri, {
    serverSelectionTimeoutMS: 500,
    connectTimeoutMS: 500,
  });
  try {
    for (let i = 0; i < 60; i += 1) {
      if (proc.exitCode !== null) {
        throw new FatalError(
          `演练沙箱 mongod 异常退出 (code=${proc.exitCode}): ${stderrChunks.join('')}`,
        );
      }
      try {
        await probe.connect();
        await probe.db('admin').command({ ping: 1 });
        return proc;
      } catch {
        await sleep(250);
      }
    }
    throw new FatalError('演练沙箱 mongod 在 15s 内未就绪');
  } finally {
    await probe.close().catch(() => undefined);
  }
};

const stopSandboxMongod = async (
  proc: ChildProcess | undefined,
): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
};

const drillOneArchive = async (
  sandboxClient: MongoClient,
  liveClient: MongoClient,
  sandboxUri: string,
  name: string,
  targetDb: string,
): Promise<void> => {
  const file = join(BACKUP_DIR, name);
  await verifyGzip(file);

  const drillDb = buildDrillDbName(targetDb);
  try {
    log(`演练备份 ${name} -> 隔离沙箱 ${drillDb} (校验目标: ${targetDb})`);
    await run('mongorestore', [
      `--uri=${sandboxUri}`,
      `--archive=${file}`,
      '--gzip',
      `--nsInclude=${targetDb}.*`,
      `--nsFrom=${targetDb}.$col$`,
      `--nsTo=${drillDb}.$col$`,
      '--quiet',
    ]);

    const drill = sandboxClient.db(drillDb);
    const live = liveClient.db(targetDb);
    // 仅统计实体集合, 跳过视图 (view) 与 system.* 内部集合防 indexes() 报错
    const cols = (await drill.listCollections({ type: 'collection' }).toArray())
      .map((c) => c.name)
      .filter((colName) => !colName.startsWith('system.'))
      .sort();
    if (cols.length === 0) {
      throw new FatalError(`恢复 ${name} 后没有任何集合 (目标库: ${targetDb})`);
    }

    log(`恢复结果 [${targetDb}] (集合: 文档数, 沙箱索引数 / 线上索引数)`);
    let total = 0;
    const mismatched: string[] = [];
    const liveIndexErrors: string[] = [];
    for (const c of cols) {
      const docs = await drill.collection(c).countDocuments({});
      const idx = (await drill.collection(c).indexes()).length;
      let liveIdx: number | null = null;
      let missingOnLive = false;
      try {
        liveIdx = (await live.collection(c).indexes()).length;
      } catch (err) {
        const codeName =
          typeof err === 'object' && err !== null && 'codeName' in err
            ? String((err as { codeName?: unknown }).codeName)
            : '';
        if (codeName === 'NamespaceNotFound') {
          missingOnLive = true;
          log(
            `  [提示] 线上库 ${targetDb} 已不存在集合 ${c}, 跳过索引数量比对`,
          );
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          log(`  [警告] 读取线上集合 ${targetDb}.${c} 索引失败: ${detail}`);
          liveIndexErrors.push(`${c} (${detail})`);
        }
      }
      total += docs;
      if (liveIdx !== null && liveIdx !== idx) mismatched.push(c);
      let liveSummary = String(liveIdx);
      if (missingOnLive) liveSummary = '线上无此集合';
      else if (liveIdx === null) liveSummary = '读取失败';
      log(`  ${c}: ${docs} 文档, ${idx} 索引 / ${liveSummary}`);
    }
    if (liveIndexErrors.length > 0) {
      throw new FatalError(
        `读取线上索引失败 [${targetDb}]: ${liveIndexErrors.join('; ')}`,
      );
    }
    if (mismatched.length > 0) {
      throw new FatalError(
        `索引数量与线上不一致 [${targetDb}]: ${mismatched.join(', ')}`,
      );
    }
    log(
      `恢复演练通过 [${targetDb}], 共 ${cols.length} 个集合, ${total} 条文档 (线上零写入)`,
    );
  } finally {
    await sandboxClient
      .db(drillDb)
      .dropDatabase()
      .catch(() => undefined);
  }
};

main(async () => {
  const backupUser = needAlnum('MONGO_BACKUP_USER');
  const backupPassword = needAlnum('MONGO_BACKUP_PASSWORD');
  const apps = getConfiguredApps();

  const arg = process.argv[2];
  const targets: Array<{ name: string; db: string }> = [];

  if (arg) {
    const name = basename(arg);
    const db = parseBackupDb(name);
    if (!db) throw new FatalError(`找不到可用的备份文件: ${name}`);
    targets.push({ name, db });
  } else {
    for (const app of apps) {
      const latest = (await listBackups(BACKUP_DIR, app.db))[0];
      if (!latest) {
        throw new FatalError(`找不到业务库 ${app.db} 的可用备份文件`);
      }
      targets.push({ name: latest, db: app.db });
    }
  }

  const sandboxDir = `/tmp/codd-drill-${process.pid}-${Date.now()}`;
  const sandboxDbPath = join(sandboxDir, 'db');
  const sandboxSockPath = join(sandboxDir, 'drill.sock');
  const sandboxUri = buildSocketUri(sandboxSockPath);
  let sandboxProc: ChildProcess | undefined;
  const sandboxClient = new MongoClient(sandboxUri);
  const liveClient = new MongoClient(
    buildMongoUri(backupUser, backupPassword, 'secondaryPreferred'),
  );

  try {
    await mkdir(sandboxDir, { recursive: true, mode: 0o700 });
    log(
      `启动容器内隔离沙箱 mongod (Unix Socket: ${sandboxSockPath}, 内存上限 0.25GB)...`,
    );
    sandboxProc = await startSandboxMongod(
      sandboxDbPath,
      sandboxSockPath,
      sandboxUri,
    );
    await sandboxClient.connect();
    await liveClient.connect();
    for (const t of targets) {
      await drillOneArchive(
        sandboxClient,
        liveClient,
        sandboxUri,
        t.name,
        t.db,
      );
    }
  } finally {
    await sandboxClient.close().catch(() => undefined);
    await liveClient.close().catch(() => undefined);
    await stopSandboxMongod(sandboxProc);
    await rm(sandboxDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    log('已销毁隔离沙箱 mongod 与临时数据目录');
  }
});
