/**
 * `@iyowei/wake-cli` 顶层 CLI 编排集成测试 (含双语切换、非交互 init、list、doctor 与超时退出码)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWakeCli } from './cli.ts';

const dirs: string[] = [];

function allocDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wake-cli-test-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('wake-cli 顶层命令编排', () => {
  test('完整闭环: init 非交互写入 -> list JSON -> doctor 只读 -> wake 上线与超时退 1', async () => {
    const dir = allocDir();
    const cfgPath = join(dir, 'wake', 'config.json');

    const initOut: string[] = [];
    const initErr: string[] = [];
    const initCode = await runWakeCli(
      [
        'init',
        '--config',
        cfgPath,
        '--name',
        'workstation',
        '--mac',
        '00:11:22:33:44:55',
        '--host',
        '192.0.2.10',
        '--relay',
        'bastion-a',
        '--default',
        '--yes',
        '--lang',
        'en',
      ],
      {
        isInteractive: () => false,
        colorChannels: () => ({ stdout: false, stderr: false }),
        out: (l) => initOut.push(l),
        err: (l) => initErr.push(l),
      },
    );
    expect(initCode, initErr.join('\n')).toBe(0);
    expect(initOut.join('\n')).toContain('Saved target workstation');

    const listOut: string[] = [];
    const listCode = await runWakeCli(
      ['list', '--config', cfgPath, '--json', '--lang', 'zh'],
      {
        colorChannels: () => ({ stdout: false, stderr: false }),
        out: (l) => listOut.push(l),
      },
    );
    expect(listCode).toBe(0);
    const listParsed = JSON.parse(listOut.join('\n')) as {
      defaultTarget: string;
      targets: Record<string, { macs: string[] }>;
    };
    expect(listParsed.defaultTarget).toBe('workstation');
    expect(listParsed.targets.workstation?.macs).toEqual(['00:11:22:33:44:55']);

    const docOut: string[] = [];
    const docCode = await runWakeCli(
      ['doctor', '--config', cfgPath, '--json'],
      {
        colorChannels: () => ({ stdout: false, stderr: false }),
        out: (l) => docOut.push(l),
        deps: {
          network: {
            listInterfaces: () => [],
            probeTcp: async () => ({ reachable: false, latencyMs: 3 }),
            sendUdpBurst: async () => {
              throw new Error('doctor must not send UDP packets');
            },
          },
          relay: {
            probeRelay: async ({ relay }) => ({
              relay,
              reachable: true,
              remoteWakeAvailable: true,
              remoteWakeVersion: '1.0.0',
            }),
          },
        },
      },
    );
    expect(docCode).toBe(0);
    expect(JSON.parse(docOut.join('\n')).relays[0].remoteWakeVersion).toBe(
      '1.0.0',
    );

    const wakeOut: string[] = [];
    const wakeCode = await runWakeCli(
      ['--config', cfgPath, '--json', 'workstation'],
      {
        colorChannels: () => ({ stdout: false, stderr: false }),
        out: (l) => wakeOut.push(l),
        deps: {
          network: {
            probeTcp: async () => ({ reachable: true, latencyMs: 2 }),
          },
        },
      },
    );
    expect(wakeCode).toBe(0);
    expect(JSON.parse(wakeOut.join('\n')).status).toBe('already-online');

    const timeoutOut: string[] = [];
    const timeoutErr: string[] = [];
    let nowMs = 0;
    const timeoutCode = await runWakeCli(
      ['workstation', '--config', cfgPath, '-t', '1', '--lang', 'en'],
      {
        colorChannels: () => ({ stdout: false, stderr: false }),
        out: (l) => timeoutOut.push(l),
        err: (l) => timeoutErr.push(l),
        deps: {
          clock: {
            now: () => nowMs,
            sleep: async () => {
              nowMs += 1_500;
            },
          },
          network: {
            probeTcp: async () => ({ reachable: false, latencyMs: 1 }),
          },
          relay: {
            dispatchViaRelay: async () => ({ ok: true, packetsSent: 2 }),
          },
        },
      },
    );
    expect(timeoutCode).toBe(1);
    expect(timeoutOut.join('\n')).toContain('wait timed out');
    expect(timeoutErr.join('\n')).toContain('before timeout');
  });

  test('lang 与 update --help 及 --version / --help 正常工作', async () => {
    const out: string[] = [];
    expect(await runWakeCli(['-V'], { out: (l) => out.push(l) })).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);

    const helpOut: string[] = [];
    expect(
      await runWakeCli(['--lang', 'en', '--help'], {
        colorChannels: () => ({ stdout: false, stderr: false }),
        out: (l) => helpOut.push(l),
      }),
    ).toBe(0);
    expect(helpOut.join('\n')).toContain('Usage');

    const langErr: string[] = [];
    expect(
      await runWakeCli(['--lang'], {
        err: (l) => langErr.push(l),
      }),
    ).toBe(1);
    expect(langErr.length).toBeGreaterThan(0);

    const updOut: string[] = [];
    expect(
      await runWakeCli(['update', '--help'], {
        out: (l) => updOut.push(l),
      }),
    ).toBe(0);
    expect(updOut.join('\n')).toContain('WAKE');
  });
});
