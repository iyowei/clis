/**
 * TTY 实时进度指示器单测: 覆盖非 TTY 零输出、全阶段文案推进、告警插队防串行、
 * NO_COLOR 无色旋转、窄终端防软折行与 stop() 幂等清行 + 定时器释放。
 */
import { describe, expect, test } from 'bun:test';

import { type TimerHandle, createSweepProgress } from './progress.ts';

const ANSI_RE = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`,
  'g',
);
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

describe('createSweepProgress', () => {
  test('enabled=false (非 TTY / TERM=dumb) 严格零输出', () => {
    const chunks: string[] = [];
    const progress = createSweepProgress({
      enabled: false,
      color: true,
      rootCount: 2,
      write: (chunk) => chunks.push(chunk),
    });

    progress.start();
    progress.update({ kind: 'phase', phase: 'scan', status: 'start' });
    progress.update({
      kind: 'hit',
      hit: { target: '/w/a/node_modules', project: 'a', root: '/w' },
    });
    progress.suspend();
    progress.resume();
    progress.stop();

    expect(chunks).toEqual([]);
  });

  test('start 同步出首帧, 消费扫描 → 体积 → 清理全阶段事件并在 stop 后彻底清行释放定时器', () => {
    const chunks: string[] = [];
    let clock = 1000;
    let tick: (() => void) | undefined;
    let cleared = false;
    let unrefCalled = false;

    const progress = createSweepProgress({
      enabled: true,
      color: true,
      rootCount: 2,
      write: (chunk) => chunks.push(chunk),
      columns: () => 80,
      now: () => clock,
      setTimer: (fn): TimerHandle => {
        tick = fn;
        return {
          unref: () => {
            unrefCalled = true;
          },
        };
      },
      clearTimer: () => {
        cleared = true;
      },
    });

    progress.start();
    expect(unrefCalled).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(stripAnsi(chunks[0]!)).toBe('\r  ⠋ 扫描中 · 2 个根');
    // 主视图同源标准 SGR (零硬编码 24-bit RGB)
    expect(chunks[0]).not.toContain('38;2;');

    clock = 1350;
    progress.update({
      kind: 'hit',
      hit: { target: '/w/a/node_modules', project: 'a', root: '/w' },
    });
    expect(stripAnsi(chunks.at(-1)!)).toBe('\r  ⠋ 扫描中 · 已发现 1 处 · 0.3s');

    // 定时器推动帧旋转
    tick?.();
    expect(stripAnsi(chunks.at(-1)!)).toBe('\r  ⠙ 扫描中 · 已发现 1 处 · 0.3s');

    clock = 2200;
    progress.update({ kind: 'phase', phase: 'measure', status: 'start' });
    progress.update({
      kind: 'measured',
      target: '/w/a/node_modules',
      bytes: 1024 * 1024 * 120,
      basis: 'disk-usage',
    });
    expect(stripAnsi(chunks.at(-1)!)).toBe(
      '\r  ⠙ 统计体积 · 1/1 处 · 120 MB · 1.2s',
    );

    clock = 3100;
    progress.update({ kind: 'phase', phase: 'remove', status: 'start' });
    progress.update({
      kind: 'removed',
      target: '/w/a/node_modules',
      outcome: 'removed',
    });
    expect(stripAnsi(chunks.at(-1)!)).toBe('\r  ⠙ 正在清理 · 1/1 处 · 2.1s');

    progress.stop();
    expect(cleared).toBe(true);
    expect(chunks.at(-1)).toBe('\r\u001b[2K');

    // stop 幂等: 二次调用不重复写清除符
    const countAfterStop = chunks.length;
    progress.stop();
    expect(chunks.length).toBe(countAfterStop);
  });

  test('suspend / resume 在告警插队前先清行再续绘, color=false 时无 SGR 色码但仍旋转', () => {
    const chunks: string[] = [];
    const progress = createSweepProgress({
      enabled: true,
      color: false,
      rootCount: 1,
      write: (chunk) => chunks.push(chunk),
      columns: () => 80,
      now: () => 0,
      setTimer: () => ({}),
      clearTimer: () => {},
    });

    progress.start();
    // color=false 只有清行控制符, 不带 SGR 色码 (\x1b[...m)
    const SGR_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`);
    expect(chunks[0]).not.toMatch(SGR_RE);
    expect(chunks[0]).toBe('\r\u001b[2K  ⠋ 扫描中 · 1 个根');

    progress.suspend();
    expect(chunks.at(-1)).toBe('\r\u001b[2K');

    progress.resume();
    expect(chunks.at(-1)).toBe('\r\u001b[2K  ⠋ 扫描中 · 1 个根');

    progress.stop();
  });

  test('窄屏自动截断至 columns-1 以内, 绝不触发软折行残影', () => {
    const chunks: string[] = [];
    let clock = 0;
    const progress = createSweepProgress({
      enabled: true,
      color: false,
      rootCount: 3,
      write: (chunk) => chunks.push(chunk),
      columns: () => 20,
      now: () => clock,
      setTimer: () => ({}),
      clearTimer: () => {},
    });

    progress.start();
    clock = 1500;
    progress.update({ kind: 'phase', phase: 'measure', status: 'start' });
    progress.update({
      kind: 'measured',
      target: '/w/a/node_modules',
      bytes: 1024 * 1024 * 512,
      basis: 'disk-usage',
    });
    const visible = stripAnsi(chunks.at(-1)!).replace('\r', '');
    let width = 0;
    for (const ch of visible) {
      const code = ch.codePointAt(0) ?? 0;
      width +=
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xff60)
          ? 2
          : 1;
    }
    expect(width).toBeLessThanOrEqual(19);
    expect(visible).toContain('…');
    progress.stop();
  });
});
