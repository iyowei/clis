/**
 * 升级命令构造、PATH 防劫持解析、Windows npm 直调与 Yarn Berry 拦截单测。
 */
import { describe, expect, test } from 'bun:test';

import { type SpawnSyncReturns } from 'node:child_process';

import {
  type SpawnLike,
  buildIsolatedEnv,
  buildUpgradePlan,
  executeUpgradePlan,
  formatUpgradeDisplayCommand,
  isYarnBerryVersion,
  probeGlobalRoots,
  resolveExecutableInPath,
  resolvePmInvocation,
} from './executor.ts';

describe('resolveExecutableInPath 防当前目录劫持', () => {
  test('POSIX 跳过相对与空 PATH 条目, 仅解析绝对目录', () => {
    const existing = new Set(['./bun', '/usr/local/bin/bun']);
    const found = resolveExecutableInPath(
      'bun',
      'darwin',
      { PATH: ':.:./bin:/usr/local/bin' },
      (p) => existing.has(p),
    );
    expect(found).toEqual({ path: '/usr/local/bin/bun', isBatch: false });
  });

  test('Windows 优先原生 .exe, 其次 .cmd 批处理, 跳过相对路径', () => {
    const existing = new Set(['C:\\tools\\pnpm.cmd', 'C:\\bun\\bun.exe']);
    expect(
      resolveExecutableInPath('bun', 'win32', { Path: '.;"C:\\bun"' }, (p) =>
        existing.has(p),
      ),
    ).toEqual({ path: 'C:\\bun\\bun.exe', isBatch: false });

    expect(
      resolveExecutableInPath('pnpm', 'win32', { PATH: 'C:\\tools' }, (p) =>
        existing.has(p),
      ),
    ).toEqual({ path: 'C:\\tools\\pnpm.cmd', isBatch: true });
  });
});

