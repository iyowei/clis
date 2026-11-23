/**
 * 差分模糊测试 · 确定性生成器、规范深比较与通用不变量校验 (纯函数, 零 IO, 零领域硬编码)。
 *
 * 上游: `scripts/transcription/run-diff-fuzz.ts` 按包级 `fuzz-targets.json` 调度本模块生成对抗输入;
 * 下游: 生成的 args 数组封装为 API harness `{ steps }` 指令, 回包由本模块做不变量校验与双实现深等价比对。
 */
import type { InvariantName } from './fuzz-invariants.ts';

export {
  type HarnessOutcome,
  type InvariantName,
  canonicalJson,
  checkInvariants,
  comparableOutcome,
  hasForbiddenControlChar,
} from './fuzz-invariants.ts';

/** 单个模糊测试目标声明 (对应包级 `conformance/fuzz-targets.json` 中的一项) */
export interface FuzzTargetSpec {
  id: string;
  export: string;
  generator: GeneratorName;
  invariants?: InvariantName[];
  generatorOptions?: Record<string, unknown>;
  description?: string;
}

/** 配置文件顶层结构 (`fuzz-targets.json`) */
export interface FuzzConfig {
  schemaVersion: 1;
  targets: FuzzTargetSpec[];
}

export type GeneratorName =
  | 'dirty-line'
  | 'indented-dirty-line'
  | 'byte-size'
  | 'rule-match'
  | 'config-path-options'
  | 'name-lists'
  | 'v1-config-raw'
  | 'xdg-path'
  | 'classify-target'
  | 'rule-leaf-match'
  | 'older-than-days'
  | 'safe-target-leaf'
  | 'inside-any-root';

/** Park-Miller / Lehmer 确定性伪随机数生成器 (零位运算): 同 seed 跨运行时/跨平台产出严格一致的 [0, 1) 序列 */
export function createPrng(seed: number): () => number {
  const MOD = 2147483647;
  let state = (Math.abs(Math.trunc(seed)) % (MOD - 1)) + 1;
  return (): number => {
    state = (state * 48271) % MOD;
    return (state - 1) / (MOD - 1);
  };
}

const pick = <T>(rng: () => number, list: readonly T[]): T =>
  list[Math.floor(rng() * list.length)]!;

const randInt = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

// ---------------------------------------------------------------------------
// 结构化对抗输入生成器 (前若干条固定高危边缘样本, 其余为确定性随机组合; 枚举以 GeneratorName 为准)
// ---------------------------------------------------------------------------

const DIRTY_ATOMS = [
  'alpha',
  '路径',
  'emoji🚀',
  '\u001b[31mred\u001b[0m',
  '\u001b[2J',
  '\u001b]0;title\u0007',
  '\u202espoof',
  '\u2066bidi\u2069',
  '\u200b\ufeff',
  '\x00\x01\x08\x0b\x0c\x1f\x7f',
  '\u0085\u009b',
  '\n',
  '\r\n',
  '\t',
  '   ',
  '\u00a0',
  'a/b/c',
] as const;

const DIRTY_EDGES = [
  '',
  '   \t\n\r  ',
  '\u001b[31m\u202e\x00\x7f\ufeff',
  'plain-ascii-123',
  '  leading\tand\nmultiline\r\n  ',
  '\u001b[2Jevil\n\tpath\u202espoof ',
  '中文目录/含 空格/🚀test\u200b',
] as const;

function genDirtyLine(rng: () => number, index: number): unknown[] {
  if (index < DIRTY_EDGES.length) return [DIRTY_EDGES[index]!];
  const parts: string[] = [];
  const count = randInt(rng, 1, 10);
  for (let i = 0; i < count; i += 1) parts.push(pick(rng, DIRTY_ATOMS));
  return [parts.join('')];
}

function genIndentedDirtyLine(rng: () => number, index: number): unknown[] {
  const [raw] = genDirtyLine(rng, index) as [string];
  const indents = ['', ' ', '  ', '\t', ' \t '];
  return [`${pick(rng, indents)}${raw}`];
}

