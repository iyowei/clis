import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, link, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/**
 * 工具脚本共用函数。全部配置来自环境变量, 由 compose 注入, 不读文件。
 */

export type AppDbSpec = {
  db: string;
  user: string;
  password: string;
};

const RESERVED_DBS = new Set(['admin', 'local', 'config']);
const BACKUP_NAME_RE = /^mongo-([A-Za-z0-9_-]+)-\d{8}_\d{6}\.archive\.gz$/;

export const log = (...args: unknown[]): void => {
  const ts = new Date().toLocaleString('sv-SE', {
    timeZone: process.env.TZ || 'Asia/Shanghai',
  });
  console.log(ts, ...args);
};

export class FatalError extends Error {}

export const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new FatalError(`缺少环境变量 ${name}`);
  return v;
};

export const validateAlnumSecret = (v: string, label: string): string => {
  if (!/^[A-Za-z0-9]+$/.test(v) || v === 'CHANGE_ME') {
    throw new FatalError(`${label} 只允许字母和数字, 且不能是模板值 CHANGE_ME`);
  }
  return v;
};

/** 凭据会拼进连接串, 限定字母数字, 避免需要转义而拼错 */
export const needAlnum = (name: string): string =>
  validateAlnumSecret(need(name), name);

export const validateDbName = (v: string, label: string): string => {
  if (!v || v.length > 63 || !/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new FatalError(
      `${label} 只允许字母, 数字, 下划线, 连字符, 且长度须为 1-63`,
    );
  }
  if (RESERVED_DBS.has(v)) {
    throw new FatalError(`${label} 不能使用保留系统库名 ${v}`);
  }
  return v;
};

export const needDbName = (name: string): string =>
  validateDbName(need(name), name);

/** 解析可选附加业务库 MONGO_EXTRA_APPS (格式: db:user:password, 逗号分隔) */
export const parseExtraApps = (
  raw: string | undefined,
  primaryDb: string,
): AppDbSpec[] => {
  if (!raw || !raw.trim()) return [];
  const seen = new Set([primaryDb]);
  const specs: AppDbSpec[] = [];

  let entryIdx = 0;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    entryIdx += 1;
    const parts = trimmed.split(':');
    if (parts.length !== 3) {
      throw new FatalError(
        `MONGO_EXTRA_APPS 第 ${entryIdx} 项格式必须为 库名:用户名:密码 (且均不含冒号)`,
      );
    }
    const [rawDb, rawUser, rawPwd] = parts as [string, string, string];
    const db = validateDbName(rawDb, `MONGO_EXTRA_APPS 第 ${entryIdx} 项库名`);
    if (seen.has(db)) {
      throw new FatalError(`MONGO_EXTRA_APPS 存在重复业务库名: ${db}`);
    }
    seen.add(db);
    const user = validateAlnumSecret(rawUser, `MONGO_EXTRA_APPS 用户名(${db})`);
    const password = validateAlnumSecret(
      rawPwd,
      `MONGO_EXTRA_APPS 密码(${db})`,
    );
    specs.push({ db, user, password });
  }
  return specs;
};

/** 返回主库与附加库的全部业务库定义, 供初始化与全库备份/演练共用 */
export const getConfiguredApps = (): AppDbSpec[] => {
  const primary: AppDbSpec = {
    db: needDbName('MONGO_APP_DATABASE'),
    user: needAlnum('MONGO_APP_USER'),
    password: needAlnum('MONGO_APP_PASSWORD'),
  };
  return [primary, ...parseExtraApps(process.env.MONGO_EXTRA_APPS, primary.db)];
};

export const intEnv = (name: string, fallback: number, min = 1): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new FatalError(
      min === 0
        ? `${name} 必须是非负整数 (>= 0), 当前为 ${raw}`
        : `${name} 必须是 >= ${min} 的整数, 当前为 ${raw}`,
    );
  }
  return n;
};

export const mongoTarget = () => ({
  host: process.env.MONGO_HOST || 'mongo',
  port: process.env.MONGO_PORT || '27117',
});

/** 解析多节点副本集成员列表 (RS_MEMBERS=host1:port,host2:port,...) */
export const parseRsMembersList = (raw = process.env.RS_MEMBERS): string[] => {
  if (!raw || !raw.trim()) return [];
  const list: string[] = [];
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!/^[A-Za-z0-9._-]+:\d{1,5}$/.test(trimmed)) {
      throw new FatalError(
        `RS_MEMBERS 条目格式不合法 (须为 主机:端口): ${trimmed}`,
      );
    }
    list.push(trimmed);
  }
  return list;
};

