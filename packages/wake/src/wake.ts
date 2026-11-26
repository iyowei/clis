/**
 * `@iyowei/wake` 唤醒主流程编排器: 合并配置与显式参数、在线预检、SSH 中继故障转移、本机子网感知降级及就绪轮询。
 */
import {
  DEFAULT_RELAY_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  resolveTargetFromConfig,
  resolveWakeConfigPath,
  tryLoadWakeConfig,
} from './config.ts';
import { WakeError } from './errors.ts';
import {
  normalizeMacList,
  validateBroadcastIpv4,
  validatePort,
  validateSafeHost,
  validateSafeRelay,
  validateTargetName,
} from './magic.ts';
import {
  listLocalLanInterfaces,
  probeTcpPort,
  resolveBroadcastTargets,
  sendUdpMagicBurst,
} from './network.ts';
import { buildRemoteWakeArgs, runSshRelayWake } from './relay.ts';
import type {
  RelayAttempt,
  WakeDeps,
  WakeReport,
  WakeTargetConfig,
  WakeTargetOptions,
  WakeWarning,
} from './types.ts';

interface ResolvedWakePlan {
  targetLabel: string;
  configTargetName?: string;
  macs: string[];
  hasExplicitMacs: boolean;
  host?: string;
  port: number;
  broadcast: string[];
  relays: string[];
  wait: boolean;
  waitTimeoutMs: number;
  relayTimeoutMs: number;
  pollIntervalMs: number;
  reburstIntervalMs: number;
  localOnly: boolean;
  noLocalFallback: boolean;
  force: boolean;
  repeatPerDestination: number;
  rounds: number;
}

function mergeUniqueStrings(
  base: readonly string[],
  override: readonly string[],
  normalize: (value: string) => string,
): string[] {
  if (override.length > 0) return override.map(normalize);
  return base.map(normalize);
}

function lookupConfiguredTarget(
  options: WakeTargetOptions,
  hasExplicitMacs: boolean,
  allowRemoteLookup: boolean,
): { name?: string; entry?: WakeTargetConfig } {
  if (hasExplicitMacs && options.target === undefined) {
    return {};
  }
  const configPath = resolveWakeConfigPath(options);
  const maybeConfig = tryLoadWakeConfig(configPath);
  if (!maybeConfig.exists) {
    if (!hasExplicitMacs && !allowRemoteLookup) {
      throw new WakeError(
        'CONFIG_ABSENT',
        `未找到 wake 配置文件: ${configPath} (运行 wake init 创建, 或通过 --mac 直接指定 MAC 地址)`,
      );
    }
    return {};
  }

  if (options.target !== undefined) {
    try {
      const hit = resolveTargetFromConfig(
        maybeConfig.loaded.config,
        options.target,
      );
      return { name: hit.name, entry: hit.target };
    } catch (error) {
      if (allowRemoteLookup || hasExplicitMacs) return {};
      throw error;
    }
  }

  if (hasExplicitMacs) return {};
  const hit = resolveTargetFromConfig(maybeConfig.loaded.config);
  return { name: hit.name, entry: hit.target };
}

function resolveWakePlan(options: WakeTargetOptions): ResolvedWakePlan {
  const hasExplicitMacs = options.macs !== undefined && options.macs.length > 0;
  const relaysOverride = options.relays ?? [];
  const allowRemoteLookup =
    !options.localOnly &&
    options.target !== undefined &&
    relaysOverride.length > 0 &&
    !hasExplicitMacs;

  const { name: configName, entry: configEntry } = lookupConfiguredTarget(
    options,
    hasExplicitMacs,
    allowRemoteLookup,
  );

  let macs: string[] = [];
  if (hasExplicitMacs) {
    macs = normalizeMacList(options.macs!);
  } else if (configEntry !== undefined) {
    macs = normalizeMacList(configEntry.macs);
  }

  if (macs.length === 0 && !allowRemoteLookup) {
    throw new WakeError('INVALID_MAC', '缺少有效的目标 MAC 地址');
  }

  const targetLabel =
    configName ??
    (options.target !== undefined
      ? validateTargetName(options.target)
      : (macs[0] ?? 'ad-hoc'));

  const host =
    options.host !== undefined
      ? validateSafeHost(options.host)
      : configEntry?.host;
  const port = validatePort(options.port ?? configEntry?.port, 22);
  const broadcast = mergeUniqueStrings(
    configEntry?.broadcast ?? [],
    options.broadcast ?? [],
    validateBroadcastIpv4,
  );
  const relays = options.localOnly
    ? []
    : mergeUniqueStrings(
        configEntry?.relays ?? [],
        relaysOverride,
        validateSafeRelay,
      );

  let configTargetName: string | undefined = configName;
  if (configTargetName === undefined && options.target !== undefined) {
    configTargetName = validateTargetName(options.target);
  }

  return {
    targetLabel,
    ...(configTargetName !== undefined ? { configTargetName } : {}),
    macs,
    hasExplicitMacs: macs.length > 0,
    ...(host !== undefined ? { host } : {}),
    port,
    broadcast,
    relays,
    wait: options.wait ?? host !== undefined,
    waitTimeoutMs:
      options.waitTimeoutMs ??
      configEntry?.waitTimeoutMs ??
      DEFAULT_WAIT_TIMEOUT_MS,
    relayTimeoutMs:
      options.relayTimeoutMs ??
      configEntry?.relayTimeoutMs ??
      DEFAULT_RELAY_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    reburstIntervalMs: options.reburstIntervalMs ?? 15_000,
    localOnly: options.localOnly === true,
    noLocalFallback: options.noLocalFallback === true,
    force: options.force === true,
    repeatPerDestination: options.repeatPerDestination ?? 2,
    rounds: options.rounds ?? 2,
  };
}

