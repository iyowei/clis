/**
 * du 输出形态的解析 / 一致性判定, 与「形态不符即整批降级」的行为 (安全审计 C7 闭环)。
 * 形态依据 (2026-09-27 核实): du 仅在 stdout 为终端时按 shell-escape 引用文件名
 * (GNU coreutils 手册 du 节点「When standard output is a terminal, file names are quoted」;
 * 源码侧 isatty 门控; 9.12 之前的版本无引用逻辑), 本候选以管道捕获 stdout, 恒非终端。
 * 样本取自 GNU coreutils 9.12 的实测输出: 非终端形态逐字原样 (TAB / ESC / 引号均不转义,
 * 且 QUOTING_STYLE 环境变量在非终端下不生效), 终端 (pty) 才出现 '...' / "..." / $'\t' 引用形态;
 * 终端样本在此用于验证 fail-safe 防线: 形态与输入不符即整批降级, 不逐条采信。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessDuOutput,
  chunkTargetsByBytes,
  createDuSizer,
} from './size-du.ts';
import type { MeasureProgressEvent } from './types.ts';

const ROOT = '/w/proj';

/** 非终端形态样本的目标集合 (覆盖 TAB / ESC / BEL / 引号 / 反斜杠 / 空格 / 中文) */
const ODD_TARGETS = [
  `${ROOT}/normal`,
  `${ROOT}/tab\there`,
  `${ROOT}/esc\x1besc`,
  `${ROOT}/bel\x07bel`,
  `${ROOT}/sq'uote`,
  `${ROOT}/dq"uote`,
  `${ROOT}/back\\slash`,
  `${ROOT}/sp ace`,
  `${ROOT}/中文 目录`,
];

/** GNU du 9.12 非终端实测形态: 路径逐字原样, 无引号无转义 */
const NON_TTY_STDOUT = [
  '4\t/w/proj/normal',
  '8\t/w/proj/tab\there',
  '4\t/w/proj/esc\x1besc',
  '4\t/w/proj/bel\x07bel',
  "4\t/w/proj/sq'uote",
  '4\t/w/proj/dq"uote',
  '4\t/w/proj/back\\slash',
  '4\t/w/proj/sp ace',
  '4\t/w/proj/中文 目录',
  '',
].join('\n');

/** GNU du 9.12 终端 (pty) 实测形态: shell-escape 引用, 与输入拼写不同 */
const TTY_STDOUT = [
  '4\t/w/proj/normal',
  "8\t'/w/proj/tab'$'\\t''here'",
  "4\t'/w/proj/esc'$'\\033''esc'",
  "4\t'/w/proj/bel'$'\\a''bel'",
  '4\t"/w/proj/sq\'uote"',
  "4\t'/w/proj/dq\"uote'",
  "4\t'/w/proj/back\\slash'",
  "4\t'/w/proj/sp ace'",
  "4\t'/w/proj/中文 目录'",
  '',
].join('\n');

describe('du 输出形态 · 非终端 (本候选实际形态)', () => {
  test('怪名路径逐字原样成行: 全部采信且逐条对上', () => {
    const result = assessDuOutput(NON_TTY_STDOUT, ODD_TARGETS);

    expect(result.intact).toBe(true);
    expect(result.duplicated).toBe(false);
    expect(result.unexpected).toBe(false);
    expect([...result.sizes.keys()]).toEqual(ODD_TARGETS);
    expect(result.sizes.get(`${ROOT}/tab\there`)).toBe(8 * 1024);
  });

  test('输出少于输入 (部分目标无行): 已有行仍采信, 判定不被降级', () => {
    const stdout = `4\t${ODD_TARGETS[0]}\n`;

    const result = assessDuOutput(stdout, ODD_TARGETS);

    expect(result.intact).toBe(true);
    expect(result.sizes.size).toBe(1);
  });

  test('空输出 (如全部目标不存在): 无路径可采信, 判定本身不降级', () => {
    const result = assessDuOutput('', ODD_TARGETS);

    expect(result.intact).toBe(true);
    expect(result.sizes.size).toBe(0);
  });
});

