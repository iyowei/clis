// 副本集与账号初始化 (mongosh --nodb, 脚本自己用 root 凭据连接)
// 参数全部来自环境变量, 不经过 shell 拼接。幂等, 可重复执行。
// 支持主业务库 (MONGO_APP_*) 与可选附加业务库 (MONGO_EXTRA_APPS=db:user:pwd,...), 按库隔离 readWrite 权限。
// 多节点发生故障切主后重跑 make init 时, 会自动根据 hello().primary 路由至当前主节点完成建号或轮换口令。

const env = process.env;
const RESERVED_DBS = { admin: true, local: true, config: true };

const fail = (msg) => {
  print(`错误: ${msg}`);
  quit(1);
};

const need = (name) => {
  const v = env[name];
  if (!v) fail(`缺少环境变量 ${name}`);
  return v;
};

const checkAlnum = (v, label) => {
  if (!/^[A-Za-z0-9]+$/.test(v) || v === 'CHANGE_ME') {
    fail(`${label} 只允许字母和数字, 且不能是模板值 CHANGE_ME`);
  }
  return v;
};

const alnum = (name) => checkAlnum(need(name), name);

const checkDbName = (v, label) => {
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    fail(`${label} 只允许字母, 数字, 下划线, 连字符`);
  }
  if (RESERVED_DBS[v]) {
    fail(`${label} 不能使用保留系统库名 ${v}`);
  }
  return v;
};

const parseAppSpecs = () => {
  const primaryDb = checkDbName(
    need('MONGO_APP_DATABASE'),
    'MONGO_APP_DATABASE',
  );
  const primaryUser = alnum('MONGO_APP_USER');
  const primaryPwd = alnum('MONGO_APP_PASSWORD');
  const specs = [{ db: primaryDb, user: primaryUser, pwd: primaryPwd }];
  const seen = {};
  seen[primaryDb] = true;

  const extra = env.MONGO_EXTRA_APPS;
  if (!extra || !extra.trim()) return specs;

  for (const rawEntry of extra.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split(':');
    if (parts.length !== 3) {
      fail(`MONGO_EXTRA_APPS 条目格式必须为 库名:用户名:密码, 当前为 ${entry}`);
    }
    const db = checkDbName(parts[0], `MONGO_EXTRA_APPS 库名(${parts[0]})`);
    if (seen[db]) {
      fail(`MONGO_EXTRA_APPS 存在重复业务库名: ${db}`);
    }
    seen[db] = true;
    const user = checkAlnum(parts[1], `MONGO_EXTRA_APPS 用户名(${db})`);
    const pwd = checkAlnum(parts[2], `MONGO_EXTRA_APPS 密码(${db})`);
    specs.push({ db, user, pwd });
  }
  return specs;
};

const parseRsRole = () => {
  const role = (env.RS_ROLE || 'primary').trim();
  if (role !== 'primary' && role !== 'secondary') {
    fail(`RS_ROLE 只允许 primary 或 secondary, 当前为 ${role}`);
  }
  return role;
};

const parseRsMembers = () => {
  const port = env.MONGO_PORT || '27117';
  const fallbackHost = env.RS_MEMBER_HOST || `mongo:${port}`;
  const raw = env.RS_MEMBERS;
  if (!raw || !raw.trim()) {
    return [{ _id: 0, host: fallbackHost }];
  }
  const members = [];
  const seen = {};
  for (const rawEntry of raw.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const m = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(entry);
    if (!m) {
      fail(`RS_MEMBERS 条目格式必须为 主机:端口, 当前为 ${entry}`);
    }
    const portNum = Number(m[2]);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      fail(`RS_MEMBERS 端口超出范围 (1-65535): ${entry}`);
    }
    if (seen[entry]) {
      fail(`RS_MEMBERS 存在重复成员地址: ${entry}`);
    }
    seen[entry] = true;
    members.push({ _id: members.length, host: entry });
  }
  if (members.length === 0) {
    return [{ _id: 0, host: fallbackHost }];
  }
  if (members.length > 1) {
    members[0].priority = 2;
    for (let i = 1; i < members.length; i += 1) {
      members[i].priority = 1;
    }
  }
  return members;
};

const host = env.MONGO_HOST || 'mongo';
const port = env.MONGO_PORT || '27117';
const rootUser = alnum('MONGO_INITDB_ROOT_USERNAME');
const rootPwd = alnum('MONGO_INITDB_ROOT_PASSWORD');
const appSpecs = parseAppSpecs();
const backupUser = alnum('MONGO_BACKUP_USER');
const backupPwd = alnum('MONGO_BACKUP_PASSWORD');
const rsName = env.RS_NAME || 'rs0';
const rsRole = parseRsRole();
const rsMembers = parseRsMembers();

