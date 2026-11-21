/**
 * 差分模糊测试 · 确定性生成器、规范深比较与通用不变量校验 (纯函数, 零 IO, 零领域硬编码)。
 *
 * 上游: `scripts/transcription/run-diff-fuzz.ts` 按包级 `fuzz-targets.json` 调度本模块生成对抗输入;
 * 下游: 生成的 args 数组封装为 API harness `{ steps }` 指令, 回包由本模块做不变量校验与双实现深等价比对。
 */

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
  | 'classify-target';

export type InvariantName =
  | 'no-crash'
  | 'ok-string'
  | 'non-empty-string'
  | 'no-control-chars'
  | 'no-newlines'
  | 'idempotent';

/** API harness 单条规范输出形状 */
export interface HarnessOutcome {
  ok: boolean;
  value?: unknown;
  error?: {
    name?: string;
    code?: string;
    message?: string;
    details?: unknown;
  };
}

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
// 9 类结构化对抗输入生成器 (前若干条固定高危边缘样本, 其余为确定性随机组合)
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
  const pool = [
    '.git',
    'dist',
    'build',
    'cache',
    '.cache',
    'Build',
    '中文目录',
    'a',
    'b',
    'temp',
  ];
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

function genClassifyTarget(rng: () => number, index: number): unknown[] {
  const win = index % 2 === 1;
  const sep = win ? '\\' : '/';
  const home = win ? 'C:\\Users\\alice' : '/Users/alice';
  const roots = win
    ? ['C:\\Users\\alice', 'D:\\work', 'C:\\ProgramData']
    : ['/Users/alice', '/opt/work', '/var/app'];
  const mids = [
    'work',
    'web',
    'lib',
    'LIB',
    '.nvm',
    '.BUN',
    '.vscode',
    '.hidden-tool',
    'extensions',
    '_npx',
    'packages',
  ];
  const segCount = randInt(rng, 1, 4);
  const chosen: string[] = [];
  for (let i = 0; i < segCount; i += 1) chosen.push(pick(rng, mids));
  const target = `${pick(rng, roots)}${sep}${chosen.join(sep)}${sep}node_modules`;
  return [
    target,
    {
      style: { $probe: win ? 'pathops.win32' : 'pathops.posix' },
      home: rng() > 0.15 ? home : null,
    },
  ];
}

/** 按声明的生成器名称产出 count 组确定性对抗参数列表 */
export function generateFuzzArgs(
  generator: GeneratorName,
  seed: number,
  count: number,
  options?: Record<string, unknown>,
): unknown[][] {
  const rng = createPrng(seed);
  const list: unknown[][] = [];
  for (let index = 0; index < count; index += 1) {
    switch (generator) {
      case 'dirty-line':
        list.push(genDirtyLine(rng, index));
        break;
      case 'indented-dirty-line':
        list.push(genIndentedDirtyLine(rng, index));
        break;
      case 'byte-size':
        list.push(genByteSize(rng, index));
        break;
      case 'rule-match':
        list.push(genRuleMatch(rng, index));
        break;
      case 'config-path-options':
        list.push(genConfigPathOptions(rng, index, options));
        break;
      case 'name-lists':
        list.push(genNameLists(rng));
        break;
      case 'v1-config-raw':
        list.push(genV1ConfigRaw(rng, index));
        break;
      case 'xdg-path':
        list.push(genXdgPath(rng, index));
        break;
      case 'classify-target':
        list.push(genClassifyTarget(rng, index));
        break;
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// 规范 JSON 深比较与不变量检查
// ---------------------------------------------------------------------------

/** 递归按对象键字典序归一后序列化, 用于跨语言/跨运行时确定性深等价比较 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 提取用于跨实现差分比较的可比较载荷 (成功比 value; 失败比 error.code 或 error.name) */
export function comparableOutcome(outcome: HarnessOutcome): string {
  if (outcome.ok) return canonicalJson({ ok: true, value: outcome.value });
  return canonicalJson({
    ok: false,
    code: outcome.error?.code ?? null,
    name: outcome.error?.name ?? 'Error',
  });
}

/** 检查字符串是否包含禁止的控制字符 (C0 除 \t, DEL, C1, bidi 与零宽/BOM) */
export function hasForbiddenControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

/** 校验单次执行结果是否满足目标声明的全部非幂等不变量 (返回违例原因列表) */
export function checkInvariants(
  outcome: HarnessOutcome,
  invariants: readonly InvariantName[],
): string[] {
  const violations: string[] = [];
  for (const inv of invariants) {
    if (inv === 'no-crash' || inv === 'idempotent') continue;
    if (inv === 'ok-string') {
      if (!outcome.ok || typeof outcome.value !== 'string') {
        violations.push(
          `违反 ok-string: ok=${String(outcome.ok)}, typeof value=${typeof outcome.value}`,
        );
      }
      continue;
    }
    if (inv === 'non-empty-string') {
      if (
        !outcome.ok ||
        typeof outcome.value !== 'string' ||
        outcome.value === ''
      ) {
        violations.push('违反 non-empty-string: 结果不是非空字符串');
      }
      continue;
    }
    if (inv === 'no-control-chars') {
      if (
        !outcome.ok ||
        typeof outcome.value !== 'string' ||
        hasForbiddenControlChar(outcome.value)
      ) {
        violations.push(
          `违反 no-control-chars: 输出含裸控制/bidi 字符 (${JSON.stringify(outcome.value)})`,
        );
      }
      continue;
    }
    if (inv === 'no-newlines') {
      if (
        !outcome.ok ||
        typeof outcome.value !== 'string' ||
        outcome.value.includes('\n') ||
        outcome.value.includes('\r')
      ) {
        violations.push(
          `违反 no-newlines: 输出含换行符 (${JSON.stringify(outcome.value)})`,
        );
      }
    }
  }
  return violations;
}