/**
 * 构建线上 MongoDB 连接 URI:
 * - 多节点副本集 (RS_MEMBERS >= 2): 走标准 replicaSet 拓扑发现 (不加 directConnection=true),
 *   确保 secondaryPreferred 真正命中从节点热备, 且切主后 restore 自动路由至新主节点;
 * - 单节点副本集: 走 directConnection=true 直连当前容器, 避免容器别名解析歧义。
 */
export const buildMongoUri = (
  user: string,
  password: string,
  readPreference?: 'primaryPreferred' | 'secondaryPreferred',
): string => {
  const members = parseRsMembersList();
  const rp = readPreference ? `&readPreference=${readPreference}` : '';
  if (members.length >= 2) {
    const rsName = (process.env.RS_NAME || 'rs0').trim() || 'rs0';
    return `mongodb://${user}:${password}@${members.join(',')}/?authSource=admin&replicaSet=${rsName}${rp}`;
  }
  const { host, port } = mongoTarget();
  return `mongodb://${user}:${password}@${host}:${port}/?authSource=admin&directConnection=true${rp}`;
};

/**
 * 生成 mongodump / mongorestore 的 --config 文件内容。
 * 凭据只出现在容器内的临时文件里, 不出现在进程参数和镜像元数据中。
 */
export const toolConfigYaml = (
  user: string,
  password: string,
  readPreference?: 'primaryPreferred' | 'secondaryPreferred',
): string => `uri: ${buildMongoUri(user, password, readPreference)}\n`;

/** 运行子进程, stdout 和 stderr 直通, 非零退出码时抛错 */
export const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new FatalError(`${cmd} 退出码 ${code}`)),
    );
  });

/** 统一的入口包装: 出错时打印原因并以非零退出码结束 */
export const main = (fn: () => Promise<void>): void => {
  fn().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`错误: ${msg}`);
    process.exit(1);
  });
};

export const BACKUP_DIR = '/backup';

/** 从规范归档文件名里还原业务库名, 不合法则返回 null */
export const parseBackupDb = (name: string): string | null => {
  const m = BACKUP_NAME_RE.exec(name);
  return m && m[1] ? m[1] : null;
};

export const isBackupName = (name: string): boolean =>
  parseBackupDb(name) !== null;

const isRegularFile = async (filePath: string): Promise<boolean> => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

/**
 * 安全解析备份归档路径 (白名单仅放行根目录与 weekly/ 子目录, 严禁路径穿越):
 * - 显式传入 weekly/<文件名>: 直接定位 <backupDir>/weekly/<文件名>;
 * - 仅传入纯 <文件名>: 优先查找根目录, 若根目录无则自动回退查找 weekly/;
 * - 拒绝绝对路径、..、多层目录与非法文件名。
 */
export const resolveBackupArchivePath = async (
  rawArg: string,
  backupDir = BACKUP_DIR,
): Promise<{ file: string; relPath: string; db: string }> => {
  const normalized = rawArg.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new FatalError(`非法的备份文件路径: ${rawArg}`);
  }
  const parts = normalized.split('/');
  let scope: 'auto' | 'weekly' = 'auto';
  let name: string;
  if (parts.length === 1) {
    name = parts[0]!;
  } else if (parts.length === 2 && parts[0] === 'weekly') {
    scope = 'weekly';
    name = parts[1]!;
  } else {
    throw new FatalError(
      `只允许指定备份根目录文件名或 weekly/<文件名>, 拒绝路径: ${rawArg}`,
    );
  }
  const parsedDb = parseBackupDb(name);
  if (!parsedDb) throw new FatalError(`不是合法的备份文件名: ${name}`);
  const db = validateDbName(parsedDb, '归档库名');

  if (scope === 'weekly') {
    const weeklyFile = join(backupDir, 'weekly', name);
    if (await isRegularFile(weeklyFile)) {
      return { file: weeklyFile, relPath: `weekly/${name}`, db };
    }
    throw new FatalError(`找不到周备份文件 ${weeklyFile}`);
  }

  const rootFile = join(backupDir, name);
  if (await isRegularFile(rootFile)) {
    return { file: rootFile, relPath: name, db };
  }
  const fallbackWeekly = join(backupDir, 'weekly', name);
  if (await isRegularFile(fallbackWeekly)) {
    return { file: fallbackWeekly, relPath: `weekly/${name}`, db };
  }
  throw new FatalError(
    `找不到备份文件 ${rootFile} (在 weekly/ 下也未找到同名归档)`,
  );
};

