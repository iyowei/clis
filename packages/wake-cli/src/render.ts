/**
 * `@iyowei/wake-cli` 双语视图渲染与错误本地化: 覆盖唤醒结果、目标清单、环境诊断及 SGR 流光等待态。
 */
import { type Locale, t } from '@iyowei/cli-i18n';
import { renderShimmerText } from '@iyowei/cli-updater';
import {
  type WakeConfig,
  type WakeDoctorReport,
  type WakeProgressEvent,
  type WakeReport,
  isWakeError,
} from '@iyowei/wake';

import {
  displayWidth,
  padDisplay,
  paint,
  renderHeader,
  sanitizeOutputLine,
} from './render-primitives.ts';

function localizeStatusText(
  status: WakeReport['status'],
  locale: Locale,
): string {
  switch (status) {
    case 'already-online':
      return t(locale, '已在线 (无需唤醒)', 'Already online');
    case 'woken':
      return t(locale, '唤醒成功并已就绪', 'Woken and reachable');
    case 'dispatched':
      return t(locale, '魔术包已发送 (--no-wait)', 'Magic packet dispatched');
    case 'timeout':
      return t(locale, '已发包但等待上线超时', 'Dispatched, wait timed out');
  }
}

function statusTone(status: WakeReport['status']): string {
  switch (status) {
    case 'already-online':
    case 'woken':
      return '1;32';
    case 'dispatched':
      return '36';
    case 'timeout':
      return '1;31';
  }
}

function formatMethodLabel(report: WakeReport, locale: Locale): string {
  if (report.method === 'none') {
    return t(locale, '跳过发包', 'Skipped dispatch');
  }
  if (report.method === 'relay') {
    const relay = sanitizeOutputLine(report.activeRelay ?? 'relay');
    return t(locale, `SSH 中继 (${relay})`, `SSH relay (${relay})`);
  }
  return t(locale, '本机局域网 UDP 广播', 'Local LAN UDP broadcast');
}

/** 渲染 `wake` 执行结果 (JSON 或双语终端面板) */
export function renderWakeReport(
  report: WakeReport,
  options: { color: boolean; json: boolean; locale: Locale },
): string {
  if (options.json) return JSON.stringify(report, null, 2);

  const { color, locale } = options;
  const safeTarget = sanitizeOutputLine(report.target);
  const lines: string[] = [];

  lines.push(
    renderHeader(
      t(locale, `目标 ${safeTarget}`, `Target ${safeTarget}`),
      color,
    ),
  );
  lines.push('');

  const rows: Array<readonly [string, string, string?]> = [
    [
      t(locale, '状态', 'Status'),
      localizeStatusText(report.status, locale),
      statusTone(report.status),
    ],
    [t(locale, '途径', 'Path'), formatMethodLabel(report, locale), undefined],
    [
      'MAC',
      report.macs.length > 0
        ? report.macs.join(', ')
        : t(locale, '由中继配置解析', 'Resolved by relay'),
      '36',
    ],
  ];

  if (report.host !== undefined) {
    const endpoint = `${sanitizeOutputLine(report.host)}:${String(report.port ?? 22)}`;
    rows.push([t(locale, '端点', 'Endpoint'), endpoint, undefined]);
  }
  if (report.dispatched) {
    const pktSummary =
      report.destinations.length > 0
        ? `${String(report.packetsSent)} (${report.destinations.join(', ')})`
        : String(report.packetsSent);
    rows.push([t(locale, '发包', 'Packets'), pktSummary, undefined]);
  }
  rows.push([
    t(locale, '耗时', 'Elapsed'),
    `${(report.elapsedMs / 1000).toFixed(1)}s`,
    '2',
  ]);

  const labelCol = Math.max(...rows.map(([lbl]) => displayWidth(lbl))) + 3;
  for (const [label, value, tone] of rows) {
    const styledVal = tone !== undefined ? paint(value, tone, color) : value;
    lines.push(
      `  ${paint(padDisplay(label, labelCol), '2', color)}${styledVal}`,
    );
  }

  for (const attempt of report.relayAttempts) {
    if (attempt.ok) continue;
    const msg = sanitizeOutputLine(
      `${attempt.relay}: ${attempt.reason ?? t(locale, '未响应', 'failed')}`,
    );
    lines.push(
      `  ${paint('!', '33', color)} ${paint(t(locale, '中继回退:', 'Relay failover:'), '33', color)} ${msg}`,
    );
  }
  for (const warn of report.warnings) {
    lines.push(
      `  ${paint('!', '33', color)} ${sanitizeOutputLine(warn.message)}`,
    );
  }

  return lines.join('\n');
}

