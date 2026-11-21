/**
 * 转写报告层单测: 全量核验水印、--filter 非全量警告、条款原文抽取与 --emit-failures 自包含诊断单落盘。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../lib/tmp-root.ts';
import {
  type CaseReport,
  emitFailureDiagnostics,
  extractSpecClauses,
  printHumanReport,
  printJsonReport,
} from './report.ts';

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 捕获回调向 process.stdout 写入的文本 */
function captureStdout(fn: () => void): string {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

const PASS_REPORT: CaseReport = {
  id: 'demo-pass',
  specRefs: ['BC-01'],
  status: 'pass',
  durationMs: 12,
  failures: [],
};

const FAIL_REPORT: CaseReport = {
  id: 'demo-fail',
  specRefs: ['BC-01', 'OF-14'],
  status: 'fail',
  durationMs: 25,
  failures: [
    {
      kind: 'exitCode',
      message: '退出码不符: 期望 1, 实得 0',
      expected: '1',
      actual: '0',
    },
  ],
  diagnostics: {
    stdout: 'unexpected ok\n',
    stderr: 'minor warn\n',
  },
};

describe('全量核验水印与 JSON 只增扩展', () => {
  test('全集零跳过通过时人读与 JSON 均标记 fullRunVerified', () => {
    const human = captureStdout(() => {
      printHumanReport('corpus', 'demo-bin', [PASS_REPORT], {
        totalCorpus: 1,
        selected: 1,
        skipped: 0,
        fullRunVerified: true,
      });
    });
    expect(human).toContain('全集 1 · 实跑 1 · 跳过 0');
    expect(human).toContain('[全量核验通过]');
    expect(human).not.toContain('[非全量运行]');

    const rawJson = captureStdout(() => {
      printJsonReport('corpus', 'demo-bin', [PASS_REPORT], {
        totalCorpus: 1,
        selected: 1,
        skipped: 0,
        fullRunVerified: true,
      });
    });
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    expect(parsed.total).toBe(1);
    expect(parsed.totalCorpus).toBe(1);
    expect(parsed.selected).toBe(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.filtered).toBe(false);
    expect(parsed.fullRunVerified).toBe(true);
  });

  test('带 --filter 子集运行时显式打出非全量警告且 fullRunVerified=false', () => {
    const human = captureStdout(() => {
      printHumanReport('corpus', 'demo-bin', [PASS_REPORT], {
        totalCorpus: 10,
        selected: 1,
        skipped: 9,
        filter: 'demo-',
        fullRunVerified: false,
      });
    });
    expect(human).toContain('全集 10 · 实跑 1 · 跳过 9');
    expect(human).toContain('[非全量运行]');
    expect(human).toContain('--filter "demo-"');
    expect(human).not.toContain('[全量核验通过]');

    const rawJson = captureStdout(() => {
      printJsonReport('corpus', 'demo-bin', [PASS_REPORT], {
        totalCorpus: 10,
        selected: 1,
        skipped: 9,
        filter: 'demo-',
        fullRunVerified: false,
      });
    });
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    expect(parsed.filtered).toBe(true);
    expect(parsed.fullRunVerified).toBe(false);
    expect(parsed.skipped).toBe(9);
    expect(parsed.filter).toBe('demo-');
  });
});

describe('条款原文抽取与 --emit-failures 自包含诊断单', () => {
  test('extractSpecClauses 精确解析 Markdown 表格行并还原转义管道符', () => {
    const md = [
      '| 编号 | 条款 | 权威出处 | 可验收 |',
      '| --- | --- | --- | --- |',
      '| BC-01 | 规则支持 `file \\| dir` 两态 | design.md | CLI 黑盒 |',
      '| OF-14 | 全输出面单源净化控制字符 | security.md | API 黑盒 |',
    ].join('\n');

    const map = extractSpecClauses(md, ['BC-01', 'OF-14', 'EC-99']);
    expect(map.get('BC-01')).toBe(
      '规则支持 `file | dir` 两态 (出处: design.md)',
    );
    expect(map.get('OF-14')).toBe(
      '全输出面单源净化控制字符 (出处: security.md)',
    );
    expect(map.has('EC-99')).toBe(false);
  });

  test('emitFailureDiagnostics 全部通过时不写盘; 存在失败时清理旧单并输出条款原文与语料 JSON', () => {
    const root = makeTmpRoot('report-emit-');
    createdRoots.push(root);
    const outDir = join(root, 'failures');
    const contractPath = join(root, 'behavior-contract.md');
    writeFileSync(
      contractPath,
      '| BC-01 | 核心条款正文 | spec.md | CLI |\n| OF-14 | 净化条款正文 | sec.md | API |\n',
      'utf8',
    );

    const empty = emitFailureDiagnostics(outDir, [PASS_REPORT], new Map(), {
      target: 'demo-bin',
      corpusDir: 'corpus',
      contractPath,
    });
    expect(empty).toEqual([]);
    expect(existsSync(outDir)).toBe(false);

    // 预置陈旧文件, 验证新一轮导出前先清旧
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'stale-case.md'), 'old');

    const casesById = new Map<string, unknown>([
      [
        'demo-fail',
        {
          id: 'demo-fail',
          specRefs: ['BC-01', 'OF-14'],
          expect: { exitCode: 1 },
        },
      ],
    ]);
    const written = emitFailureDiagnostics(
      outDir,
      [PASS_REPORT, FAIL_REPORT],
      casesById,
      { target: 'demo-bin', corpusDir: 'corpus', contractPath },
    );
    expect(written).toEqual([join(outDir, 'demo-fail.md')]);
    expect(existsSync(join(outDir, 'stale-case.md'))).toBe(false);
    expect(existsSync(join(outDir, 'INDEX.md'))).toBe(true);

    const doc = readFileSync(join(outDir, 'demo-fail.md'), 'utf8');
    expect(doc).toContain('# 失败诊断单: `demo-fail`');
    expect(doc).toContain('核心条款正文 (出处: spec.md)');
    expect(doc).toContain('净化条款正文 (出处: sec.md)');
    expect(doc).toContain('退出码不符: 期望 1, 实得 0');
    expect(doc).toContain('unexpected ok');
    expect(doc).toContain('"exitCode": 1');
  });
});