if (rsRole === 'secondary') {
  print(
    '从节点模式 (RS_ROLE=secondary): 跳过本机初始化与建号, 等待主引导节点执行 init 并自动同步',
  );
  quit(0);
}

const directUri = (targetHostPort) =>
  `mongodb://${rootUser}:${rootPwd}@${targetHostPort}/admin` +
  '?authSource=admin&directConnection=true' +
  '&serverSelectionTimeoutMS=120000&connectTimeoutMS=120000';

let conn = new Mongo(directUri(`${host}:${port}`));
let admin = conn.getDB('admin');

print('步骤 1/4: 检查副本集状态');
let needInit = false;
try {
  admin.adminCommand({ replSetGetStatus: 1 });
  print('副本集已初始化, 跳过');
} catch (e) {
  if (e.codeName === 'NotYetInitialized') {
    needInit = true;
  } else {
    throw e;
  }
}

if (needInit) {
  if (rsMembers.length > 1) {
    print('等待多节点副本集其余成员就绪 (最多 60 秒)...');
    const selfHostPort = `${host}:${port}`;
    const peers = rsMembers
      .map((m) => m.host)
      .filter((h) => h !== selfHostPort);
    for (let waitSec = 0; waitSec < 60; waitSec += 2) {
      let allReachable = true;
      for (const peer of peers) {
        try {
          new Mongo(
            `mongodb://${peer}/admin?directConnection=true&serverSelectionTimeoutMS=1500&connectTimeoutMS=1500`,
          )
            .getDB('admin')
            .adminCommand({ ping: 1 });
        } catch (e) {
          const errName = e && e.name ? String(e.name) : '';
          const msg = e && e.message ? String(e.message) : String(e);
          if (
            errName === 'MongoNetworkError' ||
            errName === 'MongoNetworkTimeoutError' ||
            errName === 'MongoServerSelectionError' ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('ENOTFOUND') ||
            msg.includes('EAI_AGAIN') ||
            msg.includes('Server selection timed out') ||
            msg.includes('socket')
          ) {
            allReachable = false;
            break;
          }
        }
      }
      if (allReachable) {
        print('全部副本集成员网络与端口已就绪');
        break;
      }
      sleep(2000);
    }
  }
  // 显式声明成员地址。多节点场景将首个成员设 priority=2 为默认主节点
  print(
    `初始化副本集 ${rsName}, 成员: ${rsMembers.map((m) => m.host).join(', ')}`,
  );
  printjson(
    admin.adminCommand({
      replSetInitiate: {
        _id: rsName,
        members: rsMembers,
      },
    }),
  );
}

print('步骤 2/4: 等待主节点就绪');
let ready = false;
for (let i = 0; i < 90; i += 1) {
  try {
    const h = admin.hello();
    if (h.isWritablePrimary) {
      ready = true;
      break;
    }
    if (h.primary) {
      print(`检测到活跃主节点为 ${h.primary}, 自动路由并校验可写权限`);
      conn = new Mongo(directUri(h.primary));
      admin = conn.getDB('admin');
      if (admin.hello().isWritablePrimary) {
        ready = true;
        break;
      }
    }
  } catch (e) {
    // 选举期间的瞬时错误, 继续等
  }
  sleep(1000);
}
if (!ready) {
  fail('90 秒内未选出主节点');
}
print('主节点就绪');

function upsertUser(dbName, user, pwd, roles) {
  const target = conn.getDB(dbName);
  if (target.getUser(user)) {
    target.updateUser(user, { pwd, roles });
    print(`用户 ${user}@${dbName} 已存在, 已更新密码和角色`);
  } else {
    target.createUser({ user, pwd, roles });
    print(`用户 ${user}@${dbName} 已创建`);
  }
}

print(`步骤 3/4: 业务账号 (共 ${appSpecs.length} 个隔离业务库)`);
for (const spec of appSpecs) {
  upsertUser(spec.db, spec.user, spec.pwd, [
    { role: 'readWrite', db: spec.db },
  ]);
}

print('步骤 4/4: 备份账号 (仅内置 backup 角色)');
upsertUser('admin', backupUser, backupPwd, [{ role: 'backup', db: 'admin' }]);

print('副本集与账号初始化完成');
