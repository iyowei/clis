/**
 * @iyowei/codd 模板化部署包生成单测:
 * 覆盖 single / replica-set / k8s-single / k8s-rs 拓扑、P0/P1 修复与清单红线拦截。
 */
import { describe, expect, test } from 'bun:test';

import {
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
import { join } from 'node:path';

import { ConfigError, type DeployManifest, generateBundle } from './index.ts';

interface TestWorkspace {
  tmpDir: string;
  outDir: string;
  stateDir: string;
  cleanup: () => void;
}

const makeTestWorkspace = (): TestWorkspace => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'codd-gen-test-'));
  const outDir = join(tmpDir, 'dist');
  const stateDir = join(tmpDir, 'state');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    tmpDir,
    outDir,
    stateDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
};

const writeManifest = (
  dir: string,
  m: DeployManifest,
  fileName = 'deploy.json',
): string => {
  const p = join(dir, fileName);
  writeFileSync(p, JSON.stringify(m, null, 2), 'utf8');
  return p;
};

describe('Podman 单节点、密码轮换与 P0/P1 修复验证', () => {
  test('single 模式输出带指纹部署目录、0600 凭证、.codd-state/.gitignore 与零残留占位符', () => {
    const ws = makeTestWorkspace();
    try {
      const mPath = writeManifest(ws.tmpDir, {
        mode: 'single',
        name: 'core',
        keepWeekly: 0,
        hardware: {
          cpuCores: 4,
          memoryGb: 8,
          diskGb: 100,
          workload: 'balanced',
        },
        apps: [
          { db: 'orders', user: 'ordersu' },
          { db: 'billing', user: 'billu' },
        ],
        nodes: [
          {
            name: 'host1',
            os: 'macos',
            bindIp: '0.0.0.0',
            host: '127.0.0.1',
            backupDir: '/Users/alice/srv/backups/mongo-core',
            stackDir: '/Users/alice/custom-stacks',
          },
        ],
      });

      const r1 = generateBundle({
        workDir: ws.tmpDir,
        manifestPath: mPath,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
      });
      expect(r1.bundleDirs.length).toBe(1);
      expect(readdirSync(ws.outDir)).toEqual([`mongo-core-${r1.fingerprint}`]);
      expect(r1.backupDirs).toEqual([
        `/Users/alice/srv/backups/mongo-core-${r1.fingerprint}`,
      ]);
      expect(readFileSync(join(ws.stateDir, '.gitignore'), 'utf8')).toBe('*\n');
      expect(r1.nextSteps[0]).toContain(
        `/Users/alice/custom-stacks/mongo-core-${r1.fingerprint}/`,
      );

      const b1 = r1.bundleDirs[0]!;
      expect(existsSync(join(b1, '.dockerignore'))).toBe(true);
      expect(existsSync(join(b1, 'tune-linux-host.sh'))).toBe(true);
      expect(existsSync(join(b1, 'docs'))).toBe(false);

      for (const fname of readdirSync(b1)) {
        if (fname === 'bun.lock') continue;
        const txt = readFileSync(join(b1, fname), 'utf8');
        const cleaned =
          fname === 'Makefile'
            ? txt.replace(/\{\{\.[A-Za-z0-9_.]+\}\}/g, '')
            : txt;
        expect(/\{\{[A-Z0-9_]+\}\}/.test(cleaned)).toBe(false);
        expect(txt.includes('<FINGERPRINT>')).toBe(false);
      }

      const env1 = readFileSync(join(b1, '.env'), 'utf8');
      expect(env1).toContain(`FINGERPRINT=${r1.fingerprint}`);
      expect(env1).toContain('KEEP_WEEKLY=0');
      expect(env1).toContain('WT_CACHE_GB=3.5');
      expect(env1).toContain('MEMORY_LIMIT=8g');
      if (process.platform !== 'win32') {
        expect(statSync(join(b1, '.env')).mode % 0o1000).toBe(0o600);
      }

      const creds1 = readFileSync(r1.credentialsFile, 'utf8');
      expect(creds1).toContain('全网卡监听连接串');
      expect(creds1).toContain(
        '@127.0.0.1:27117/orders?authSource=orders&directConnection=true&compressors=zstd',
      );
      expect(creds1).toContain(
        '@mongo:27117/orders?authSource=orders&compressors=zstd',
      );

      const bundlePkg = JSON.parse(
        readFileSync(join(b1, 'package.json'), 'utf8'),
      ) as { engines: { bun: string } };
      expect(bundlePkg.engines.bun).toBe('>=1.4.2');
      expect(readFileSync(join(b1, 'Makefile'), 'utf8')).toContain(
        'tune-host:',
      );

      const r2 = generateBundle({
        workDir: ws.tmpDir,
        manifestPath: mPath,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
      });
      expect(r2.fingerprint).toBe(r1.fingerprint);
      expect(readFileSync(join(b1, '.env'), 'utf8')).toBe(env1);

      generateBundle({
        workDir: ws.tmpDir,
        manifestPath: mPath,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
        rotate: 'apps',
      });
      const env3 = readFileSync(join(b1, '.env'), 'utf8');
      const getK = (t: string, k: string) =>
        t.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
      expect(getK(env3, 'MONGO_INITDB_ROOT_PASSWORD')).toBe(
        getK(env1, 'MONGO_INITDB_ROOT_PASSWORD'),
      );
      expect(getK(env3, 'MONGO_APP_PASSWORD')).not.toBe(
        getK(env1, 'MONGO_APP_PASSWORD'),
      );

      const r4 = generateBundle({
        workDir: ws.tmpDir,
        manifestPath: mPath,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
        newFingerprint: true,
      });
      expect(r4.fingerprint).not.toBe(r1.fingerprint);
      expect(r4.bundleDirs[0]).not.toBe(r1.bundleDirs[0]);
      expect(r4.backupDirs[0]).not.toBe(r1.backupDirs[0]);
    } finally {
      ws.cleanup();
    }
  });

  test('multiNetAlias=true 隔离容器别名与连接串, host+0.0.0.0 使用 127.0.0.1 作为客户端目标, 损坏状态文件抛 ConfigError', () => {
    const ws = makeTestWorkspace();
    try {
      const rAlias = generateBundle({
        workDir: ws.tmpDir,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
        manifest: {
          mode: 'single',
          name: 'multi',
          multiNetAlias: true,
          apps: [{ db: 'app', user: 'appu' }],
          nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
        },
      });
      const aliasHost = `mongo-${rAlias.fingerprint}`;
      const composeAlias = readFileSync(
        join(rAlias.bundleDirs[0]!, 'podman-compose.yml'),
        'utf8',
      );
      expect(composeAlias).toContain(`- ${aliasHost}`);
      expect(composeAlias).not.toContain('- mongo\n');
      expect(composeAlias).toContain(`MONGO_HOST: ${aliasHost}`);
      const credsAlias = readFileSync(rAlias.credentialsFile, 'utf8');
      expect(credsAlias).toContain(
        `@${aliasHost}:27117/app?authSource=app&compressors=zstd`,
      );

      const rHost = generateBundle({
        workDir: ws.tmpDir,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
        manifest: {
          mode: 'single',
          name: 'hostzero',
          networkMode: 'host',
          apps: [{ db: 'app', user: 'appu' }],
          nodes: [
            {
              os: 'linux',
              bindIp: '0.0.0.0',
              backupDir: '/home/ops/srv/backups',
            },
          ],
        },
      });
      const composeHost = readFileSync(
        join(rHost.bundleDirs[0]!, 'podman-compose.yml'),
        'utf8',
      );
      expect(composeHost).toContain('MONGO_HOST: 127.0.0.1');
      expect(composeHost).not.toContain(
        'MONGO_HOST: ${MONGO_BIND_IP:-0.0.0.0}',
      );

      // 写入损坏的 .state.json, 应包装为 ConfigError 而非裸 SyntaxError
      writeFileSync(rHost.stateFile, '{ broken json', 'utf8');
      expect(() =>
        generateBundle({
          workDir: ws.tmpDir,
          outDir: ws.outDir,
          stateDir: ws.stateDir,
          manifest: {
            mode: 'single',
            name: 'hostzero',
            networkMode: 'host',
            apps: [{ db: 'app', user: 'appu' }],
            nodes: [
              {
                os: 'linux',
                bindIp: '0.0.0.0',
                backupDir: '/home/ops/srv/backups',
              },
            ],
          },
        }),
      ).toThrow(ConfigError);
    } finally {
      ws.cleanup();
    }
  });
});