/** 按修改时间从新到旧列出目录下的备份文件 (可选按业务库名过滤) */
export const listBackups = async (
  dir: string,
  db?: string,
): Promise<string[]> => {
  const names = (await readdir(dir)).filter((n) => {
    const parsedDb = parseBackupDb(n);
    if (!parsedDb) return false;
    return db ? parsedDb === db : true;
  });
  const withTime = await Promise.all(
    names.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })),
  );
  return withTime.sort((a, b) => b.t - a.t).map((x) => x.n);
};

/** 校验 gzip 流可完整解压, 不把内容落盘 */
export const verifyGzip = async (file: string): Promise<void> => {
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  await pipeline(createReadStream(file), createGunzip(), sink);
};

/** 构造演练沙箱临时库名, 严格控制在 MongoDB 63 字节上限以内 */
export const buildDrillDbName = (
  targetDb: string,
  nowMs = Date.now(),
): string => {
  const tsTag = nowMs.toString(36);
  const prefix = 'd_';
  const maxDbPart = Math.max(1, 63 - prefix.length - 1 - tsTag.length);
  return `${prefix}${targetDb.slice(0, maxDbPart)}_${tsTag}`;
};

/** 用于文件名的时间戳, 形如 20261118_114500, 按 TZ 取本地时间 */
export const stamp = (d = new Date()): string =>
  d
    .toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Asia/Shanghai' })
    .replace(/[-:]/g, '')
    .replace(' ', '_');

/** 按 TZ 判断今天是否周日 */
export const isSunday = (d = new Date()): boolean =>
  d.toLocaleString('en-US', {
    timeZone: process.env.TZ || 'Asia/Shanghai',
    weekday: 'short',
  }) === 'Sun';

const STALE_PARTIAL_RE =
  /^mongo-[A-Za-z0-9_-]+-\d{8}_\d{6}\.archive\.gz\.partial$/;

/** 格式化字节数为人类可读单位 (B / KiB / MiB / GiB) */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

/** 清理超过 maxAgeMs 未修改的异常中断残留 .partial 半成品归档 (默认 6 小时) */
export const cleanStalePartials = async (
  dir: string,
  maxAgeMs = 6 * 3600 * 1000,
  nowMs = Date.now(),
): Promise<string[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!STALE_PARTIAL_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (nowMs - st.mtimeMs >= maxAgeMs) {
        await rm(full, { force: true });
        removed.push(name);
      }
    } catch {
      // 文件已被并发清理时跳过
    }
  }
  return removed;
};

export interface FsStatLike {
  bavail: number | bigint;
  bsize: number | bigint;
  frsize?: number | bigint;
}

/** 校验备份目标挂载点可用空间是否满足安全底线 + 预估新增归档体积; minFreeMb<=0 时跳过 */
export const assertEnoughDiskSpace = async (opts: {
  dir: string;
  minFreeMb: number;
  estimatedNewBytes?: number;
  readFs?: (path: string) => Promise<FsStatLike>;
}): Promise<number> => {
  const { dir, minFreeMb, estimatedNewBytes = 0, readFs = statfs } = opts;
  if (minFreeMb <= 0) return -1;
  const info = await readFs(dir);
  const frsize = Number(info.frsize ?? 0);
  const unit = frsize > 0 ? frsize : Number(info.bsize);
  const availBytes = Number(info.bavail) * unit;
  const minFreeBytes = minFreeMb * 1024 * 1024;
  const estBytes = Math.max(0, Math.ceil(estimatedNewBytes));
  const requiredBytes = minFreeBytes + estBytes;
  if (availBytes < requiredBytes) {
    throw new FatalError(
      `备份目录 ${dir} 可用磁盘空间不足: 当前剩余 ${formatBytes(availBytes)}, 低于安全下限 ${formatBytes(requiredBytes)} (底线 ${minFreeMb} MiB + 预估新增 ${formatBytes(estBytes)}), 已中止本次备份以防写满磁盘并保留既有历史备份`,
    );
  }
  return availBytes;
};

/** 周日归档优先创建硬链接零复制复用物理块; 不支持硬链接的文件系统自动降级拷贝 */
export const linkOrCopyFile = async (
  src: string,
  dst: string,
  linkFn: (existingPath: string, newPath: string) => Promise<void> = link,
  copyFn: (source: string, dest: string) => Promise<void> = copyFile,
): Promise<'link' | 'copy'> => {
  try {
    await linkFn(src, dst);
    return 'link';
  } catch {
    await copyFn(src, dst);
    return 'copy';
  }
};

