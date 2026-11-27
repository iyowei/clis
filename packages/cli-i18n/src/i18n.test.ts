/**
 * `@iyowei/cli-i18n` 单元测试:
 * 覆盖 macOS bplist00 / XML `.GlobalPreferences.plist` 探测、Linux `/etc/locale.conf`、
 * 四层优先级覆盖 (含中文系统强制自定义英文)、按工具独立落盘、`--lang` 参数剥离与 `lang` 子命令。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractMacPreferredLanguage } from './bplist.ts';
import {
  classifyLocaleTag,
  detectSystemLocale,
  displayWidth,
  padEndDisplay,
  padStartDisplay,
  parseLangPreference,
  resolveCliLocale,
  runLangCommand,
  stripLangArgs,
} from './index.ts';

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `cli-i18n-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造最小合法 `bplist00` 二进制字节流: `{ AppleLanguages: [langTag] }` */
function buildMinimalMacBplist(langTag: string): Uint8Array {
  const keyBytes = Buffer.from('AppleLanguages', 'ascii');
  const valBytes = Buffer.from(langTag, 'ascii');

  // Object 0: Dict (1 pair -> key ref 1, val ref 2) -> [0xD1, 0x01, 0x02]
  const obj0 = Buffer.from([0xd1, 0x01, 0x02]);
  // Object 1: ASCII String "AppleLanguages" (len 14 -> 0x5E)
  const obj1 = Buffer.concat([Buffer.from([0x5e]), keyBytes]);
  // Object 2: Array (1 elem -> ref 3) -> [0xA1, 0x03]
  const obj2 = Buffer.from([0xa1, 0x03]);
  // Object 3: ASCII String langTag (len < 15)
  const obj3 = Buffer.concat([Buffer.from([0x50 + valBytes.length]), valBytes]);

  const header = Buffer.from('bplist00', 'ascii');
  const off0 = header.length;
  const off1 = off0 + obj0.length;
  const off2 = off1 + obj1.length;
  const off3 = off2 + obj2.length;
  const offsetTableStart = off3 + obj3.length;
  const offsetTable = Buffer.from([off0, off1, off2, off3]);

  const trailer = Buffer.alloc(32, 0);
  trailer[6] = 1; // offsetIntSize = 1
  trailer[7] = 1; // objectRefSize = 1
  trailer[15] = 4; // numObjects = 4
  trailer[23] = 0; // topObject = 0
  trailer[31] = offsetTableStart;

  return new Uint8Array(
    Buffer.concat([header, obj0, obj1, obj2, obj3, offsetTable, trailer]),
  );
}

