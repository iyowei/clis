/**
 * @iyowei/codd Helm 模板 | quote 专项回归测试:
 * 验证合规但易被 YAML 误解析为数字/布尔的 releaseName ('2026' / 'true') 下,
 * 全部 Helm 模板 name / labels / selector 与 values.generated.yaml 均以字符串引号输出。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateBundle } from './index.ts';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codd-helm-quote-'));
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

describe('Helm 模板数字/布尔 releaseName 引号防护', () => {
  test("releaseName='2026' 与 releaseName='true' 生成产物中模板全含 | quote 且 values 字段带引号", () => {
    const dir = makeTempDir();
    const helmProbe = spawnSync('helm', ['version', '--short'], {
      stdio: 'ignore',
    });

    for (const [mode, releaseName, name] of [
      ['k8s-single', '2026', 'numrel'],
      ['k8s-rs', 'true', 'boolrel'],
    ] as const) {
      const res = generateBundle({
        workDir: dir,
        manifest: {
          mode,
          name,
          apps: [{ db: '2026', user: 'true' }],
          k8s: { namespace: 'data', releaseName },
        },
      });
      const kDir = res.bundleDirs[0]!;
      const tplDir = join(kDir, 'chart/templates');

      const helpers = readFileSync(join(tplDir, '_helpers.tpl'), 'utf8');
      expect(helpers).toContain(
        'app.kubernetes.io/instance: {{ .Release.Name | quote }}',
      );
      expect(helpers).toContain(
        'helm.sh/chart: {{ include "mongo.chart" . | quote }}',
      );
      expect(helpers).toContain(
        'app.kubernetes.io/managed-by: {{ .Release.Service | quote }}',
      );

      const service = readFileSync(join(tplDir, 'service.yaml'), 'utf8');
      expect(service).toContain(
        'name: {{ printf "%s-headless" (include "mongo.fullname" .) | quote }}',
      );
      expect(service).toContain(
        'name: {{ include "mongo.fullname" . | quote }}',
      );
      expect(service).toContain('type: {{ .Values.service.type | quote }}');

      const initCm = readFileSync(join(tplDir, 'init-configmap.yaml'), 'utf8');
      expect(initCm).toContain(
        'name: {{ printf "%s-init-script" (include "mongo.fullname" .) | quote }}',
      );

      const secret = readFileSync(join(tplDir, 'secret.yaml'), 'utf8');
      expect(secret).toContain('name: {{ $secretName | quote }}');

      const vals = readFileSync(join(kDir, 'values.generated.yaml'), 'utf8');
      expect(vals).toContain(`existingSecret: "${releaseName}-auth"`);
      expect(vals).toContain('database: "2026"');
      expect(vals).toContain('username: "true"');

      const deploySh = readFileSync(join(kDir, 'deploy.sh'), 'utf8');
      expect(deploySh).toContain(`helm upgrade --install "${releaseName}"`);
      const createSecretSh = readFileSync(
        join(kDir, 'create-secret.sh'),
        'utf8',
      );
      expect(createSecretSh).toContain(`name: "${releaseName}-auth"`);

      if (helmProbe.status === 0) {
        const lint = spawnSync(
          'helm',
          [
            'lint',
            join(kDir, 'chart'),
            '-f',
            join(kDir, 'values.generated.yaml'),
          ],
          { encoding: 'utf8' },
        );
        expect(lint.status).toBe(0);

        const tpl = spawnSync(
          'helm',
          [
            'template',
            releaseName,
            join(kDir, 'chart'),
            '-f',
            join(kDir, 'values.generated.yaml'),
          ],
          { encoding: 'utf8' },
        );
        expect(tpl.status).toBe(0);
        expect(tpl.stdout).toContain(
          `app.kubernetes.io/instance: "${releaseName}"`,
        );
        expect(tpl.stdout).toContain(`name: "${releaseName}"`);
        expect(tpl.stdout).toContain(`name: "${releaseName}-headless"`);
        expect(tpl.stdout).toContain(`name: "${releaseName}-init-script"`);
        expect(tpl.stdout).toContain(`name: "${releaseName}-config"`);
        expect(tpl.stdout).toContain(`name: "${releaseName}-init"`);

        const tplSecret = spawnSync(
          'helm',
          [
            'template',
            releaseName,
            join(kDir, 'chart'),
            '-f',
            join(kDir, 'values.generated.yaml'),
            '--set',
            'auth.existingSecret=',
          ],
          { encoding: 'utf8' },
        );
        expect(tplSecret.status).toBe(0);
        expect(tplSecret.stdout).toContain(`name: "${releaseName}-auth"`);
      }
    }
  }, 30_000);
});
