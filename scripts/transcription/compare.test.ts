/**
 * 转写契约套件 · 比对层与校验层单测:
 * 1. compareApiCase 未预期抛错拦截 (未声明 expect.error 时即便仅断言 fs/events 也不得静默 PASS);
 * 2. validateCase 校验收紧 (创建步禁 collectEvents / api expect 非空 / result 与 error 互斥 / 条款正则统一)。
 */
import { describe, expect, test } from 'bun:test';

import { compareApiCase } from './compare.ts';
import type { ExecOutcome } from './fixture.ts';
import { validateCase } from './validate.ts';

describe('compareApiCase: 未预期抛错拦截', () => {
  const errOutcome: ExecOutcome = {
    status: 0,
    stdout: JSON.stringify({
      ok: false,
      error: { name: 'SweepError', code: 'INVALID_ARGUMENT', message: 'boom' },
    }),
    stderr: '',
    timedOut: false,
  };

  test('仅声明 expect.events 未声明 expect.error 时, outcome.ok=false 必判 FAIL', async () => {
    const failures = await compareApiCase(
      { events: { lastIs: 'done' } },
      errOutcome,
      '/unused',
    );
    expect(failures.some((f) => f.kind === 'error')).toBe(true);
    expect(failures[0]?.message).toContain('未预期抛错');
  });

  test('仅声明 expect.fs 未声明 expect.error 时, outcome.ok=false 必判 FAIL (杜绝静默 PASS)', async () => {
    const failures = await compareApiCase({ fs: [] }, errOutcome, '/unused');
    expect(failures.some((f) => f.kind === 'error')).toBe(true);
  });

  test('声明匹配的 expect.error 时通过', async () => {
    const failures = await compareApiCase(
      { error: { code: 'INVALID_ARGUMENT', name: 'SweepError' } },
      errOutcome,
      '/unused',
    );
    expect(failures).toEqual([]);
  });
});

describe('validateCase: 语料校验收紧与条款正则统一', () => {
  const baseApi = {
    id: 'api-sample',
    kind: 'api',
    specRefs: ['BC-01'],
    fixture: {},
    steps: [{ call: { export: 'createScanner' } }],
    expect: { result: { subset: {} } },
  };

  test('创建步 (call.export) 声明 collectEvents: true 判错', () => {
    const problems = validateCase({
      ...baseApi,
      steps: [{ call: { export: 'createScanner' }, collectEvents: true }],
    });
    expect(problems.some((p) => p.includes('创建步不支持 collectEvents'))).toBe(
      true,
    );
  });

  test('api case 的 expect 至少含 result/error/events/fs 之一, 且 result 与 error 互斥', () => {
    const emptyExpect = validateCase({ ...baseApi, expect: {} });
    expect(emptyExpect.some((p) => p.includes('须至少含'))).toBe(true);

    const both = validateCase({
      ...baseApi,
      expect: { result: { exact: 1 }, error: { code: 'CANCELLED' } },
    });
    expect(both.some((p) => p.includes('互斥'))).toBe(true);
  });

  test('specRefs 仅接受 BC/OF/EC 前缀的条款编号 (与 validate-coverage 统一正则)', () => {
    expect(validateCase(baseApi)).toEqual([]);
    const bad = validateCase({ ...baseApi, specRefs: ['XX-01'] });
    expect(bad.some((p) => p.includes('specRefs'))).toBe(true);
  });
});