/** 渲染 `wake list` 配置清单 */
export function renderListReport(
  configPath: string,
  config: WakeConfig | null,
  options: { color: boolean; json: boolean; locale: Locale },
): string {
  if (options.json) {
    return JSON.stringify(
      {
        configPath,
        defaultTarget: config?.defaultTarget ?? null,
        targets: config?.targets ?? {},
      },
      null,
      2,
    );
  }

  const { color, locale } = options;
  const lines: string[] = [
    renderHeader(t(locale, '已配置目标主机', 'Configured Targets'), color),
    `  ${paint(t(locale, '配置文件:', 'Config file:'), '2', color)} ${sanitizeOutputLine(configPath)}`,
    '',
  ];

  if (config === null || Object.keys(config.targets).length === 0) {
    lines.push(
      `  ${paint(t(locale, '尚无配置目标, 请运行 wake init 添加。', 'No targets configured yet. Run wake init to add one.'), '33', color)}`,
    );
    return lines.join('\n');
  }

  const entries = Object.entries(config.targets).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const nameCol = Math.max(...entries.map(([k]) => displayWidth(k))) + 4;
  for (const [name, entry] of entries) {
    const isDef = config.defaultTarget === name;
    const mark = isDef ? paint('*', '32', color) : ' ';
    const nameStyled = paint(
      padDisplay(sanitizeOutputLine(name), nameCol),
      isDef ? '1;36' : '36',
      color,
    );
    const endpoint =
      entry.host !== undefined
        ? `${sanitizeOutputLine(entry.host)}:${String(entry.port ?? 22)}`
        : t(locale, '无探测主机', 'no probe host');
    const relayNote =
      entry.relays && entry.relays.length > 0
        ? ` · ${t(locale, '中继', 'relays')}: ${entry.relays.map(sanitizeOutputLine).join(' → ')}`
        : '';
    lines.push(
      `  ${mark} ${nameStyled}${entry.macs.join(', ')}  ${paint(`(${endpoint}${relayNote})`, '2', color)}`,
    );
  }

  return lines.join('\n');
}

function formatConfigState(
  report: WakeDoctorReport,
  color: boolean,
  locale: Locale,
): string {
  if (!report.configExists) {
    return paint(
      t(locale, '未创建 (可运行 wake init)', 'Absent (run wake init)'),
      '33',
      color,
    );
  }
  if (report.configError !== undefined) {
    return paint(sanitizeOutputLine(report.configError), '31', color);
  }
  return paint(t(locale, '正常', 'OK'), '32', color);
}

function formatTargetReachable(
  report: WakeDoctorReport,
  color: boolean,
  locale: Locale,
): string {
  if (report.targetReachable === undefined) {
    return t(locale, '未配置 host', 'no probe host');
  }
  if (report.targetReachable) {
    return paint(
      t(
        locale,
        `在线 (${String(report.targetLatencyMs ?? 0)}ms)`,
        `Online (${String(report.targetLatencyMs ?? 0)}ms)`,
      ),
      '32',
      color,
    );
  }
  return paint(
    t(locale, '当前离线或端口未就绪', 'Offline / port unreachable'),
    '33',
    color,
  );
}

function formatRelayBadge(
  relay: WakeDoctorReport['relays'][number],
  color: boolean,
): string {
  if (relay.reachable && relay.remoteWakeAvailable) {
    return paint('✓', '32', color);
  }
  if (relay.reachable) {
    return paint('!', '33', color);
  }
  return paint('✗', '31', color);
}

