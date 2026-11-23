/**
 * template/ 常驻 CI 完整性回归测试:
 * 1) 单元测试 template/podman/lib.ts 纯函数 (无需真 Mongo)
 * 2) 校验 deploy.schema.json 与 deploy-2c2g.json 双向有效
 * 3) 校验 Podman / K8s 生成产物零未替换占位符、良构 XML、关键安全与 Helm 模板守卫
 * 4) 非 Windows 下 sh -n 校验全部 shell 脚本语法; 本机存在 helm 时附跑 helm lint 与 helm template
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FatalError,
  buildMongoUri,
  intEnv,
  isBackupName,
  listBackups,
  parseBackupDb,
  parseExtraApps,
  parseRsMembersList,
  toolConfigYaml,
  validateAlnumSecret,
  validateDbName,
} from '../template/podman/lib.ts';
import {
  type DeployManifest,
  generateBundle,
  validateManifest,
} from './index.ts';

const SOURCE_TEMPLATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../template',
);

const applyTempEnv = (
  patch: Record<string, string | undefined>,
): (() => void) => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
};

describe('template/podman/lib.ts 纯函数单测', () => {
  test('intEnv 默认 min=1 拦截 0, 传 min=0 放行 0 (对齐 keepWeekly: 0)', () => {
    const restore = applyTempEnv({ KEEP_WEEKLY: '0', KEEP_DAILY: '0' });
    try {
      expect(intEnv('KEEP_WEEKLY', 4, 0)).toBe(0);
      expect(() => intEnv('KEEP_DAILY', 7)).toThrow(FatalError);
      for (const bad of ['-1', 'abc']) {
        process.env.KEEP_WEEKLY = bad;
        expect(() => intEnv('KEEP_WEEKLY', 4, 0)).toThrow(FatalError);
      }
      delete process.env.KEEP_WEEKLY;
      expect(intEnv('KEEP_WEEKLY', 4, 0)).toBe(4);
    } finally {
      restore();
    }
  });

  test('凭据、库名、附加业务库、备份归档名与副本集 URI 解析正确', () => {
    expect(validateAlnumSecret('abc123', 'PWD')).toBe('abc123');
    expect(() => validateAlnumSecret('CHANGE_ME', 'PWD')).toThrow(FatalError);
    expect(() => validateAlnumSecret('bad@1', 'PWD')).toThrow(FatalError);
    expect(validateDbName('shop_v2', 'DB')).toBe('shop_v2');
    expect(() => validateDbName('admin', 'DB')).toThrow(FatalError);

    expect(
      parseExtraApps('orders:orderu:pwd123,logs:logsu:pwd456', 'app'),
    ).toEqual([
      { db: 'orders', user: 'orderu', password: 'pwd123' },
      { db: 'logs', user: 'logsu', password: 'pwd456' },
    ]);
    expect(() => parseExtraApps('app:u:p', 'app')).toThrow(FatalError);
    expect(parseBackupDb('mongo-orders-20261119_033000.archive.gz')).toBe(
      'orders',
    );
    expect(parseBackupDb('random.tar.gz')).toBeNull();
    expect(parseRsMembersList('node1:27117,node2:27117')).toEqual([
      'node1:27117',
      'node2:27117',
    ]);

    const restoreRs = applyTempEnv({
      RS_MEMBERS: 'n1:27117,n2:27117,n3:27117',
      RS_NAME: 'rs0',
    });
    try {
      expect(buildMongoUri('bak', 'sec', 'secondaryPreferred')).toBe(
        'mongodb://bak:sec@n1:27117,n2:27117,n3:27117/?authSource=admin&replicaSet=rs0&readPreference=secondaryPreferred',
      );
      expect(toolConfigYaml('root', 'RootPass123')).toBe(
        'uri: mongodb://root:RootPass123@n1:27117,n2:27117,n3:27117/?authSource=admin&replicaSet=rs0\n',
      );
    } finally {
      restoreRs();
    }

    const restoreSingle = applyTempEnv({
      RS_MEMBERS: '',
      MONGO_HOST: 'mongo',
      MONGO_PORT: '27117',
    });
    try {
      expect(buildMongoUri('bak', 'sec')).toBe(
        'mongodb://bak:sec@mongo:27117/?authSource=admin&directConnection=true',
      );
      expect(toolConfigYaml('backup', 'Pass123', 'secondaryPreferred')).toBe(
        'uri: mongodb://backup:Pass123@mongo:27117/?authSource=admin&directConnection=true&readPreference=secondaryPreferred\n',
      );
      expect(toolConfigYaml('root', 'RootPass123')).toBe(
        'uri: mongodb://root:RootPass123@mongo:27117/?authSource=admin&directConnection=true\n',
      );
    } finally {
      restoreSingle();
    }
  });

  test('listBackups 按库隔离并按修改时间倒序返回, 拒绝非法与路径穿越归档名', async () => {
    expect(isBackupName('mongo-billing-20261118_033000.archive.gz')).toBe(true);
    expect(isBackupName('random.tar.gz')).toBe(false);
    expect(parseBackupDb('../mongo-app-20261118_033000.archive.gz')).toBeNull();
    expect(
      parseBackupDb('mongo-app-20261118_033000.archive.gz.partial'),
    ).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), 'codd-list-backups-'));
    try {
      const fAppOld = 'mongo-app-20261117_033000.archive.gz';
      const fAppNew = 'mongo-app-20261118_033000.archive.gz';
      const fOrd = 'mongo-orders-20261118_033000.archive.gz';
      writeFileSync(join(dir, fAppOld), 'x');
      writeFileSync(join(dir, fAppNew), 'x');
      writeFileSync(join(dir, fOrd), 'x');
      writeFileSync(join(dir, 'ignored.partial'), 'x');
      utimesSync(join(dir, fAppOld), 1000, 1000);
      utimesSync(join(dir, fAppNew), 2000, 2000);
      utimesSync(join(dir, fOrd), 3000, 3000);

      expect(await listBackups(dir, 'app')).toEqual([fAppNew, fAppOld]);
      expect(await listBackups(dir, 'orders')).toEqual([fOrd]);
      expect(await listBackups(dir)).toEqual([fOrd, fAppNew, fAppOld]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Schema 与模板源码结构守卫', () => {
  test('deploy.schema.json 与 deploy-2c2g.json 合法且通过校验与生成', () => {
    const tplRoot = SOURCE_TEMPLATE_ROOT;
    const schema = JSON.parse(
      readFileSync(join(tplRoot, 'schema/deploy.schema.json'), 'utf8'),
    ) as {
      $schema?: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const sample = JSON.parse(
      readFileSync(join(tplRoot, 'schema/deploy-2c2g.json'), 'utf8'),
    ) as DeployManifest;

    expect(schema.$schema).toContain('draft-07');
    expect(schema.required).toEqual(['mode', 'name', 'apps']);
    expect(schema.properties?.keepWeekly).toBeDefined();
    expect(() => validateManifest(sample)).not.toThrow();

    const ws = mkdtempSync(join(tmpdir(), 'codd-tpl-sample-'));
    try {
      const res = generateBundle({
        workDir: ws,
        templateDir: SOURCE_TEMPLATE_ROOT,
        manifest: sample,
      });
      expect(res.bundleDirs.length).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('Helm 与 Podman 模板保留所有关键安全与正确性守卫', () => {
    const tplRoot = SOURCE_TEMPLATE_ROOT;
    const sts = readFileSync(
      join(tplRoot, 'helm/templates/statefulset.yaml'),
      'utf8',
    );
    expect(sts).toContain('{{- if .Values.persistence.storageClass }}');
    expect(sts).toContain('{{- if or $hasNodeAffinity $hasPodAntiAffinity }}');
    expect(sts.indexOf('name: fix-keyfile-permissions')).toBeLessThan(
      sts.indexOf('name: bootstrap-root'),
    );
    expect(sts).toContain('imagePullPolicy:');
    const mainContainerPart = sts.slice(sts.indexOf('containers:'));
    expect(mainContainerPart).not.toContain('MONGO_INITDB_ROOT_PASSWORD');
    expect(mainContainerPart).not.toContain('MONGO_INITDB_ROOT_USERNAME');

    const secret = readFileSync(
      join(tplRoot, 'helm/templates/secret.yaml'),
      'utf8',
    );
    expect(secret).toContain('lookup "v1" "Secret"');

    const values = readFileSync(join(tplRoot, 'helm/values.yaml'), 'utf8');
    expect(values).not.toMatch(/^\s*metrics:/m);
    const persistenceBlock = values.slice(
      values.indexOf('persistence:'),
      values.indexOf('# StatefulSet'),
    );
    expect(persistenceBlock).not.toMatch(/^\s+enabled:/m);
    expect(persistenceBlock).toContain('accessMode:');

    const makeTpl = readFileSync(join(tplRoot, 'podman/Makefile.tmpl'), 'utf8');
    expect(makeTpl).not.toContain('bun run generate');
    expect(makeTpl).toContain('请先使用 codd 生成部署目录');

    const bunfig = readFileSync(join(tplRoot, 'podman/bunfig.toml'), 'utf8');
    const activeLines = bunfig
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    expect(
      activeLines.some((l) =>
        /^registry\s*=\s*["']https:\/\/registry\.npmmirror\.com["']$/.test(
          l.trim(),
        ),
      ),
    ).toBe(true);

    const tuneSh = readFileSync(
      join(tplRoot, 'podman/tune-linux-host.sh'),
      'utf8',
    );
    for (const p of ['enabled', 'defrag', 'khugepaged/max_ptes_none']) {
      expect(tuneSh).toContain(
        `[ -f /sys/kernel/mm/transparent_hugepage/${p} ]`,
      );
    }
  });

  test('init-configmap.yaml 与 podman/init.js 报错不打印密码且拦截弱占位符与超长库名', () => {
    const initCm = readFileSync(
      join(SOURCE_TEMPLATE_ROOT, 'helm/templates/init-configmap.yaml'),
      'utf8',
    );
    const k8sSrc =
      /const RESERVED =[\s\S]*?function parseAndValidateInitConfig\(envObj\) \{[\s\S]*?\n {4}\}/.exec(
        initCm,
      )?.[0] ?? '';
    const podmanInit = readFileSync(
      join(SOURCE_TEMPLATE_ROOT, 'podman/init.js'),
      'utf8',
    );
    const podmanSrc = podmanInit.slice(0, podmanInit.indexOf('if (rsRole ==='));
    expect(k8sSrc.length > 0 && podmanSrc.length > 0).toBe(true);

    type AppTuple = Array<{ db: string; user: string; pwd: string }>;
    const evalInit = (
      src: string,
      envMap: Record<string, string>,
    ): AppTuple => {
      const logs: string[] = [];
      const fn = new Function('process', 'print', 'quit', src);
      return fn(
        { env: envMap },
        (m: string) => logs.push(m),
        (c: number) => {
          throw new Error(`QUIT_${c}:${logs.join('|')}`);
        },
      ) as AppTuple;
    };
    const runK8s = (e: Record<string, string>) =>
      evalInit(
        `${k8sSrc}\nreturn parseAndValidateInitConfig(process.env).apps;`,
        e,
      );
    const runPodman = (e: Record<string, string>) =>
      evalInit(`${podmanSrc}\nreturn appSpecs;`, e);

    const db63a = 'a'.repeat(63);
    const db63b = 'b'.repeat(63);
    const validEnv: Record<string, string> = {
      MONGO_INITDB_ROOT_USERNAME: 'root',
      MONGO_INITDB_ROOT_PASSWORD: 'RootPassword123',
      MONGO_APP_DATABASE: db63a,
      MONGO_APP_USER: 'u1',
      MONGO_APP_PASSWORD: 'AppPassword123',
      MONGO_BACKUP_USER: 'backup',
      MONGO_BACKUP_PASSWORD: 'BackupPassword123',
      MONGO_EXTRA_APPS: `${db63b}:u2:ExtraPassword123`,
    };
    const expectedApps = [
      { db: db63a, user: 'u1', pwd: 'AppPassword123' },
      { db: db63b, user: 'u2', pwd: 'ExtraPassword123' },
    ];
    expect(runK8s(validEnv)).toEqual(expectedApps);
    expect(runPodman(validEnv)).toEqual(expectedApps);

    const canary = 'SuperSecretLeakCanary987654';
    const changeMeKeys =
      'MONGO_INITDB_ROOT_USERNAME MONGO_INITDB_ROOT_PASSWORD MONGO_APP_USER MONGO_APP_PASSWORD MONGO_BACKUP_USER MONGO_BACKUP_PASSWORD'.split(
        ' ',
      );
    const badEnvPatches: Array<Record<string, string>> = [
      ...['admin', 'local', 'config', 'a'.repeat(64)].map((d) => ({
        MONGO_APP_DATABASE: d,
      })),
      ...changeMeKeys.map((k) => ({ [k]: 'CHANGE_ME' })),
      { MONGO_BACKUP_PASSWORD: '' },
      { MONGO_INITDB_ROOT_PASSWORD: `${canary}!` },
      { MONGO_EXTRA_APPS: `${'b'.repeat(64)}:u2:${canary}` },
      { MONGO_EXTRA_APPS: `orders:u2:${canary}:extraColon` },
      { MONGO_EXTRA_APPS: `${canary}@bad:u2:${canary}` },
      { MONGO_EXTRA_APPS: 'orders:CHANGE_ME:ValidPwd1' },
      { MONGO_EXTRA_APPS: 'orders:u2:CHANGE_ME' },
      { MONGO_EXTRA_APPS: `orders:u2:${canary}@bad` },
      { MONGO_EXTRA_APPS: `${db63a}:u2:p2` },
      { MONGO_EXTRA_APPS: 'orders:u2:p2,orders:u3:p3' },
    ];
    for (const patch of badEnvPatches) {
      const merged = { ...validEnv, ...patch };
      for (const runner of [runK8s, runPodman]) {
        expect(() => runner(merged)).toThrow('QUIT_1');
        try {
          runner(merged);
        } catch (e) {
          expect(String(e)).not.toContain(canary);
        }
      }
    }
    expect(() => parseExtraApps(`orders:u2:${canary}:colon`, 'shop')).toThrow(
      FatalError,
    );
    try {
      parseExtraApps(`orders:u2:${canary}:colon`, 'shop');
    } catch (e) {
      expect(String(e)).not.toContain(canary);
    }
    expect(() => validateDbName('d'.repeat(64), 'DB')).toThrow(FatalError);
  });
});

describe('生成产物完整性、Shell 语法与可选 Helm 校验', () => {
  test('Podman (macOS) 与 K8s (k8s-single / k8s-rs) 产物良构、零残留占位符且脚本通过 sh -n', () => {
    const ws = mkdtempSync(join(tmpdir(), 'codd-tpl-e2e-'));
    try {
      const macRes = generateBundle({
        workDir: ws,
        templateDir: SOURCE_TEMPLATE_ROOT,
        manifest: {
          mode: 'single',
          name: 'macbox',
          apps: [{ db: 'app', user: 'appu' }],
          nodes: [
            {
              os: 'macos',
              backupDir: '/Users/alice/srv/backups',
              stackDir: '/Users/alice/srv/stacks',
            },
          ],
        },
      });
      const macDir = macRes.bundleDirs[0]!;
      const plistName = readdirSync(macDir).find((f) => f.endsWith('.plist'));
      expect(plistName).toBeDefined();
      const plist = readFileSync(join(macDir, plistName!), 'utf8');
      expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain('</plist>');
      expect(/&(?!(?:amp|lt|gt|quot|apos);)/.test(plist)).toBe(false);

      const k1Res = generateBundle({
        workDir: ws,
        templateDir: SOURCE_TEMPLATE_ROOT,
        manifest: {
          mode: 'k8s-single',
          name: 'k1',
          apps: [{ db: 'app', user: 'appu' }],
        },
      });
      const k3Res = generateBundle({
        workDir: ws,
        templateDir: SOURCE_TEMPLATE_ROOT,
        manifest: {
          mode: 'k8s-rs',
          name: 'k3',
          apps: [
            { db: 'app', user: 'appu' },
            { db: 'logs', user: 'logsu' },
          ],
          k8s: { namespace: 'prod', storageClass: 'gp3' },
        },
      });

      const k1Dir = k1Res.bundleDirs[0]!;
      const k3Dir = k3Res.bundleDirs[0]!;

      for (const dir of [k1Dir, k3Dir]) {
        for (const f of [
          'values.generated.yaml',
          'create-secret.sh',
          'deploy.sh',
        ]) {
          const content = readFileSync(join(dir, f), 'utf8');
          expect(/\{\{[A-Z0-9_]+\}\}/.test(content)).toBe(false);
        }
      }

      if (process.platform !== 'win32') {
        const shScripts = [
          join(macDir, 'tune-linux-host.sh'),
          join(k1Dir, 'create-secret.sh'),
          join(k1Dir, 'deploy.sh'),
          join(k3Dir, 'create-secret.sh'),
          join(k3Dir, 'deploy.sh'),
        ];
        for (const script of shScripts) {
          const check = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
          expect(check.status).toBe(0);
        }
      }

      // 若运行环境已安装 helm, 附跑 helm lint 与 helm template 校验两套拓扑
      const helmProbe = spawnSync('helm', ['version', '--short'], {
        stdio: 'ignore',
      });
      if (helmProbe.status === 0) {
        for (const [label, dir, expectEmptyAffinity] of [
          ['k1', k1Dir, true],
          ['k3', k3Dir, false],
        ] as const) {
          const valArgs = [
            join(dir, 'chart'),
            '-f',
            join(dir, 'values.generated.yaml'),
          ];
          const lint = spawnSync('helm', ['lint', ...valArgs], {
            encoding: 'utf8',
          });
          expect(lint.status).toBe(0);

          const tpl = spawnSync('helm', ['template', label, ...valArgs], {
            encoding: 'utf8',
          });
          expect(tpl.status).toBe(0);
          // init Job 绝不能贴 app.kubernetes.io/name: mongo, 否则 3 节点硬反亲和将因 init Pod 占节点而死锁且 Service 会误选中 init Pod
          const jobSection = tpl.stdout
            .split(/^---$/m)
            .find((doc) => /\bkind:\s*Job\b/.test(doc));
          expect(jobSection).toBeDefined();
          expect(jobSection).toContain('app.kubernetes.io/name: mongo-init');
          expect(jobSection).not.toMatch(
            /app\.kubernetes\.io\/name:\s*mongo$/m,
          );
          if (expectEmptyAffinity) {
            expect(tpl.stdout).not.toMatch(/^\s+affinity:\s*$/m);
            expect(tpl.stdout).not.toMatch(/^\s+storageClassName:\s*$/m);
          } else {
            expect(tpl.stdout).toContain('podAntiAffinity:');
            expect(tpl.stdout).toContain('storageClassName: "gp3"');
          }
        }
      }
    } finally {
      rmSync(ws, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 30_000);
});