const BYTE_EDGES = [
  0,
  1,
  512,
  1023,
  1024,
  1025,
  1536,
  1024 * 1024 - 1,
  1024 * 1024,
  1024 ** 3,
  1024 ** 4,
  1024 ** 5,
  0.4,
  0.5,
  1023.4,
  1023.6,
  -0,
  -1,
  -1024,
] as const;

function genByteSize(rng: () => number, index: number): unknown[] {
  if (index < BYTE_EDGES.length) return [BYTE_EDGES[index]!];
  const exp = randInt(rng, 0, 5);
  const base = 1024 ** exp;
  return [Math.floor(rng() * base * 2)];
}

const RULE_EDGES = [
  '',
  ' ',
  '.',
  '..',
  '.git',
  '*',
  '**',
  '***',
  '?',
  '???',
  '*.*',
  '.*',
  '*?',
  ' *.log',
  '*.log ',
  'a/b',
  'a\\b',
  'foo\x00bar',
  'foo\nbar',
  'foo\x7fbar',
  '*.log',
  'build-*',
  'cache_?.tmp',
  '.DS_Store',
  'dist',
] as const;

function genRuleMatch(rng: () => number, index: number): unknown[] {
  if (index < RULE_EDGES.length) return [RULE_EDGES[index]!];
  const tokens = [
    '*',
    '?',
    '.',
    'log',
    'tmp',
    'build',
    '-',
    '_',
    '/',
    '\\',
    ' ',
    '\x1b',
    'cache',
  ];
  const count = randInt(rng, 1, 5);
  let out = '';
  for (let i = 0; i < count; i += 1) out += pick(rng, tokens);
  return [out];
}

function genConfigPathOptions(
  rng: () => number,
  index: number,
  opts?: Record<string, unknown>,
): unknown[] {
  const envVar =
    typeof opts?.envVar === 'string' && opts.envVar !== ''
      ? opts.envVar
      : 'APP_CONFIG';
  const platforms = ['darwin', 'linux', 'win32'] as const;
  const homes = ['/Users/alice', '/home/bob', 'C:\\Users\\alice'] as const;
  const flags = [undefined, '', '/custom/cfg.json', 'C:\\cfg\\custom.json'];
  const envVals = [undefined, '', '/env/cfg.json', 'D:\\env\\cfg.json'];
  const appDatas = [undefined, '', 'C:\\Users\\alice\\AppData\\Roaming'];
  const profiles = [undefined, '', 'C:\\Users\\alice'];

  const platform = platforms[index % platforms.length]!;
  const flag = pick(rng, flags);
  const envVal = pick(rng, envVals);
  const env: Record<string, string> = {};
  if (envVal !== undefined) env[envVar] = envVal;
  const appData = pick(rng, appDatas);
  if (appData !== undefined) env.APPDATA = appData;
  const userProfile = pick(rng, profiles);
  if (userProfile !== undefined) env.USERPROFILE = userProfile;

  return [
    {
      ...(flag !== undefined ? { flag } : {}),
      platform,
      homedir: pick(rng, homes),
      env,
    },
  ];
}

function genNameLists(rng: () => number): unknown[] {
  const pool = '.git|dist|build|cache|.cache|Build|中文目录|a|b|temp'.split(
    '|',
  );
  const makeList = (): string[] => {
    const len = randInt(rng, 0, 6);
    const arr: string[] = [];
    for (let i = 0; i < len; i += 1) arr.push(pick(rng, pool));
    return arr;
  };
  return [makeList(), makeList()];
}

const V1_EDGES: readonly unknown[] = [
  null,
  [],
  'string',
  42,
  {},
  { roots: [] },
  { roots: [''] },
  { roots: ['/work'], version: 1 },
  { roots: ['/work'], version: 2 },
  { roots: ['/work'], version: 3 },
  { roots: ['/work'], unknownKey: true },
  { roots: ['/work'], exclude: ['dist'], include: ['app'] },
  { roots: ['/work'], exclude: 'not-array' },
  { roots: ['/work'], include: [123] },
];

