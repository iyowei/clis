/**
 * 初始化向导测试: fake IO 脚本化答案, 钉死交互流与落盘契约。
 * 权威: config-and-initialization.md「配置初始化模型」与 ADR 0004。
 * 交互壳 createReadlineIO 属薄壳, 由 init.smoke.test.ts 双载体回归覆盖。
 */
import { describe, expect, test } from 'bun:test';

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_EXCLUDE } from '@iyowei/sweep-node-modules';

import { type InitDeps, type InitIO, runInit } from './init.ts';

// 配置路径取真实家目录之下: 断言依赖「路径 ∈ 家目录 → 输出缩写为 ~」的坐标关系, 不得写死任一平台的
// 家目录字面量 (写死 macOS 路径在 Linux runner 上无法触发缩写, CI 实测命中)
const CONFIG_PATH = join(
  homedir(),
  '.config',
  'sweep-node-modules',
  'config.json',
);

/** 脚本化的 fake IO: 按序弹出预设答案; 脚本耗尽即抛错, 防漏配答案静默退化成取消态 */
function makeFakeIO(script: {
  asks?: (string | null)[];
  confirms?: boolean[];
  /** 着色开关 (缺省 false): 逐字断言钉降级形态, 着色用例单独翻 true */
  color?: boolean;
}) {
  const askCalls: { question: string; hint?: string }[] = [];
  const confirmCalls: { question: string; defaultYes: boolean }[] = [];
  const prints: string[] = [];
  let closeCalls = 0;
  const pendingAsks = [...(script.asks ?? [])];
  const pendingConfirms = [...(script.confirms ?? [])];

  const io: InitIO = {
    color: script.color ?? false,
    async ask(question, hint) {
      askCalls.push({ question, hint });
      if (pendingAsks.length === 0)
        throw new Error('fake IO: ask 答案脚本已耗尽');
      return pendingAsks.shift()!;
    },
    async confirm(question, defaultYes) {
      confirmCalls.push({ question, defaultYes });
      if (pendingConfirms.length === 0)
        throw new Error('fake IO: confirm 答案脚本已耗尽');
      return pendingConfirms.shift()!;
    },
    print(line) {
      prints.push(line);
    },
    close() {
      closeCalls += 1;
    },
  };

  return {
    io,
    askCalls,
    confirmCalls,
    prints,
    getCloseCalls: () => closeCalls,
  };
}

/** 组装被测 deps: 文件系统与 IO 全部 fake, 落盘只记录不写盘 */
function makeDeps(options: {
  /** configPath 是否存在 (覆盖保护分流) */
  configExists?: boolean;
  /** configPath 是否为既有目录 (前置与落盘前拦截 EISDIR) */
  configIsDirectory?: boolean;
  /** 非 configPath 路径的存在性谓词 (根校验); 缺省一律视为存在 */
  rootExists?: (path: string) => boolean;
  /** 根是否为目录谓词 (拦截普通文件); 缺省与 rootExists 同真 */
  rootIsDirectory?: (path: string) => boolean;
  /** 根锚点链上首个符号链接的路径谓词 (删除侧同一判定); 缺省一律视为全链真目录 */
  rootLink?: (path: string) => string | null;
  /** 配置路径 (落盘目标) 锚点链上首个符号链接的路径谓词 (写入侧同一判定); 缺省一律视为全链真身 */
  targetLink?: (path: string) => string | null;
  /** 注入家目录; 缺省走 os.homedir() */
  home?: string;
  asks?: (string | null)[];
  confirms?: boolean[];
  /** 着色开关 (缺省 false) */
  color?: boolean;
}) {
  const { io, askCalls, confirmCalls, prints, getCloseCalls } =
    makeFakeIO(options);
  const writes: { path: string; text: string }[] = [];
  const deps: InitDeps = {
    configPath: CONFIG_PATH,
    configExists: async () => options.configExists ?? false,
    configIsDirectory: async () => options.configIsDirectory ?? false,
    rootExists: async (path) => options.rootExists?.(path) ?? true,
    rootIsDirectory: async (path) =>
      options.rootIsDirectory?.(path) ?? options.rootExists?.(path) ?? true,
    firstSymlinkOnRoot: async (path) => options.rootLink?.(path) ?? null,
    firstSymlinkOnTarget: async (path) => options.targetLink?.(path) ?? null,
    writeFile: async (path, text) => {
      writes.push({ path, text });
    },
    home: options.home,
    io,
  };

  return { deps, writes, askCalls, confirmCalls, prints, getCloseCalls };
}