describe('多节点副本集、Kubernetes 与红线拦截验证', () => {
  test('replica-set 模式输出 3 台物理节点隔离套件并拦截 macOS + host 网络混配', () => {
    const ws = makeTestWorkspace();
    try {
      const mPath = writeManifest(ws.tmpDir, {
        mode: 'replica-set',
        name: 'ha',
        networkMode: 'host',
        hardware: { cpuCores: 4, memoryGb: 8, diskGb: 100 },
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            name: 'node1',
            os: 'linux',
            bindIp: '10.8.0.11',
            backupDir: '/home/ops/srv/backups',
          },
          {
            name: 'node2',
            os: 'linux',
            bindIp: '10.8.0.12',
            backupDir: '/home/ops/srv/backups',
          },
          {
            name: 'node3',
            os: 'linux',
            bindIp: '10.8.0.13',
            backupDir: '/home/ops/srv/backups',
          },
        ],
      });

      const res = generateBundle({
        workDir: ws.tmpDir,
        manifestPath: mPath,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
      });
      expect(res.bundleDirs.length).toBe(3);
      expect(new Set(res.backupDirs).size).toBe(3);

      const env0 = readFileSync(join(res.bundleDirs[0]!, '.env'), 'utf8');
      const compose0 = readFileSync(
        join(res.bundleDirs[0]!, 'podman-compose.yml'),
        'utf8',
      );
      expect(env0).toContain('RS_ROLE=primary');
      expect(env0).toContain('RS_PEER_1=node2:10.8.0.12');
      expect(compose0).toContain('network_mode: host');
      expect(readFileSync(res.credentialsFile, 'utf8')).toContain(
        '&compressors=zstd',
      );

      expect(() =>
        generateBundle({
          workDir: ws.tmpDir,
          manifest: {
            mode: 'single',
            name: 'badhost',
            networkMode: 'host',
            apps: [{ db: 'app', user: 'appu' }],
            nodes: [{ os: 'macos', backupDir: '/Users/ops/srv/backups' }],
          },
          outDir: ws.outDir,
          stateDir: ws.stateDir,
        }),
      ).toThrow(ConfigError);
    } finally {
      ws.cleanup();
    }
  });

  test('k8s-rs 模式输出自包含 chart/ 目录并严格拦截手写 fingerprint 与 overrides', () => {
    const ws = makeTestWorkspace();
    try {
      const mPath = writeManifest(ws.tmpDir, {
        mode: 'k8s-rs',
        name: 'cluster',
        hardware: {
          cpuCores: 4,
          memoryGb: 8,
          diskGb: 100,
          workload: 'write-heavy',
        },
        apps: [
          { db: 'main', user: 'mainu' },
          { db: 'logs', user: 'logsu' },
        ],
        k8s: { namespace: 'prod-db', storageClass: 'gp3' },
      });

      const res = generateBundle({
        workDir: ws.tmpDir,
        manifestPath: mPath,
        outDir: ws.outDir,
        stateDir: ws.stateDir,
      });
      const kDir = res.bundleDirs[0]!;
      expect(existsSync(join(kDir, 'chart/Chart.yaml'))).toBe(true);
      expect(existsSync(join(kDir, 'chart/.helmignore'))).toBe(true);
      expect(existsSync(join(kDir, 'chart/templates/statefulset.yaml'))).toBe(
        true,
      );

      const vals = readFileSync(join(kDir, 'values.generated.yaml'), 'utf8');
      expect(vals).toContain('replicaCount: 3');
      expect(vals).toContain('cacheSizeGB: 3.5');
      expect(vals).toContain('oplogSizeMB: 8190');
      expect(vals).not.toContain('logsu:');
      expect(readFileSync(join(kDir, 'create-secret.sh'), 'utf8')).toContain(
        "--from-literal=extra-apps='logs:logsu:",
      );
      expect(readFileSync(join(kDir, 'deploy.sh'), 'utf8')).toContain(
        '"$SCRIPT_DIR/chart"',
      );
      expect(readFileSync(res.credentialsFile, 'utf8')).toContain(
        '&compressors=zstd',
      );

      const mBadFp = writeManifest(
        ws.tmpDir,
        {
          mode: 'single',
          name: 'badfp',
          fingerprint: 'deadbeef1234',
          apps: [{ db: 'app', user: 'appu' }],
          nodes: [{ os: 'linux', backupDir: '/home/ops/bak' }],
        } as unknown as DeployManifest,
        'bad-fp.json',
      );
      expect(() =>
        generateBundle({
          workDir: ws.tmpDir,
          manifestPath: mBadFp,
          outDir: ws.outDir,
          stateDir: ws.stateDir,
        }),
      ).toThrow(ConfigError);

      const mBadOv = writeManifest(
        ws.tmpDir,
        {
          mode: 'single',
          name: 'badov',
          overrides: { wtCacheGb: 4 },
          apps: [{ db: 'app', user: 'appu' }],
          nodes: [{ os: 'linux', backupDir: '/home/ops/bak' }],
        } as unknown as DeployManifest,
        'bad-ov.json',
      );
      expect(() =>
        generateBundle({
          workDir: ws.tmpDir,
          manifestPath: mBadOv,
          outDir: ws.outDir,
          stateDir: ws.stateDir,
        }),
      ).toThrow(ConfigError);
    } finally {
      ws.cleanup();
    }
  });
});
