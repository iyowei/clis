/**
 * Podman 渲染器的纯模板辅助函数: 网络拓扑片段、macOS LaunchAgent XML 转义与连接串汇总。
 */
import { writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { renderTemplate } from './render.ts';
import { deriveRemoteHome, resolveServerStackDir } from './ssh.ts';
import type {
  DeployManifest,
  GenerateState,
  NetworkMode,
  NodeInput,
} from './types.ts';

export interface ResolvedPodmanNode extends NodeInput {
  nodeName: string;
  host: string;
  bindIp: string;
  isolatedBackupDir: string;
}

export interface SingleCredsInput {
  manifest: DeployManifest;
  state: GenerateState;
  networkMode: NetworkMode;
  stackPrefix: string;
  port: number;
  hostPort: number;
  rawBindIp: string;
  credLines: string[];
}

export interface NetworkFragments {
  mongoNetworkSection: string;
  clientNetworkSection: string;
  topNetworksSection: string;
  mongoClientHost: string;
}

export const escapeXml = (str: string): string =>
  str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export const computeRsMemberHost = (opts: {
  manifest: DeployManifest;
  networkMode: NetworkMode;
  host: string;
  port: number;
  stackPrefix: string;
  fingerprint: string;
}): string => {
  if (opts.manifest.mode !== 'single') return '';
  if (opts.networkMode === 'host') return `${opts.host}:${opts.port}`;
  if (opts.manifest.multiNetAlias) {
    return `${opts.stackPrefix}-${opts.fingerprint}:${opts.port}`;
  }
  return '';
};

export const buildNetworkFragments = (opts: {
  manifest: DeployManifest;
  networkMode: NetworkMode;
  node: ResolvedPodmanNode;
  stackPrefix: string;
  fingerprint: string;
  port: number;
  hostPort: number;
}): NetworkFragments => {
  const {
    manifest,
    networkMode,
    node,
    stackPrefix,
    fingerprint,
    port,
    hostPort,
  } = opts;
  const useMultiNetAlias =
    manifest.mode === 'single' &&
    networkMode === 'bridge' &&
    Boolean(manifest.multiNetAlias);
  const aliasLines = useMultiNetAlias
    ? [`          - ${stackPrefix}-${fingerprint}`]
    : ['          - mongo', '          - ${RS_SELF_HOST:-mongo-self}'];

  if (networkMode === 'host') {
    return {
      mongoNetworkSection: '    network_mode: host',
      clientNetworkSection: '    network_mode: host',
      topNetworksSection: '',
      mongoClientHost:
        node.bindIp === '0.0.0.0'
          ? '127.0.0.1'
          : `\${MONGO_BIND_IP:-${node.bindIp}}`,
    };
  }
  return {
    mongoNetworkSection: [
      '    ports:',
      `      - "\${MONGO_BIND_IP:-${node.bindIp}}:\${MONGO_HOST_PORT:-${hostPort}}:\${MONGO_PORT:-${port}}"`,
      '    networks:',
      '      mongo-net:',
      '        aliases:',
      ...aliasLines,
    ].join('\n'),
    clientNetworkSection: ['    networks:', '      - mongo-net'].join('\n'),
    topNetworksSection: [
      '',
      'networks:',
      '  mongo-net:',
      `    name: ${stackPrefix}-\${FINGERPRINT}-net`,
      '    driver: bridge',
    ].join('\n'),
    mongoClientHost: useMultiNetAlias
      ? `${stackPrefix}-${fingerprint}`
      : 'mongo',
  };
};

export const emitMacosPlist = (opts: {
  node: ResolvedPodmanNode;
  bundleDir: string;
  dirName: string;
  stackPrefix: string;
  manifestName: string;
  fingerprint: string;
  plistTmpl: string;
}): void => {
  const {
    node,
    bundleDir,
    dirName,
    stackPrefix,
    manifestName,
    fingerprint,
    plistTmpl,
  } = opts;
  const home =
    deriveRemoteHome(node.isolatedBackupDir, 'macos') ?? '/Users/<用户名>';
  const stackDir = resolveServerStackDir(
    node.stackDir,
    home,
    dirName,
    stackPrefix,
    manifestName,
    fingerprint,
  );
  const logPath = posix.join(
    home,
    'srv/logs',
    `mongo-backup-${fingerprint}.log`,
  );
  const podmanBin = node.podmanBin ?? '/opt/homebrew/bin/podman';
  const plistRendered = renderTemplate('mongo-backup.plist.tmpl', plistTmpl, {
    FINGERPRINT: escapeXml(fingerprint),
    PODMAN_DIR: escapeXml(posix.dirname(podmanBin)),
    STACK_DIR: escapeXml(stackDir),
    LOG_PATH: escapeXml(logPath),
  });
  writeFileSync(
    join(bundleDir, `com.codd.mongo-backup-${fingerprint}.plist`),
    plistRendered,
    'utf8',
  );
};

export const appendSingleCreds = (input: SingleCredsInput): void => {
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
    const bridgeHost = manifest.multiNetAlias
      ? `${stackPrefix}-${state.fingerprint}`
      : 'mongo';
    credLines.push(
      `# 同网络容器连接串 (需挂 ${stackPrefix}-${state.fingerprint}-net):`,
    );
    for (const app of manifest.apps) {
      credLines.push(
        `mongodb://${app.user}:${state.appPasswords[app.db]}@${bridgeHost}:${port}/${app.db}?authSource=${app.db}&compressors=zstd`,
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
      `mongodb://${app.user}:${state.appPasswords[app.db]}@${singleHostIp}:${hostPort}/${app.db}?authSource=${app.db}&directConnection=true&compressors=zstd`,
    );
  }
};