/** 渲染 `wake doctor` 诊断报告 */
export function renderDoctorReport(
  report: WakeDoctorReport,
  options: { color: boolean; json: boolean; locale: Locale },
): string {
  if (options.json) return JSON.stringify(report, null, 2);

  const { color, locale } = options;
  const lines: string[] = [
    renderHeader(
      t(locale, '唤醒环境只读诊断', 'Wake Environment Diagnostics'),
      color,
    ),
    '',
  ];

  const cfgState = formatConfigState(report, color, locale);
  lines.push(
    `  ${paint(t(locale, '配置:', 'Config:'), '2', color)} ${sanitizeOutputLine(report.configPath)} (${cfgState})`,
  );

  if (report.targetName !== undefined) {
    const targetLabel = sanitizeOutputLine(report.targetName);
    const reach = formatTargetReachable(report, color, locale);
    lines.push(
      `  ${paint(t(locale, '目标:', 'Target:'), '2', color)} ${paint(targetLabel, '36', color)} (${reach})`,
    );
  }

  lines.push('');
  lines.push(
    `  ${paint(t(locale, '本机 IPv4 接口:', 'Local IPv4 Interfaces:'), '1', color)}`,
  );
  if (report.interfaces.length === 0) {
    lines.push(
      `    ${paint(t(locale, '未发现可用外部 IPv4 接口', 'No external IPv4 interfaces detected'), '33', color)}`,
    );
  } else {
    for (const nic of report.interfaces) {
      const tag = nic.isVirtual
        ? paint(t(locale, '[隧道/虚拟]', '[tunnel/virtual]'), '2', color)
        : paint(t(locale, '[局域网]', '[LAN]'), '32', color);
      lines.push(
        `    ${tag} ${nic.name}: ${nic.address} → ${t(locale, '广播', 'broadcast')} ${nic.broadcast}`,
      );
    }
  }

  if (report.relays.length > 0) {
    lines.push('');
    lines.push(
      `  ${paint(t(locale, 'SSH 中继状态:', 'SSH Relays:'), '1', color)}`,
    );
    for (const r of report.relays) {
      const badge = formatRelayBadge(r, color);
      const status =
        r.reachable && r.remoteWakeAvailable
          ? t(
              locale,
              `可用 (wake ${sanitizeOutputLine(r.remoteWakeVersion ?? '')})`,
              `ready (wake ${sanitizeOutputLine(r.remoteWakeVersion ?? '')})`,
            )
          : sanitizeOutputLine(
              r.reason ??
                t(locale, '远端未安装 wake', 'remote wake unavailable'),
            );
      lines.push(
        `    ${badge} ${sanitizeOutputLine(r.relay)}  ${paint(status, '2', color)}`,
      );
    }
  }

  return lines.join('\n');
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 将等待上线进度事件渲染为单行流光指示文本 (含无颜色纯文本回退) */
export function renderProgressLine(
  event: WakeProgressEvent,
  tick: number,
  color: boolean,
  locale: Locale,
): string {
  const glyph = paint(SPINNER[tick % SPINNER.length]!, '36', color);
  if (event.phase === 'precheck') {
    const msg = t(
      locale,
      `正在预检 ${sanitizeOutputLine(event.host)}:${String(event.port)}…`,
      `Checking ${sanitizeOutputLine(event.host)}:${String(event.port)}…`,
    );
    return `${glyph} ${renderShimmerText(msg, tick, color)}`;
  }
  if (event.phase === 'relay') {
    const msg = t(
      locale,
      `正在通过 SSH 中继 (${String(event.index)}/${String(event.total)}): ${sanitizeOutputLine(event.relay)}…`,
      `Trying SSH relay (${String(event.index)}/${String(event.total)}): ${sanitizeOutputLine(event.relay)}…`,
    );
    return `${glyph} ${renderShimmerText(msg, tick, color)}`;
  }
  if (event.phase === 'local-burst') {
    const msg = t(
      locale,
      `正在发送局域网 WoL 魔术包 (${event.destinations.join(', ')})…`,
      `Broadcasting WoL magic packet (${event.destinations.join(', ')})…`,
    );
    return `${glyph} ${renderShimmerText(msg, tick, color)}`;
  }
  const sec = (event.elapsedMs / 1000).toFixed(1);
  const maxSec = String(Math.round(event.timeoutMs / 1000));
  const msg = t(
    locale,
    `已发送唤醒包, 等待 ${sanitizeOutputLine(event.host)}:${String(event.port)} 上线 (${sec}s / ${maxSec}s)…`,
    `Waiting for ${sanitizeOutputLine(event.host)}:${String(event.port)} (${sec}s / ${maxSec}s)…`,
  );
  return `${glyph} ${renderShimmerText(msg, tick, color)}`;
}

/** 将 `WakeError` 与未知异常本地化为可读错误文本 */
export function localizeWakeError(error: unknown, locale: Locale): string {
  if (!isWakeError(error)) {
    return sanitizeOutputLine(
      error instanceof Error ? error.message : String(error),
    );
  }
  const msg = sanitizeOutputLine(error.message);
  if (locale === 'zh') return msg;
  switch (error.code) {
    case 'CONFIG_ABSENT':
      return 'Wake configuration file not found (run wake init or pass --mac)';
    case 'CONFIG_READ_FAILED':
      return `Failed to read wake configuration: ${msg}`;
    case 'CONFIG_INVALID':
      return `Invalid wake configuration: ${msg}`;
    case 'CONFIG_WRITE_FAILED':
      return `Failed to write wake configuration: ${msg}`;
    case 'TARGET_NOT_FOUND':
      return `Wake target not found: ${msg}`;
    case 'INVALID_TARGET':
      return `Invalid target name: ${msg}`;
    case 'INVALID_MAC':
      return `Invalid MAC address: ${msg}`;
    case 'INVALID_HOST':
      return `Invalid host address: ${msg}`;
    case 'INVALID_PORT':
      return `Invalid TCP port: ${msg}`;
    case 'INVALID_BROADCAST':
      return `Invalid broadcast IPv4 address: ${msg}`;
    case 'INVALID_RELAY':
      return `Invalid SSH relay identifier: ${msg}`;
    case 'NETWORK_FAILED':
      return `Network dispatch failed: ${msg}`;
    case 'RELAY_FAILED':
      return `SSH relay dispatch failed: ${msg}`;
  }
}
