/**
 * `@iyowei/fan-cli` 顶层入口编排:
 * 参数解析 -> `-V`/`-h` 短路 -> `update` 自更新 -> `persist` 守护管理 -> `@iyowei/fan` 控制与持久化 -> 渲染。
 */
import { readFileSync } from 'node:fs';

import { runSelfUpdate } from '@iyowei/cli-updater';
import {
  type FanController,
  type FanInfo,
  type FanStateStore,
  type FanStatusReport,
  type FanTransport,
  type PersistDaemonStatus,
  type PersistDaemonSyncResult,
  createFanController,
  ensurePersistDaemon,
  getPersistDaemonStatus,
  installPersistDaemon,
  uninstallPersistDaemon,
} from '@iyowei/fan';

import { parseArgs } from './args.ts';
import { helpText } from './help.ts';
import {
  isManualFanSettled,
  paint,
  renderPersistStatus,
  renderReport,
  renderWatchLine,
} from './render.ts';

export interface PersistDaemonOps {
  getStatus: () => PersistDaemonStatus;
  install: () => PersistDaemonStatus;
  uninstall: () => PersistDaemonStatus;
  ensure?: () => PersistDaemonSyncResult;
}

export interface CliDeps {
  transport?: FanTransport;
  stateStore?: FanStateStore;
  persistOps?: PersistDaemonOps;
  stdoutColor?: boolean;
  stderrColor?: boolean;
  out?: (line: string) => void;
  rawWrite?: (chunk: string) => void;
  err?: (line: string) => void;
  version?: string;
  /** 是否在调速命令后原地刷新追踪实际转速爬升 (默认仅在真 TTY 交互执行时开启) */
  liveSettle?: boolean;
  settleIntervalMs?: number;
  settleMaxMs?: number;
}

function defaultColors(): { stdout: boolean; stderr: boolean } {
  const allowed =
    !process.env.NO_COLOR && process.env.TERM?.toLowerCase() !== 'dumb';
  return {
    stdout: allowed && process.stdout.isTTY === true,
    stderr: allowed && process.stderr.isTTY === true,
  };
}