describe('系统语言探测与标签分类', () => {
  test('classifyLocaleTag 与 parseLangPreference 覆盖常见编码及区域变体', () => {
    expect(classifyLocaleTag('zh-Hans-SG')).toBe('zh');
    expect(classifyLocaleTag('zh_CN.UTF-8')).toBe('zh');
    expect(classifyLocaleTag('zh-Hant-TW')).toBe('zh');
    expect(classifyLocaleTag('en_US.UTF-8')).toBe('en');
    expect(classifyLocaleTag('ja_JP.UTF-8')).toBe('en');
    expect(classifyLocaleTag('C.UTF-8')).toBeNull();
    expect(classifyLocaleTag('POSIX')).toBeNull();

    expect(parseLangPreference('system')).toBe('system');
    expect(parseLangPreference('EN')).toBe('en');
    expect(parseLangPreference('en-US')).toBe('en');
    expect(parseLangPreference('zh-CN')).toBe('zh');
    expect(parseLangPreference('zh-Hans')).toBe('zh');
    expect(parseLangPreference('mars')).toBeNull();
  });

  test('macOS bplist00 优先于终端 LC_ALL=en_US.UTF-8 识别出真实中文系统语言', () => {
    const home = makeTempDir();
    const prefsDir = join(home, 'Library', 'Preferences');
    mkdirSync(prefsDir, { recursive: true });
    const bplist = buildMinimalMacBplist('zh-Hans-SG');
    expect(extractMacPreferredLanguage(bplist)).toBe('zh-Hans-SG');

    writeFileSync(join(prefsDir, '.GlobalPreferences.plist'), bplist);
    const detected = detectSystemLocale({
      platform: 'darwin',
      homedir: home,
      env: { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
      allowSubprocess: false,
    });
    expect(detected).toEqual({
      locale: 'zh',
      rawTag: 'zh-Hans-SG',
      method: 'macos-prefs',
    });
  });

  test('macOS XML plist 与 Linux /etc/locale.conf 回退识别正常', () => {
    const home = makeTempDir();
    const prefsDir = join(home, 'Library', 'Preferences');
    mkdirSync(prefsDir, { recursive: true });
    writeFileSync(
      join(prefsDir, '.GlobalPreferences.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>AppleLanguages</key>
  <array><string>en-US</string><string>zh-Hans-US</string></array>
</dict></plist>`,
    );
    expect(
      detectSystemLocale({
        platform: 'darwin',
        homedir: home,
        env: { LANG: 'zh_CN.UTF-8' },
        allowSubprocess: false,
      }),
    ).toEqual({
      locale: 'en',
      rawTag: 'en-US',
      method: 'macos-prefs',
    });

    const etcDir = makeTempDir();
    writeFileSync(join(etcDir, 'locale.conf'), 'LANG="zh_CN.UTF-8"\n');
    expect(
      detectSystemLocale({
        platform: 'linux',
        homedir: home,
        etcDir,
        env: { LANG: 'C.UTF-8' },
        allowSubprocess: false,
      }),
    ).toEqual({
      locale: 'zh',
      rawTag: 'zh_CN.UTF-8',
      method: 'linux-conf',
    });
  });
});

describe('按工具独立持久化、四层优先级与 lang 子命令', () => {
  test('系统语言为中文时, 单工具自定义为 en 强制展示英文且不影响其他 CLI', () => {
    const home = makeTempDir();
    const prefsDir = join(home, 'Library', 'Preferences');
    mkdirSync(prefsDir, { recursive: true });
    writeFileSync(
      join(prefsDir, '.GlobalPreferences.plist'),
      buildMinimalMacBplist('zh-Hans-CN'),
    );

    const baseOpts = {
      platform: 'darwin' as const,
      homedir: home,
      env: { LC_ALL: 'en_US.UTF-8' },
    };

    // 默认均为 system -> 跟随 macOS 中文系统语言
    expect(resolveCliLocale({ ...baseOpts, toolName: 'fan' }).locale).toBe(
      'zh',
    );
    expect(resolveCliLocale({ ...baseOpts, toolName: 'sweep' }).locale).toBe(
      'zh',
    );

    // 将 fan 独立设为英文
    const lines: string[] = [];
    const code = runLangCommand({
      ...baseOpts,
      toolName: 'fan',
      binName: 'fan',
      argv: ['en'],
      color: { stdout: false, stderr: false },
      out: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Language Updated');
    expect(lines.join('\n')).toContain('Overrides Chinese system language');

    // fan 现为英文, 而 sweep 依旧保持默认 system (中文)
    const fanResolved = resolveCliLocale({ ...baseOpts, toolName: 'fan' });
    expect(fanResolved.locale).toBe('en');
    expect(fanResolved.preference).toBe('en');
    expect(fanResolved.source).toBe('config');

    const sweepResolved = resolveCliLocale({ ...baseOpts, toolName: 'sweep' });
    expect(sweepResolved.locale).toBe('zh');
    expect(sweepResolved.preference).toBe('system');

    // 环境变量与 --lang 旗标按优先级覆盖落盘配置
    expect(
      resolveCliLocale({
        ...baseOpts,
        toolName: 'fan',
        env: { CLIS_LANG: 'zh' },
      }).locale,
    ).toBe('zh');
    expect(
      resolveCliLocale({
        ...baseOpts,
        toolName: 'fan',
        env: { FAN_LANG: 'zh', CLIS_LANG: 'en' },
      }).locale,
    ).toBe('zh');
    expect(
      resolveCliLocale({
        ...baseOpts,
        toolName: 'fan',
        flag: 'zh',
        env: { FAN_LANG: 'en' },
      }).locale,
    ).toBe('zh');

    // 恢复 fan 为 system -> 重新跟随中文系统语言
    const resetLines: string[] = [];
    expect(
      runLangCommand({
        ...baseOpts,
        toolName: 'fan',
        binName: 'fan',
        argv: ['system'],
        color: { stdout: false, stderr: false },
        out: (line) => resetLines.push(line),
      }),
    ).toBe(0);
    expect(resetLines.join('\n')).toContain('已恢复跟随系统语言');
    expect(resolveCliLocale({ ...baseOpts, toolName: 'fan' }).locale).toBe(
      'zh',
    );
  });

  test('stripLangArgs 正确剥离 --lang / --lang=、尊重 -- 终止符与 valueFlags', () => {
    expect(
      stripLangArgs(['set', '50%', '--lang', 'en'], { fallbackLocale: 'zh' }),
    ).toEqual({
      argv: ['set', '50%'],
      lang: 'en',
    });
    expect(
      stripLangArgs(['--lang=zh', '--', '--lang', 'en'], {
        fallbackLocale: 'en',
      }),
    ).toEqual({
      argv: ['--', '--lang', 'en'],
      lang: 'zh',
    });
    expect(
      stripLangArgs(['--exclude', '--lang', '--yes'], {
        valueFlags: new Set(['--exclude']),
      }),
    ).toEqual({
      argv: ['--exclude', '--lang', '--yes'],
      lang: undefined,
    });
    expect(
      stripLangArgs(['--lang', 'bad'], { fallbackLocale: 'en' }).error,
    ).toContain('Invalid --lang value "bad"');
  });

  test('混排列宽与对齐补白无视 ANSI 转义码', () => {
    expect(displayWidth('\u001B[1m风扇状态\u001B[0m')).toBe(8);
    expect(displayWidth(padEndDisplay('手动', 8))).toBe(8);
    expect(displayWidth(padStartDisplay('Auto', 8))).toBe(8);
  });

  test('formatLangHelp 在不同 binName 与中英文下将用法与可选值右栏对齐到同一垂直列线', async () => {
    const { formatLangHelp } = await import('./lang-command.ts');
    for (const binName of ['fan', 'wake', 'create-clis']) {
      for (const locale of ['zh', 'en'] as const) {
        const text = formatLangHelp({
          binName,
          envVarName: `${binName.toUpperCase()}_LANG`,
          configPath: `/tmp/${binName}/lang.json`,
          locale,
          color: false,
        });
        const alignedHeadings = new Set(
          locale === 'zh' ? ['用法', '可选值'] : ['Usage', 'Values'],
        );
        let section = '';
        const cols = new Set<number>();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (/^  \S/.test(line)) {
            section = trimmed;
            continue;
          }
          if (!alignedHeadings.has(section) || trimmed === '') continue;
          const m = /^(    .+?)( {2,})(\S.*)$/.exec(line);
          expect(m, `${binName}/${locale} 应匹配两栏: ${line}`).not.toBeNull();
          cols.add(displayWidth(m![1]!.slice(4)) + m![2]!.length);
        }
        expect(cols.size, `${binName}/${locale} 右栏未对齐`).toBe(1);
      }
    }
  });
});
