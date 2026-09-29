/**
 * npm 启动器冒烟: `bin/sweep-nm.mjs` 挑选运行时后透传参数与退出码。
 * 它是 npm 分发形态的用户入口 (经 bin shim 调用), 与仓库内的 sh / cmd 启动器同职责;
 * 三者逻辑一致, 本测试钉住其中的参数透传与退出码透传两条外部可观测契约。
 *
 * 第二组钉「产物自证」契约 (审计项: 发行面 dist/cli.js 与源码和提交无身份绑定): 启动器只认
 * 「形状版本受支持且与随附清单摘要一致」的产物, 缺失 / 损坏 / 版本不支持 / 不符一律拒收并给
 * 指引; 拒收指引按宿主分流 (检出态给源码入口与重构建, 包态给重装本包); 无产物时回退源码入口
 * 的原有语义不变。该组在临时的包布局上跑 (启动器原样复制进临时根, 造畸形的 dist): 拒绝路径
 * 不能在本仓库的真实 dist 上造, 真实 dist 是正例现场, 也是工作树的一部分。
 * 与之对账的清单形状与摘要算法由 scripts/release-artifact.ts 定义, 本测试直接复用它的写入器,
 * 两侧口径不一致即在此暴露。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_FILE,
  MANIFEST_FILE,
  buildManifest,
  sha256File,
} from '../scripts/release-artifact.ts';

const ROOT = join(import.meta.dir, '..');
const LAUNCHER = join(ROOT, 'bin', 'sweep-nm.mjs');

/** 以当前运行时执行启动器, 断言其对外行为而非内部实现 */
const run = (...args: string[]) =>
  spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8' });

describe('npm 启动器', () => {
  test('透传 --help 且零退出', () => {
    const { status, stdout } = run('--help');

    expect(status).toBe(0);
    expect(stdout).toContain('SWEEP-NM');
  });

  test('非零退出码原样回传 (参数错误退 1, 见行为契约 BC-27)', () => {
    const { status } = run('--definitely-not-a-flag');

    expect(status).toBe(1);
  });
});

interface FakePackage {
  root: string;
  distDir: string;
  cliPath: string;
  launcher: string;
  cleanup: () => void;
}

