/**
 * `@iyowei/fan` 核心编排器 (`createFanController`):
 * 负责风扇索引校验、RPM/百分比解析与跨风扇夹逼、持久化状态自动记住/恢复、Macs Fan Control 冲突提示与底层传输委托。
 */
import { ensurePersistDaemon } from './daemon.ts';
import { FanError, isFanError } from './errors.ts';
import { createAppleSmcTransport } from './smc-apple.ts';
import { parseSpeedSpec, resolveTargetRpm } from './speed.ts';
import { createMacOsFanStateStore, mergePersistedState } from './state.ts';
import type {
  FanController,
  FanControllerOptions,
  FanInfo,
  FanPersistedState,
  FanStateStore,
  FanStatusReport,
  FanTransport,
  FanWarning,
  FanWriteRequest,
  ManualControlStrategy,
  MinFanOptions,
  PersistDaemonAction,
  PersistedFanEntry,
  SetSpeedOptions,
  SpeedSpec,
  TargetFanOptions,
} from './types.ts';

function selectTargets(
  fans: readonly FanInfo[],
  fanIndex: number | undefined,
): FanInfo[] {
  if (fans.length === 0) {
    throw new FanError('SMC_UNAVAILABLE', '未检测到受控风扇');
  }
  if (fanIndex === undefined) {
    return [...fans];
  }
  if (!Number.isInteger(fanIndex) || fanIndex < 0 || fanIndex >= fans.length) {
    throw new FanError(
      'INVALID_FAN_INDEX',
      `无效的风扇编号 ${String(fanIndex)} (可用范围: 0..${String(fans.length - 1)})`,
    );
  }
  const target = fans.find((fan) => fan.index === fanIndex);
  if (target === undefined) {
    throw new FanError(
      'INVALID_FAN_INDEX',
      `未找到编号为 ${String(fanIndex)} 的风扇`,
    );
  }
  return [target];
}

function filterFans(
  fans: readonly FanInfo[],
  fanIndex: number | undefined,
): FanInfo[] {
  if (fanIndex === undefined) return [...fans];
  const found = fans.filter((fan) => fan.index === fanIndex);
  if (found.length === 0) {
    throw new FanError(
      'INVALID_FAN_INDEX',
      `无效的风扇编号 ${String(fanIndex)} (可用范围: 0..${String(fans.length - 1)})`,
    );
  }
  return found;
}

function inspectPersisted(store: FanStateStore | undefined): {
  persisted: FanPersistedState | null;
  warning?: FanWarning;
} {
  if (store === undefined) return { persisted: null };
  try {
    return { persisted: store.read() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      persisted: null,
      warning: { code: 'STATE_CORRUPT', message },
    };
  }
}

function buildReport(
  fans: FanInfo[],
  transport: FanTransport,
  options: {
    extraWarnings?: FanWarning[];
    persisted?: FanPersistedState | null;
    didPersist?: boolean;
    daemonAction?: PersistDaemonAction;
  } = {},
): FanStatusReport {
  const macsFanControlRunning = transport.isMacsFanControlRunning();
  const warnings: FanWarning[] = [...(options.extraWarnings ?? [])];
  if (macsFanControlRunning) {
    warnings.push({
      code: 'MACS_FAN_CONTROL_RUNNING',
      message:
        '检测到 Macs Fan Control 正在后台运行, 它可能会在数秒内覆写手动设置的 SMC 转速',
    });
  }
  const report: FanStatusReport = {
    fans,
    macsFanControlRunning,
    warnings,
  };
  if (options.persisted !== undefined) {
    report.persisted = options.persisted;
  }
  if (options.didPersist !== undefined) {
    report.didPersist = options.didPersist;
  }
  if (options.daemonAction !== undefined) {
    report.daemonAction = options.daemonAction;
  }
  return report;
}