describe('du 输出形态 · 终端引用形态 (非本候选形态, 防线验证)', () => {
  test('shell-escape 引用形态与输入不符: 整体降级, 不逐条采信', () => {
    const result = assessDuOutput(TTY_STDOUT, ODD_TARGETS);

    expect(result.intact).toBe(false);
    expect(result.unexpected).toBe(true);
  });

  test('引用形态与字面形态混排: 仍整体降级 (无部分采信通道)', () => {
    const mixed = `${NON_TTY_STDOUT}${TTY_STDOUT}`;

    const result = assessDuOutput(mixed, ODD_TARGETS);

    expect(result.intact).toBe(false);
    expect(result.duplicated).toBe(true);
  });
});

describe('du 输出形态 · 伪造与重复', () => {
  test('输入之外的路径 (伪行): 整体降级, 真实行一并作废', () => {
    const stdout = [
      `4\t${ODD_TARGETS[0]}`,
      '88888888\t/elsewhere/forged',
      '',
    ].join('\n');

    const result = assessDuOutput(stdout, ODD_TARGETS);

    expect(result.intact).toBe(false);
    expect(result.unexpected).toBe(true);
  });

  test('同一路径多行 (伪造覆盖的同形信号): 整体降级', () => {
    const stdout = [
      `4\t${ODD_TARGETS[0]}`,
      `88888888\t${ODD_TARGETS[0]}`,
      '',
    ].join('\n');

    const result = assessDuOutput(stdout, ODD_TARGETS);

    expect(result.intact).toBe(false);
    expect(result.duplicated).toBe(true);
  });
});

// 注入假 du 的端到端行为: 验证形态不符时整批落 unmeasured 且告警可归因 (win32 无 sh, 整组跳过)
const canRunShell = process.platform !== 'win32';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

/** 造一个按给定脚本行输出的假 du (可执行 sh 脚本); 调用方经 afterEach 统一清理 */
async function makeFakeDu(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sweep-du-shape-'));
  tempDirs.push(dir);
  const bin = join(dir, 'du');
  await writeFile(bin, `#!/bin/sh\n${body}`);
  await chmod(bin, 0o755);
  return bin;
}

