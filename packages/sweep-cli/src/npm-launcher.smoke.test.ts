/**
 * npm 启动器冒烟: `bin/sweep.mjs` 挑选运行时后透传参数与退出码。
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
const LAUNCHER = join(ROOT, 'bin', 'sweep.mjs');

/** 以当前运行时执行启动器, 断言其对外行为而非内部实现 */
const run = (...args: string[]) =>
  spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8' });

describe('npm 启动器', () => {
  test('透传 --help 且零退出', () => {
    const { status, stdout } = run('--help');

    expect(status).toBe(0);
    expect(stdout).toContain('▍ SWEEP');
    expect(stdout).not.toMatch(/sweep-nm/i);
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

/** 临时包布局: <root>/bin/sweep.mjs + bin/bunfig.toml (启动器原样复制) + 空的 <root>/dist/ */
const makePackage = (): FakePackage => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-pkg-')));
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(LAUNCHER, join(root, 'bin', 'sweep.mjs'));
  copyFileSync(
    join(ROOT, 'bin', 'bunfig.toml'),
    join(root, 'bin', 'bunfig.toml'),
  );
  return {
    root,
    distDir: join(root, 'dist'),
    cliPath: join(root, 'dist', CLI_FILE),
    launcher: join(root, 'bin', 'sweep.mjs'),
    cleanup: () => {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
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

  test('双缺失 (dist/cli.js 与 src/cli.ts 均不存在) → 友好重装指引并退 1 (X-P0-1)', () => {
    const pkg = makePackage();
    try {
      const { status, stderr } = runPackaged(pkg, '--help');

      expect(status).toBe(1);
      expect(stderr).toContain('缺少可执行入口');
      expect(stderr).toContain('重装本包');
    } finally {
      pkg.cleanup();
    }
  });

  test('纯 Node (>= 22.18, PATH 无 bun) → 同进程直接 import 并保留原始 argv[1] (X-P0-1)', () => {
    const nodePathRes = spawnSync(
      'node',
      ['-e', 'process.stdout.write(process.execPath)'],
      { encoding: 'utf8' },
    );
    if (nodePathRes.status !== 0) return;
    const nodeExecPath = nodePathRes.stdout.trim();

    const pkg = makePackage();
    try {
      writeArtifact(
        pkg,
        'process.stdout.write(`ARGV1=${process.argv[1]}\\n`);\n',
      );
      const emptyPathEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(emptyPathEnv)) {
        if (key.toUpperCase() === 'PATH') delete emptyPathEnv[key];
      }
      emptyPathEnv.PATH = '';
      const res = spawnSync(nodeExecPath, [pkg.launcher, '--help'], {
        encoding: 'utf8',
        env: emptyPathEnv,
      });

      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain(`ARGV1=${pkg.launcher}`);
    } finally {
      pkg.cleanup();
    }
  });

  test('未隔离 Bun 在空 PATH 下直接重派 process.execPath 进入隔离态 (不扫 PATH 也不误降级)', () => {
    const pkg = makePackage();
    try {
      writeArtifact(
        pkg,
        'process.stdout.write(`ISOLATED=${process.env.CLIS_BUN_ISOLATED}\\n`);\n',
      );
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === 'PATH') delete env[key];
      }
      delete env.CLIS_BUN_ISOLATED;
      env.PATH = '';
      const res = spawnSync(process.execPath, [pkg.launcher, '--help'], {
        encoding: 'utf8',
        env,
      });

      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('ISOLATED=1');
    } finally {
      pkg.cleanup();
    }
  });
});

describe('npm 启动器 · 工作目录配置与环境变量隔离', () => {
  test('被扫目录存在损坏 bunfig.toml / 恶意 preload / .env 时, 经 node 启动器与 sh 启动器均安全运行且不受污染', () => {
    const dirtyCwd = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-dirty-')));
    try {
      writeFileSync(
        join(dirtyCwd, 'bunfig.toml'),
        'preload = ["./evil.js"]\n[[broken toml\n',
      );
      writeFileSync(
        join(dirtyCwd, 'evil.js'),
        "throw new Error('PRELOAD_HIJACKED');\n",
      );
      writeFileSync(
        join(dirtyCwd, '.env'),
        'SWEEP_CONFIG=/hijacked/by/dotenv.json\nNO_COLOR=1\n',
      );
      const env = { ...process.env };
      delete env.SWEEP_CONFIG;

      // 1) npm 分发态入口 (shebang 为 node, 由 .mjs 传 --config / --no-env-file 派生 bun)
      const viaMjs = spawnSync('node', [LAUNCHER, 'config'], {
        cwd: dirtyCwd,
        encoding: 'utf8',
        env,
      });
      if (viaMjs.error === undefined) {
        expect(viaMjs.status, viaMjs.stderr).toBe(0);
        expect(viaMjs.stdout).not.toContain('/hijacked/by/dotenv.json');
        expect(viaMjs.stderr).not.toContain('PRELOAD_HIJACKED');
      }

      // 2) POSIX 源码入口 (bin/sweep)
      if (process.platform !== 'win32') {
        const viaSh = spawnSync(
          '/bin/sh',
          [join(ROOT, 'bin', 'sweep'), 'config'],
          {
            cwd: dirtyCwd,
            encoding: 'utf8',
            env,
          },
        );
        expect(viaSh.status, viaSh.stderr).toBe(0);
        expect(viaSh.stdout).not.toContain('/hijacked/by/dotenv.json');
        expect(viaSh.stderr).not.toContain('PRELOAD_HIJACKED');
      }
    } finally {
      rmSync(dirtyCwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
});
