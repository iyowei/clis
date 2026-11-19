/**
 * Podman 渲染器的纯模板辅助函数: 网络拓扑片段、mongod 绑定策略、macOS LaunchAgent 与连接串汇总。
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
  ParsedSshTarget,
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

export const toLf = (content: string): string =>
  content.replaceAll('\r\n', '\n');

export const writeLfFile = (filePath: string, content: string): void => {
  writeFileSync(filePath, toLf(content), 'utf8');
};

export const escapeXml = (str: string): string =>
  str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/**
 * 推导 mongod.conf net 段绑定配置:
 * - bridge 模式由宿主机 ports 映射控制暴露网卡, 容器内维持 bindIpAll: true;
 * - host 模式严禁默认 bindIpAll: true 架空 bindIp:
 *   - 127.0.0.1 -> 仅绑定本机回环;
 *   - 自定义私网/WireGuard IP -> 绑定 127.0.0.1,<bindIp> (保本机探活/make shell 可达且不暴露公网);
 *   - 显式 0.0.0.0 -> 尊重自定义渲染 bindIpAll: true。
 */
export const buildMongodBindLine = (
  networkMode: NetworkMode,
  bindIp: string,
): string => {
  if (networkMode === 'bridge' || bindIp === '0.0.0.0') {
    return 'bindIpAll: true';
  }
  if (bindIp === '127.0.0.1') {
    return 'bindIp: "127.0.0.1"';
  }
  return `bindIp: "127.0.0.1,${bindIp}"`;
};

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

export const formatUploadNextStep = (opts: {
  nodeName: string;
  rsRole: string;
  bundleDir: string;
  remoteStackDir: string;
  parsedSsh: ParsedSshTarget | null;
  platform?: NodeJS.Platform;
}): string => {
  const {
    nodeName,
    rsRole,
    bundleDir,
    remoteStackDir,
    parsedSsh,
    platform = process.platform,
  } = opts;
  if (platform === 'win32') {
    const scpFlags: string[] = [];
    if (parsedSsh?.port && parsedSsh.port !== 22) {
      scpFlags.push(`-P ${parsedSsh.port}`);
    }
    if (parsedSsh?.identityFile) {
      scpFlags.push(`-i "${parsedSsh.identityFile}"`);
    }
    const optStr = scpFlags.length > 0 ? `${scpFlags.join(' ')} ` : '';
    const dst = parsedSsh
      ? `${parsedSsh.target}:${remoteStackDir}`
      : `<user@host>:${remoteStackDir}`;
    return `[${nodeName}/${rsRole}] scp -r ${optStr}"${bundleDir}" "${dst}" (Windows 提示: 如在 Git Bash/WSL 中执行可改用 rsync)`;
  }

  const targetDesc = parsedSsh
    ? `${parsedSsh.target}:${remoteStackDir}/`
    : `${remoteStackDir}/`;
  const rshFlag = parsedSsh ? parsedSsh.rsyncRshFlag : '';
  return `[${nodeName}/${rsRole}] rsync -av ${rshFlag}"${bundleDir}/" "${targetDesc}"`;
};

export const emitMacosPlist = (opts: {
  node: ResolvedPodmanNode;
  bundleDir: string;
  dirName: string;
  stackPrefix: string;
  manifestName: string;
  fingerprint: string;
  plistTmpl: string;
  warnings: string[];
}): void => {
  const {
    node,
    bundleDir,
    dirName,
    stackPrefix,
    manifestName,
    fingerprint,
    plistTmpl,
    warnings,
  } = opts;
  const derivedHome = deriveRemoteHome(node.isolatedBackupDir, 'macos');
  const home = derivedHome ?? '/Users/<用户名>';
  if (!derivedHome) {
    warnings.push(
      `macOS 节点 ${node.nodeName} 无法从 backupDir (${node.isolatedBackupDir}) 推导用户名, .plist 中已写入占位符 /Users/<用户名>, 部署前请手动替换`,
    );
  }
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
  const rawPodmanDir = podmanBin.includes('/') ? posix.dirname(podmanBin) : '';
  const podmanPathPrefix =
    rawPodmanDir && rawPodmanDir !== '.' && rawPodmanDir !== '/'
      ? `${escapeXml(rawPodmanDir)}:`
      : '';
  const plistRendered = renderTemplate('mongo-backup.plist.tmpl', plistTmpl, {
    FINGERPRINT: escapeXml(fingerprint),
    PODMAN_PATH_PREFIX: podmanPathPrefix,
    STACK_DIR: escapeXml(stackDir),
    LOG_PATH: escapeXml(logPath),
  });
  writeLfFile(
    join(bundleDir, `com.codd.mongo-backup-${fingerprint}.plist`),
    plistRendered,
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
