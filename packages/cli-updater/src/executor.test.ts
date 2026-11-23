/**
 * 升级命令构造、PATH 防劫持解析、Windows npm 直调与 Yarn Berry 拦截单测。
 */
import { describe, expect, test } from 'bun:test';

import {
  buildIsolatedEnv,
  buildUpgradePlan,
  formatUpgradeDisplayCommand,
  isYarnBerryVersion,
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

    // Windows 下 PATH 为空串或纯空白时自动回退到 Path
    for (const empty of ['', '   ']) {
      expect(
        resolveExecutableInPath(
          'bun',
          'win32',
          { PATH: empty, Path: 'C:\\bun' },
          (p) => existing.has(p),
        ),
      ).toEqual({ path: 'C:\\bun\\bun.exe', isBatch: false });
    }
  });
});

describe('resolvePmInvocation Windows npm 直调与 PATH 顺序', () => {
  const nodeDir = 'C:\\Program Files\\nodejs';
  const nodeExe = `${nodeDir}\\node.exe`;
  const npmCmd = `${nodeDir}\\npm.cmd`;
  const npmCli = `${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`;

  test('Windows 下 npm 命中 npm.cmd 时优先直调同目录 node.exe + npm-cli.js 绕开批处理壳层', () => {
    const existing = new Set([nodeExe, npmCmd, npmCli]);
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

  test('Windows 下 resolvePmInvocation("npm") 严守 PATH 顺序, 绝不绕过前位原生 npm.exe 抢跑后位 npm-cli.js', () => {
    const voltaNpmExe = 'C:\\Users\\dev\\.volta\\bin\\npm.exe';
    const existingWithVolta = new Set([voltaNpmExe, nodeExe, npmCmd, npmCli]);
    expect(
      resolvePmInvocation(
        'npm',
        ['install', '-g', 'create-clis@1.2.0'],
        'win32',
        { PATH: `C:\\Users\\dev\\.volta\\bin;${nodeDir}` },
        (p) => existingWithVolta.has(p),
      ),
    ).toEqual({
      command: voltaNpmExe,
      args: ['install', '-g', 'create-clis@1.2.0'],
    });

    // 前位为独立 npm.cmd (同目录无 npm-cli.js) 时同样严守 PATH 顺序走 ComSpec, 不越位抢跑后位 npm-cli.js
    const customCmd = 'C:\\custom-npm\\npm.cmd';
    const existingWithCustomCmd = new Set([customCmd, nodeExe, npmCmd, npmCli]);
    expect(
      resolvePmInvocation(
        'npm',
        ['install', '-g', 'create-clis@1.2.0'],
        'win32',
        {
          PATH: `C:\\custom-npm;${nodeDir}`,
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        },
        (p) => existingWithCustomCmd.has(p),
      ),
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\custom-npm\\npm.cmd" install -g create-clis@1.2.0"',
      ],
      windowsVerbatimArguments: true,
    });

    // 前位 npm.cmd 同目录含 npm-cli.js 但无同目录 node.exe 时, 借助 PATH 中 node.exe 直调前位 npm-cli.js
    const userNpmDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
    const userNpmCmd = `${userNpmDir}\\npm.cmd`;
    const userNpmCli = `${userNpmDir}\\node_modules\\npm\\bin\\npm-cli.js`;
    const existingWithUserNpm = new Set([
      userNpmCmd,
      userNpmCli,
      nodeExe,
      npmCmd,
      npmCli,
    ]);
    expect(
      resolvePmInvocation(
        'npm',
        ['install', '-g', 'create-clis@1.2.0'],
        'win32',
        { PATH: `${userNpmDir};${nodeDir}` },
        (p) => existingWithUserNpm.has(p),
      ),
    ).toEqual({
      command: nodeExe,
      args: [userNpmCli, 'install', '-g', 'create-clis@1.2.0'],
    });
  });
});

describe('resolvePmInvocation 跨平台批处理转义与 JS 入口探测', () => {
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

    // ComSpec 为空串或纯空白时自动回退到 COMSPEC, 两者均空时回退默认 cmd.exe
    const invokeBatch = (env: NodeJS.ProcessEnv) =>
      resolvePmInvocation(
        'pnpm',
        ['add', '-g', 'pkg@1.0.0'],
        'win32',
        env,
        (p) => existing.has(p),
      )?.command;
    expect(
      invokeBatch({
        PATH: 'C:\\pnpm',
        ComSpec: '',
        COMSPEC: 'D:\\Win\\System32\\cmd.exe',
      }),
    ).toBe('D:\\Win\\System32\\cmd.exe');
    expect(invokeBatch({ PATH: 'C:\\pnpm', ComSpec: '   ', COMSPEC: '' })).toBe(
      'cmd.exe',
    );
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
      packageName: '@iyowei/sweep-cli',
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
        '@iyowei/sweep-cli@0.4.0',
        '--registry=https://registry.npmmirror.com',
      ]);
      expect(bunPlan.plan.displayCommand).toBe(
        'bun add -g @iyowei/sweep-cli@0.4.0 --registry=https://registry.npmmirror.com',
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
    const badInputs = [
      { packageName: 'bad;whoami' },
      { packageName: 'create-clis', targetSpec: '1.0.0 && id' },
      { packageName: 'create-clis', explicitRegistry: 'file:///etc/passwd' },
    ];
    for (const extra of badInputs) {
      expect(
        buildUpgradePlan({
          pm: 'npm',
          platform: 'linux',
          env: posixEnv,
          isFile: allPosix,
          ...extra,
        }).ok,
      ).toBe(false);
    }
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