function readCliVersion(): string {
  try {
    const raw = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatTime(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function runWatchLoop(
  controller: FanController,
  fanIndex: number | undefined,
  intervalSec: number,
  color: boolean,
  out: (line: string) => void,
): Promise<number> {
  const intervalMs = Math.max(200, Math.round(intervalSec * 1000));
  let stopped = false;
  const onSigint = () => {
    stopped = true;
  };
  process.on('SIGINT', onSigint);
  try {
    while (!stopped) {
      const report = controller.status({ fanIndex });
      out(renderWatchLine(report, formatTime(), color));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
  return 0;
}

const ACTION_TITLES: Readonly<Record<string, string>> = {
  status: '风扇状态',
  set: '已设定手动转速',
  max: '已开启全速模式',
  min: '已设定最低转速',
  auto: '已恢复系统自动温控',
  apply: '已应用持久化配置',
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const AUTO_PLATEAU_LIMIT = 8;
const AUTO_PLATEAU_DELTA_RPM = 30;

function fansNeedSettle(report: FanStatusReport): boolean {
  return report.fans.some((fan) => {
    if (fan.mode === 'manual') {
      return !isManualFanSettled(fan);
    }
    return Math.round(fan.actualRpm) > 0;
  });
}

function isAutoPlateau(
  prevFans: readonly FanInfo[],
  nextFans: readonly FanInfo[],
): boolean {
  if (nextFans.length === 0 || nextFans.some((f) => f.mode !== 'auto')) {
    return false;
  }
  return nextFans.every((next) => {
    const prev = prevFans.find((p) => p.index === next.index);
    return (
      prev !== undefined &&
      Math.abs(next.actualRpm - prev.actualRpm) <= AUTO_PLATEAU_DELTA_RPM
    );
  });
}

async function renderWithLiveSettle(options: {
  initialReport: FanStatusReport;
  controller: FanController;
  fanIndex: number | undefined;
  color: boolean;
  title: string | undefined;
  writeRaw: (chunk: string) => void;
  intervalMs: number;
  maxMs: number | undefined;
}): Promise<void> {
  const {
    initialReport,
    controller,
    fanIndex,
    color,
    title,
    writeRaw,
    intervalMs,
    maxMs,
  } = options;

  let current: FanStatusReport = initialReport;
  if (!fansNeedSettle(current) || (maxMs !== undefined && maxMs <= 0)) {
    writeRaw(`${renderReport(current, { color, json: false, title })}\n`);
    return;
  }

  let tick = 0;
  const hasAutoSpinning = () =>
    current.fans.some((f) => f.mode === 'auto' && Math.round(f.actualRpm) > 0);
  const spinHint = () => {
    const glyph = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
    return hasAutoSpinning()
      ? `${glyph} 正在等待风扇降速停转… (Ctrl+C 跳过等待)`
      : `${glyph} 物理风扇正在响应目标转速… (Ctrl+C 跳过等待)`;
  };

  let frame = renderReport(current, {
    color,
    json: false,
    title,
    extraHint: spinHint(),
    settlingAuto: true,
  });
  writeRaw(`${frame}\n`);

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);
  if (color) writeRaw('\u001B[?25l');

  let autoPlateauTicks = 0;
  const deadline = maxMs === undefined ? undefined : Date.now() + maxMs;
  try {
    while (
      !interrupted &&
      (deadline === undefined || Date.now() < deadline) &&
      fansNeedSettle(current)
    ) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (interrupted) break;
      tick += 1;
      const prevFans = current.fans;
      const latest = controller.status({ fanIndex });
      current = { ...initialReport, fans: latest.fans };
      if (!fansNeedSettle(current)) break;

      if (isAutoPlateau(prevFans, current.fans)) {
        autoPlateauTicks += 1;
        if (autoPlateauTicks >= AUTO_PLATEAU_LIMIT) break;
      } else {
        autoPlateauTicks = 0;
      }

      const prevLines = frame.split('\n').length;
      frame = renderReport(current, {
        color,
        json: false,
        title,
        extraHint: spinHint(),
        settlingAuto: true,
      });
      writeRaw(`\u001B[${String(prevLines)}A\r\u001B[0J${frame}\n`);
    }
    const prevLines = frame.split('\n').length;
    const finalFrame = renderReport(current, { color, json: false, title });
    writeRaw(`\u001B[${String(prevLines)}A\r\u001B[0J${finalFrame}\n`);
  } finally {
    if (color) writeRaw('\u001B[?25h');
    process.off('SIGINT', onSigint);
  }
}

const PERSIST_TITLES: Readonly<Record<string, string>> = {
  status: '持久化守护状态',
  install: '已安装持久化守护服务',
  uninstall: '已卸载持久化守护服务',
};

function runPersistAction(
  persistOps: PersistDaemonOps,
  action: 'status' | 'install' | 'uninstall',
): PersistDaemonStatus {
  if (action === 'install') return persistOps.install();
  if (action === 'uninstall') return persistOps.uninstall();
  return persistOps.getStatus();
}

/** 执行单次 CLI 调用 (可注入 `transport` / `stateStore` / `persistOps` 供单测直测) */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> {
  const colors = defaultColors();
  const stdoutColor = deps.stdoutColor ?? colors.stdout;
  const stderrColor = deps.stderrColor ?? colors.stderr;
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err =
    deps.err ??
    ((line: string) =>
      process.stderr.write(
        stderrColor ? `${paint('✗', '31', true)} ${line}\n` : `${line}\n`,
      ));

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    err(`参数错误: ${parsed.message} (用 --help 查看用法)`);
    return 1;
  }

  const { options } = parsed;
  if (options.version) {
    out(deps.version ?? readCliVersion());
    return 0;
  }
  if (options.help) {
    out(helpText(stdoutColor));
    return 0;
  }

  const persistOps: PersistDaemonOps = deps.persistOps ?? {
    getStatus: () => getPersistDaemonStatus(),
    install: () => installPersistDaemon(),
    uninstall: () => uninstallPersistDaemon(),
    ensure: () => ensurePersistDaemon(),
  };

  const ensureFromOps = (): PersistDaemonSyncResult => {
    if (persistOps.ensure !== undefined) {
      return persistOps.ensure();
    }
    const cur = persistOps.getStatus();
    if (cur.installed && cur.running) {
      return { status: cur, action: 'unchanged' };
    }
    const existed = cur.installed;
    const next = persistOps.install();
    return { status: next, action: existed ? 'updated' : 'installed' };
  };

  try {
    if (options.command === 'update') {
      return await runSelfUpdate({
        binName: 'fan',
        entryMetaUrl: import.meta.url,
        argv: options.updateArgs ?? [],
        color: { stdout: stdoutColor, stderr: stderrColor },
      });
    }

    if (options.command === 'persist') {
      const action = options.persistAction ?? 'status';
      const daemonStatus = runPersistAction(persistOps, action);
      out(
        renderPersistStatus(daemonStatus, {
          color: stdoutColor,
          json: options.json,
          title: PERSIST_TITLES[action],
        }),
      );
      return 0;
    }

    const shouldManageDaemon =
      deps.persistOps !== undefined ||
      (deps.transport === undefined && process.platform === 'darwin');

    const controller = createFanController({
      transport: deps.transport,
      stateStore: deps.stateStore,
      ensureDaemon: shouldManageDaemon ? ensureFromOps : false,
    });

    if (options.command === 'status' && options.watchSeconds !== undefined) {
      return await runWatchLoop(
        controller,
        options.fanIndex,
        options.watchSeconds,
        stdoutColor,
        out,
      );
    }

    const fanOpts = {
      fanIndex: options.fanIndex,
      persist: !options.once,
    };
    let report: FanStatusReport;
    if (options.command === 'status') {
      report = controller.status({ fanIndex: options.fanIndex });
    } else if (options.command === 'set') {
      report = controller.set({ speed: options.speed!, ...fanOpts });
    } else if (options.command === 'max') {
      report = controller.max(fanOpts);
    } else if (options.command === 'min') {
      report = controller.min(fanOpts);
    } else if (options.command === 'auto') {
      report = controller.auto(fanOpts);
    } else {
      report = controller.apply();
    }

    const isMutatingTuneCmd =
      options.command === 'set' ||
      options.command === 'max' ||
      options.command === 'min' ||
      options.command === 'auto' ||
      options.command === 'apply';
    const shouldLiveSettle =
      !options.json &&
      isMutatingTuneCmd &&
      (deps.liveSettle ??
        (deps.out === undefined && process.stdout.isTTY === true));

    if (shouldLiveSettle) {
      const writeRaw =
        deps.rawWrite ?? ((chunk: string) => process.stdout.write(chunk));
      await renderWithLiveSettle({
        initialReport: report,
        controller,
        fanIndex: options.fanIndex,
        color: stdoutColor,
        title: ACTION_TITLES[options.command],
        writeRaw,
        intervalMs: deps.settleIntervalMs ?? 200,
        maxMs: deps.settleMaxMs,
      });
      return 0;
    }

    out(
      renderReport(report, {
        color: stdoutColor,
        json: options.json,
        title: ACTION_TITLES[options.command],
      }),
    );
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(msg);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
