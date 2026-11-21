/**
 * 自更新 UI 配色降级、净化防注入、TTY Spinner 与静默接管/失败展开行为单元测试。
 */
import { describe, expect, test } from 'bun:test';

import { formatUpdateHelp } from './args.ts';
import {
  type SpinnerTimerHandle,
  type UpdateSpinner,
  createUpdateSpinner,
} from './spinner.ts';
import {
  createUpdateUi,
  displayWidth,
  sanitizeMultilineTail,
  stripAnsi,
} from './ui.ts';
import { type PackageMeta, type UpdateIO, runSelfUpdate } from './update.ts';

function captureIo(): { io: UpdateIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    out,
    err,
  };
}

const bunMeta: PackageMeta = {
  name: '@iyowei/sweep-cli',
  version: '0.5.1',
  isPrivate: false,
  rawPackageRoot:
    '/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-cli',
  packageRoot: '/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-cli',
};

describe('update UI 标准 SGR 配色与防注入净化', () => {
  test('formatUpdateHelp 与 createUpdateUi 满足去色等价且零 24-bit RGB 硬编码', () => {
    const plainHelp = formatUpdateHelp('sweep', bunMeta.name, false);
    const coloredHelp = formatUpdateHelp('sweep', bunMeta.name, true);
    expect(plainHelp).not.toContain('\u001b');
    expect(coloredHelp).toContain('\u001b[');
    expect(coloredHelp).not.toMatch(/38;2;|48;2;/);
    expect(stripAnsi(coloredHelp)).toBe(plainHelp);
    expect(plainHelp).toContain('--verbose');

    const uiPlain = createUpdateUi({ stdout: false, stderr: false });
    const uiColor = createUpdateUi({ stdout: true, stderr: true });
    expect(stripAnsi(uiColor.header('codd'))).toBe(uiPlain.header('codd'));
    expect(stripAnsi(uiColor.kv('当前版本', 'a@1.0.0', 'bold'))).toBe(
      uiPlain.kv('当前版本', 'a@1.0.0', 'bold'),
    );
    expect(
      stripAnsi(
        uiColor.foundUpdate('0.5.1', '0.6.0', 'https://registry.npmjs.org'),
      ),
    ).toBe(uiPlain.foundUpdate('0.5.1', '0.6.0', 'https://registry.npmjs.org'));
  });

  test('sanitizeMultilineTail 剥离 ANSI 颜色码与控制字符并保留末尾报错行', () => {
    const rawLines = Array.from(
      { length: 16 },
      (_, idx) => `\u001b[31mline-${idx}\u202e\u001b[0m`,
    ).join('\n');
    const res = sanitizeMultilineTail(rawLines, 5, 2048);
    expect(res.clipped).toBe(true);
    expect(res.lines).toEqual([
      'line-11',
      'line-12',
      'line-13',
      'line-14',
      'line-15',
    ]);
    for (const line of res.lines) {
      expect(line).not.toContain('\u001b');
      expect(line).not.toContain('\u202e');
    }
  });
});

describe('createUpdateSpinner TTY 实时进度', () => {
  test('enabled=false 时严格 0 字节输出; enabled=true 时首帧立现、旋转更新、窄屏安全截断、stop 擦净', () => {
    const silentChunks: string[] = [];
    const silent = createUpdateSpinner({
      enabled: false,
      color: false,
      write: (c) => silentChunks.push(c),
    });
    silent.start('正在检查最新版本', 'registry.npmjs.org');
    silent.update('正在升级');
    silent.stop();
    expect(silentChunks).toEqual([]);

    const chunks: string[] = [];
    let tickCallback: (() => void) | undefined;
    let cleared = 0;
    let nowMs = 0;
    const spinner = createUpdateSpinner({
      enabled: true,
      color: true,
      columns: () => 26,
      now: () => nowMs,
      write: (c) => chunks.push(c),
      setTimer: (fn) => {
        tickCallback = fn;
        return {} as SpinnerTimerHandle;
      },
      clearTimer: () => {
        cleared += 1;
      },
    });

    spinner.start('正在检查最新版本', 'registry.npmjs.org');
    expect(chunks.length).toBe(1);
    const firstPlain = stripAnsi(chunks[0]!).replace(/^\r/, '');
    expect(firstPlain).toContain('⠋');
    expect(displayWidth(firstPlain)).toBeLessThanOrEqual(25);
    expect(firstPlain).toContain('…');

    nowMs = 1400;
    tickCallback?.();
    expect(chunks.length).toBe(2);
    expect(stripAnsi(chunks[1]!)).toContain('⠙');

    spinner.stop();
    spinner.stop(); // 幂等
    expect(cleared).toBe(1);
    expect(chunks[chunks.length - 1]).toBe('\r\u001b[2K');
  });
});

