/**
 * 自定义清理规则 (`rules`) 专项测试:
 * 覆盖 match 安全校验、action 缺省强制 trash、kind 过滤、olderThanDays 边界、
 * 局部 exclude/include 收紧与多源碰撞保守优先 ('trash' > 'delete')。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXCLUDE, loadConfig } from './config.ts';
import {
  MS_PER_DAY,
  compileNameMatcher,
  compileRules,
  isOlderThanDays,
  matchesAnyRuleLeaf,
  ruleMatchesKind,
  validateRuleMatch,
} from './rules.ts';
import { createParallelScanner } from './scan-parallel.ts';

const dirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), 'sweep-lab-rules-'));
  const real = await realpath(raw);
  dirs.push(real);
  return real;
}

async function touch(filePath: string, content = ''): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs.length = 0;
});

describe('rules 纯函数校验与编译', () => {
  test('validateRuleMatch 拒绝高危/非法模式并放行安全模式', () => {
    const forbidden = [
      '',
      '   ',
      ' *.log',
      '*.log ',
      '.',
      '..',
      '.git',
      '*',
      '**',
      '***',
      '*.*',
      '.*',
      '*?',
      '?',
      'foo/bar',
      'foo\\bar',
      '/abs',
      'bad\x00name',
      'bad\nname',
      'bad\x1fname',
      'bad\x7fname',
    ];
    for (const pattern of forbidden) {
      expect(
        validateRuleMatch(pattern),
        `应拒绝 ${JSON.stringify(pattern)}`,
      ).not.toBeNull();
    }

    const allowed = [
      '*.log',
      'temp-?',
      'dist',
      '.cache',
      'file.(1)+[a].tmp',
      'cmake-build-*',
    ];
    for (const pattern of allowed) {
      expect(validateRuleMatch(pattern), `应放行 ${pattern}`).toBeNull();
    }
  });

  test('compileNameMatcher / ruleMatchesKind / isOlderThanDays / matchesAnyRuleLeaf', () => {
    const exact = compileNameMatcher('error.log');
    expect(exact('error.log')).toBe(true);
    expect(exact('error1log')).toBe(false);

    const glob = compileNameMatcher('app-[1]+?.log*');
    expect(glob('app-[1]+a.log')).toBe(true);
    expect(glob('app-[1]+a.log.gz')).toBe(true);
    expect(glob('app-[1]+ab.log')).toBe(false);

    expect(ruleMatchesKind('file', 'file')).toBe(true);
    expect(ruleMatchesKind('file', 'dir')).toBe(false);
    expect(ruleMatchesKind('dir', 'dir')).toBe(true);
    expect(ruleMatchesKind('dir', 'file')).toBe(false);
    expect(ruleMatchesKind('any', 'file')).toBe(true);
    expect(ruleMatchesKind('any', 'dir')).toBe(true);

    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    expect(isOlderThanDays(nowMs - 7 * MS_PER_DAY, 7, nowMs)).toBe(true);
    expect(isOlderThanDays(nowMs - 7 * MS_PER_DAY + 1, 7, nowMs)).toBe(false);

    expect(
      matchesAnyRuleLeaf('debug.log', [
        { name: 'logs', kind: 'file', match: '*.log', action: 'trash' },
      ]),
    ).toBe(true);
    expect(
      matchesAnyRuleLeaf('debug.txt', [
        { name: 'logs', kind: 'file', match: '*.log', action: 'trash' },
      ]),
    ).toBe(false);

    const compiled = compileRules([
      { name: 'omitted-action', kind: 'file', match: '*.tmp' },
      {
        name: 'explicit-delete',
        kind: 'dir',
        match: 'dist-*',
        action: 'delete',
      },
    ]);
    expect(compiled[0]?.rule.action).toBe('trash');
    expect(compiled[0]?.matchesName('a.tmp')).toBe(true);
    expect(compiled[1]?.rule.action).toBe('delete');
  });

  test('配置解析强制保证 rules[].action 缺省为 trash', async () => {
    const root = await makeTempRoot();
    const cfgPath = join(root, 'config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        version: 2,
        roots: [root],
        rules: [
          { name: '无 action 规则', kind: 'file', match: '*.tmp' },
          {
            name: '显式 delete 规则',
            kind: 'dir',
            match: 'tmp-*',
            action: 'delete',
          },
        ],
      }),
    );

    const loaded = await loadConfig(cfgPath);
    expect(loaded.state).toBe('ok');
    if (loaded.state === 'ok') {
      expect(loaded.config.rules[0]?.action).toBe('trash');
      expect(loaded.config.rules[1]?.action).toBe('delete');
    }
  });
});

describe('rules 扫描行为: kind / olderThanDays / 局部过滤', () => {
  test('kind: file / dir / any 精确区分文件与目录形态', async () => {
    const root = await makeTempRoot();
    await touch(join(root, 'box-a', 'scratch.tmp'), 'file');
    await mkdir(join(root, 'box-b', 'scratch.tmp'), { recursive: true });

    const onlyFile = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: {},
      rules: [
        { name: '仅文件', kind: 'file', match: '*.tmp', action: 'trash' },
      ],
    });
    expect(onlyFile.hits).toEqual([
      {
        project: join(root, 'box-a'),
        target: join(root, 'box-a', 'scratch.tmp'),
        root,
        entryKind: 'file',
        action: 'trash',
        source: { kind: 'rule', name: '仅文件' },
      },
    ]);

    const onlyDir = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: {},
      rules: [{ name: '仅目录', kind: 'dir', match: '*.tmp', action: 'trash' }],
    });
    expect(onlyDir.hits.map((h) => [h.target, h.entryKind])).toEqual([
      [join(root, 'box-b', 'scratch.tmp'), 'dir'],
    ]);

    const both = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: {},
      rules: [{ name: '均可', kind: 'any', match: '*.tmp', action: 'trash' }],
    });
    expect(both.hits.map((h) => [h.target, h.entryKind])).toEqual([
      [join(root, 'box-a', 'scratch.tmp'), 'file'],
      [join(root, 'box-b', 'scratch.tmp'), 'dir'],
    ]);
  });

  test('olderThanDays 边界: 达到阈值命中, 晚于阈值跳过 (utimes 注入真实 mtime)', async () => {
    const root = await makeTempRoot();
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const exactOld = join(root, 'logs', 'exact-10d.log');
    const veryOld = join(root, 'logs', 'old-20d.log');
    const fresh = join(root, 'logs', 'fresh-5d.log');
    const oldDir = join(root, 'tmp-old');
    const freshDir = join(root, 'tmp-new');

    await touch(exactOld, 'a');
    await touch(veryOld, 'b');
    await touch(fresh, 'c');
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });

    const setMtime = async (path: string, ms: number): Promise<void> => {
      const date = new Date(ms);
      await utimes(path, date, date);
    };
    await setMtime(exactOld, nowMs - 10 * MS_PER_DAY);
    await setMtime(veryOld, nowMs - 20 * MS_PER_DAY);
    await setMtime(fresh, nowMs - 5 * MS_PER_DAY);
    await setMtime(oldDir, nowMs - 15 * MS_PER_DAY);
    await setMtime(freshDir, nowMs - 2 * MS_PER_DAY);

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: {},
      nowMs,
      rules: [
        {
          name: '十天日志',
          kind: 'file',
          match: '*.log',
          action: 'trash',
          olderThanDays: 10,
        },
        {
          name: '十天临时目录',
          kind: 'dir',
          match: 'tmp-*',
          action: 'trash',
          olderThanDays: 10,
        },
      ],
    });

    expect(hits.map((h) => h.target)).toEqual(
      [exactOld, veryOld, oldDir].sort(),
    );
  });

  test('局部 exclude / include 收紧规则范围, 且不突破全局 exclude', async () => {
    const root = await makeTempRoot();
    await touch(join(root, 'scope-a', 'keep', 'a.log'), '1');
    await touch(join(root, 'scope-a', 'clean', 'b.log'), '2');
    await touch(join(root, 'scope-b', 'clean', 'c.log'), '3');
    await touch(join(root, 'scope-a', 'global-ban', 'd.log'), '4');

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: ['global-ban'],
      include: [],
      presets: {},
      rules: [
        {
          name: '局部过滤日志',
          kind: 'file',
          match: '*.log',
          action: 'trash',
          include: ['scope-a'],
          exclude: ['keep'],
        },
      ],
    });

    expect(hits.map((h) => h.target)).toEqual([
      join(root, 'scope-a', 'clean', 'b.log'),
    ]);
  });
});

describe('rules 多源碰撞保守优先 (trash > delete)', () => {
  test('同一 realpath 同时命中 delete 预设与 trash 自定义规则时, 最终动作强制为 trash', async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, 'app', 'node_modules'), { recursive: true });
    await touch(join(root, 'app', 'package.json'), '{}');

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: { node: { action: 'delete' } },
      rules: [
        {
          name: '保守保护 node_modules',
          kind: 'dir',
          match: 'node_modules',
          action: 'trash',
        },
      ],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      target: join(root, 'app', 'node_modules'),
      action: 'trash',
      source: { kind: 'preset', name: 'node' },
    });
  });

  test('双预设碰撞 (rust delete + java trash) 与双规则反向碰撞 (trash + delete) 均保守取 trash', async () => {
    const root = await makeTempRoot();
    // 同级同时存在 Cargo.toml 和 pom.xml, 命中 rust(delete) 与 java(trash)
    await mkdir(join(root, 'polyglot', 'target'), { recursive: true });
    await touch(join(root, 'polyglot', 'Cargo.toml'), '[package]\n');
    await touch(join(root, 'polyglot', 'pom.xml'), '<project/>');
    await touch(join(root, 'polyglot', 'trace.log'), 'log');

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: {
        rust: { action: 'delete' },
        java: { action: 'trash' },
      },
      rules: [
        { name: '先回收', kind: 'file', match: '*.log', action: 'trash' },
        { name: '后强删', kind: 'file', match: 'trace.*', action: 'delete' },
      ],
    });

    const targetHit = hits.find(
      (h) => h.target === join(root, 'polyglot', 'target'),
    );
    const logHit = hits.find(
      (h) => h.target === join(root, 'polyglot', 'trace.log'),
    );
    expect(targetHit?.action).toBe('trash');
    expect(logHit?.action).toBe('trash');
  });

  test('[S-2] 阻断自定义规则借道 java 特批越过 DEFAULT_EXCLUDE, 且软链根指向家目录时严防命中 ~/.gradle', async () => {
    const base = await makeTempRoot();
    const fakeHome = join(base, 'real-home');
    const linkToHome = join(base, 'link-home');
    await mkdir(join(fakeHome, '.gradle', 'caches'), { recursive: true });
    await touch(join(fakeHome, 'build.gradle'), '// bait\n');
    await touch(join(fakeHome, '.gradle', 'caches', 'keep.jar'), 'jar');
    await mkdir(join(fakeHome, 'other-team', 'svc', '.gradle'), {
      recursive: true,
    });
    await touch(join(fakeHome, 'other-team', 'svc', 'build.gradle'), '');
    await mkdir(join(fakeHome, 'allowed-team', 'app', '.gradle'), {
      recursive: true,
    });
    await touch(join(fakeHome, 'allowed-team', 'app', 'build.gradle'), '');

    const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(fakeHome, linkToHome, dirLinkType);

    // 攻击路径 1: DEFAULT_EXCLUDE 生效时, 越过默认护栏的 .gradle 只允许评估 java 预设, 自定义规则严禁借道命中或混入动作
    const hijackScan = await createParallelScanner().scan({
      roots: [fakeHome],
      home: fakeHome,
      exclude: [...DEFAULT_EXCLUDE],
      excludeExplicit: false,
      include: [],
      presets: {
        java: { action: 'delete', include: ['allowed-team'] },
      },
      rules: [
        {
          name: 'hijack-gradle',
          kind: 'dir',
          match: '.grad*',
          action: 'trash',
        },
      ],
    });
    expect(hijackScan.hits).toEqual([
      {
        project: join(fakeHome, 'allowed-team', 'app'),
        target: join(fakeHome, 'allowed-team', 'app', '.gradle'),
        root: fakeHome,
        entryKind: 'dir',
        action: 'delete',
        source: { kind: 'preset', name: 'java' },
      },
    ]);

    // 攻击路径 2: 显式清空 exclude: [] 并以指向 ~ 的软链作为扫描根时, realpath(parentDir) 拦截 ~/.gradle
    const symlinkRootScan = await createParallelScanner().scan({
      roots: [linkToHome],
      home: fakeHome,
      exclude: [],
      excludeExplicit: true,
      include: [],
      presets: { java: {} },
      rules: [
        {
          name: 'hijack-home-gradle',
          kind: 'dir',
          match: '.grad*',
          action: 'delete',
        },
      ],
    });
    expect(symlinkRootScan.hits.map((h) => h.target)).toEqual(
      [
        join(linkToHome, 'allowed-team', 'app', '.gradle'),
        join(linkToHome, 'other-team', 'svc', '.gradle'),
      ].sort(),
    );
  });
});
