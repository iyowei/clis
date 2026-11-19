/**
 * Podman 部署包渲染器 (支持单节点与 3 物理节点高可用副本集)。
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { copyTemplateFile, readTemplateFile } from './assets.ts';
import type { ComputedSizing, HardwareSpec } from './formulas.ts';
import { renderTemplate } from './render.ts';
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
  NodeInput,
} from './types.ts';

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

interface ToolsPackageManifest {
  version: string;
  engines?: { bun?: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface ResolvedPodmanNode extends NodeInput {
  nodeName: string;
  host: string;
  bindIp: string;
  isolatedBackupDir: string;
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
}

interface SingleCredsInput {
  manifest: DeployManifest;
  state: GenerateState;
  networkMode: NetworkMode;
  stackPrefix: string;
  port: number;
  hostPort: number;
  rawBindIp: string;
  credLines: string[];
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

const computeRsMemberHost = (opts: {
  manifest: DeployManifest;
  networkMode: NetworkMode;
  host: string;
  port: number;
  stackPrefix: string;
  fingerprint: string;
}): string => {
  if (opts.manifest.mode !== 'single') return '';
  if (opts.networkMode === 'host') return `${opts.host}:${opts.port}`;
  if (opts.manifest.multiNetAlias)
    return `${opts.stackPrefix}-${opts.fingerprint}:${opts.port}`;
  return '';
};

const appendSingleCreds = (input: SingleCredsInput): void => {
  const {
    manifest,
    state,
    networkMode,
    stackPrefix,
    port,
    hostPort,
    rawBindIp,
    credLines,
  } = input;
  if (networkMode === 'bridge') {
    credLines.push(
      `# 同网络容器连接串 (需挂 ${stackPrefix}-${state.fingerprint}-net):`,
    );
    for (const app of manifest.apps) {
      credLines.push(
        `mongodb://${app.user}:${state.appPasswords[app.db]}@mongo:${port}/${app.db}?authSource=${app.db}`,
      );
    }
    credLines.push('');
  }
  const singleHostIp = rawBindIp === '0.0.0.0' ? '127.0.0.1' : rawBindIp;
  if (rawBindIp === '0.0.0.0') {
    credLines.push(
      '# 全网卡监听连接串 (本机填 127.0.0.1, 局域网或 WireGuard 远程免隧道直连直接把 127.0.0.1 换成服务器内网/WG IP):',
    );
  } else if (singleHostIp === '127.0.0.1') {
    credLines.push(
      '# 宿主机回环连接串 (Compass 远程连请在 Advanced -> Proxy/SSH 勾 SSH with Identity File):',
    );
  } else {
    credLines.push(`# 绑定网卡 (${singleHostIp}) 连接串:`);
  }
  for (const app of manifest.apps) {
    credLines.push(
      `mongodb://${app.user}:${state.appPasswords[app.db]}@${singleHostIp}:${hostPort}/${app.db}?authSource=${app.db}&directConnection=true`,
    );
  }
};

const emitSinglePodmanNode = (opts: {
  ctx: PodmanEmitContext;
  tpls: PodmanTemplates;
  resolvedNodes: ResolvedPodmanNode[];
  idx: number;
  rsMembers: string;
  primaryApp: AppInput;
  extraAppsStr: string;
}): void => {
  const { ctx, tpls, resolvedNodes, idx, rsMembers, primaryApp, extraAppsStr } =
    opts;
  const { podmanTplDir, outDir, deployId, manifest, hw, sizing, state } = ctx;
  const node = resolvedNodes[idx]!;

  const stackPrefix = manifest.stackPrefix ?? 'mongo';
  const toolsImageName = `${stackPrefix}-tools`;
  const imageName = manifest.imageName ?? 'mongo';
  const imageTag = manifest.imageTag ?? '9.0.8';
  const bunImage = manifest.bunImage ?? 'oven/bun:1-slim';
  const tz = manifest.tz ?? 'Asia/Shanghai';
  const port = manifest.port ?? 27117;
  const hostPort = manifest.hostPort ?? port;
  const rsName = manifest.rsName ?? 'rs0';
  const networkMode: NetworkMode = manifest.networkMode ?? 'bridge';
  const keepDaily = manifest.keepDaily ?? 7;
  const keepWeekly = manifest.keepWeekly ?? 4;

  const dirName =
    manifest.mode === 'single'
      ? `${stackPrefix}-${manifest.name}-${state.fingerprint}`
      : `${stackPrefix}-${manifest.name}-${state.fingerprint}-${node.nodeName}`;
  const bundleDir = join(outDir, dirName);
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  ctx.bundleDirs.push(bundleDir);

  for (const f of STATIC_PODMAN_FILES) {
    copyTemplateFile(podmanTplDir, f, join(bundleDir, f));
  }
  chmodSync(join(bundleDir, 'tune-linux-host.sh'), 0o755);

  const peers = resolvedNodes.filter((_, j) => j !== idx);
  const peer1 = peers[0] ? `${peers[0].host}:${peers[0].bindIp}` : '';
  const peer2 = peers[1] ? `${peers[1].host}:${peers[1].bindIp}` : '';
  const rsRole = idx === 0 ? 'primary' : 'secondary';
  const rsMemberHost = computeRsMemberHost({
    manifest,
    networkMode,
    host: node.host,
    port,
    stackPrefix,
    fingerprint: state.fingerprint,
  });

  const mongoNetworkSection =
    networkMode === 'host'
      ? '    network_mode: host'
      : [
          '    ports:',
          `      - "\${MONGO_BIND_IP:-${node.bindIp}}:\${MONGO_HOST_PORT:-${hostPort}}:\${MONGO_PORT:-${port}}"`,
          '    networks:',
          '      mongo-net:',
          '        aliases:',
          '          - mongo',
          '          - ${RS_SELF_HOST:-mongo-self}',
        ].join('\n');

  const clientNetworkSection =
    networkMode === 'host'
      ? '    network_mode: host'
      : ['    networks:', '      - mongo-net'].join('\n');

  const topNetworksSection =
    networkMode === 'host'
      ? ''
      : [
          '',
          'networks:',
          '  mongo-net:',
          `    name: ${stackPrefix}-\${FINGERPRINT}-net`,
          '    driver: bridge',
        ].join('\n');

  const mongoClientHost =
    networkMode === 'host' ? `\${MONGO_BIND_IP:-${node.bindIp}}` : 'mongo';

  const sharedFormulaVars = {
    DEPLOY_ID: deployId,
    NODE_NAME: node.nodeName,
    HARDWARE_SUMMARY: sizing.hardwareSummary,
    FORMULA_SUMMARY: sizing.formulaSummary,
    STACK_PREFIX: stackPrefix,
    FINGERPRINT: state.fingerprint,
    TZ: tz,
    MONGO_IMAGE_NAME: imageName,
    MONGO_IMAGE_TAG: imageTag,
    BUN_IMAGE: bunImage,
    TOOLS_IMAGE_NAME: toolsImageName,
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
    KEEP_DAILY: keepDaily,
    KEEP_WEEKLY: keepWeekly,
  };

  const composeRendered = renderTemplate(
    'podman-compose.yml.tmpl',
    tpls.composeTmpl,
    {
      ...sharedFormulaVars,
      STOP_GRACE_PERIOD: sizing.stopGracePeriodSec,
      NOFILE_ULIMIT: sizing.nofileUlimit,
      NPROC_ULIMIT: sizing.nprocUlimit,
      LOG_MAX_SIZE: sizing.logMaxSize,
      MONGO_NETWORK_SECTION: mongoNetworkSection,
      CLIENT_NETWORK_SECTION: clientNetworkSection,
      TOP_NETWORKS_SECTION: topNetworksSection,
      MONGO_CLIENT_HOST: mongoClientHost,
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
    MAX_INCOMING_CONNECTIONS: sizing.maxIncomingConnections,
    RS_NAME: rsName,
    OPLOG_SIZE_MB: sizing.oplogSizeMb,
    SLOW_OP_THRESHOLD_MS: sizing.slowOpThresholdMs,
  });

  const envRendered = renderTemplate('.env.tmpl', tpls.envTmpl, {
    ...sharedFormulaVars,
    MONGO_INITDB_ROOT_USERNAME: state.rootUsername,
    MONGO_INITDB_ROOT_PASSWORD: state.rootPassword,
    MONGO_APP_DATABASE: primaryApp.db,
    MONGO_APP_USER: primaryApp.user,
    MONGO_APP_PASSWORD: state.appPasswords[primaryApp.db]!,
    MONGO_EXTRA_APPS: extraAppsStr,
    MONGO_BACKUP_USER: state.backupUsername,
    MONGO_BACKUP_PASSWORD: state.backupPassword,
    RS_MEMBER_HOST: rsMemberHost,
    MONGO_KEYFILE: manifest.mode === 'replica-set' ? state.keyFile : '',
    RS_SELF_HOST: manifest.mode === 'replica-set' ? node.host : '',
    RS_MEMBERS: rsMembers,
    RS_PEER_1: peer1,
    RS_PEER_2: peer2,
    BACKUP_DIR: node.isolatedBackupDir,
  });

  writeFileSync(join(bundleDir, 'podman-compose.yml'), composeRendered, 'utf8');
  writeFileSync(join(bundleDir, 'mongod.conf'), mongodRendered, 'utf8');
  writeFileSync(join(bundleDir, 'Makefile'), tpls.makeRendered, 'utf8');
  writeFileSync(join(bundleDir, 'package.json'), tpls.toolsPkg, 'utf8');
  writeFileSync(join(bundleDir, 'bun.lock'), tpls.toolsLock, 'utf8');
  writeSecretFile(join(bundleDir, '.env'), envRendered, 0o600);

  if (node.os === 'macos') {
    const home =
      deriveRemoteHome(node.isolatedBackupDir, 'macos') ?? '/Users/<用户名>';
    const stackDir = resolveServerStackDir(
      node.stackDir,
      home,
      dirName,
      stackPrefix,
      manifest.name,
      state.fingerprint,
    );
    const logPath = posix.join(
      home,
      'srv/logs',
      `mongo-backup-${state.fingerprint}.log`,
    );
    const podmanBin = node.podmanBin ?? '/opt/homebrew/bin/podman';
    const plistRendered = renderTemplate(
      'mongo-backup.plist.tmpl',
      tpls.plistTmpl,
      {
        FINGERPRINT: state.fingerprint,
        PODMAN_DIR: posix.dirname(podmanBin),
        STACK_DIR: stackDir,
        LOG_PATH: logPath,
      },
    );
    writeFileSync(
      join(bundleDir, `com.codd.mongo-backup-${state.fingerprint}.plist`),
      plistRendered,
      'utf8',
    );
  }

  const parsedSsh = node.sshTarget ? parseSshInput(node.sshTarget) : null;
  const targetDesc = parsedSsh
    ? `${parsedSsh.target}:~/srv/stacks/${dirName}/`
    : `~/srv/stacks/${dirName}/`;
  const rshFlag = parsedSsh ? parsedSsh.rsyncRshFlag : '';
  ctx.nextSteps.push(
    `[${node.nodeName}/${rsRole}] rsync -av ${rshFlag}${bundleDir}/ ${targetDesc}`,
  );
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
    toolsLock: readTemplateFile(podmanTplDir, 'tools.bun.lock').replace(
      /"name":\s*"codd"/,
      `"name": "${toolsImageName}"`,
    ),
  };

  const resolvedNodes: ResolvedPodmanNode[] = manifest.nodes!.map((n, idx) => {
    const fallbackName = manifest.mode === 'single' ? 'main' : `node${idx + 1}`;
    const nodeName = n.name || fallbackName;
    const fallbackHost = manifest.mode === 'single' ? '127.0.0.1' : nodeName;
    const host = n.host || fallbackHost;
    const bindIp = n.bindIp ?? '127.0.0.1';
    return {
      ...n,
      nodeName,
      host,
      bindIp,
      isolatedBackupDir: ctx.backupDirs[idx]!,
    };
  });

  const rsMembers =
    manifest.mode === 'replica-set'
      ? resolvedNodes.map((n) => `${n.host}:${port}`).join(',')
      : '';

  for (let idx = 0; idx < resolvedNodes.length; idx += 1) {
    emitSinglePodmanNode({
      ctx,
      tpls,
      resolvedNodes,
      idx,
      rsMembers,
      primaryApp,
      extraAppsStr,
    });
  }

  if (manifest.mode === 'single') {
    appendSingleCreds({
      manifest,
      state,
      networkMode,
      stackPrefix,
      port,
      hostPort,
      rawBindIp: resolvedNodes[0]!.bindIp,
      credLines: ctx.credLines,
    });
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