describe('resolvePmInvocation 跨平台调用构造', () => {
  test('Windows 下 npm 优先直调 node.exe + npm-cli.js 绕开 npm.cmd 壳层', () => {
    const nodeDir = 'C:\\Program Files\\nodejs';
    const nodeExe = `${nodeDir}\\node.exe`;
    const npmCli = `${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`;
    const existing = new Set([nodeExe, npmCli]);
    const inv = resolvePmInvocation(
      'npm',
      ['install', '-g', 'create-clis@1.1.0'],
      'win32',
      { PATH: nodeDir },
      (p) => existing.has(p),
    );
    expect(inv).toEqual({
      command: nodeExe,
      args: [npmCli, 'install', '-g', 'create-clis@1.1.0'],
    });
  });

  test('Windows 下 .cmd 批处理走 ComSpec /d /s /c 单串转义并启用 windowsVerbatimArguments', () => {
    const existing = new Set(['C:\\pnpm\\pnpm.cmd']);
    const inv = resolvePmInvocation(
      'pnpm',
      ['add', '-g', 'create-clis@1.1.0'],
      'win32',
      { PATH: 'C:\\pnpm', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      (p) => existing.has(p),
    );
    expect(inv).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\pnpm\\pnpm.cmd" add -g create-clis@1.1.0"',
      ],
      windowsVerbatimArguments: true,
    });
  });

  test('Windows .cmd 含空格/括号/&/% 路径及 cmd 元字符参数安全转义, 拒绝引号与换行注入', () => {
    const spacesPath = 'C:\\Program Files (x86)\\Yarn\\bin\\yarn.cmd';
    const invSpaces = resolvePmInvocation(
      'yarn',
      ['global', 'add', 'create-clis@1.2.0'],
      'win32',
      {
        PATH: 'C:\\Program Files (x86)\\Yarn\\bin',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      (p) => p === spacesPath,
    );
    expect(invSpaces).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files (x86)\\Yarn\\bin\\yarn.cmd" global add create-clis@1.2.0"',
      ],
      windowsVerbatimArguments: true,
    });

    const ampPath = 'C:\\R&D\\Tools (x64)\\pnpm.cmd';
    const invAmp = resolvePmInvocation(
      'pnpm',
      ['add', '-g', 'a&b|c(1)', '%PATH%'],
      'win32',
      {
        PATH: 'C:\\R&D\\Tools (x64)',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      (p) => p === ampPath,
    );
    expect(invAmp).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\R&D\\Tools (x64)\\pnpm.cmd" add -g "a&b|c(1)" ^^^%"PATH"^^^%"',
      ],
      windowsVerbatimArguments: true,
    });

    const pctPath = 'C:\\100%dev\\pnpm.cmd';
    const invPct = resolvePmInvocation(
      'pnpm',
      ['--version'],
      'win32',
      { PATH: 'C:\\100%dev', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      (p) => p === pctPath,
    );
    expect(invPct?.windowsVerbatimArguments).toBe(true);
    expect(invPct?.args[3]).toBe('""C:\\100"^%"dev\\pnpm.cmd" --version"');

    // 含双引号或换行的注入参数直接安全拒绝
    expect(
      resolvePmInvocation(
        'pnpm',
        ['add', 'bad" & calc'],
        'win32',
        { PATH: 'C:\\pnpm' },
        (p) => p === 'C:\\pnpm\\pnpm.cmd',
      ),
    ).toBeNull();
    expect(
      resolvePmInvocation(
        'pnpm',
        ['add', 'bad\ncalc'],
        'win32',
        { PATH: 'C:\\pnpm' },
        (p) => p === 'C:\\pnpm\\pnpm.cmd',
      ),
    ).toBeNull();
  });

  test('Windows 下 pnpm.cmd / yarn.cmd 优先探测并直调 node.exe + JS 入口, 且拒 /usr/bin 假绝对 PATH', () => {
    const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
    const pnpmCmd = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\pnpm.cmd';
    const pnpmCjs =
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs';
    const existingPnpm = new Set([nodeExe, pnpmCmd, pnpmCjs]);
    expect(
      resolvePmInvocation(
        'pnpm',
        ['add', '-g', 'create-clis@1.2.0'],
        'win32',
        {
          PATH: '/usr/bin;C:\\Users\\dev\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs',
        },
        (p) => existingPnpm.has(p),
      ),
    ).toEqual({
      command: nodeExe,
      args: [pnpmCjs, 'add', '-g', 'create-clis@1.2.0'],
    });

    const yarnCmd = 'C:\\Program Files (x86)\\Yarn\\bin\\yarn.cmd';
    const yarnJs = 'C:\\Program Files (x86)\\Yarn\\bin\\yarn.js';
    const existingYarn = new Set([nodeExe, yarnCmd, yarnJs]);
    expect(
      resolvePmInvocation(
        'yarn',
        ['global', 'add', 'create-clis@1.2.0'],
        'win32',
        {
          PATH: 'C:\\Program Files (x86)\\Yarn\\bin;C:\\Program Files\\nodejs',
        },
        (p) => existingYarn.has(p),
      ),
    ).toEqual({
      command: nodeExe,
      args: [yarnJs, 'global', 'add', 'create-clis@1.2.0'],
    });

    // Windows 拒绝 Git Bash 盘根相对 PATH (/usr/bin)
    expect(
      resolveExecutableInPath('bun', 'win32', { PATH: '/usr/bin' }, () => true),
    ).toBeNull();
  });
});

