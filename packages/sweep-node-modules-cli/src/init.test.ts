/**
 * 初始化向导测试: fake IO 脚本化答案, 钉死交互流与落盘契约。
 * 权威: config-and-initialization.md「配置初始化模型」与 ADR 0004。
 * 交互壳 createReadlineIO 属薄壳, 由 init.smoke.test.ts 双载体回归覆盖。
 */
import { describe, expect, test } from 'bun:test';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXCLUDE } from '@iyowei/sweep-node-modules';

import { type InitDeps, type InitIO, parseList, runInit } from './init.ts';

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
  };

  return { io, askCalls, confirmCalls, prints };
}

/** 组装被测 deps: 文件系统与 IO 全部 fake, 落盘只记录不写盘 */
function makeDeps(options: {
  /** configPath 是否存在 (覆盖保护分流) */
  configExists?: boolean;
  /** 非 configPath 路径的存在性谓词 (根校验); 缺省一律视为存在 */
  rootExists?: (path: string) => boolean;
  /** 根锚点链上首个符号链接的路径谓词 (删除侧同一判定); 缺省一律视为全链真目录 */
  rootLink?: (path: string) => string | null;
  /** 配置路径 (落盘目标) 锚点链上首个符号链接的路径谓词 (写入侧同一判定); 缺省一律视为全链真身 */
  targetLink?: (path: string) => string | null;
  asks?: (string | null)[];
  confirms?: boolean[];
  /** 着色开关 (缺省 false) */
  color?: boolean;
}) {
  const { io, askCalls, confirmCalls, prints } = makeFakeIO(options);
  const writes: { path: string; text: string }[] = [];
  const deps: InitDeps = {
    configPath: CONFIG_PATH,
    fileExists: async (path) =>
      path === CONFIG_PATH
        ? (options.configExists ?? false)
        : (options.rootExists?.(path) ?? true),
    firstSymlinkOnRoot: async (path) => options.rootLink?.(path) ?? null,
    firstSymlinkOnTarget: async (path) => options.targetLink?.(path) ?? null,
    writeFile: async (path, text) => {
      writes.push({ path, text });
    },
    io,
  };

  return { deps, writes, askCalls, confirmCalls, prints };
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
        roots: ['/a', '/b', '/c'],
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
    const { deps, askCalls, prints } = makeDeps({
      rootExists: (path) => path === '/ok',
      asks: ['/missing-a /missing-b', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: { roots: ['/ok'], exclude: [...DEFAULT_EXCLUDE], include: [] },
    });
    expect(prints).toContain('  ✗ 根不存在: /missing-a');
    expect(prints).toContain('  ✗ 根不存在: /missing-b');
    // 根问了两次 (重问), 加排除与包含名单各一次, 共四次
    expect(askCalls).toHaveLength(4);
    expect(askCalls[1]!.question).toBe(askCalls[0]!.question);
  });

  test('根不存在提示经净化: 控制字节不入终端 (与清单面同一源实现)', async () => {
    const { deps, prints } = makeDeps({
      rootExists: (path) => path !== 'evil\u001b[2Jroot\u202e',
      asks: ['evil\u001b[2Jroot\u202e /ok', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    // 回显行里的 ESC (清屏序列引导) 与 RLO (视觉反转) 被剥除, 只剩可读文本;
    // 未净化时该行会把控制字节直写终端, 并可能把后续内容覆盖成伪造的可信输出
    expect(prints).toContain('  \u2717 根不存在: evil[2Jroot');
    expect(prints.some((line) => line.includes('\u001b'))).toBe(false);
    expect(prints.some((line) => line.includes('\u202e'))).toBe(false);
  });
  test('根落在符号链接路径上: 提示后重问该问, 坏输入不进配置', async () => {
    const { deps, askCalls, prints } = makeDeps({
      // 删除侧判在配置拼写上: 根自身或祖先链任一级为符号链接即拒 (/tmp 是 macOS 的系统固有链接)
      rootLink: (path) => (path === '/tmp/x' ? '/tmp' : null),
      asks: ['/tmp/x', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: { roots: ['/ok'], exclude: [...DEFAULT_EXCLUDE], include: [] },
    });
    // 提示点明删除侧要求真实路径与改写方向 (整批拒绝在删除侧才发生, 向导当场暴露它)
    expect(prints).toContain(
      '  ✗ 根锚点链上有符号链接: /tmp (根: /tmp/x); 删除侧要求真实路径, 改写为不含符号链接的形态 (macOS 上如 /tmp/x 写成 /private/tmp/x)',
    );
    // 根问了两次 (重问), 加排除与包含名单各一次, 共四次
    expect(askCalls).toHaveLength(4);
    expect(askCalls[1]!.question).toBe(askCalls[0]!.question);
  });

  test('根不存在时不叠报形态问题: 同一根只给一条提示', async () => {
    const { deps, prints } = makeDeps({
      rootExists: (path) => path === '/ok',
      rootLink: (path) => (path === '/var/ghost' ? '/var' : null),
      asks: ['/var/ghost', '/ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(prints).toContain('  ✗ 根不存在: /var/ghost');
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
describe('runInit: 落盘前锚点检查 (写入侧)', () => {
  test('配置路径自身是符号链接: 拒绝写入并重问该问; 用户改答「否」即取消, 不落盘', async () => {
    const { deps, writes, confirmCalls, prints } = makeDeps({
      // 写入侧判在配置拼写上 (写入会跟随链接改写其目标): 链接位置即配置路径自身
      targetLink: (path) => (path === CONFIG_PATH ? '/var' : null),
      asks: ['/root', '', ''],
      // 第一次确认写入被拒, 重问该问后用户放弃
      confirms: [true, false],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    expect(confirmCalls).toHaveLength(2);
    // 拒绝文案与根校验同形 (红色 ✗ + 链接定位 + 改写指引), 点明写入侧为何要拒
    expect(prints).toContain(
      `  ✗ 配置路径锚点链上有符号链接: /var (配置: ${CONFIG_PATH}); 写入会跟随符号链接改写其目标, 改写为不含符号链接的形态 (macOS 上如 /tmp/x 写成 /private/tmp/x)`,
    );
    expect(prints).toContain('已取消, 未写入配置');
  });

  test('悬空链接的配置路径: 判重先出覆盖一问, 随后才在写入面被拒 (两问先后)', async () => {
    const { deps, writes, confirmCalls, prints } = makeDeps({
      // 判重取 lstat 语义 (不跟进末段): 悬空链接同样算「已存在」, 故先经过覆盖一问
      configExists: true,
      // 悬空链接在锚点判定里同样命中 (lstat 不跟进末段, 链接自身即结果)
      targetLink: (path) => (path === CONFIG_PATH ? CONFIG_PATH : null),
      asks: ['/root', '', ''],
      // 覆盖确认 (y) → 写入确认 (y, 随即被拒) → 重问该问时放弃
      confirms: [true, true, false],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    // 两问先后: 覆盖一问在前 (判重把悬空链接算作已存在), 写入确认在后, 被拒后重问同问
    expect(confirmCalls).toHaveLength(3);
    expect(confirmCalls[0]!.question).toContain('覆盖');
    expect(confirmCalls[1]!.question).toBe('确认写入?');
    expect(confirmCalls[2]!.question).toBe('确认写入?');
    // 写入面被拒的定位报的是链接自身 (与「配置路径自身是符号链接」同形) 与配置拼写
    expect(prints).toContain(
      `  ✗ 配置路径锚点链上有符号链接: ${CONFIG_PATH} (配置: ${CONFIG_PATH}); 写入会跟随符号链接改写其目标, 改写为不含符号链接的形态 (macOS 上如 /tmp/x 写成 /private/tmp/x)`,
    );
  });

  test('配置路径的父目录某级是符号链接: 同样拒绝, 定位报的是该级', async () => {
    const parent = join(homedir(), '.config', 'sweep-node-modules');
    const { deps, writes, confirmCalls, prints } = makeDeps({
      targetLink: (path) => (path === CONFIG_PATH ? parent : null),
      asks: ['/root', '', ''],
      confirms: [true, false],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'cancelled' });
    expect(writes).toHaveLength(0);
    expect(confirmCalls).toHaveLength(2);
    expect(
      prints.some(
        (line) =>
          line.includes('配置路径锚点链上有符号链接: ') &&
          line.includes(parent),
      ),
    ).toBe(true);
  });

  test('拒绝后重问: 路径锚点转好后同一轮照常落盘 (重问不吞已收集的答案)', async () => {
    let calls = 0;
    const { deps, writes, confirmCalls } = makeDeps({
      // 首次判得链接, 第二次判得全链真身 (模拟路径在重问之间被修正)
      targetLink: () => {
        calls += 1;
        return calls === 1 ? '/var' : null;
      },
      asks: ['/root', '', ''],
      confirms: [true, true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(writes).toHaveLength(1);
    expect(confirmCalls).toHaveLength(2);
  });

  test('正常路径: 锚点判定收到的正是配置拼写, 通过后不额外提问', async () => {
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
    // 判在用户给的拼写上 (与写盘同一坐标), 不做 realpath 归一再判
    expect(probed).toEqual([CONFIG_PATH]);
    expect(confirmCalls).toHaveLength(1);
  });

  test('锚点拒绝行经净化: 控制字节不入终端 (与其余外部数据回显同一源实现)', async () => {
    const { deps, prints } = makeDeps({
      targetLink: () => '/var/evil\u001b[2Jlink\u202e',
      asks: ['/root', '', ''],
      confirms: [true, false],
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
    const { deps, writes, askCalls, prints } = makeDeps({
      configExists: true,
      confirms: [false],
    });

    const result = await runInit(deps);

    expect(result).toEqual({ state: 'declined-overwrite' });
    expect(writes).toHaveLength(0);
    expect(askCalls).toHaveLength(0);
    // 除开场顶栏外不再输出任何行 (取消分支不新造视觉)
    expect(prints).toEqual(['▍ SWEEP-NM  初始化向导']);
  });
});

describe('parseList: 答案解析', () => {
  test('空串与全空白回落 fallback', () => {
    expect(parseList('', ['/default'])).toEqual(['/default']);
    expect(parseList('   \t ', ['/default'])).toEqual(['/default']);
    expect(parseList('', [])).toEqual([]);
  });

  test('null (取消态) 回落 fallback', () => {
    expect(parseList(null, ['/default'])).toEqual(['/default']);
    expect(parseList(null, [])).toEqual([]);
  });

  test('逗号分隔: 半角与全角均成立', () => {
    expect(parseList('/a,/b', [])).toEqual(['/a', '/b']);
    expect(parseList('/a，/b', [])).toEqual(['/a', '/b']);
  });

  test('空白分隔: 多空格 / 制表符 / 首尾空白', () => {
    expect(parseList('  /a   /b\t/c  ', [])).toEqual(['/a', '/b', '/c']);
  });

  test('混合分隔与空项过滤', () => {
    expect(parseList(', /a ,, /b ,', [])).toEqual(['/a', '/b']);
  });

  test('中文路径不被破坏', () => {
    expect(
      parseList('/Users/iyowei/我的文档，/Users/iyowei/项目数据', []),
    ).toEqual(['/Users/iyowei/我的文档', '/Users/iyowei/项目数据']);
  });

  test('成对引号: 空格与逗号保留, 引号本身剥离', () => {
    expect(parseList('"/tmp/My Projects"', [])).toEqual(['/tmp/My Projects']);
    expect(parseList('"/tmp/a, b"', [])).toEqual(['/tmp/a, b']);
    expect(parseList("'/tmp/a b' /c", [])).toEqual(['/tmp/a b', '/c']);
  });

  test('未配对引号按普通字符处理, 不吞后续内容', () => {
    expect(parseList('/a "b c', [])).toEqual(['/a', '"b', 'c']);
  });

  test('~ 展开为家目录 (含引号内的 ~ 与 win32 习惯的 ~\\)', () => {
    expect(parseList('~', [])).toEqual([homedir()]);
    expect(parseList('~/lab', [])).toEqual([join(homedir(), 'lab')]);
    expect(parseList('~\\lab', [])).toEqual([join(homedir(), 'lab')]);
    expect(parseList('"~/My Projects" ~/lab', [])).toEqual([
      join(homedir(), 'My Projects'),
      join(homedir(), 'lab'),
    ]);
  });
});