interface BackupEntry {
  fullPath: string;
  relPath: string;
  db: string;
  isWeekly: boolean;
  size: number;
  mtimeMs: number;
  inodeKey: string;
}

const collectBackupEntries = async (
  dir: string,
  isWeekly: boolean,
): Promise<BackupEntry[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const name of names) {
    const db = parseBackupDb(name);
    if (!db) continue;
    const fullPath = join(dir, name);
    try {
      const st = await stat(fullPath);
      const inodeKey = st.ino > 0 ? `${st.dev}:${st.ino}` : fullPath;
      out.push({
        fullPath,
        relPath: isWeekly ? `weekly/${name}` : name,
        db,
        isWeekly,
        size: st.size,
        mtimeMs: st.mtimeMs,
        inodeKey,
      });
    } catch {
      // 忽略已移除条目
    }
  }
  return out;
};

const pickProtectedEntries = (entries: BackupEntry[]): Set<string> => {
  const latestDaily = new Map<string, BackupEntry>();
  const latestAny = new Map<string, BackupEntry>();
  for (const e of entries) {
    const prevAny = latestAny.get(e.db);
    if (!prevAny || e.mtimeMs > prevAny.mtimeMs) latestAny.set(e.db, e);
    if (!e.isWeekly) {
      const prevDaily = latestDaily.get(e.db);
      if (!prevDaily || e.mtimeMs > prevDaily.mtimeMs) latestDaily.set(e.db, e);
    }
  }
  const protectedPaths = new Set<string>();
  for (const [db, anyEntry] of latestAny) {
    protectedPaths.add((latestDaily.get(db) ?? anyEntry).fullPath);
  }
  return protectedPaths;
};

/**
 * 总物理容量硬上限裁剪 (inode 去重计算, 防硬链接重复计费):
 * 超过 maxTotalMb 时按修改时间从最旧起淘汰旧归档, 死守每个业务库至少保留最新 1 份备份。
 */
export const pruneByTotalBudget = async (opts: {
  rootDir: string;
  weeklyDir: string;
  maxTotalMb: number;
  onDelete?: (relPath: string, size: number) => void;
}): Promise<{ deleted: string[]; totalBytes: number; overBudget: boolean }> => {
  const { rootDir, weeklyDir, maxTotalMb, onDelete } = opts;
  const entries = [
    ...(await collectBackupEntries(rootDir, false)),
    ...(await collectBackupEntries(weeklyDir, true)),
  ];
  const inodeRefCount = new Map<string, number>();
  const inodeSize = new Map<string, number>();
  for (const e of entries) {
    inodeRefCount.set(e.inodeKey, (inodeRefCount.get(e.inodeKey) ?? 0) + 1);
    if (!inodeSize.has(e.inodeKey)) inodeSize.set(e.inodeKey, e.size);
  }
  let totalBytes = 0;
  for (const sz of inodeSize.values()) totalBytes += sz;
  if (maxTotalMb <= 0) {
    return { deleted: [], totalBytes, overBudget: false };
  }
  const maxBytes = maxTotalMb * 1024 * 1024;
  if (totalBytes <= maxBytes) {
    return { deleted: [], totalBytes, overBudget: false };
  }

  const protectedPaths = pickProtectedEntries(entries);
  const protectedInodes = new Set<string>();
  for (const e of entries) {
    if (protectedPaths.has(e.fullPath)) protectedInodes.add(e.inodeKey);
  }

  const candidates = entries
    .filter(
      (e) =>
        !protectedPaths.has(e.fullPath) && !protectedInodes.has(e.inodeKey),
    )
    .sort((a, b) => {
      if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
      return a.isWeekly === b.isWeekly ? 0 : a.isWeekly ? -1 : 1;
    });

  const deleted: string[] = [];
  for (const e of candidates) {
    if (totalBytes <= maxBytes) break;
    await rm(e.fullPath, { force: true });
    deleted.push(e.relPath);
    onDelete?.(e.relPath, e.size);
    const nextRef = (inodeRefCount.get(e.inodeKey) ?? 1) - 1;
    inodeRefCount.set(e.inodeKey, nextRef);
    if (nextRef <= 0) totalBytes -= e.size;
  }

  return { deleted, totalBytes, overBudget: totalBytes > maxBytes };
};
