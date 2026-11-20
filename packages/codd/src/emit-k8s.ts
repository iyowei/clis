/**
 * Kubernetes (Helm) 自包含部署包渲染器 (支持单副本与 3 副本高可用 StatefulSet)。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { readTemplateFile, resolveTemplateFilePath } from './assets.ts';
import type { ComputedSizing } from './formulas.ts';
import { renderTemplate } from './render.ts';
import { writeSecretFile } from './state.ts';
import type { DeployManifest, GenerateState } from './types.ts';

export interface K8sEmitContext {
  helmTplDir: string;
  outDir: string;
  deployId: string;
  manifest: DeployManifest;
  sizing: ComputedSizing;
  state: GenerateState;
  bundleDirs: string[];
  credLines: string[];
  nextSteps: string[];
}

const writeLf = (targetPath: string, content: string): void => {
  writeFileSync(targetPath, content.replaceAll('\r\n', '\n'), 'utf8');
};

const copyPortableHelmChart = (
  helmTplDir: string,
  targetChartDir: string,
): void => {
  mkdirSync(join(targetChartDir, 'templates'), { recursive: true });
  writeLf(
    join(targetChartDir, 'Chart.yaml'),
    readTemplateFile(helmTplDir, 'Chart.yaml'),
  );
  writeLf(
    join(targetChartDir, 'values.yaml'),
    readTemplateFile(helmTplDir, 'values.yaml'),
  );

  const helmIgnoreSrc = resolveTemplateFilePath(helmTplDir, '.helmignore');
  if (existsSync(helmIgnoreSrc)) {
    writeLf(
      join(targetChartDir, '.helmignore'),
      readFileSync(helmIgnoreSrc, 'utf8'),
    );
  }

  for (const entry of readdirSync(join(helmTplDir, 'templates'))) {
    if (entry.endsWith('.yaml') || entry.endsWith('.tpl')) {
      writeLf(
        join(targetChartDir, 'templates', entry),
        readFileSync(join(helmTplDir, 'templates', entry), 'utf8'),
      );
    }
  }
};

/**
 * 推导默认 Helm Release 名称: 先截断前缀至 <= (50 - 1 - fp.length) 并去尾 '-',
 * 再固定拼接 -${fingerprint}, 保证永不截断指纹且派生 init-configmap/Pod 名恒 <= 63。
 */
const buildDefaultReleaseName = (
  stackPrefix: string,
  manifestName: string,
  fingerprint: string,
): string => {
  const maxPrefixLen = Math.max(1, 50 - 1 - fingerprint.length);
  const rawPrefix = `${stackPrefix}-${manifestName}`
    .slice(0, maxPrefixLen)
    .replace(/-+$/, '');
  const safePrefix = rawPrefix || 'm';
  return `${safePrefix}-${fingerprint}`;
};