describe('buildUpgradePlan 五大包管理器与安全拦截', () => {
  const posixEnv = { PATH: '/usr/local/bin' };
  const allPosix = (p: string): boolean => p.startsWith('/usr/local/bin/');

  test('bun / npm / pnpm / yarn v1 / volta 分别产出精确升级命令与可选 --registry', () => {
    const bunPlan = buildUpgradePlan({
      pm: 'bun',
      packageName: '@iyowei/sweep-node-modules-cli',
      targetSpec: '0.4.0',
      explicitRegistry: 'https://registry.npmmirror.com/',
      platform: 'darwin',
      env: posixEnv,
      isFile: allPosix,
    });
    expect(bunPlan.ok).toBe(true);
    if (bunPlan.ok) {
      expect(bunPlan.plan.args).toEqual([
        'add',
        '-g',
        '@iyowei/sweep-node-modules-cli@0.4.0',
        '--registry=https://registry.npmmirror.com',
      ]);
      expect(bunPlan.plan.displayCommand).toBe(
        'bun add -g @iyowei/sweep-node-modules-cli@0.4.0 --registry=https://registry.npmmirror.com',
      );
    }

    const npmPlan = buildUpgradePlan({
      pm: 'npm',
      packageName: 'create-clis',
      targetSpec: '1.2.0',
      platform: 'linux',
      env: posixEnv,
      isFile: allPosix,
    });
    expect(npmPlan.ok).toBe(true);
    if (npmPlan.ok) {
      expect(npmPlan.plan.args).toEqual(['install', '-g', 'create-clis@1.2.0']);
    }

    const pnpmPlan = buildUpgradePlan({
      pm: 'pnpm',
      packageName: 'create-clis',
      targetSpec: '1.2.0',
      platform: 'linux',
      env: posixEnv,
      isFile: allPosix,
    });
    expect(pnpmPlan.ok && pnpmPlan.plan.args).toEqual([
      'add',
      '-g',
      'create-clis@1.2.0',
    ]);

    const yarnPlan = buildUpgradePlan({
      pm: 'yarn',
      packageName: 'create-clis',
      targetSpec: '1.2.0',
      yarnVersion: '1.22.22',
      platform: 'linux',
      env: posixEnv,
      isFile: allPosix,
    });
    expect(yarnPlan.ok && yarnPlan.plan.args).toEqual([
      'global',
      'add',
      'create-clis@1.2.0',
    ]);

    const voltaPlan = buildUpgradePlan({
      pm: 'volta',
      packageName: 'create-clis',
      targetSpec: '1.2.0',
      platform: 'linux',
      env: posixEnv,
      isFile: allPosix,
    });
    expect(voltaPlan.ok && voltaPlan.plan.args).toEqual([
      'install',
      'create-clis@1.2.0',
    ]);
  });

  test('Yarn v2+ (Berry) 明确前置拦截并提示切换管理器', () => {
    expect(isYarnBerryVersion('4.5.0')).toBe(true);
    expect(isYarnBerryVersion('1.22.22')).toBe(false);

    const plan = buildUpgradePlan({
      pm: 'yarn',
      packageName: 'create-clis',
      targetSpec: '1.2.0',
      yarnVersion: '4.5.0',
      platform: 'darwin',
      env: posixEnv,
      isFile: allPosix,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('Berry');
  });

  test('缺失对应包管理器二进制时报错并给出手动复制命令', () => {
    const plan = buildUpgradePlan({
      pm: 'pnpm',
      packageName: 'create-clis',
      targetSpec: '1.2.0',
      platform: 'darwin',
      env: posixEnv,
      isFile: () => false,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.fallbackCommand).toBe('pnpm add -g create-clis@1.2.0');
    }
  });

  test('恶意包名、非法版本标签与非法 registry 一律拦截', () => {
    expect(
      buildUpgradePlan({
        pm: 'npm',
        packageName: 'bad;whoami',
        platform: 'linux',
        env: posixEnv,
        isFile: allPosix,
      }).ok,
    ).toBe(false);
    expect(
      buildUpgradePlan({
        pm: 'npm',
        packageName: 'create-clis',
        targetSpec: '1.0.0 && id',
        platform: 'linux',
        env: posixEnv,
        isFile: allPosix,
      }).ok,
    ).toBe(false);
    expect(
      buildUpgradePlan({
        pm: 'npm',
        packageName: 'create-clis',
        explicitRegistry: 'file:///etc/passwd',
        platform: 'linux',
        env: posixEnv,
        isFile: allPosix,
      }).ok,
    ).toBe(false);
  });

  test('buildIsolatedEnv 剥离宿主 npm 生命周期污染变量并应用覆盖', () => {
    const env = buildIsolatedEnv(
      {
        PATH: '/usr/bin',
        npm_execpath: '/old/npm',
        npm_lifecycle_event: 'start',
        INIT_CWD: '/dirty/dir',
      },
      { npm_config_registry: 'https://registry.npmmirror.com' },
    );
    expect(env.npm_execpath).toBeUndefined();
    expect(env.npm_lifecycle_event).toBeUndefined();
    expect(env.INIT_CWD).toBeUndefined();
    expect(env.npm_config_registry).toBe('https://registry.npmmirror.com');
    expect(formatUpgradeDisplayCommand('volta', 'create-clis', '1.0.0')).toBe(
      'volta install create-clis@1.0.0',
    );
    expect(
      formatUpgradeDisplayCommand(
        'volta',
        'create-clis',
        '1.0.0',
        'https://registry.npmmirror.com/',
      ),
    ).toBe(
      'NPM_CONFIG_REGISTRY=https://registry.npmmirror.com volta install create-clis@1.0.0',
    );
  });
});

describe('executeUpgradePlan 与 probeGlobalRoots 隔离与透传', () => {
  test('executeUpgradePlan 透传 windowsVerbatimArguments 并保留子进程终止 signal', () => {
    let seenVerbatim: boolean | undefined;
    const mockSpawn: SpawnLike = (_cmd, _args, opts) => {
      seenVerbatim = opts.windowsVerbatimArguments;
      return {
        pid: 123,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        status: null,
        signal: 'SIGINT',
      } as SpawnSyncReturns<string>;
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

    const mockSpawn: SpawnLike = (_cmd, args, opts) => {
      if (opts.cwd !== undefined) seenCwds.add(opts.cwd);
      seenCorepack.push(opts.env?.COREPACK_ENABLE_DOWNLOAD_PROMPT);
      seenVerbatim.push(opts.windowsVerbatimArguments);
      const joined = args.join(' ');
      let stdout = '';
      if (joined.includes('pnpm.cmd') && joined.includes('root -g')) {
        stdout = 'C:\\custom\\pnpm\\global\n';
      } else if (joined.includes('yarn.cmd') && joined.includes('--version')) {
        stdout = '1.22.22\n';
      } else if (joined.includes('yarn.cmd') && joined.includes('global dir')) {
        stdout = 'C:\\custom\\yarn\\global\n';
      }
      return {
        pid: 1,
        output: [null, stdout, ''],
        stdout,
        stderr: '',
        status: stdout === '' ? 1 : 0,
        signal: null,
      } as SpawnSyncReturns<string>;
    };

    const files = new Set(['C:\\tools\\pnpm.cmd', 'C:\\tools\\yarn.cmd']);
    const existingDirs = new Set([
      'C:\\custom\\pnpm\\global',
      'C:\\custom\\yarn\\global',
      '/home/dev/.custom-bun/global',
    ]);

    const roots = probeGlobalRoots(
      'win32',
      { PATH: 'C:\\tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      mockSpawn,
      {
        homeDir: '/home/dev',
        readText: (p) =>
          p.endsWith('.bunfig.toml')
            ? '[install]\nglobalDir = "~/.custom-bun/global"\n'
            : null,
        pathExists: (p) =>
          existingDirs.has(p.replaceAll('\\', '/')) || existingDirs.has(p),
        isFile: (p) => files.has(p),
      },
    );

    expect(seenCwds.size).toBe(1);
    expect(seenCorepack.length).toBeGreaterThanOrEqual(3);
    expect(seenCorepack.every((v) => v === '0')).toBe(true);
    expect(seenVerbatim.every((v) => v === true)).toBe(true);
    expect(roots.pnpm).toBe('C:\\custom\\pnpm\\global');
    expect(roots.yarn).toBe('C:\\custom\\yarn\\global');
    expect(roots.bun).toBe('/home/dev/.custom-bun/global');
  });
});
