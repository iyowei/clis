/**
 * @iyowei/codd 生产安全与跨平台加固专项回归测试:
 * 覆盖 CODD-P0-1 ~ P0-11 与 CODD-P1-1 ~ P1-4 全部核心防线。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildDrillDbName } from '../template/podman/lib.ts';
import { formatUploadNextStep } from './emit-podman-helpers.ts';
import {
  ConfigError,
  type DeployManifest,
  TemplateRenderError,
  generateBundle,
  resolvePackageRoot,
} from './index.ts';

const SOURCE_TEMPLATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../template',
);

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codd-hardening-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

describe('CODD-P0-1 & P0-2: networkMode=host 绑定隔离与 RS_SELF_HOST 映射', () => {
  test('host 模式按 bindIp 动态渲染 mongod.conf 绑定策略, 0.0.0.0 触发安全告警', () => {
    const dir = makeTempDir();
    const rLoopback = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'hostloop',
        networkMode: 'host',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'linux', backupDir: '/home/ops/bak' }],
      },
    });
    const confLoopback = readFileSync(
      join(rLoopback.bundleDirs[0]!, 'mongod.conf'),
      'utf8',
    );
    expect(confLoopback).toContain('bindIp: "127.0.0.1"');
    expect(confLoopback).not.toContain('bindIpAll: true');
    expect(rLoopback.warnings.some((w) => w.includes('0.0.0.0'))).toBe(false);

    const rWg = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'hostwg',
        networkMode: 'host',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          { os: 'linux', bindIp: '10.8.0.11', backupDir: '/home/ops/bak' },
        ],
      },
    });
    const confWg = readFileSync(
      join(rWg.bundleDirs[0]!, 'mongod.conf'),
      'utf8',
    );
    expect(confWg).toContain('bindIp: "127.0.0.1,10.8.0.11"');
    expect(confWg).not.toContain('bindIpAll: true');

    const rAll = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'hostall',
        networkMode: 'host',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'linux', bindIp: '0.0.0.0', backupDir: '/home/ops/bak' }],
      },
    });
    const confAll = readFileSync(
      join(rAll.bundleDirs[0]!, 'mongod.conf'),
      'utf8',
    );
    expect(confAll).toContain('bindIpAll: true');
    expect(
      rAll.warnings.some(
        (w) => w.includes('networkMode=host') && w.includes('0.0.0.0'),
      ),
    ).toBe(true);
  });

  test('replica-set + host 模式为非 IPv4 本机 RS_SELF_HOST 注入 extra_hosts 并隔离绑定 IP', () => {
    const dir = makeTempDir();
    const res = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'replica-set',
        name: 'rsnet',
        networkMode: 'host',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            name: 'node1',
            os: 'linux',
            bindIp: '10.8.0.11',
            backupDir: '/home/ops/bak',
          },
          {
            name: 'node2',
            os: 'linux',
            bindIp: '10.8.0.12',
            backupDir: '/home/ops/bak',
          },
          {
            name: 'node3',
            os: 'linux',
            bindIp: '10.8.0.13',
            backupDir: '/home/ops/bak',
          },
        ],
      },
    });
    const compose0 = readFileSync(
      join(res.bundleDirs[0]!, 'podman-compose.yml'),
      'utf8',
    );
    const selfHostMatches = compose0.match(
      /\$\{RS_SELF_HOST\}:\$\{MONGO_BIND_IP\}/g,
    );
    expect(selfHostMatches?.length).toBe(3);

    const conf0 = readFileSync(join(res.bundleDirs[0]!, 'mongod.conf'), 'utf8');
    expect(conf0).toContain('bindIp: "127.0.0.1,10.8.0.11"');

    const macRs = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'replica-set',
        name: 'macrs',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            name: 'node1',
            os: 'linux',
            bindIp: '10.8.0.11',
            backupDir: '/home/ops/bak',
          },
          {
            name: 'node2',
            os: 'linux',
            bindIp: '10.8.0.12',
            backupDir: '/home/ops/bak',
          },
          {
            name: 'node3',
            os: 'macos',
            bindIp: '10.8.0.13',
            backupDir: '/Users/ops/bak',
          },
        ],
      },
    });
    expect(
      macRs.warnings.some((w) => w.includes('cannot assign requested address')),
    ).toBe(true);
    expect(readFileSync(macRs.credentialsFile, 'utf8')).toContain('/etc/hosts');
  });
});

describe('CODD-P0-3 / P0-4 / P0-7: K8s existingSecret、指纹防截断与 YAML 引号', () => {
  test('显式 existingSecret 时 deploy.sh 跳过 create-secret.sh 改做存在性校验', () => {
    const dir = makeTempDir();
    const res = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'k8s-rs',
        name: 'vaultdb',
        apps: [{ db: 'app', user: 'appu' }],
        k8s: { namespace: 'prod', existingSecret: 'vault-managed-mongo' },
      },
    });
    const kDir = res.bundleDirs[0]!;
    const deploySh = readFileSync(join(kDir, 'deploy.sh'), 'utf8');
    expect(deploySh).not.toContain('"$SCRIPT_DIR/create-secret.sh"');
    expect(deploySh).toContain(
      'kubectl -n "prod" get secret "vault-managed-mongo" >/dev/null',
    );
    expect(existsSync(join(kDir, 'create-secret.sh'))).toBe(true);
    expect(readFileSync(join(kDir, 'create-secret.sh'), 'utf8')).toContain(
      'existingSecret',
    );
    if (process.platform !== 'win32') {
      expect(spawnSync('sh', ['-n', join(kDir, 'deploy.sh')]).status).toBe(0);
    }
  });

  test('超长 prefix+name 永不截断 12 位指纹, 且纯数字/布尔库名与 rsName 在 YAML 中保持引号字符串', () => {
    const dir = makeTempDir();
    const res = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'k8s-single',
        stackPrefix: 'a'.repeat(32),
        name: 'b'.repeat(32),
        rsName: 'on',
        apps: [{ db: '2026', user: 'true' }],
      },
    });
    const kDir = res.bundleDirs[0]!;
    const deploySh = readFileSync(join(kDir, 'deploy.sh'), 'utf8');
    const relMatch = /helm upgrade --install "([^"]+)"/.exec(deploySh);
    expect(relMatch).not.toBeNull();
    const releaseName = relMatch![1]!;
    expect(releaseName.length).toBeLessThanOrEqual(50);
    expect(releaseName.endsWith(`-${res.fingerprint}`)).toBe(true);

    const vals = readFileSync(join(kDir, 'values.generated.yaml'), 'utf8');
    expect(vals).toContain('database: "2026"');
    expect(vals).toContain('username: "true"');
    expect(vals).toContain('replSetName: "on"');
  });
});

describe('CODD-P0-5 & P0-8: 状态校验、空 keyFile 保护与排他锁', () => {
  test('auth.keyFile 空串不清空既有状态, 篡改状态与并发写锁均被拦截, --rotate-all 告警', () => {
    const dir = makeTempDir();
    const manifest: DeployManifest = {
      mode: 'single',
      name: 'sec',
      apps: [{ db: 'app', user: 'appu' }],
      nodes: [{ os: 'linux', backupDir: '/home/ops/bak' }],
    };
    const r1 = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest,
    });
    const state1 = JSON.parse(readFileSync(r1.stateFile, 'utf8')) as {
      keyFile: string;
      fingerprint: string;
    };
    expect(existsSync(`${r1.stateFile}.lock`)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(dirname(r1.stateFile)).mode % 0o1000).toBe(0o700);
    }

    generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: { ...manifest, auth: { keyFile: '' } },
    });
    const state2 = JSON.parse(readFileSync(r1.stateFile, 'utf8')) as {
      keyFile: string;
    };
    expect(state2.keyFile).toBe(state1.keyFile);

    const rRot = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest,
      rotate: 'all',
    });
    expect(rRot.warnings.some((w) => w.includes('--rotate-all'))).toBe(true);

    writeFileSync(`${r1.stateFile}.lock`, 'pid=99999\n', 'utf8');
    expect(() =>
      generateBundle({
        workDir: dir,
        templateDir: SOURCE_TEMPLATE_ROOT,
        manifest,
      }),
    ).toThrow(ConfigError);
    rmSync(`${r1.stateFile}.lock`, { force: true });

    for (const tampered of [
      { fingerprint: '../escape' },
      { rootPassword: 'bad"quote' },
      { keyFile: 'line1\nline2' },
      { appPasswords: { app: 'evil;id' } },
    ]) {
      writeFileSync(
        r1.stateFile,
        JSON.stringify({ ...state1, ...tampered }),
        'utf8',
      );
      expect(() =>
        generateBundle({
          workDir: dir,
          templateDir: SOURCE_TEMPLATE_ROOT,
          manifest,
        }),
      ).toThrow(ConfigError);
    }
  });
});

describe('CODD-P0-9 ~ P0-11 & P1-2 ~ P1-4: 无 argv 漏密、模板锚点与跨平台', () => {
  test('Makefile / tune-linux-host.sh 消除命令行明文凭据, tools.bun.lock 脱镜像并强制 LF', () => {
    const dir = makeTempDir();
    const res = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'noargv',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            os: 'macos',
            backupDir: '/private/var/mongo-bak',
            podmanBin: 'podman',
          },
        ],
      },
    });
    const bDir = res.bundleDirs[0]!;
    const makefile = readFileSync(join(bDir, 'Makefile'), 'utf8');
    expect(makefile).toContain('-e MONGO_INITDB_ROOT_PASSWORD');
    expect(makefile).toContain('process.env.MONGO_INITDB_ROOT_PASSWORD');
    expect(makefile).toContain('tools-rebuild:');
    expect(makefile).not.toContain('$$MONGO_INITDB_ROOT_PASSWORD@127.0.0.1');
    expect(makefile).not.toContain('\r\n');

    const tuneSh = readFileSync(join(bDir, 'tune-linux-host.sh'), 'utf8');
    expect(tuneSh).toContain('-e MONGO_INITDB_ROOT_PASSWORD');
    expect(tuneSh).not.toContain('${MONGO_INITDB_ROOT_PASSWORD}@127.0.0.1');
    expect(tuneSh).not.toContain('\r\n');

    const envFile = readFileSync(join(bDir, '.env'), 'utf8');
    expect(envFile).toContain('BUN_IMAGE=oven/bun:1.4.5-slim');
    expect(envFile).not.toContain('\r\n');

    const lockFile = readFileSync(join(bDir, 'bun.lock'), 'utf8');
    expect(lockFile).not.toContain('registry.npmmirror.com');

    expect(res.warnings.some((w) => w.includes('/Users/<用户名>'))).toBe(true);
    const plistName = readdirSync(bDir).find((f) => f.endsWith('.plist'))!;
    const plist = readFileSync(join(bDir, plistName), 'utf8');
    expect(plist).not.toContain('<string>.:');
    expect(plist).toContain('<string>/opt/homebrew/bin:');

    const winStep = formatUploadNextStep({
      nodeName: 'main',
      rsRole: 'primary',
      bundleDir: 'C:\\work\\dist\\mongo-app-abc',
      remoteStackDir: '~/srv/stacks/mongo-app-abc',
      parsedSsh: {
        target: 'ops@10.0.0.2',
        port: 2222,
        normalized: 'ssh -p 2222 ops@10.0.0.2',
        rsyncRshFlag: '-e "ssh -p 2222" ',
      },
      platform: 'win32',
    });
    expect(winStep).toContain('scp -r -P 2222');
    expect(winStep).toContain('"C:\\work\\dist\\mongo-app-abc"');
  });

  test('assets 锚文件防误命中、相对 templateDir 按 workDir 解析、破坏 lock 包名与工具脚本守卫', () => {
    const dir = makeTempDir();
    const outer = join(dir, 'outer-codd');
    mkdirSync(join(outer, 'template/podman'), { recursive: true });
    mkdirSync(join(outer, 'template/helm'), { recursive: true });
    writeFileSync(join(outer, 'package.json'), '{"name":"codd"}', 'utf8');
    writeFileSync(
      join(outer, 'template/podman/podman-compose.yml.tmpl'),
      '',
      'utf8',
    );
    writeFileSync(join(outer, 'template/helm/Chart.yaml'), '', 'utf8');
    const nestedFake = join(outer, 'nested-app');
    mkdirSync(join(nestedFake, 'template'), { recursive: true });
    writeFileSync(
      join(nestedFake, 'package.json'),
      '{"name":"nested"}',
      'utf8',
    );
    const nestedMod = join(nestedFake, 'index.js');
    writeFileSync(nestedMod, '', 'utf8');
    expect(resolvePackageRoot(pathToFileURL(nestedMod).href)).toBe(outer);

    const work = join(dir, 'work');
    const relTpl = join(work, 'custom-tpl');
    cpSync(SOURCE_TEMPLATE_ROOT, relTpl, { recursive: true });
    const rRel = generateBundle({
      workDir: work,
      templateDir: './custom-tpl',
      manifest: {
        mode: 'single',
        name: 'reltpl',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'linux', backupDir: '/home/ops/bak' }],
      },
    });
    expect(rRel.bundleDirs.length).toBe(1);

    writeFileSync(join(relTpl, 'podman/tools.bun.lock'), '{}', 'utf8');
    expect(() =>
      generateBundle({
        workDir: work,
        templateDir: './custom-tpl',
        manifest: {
          mode: 'single',
          name: 'badlock',
          apps: [{ db: 'app', user: 'appu' }],
          nodes: [{ os: 'linux', backupDir: '/home/ops/bak' }],
        },
      }),
    ).toThrow(TemplateRenderError);

    expect(buildDrillDbName('a'.repeat(63)).length).toBeLessThanOrEqual(63);
    const backupTs = readFileSync(
      join(SOURCE_TEMPLATE_ROOT, 'podman/backup.ts'),
      'utf8',
    );
    expect(backupTs).toContain('if (size === 0)');
    const drillTs = readFileSync(
      join(SOURCE_TEMPLATE_ROOT, 'podman/drill.ts'),
      'utf8',
    );
    expect(drillTs).toContain("{ type: 'collection' }");
    expect(drillTs).toContain("startsWith('system.')");
    expect(drillTs).not.toContain('27999');

    const stsYaml = readFileSync(
      join(SOURCE_TEMPLATE_ROOT, 'helm/templates/statefulset.yaml'),
      'utf8',
    );
    expect(stsYaml).toContain('set -euo pipefail');
    expect(stsYaml).toContain('kill -0 "$PID"');
    expect(stsYaml).toContain('$fixResources');
    expect(stsYaml).toContain('$bootstrapResources');

    const initCm = readFileSync(
      join(SOURCE_TEMPLATE_ROOT, 'helm/templates/init-configmap.yaml'),
      'utf8',
    );
    expect(initCm).toContain('encodeURIComponent');
  });
});
