/**
 * Podman 部署包渲染器 (支持单节点与 3 物理节点高可用副本集)。
 */
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { readTemplateFile } from './assets.ts';
import {
  type ResolvedPodmanNode,
  appendSingleCreds,
  buildMongodBindLine,
  buildNetworkFragments,
  computeRsMemberHost,
  emitMacosPlist,
  formatSinglePostUploadSteps,
  formatUploadNextStep,
  writeLfFile,
} from './emit-podman-helpers.ts';
import type { ComputedSizing, HardwareSpec } from './formulas.ts';
import { TemplateRenderError, renderTemplate } from './render.ts';
import {
  deriveRemoteHome,
  parseSshInput,
  resolveServerStackDir,
} from './ssh.ts';
import { writeSecretFile } from './state.ts';
import type {
  AppInput,
  DeployManifest,
  GenerateState,
  NetworkMode,
} from './types.ts';
import { IPV4_RE } from './validate.ts';

const STATIC_PODMAN_FILES = [
  'init.js',
  'Dockerfile',
  '.dockerignore',
  'bunfig.toml',
  'lib.ts',
  'backup.ts',
  'drill.ts',
  'restore.ts',
  'tune-linux-host.sh',
];

const TOOLS_LOCK_NAME_RE = /"name":\s*"codd"/;