interface DispatchOutcome {
  method: 'relay' | 'local';
  activeRelay?: string;
  packetsSent: number;
  destinations: string[];
  relayAttempts: RelayAttempt[];
  warnings: WakeWarning[];
}

async function dispatchOnce(
  plan: ResolvedWakePlan,
  deps: WakeDeps,
  onProgress: WakeTargetOptions['onProgress'],
  options: { roundsOverride?: number } = {},
): Promise<DispatchOutcome> {
  const relayAttempts: RelayAttempt[] = [];
  const warnings: WakeWarning[] = [];

  const remoteDispatch = deps.relay?.dispatchViaRelay ?? runSshRelayWake;
  const remoteArgs = buildRemoteWakeArgs({
    targetName: plan.configTargetName,
    ...(plan.hasExplicitMacs ? { macs: plan.macs } : {}),
    ...(plan.host !== undefined ? { host: plan.host } : {}),
    port: plan.port,
    broadcast: plan.broadcast,
  });

  for (let i = 0; i < plan.relays.length; i += 1) {
    const relay = plan.relays[i]!;
    onProgress?.({
      phase: 'relay',
      relay,
      index: i + 1,
      total: plan.relays.length,
    });
    const res = await remoteDispatch({
      relay,
      remoteArgs,
      timeoutMs: plan.relayTimeoutMs,
    });
    relayAttempts.push({
      relay,
      ok: res.ok,
      ...(res.packetsSent !== undefined
        ? { packetsSent: res.packetsSent }
        : {}),
      ...(res.destinations !== undefined
        ? { destinations: res.destinations }
        : {}),
      ...(res.reason !== undefined ? { reason: res.reason } : {}),
    });
    if (res.ok) {
      return {
        method: 'relay',
        activeRelay: relay,
        packetsSent: res.packetsSent ?? 1,
        destinations: res.destinations ?? [],
        relayAttempts,
        warnings,
      };
    }
  }

  if (plan.relays.length > 0 && plan.noLocalFallback) {
    const reasons = relayAttempts
      .map((a) => `${a.relay}: ${a.reason ?? '失败'}`)
      .join('; ');
    throw new WakeError(
      'RELAY_FAILED',
      `全部 SSH 中继均失败且已禁用本机回退 (${reasons})`,
    );
  }

  if (!plan.hasExplicitMacs) {
    throw new WakeError(
      'RELAY_FAILED',
      'SSH 中继未成功且本地无对应 MAC 地址可供直接广播',
    );
  }

  if (plan.relays.length > 0) {
    warnings.push({
      code: 'RELAY_FALLBACK',
      message: '全部配置中继均不可达, 已自动降级为本机局域网 UDP 广播',
    });
  }

  const listIfaces = deps.network?.listInterfaces ?? listLocalLanInterfaces;
  const interfaces = listIfaces();
  const { destinations, sourceAddresses, matchedSubnet } =
    resolveBroadcastTargets({
      ...(plan.host !== undefined ? { host: plan.host } : {}),
      explicitBroadcasts: plan.broadcast,
      interfaces,
    });

  if (
    plan.host !== undefined &&
    !matchedSubnet &&
    plan.broadcast.length === 0
  ) {
    warnings.push({
      code: 'LOCAL_SUBNET_MISMATCH',
      message: `本机未检测到与 ${plan.host} 同网段的物理局域网接口, 已尝试广播地址 ${destinations.join(', ')}`,
    });
  }

  onProgress?.({
    phase: 'local-burst',
    round: 1,
    destinations,
  });

  const sendBurst = deps.network?.sendUdpBurst ?? sendUdpMagicBurst;
  const burst = await sendBurst({
    macs: plan.macs,
    destinations,
    sourceAddresses,
    repeatPerDestination: plan.repeatPerDestination,
    rounds: options.roundsOverride ?? plan.rounds,
    roundIntervalMs: 350,
  });

  return {
    method: 'local',
    packetsSent: burst.packetsSent,
    destinations: burst.destinations,
    relayAttempts,
    warnings,
  };
}