export const emitK8sBundle = (ctx: K8sEmitContext): void => {
  const { helmTplDir, outDir, deployId, manifest, sizing, state } = ctx;
  const stackPrefix = manifest.stackPrefix ?? 'mongo';
  const imageName = manifest.imageName ?? 'mongo';
  const imageTag = manifest.imageTag ?? '9.0.8';
  const port = manifest.port ?? 27117;
  const rsName = manifest.rsName ?? 'rs0';

  const primaryApp = manifest.apps[0]!;
  const extraAppsStr = manifest.apps
    .slice(1)
    .map((a) => `${a.db}:${a.user}:${state.appPasswords[a.db]}`)
    .join(',');

  const replicaCount = manifest.mode === 'k8s-single' ? 1 : 3;
  const ns = manifest.k8s?.namespace ?? 'data';
  const defaultRelease = buildDefaultReleaseName(
    stackPrefix,
    manifest.name,
    state.fingerprint,
  );
  const releaseName = manifest.k8s?.releaseName ?? defaultRelease;
  const explicitExistingSecret =
    manifest.k8s?.existingSecret?.trim() ||
    manifest.auth?.existingSecret?.trim() ||
    '';
  const usesExistingSecret = explicitExistingSecret.length > 0;
  const secretName = usesExistingSecret
    ? explicitExistingSecret
    : `${releaseName}-auth`;
  const serviceType = manifest.k8s?.serviceType ?? 'ClusterIP';
  const nodePort = manifest.k8s?.nodePort ?? 30117;
  const defaultAntiAffinity = replicaCount > 1 ? 'hard' : 'soft';
  const antiAffinity = manifest.k8s?.podAntiAffinity ?? defaultAntiAffinity;
  const storageClass = manifest.k8s?.storageClass ?? '';

  const k8sDirName = releaseName.includes(state.fingerprint)
    ? `${releaseName}-k8s`
    : `${releaseName}-${state.fingerprint}-k8s`;
  const k8sDir = join(outDir, k8sDirName);
  rmSync(k8sDir, { recursive: true, force: true });
  mkdirSync(k8sDir, { recursive: true });
  ctx.bundleDirs.push(k8sDir);

  copyPortableHelmChart(helmTplDir, join(k8sDir, 'chart'));

  const valuesRendered = renderTemplate(
    'values.generated.yaml.tmpl',
    readTemplateFile(helmTplDir, 'values.generated.yaml.tmpl'),
    {
      DEPLOY_ID: deployId,
      HARDWARE_SUMMARY: sizing.hardwareSummary,
      FORMULA_SUMMARY: sizing.formulaSummary,
      REPLICA_COUNT: replicaCount,
      STOP_GRACE_PERIOD: sizing.stopGracePeriodSec,
      IMAGE_REPOSITORY: imageName,
      IMAGE_TAG: imageTag,
      EXISTING_SECRET: secretName,
      ROOT_USERNAME: state.rootUsername,
      BACKUP_USERNAME: state.backupUsername,
      APP_DATABASE: primaryApp.db,
      APP_USERNAME: primaryApp.user,
      SERVICE_TYPE: serviceType,
      PORT: port,
      NODE_PORT: nodePort,
      CPU_LIMIT: sizing.cpuLimit,
      K8S_LIMIT_MEMORY: sizing.k8sLimitMemory,
      K8S_REQUEST_CPU: sizing.k8sRequestCpu,
      K8S_REQUEST_MEMORY: sizing.k8sRequestMemory,
      PERSISTENCE_SIZE: sizing.persistenceSize,
      STORAGE_CLASS: storageClass,
      ANTI_AFFINITY_ENABLED: replicaCount > 1 ? 'true' : 'false',
      ANTI_AFFINITY_TYPE: antiAffinity,
      MAX_INCOMING_CONNECTIONS: sizing.maxIncomingConnections,
      BLOCK_COMPRESSOR: sizing.blockCompressor,
      WT_CACHE_GB: sizing.wtCacheGb,
      RS_NAME: rsName,
      OPLOG_SIZE_MB: sizing.oplogSizeMb,
      SLOW_OP_THRESHOLD_MS: sizing.slowOpThresholdMs,
    },
  );

  const secretNotice = usesExistingSecret
    ? '# 注意: 清单已显式指定 existingSecret, deploy.sh 不会自动执行本脚本 (仅保留供外部 Vault/ExternalSecrets 核对键名)。\n'
    : '';
  const secretRendered = renderTemplate(
    'create-secret.sh.tmpl',
    readTemplateFile(helmTplDir, 'create-secret.sh.tmpl'),
    {
      SECRET_NOTICE: secretNotice,
      NAMESPACE: ns,
      SECRET_NAME: secretName,
      ROOT_PASSWORD: state.rootPassword,
      APP_PASSWORD: state.appPasswords[primaryApp.db]!,
      BACKUP_PASSWORD: state.backupPassword,
      EXTRA_APPS: extraAppsStr,
      KEY_FILE: state.keyFile,
    },
  );

  const secretStep = usesExistingSecret
    ? [
        `# 已显式指定 existingSecret (${secretName}), 跳过执行 create-secret.sh 以免覆写外部托管 Secret (create-secret.sh 仅保留供参考)`,
        `kubectl -n "${ns}" get secret "${secretName}" >/dev/null`,
      ].join('\n')
    : '"$SCRIPT_DIR/create-secret.sh"';

  const deployRendered = renderTemplate(
    'deploy.sh.tmpl',
    readTemplateFile(helmTplDir, 'deploy.sh.tmpl'),
    {
      SECRET_STEP: secretStep,
      RELEASE_NAME: releaseName,
      NAMESPACE: ns,
    },
  );

  writeLf(join(k8sDir, 'values.generated.yaml'), valuesRendered);
  writeSecretFile(join(k8sDir, 'create-secret.sh'), secretRendered, 0o700);
  writeSecretFile(join(k8sDir, 'deploy.sh'), deployRendered, 0o700);

  if (replicaCount === 1) {
    ctx.credLines.push('# K8s 单副本集群内连接串:');
    for (const app of manifest.apps) {
      ctx.credLines.push(
        `mongodb://${app.user}:${state.appPasswords[app.db]}@${releaseName}.${ns}.svc.cluster.local:${port}/${app.db}?authSource=${app.db}&directConnection=true`,
      );
    }
  } else {
    const fqdns = Array.from(
      { length: replicaCount },
      (_, i) =>
        `${releaseName}-${i}.${releaseName}-headless.${ns}.svc.cluster.local:${port}`,
    ).join(',');
    ctx.credLines.push('# K8s 3 副本高可用自动切主连接串:');
    for (const app of manifest.apps) {
      ctx.credLines.push(
        `mongodb://${app.user}:${state.appPasswords[app.db]}@${fqdns}/${app.db}?replicaSet=${rsName}&authSource=${app.db}`,
      );
    }
  }

  const deployPath = join(k8sDir, 'deploy.sh');
  ctx.nextSteps.push(
    process.platform === 'win32'
      ? `bash "${deployPath.replaceAll('\\', '/')}" (请在 Git Bash 或 WSL 中执行)`
      : `bash "${deployPath}"`,
  );
};
