/**
 * 全包管理器 + 跨平台安装源探测单测 (macOS / Linux / Windows 路径矩阵)。
 */
import { describe, expect, test } from 'bun:test';

import {
  type EphemeralRunner,
  type PackageManager,
  detectInstallOriginFromPath,
  isWithinDir,
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

  test('临时一次性运行器: npx / bunx / pnpm dlx / yarn dlx', () => {
    const cases: readonly (readonly [string, EphemeralRunner])[] = [
      [
        '/Users/dev/.npm/_npx/ab12cd/node_modules/@iyowei/sweep-node-modules-cli',
        'npx',
      ],
      [
        'C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\123\\node_modules\\create-clis',
        'npx',
      ],
      [
        '/tmp/bunx-501-@iyowei/sweep-node-modules-cli@0.3.0/node_modules/@iyowei/sweep-node-modules-cli',
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
      [
        '/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-node-modules-cli',
        'bun',
      ],
      [
        'C:\\Users\\dev\\.bun\\install\\global\\node_modules\\@iyowei\\sweep-node-modules-cli',
        'bun',
      ],
      [
        '/Users/dev/Library/pnpm/global/5/.pnpm/@iyowei+sweep@0.3.0/node_modules/@iyowei/sweep-node-modules-cli',
        'pnpm',
      ],
      ['/home/dev/.local/share/pnpm/global/5/node_modules/create-clis', 'pnpm'],
      [
        'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\create-clis',
        'pnpm',
      ],
      [
        '/Users/dev/.config/yarn/global/node_modules/@iyowei/sweep-node-modules-cli',
        'yarn',
      ],
      [
        'C:\\Users\\dev\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\create-clis',
        'yarn',
      ],
      [
        '/Users/dev/.volta/tools/image/packages/@iyowei/sweep-node-modules-cli/lib/node_modules/@iyowei/sweep-node-modules-cli',
        'volta',
      ],
      [
        'C:\\Users\\dev\\AppData\\Local\\Volta\\tools\\image\\packages\\create-clis\\node_modules\\create-clis',
        'volta',
      ],
      ['/usr/local/lib/node_modules/@iyowei/sweep-node-modules-cli', 'npm'],
      ['/opt/homebrew/lib/node_modules/@iyowei/sweep-node-modules-cli', 'npm'],
      [
        '/Users/dev/.nvm/versions/node/v22.18.0/lib/node_modules/@iyowei/sweep-node-modules-cli',
        'npm',
      ],
      [
        '/Users/dev/.local/share/mise/installs/node/22.18.0/lib/node_modules/create-clis',
        'npm',
      ],
      [
        'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@iyowei\\sweep-node-modules-cli',
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
  });

  test('动态实查全局根目录兜底: 自定义 pnpm/npm 全局目录即便含 package.json 也不误判成项目依赖', () => {
    const customPnpm =
      '/srv/custom-global/5/node_modules/@iyowei/sweep-node-modules-cli';
    const origin = detectInstallOriginFromPath({
      packageRoot: customPnpm,
      env: {},
      pathExists: (p) => p.endsWith('/srv/custom-global/5/package.json'),
      globalRoots: { pnpm: '/srv/custom-global/5/node_modules' },
    });
    expect(origin).toMatchObject({ kind: 'global', pm: 'pnpm' });
  });

  test('项目本地依赖按锁文件识别推荐包管理器', () => {
    const proj = '/Users/dev/my-app';
    const pkgRoot = `${proj}/node_modules/@iyowei/sweep-node-modules-cli`;
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
});