/** 唤醒指定目标主机 (配置驱动或纯 CLI 参数驱动) */
export async function wakeTarget(
  options: WakeTargetOptions,
  deps: WakeDeps = {},
): Promise<WakeReport> {
  const now = deps.clock?.now ?? (() => Date.now());
  const sleep =
    deps.clock?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probeTcp = deps.network?.probeTcp ?? probeTcpPort;
  const startMs = now();

  const plan = resolveWakePlan(options);

  if (plan.host !== undefined && !plan.force) {
    options.onProgress?.({
      phase: 'precheck',
      host: plan.host,
      port: plan.port,
    });
    const probe = await probeTcp(plan.host, plan.port, 1_200);
    if (probe.reachable) {
      return {
        target: plan.targetLabel,
        status: 'already-online',
        method: 'none',
        macs: plan.macs,
        host: plan.host,
        port: plan.port,
        packetsSent: 0,
        destinations: [],
        relayAttempts: [],
        warnings: [],
        elapsedMs: Math.max(0, now() - startMs),
        dispatched: false,
      };
    }
  }

  const initial = await dispatchOnce(plan, deps, options.onProgress);
  const allWarnings = [...initial.warnings];
  const allAttempts = [...initial.relayAttempts];
  let totalPackets = initial.packetsSent;
  let lastMethod = initial.method;
  let activeRelay = initial.activeRelay;
  const destinations = [...initial.destinations];

  if (!plan.wait || plan.host === undefined) {
    return {
      target: plan.targetLabel,
      status: 'dispatched',
      method: lastMethod,
      ...(activeRelay !== undefined ? { activeRelay } : {}),
      macs: plan.macs,
      ...(plan.host !== undefined ? { host: plan.host } : {}),
      port: plan.port,
      packetsSent: totalPackets,
      destinations,
      relayAttempts: allAttempts,
      warnings: allWarnings,
      elapsedMs: Math.max(0, now() - startMs),
      dispatched: true,
    };
  }

  let nextReburstAt = startMs + plan.reburstIntervalMs;
  let attempt = 0;

  while (now() - startMs < plan.waitTimeoutMs) {
    attempt += 1;
    const probe = await probeTcp(plan.host, plan.port, 1_000);
    const elapsedMs = Math.max(0, now() - startMs);
    if (probe.reachable) {
      return {
        target: plan.targetLabel,
        status: 'woken',
        method: lastMethod,
        ...(activeRelay !== undefined ? { activeRelay } : {}),
        macs: plan.macs,
        host: plan.host,
        port: plan.port,
        packetsSent: totalPackets,
        destinations,
        relayAttempts: allAttempts,
        warnings: allWarnings,
        elapsedMs,
        dispatched: true,
      };
    }

    options.onProgress?.({
      phase: 'waiting',
      host: plan.host,
      port: plan.port,
      elapsedMs,
      timeoutMs: plan.waitTimeoutMs,
      attempt,
    });

    if (now() >= nextReburstAt && plan.reburstIntervalMs > 0) {
      try {
        const reburst = await dispatchOnce(
          {
            ...plan,
            relays: activeRelay !== undefined ? [activeRelay] : plan.relays,
          },
          deps,
          undefined,
          { roundsOverride: 1 },
        );
        totalPackets += reburst.packetsSent;
        lastMethod = reburst.method;
        if (reburst.activeRelay !== undefined)
          activeRelay = reburst.activeRelay;
      } catch {
        // 周期补发失败不中断等待轮询
      }
      nextReburstAt = now() + plan.reburstIntervalMs;
    }

    const remainingMs = plan.waitTimeoutMs - (now() - startMs);
    if (remainingMs <= 0) break;
    await sleep(Math.min(plan.pollIntervalMs, remainingMs));
  }

  return {
    target: plan.targetLabel,
    status: 'timeout',
    method: lastMethod,
    ...(activeRelay !== undefined ? { activeRelay } : {}),
    macs: plan.macs,
    host: plan.host,
    port: plan.port,
    packetsSent: totalPackets,
    destinations,
    relayAttempts: allAttempts,
    warnings: allWarnings,
    elapsedMs: Math.max(0, now() - startMs),
    dispatched: true,
  };
}
