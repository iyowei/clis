/**
 * `@iyowei/fan` 核心编排器 (`createFanController`):
 * 负责风扇索引校验、RPM/百分比解析与跨风扇夹逼、持久化状态自动记住/恢复、Macs Fan Control 冲突提示与底层传输委托。
 */
import { FanError } from './errors.ts';
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

function safeReadPersisted(
  store: FanStateStore | undefined,
): FanPersistedState | null {
  if (store === undefined) return null;
  try {
    return store.read();
  } catch {
    return null;
  }
}

function buildReport(
  fans: FanInfo[],
  transport: FanTransport,
  options: {
    extraWarnings?: FanWarning[];
    persisted?: FanPersistedState | null;
    didPersist?: boolean;
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
  return report;
}

function saveUpdates(
  store: FanStateStore | undefined,
  persistFlag: boolean | undefined,
  updates: Readonly<Record<string, PersistedFanEntry>>,
): { persisted: FanPersistedState | null; didPersist: boolean } {
  if (store === undefined || persistFlag === false) {
    return {
      persisted: safeReadPersisted(store),
      didPersist: false,
    };
  }
  const next = mergePersistedState(safeReadPersisted(store), updates);
  store.write(next);
  return { persisted: next, didPersist: true };
}

/** 创建风扇控制器 (默认直连 macOS AppleSMC 与系统级状态存储; 传自定义 `transport` 时不碰磁盘除非显式传 `stateStore`) */
export function createFanController(
  options: FanControllerOptions = {},
): FanController {
  const transport = options.transport ?? createAppleSmcTransport();
  const stateStore =
    options.stateStore ??
    (options.transport === undefined && process.platform === 'darwin'
      ? createMacOsFanStateStore()
      : undefined);

  return {
    status(opts: TargetFanOptions = {}): FanStatusReport {
      const allFans = transport.readFans();
      const selected = selectTargets(allFans, opts.fanIndex);
      return buildReport(selected, transport, {
        persisted: safeReadPersisted(stateStore),
      });
    },

    set(opts: SetSpeedOptions): FanStatusReport {
      const spec = parseSpeedSpec(opts.speed);
      const allFans = transport.readFans();
      const targets = selectTargets(allFans, opts.fanIndex);

      if (spec.kind === 'rpm') {
        const minAllowed = Math.min(...targets.map((fan) => fan.minRpm));
        const maxAllowed = Math.max(...targets.map((fan) => fan.maxRpm));
        if (spec.rpm < minAllowed || spec.rpm > maxAllowed) {
          throw new FanError(
            'INVALID_SPEED',
            `目标转速 ${String(Math.round(spec.rpm))} RPM 超出允许范围 ${String(Math.round(minAllowed))}-${String(Math.round(maxAllowed))}`,
          );
        }
      }

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
            ? { mode: 'manual', kind: 'percent', value: spec.percent }
            : { mode: 'manual', kind: 'rpm', value: targetRpm };
      }

      const updated = transport.applyWrites(requests);
      const saved = saveUpdates(stateStore, opts.persist, updates);
      return buildReport(filterFans(updated, opts.fanIndex), transport, {
        extraWarnings: warnings,
        ...saved,
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
        };
      }

      const updated = transport.applyWrites(requests);
      const saved = saveUpdates(stateStore, opts.persist, updates);
      return buildReport(filterFans(updated, opts.fanIndex), transport, saved);
    },

    min(opts: TargetFanOptions = {}): FanStatusReport {
      const allFans = transport.readFans();
      const targets = selectTargets(allFans, opts.fanIndex);
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
        };
      }

      const updated = transport.applyWrites(requests);
      const saved = saveUpdates(stateStore, opts.persist, updates);
      return buildReport(filterFans(updated, opts.fanIndex), transport, saved);
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

      const updated = transport.applyWrites(requests);
      const saved = saveUpdates(stateStore, opts.persist, updates);
      return buildReport(filterFans(updated, opts.fanIndex), transport, saved);
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
