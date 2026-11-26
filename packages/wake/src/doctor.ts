/**
 * `@iyowei/wake` 只读环境与中继诊断 (`wake doctor`): 绝不发送任何 WoL 魔术包, 保持严格只读幂等。
 */
import {
  DEFAULT_RELAY_TIMEOUT_MS,
  resolveTargetFromConfig,
  resolveWakeConfigPath,
  tryLoadWakeConfig,
} from './config.ts';
import { validatePort, validateSafeRelay } from './magic.ts';
import { listLocalLanInterfaces, probeTcpPort } from './network.ts';
import { probeSshRelay } from './relay.ts';
import type {
  WakeConfig,
  WakeDeps,
  WakeDoctorRelayResult,
  WakeDoctorReport,
  WakePathContext,
} from './types.ts';

export interface DiagnoseWakeOptions extends WakePathContext {
  target?: string;
  relayTimeoutMs?: number;
}

interface ResolvedDoctorConfig {
  configExists: boolean;
  configError?: string;
  targetName?: string;
  targetFound?: boolean;
  host?: string;
  port?: number;
  relaysToTest: string[];
  relayTimeoutMs: number;
}

function collectAllConfiguredRelays(targets: WakeConfig['targets']): string[] {
  const allRelays = new Set<string>();
  for (const entry of Object.values(targets)) {
    for (const relay of entry.relays ?? []) {
      allRelays.add(relay);
    }
  }
  return [...allRelays];
}

function resolveDoctorConfig(
  configPath: string,
  options: DiagnoseWakeOptions,
): ResolvedDoctorConfig {
  const relayTimeoutMs = options.relayTimeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
  let loaded;
  try {
    loaded = tryLoadWakeConfig(configPath);
  } catch (error) {
    return {
      configExists: true,
      configError: (error as Error).message,
      targetName: options.target,
      relaysToTest: [],
      relayTimeoutMs,
    };
  }

  if (!loaded.exists) {
    return {
      configExists: false,
      targetName: options.target,
      relaysToTest: [],
      relayTimeoutMs,
    };
  }

  const cfg = loaded.loaded.config;
  const shouldLookupTarget =
    options.target !== undefined ||
    cfg.defaultTarget !== undefined ||
    Object.keys(cfg.targets).length === 1;
  if (!shouldLookupTarget) {
    return {
      configExists: true,
      targetName: options.target,
      relaysToTest: collectAllConfiguredRelays(cfg.targets),
      relayTimeoutMs,
    };
  }

  try {
    const hit = resolveTargetFromConfig(cfg, options.target);
    return {
      configExists: true,
      targetName: hit.name,
      targetFound: true,
      host: hit.target.host,
      port: validatePort(hit.target.port, 22),
      relaysToTest: [...(hit.target.relays ?? [])],
      relayTimeoutMs: hit.target.relayTimeoutMs ?? relayTimeoutMs,
    };
  } catch (error) {
    return {
      configExists: true,
      targetName: options.target,
      targetFound: false,
      configError: (error as Error).message,
      relaysToTest: collectAllConfiguredRelays(cfg.targets),
      relayTimeoutMs,
    };
  }
}

/** 诊断配置文件、本机网卡、SSH 中继可用性与目标在线状态 (严格只读) */
export async function diagnoseWake(
  options: DiagnoseWakeOptions = {},
  deps: WakeDeps = {},
): Promise<WakeDoctorReport> {
  const configPath = resolveWakeConfigPath(options);
  const listIfaces = deps.network?.listInterfaces ?? listLocalLanInterfaces;
  const interfaces = listIfaces();
  const resolved = resolveDoctorConfig(configPath, options);

  let targetReachable: boolean | undefined;
  let targetLatencyMs: number | undefined;
  if (resolved.host !== undefined) {
    const probeTcp = deps.network?.probeTcp ?? probeTcpPort;
    const probe = await probeTcp(resolved.host, resolved.port ?? 22, 1_500);
    targetReachable = probe.reachable;
    targetLatencyMs = probe.latencyMs;
  }

  const probeRelay = deps.relay?.probeRelay ?? probeSshRelay;
  const relays: WakeDoctorRelayResult[] = [];
  for (const rawRelay of resolved.relaysToTest) {
    const relay = validateSafeRelay(rawRelay);
    relays.push(
      await probeRelay({ relay, timeoutMs: resolved.relayTimeoutMs }),
    );
  }

  return {
    configPath,
    configExists: resolved.configExists,
    ...(resolved.configError !== undefined
      ? { configError: resolved.configError }
      : {}),
    ...(resolved.targetName !== undefined
      ? { targetName: resolved.targetName }
      : {}),
    ...(resolved.targetFound !== undefined
      ? { targetFound: resolved.targetFound }
      : {}),
    ...(resolved.host !== undefined ? { host: resolved.host } : {}),
    ...(resolved.port !== undefined ? { port: resolved.port } : {}),
    ...(targetReachable !== undefined ? { targetReachable } : {}),
    ...(targetLatencyMs !== undefined ? { targetLatencyMs } : {}),
    interfaces,
    relays,
  };
}
