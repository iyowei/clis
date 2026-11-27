/**
 * `@iyowei/wake-cli` 配置向导 (`wake init`):
 * 支持两种等价路径:
 * 1. 非交互参数模式 (`--name <alias> --mac <mac> [...]`): 确定性写入 `config.json`, 便于脚本自动化与测试;
 * 2. 交互式 TTY 向导: 自动探测本机 ARP 邻接表给出可选主机/MAC, 引导录入并原子落盘。
 */
import { createInterface } from 'node:readline/promises';

import { type Locale, t } from '@iyowei/cli-i18n';
import {
  type ArpNeighborEntry,
  type WakeTargetConfig,
  discoverArpNeighbors,
  normalizeMacList,
  resolveWakeConfigPath,
  upsertWakeTarget,
  validateTargetName,
} from '@iyowei/wake';

import type { CliOptions } from './args.ts';
import {
  paint,
  renderHeader,
  sanitizeOutputLine,
} from './render-primitives.ts';

function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

async function promptInteractiveInit(options: {
  cli: CliOptions;
  locale: Locale;
  neighbors: readonly ArpNeighborEntry[];
  out: (line: string) => void;
}): Promise<{
  targetName: string;
  target: WakeTargetConfig;
  setDefault: boolean;
}> {
  const { cli, locale, neighbors, out } = options;
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    if (neighbors.length > 0) {
      out(
        t(
          locale,
          '发现近期局域网 ARP 主机 (可直接输入编号自动带入):',
          'Discovered local ARP neighbors (enter index to prefill):',
        ),
      );
      const preview = neighbors.slice(0, 8);
      for (let i = 0; i < preview.length; i += 1) {
        const n = preview[i]!;
        out(
          `  [${String(i + 1)}] ${n.ip}  ${n.mac}${n.iface ? ` (${sanitizeOutputLine(n.iface)})` : ''}`,
        );
      }
      const pick = (
        await rl.question(
          t(
            locale,
            '选择编号 [回车跳过]: ',
            'Pick neighbor number [Enter to skip]: ',
          ),
        )
      ).trim();
      const idx = Number(pick);
      if (Number.isInteger(idx) && idx >= 1 && idx <= preview.length) {
        const chosen = preview[idx - 1]!;
        if (cli.macs.length === 0) cli.macs.push(chosen.mac);
        if (cli.host === undefined) cli.host = chosen.ip;
      }
    }

    const nameRaw =
      cli.name ??
      cli.target ??
      (
        await rl.question(
          t(
            locale,
            '目标别名 (例如 workstation): ',
            'Target alias (e.g. workstation): ',
          ),
        )
      ).trim();
    const targetName = validateTargetName(nameRaw || 'workstation');

    const macPromptDefault = cli.macs.join(', ');
    const macAnswer = (
      await rl.question(
        macPromptDefault !== ''
          ? t(
              locale,
              `MAC 地址 (逗号分隔) [${macPromptDefault}]: `,
              `MAC address(es), comma-separated [${macPromptDefault}]: `,
            )
          : t(
              locale,
              'MAC 地址 (支持多块网卡, 逗号分隔): ',
              'MAC address(es), comma-separated: ',
            ),
      )
    ).trim();
    const macs = normalizeMacList(
      macAnswer !== '' ? splitCsv(macAnswer) : cli.macs,
    );

    const hostDefault = cli.host ?? '';
    const hostAnswer = (
      await rl.question(
        hostDefault !== ''
          ? t(
              locale,
              `目标主机 IP/域名 [${hostDefault}]: `,
              `Target host IP/hostname [${hostDefault}]: `,
            )
          : t(
              locale,
              '目标主机 IP/域名 (可选, 用于就绪检测): ',
              'Target host IP/hostname (optional, for readiness check): ',
            ),
      )
    ).trim();
    const host = hostAnswer !== '' ? hostAnswer : cli.host;

    const relayAnswer = (
      await rl.question(
        t(
          locale,
          'SSH 跳板机列表 (跨网段代发开机包用, 填别名或 user@host, 逗号隔开, 可留空): ',
          'SSH jump hosts in order (alias or user@host, comma-separated, optional): ',
        ),
      )
    ).trim();
    const relays = relayAnswer !== '' ? splitCsv(relayAnswer) : [...cli.relays];

    const defAnswer = (
      await rl.question(
        t(locale, '设为默认唤醒目标? [Y/n]: ', 'Set as defaultTarget? [Y/n]: '),
      )
    )
      .trim()
      .toLowerCase();
    const setDefault =
      cli.setDefault || (defAnswer !== 'n' && defAnswer !== 'no');

    return {
      targetName,
      target: {
        macs,
        ...(host !== undefined && host !== '' ? { host } : {}),
        port: cli.port ?? 22,
        ...(cli.broadcast.length > 0 ? { broadcast: cli.broadcast } : {}),
        ...(relays.length > 0 ? { relays } : {}),
      },
      setDefault,
    };
  } finally {
    rl.close();
  }
}