function genV1ConfigRaw(rng: () => number, index: number): unknown[] {
  if (index < V1_EDGES.length) return [V1_EDGES[index], '/mock/home'];
  const candidate: Record<string, unknown> = {};
  if (rng() > 0.2) candidate.roots = rng() > 0.2 ? ['/work/a', '/work/b'] : [];
  if (rng() > 0.5) candidate.version = pick(rng, [1, 2, 99, '1']);
  if (rng() > 0.5) candidate.exclude = pick(rng, [[], ['dist', '.git'], 'bad']);
  if (rng() > 0.5) candidate.include = pick(rng, [[], ['app'], [1]]);
  if (rng() > 0.7) candidate.extraField = true;
  return [candidate, '/mock/home'];
}

const XDG_EDGES = [
  '/home/user/file.txt',
  '/home/user/with space/a%20b#c?d&e=f',
  '/tmp/中文目录/火箭🚀.log',
  'relative/path/item',
  '/a/b/./../c',
  '',
] as const;

function genXdgPath(rng: () => number, index: number): unknown[] {
  if (index < XDG_EDGES.length) return [XDG_EDGES[index]!];
  const segs = [
    'work',
    'my dir',
    'a%b',
    'x#y?z',
    '项目',
    '🚀',
    'foo+bar',
    '(test)',
    'a~b-c_d.e',
  ];
  const depth = randInt(rng, 1, 5);
  const parts: string[] = [];
  for (let i = 0; i < depth; i += 1) parts.push(pick(rng, segs));
  return [`/${parts.join('/')}`];
}

const CLASSIFY_EDGES: readonly [string, boolean, string][] = [
  [
    'C:\\Users\\alice\\AppData\\Local\\Temp\\work\\node_modules',
    true,
    'C:\\Users\\alice',
  ],
  [
    'C:\\Users\\alice\\AppData\\Local\\Temp\\npm-cache\\_npx\\a\\node_modules',
    true,
    'C:\\Users\\alice',
  ],
  [
    'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules',
    true,
    'C:\\Users\\alice',
  ],
  ['/Users/alice/AppData/Local/Temp/work/node_modules', false, '/Users/alice'],
];

const CLASSIFY_MIDS =
  'work|web|lib|LIB|.nvm|.BUN|.vscode|.hidden-tool|extensions|_npx|AppData|Local|Temp|Roaming|packages'.split(
    '|',
  );

function genClassifyTarget(rng: () => number, index: number): unknown[] {
  if (index < CLASSIFY_EDGES.length) {
    const [target, win, home] = CLASSIFY_EDGES[index]!;
    return [
      target,
      {
        style: { $probe: win ? 'pathops.win32' : 'pathops.posix' },
        home,
      },
    ];
  }
  const win = index % 2 === 1;
  const sep = win ? '\\' : '/';
  const home = win ? 'C:\\Users\\alice' : '/Users/alice';
  const roots = win
    ? ['C:\\Users\\alice', 'D:\\work', 'C:\\ProgramData']
    : ['/Users/alice', '/opt/work', '/var/app'];
  const segCount = randInt(rng, 1, 4);
  const chosen: string[] = [];
  for (let i = 0; i < segCount; i += 1) chosen.push(pick(rng, CLASSIFY_MIDS));
  const target = `${pick(rng, roots)}${sep}${chosen.join(sep)}${sep}node_modules`;
  return [
    target,
    {
      style: { $probe: win ? 'pathops.win32' : 'pathops.posix' },
      home: rng() > 0.15 ? home : null,
    },
  ];
}

function genRuleLeafMatch(rng: () => number, index: number): unknown[] {
  const patterns =
    '*.log|build-*|cache_?.tmp|.DS_Store|app[1].tmp|foo+bar(1).bak'.split('|');
  const leaves =
    'app.log|.log|build-debug|build-|cache_a.tmp|cache_ab.tmp|.DS_Store|app[1].tmp|foo+bar(1).bak|keep.txt'.split(
      '|',
    );
  const pat = patterns[index % patterns.length]!;
  const leaf = index < leaves.length ? leaves[index]! : pick(rng, leaves);
  return [leaf, [{ name: 'fuzz', kind: 'any', match: pat, action: 'trash' }]];
}

