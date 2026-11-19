import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
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
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new FatalError(`${label} 只允许字母, 数字, 下划线, 连字符`);
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

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length !== 3) {
      throw new FatalError(
        `MONGO_EXTRA_APPS 条目格式必须为 库名:用户名:密码, 当前为 ${trimmed}`,
      );
    }
    const [rawDb, rawUser, rawPwd] = parts as [string, string, string];
    const db = validateDbName(rawDb, `MONGO_EXTRA_APPS 库名(${rawDb})`);
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