function buildRollbackRequests(targets: readonly FanInfo[]): FanWriteRequest[] {
  return targets.map((fan) =>
    fan.mode === 'auto'
      ? { kind: 'auto', fanIndex: fan.index }
      : { kind: 'manual', fanIndex: fan.index, targetRpm: fan.targetRpm },
  );
}

function persistWithRollback(
  store: FanStateStore,
  existing: FanPersistedState | null,
  updates: Readonly<Record<string, PersistedFanEntry>>,
  transport: FanTransport,
  targets: readonly FanInfo[],
): { persisted: FanPersistedState; didPersist: boolean } {
  try {
    const next = mergePersistedState(existing, updates);
    store.write(next);
    return { persisted: next, didPersist: true };
  } catch (error) {
    const isPermDenied =
      isFanError(error) && error.code === 'PERMISSION_DENIED';
    let rollbackNote = '';
    if (!isPermDenied) {
      try {
        transport.applyWrites(buildRollbackRequests(targets));
        rollbackNote = ' (已回滚硬件风扇状态)';
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        rollbackNote = ` (硬件转速已改变但回滚失败: ${rbMsg})`;
      }
    } else {
      rollbackNote = ' (硬件转速已改变但持久化提权失败, 未写入配置)';
    }
    const baseMsg = error instanceof Error ? error.message : String(error);
    const code = isFanError(error) ? error.code : 'DAEMON_FAILED';
    throw new FanError(code, `${baseMsg}${rollbackNote}`, { cause: error });
  }
}

function syncDaemonSafe(
  ensureDaemon: (() => { action: PersistDaemonAction }) | undefined,
): PersistDaemonAction | undefined {
  if (ensureDaemon === undefined) return undefined;
  try {
    return ensureDaemon().action;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = isFanError(error) ? error.code : 'DAEMON_FAILED';
    throw new FanError(
      code,
      `硬件与持久化配置已更新, 但后台守护同步失败: ${msg}`,
      { cause: error },
    );
  }
}

interface MutationDeps {
  transport: FanTransport;
  stateStore: FanStateStore | undefined;
  ensureDaemon: (() => { action: PersistDaemonAction }) | undefined;
}

function executeMutation(
  deps: MutationDeps,
  input: {
    targets: readonly FanInfo[];
    requests: readonly FanWriteRequest[];
    updates: Readonly<Record<string, PersistedFanEntry>>;
    fanIndex: number | undefined;
    persist: boolean | undefined;
    syncDaemon: boolean;
    extraWarnings?: FanWarning[];
  },
): FanStatusReport {
  const { transport, stateStore, ensureDaemon } = deps;
  const shouldPersist = input.persist !== false && stateStore !== undefined;
  // 持久化写前先验读 state.json: 损坏时在改写硬件前直接抛 STATE_CORRUPT 阻断
  const existingState = shouldPersist ? stateStore.read() : null;
  const updated = transport.applyWrites(input.requests);

  const warnings = [...(input.extraWarnings ?? [])];
  let persisted: FanPersistedState | null;
  let didPersist = false;
  if (shouldPersist) {
    const saved = persistWithRollback(
      stateStore,
      existingState,
      input.updates,
      transport,
      input.targets,
    );
    persisted = saved.persisted;
    didPersist = saved.didPersist;
  } else {
    const inspected = inspectPersisted(stateStore);
    persisted = inspected.persisted;
    if (inspected.warning !== undefined) warnings.push(inspected.warning);
  }

  // --once (persist=false) 不安装或重启持久化守护, 防 RunAtLoad 读取旧 state.json 覆盖临时设定
  const daemonAction =
    input.syncDaemon && shouldPersist
      ? syncDaemonSafe(ensureDaemon)
      : undefined;
  let finalFans = updated;
  if (daemonAction === 'installed' || daemonAction === 'updated') {
    const postDaemonFans = transport.readFans();
    const drifted = input.requests.some((req) => {
      const fan = postDaemonFans.find((item) => item.index === req.fanIndex);
      if (fan === undefined) return false;
      if (req.kind === 'auto') return fan.mode !== 'auto';
      const entry = input.updates[String(req.fanIndex)];
      const isFloor = entry?.mode === 'manual' && entry.strategy !== 'fixed';
      if (
        isFloor &&
        fan.mode === 'manual' &&
        fan.targetRpm >= req.targetRpm - 5
      ) {
        return false;
      }
      return (
        fan.mode !== 'manual' || Math.abs(fan.targetRpm - req.targetRpm) >= 5
      );
    });
    finalFans = drifted
      ? transport.applyWrites(input.requests)
      : postDaemonFans;
  }
  return buildReport(filterFans(finalFans, input.fanIndex), transport, {
    extraWarnings: warnings,
    persisted,
    didPersist,
    daemonAction,
  });
}