function genOlderThanDays(rng: () => number, index: number): unknown[] {
  const now = 1_760_000_000_000;
  const day = 86_400_000;
  const edges: [number, number, number][] = [
    [now + day, 1, now],
    [now, 0, now],
    [now - day, 1, now],
    [now - day + 1, 1, now],
    [now - day * 30, 30, now],
    [now - day * 30 + 1, 30, now],
    [0, 365, now],
  ];
  if (index < edges.length) return edges[index]!;
  const deltaDays = randInt(rng, -5, 120);
  const threshold = randInt(rng, 1, 90);
  return [now - deltaDays * day, threshold, now];
}

function genSafeTargetLeaf(rng: () => number, index: number): unknown[] {
  const win = index % 2 === 1;
  const samples = win
    ? [
        'C:\\work\\a\\node_modules',
        'C:\\work\\a\\',
        'C:\\work\\.',
        'C:\\work\\..',
        'C:\\work\\.git',
        'C:\\work\\*',
        'C:\\work\\app.log',
        '',
      ]
    : [
        '/work/a/node_modules',
        '/work/a/',
        '/work/.',
        '/work/..',
        '/work/.git',
        '/work/*',
        '/work/app.log',
        '',
      ];
  const target =
    index < samples.length
      ? samples[index]!
      : `${win ? 'C:\\work\\' : '/work/'}${pick(rng, ['dist', 'target', '.git', '..', '*', 'cache/', 'a.log'])}`;
  return [target, { $probe: win ? 'pathops.win32' : 'pathops.posix' }];
}

function genInsideAnyRoot(rng: () => number, index: number): unknown[] {
  const win = index % 2 === 1;
  const roots = win ? ['C:\\Work', 'D:\\Proj', ''] : ['/work', '/opt/proj', ''];
  const candidates = win
    ? [
        'C:\\work\\app\\target',
        'C:\\work2\\app\\target',
        'C:\\Work',
        'C:\\Work\\..\\secret',
        'E:\\other\\target',
        '',
      ]
    : [
        '/work/app/target',
        '/work2/app/target',
        '/work',
        '/work/../secret',
        '/opt/proj/sub/dist',
        '',
      ];
  const target =
    index < candidates.length ? candidates[index]! : pick(rng, candidates);
  return [target, roots, { $probe: win ? 'pathops.win32' : 'pathops.posix' }];
}

type GeneratorFn = (
  rng: () => number,
  index: number,
  options?: Record<string, unknown>,
) => unknown[];

const GENERATOR_MAP: Readonly<Record<GeneratorName, GeneratorFn>> = {
  'dirty-line': genDirtyLine,
  'indented-dirty-line': genIndentedDirtyLine,
  'byte-size': genByteSize,
  'rule-match': genRuleMatch,
  'config-path-options': genConfigPathOptions,
  'name-lists': (rng) => genNameLists(rng),
  'v1-config-raw': genV1ConfigRaw,
  'xdg-path': genXdgPath,
  'classify-target': genClassifyTarget,
  'rule-leaf-match': genRuleLeafMatch,
  'older-than-days': genOlderThanDays,
  'safe-target-leaf': genSafeTargetLeaf,
  'inside-any-root': genInsideAnyRoot,
};

/** 按声明的生成器名称产出 count 组确定性对抗参数列表 */
export function generateFuzzArgs(
  generator: GeneratorName,
  seed: number,
  count: number,
  options?: Record<string, unknown>,
): unknown[][] {
  const rng = createPrng(seed);
  const fn = GENERATOR_MAP[generator];
  const list: unknown[][] = [];
  for (let index = 0; index < count; index += 1) {
    list.push(fn(rng, index, options));
  }
  return list;
}