describe('runInit: written 路径', () => {
  test('开场提示 + 空答取默认根与默认排除名单; 回显后默认确认写入', async () => {
    const { deps, writes, askCalls, confirmCalls, prints } = makeDeps({
      asks: ['', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    // 空答的排除名单取内置默认名单: 显式写出的 exclude 会接管默认值, 回填空数组即等于「一路回车丢保护」
    const expected = {
      roots: [homedir()],
      exclude: [...DEFAULT_EXCLUDE],
      include: [],
    };
    expect(result).toEqual({ state: 'written', config: expected });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(CONFIG_PATH);
    expect(writes[0]!.text).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    // 默认值提示经家目录缩写 (homedir 自身即缩写为 ~), 且缩写在前、净化在后 (与其余回显面同一坐标);
    // 该表达式的取值恒为 ~, 其上游不存在可达的控制字节输入, 故此处钉的是坐标形态 (净化本身在该处
    // 无可观测改写, 是纵深防御而非当前生效的剥除面); 排除一问的提示点明空答取默认名单与条数
    expect(askCalls[0]!.hint).toBe('默认: ~');
    expect(askCalls[1]!.hint).toBe(
      `回车采用默认名单 (${DEFAULT_EXCLUDE.length} 条)`,
    );
    // 顶栏先出; 开场一句作中性提示行, 回显解析结果在确认前可见, 收尾落盘回执
    expect(prints[0]).toBe('▍ SWEEP-NM  初始化向导');
    expect(prints[1]).toBe('  ░ 首次使用, 先确定扫描范围');
    expect(prints).toContain(
      `  ░ 将写入 1 个扫描根 · 排除 ${DEFAULT_EXCLUDE.length} 条 · 包含 0 条`,
    );
    // 落盘回执: 成功标记 + 家目录缩写 (降级态只去色码);
    // 随后回显落盘 JSON 全文 (内容与文件逐字一致, 整体加两空格缩进与其余行同左缘)
    expect(prints).toContain(
      '  配置已写入: ~/.config/sweep-node-modules/config.json  ✓',
    );
    expect(prints).toContain(
      JSON.stringify(expected, null, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    // 写入确认为最后一问且默认 Y
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.defaultYes).toBe(true);
  });

  test('逗号与空白混用的多根, 排除名单非空; 回显两侧解析结果', async () => {
    const { deps, writes, prints } = makeDeps({
      asks: ['/a, /b  /c', 'dist, coverage', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: {
        roots: [resolve('/a'), resolve('/b'), resolve('/c')],
        exclude: ['dist', 'coverage'],
        include: [],
      },
    });
    expect(writes).toHaveLength(1);
    expect(prints).toContain('  ░ 将写入 3 个扫描根 · 排除 2 条 · 包含 0 条');
  });

  test('已存在配置且确认覆盖: 覆盖确认默认否, 写入确认默认 Y', async () => {
    const { deps, writes, confirmCalls } = makeDeps({
      configExists: true,
      confirms: [true, true],
      asks: ['/root', '', ''],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[0]!.defaultYes).toBe(false);
    expect(confirmCalls[0]!.question).toContain('覆盖');
    expect(confirmCalls[1]!.defaultYes).toBe(true);
    expect(writes).toHaveLength(1);
  });

  test('根不存在: 逐个提示后重问该问, 坏输入不进配置', async () => {
    const okRoot = resolve('/ok');
    const { deps, askCalls, prints } = makeDeps({
      rootExists: (path) => path === okRoot,
      asks: ['/missing-a /missing-b', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: {
        roots: [okRoot],
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
      },
    });
    expect(prints).toContain(`  ✗ 根不存在: ${resolve('/missing-a')}`);
    expect(prints).toContain(`  ✗ 根不存在: ${resolve('/missing-b')}`);
    // 根问了两次 (重问), 加排除与包含名单各一次, 共四次
    expect(askCalls).toHaveLength(4);
    expect(askCalls[1]!.question).toBe(askCalls[0]!.question);
  });

  test('根不存在提示经净化: 控制字节不入终端 (与清单面同一源实现)', async () => {
    const evilAbs = resolve('/evil\u001b[2Jroot\u202e');
    const { deps, prints } = makeDeps({
      rootExists: (path) => path !== evilAbs,
      asks: ['/evil\u001b[2Jroot\u202e /ok', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    // 回显行里的 ESC (清屏序列引导) 与 RLO (视觉反转) 被剥除, 只剩可读文本;
    expect(
      prints.some(
        (line) =>
          line.includes('  \u2717 根不存在: ') && line.includes('evil[2Jroot'),
      ),
    ).toBe(true);
    expect(prints.some((line) => line.includes('\u001b'))).toBe(false);
    expect(prints.some((line) => line.includes('\u202e'))).toBe(false);
  });
  test('根落在符号链接路径上: 提示后重问该问, 坏输入不进配置', async () => {
    const tmpX = resolve('/tmp/x');
    const { deps, askCalls, prints } = makeDeps({
      // 删除侧判在配置拼写上: 根自身或祖先链任一级为符号链接即拒 (/tmp 是 macOS 的系统固有链接)
      rootLink: (path) => (path === tmpX ? '/tmp' : null),
      asks: ['/tmp/x', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: {
        roots: [resolve('/ok')],
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
      },
    });
    // 提示点明删除侧要求真实路径与改写方向 (整批拒绝在删除侧才发生, 向导当场暴露它)
    expect(prints).toContain(
      `  ✗ 根锚点链上有符号链接: /tmp (根: ${tmpX}); 删除侧要求真实路径, 改写为不含符号链接的形态 (macOS 上如 /tmp/x 写成 /private/tmp/x)`,
    );
    // 根问了两次 (重问), 加排除与包含名单各一次, 共四次
    expect(askCalls).toHaveLength(4);
    expect(askCalls[1]!.question).toBe(askCalls[0]!.question);
  });

  test('根不存在时不叠报形态问题: 同一根只给一条提示', async () => {
    const okRoot = resolve('/ok');
    const ghostRoot = resolve('/var/ghost');
    const { deps, prints } = makeDeps({
      rootExists: (path) => path === okRoot,
      rootLink: (path) => (path === ghostRoot ? '/var' : null),
      asks: ['/var/ghost', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(prints).toContain(`  ✗ 根不存在: ${ghostRoot}`);
    expect(prints.some((line) => line.includes('根锚点链上有符号链接'))).toBe(
      false,
    );
  });

  test('着色开关只改色码: 剥去 ANSI 后与降级态逐字一致', async () => {
    const script = { asks: ['', '', ''], confirms: [true] };
    const plain = makeDeps(script);
    const colored = makeDeps({ ...script, color: true });

    await runInit(plain.deps);
    await runInit(colored.deps);

    expect(colored.prints.some((line) => line.includes('\x1b['))).toBe(true);
    const strip = (line: string): string =>
      // 有意匹配 ANSI 控制序列: 剥去色码正是本断言的职责, 非误用
      // eslint-disable-next-line no-control-regex
      line.replace(/\x1b\[[0-9;]*m/g, '');
    expect(colored.prints.map(strip)).toEqual(plain.prints);
  });
});
describe('runInit: 前置配置路径检查与落盘前 TOCTOU 复检 (SWEEPCLI-P0-3)', () => {
  test('前置拦截: 配置路径是既有目录时零询问直接拒绝, 防 EISDIR', async () => {
    const { deps, writes, askCalls, confirmCalls, prints } = makeDeps({
      configExists: true,
      configIsDirectory: true,
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    expect(askCalls).toHaveLength(0);
    expect(confirmCalls).toHaveLength(0);
    expect(prints.some((line) => line.includes('配置路径是既有目录'))).toBe(
      true,
    );
    expect(prints).toContain('已取消, 未写入配置');
  });

  test('前置拦截: 配置路径或祖先链已含符号链接 (含悬空链接) 时进入三问前直接拒绝', async () => {
    const parent = join(homedir(), '.config', 'sweep-node-modules');
    for (const [label, link] of [
      ['自身', CONFIG_PATH],
      ['祖先', parent],
      ['系统软链', '/var'],
    ] as const) {
      const { deps, writes, askCalls, confirmCalls, prints } = makeDeps({
        configExists: label === '自身',
        targetLink: (path) => (path === CONFIG_PATH ? link : null),
      });

      const result = await runInit(deps);

      expect(result).toEqual({ state: 'cancelled' });
      expect(writes).toHaveLength(0);
      expect(askCalls).toHaveLength(0);
      expect(confirmCalls).toHaveLength(0);
      expect(prints).toContain(
        `  ✗ 配置路径锚点链上有符号链接: ${link} (配置: ${CONFIG_PATH}); 写入会跟随符号链接改写其目标, 改写为不含符号链接的形态 (macOS 上如 /tmp/x 写成 /private/tmp/x)`,
      );
      expect(prints).toContain('已取消, 未写入配置');
    }
  });

  test('落盘前 TOCTOU 复检: 问答期间路径出现软链时拒写, 重问默认降为 false (y/N) 防死循环', async () => {
    let calls = 0;
    const { deps, writes, confirmCalls, prints } = makeDeps({
      // 首次 (前置检查) 全链真身; 第二次 (确认写入后 TOCTOU 复检) 检出软链
      targetLink: () => {
        calls += 1;
        return calls === 1 ? null : '/var';
      },
      asks: ['/root', '', ''],
      confirms: [true, false],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[0]!.defaultYes).toBe(true);
    expect(confirmCalls[1]!.defaultYes).toBe(false);
    expect(prints).toContain('已取消, 未写入配置');
  });

  test('落盘前 TOCTOU 拒绝后重问: 锚点恢复真身后照常落盘 (不吞已收集答案)', async () => {
    let calls = 0;
    const { deps, writes, confirmCalls } = makeDeps({
      // 1=前置通过, 2=首次落盘前检出软链, 3=修正后复检通过
      targetLink: () => {
        calls += 1;
        return calls === 2 ? '/var' : null;
      },
      asks: ['/root', '', ''],
      confirms: [true, true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(writes).toHaveLength(1);
    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[0]!.defaultYes).toBe(true);
    expect(confirmCalls[1]!.defaultYes).toBe(false);
  });

  test('正常路径: 前置与落盘前均校验配置拼写, 通过后只问一次确认写入', async () => {
    const probed: string[] = [];
    const { deps, writes, confirmCalls } = makeDeps({
      targetLink: (path) => {
        probed.push(path);
        return null;
      },
      asks: ['/root', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(writes).toHaveLength(1);
    expect(probed).toEqual([CONFIG_PATH, CONFIG_PATH]);
    expect(confirmCalls).toHaveLength(1);
  });

  test('锚点拒绝行经净化: 控制字节不入终端 (与其余外部数据回显同一源实现)', async () => {
    const { deps, prints } = makeDeps({
      targetLink: () => '/var/evil\u001b[2Jlink\u202e',
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(
      prints.some((line) =>
        line.includes('配置路径锚点链上有符号链接: /var/evil[2Jlink'),
      ),
    ).toBe(true);
    expect(prints.some((line) => line.includes('\u001b'))).toBe(false);
    expect(prints.some((line) => line.includes('\u202e'))).toBe(false);
  });
});

describe('runInit: cancelled 路径 (统一措辞, 均不落盘)', () => {
  test('扫描根一问取消', async () => {
    const { deps, writes, prints } = makeDeps({ asks: [null] });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    expect(prints).toContain('已取消, 未写入配置');
  });

  test('排除名单一问取消', async () => {
    const { deps, writes, askCalls, prints } = makeDeps({
      asks: ['/root', null],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    expect(askCalls).toHaveLength(2);
    expect(prints).toContain('已取消, 未写入配置');
  });

  test('回显确认被拒: 同一措辞, 不落盘', async () => {
    const { deps, writes, confirmCalls, prints } = makeDeps({
      asks: ['/a', '', ''],
      confirms: [false],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    expect(confirmCalls[0]!.defaultYes).toBe(true);
    expect(prints).toContain('已取消, 未写入配置');
  });
});

describe('runInit: declined-overwrite 路径', () => {
  test('拒绝覆盖 (默认否): 不落盘, 不再提问, 不打印取消措辞', async () => {
    const { deps, writes, askCalls, prints, getCloseCalls } = makeDeps({
      configExists: true,
      confirms: [false],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'declined-overwrite' });
    expect(writes).toHaveLength(0);
    expect(askCalls).toHaveLength(0);
    // 除开场顶栏外不再输出任何行 (取消分支不新造视觉)
    expect(prints).toEqual(['▍ SWEEP-NM  初始化向导']);
    expect(getCloseCalls()).toBe(1);
  });
});