interface ToolsPackageManifest {
  version: string;
  engines?: { bun?: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface PodmanEmitContext {
  podmanTplDir: string;
  outDir: string;
  deployId: string;
  manifest: DeployManifest;
  hw: HardwareSpec;
  sizing: ComputedSizing;
  state: GenerateState;
  backupDirs: string[];
  bundleDirs: string[];
  credLines: string[];
  nextSteps: string[];
  warnings: string[];
}

interface PodmanTemplates {
  composeTmpl: string;
  mongodTmpl: string;
  envTmpl: string;
  plistTmpl: string;
  makeRendered: string;
  toolsPkg: string;
  toolsLock: string;
}

const emitSinglePodmanNode = (opts: {
  ctx: PodmanEmitContext;
  tpls: PodmanTemplates;
  resolvedNodes: ResolvedPodmanNode[];
  idx: number;
  rsMembers: string;
  primaryApp: AppInput;
  extraAppsStr: string;
}): {
  remoteStackDir: string;
  parsedSsh: ReturnType<typeof parseSshInput> | null;
} => {
  const { ctx, tpls, resolvedNodes, idx, rsMembers, primaryApp, extraAppsStr } =
    opts;
  const { podmanTplDir, outDir, deployId, manifest, hw, sizing, state } = ctx;
  const node = resolvedNodes[idx]!;
  const stackPrefix = manifest.stackPrefix ?? 'mongo';
  const port = manifest.port ?? 27117;
  const hostPort = manifest.hostPort ?? port;
  const rsName = manifest.rsName ?? 'rs0';
  const networkMode: NetworkMode = manifest.networkMode ?? 'bridge';

  const dirName =
    manifest.mode === 'single'
      ? `${stackPrefix}-${manifest.name}-${state.fingerprint}`
      : `${stackPrefix}-${manifest.name}-${state.fingerprint}-${node.nodeName}`;
  const bundleDir = join(outDir, dirName);
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  ctx.bundleDirs.push(bundleDir);

  for (const f of STATIC_PODMAN_FILES) {
    writeLfFile(join(bundleDir, f), readTemplateFile(podmanTplDir, f));
  }
  chmodSync(join(bundleDir, 'tune-linux-host.sh'), 0o755);

  const peers = resolvedNodes.filter((_, j) => j !== idx);
  const rsRole = idx === 0 ? 'primary' : 'secondary';
  const net = buildNetworkFragments({
    manifest,
    networkMode,
    node,
    stackPrefix,
    fingerprint: state.fingerprint,
    port,
    hostPort,
  });
  const rsSelfHostExtra =
    manifest.mode === 'replica-set' &&
    networkMode === 'host' &&
    !IPV4_RE.test(node.host)
      ? '      - "${RS_SELF_HOST}:${MONGO_BIND_IP}"\n'
      : '';

  const sharedVars = {
    DEPLOY_ID: deployId,
    NODE_NAME: node.nodeName,
    HARDWARE_SUMMARY: sizing.hardwareSummary,
    FORMULA_SUMMARY: sizing.formulaSummary,
    STACK_PREFIX: stackPrefix,
    FINGERPRINT: state.fingerprint,
    TZ: manifest.tz ?? 'Asia/Shanghai',
    MONGO_IMAGE_NAME: manifest.imageName ?? 'mongo',
    MONGO_IMAGE_TAG: manifest.imageTag ?? '9.0.8',
    BUN_IMAGE: manifest.bunImage ?? 'oven/bun:1.4.5-slim',
    TOOLS_IMAGE_NAME: `${stackPrefix}-tools`,
    MONGO_BIND_IP: node.bindIp,
    MONGO_PORT: port,
    MONGO_HOST_PORT: hostPort,
    RS_NAME: rsName,
    RS_ROLE: rsRole,
    WT_CACHE_GB: sizing.wtCacheGb,
    CPU_LIMIT: sizing.cpuLimit,
    MEMORY_LIMIT: sizing.memoryLimitPodman,
    MEMORY_RESERVATION: sizing.memoryReservationPodman,
    BACKUP_CONCURRENCY: sizing.backupConcurrency,
    BACKUP_MIN_FREE_MB: manifest.backupMinFreeMb ?? sizing.backupMinFreeMb,
    BACKUP_MAX_TOTAL_MB: manifest.backupMaxTotalMb ?? sizing.backupMaxTotalMb,
    KEEP_DAILY: manifest.keepDaily ?? 7,
    KEEP_WEEKLY: manifest.keepWeekly ?? 4,
  };

  const composeRendered = renderTemplate(
    'podman-compose.yml.tmpl',
    tpls.composeTmpl,
    {
      ...sharedVars,
      STOP_GRACE_PERIOD: sizing.stopGracePeriodSec,
      NOFILE_ULIMIT: sizing.nofileUlimit,
      LOG_MAX_SIZE: sizing.logMaxSize,
      RS_SELF_HOST_EXTRA: rsSelfHostExtra,
      MONGO_NETWORK_SECTION: net.mongoNetworkSection,
      CLIENT_NETWORK_SECTION: net.clientNetworkSection,
      TOP_NETWORKS_SECTION: net.topNetworksSection,
      MONGO_CLIENT_HOST: net.mongoClientHost,
    },
  );
  const mongodRendered = renderTemplate('mongod.conf.tmpl', tpls.mongodTmpl, {
    DEPLOY_ID: deployId,
    NODE_NAME: node.nodeName,
    BLOCK_COMPRESSOR_REASON:
      sizing.blockCompressor === 'zstd'
        ? 'CPU >= 2 核启用高压缩比 zstd'
        : '单核低开销 snappy',
    MAX_CONNS_FORMULA: `${sizing.maxIncomingConnections} (非缓存内存安全上限)`,
    OPLOG_FORMULA: `${sizing.oplogSizeMb} MB (磁盘 ${hw.diskGb}G x ${sizing.workload})`,
    BLOCK_COMPRESSOR: sizing.blockCompressor,
    NET_BIND_LINE: buildMongodBindLine(networkMode, node.bindIp),
    MAX_INCOMING_CONNECTIONS: sizing.maxIncomingConnections,
    RS_NAME: rsName,
    OPLOG_SIZE_MB: sizing.oplogSizeMb,
    SLOW_OP_THRESHOLD_MS: sizing.slowOpThresholdMs,
  });
  const envRendered = renderTemplate('.env.tmpl', tpls.envTmpl, {
    ...sharedVars,
    MONGO_INITDB_ROOT_USERNAME: state.rootUsername,
    MONGO_INITDB_ROOT_PASSWORD: state.rootPassword,
    MONGO_APP_DATABASE: primaryApp.db,
    MONGO_APP_USER: primaryApp.user,
    MONGO_APP_PASSWORD: state.appPasswords[primaryApp.db]!,
    MONGO_EXTRA_APPS: extraAppsStr,
    MONGO_BACKUP_USER: state.backupUsername,
    MONGO_BACKUP_PASSWORD: state.backupPassword,
    RS_MEMBER_HOST: computeRsMemberHost({
      manifest,
      networkMode,
      host: node.host,
      port,
      stackPrefix,
      fingerprint: state.fingerprint,
    }),
    MONGO_KEYFILE: manifest.mode === 'replica-set' ? state.keyFile : '',
    RS_SELF_HOST: manifest.mode === 'replica-set' ? node.host : '',
    RS_MEMBERS: rsMembers,
    RS_PEER_1: peers[0] ? `${peers[0].host}:${peers[0].bindIp}` : '',
    RS_PEER_2: peers[1] ? `${peers[1].host}:${peers[1].bindIp}` : '',
    BACKUP_DIR: node.isolatedBackupDir,
  });

  writeLfFile(join(bundleDir, 'podman-compose.yml'), composeRendered);
  writeLfFile(join(bundleDir, 'mongod.conf'), mongodRendered);
  writeLfFile(join(bundleDir, 'Makefile'), tpls.makeRendered);
  writeLfFile(join(bundleDir, 'package.json'), tpls.toolsPkg);
  writeLfFile(join(bundleDir, 'bun.lock'), tpls.toolsLock);
  writeSecretFile(join(bundleDir, '.env'), envRendered, 0o600);

  if (node.os === 'macos') {
    emitMacosPlist({
      node,
      bundleDir,
      dirName,
      stackPrefix,
      manifestName: manifest.name,
      fingerprint: state.fingerprint,
      plistTmpl: tpls.plistTmpl,
      warnings: ctx.warnings,
    });
  }

  const parsedSsh = node.sshTarget ? parseSshInput(node.sshTarget) : null;
  const remoteStackDir = node.stackDir
    ? resolveServerStackDir(
        node.stackDir,
        deriveRemoteHome(node.isolatedBackupDir, node.os) ?? '~',
        dirName,
        stackPrefix,
        manifest.name,
        state.fingerprint,
      )
    : `~/srv/stacks/${dirName}`;
  ctx.nextSteps.push(
    formatUploadNextStep({
      nodeName: node.nodeName,
      rsRole,
      bundleDir,
      remoteStackDir,
      parsedSsh,
    }),
  );
  return { remoteStackDir, parsedSsh };
};

export const emitPodmanBundles = (ctx: PodmanEmitContext): void => {
  const { podmanTplDir, deployId, manifest, state } = ctx;
  const stackPrefix = manifest.stackPrefix ?? 'mongo';
  const toolsImageName = `${stackPrefix}-tools`;
  const port = manifest.port ?? 27117;
  const hostPort = manifest.hostPort ?? port;
  const rsName = manifest.rsName ?? 'rs0';
  const networkMode: NetworkMode = manifest.networkMode ?? 'bridge';

  const primaryApp = manifest.apps[0]!;
  const extraAppsStr = manifest.apps
    .slice(1)
    .map((a) => `${a.db}:${a.user}:${state.appPasswords[a.db]}`)
    .join(',');

  const baseToolsPkg = JSON.parse(
    readTemplateFile(podmanTplDir, 'tools.package.json'),
  ) as ToolsPackageManifest;
  const toolsPkg = `${JSON.stringify(
    {
      name: toolsImageName,
      version: baseToolsPkg.version,
      private: true,
      type: 'module',
      ...(baseToolsPkg.engines ? { engines: baseToolsPkg.engines } : {}),
      scripts: {
        backup: 'bun run backup.ts',
        restore: 'bun run restore.ts',
        drill: 'bun run drill.ts',
      },
      dependencies: baseToolsPkg.dependencies,
      devDependencies: baseToolsPkg.devDependencies,
    },
    null,
    2,
  )}\n`;

  const rawToolsLock = readTemplateFile(podmanTplDir, 'tools.bun.lock');
  if (!TOOLS_LOCK_NAME_RE.test(rawToolsLock)) {
    throw new TemplateRenderError(
      '模板 tools.bun.lock 缺少预期包名字段 "name": "codd", 无法替换为目标工具镜像名',
    );
  }
  const toolsLock = rawToolsLock.replace(
    TOOLS_LOCK_NAME_RE,
    `"name": "${toolsImageName}"`,
  );

  const tpls: PodmanTemplates = {
    composeTmpl: readTemplateFile(podmanTplDir, 'podman-compose.yml.tmpl'),
    mongodTmpl: readTemplateFile(podmanTplDir, 'mongod.conf.tmpl'),
    envTmpl: readTemplateFile(podmanTplDir, '.env.tmpl'),
    plistTmpl: readTemplateFile(podmanTplDir, 'mongo-backup.plist.tmpl'),
    makeRendered: renderTemplate(
      'Makefile.tmpl',
      readTemplateFile(podmanTplDir, 'Makefile.tmpl'),
      {
        DEPLOY_ID: deployId,
        STACK_PREFIX: stackPrefix,
        TOOLS_IMAGE_NAME: toolsImageName,
        MONGO_PORT: port,
        MONGO_HOST_PORT: hostPort,
      },
    ),
    toolsPkg,
    toolsLock,
  };

  const resolvedNodes: ResolvedPodmanNode[] = manifest.nodes!.map((n, idx) => {
    const nodeName =
      n.name || (manifest.mode === 'single' ? 'main' : `node${idx + 1}`);
    return {
      ...n,
      nodeName,
      host: n.host || (manifest.mode === 'single' ? '127.0.0.1' : nodeName),
      bindIp: n.bindIp ?? '127.0.0.1',
      isolatedBackupDir: ctx.backupDirs[idx]!,
    };
  });

  const rsMembers =
    manifest.mode === 'replica-set'
      ? resolvedNodes.map((n) => `${n.host}:${port}`).join(',')
      : '';

  const emittedMeta: Array<{
    remoteStackDir: string;
    parsedSsh: ReturnType<typeof parseSshInput> | null;
  }> = [];
  for (let idx = 0; idx < resolvedNodes.length; idx += 1) {
    emittedMeta.push(
      emitSinglePodmanNode({
        ctx,
        tpls,
        resolvedNodes,
        idx,
        rsMembers,
        primaryApp,
        extraAppsStr,
      }),
    );
  }

  if (manifest.mode === 'single') {
    const primaryNode = resolvedNodes[0]!;
    const primaryMeta = emittedMeta[0]!;
    appendSingleCreds({
      manifest,
      state,
      networkMode,
      stackPrefix,
      port,
      hostPort,
      rawBindIp: primaryNode.bindIp,
      credLines: ctx.credLines,
    });
    ctx.nextSteps.push(
      ...formatSinglePostUploadSteps({
        remoteStackDir: primaryMeta.remoteStackDir,
        parsedSsh: primaryMeta.parsedSsh,
        os: primaryNode.os,
        fingerprint: state.fingerprint,
      }),
    );
  } else {
    const hostsJoined = resolvedNodes.map((n) => `${n.host}:${port}`).join(',');
    ctx.credLines.push('# 3 物理节点高可用自动切主连接串:');
    for (const app of manifest.apps) {
      ctx.credLines.push(
        `mongodb://${app.user}:${state.appPasswords[app.db]}@${hostsJoined}/${app.db}?replicaSet=${rsName}&authSource=${app.db}`,
      );
    }
    ctx.nextSteps.push(
      '先在两台 secondary 节点跑 make check-env && make up, 再在 primary 节点跑 make check-env && make up',
    );
  }
};