/** 执行 `wake init` 配置新增/更新 */
export async function runInitCommand(options: {
  cli: CliOptions;
  locale: Locale;
  color: boolean;
  interactive: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  discoverNeighbors?: () => Promise<ArpNeighborEntry[]>;
}): Promise<number> {
  const { cli, locale, color, interactive, out, err } = options;
  const configPath = resolveWakeConfigPath({ configPath: cli.configPath });

  const resolvedName = cli.name ?? cli.target;
  const nonInteractiveReady = resolvedName !== undefined && cli.macs.length > 0;

  let targetName: string;
  let targetEntry: WakeTargetConfig;
  let setDefault = cli.setDefault;

  if (nonInteractiveReady) {
    targetName = validateTargetName(resolvedName);
    targetEntry = {
      macs: normalizeMacList(cli.macs),
      ...(cli.host !== undefined ? { host: cli.host } : {}),
      port: cli.port ?? 22,
      ...(cli.broadcast.length > 0 ? { broadcast: cli.broadcast } : {}),
      ...(cli.relays.length > 0 ? { relays: cli.relays } : {}),
      ...(cli.waitTimeoutMs !== undefined
        ? { waitTimeoutMs: cli.waitTimeoutMs }
        : {}),
    };
  } else if (!interactive) {
    err(
      t(
        locale,
        '非交互模式下执行 wake init 必须同时提供 --name <target> 与 --mac <mac>',
        'Non-interactive wake init requires --name <target> and --mac <mac>',
      ),
    );
    return 1;
  } else {
    const neighbors = await (
      options.discoverNeighbors ?? (() => discoverArpNeighbors())
    )();
    const prompted = await promptInteractiveInit({
      cli: { ...cli },
      locale,
      neighbors,
      out: (line) => err(line),
    });
    targetName = prompted.targetName;
    targetEntry = prompted.target;
    setDefault = prompted.setDefault;
  }

  const saved = upsertWakeTarget(configPath, targetName, targetEntry, {
    setDefault,
    overwrite: cli.force || cli.yes,
  });

  if (cli.json) {
    out(
      JSON.stringify(
        {
          configPath,
          savedTarget: targetName,
          defaultTarget: saved.defaultTarget ?? null,
          target: saved.targets[targetName],
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out(
    renderHeader(
      t(
        locale,
        `已保存目标 ${sanitizeOutputLine(targetName)}`,
        `Saved target ${sanitizeOutputLine(targetName)}`,
      ),
      color,
    ),
  );
  out(
    `  ${paint(t(locale, '配置路径:', 'Config path:'), '2', color)} ${sanitizeOutputLine(configPath)}`,
  );
  out(`  ${paint('MAC:', '2', color)} ${targetEntry.macs.join(', ')}`);
  if (targetEntry.host !== undefined) {
    out(
      `  ${paint(t(locale, '探测端点:', 'Endpoint:'), '2', color)} ${sanitizeOutputLine(targetEntry.host)}:${String(targetEntry.port ?? 22)}`,
    );
  }
  return 0;
}