describe.skipIf(!canRunShell)(
  'du 输出形态 · 形态不符的整批降级 (注入 du)',
  () => {
    test('含输入之外的路径: 全部 target 落 unmeasured, 告警交代后果与形态', async () => {
      // $3 = 第一个 target (argv: -sk -- <targets...>)
      const bin = await makeFakeDu(
        `printf '4\\t%s\\n' "$3"\nprintf '4\\t/outside/forged\\n'\n`,
      );
      const targets = [`${ROOT}/aa`, `${ROOT}/bb`];

      const result = await createDuSizer(bin).measure(targets);

      expect(result.entries).toEqual([]);
      expect(result.unmeasured.map((item) => item.target)).toEqual(targets);
      expect(
        result.warnings.some(
          (warning) =>
            warning.message.includes('输出与输入集合不符') &&
            warning.message.includes('含输入之外的路径'),
        ),
      ).toBe(true);
      // 低信任内容不外溢: 告警文案不得携带 du 输出的原始路径
      expect(
        result.warnings.some((warning) =>
          warning.message.includes('/outside/forged'),
        ),
      ).toBe(false);
    });

    test('同一路径多行: 同样整批降级, 形态归类为重复', async () => {
      const bin = await makeFakeDu(
        `printf '4\\t%s\\n' "$3"\nprintf '4\\t%s\\n' "$3"\n`,
      );
      const targets = [`${ROOT}/aa`];

      const result = await createDuSizer(bin).measure(targets);

      expect(result.entries).toEqual([]);
      expect(result.unmeasured.map((item) => item.target)).toEqual(targets);
      expect(
        result.warnings.some(
          (warning) =>
            warning.message.includes('输出与输入集合不符') &&
            warning.message.includes('同一路径多行'),
        ),
      ).toBe(true);
    });

    test('形态正常 (逐行对上): 全部采信, 无降级告警', async () => {
      const bin = await makeFakeDu(
        `printf '4\\t%s\\n' "$3"\nprintf '8\\t%s\\n' "$4"\n`,
      );
      const targets = [`${ROOT}/aa`, `${ROOT}/bb`];

      const result = await createDuSizer(bin).measure(targets);

      expect(result.entries).toEqual([
        { target: `${ROOT}/aa`, bytes: 4096 },
        { target: `${ROOT}/bb`, bytes: 8192 },
      ]);
      expect(result.unmeasured).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    test('重复路径输入: 去重后测, 不触发同一路径多行的误降级', async () => {
      const bin = await makeFakeDu(
        `shift 2\nfor p in "$@"; do printf '4\\t%s\\n' "$p"; done\n`,
      );
      const a = `${ROOT}/aa`;
      const b = `${ROOT}/bb`;

      const result = await createDuSizer(bin).measure([b, a, a, b]);

      expect(result.entries).toEqual([
        { target: a, bytes: 4096 },
        { target: b, bytes: 4096 },
      ]);
      expect(result.unmeasured).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    test('大参数列表分批调用: 超字节上限拆成多批 spawn 并合并结果 (防 E2BIG)', async () => {
      const logDir = await mkdtemp(join(tmpdir(), 'sweep-du-batch-log-'));
      tempDirs.push(logDir);
      const logFile = join(logDir, 'calls.log');
      const bin = await makeFakeDu(
        `shift 2\nprintf '%s\\n' "$#" >> "${logFile}"\nfor p in "$@"; do printf '4\\t%s\\n' "$p"; done\n`,
      );
      const targets = [`${ROOT}/p1`, `${ROOT}/p2`, `${ROOT}/p3`];
      // 每条路径约 11 字节 (+1 NUL = 12 字节), 上限 25 字节 → 拆成 [p1, p2] 与 [p3] 两批
      const result = await createDuSizer(bin, 25).measure(targets);

      expect(result.entries).toEqual(
        targets.map((target) => ({ target, bytes: 4096 })),
      );
      expect(result.unmeasured).toEqual([]);
      expect(result.warnings).toEqual([]);
      const calls = (await readFile(logFile, 'utf8')).trim().split('\n');
      expect(calls).toEqual(['2', '1']);
    });
  },
);

describe('du 分批切分与探针缺失完备性', () => {
  test('chunkTargetsByBytes: 按 UTF-8 字节上限分批, 单条超预算仍独立成批', () => {
    expect(chunkTargetsByBytes([], 10)).toEqual([]);
    expect(chunkTargetsByBytes(['/a', '/b', '/c'], 6)).toEqual([
      ['/a', '/b'],
      ['/c'],
    ]);
    // 单条超过预算 (10 字节 > 4 字节): 至少 1 条/批, 不死循环
    expect(chunkTargetsByBytes(['/very/long', '/x'], 4)).toEqual([
      ['/very/long'],
      ['/x'],
    ]);
  });

  test('createDuSizer(null): 非空输入全部进 unmeasured 并带告警 (遵守 BC-43 完备性恒等式)', async () => {
    const events: MeasureProgressEvent[] = [];
    const result = await createDuSizer(null).measure(
      [`${ROOT}/bb`, `${ROOT}/aa`, `${ROOT}/aa`],
      { onProgress: (event) => events.push(event) },
    );

    expect(result.entries).toEqual([]);
    expect(result.gone).toEqual([]);
    expect(result.unmeasured).toEqual([
      {
        target: `${ROOT}/aa`,
        code: 'SIZE_UNMEASURED_OTHER',
        reason: 'du 候选不可用',
      },
      {
        target: `${ROOT}/bb`,
        code: 'SIZE_UNMEASURED_OTHER',
        reason: 'du 候选不可用',
      },
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual(['SIZE_DU_UNAVAILABLE']);
    expect(events.map((e) => e.kind)).toEqual(['unmeasured', 'unmeasured']);
  });
});