/** 创建风扇控制器 (默认直连 macOS AppleSMC 与系统级状态存储; 传自定义 `transport` 时不碰磁盘除非显式传 `stateStore`) */
export function createFanController(
  options: FanControllerOptions = {},
): FanController {
  const hostPlatform = options.platform ?? process.platform;
  const transport =
    options.transport ?? createAppleSmcTransport({ platform: hostPlatform });
  const isRealDarwinDefault =
    options.transport === undefined && hostPlatform === 'darwin';
  const stateStore =
    options.stateStore ??
    (isRealDarwinDefault
      ? createMacOsFanStateStore({ platform: hostPlatform })
      : undefined);
  let ensureDaemon: (() => { action: PersistDaemonAction }) | undefined;
  if (options.ensureDaemon !== false) {
    if (options.ensureDaemon !== undefined) {
      ensureDaemon = options.ensureDaemon;
    } else if (isRealDarwinDefault) {
      ensureDaemon = () =>
        ensurePersistDaemon({
          ...(stateStore !== undefined ? { statePath: stateStore.path } : {}),
          platform: hostPlatform,
        });
    }
  }
  const mutationDeps: MutationDeps = { transport, stateStore, ensureDaemon };

  return {
    status(opts: TargetFanOptions = {}): FanStatusReport {
      const allFans = transport.readFans();
      const selected = selectTargets(allFans, opts.fanIndex);
      const { persisted, warning } = inspectPersisted(stateStore);
      return buildReport(selected, transport, {
        extraWarnings: warning !== undefined ? [warning] : undefined,
        persisted,
      });
    },

    set(opts: SetSpeedOptions): FanStatusReport {
      const spec = parseSpeedSpec(opts.speed);
      const allFans = transport.readFans();
      const targets = selectTargets(allFans, opts.fanIndex);

      if (spec.kind === 'rpm') {
        const minAllowed = Math.round(
          Math.min(...targets.map((fan) => fan.minRpm)),
        );
        const maxAllowed = Math.round(
          Math.max(...targets.map((fan) => fan.maxRpm)),
        );
        const roundedInput = Math.round(spec.rpm);
        if (roundedInput < minAllowed || roundedInput > maxAllowed) {
          throw new FanError(
            'INVALID_SPEED',
            `目标转速 ${String(roundedInput)} RPM 超出允许范围 ${String(minAllowed)}-${String(maxAllowed)}`,
          );
        }
      }

      const strategy: ManualControlStrategy =
        opts.fixed === true ? 'fixed' : 'floor';
      const warnings: FanWarning[] = [];
      const requests: FanWriteRequest[] = [];
      const updates: Record<string, PersistedFanEntry> = {};

      for (const fan of targets) {
        const { targetRpm, clamped } = resolveTargetRpm(fan, spec);
        if (clamped) {
          warnings.push({
            code: 'FAN_CLAMPED',
            fanIndex: fan.index,
            message: `风扇 ${String(fan.index)} 目标转速已限幅至 ${String(Math.round(targetRpm))} RPM (允许范围 ${String(Math.round(fan.minRpm))}-${String(Math.round(fan.maxRpm))})`,
          });
        }
        requests.push({ kind: 'manual', fanIndex: fan.index, targetRpm });
        updates[String(fan.index)] =
          spec.kind === 'percent'
            ? { mode: 'manual', kind: 'percent', value: spec.percent, strategy }
            : { mode: 'manual', kind: 'rpm', value: targetRpm, strategy };
      }

      return executeMutation(mutationDeps, {
        targets,
        requests,
        updates,
        fanIndex: opts.fanIndex,
        persist: opts.persist,
        syncDaemon: true,
        extraWarnings: warnings,
      });
    },

    max(opts: TargetFanOptions = {}): FanStatusReport {
      const allFans = transport.readFans();
      const targets = selectTargets(allFans, opts.fanIndex);
      const requests: FanWriteRequest[] = [];
      const updates: Record<string, PersistedFanEntry> = {};

      for (const fan of targets) {
        requests.push({
          kind: 'manual',
          fanIndex: fan.index,
          targetRpm: fan.maxRpm,
        });
        updates[String(fan.index)] = {
          mode: 'manual',
          kind: 'percent',
          value: 100,
          strategy: 'fixed',
        };
      }

      return executeMutation(mutationDeps, {
        targets,
        requests,
        updates,
        fanIndex: opts.fanIndex,
        persist: opts.persist,
        syncDaemon: true,
      });
    },

    min(opts: MinFanOptions = {}): FanStatusReport {
      const allFans = transport.readFans();
      const targets = selectTargets(allFans, opts.fanIndex);
      const strategy: ManualControlStrategy =
        opts.fixed === true ? 'fixed' : 'floor';
      const requests: FanWriteRequest[] = [];
      const updates: Record<string, PersistedFanEntry> = {};

      for (const fan of targets) {
        requests.push({
          kind: 'manual',
          fanIndex: fan.index,
          targetRpm: fan.minRpm,
        });
        updates[String(fan.index)] = {
          mode: 'manual',
          kind: 'percent',
          value: 0,
          strategy,
        };
      }

      return executeMutation(mutationDeps, {
        targets,
        requests,
        updates,
        fanIndex: opts.fanIndex,
        persist: opts.persist,
        syncDaemon: true,
      });
    },

    auto(opts: TargetFanOptions = {}): FanStatusReport {
      const allFans = transport.readFans();
      const targets = selectTargets(allFans, opts.fanIndex);
      const requests: FanWriteRequest[] = [];
      const updates: Record<string, PersistedFanEntry> = {};

      for (const fan of targets) {
        requests.push({ kind: 'auto', fanIndex: fan.index });
        updates[String(fan.index)] = { mode: 'auto' };
      }

      return executeMutation(mutationDeps, {
        targets,
        requests,
        updates,
        fanIndex: opts.fanIndex,
        persist: opts.persist,
        syncDaemon: false,
      });
    },

    apply(): FanStatusReport {
      const persisted = stateStore?.read() ?? null;
      const allFans = transport.readFans();
      if (persisted === null || Object.keys(persisted.fans).length === 0) {
        return buildReport(allFans, transport, { persisted });
      }

      const requests: FanWriteRequest[] = [];
      for (const fan of allFans) {
        const entry = persisted.fans[String(fan.index)];
        if (entry === undefined) continue;
        if (entry.mode === 'auto') {
          requests.push({ kind: 'auto', fanIndex: fan.index });
          continue;
        }
        const spec: SpeedSpec =
          entry.kind === 'percent'
            ? { kind: 'percent', percent: entry.value }
            : { kind: 'rpm', rpm: entry.value };
        const { targetRpm } = resolveTargetRpm(fan, spec);
        requests.push({ kind: 'manual', fanIndex: fan.index, targetRpm });
      }

      const resultFans =
        requests.length > 0 ? transport.applyWrites(requests) : allFans;
      return buildReport(resultFans, transport, { persisted });
    },
  };
}