describe('runSelfUpdate 静默接管、失败展开与 --verbose 透传', () => {
  test('默认升级静默捕获隐藏底层日志与执行命令, 并按两段驱动 Spinner 生命周期', async () => {
    const events: string[] = [];
    const spinner: UpdateSpinner = {
      start: (a, d) => events.push(`start:${a}${d ? `:${d}` : ''}`),
      update: (a) => events.push(`update:${a}`),
      stop: () => events.push('stop'),
    };
    const { io, out, err } = captureIo();
    let seenVerbose: boolean | undefined;

    const code = await runSelfUpdate({
      binName: 'sweep',
      meta: bunMeta,
      argv: [],
      io,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        isFile: (p) => p === '/usr/local/bin/bun',
        pathExists: () => false,
        readText: () => null,
        spinner,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.6.0',
          registry: reg,
        }),
        execPlanAsync: async (_plan, opts) => {
          seenVerbose = opts?.verbose;
          return {
            status: 0,
            capturedOutput: 'bun add v1.4.5\ninstalled pkg\n',
            durationMs: 2580,
          };
        },
      },
    });

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(seenVerbose).toBe(false);
    expect(events).toEqual([
      'start:正在检查最新版本:registry.npmjs.org',
      'stop',
      'start:正在通过 bun 升级至 v0.6.0',
      'stop',
    ]);
    const stdout = out.join('\n');
    expect(stdout).not.toContain('即将执行');
    expect(stdout).not.toContain('bun add v1.4.5');
    expect(stdout).toContain(
      '已通过 bun 更新 @iyowei/sweep-cli 至 v0.6.0 (2.6s) ✓',
    );
  });

  test('默认升级失败时自动展开净化后的底层尾部日志, --verbose 时直接透传不重复打印摘要', async () => {
    const { io: io1, err: err1 } = captureIo();
    const failCode = await runSelfUpdate({
      binName: 'codd',
      meta: bunMeta,
      argv: [],
      io: io1,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        isFile: (p) => p === '/usr/local/bin/bun',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.6.0',
          registry: reg,
        }),
        execPlanAsync: async () => ({
          status: 1,
          capturedOutput:
            '\u001b[31merror: EACCES permission denied\u202e\u001b[0m\n',
          truncated: false,
        }),
      },
    });
    expect(failCode).toBe(1);
    const stderr1 = err1.join('\n');
    expect(stderr1).toContain('底层输出摘要:');
    expect(stderr1).toContain('error: EACCES permission denied');
    expect(stderr1).not.toContain('\u001b');
    expect(stderr1).not.toContain('\u202e');
    expect(stderr1).toContain('手动更新命令:');

    // --verbose 模式打印执行命令并透传 verbose=true, 失败不重复展开摘要
    const { io: io2, out: out2, err: err2 } = captureIo();
    let verboseFlag: boolean | undefined;
    const verboseFail = await runSelfUpdate({
      binName: 'create-clis',
      meta: bunMeta,
      argv: ['--verbose'],
      io: io2,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        isFile: (p) => p === '/usr/local/bin/bun',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.6.0',
          registry: reg,
        }),
        execPlanAsync: async (_plan, opts) => {
          verboseFlag = opts?.verbose;
          return {
            status: 1,
            capturedOutput: 'should-not-repeat',
          };
        },
      },
    });
    expect(verboseFail).toBe(1);
    expect(verboseFlag).toBe(true);
    expect(out2.join('\n')).toContain('执行命令');
    expect(err2.join('\n')).not.toContain('底层输出摘要');
  });
});
