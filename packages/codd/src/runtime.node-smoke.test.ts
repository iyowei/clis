/**
 * 双运行时冒烟: 在真实 Node.js 子进程中加载构建产物 `dist/index.js`,
 * 验证公开核心 API (`computeSizing` / `validateManifest` / `recommendSafePort` / `resolveTemplateRoot`)
 * 在纯 Node 环境下无 Bun 专有 API 依赖且结果一致。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js');

const HAS_NODE =
  spawnSync('node', ['--version'], { stdio: 'ignore' }).status === 0;

describe('codd 双运行时冒烟 (Node.js 加载 dist/index.js)', () => {
  test.skipIf(!HAS_NODE)(
    '纯 Node 进程导入 dist/index.js 并执行核心 API 零异常',
    () => {
      expect(existsSync(DIST_ENTRY)).toBe(true);
      const entryUrl = pathToFileURL(DIST_ENTRY).href;
      const script = `
        import * as codd from ${JSON.stringify(entryUrl)};
        const sizing = codd.computeSizing({ cpuCores: 2, memoryGb: 2, diskGb: 32, workload: 'balanced' });
        const port = codd.recommendSafePort(() => 0.25);
        const tplRoot = codd.resolveTemplateRoot();
        const warnings = codd.validateManifest({
          mode: 'single',
          name: 'smoke-db',
          hardware: { cpuCores: 2, memoryGb: 2, diskGb: 32, workload: 'balanced' },
          apps: [{ db: 'app', user: 'appuser' }],
          nodes: [{ os: 'linux', backupDir: '/var/backups/mongo' }],
        });
        process.stdout.write(JSON.stringify({
          wtCacheGb: sizing.wtCacheGb,
          nofile: sizing.nofileUlimit,
          portValid: port >= 10002 && port <= 29997,
          hasTpl: typeof tplRoot === 'string' && tplRoot.length > 0,
          warningsOk: Array.isArray(warnings) && warnings.length === 0,
        }));
      `;
      const res = spawnSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      });
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(out.wtCacheGb).toBe(0.5);
      expect(out.nofile).toBe(65536);
      expect(out.portValid).toBe(true);
      expect(out.hasTpl).toBe(true);
      expect(out.warningsOk).toBe(true);
    },
  );
});
