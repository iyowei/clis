/**
 * `executeUpgradePlan` 与 `probeGlobalRoots` 隔离与跨平台路径透传单测
 * (与 executor.test.ts 分文件承载以守 max-lines 门禁)。
 */
import { describe, expect, test } from 'bun:test';

import { type SpawnSyncReturns } from 'node:child_process';

import {
  type SpawnLike,
  executeUpgradePlan,
  probeGlobalRoots,
} from './executor.ts';

describe('executeUpgradePlan 与 probeGlobalRoots 隔离与透传', () => {
  const spawnRes = (
    stdout: string,
    status: number | null = stdout === '' ? 1 : 0,
    signal: NodeJS.Signals | null = null,
  ) =>
    ({
      pid: 1,
      output: [null, stdout, ''],
      stdout,
      stderr: '',
      status,
      signal,
    }) as SpawnSyncReturns<string>;

  test('executeUpgradePlan 透传 windowsVerbatimArguments 并保留子进程终止 signal', () => {
    let seenVerbatim: boolean | undefined;
    const mockSpawn: SpawnLike = (_cmd, _args, opts) => {
      seenVerbatim = opts.windowsVerbatimArguments;
      return spawnRes('', null, 'SIGINT');
    };

    const res = executeUpgradePlan(
      {
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: [
          '/d',
          '/s',
          '/c',
          '""C:\\pnpm\\pnpm.cmd" add -g create-clis@1.0.0"',
        ],
        displayCommand: 'pnpm add -g create-clis@1.0.0',
        windowsVerbatimArguments: true,
      },
      { PATH: 'C:\\pnpm' },
      mockSpawn,
    );
    expect(seenVerbatim).toBe(true);
    expect(res.status).toBeNull();
    expect(res.signal).toBe('SIGINT');
  });

  test('probeGlobalRoots 复用单一临时目录、注 COREPACK_ENABLE_DOWNLOAD_PROMPT=0、透传 verbatim 并读 bunfig globalDir', () => {
    const seenCwds = new Set<string>();
    const seenCorepack: (string | undefined)[] = [];
    const seenVerbatim: (boolean | undefined)[] = [];

    const probeReplies: readonly (readonly [string, string, string])[] = [
      ['pnpm.cmd', 'root -g', 'C:\\custom\\pnpm\\global\n'],
      ['yarn.cmd', '--version', '1.22.22\n'],
      ['yarn.cmd', 'global dir', 'C:\\custom\\yarn\\global\n'],
    ];
    const mockSpawn: SpawnLike = (_cmd, args, opts) => {
      if (opts.cwd !== undefined) seenCwds.add(opts.cwd);
      seenCorepack.push(opts.env?.COREPACK_ENABLE_DOWNLOAD_PROMPT);
      seenVerbatim.push(opts.windowsVerbatimArguments);
      const joined = args.join(' ');
      const stdout =
        probeReplies.find(
          ([a, b]) => joined.includes(a) && joined.includes(b),
        )?.[2] ?? '';
      return spawnRes(stdout);
    };

    const files = new Set(['C:\\tools\\pnpm.cmd', 'C:\\tools\\yarn.cmd']);
    const existingDirs = new Set([
      'C:\\custom\\pnpm\\global',
      'C:\\custom\\yarn\\global',
      'C:\\Users\\dev\\.custom-bun\\global',
    ]);
    const bunfig = '[install]\nglobalDir = "~/.custom-bun/global"\n';
    const roots = probeGlobalRoots(
      'win32',
      { PATH: 'C:\\tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      mockSpawn,
      {
        homeDir: 'C:\\Users\\dev',
        readText: (p) => (p === 'C:\\Users\\dev\\.bunfig.toml' ? bunfig : null),
        pathExists: (p) => existingDirs.has(p),
        isFile: (p) => files.has(p),
      },
    );

    expect(seenCwds.size).toBe(1);
    expect(seenCorepack.length).toBeGreaterThanOrEqual(3);
    expect(seenCorepack.every((v) => v === '0')).toBe(true);
    expect(seenVerbatim.every((v) => v === true)).toBe(true);
    expect(roots).toMatchObject({
      pnpm: 'C:\\custom\\pnpm\\global',
      yarn: 'C:\\custom\\yarn\\global',
      bun: 'C:\\Users\\dev\\.custom-bun\\global',
    });

    // POSIX 平台按 POSIX 分隔符展开 ~ 路径 (在 Windows 宿主上亦严格产出 /)
    const posixRoots = probeGlobalRoots('darwin', {}, mockSpawn, {
      homeDir: '/home/dev',
      readText: (p) => (p === '/home/dev/.bunfig.toml' ? bunfig : null),
      pathExists: (p) => p === '/home/dev/.custom-bun/global',
      isFile: () => false,
    });
    expect(posixRoots.bun).toBe('/home/dev/.custom-bun/global');
  });
});
