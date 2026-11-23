/**
 * 全包管理器 + 跨平台安装源探测单测 (macOS / Linux / Windows 路径矩阵)。
 */
import { describe, expect, test } from 'bun:test';

import {
  type EphemeralRunner,
  type PackageManager,
  detectInstallOriginFromPath,
  isWithinDir,
  safeRealpath,
} from './detect.ts';

describe('isWithinDir 路径边界判定', () => {
  test('按目录边界匹配, 拒绝同名兄弟前缀误伤', () => {
    expect(isWithinDir('/opt/bun/install/global/pkg', '/opt/bun')).toBe(true);
    expect(isWithinDir('/opt/bun-other/pkg', '/opt/bun')).toBe(false);
    expect(
      isWithinDir(
        'C:\\Users\\Dev\\.bun\\install\\global\\pkg',
        'c:/users/dev/.bun',
      ),
    ).toBe(true);
  });
});

describe('detectInstallOriginFromPath 跨包管理器与 OS 矩阵', () => {
  const noFiles = (): boolean => false;

  test('本地源码开发态 (含 ~/.local/bin 软链与 bun/npm link) 优先于全局目录判定', () => {
    const repoPkg = '/Users/dev/clis/packages/codd-cli';
    const origin = detectInstallOriginFromPath({
      packageRoot: repoPkg,
      rawPaths: [
        '/Users/dev/.bun/install/global/node_modules/@iyowei/codd-cli',
      ],
      env: {},
      pathExists: (p) => p.endsWith('src/cli.ts') || p.endsWith('src\\cli.ts'),
    });
    expect(origin.kind).toBe('source');
  });

  test('临时一次性运行器: npx / bunx / pnpm dlx / yarn dlx / deno', () => {
    const cases: readonly (readonly [string, EphemeralRunner])[] = [
      ['/Users/dev/.npm/_npx/ab12cd/node_modules/@iyowei/sweep-cli', 'npx'],
      [
        'C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\123\\node_modules\\create-clis',
        'npx',
      ],
      [
        '/tmp/bunx-501-@iyowei/sweep-cli@0.3.0/node_modules/@iyowei/sweep-cli',
        'bunx',
      ],
      [
        '/Users/dev/Library/Caches/pnpm/dlx/abcdef/node_modules/create-clis',
        'pnpm-dlx',
      ],
      [
        'C:\\Users\\dev\\AppData\\Local\\pnpm-cache\\dlx\\xyz\\node_modules\\create-clis',
        'pnpm-dlx',
      ],
      ['/tmp/xfs-8a1b/dlx-1234/node_modules/create-clis', 'yarn-dlx'],
      [
        '/Users/dev/Library/Caches/deno/npm/registry.npmjs.org/create-clis/1.0.0',
        'deno',
      ],
      [
        'C:\\Users\\dev\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\create-clis\\1.0.0',
        'deno',
      ],
    ];
    for (const [pkgRoot, expectedRunner] of cases) {
      const origin = detectInstallOriginFromPath({
        packageRoot: pkgRoot,
        env: {},
        pathExists: noFiles,
      });
      expect(origin.kind).toBe('ephemeral');
      if (origin.kind === 'ephemeral') {
        expect(origin.runner).toBe(expectedRunner);
      }
    }
  });

  test('五大全局包管理器标准路径 (macOS / Linux / Windows)', () => {
    const cases: readonly (readonly [string, PackageManager])[] = [
      ['/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-cli', 'bun'],
      [
        'C:\\Users\\dev\\.bun\\install\\global\\node_modules\\@iyowei\\sweep-cli',
        'bun',
      ],
      [
        '/Users/dev/Library/pnpm/global/5/.pnpm/@iyowei+sweep@0.3.0/node_modules/@iyowei/sweep-cli',
        'pnpm',
      ],
      ['/home/dev/.local/share/pnpm/global/5/node_modules/create-clis', 'pnpm'],
      [
        'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\create-clis',
        'pnpm',
      ],
      ['/Users/dev/.config/yarn/global/node_modules/@iyowei/sweep-cli', 'yarn'],
      [
        'C:\\Users\\dev\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\create-clis',
        'yarn',
      ],
      [
        '/Users/dev/.volta/tools/image/packages/@iyowei/sweep-cli/lib/node_modules/@iyowei/sweep-cli',
        'volta',
      ],
      [
        'C:\\Users\\dev\\AppData\\Local\\Volta\\tools\\image\\packages\\create-clis\\node_modules\\create-clis',
        'volta',
      ],
      ['/usr/local/lib/node_modules/@iyowei/sweep-cli', 'npm'],
      ['/opt/homebrew/lib/node_modules/@iyowei/sweep-cli', 'npm'],
      [
        '/Users/dev/.nvm/versions/node/v22.18.0/lib/node_modules/@iyowei/sweep-cli',
        'npm',
      ],
      [
        '/Users/dev/.local/share/mise/installs/node/22.18.0/lib/node_modules/create-clis',
        'npm',
      ],
      [
        'C:\\Users\\dev\\AppData\\Local\\mise\\installs\\node\\22.18.0\\node_modules\\create-clis',
        'npm',
      ],
      [
        'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@iyowei\\sweep-cli',
        'npm',
      ],
      ['C:\\Program Files\\nodejs\\node_modules\\create-clis', 'npm'],
    ];

    for (const [pkgRoot, expectedPm] of cases) {
      const origin = detectInstallOriginFromPath({
        packageRoot: pkgRoot,
        env: {},
        pathExists: noFiles,
      });
      expect(origin.kind, `path=${pkgRoot}`).toBe('global');
      if (origin.kind === 'global') {
        expect(origin.pm, `path=${pkgRoot}`).toBe(expectedPm);
      }
    }
  });

  test('支持显式环境变量自定义全局目录 (BUN_INSTALL / PNPM_HOME / VOLTA_HOME / NPM_CONFIG_PREFIX)', () => {
    expect(
      detectInstallOriginFromPath({
        packageRoot: '/data/my-bun/install/global/node_modules/create-clis',
        env: { BUN_INSTALL: '/data/my-bun' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'bun' });

    expect(
      detectInstallOriginFromPath({
        packageRoot: '/data/my-pnpm/global/5/node_modules/create-clis',
        env: { PNPM_HOME: '/data/my-pnpm' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'pnpm' });

    expect(
      detectInstallOriginFromPath({
        packageRoot: '/data/my-npm/lib/node_modules/create-clis',
        env: { NPM_CONFIG_PREFIX: '/data/my-npm' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'npm' });

    // NPM_CONFIG_PREFIX 为空串或纯空白时自动回退到小写 npm_config_prefix
    expect(
      detectInstallOriginFromPath({
        packageRoot: '/data/lower-npm/lib/node_modules/create-clis',
        env: { NPM_CONFIG_PREFIX: '', npm_config_prefix: '/data/lower-npm' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'npm' });
    expect(
      detectInstallOriginFromPath({
        packageRoot: '/data/trim-npm/lib/node_modules/create-clis',
        env: { NPM_CONFIG_PREFIX: '   ', npm_config_prefix: '/data/trim-npm' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'npm' });
  });

  test('动态实查全局根目录兜底: 自定义 pnpm/npm 全局目录即便含 package.json 也不误判成项目依赖', () => {
    const customPnpm = '/srv/custom-global/5/node_modules/@iyowei/sweep-cli';
    const origin = detectInstallOriginFromPath({
      packageRoot: customPnpm,
      env: {},
      pathExists: (p) => p.endsWith('/srv/custom-global/5/package.json'),
      globalRoots: { pnpm: '/srv/custom-global/5/node_modules' },
    });
    expect(origin).toMatchObject({ kind: 'global', pm: 'pnpm' });
  });
});

describe('detectInstallOriginFromPath 本地项目与防误判回归', () => {
  const noFiles = (): boolean => false;

  test('项目本地依赖按锁文件识别推荐包管理器', () => {
    const proj = '/Users/dev/my-app';
    const pkgRoot = `${proj}/node_modules/@iyowei/sweep-cli`;
    const withFiles =
      (names: string[]) =>
      (p: string): boolean =>
        names.some((n) => p.endsWith(`/${n}`) || p.endsWith(`\\${n}`));

    expect(
      detectInstallOriginFromPath({
        packageRoot: pkgRoot,
        env: {},
        pathExists: withFiles(['package.json', 'bun.lock']),
      }),
    ).toMatchObject({
      kind: 'local-project',
      projectDir: proj,
      suggestedPm: 'bun',
    });

    expect(
      detectInstallOriginFromPath({
        packageRoot: pkgRoot,
        env: {},
        pathExists: withFiles(['package.json', 'pnpm-lock.yaml']),
      }),
    ).toMatchObject({ kind: 'local-project', suggestedPm: 'pnpm' });

    expect(
      detectInstallOriginFromPath({
        packageRoot: pkgRoot,
        env: {},
        pathExists: withFiles(['package.json', 'yarn.lock']),
      }),
    ).toMatchObject({ kind: 'local-project', suggestedPm: 'yarn' });
  });

  test('非标准未知安装位置安全降级为 unknown', () => {
    const origin = detectInstallOriginFromPath({
      packageRoot: '/opt/vendor/custom-bundle/cli',
      env: {},
      pathExists: noFiles,
    });
    expect(origin.kind).toBe('unknown');
  });

  test('NPM_CONFIG_PREFIX=$HOME/.local 收紧至 (lib/)?node_modules, 不再抢跑 ~/.local/share/pnpm', () => {
    const pnpmPkg =
      '/home/dev/.local/share/pnpm/global/5/node_modules/@iyowei/sweep-cli';
    expect(
      detectInstallOriginFromPath({
        packageRoot: pnpmPkg,
        env: { NPM_CONFIG_PREFIX: '/home/dev/.local' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'pnpm' });

    expect(
      detectInstallOriginFromPath({
        packageRoot: '/home/dev/.local/lib/node_modules/create-clis',
        env: { NPM_CONFIG_PREFIX: '/home/dev/.local' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'npm' });

    expect(
      detectInstallOriginFromPath({
        packageRoot: 'C:\\Users\\dev\\.local\\node_modules\\create-clis',
        env: { NPM_CONFIG_PREFIX: 'C:\\Users\\dev\\.local' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'npm' });
  });

  test('高可信 packageRoot 优先于低可信 rawPaths / argv[1], 不被 shim 路径覆盖', () => {
    const npmRoot = '/opt/homebrew/lib/node_modules/@iyowei/sweep-cli';
    expect(
      detectInstallOriginFromPath({
        packageRoot: npmRoot,
        rawPaths: ['/Users/dev/.volta/bin/sweep'],
        env: { VOLTA_HOME: '/Users/dev/.volta' },
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'npm' });

    // 当 packageRoot 自身无特征命中时, 仍回退至 rawPaths 保留 shim 线索
    expect(
      detectInstallOriginFromPath({
        packageRoot: '/opt/cas-store/abc123/pkg',
        rawPaths: ['/Users/dev/.volta/tools/image/packages/create-clis'],
        env: {},
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'volta' });
  });

  test('<prefix>/lib/node_modules 启发式位于动态实查 globalRoots 之后', () => {
    const customDir = '/srv/custom/lib/node_modules/create-clis';
    expect(
      detectInstallOriginFromPath({
        packageRoot: customDir,
        env: {},
        pathExists: noFiles,
        globalRoots: { pnpm: '/srv/custom/lib/node_modules' },
      }),
    ).toMatchObject({ kind: 'global', pm: 'pnpm' });

    // 未提供动态实查结果时仍保留 <prefix>/lib/node_modules 兜底
    expect(
      detectInstallOriginFromPath({
        packageRoot: customDir,
        env: {},
        pathExists: noFiles,
      }),
    ).toMatchObject({ kind: 'global', pm: 'npm' });
  });

  test('环境变量根同时匹配原值与 realpath (兼容 Windows 8.3 短路径 RUNNER~1)', () => {
    const origin = detectInstallOriginFromPath({
      packageRoot:
        'C:\\Users\\runneradmin\\.bun\\install\\global\\node_modules\\create-clis',
      env: { BUN_INSTALL: 'C:\\Users\\RUNNER~1\\.bun' },
      pathExists: noFiles,
      realpath: (p) =>
        p === 'C:\\Users\\RUNNER~1\\.bun' ? 'C:\\Users\\runneradmin\\.bun' : p,
    });
    expect(origin).toMatchObject({ kind: 'global', pm: 'bun' });

    expect(safeRealpath('/non-existent-path-for-cli-updater-test')).toBe(
      '/non-existent-path-for-cli-updater-test',
    );
  });
});