/** 临时包布局: <root>/bin/sweep-nm.mjs (启动器原样复制) + 空的 <root>/dist/ */
const makePackage = (): FakePackage => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-nm-pkg-')));
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(LAUNCHER, join(root, 'bin', 'sweep-nm.mjs'));
  return {
    root,
    distDir: join(root, 'dist'),
    cliPath: join(root, 'dist', CLI_FILE),
    launcher: join(root, 'bin', 'sweep-nm.mjs'),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** 运行临时包布局里的启动器 (命令入口是复制件, 逻辑即被测文件本体) */
const runPackaged = (pkg: FakePackage, ...args: string[]) =>
  spawnSync(process.execPath, [pkg.launcher, ...args], { encoding: 'utf8' });

/**
 * 造「产物 + 同源清单」: 摘要取产物实测值, 形状走 release-artifact.ts 的写入器;
 * patch 用来造畸形现场 (篡改字段而不动产物)。
 */
const writeArtifact = (
  pkg: FakePackage,
  content: string,
  patch: Record<string, unknown> = {},
): void => {
  writeFileSync(pkg.cliPath, content);
  const manifest = {
    ...buildManifest({
      cliSha256: sha256File(pkg.cliPath),
      git: { commit: null, dirty: null },
      builtAt: '2026-09-26T00:00:00.000Z',
    }),
    ...patch,
  };
  writeFileSync(
    join(pkg.distDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
};

describe('npm 启动器 · 产物自证', () => {
  test('清单与产物同源 → 执行产物, 退出码原样透传', () => {
    const pkg = makePackage();
    try {
      writeArtifact(
        pkg,
        "process.stdout.write('FAKE-DIST\\n');\nprocess.exit(7);\n",
      );

      const { status, stdout } = runPackaged(pkg, '--help');

      expect(status).toBe(7);
      expect(stdout).toContain('FAKE-DIST');
    } finally {
      pkg.cleanup();
    }
  });

  test('清单缺失 → 拒收产物 (退出码 1, 不执行, 给出处置指引)', () => {
    const pkg = makePackage();
    try {
      writeFileSync(pkg.cliPath, "process.stdout.write('FAKE-DIST\\n');\n");

      const { status, stdout, stderr } = runPackaged(pkg);

      expect(status).toBe(1);
      expect(stdout).not.toContain('FAKE-DIST');
      expect(stderr).toContain('缺少产物清单');
      expect(stderr).toContain('重新构建');
      // 包布局无 src/, 即包态: 处置指向重装本包
      expect(stderr).toContain('重装本包');
    } finally {
      pkg.cleanup();
    }
  });

  test('产物被替换 (摘要不符) → 拒收产物', () => {
    const pkg = makePackage();
    try {
      writeArtifact(pkg, "process.stdout.write('FAKE-DIST\\n');\n");
      writeFileSync(pkg.cliPath, "process.stdout.write('SWAPPED\\n');\n");

      const { status, stdout, stderr } = runPackaged(pkg);

      expect(status).toBe(1);
      expect(stdout).not.toContain('SWAPPED');
      expect(stderr).toContain('摘要与清单记录不符');
    } finally {
      pkg.cleanup();
    }
  });

  test('清单损坏 (非 JSON) → 拒收产物', () => {
    const pkg = makePackage();
    try {
      writeArtifact(pkg, "process.stdout.write('FAKE-DIST\\n');\n");
      writeFileSync(join(pkg.distDir, MANIFEST_FILE), 'not json at all');

      const { status, stderr } = runPackaged(pkg);

      expect(status).toBe(1);
      expect(stderr).toContain('损坏');
    } finally {
      pkg.cleanup();
    }
  });

  test('清单缺 cliSha256 字段 → 拒收产物', () => {
    const pkg = makePackage();
    try {
      writeArtifact(pkg, "process.stdout.write('FAKE-DIST\\n');\n", {
        cliSha256: undefined,
      });

      const { status, stderr } = runPackaged(pkg);

      expect(status).toBe(1);
      expect(stderr).toContain('缺少 cliSha256 字段');
    } finally {
      pkg.cleanup();
    }
  });

  test('清单 schemaVersion 缺失 → 拒收产物 (形状版本先对)', () => {
    const pkg = makePackage();
    try {
      writeArtifact(pkg, "process.stdout.write('FAKE-DIST\\n');\n", {
        schemaVersion: undefined,
      });

      const { status, stdout, stderr } = runPackaged(pkg);

      expect(status).toBe(1);
      expect(stdout).not.toContain('FAKE-DIST');
      expect(stderr).toContain('schemaVersion');
    } finally {
      pkg.cleanup();
    }
  });

  test('清单 schemaVersion 异值 (未知形状) → 拒收产物', () => {
    const pkg = makePackage();
    try {
      writeArtifact(pkg, "process.stdout.write('FAKE-DIST\\n');\n", {
        schemaVersion: 2,
      });

      const { status, stdout, stderr } = runPackaged(pkg);

      expect(status).toBe(1);
      expect(stdout).not.toContain('FAKE-DIST');
      expect(stderr).toContain('schemaVersion');
    } finally {
      pkg.cleanup();
    }
  });

  test('拒收指引按宿主分流: 检出态 (有源码) 指源码入口, 不指重装', () => {
    const pkg = makePackage();
    try {
      mkdirSync(join(pkg.root, 'src'), { recursive: true });
      writeFileSync(
        join(pkg.root, 'src', 'cli.ts'),
        "process.stdout.write('FAKE-SRC\\n');\n",
      );
      // 有产物但无清单: 走拒收路径 (无产物才会回退源码)
      writeFileSync(pkg.cliPath, "process.stdout.write('FAKE-DIST\\n');\n");

      const { status, stderr } = runPackaged(pkg);

      expect(status).toBe(1);
      expect(stderr).toContain('缺少产物清单');
      expect(stderr).toContain('源码入口');
      expect(stderr).toContain('重新构建');
      expect(stderr).not.toContain('重装本包');
    } finally {
      pkg.cleanup();
    }
  });

  test('无产物 → 回退源码入口 (原语义不变)', () => {
    const pkg = makePackage();
    try {
      mkdirSync(join(pkg.root, 'src'), { recursive: true });
      writeFileSync(
        join(pkg.root, 'src', 'cli.ts'),
        "process.stdout.write('FAKE-SRC\\n');\n",
      );

      const { status, stdout } = runPackaged(pkg, '--help');

      expect(status).toBe(0);
      expect(stdout).toContain('FAKE-SRC');
    } finally {
      pkg.cleanup();
    }
  });
});
