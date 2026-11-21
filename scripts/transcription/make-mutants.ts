/**
 * 变异生成器 (反向验收的自证件): 从两包源码 (坐标由 workspaces 派生, 见 scripts/lib/workspace.ts) 复制一份实现
 * 并注入单点缺陷, 生成到 mutants/gen-<id>/; 副本自带 node_modules 链接 (指向 api 副本), 可独立运行。
 *
 * 用途 (变异自证): 语料必须能抓住全部 8 个 mutant (3 both: prune-negated / sort-missing /
 * exclude-silent; 3 cli: exit-swallowed / message-removed / size-unit-wrong; 2 api:
 * size-gone-dropped / terminal-event-dropped); 抓不住 = 语料盲区 (或该 mutant 定义过弱),
 * 不是「实现没问题」。重跑纪律见对应 API 包的 docs/protocol/README.md「维护规则」。
 *
 * 幂等: 每次重建自己的 gen-* 目录, 并清掉清单之外的陈旧 gen-*; 锚点失配 (源码在漂移) 时显式
 * 失败并报出文件, 严禁静默产出一份「没注入缺陷」的副本 (那会把反向验收变成永远绿的空转)。
 *
 * 用法: bun scripts/transcription/make-mutants.ts [--help]
 *
 * 产物结构: mutants/gen-<id>/<两包目录>/src/*.ts (注入后的实现, 目录名由 workspaces 派生)
 * + mutants/gen-<id>/scripts/transcription/api-harness.ts (套件参考 harness 的副本, 指向副本源码)
 * + mutants/gen-<id>/tsconfig.json (空文件: 切断对仓库根 tsconfig paths 的继承, 防包名 import 被劫持回真单源)
 * + mutants/gen-<id>/<api 包目录>/package.json (改写为源码导出式; cli 侧照抄真包, 副本自足可跑)
 * + mutants/gen-<id>/mutant.json (注入记录)。
 * 运行某 mutant (cli 面): bun scripts/transcription/mutants/gen-<id>/<cli 包目录>/src/cli.ts
 * 运行某 mutant (api 面): --api-target "bun scripts/transcription/mutants/gen-<id>/scripts/transcription/api-harness.ts"
 * (两者均与 run-conformance.ts 配合)。
 */
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProductPairs } from '../lib/workspace.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根 (scripts/transcription/ 上溯两级): 两包源码与配置的定位基准 */
const REPO_ROOT = resolve(HERE, '..', '..');

/** 在多产品仓中按 docs/protocol 锚点唯一定位承接转写套件的双包产品 (单产品仓直接取唯一对) */
function resolveProtocolProductPair(root: string) {
  const pairs = resolveProductPairs(root);
  if (pairs.length === 1) return pairs[0]!;
  const matched = pairs.filter(({ api }) =>
    existsSync(join(root, api.dir, 'docs', 'protocol')),
  );
  if (matched.length === 1) return matched[0]!;
  throw new Error(
    `无法唯一确定承接转写协议的双包产品 (现有 ${pairs.length} 组, 带 docs/protocol 的 ${matched.length} 组)`,
  );
}

/** 两包坐标: 由根 package.json 的 workspaces 与 docs/protocol 锚点派生 */
const { api: API_PKG, cli: CLI_PKG } = resolveProtocolProductPair(REPO_ROOT);
/** 被测源: 两包的 src (mutant 是整仓实现的注入副本) 与各自 package.json (副本自足可跑) */
const API_SRC_DIR = join(REPO_ROOT, API_PKG.dir, 'src');
const CLI_SRC_DIR = join(REPO_ROOT, CLI_PKG.dir, 'src');
const API_PKG_JSON = join(REPO_ROOT, API_PKG.dir, 'package.json');
const CLI_PKG_JSON = join(REPO_ROOT, CLI_PKG.dir, 'package.json');
/** api 包名: cli 副本经同名 node_modules 链接解析到 api 副本 (就近优先于仓库根真包) */
const API_PKG_NAME = API_PKG.name;

/** mutant 产物根 (本脚本独占命名空间; 其下 gen-* 已由 .gitignore 忽略) */
const MUTANTS_DIR = join(HERE, 'mutants');

/** 生成目录前缀 (本脚本的产物命名空间, 清理只动这个前缀) */
const GEN_PREFIX = 'gen-';

// ---------------------------------------------------------------------------
// mutant 清单 (每个 mutant 只注入一处; effect 与 expectCaughtBy 是变异自证时的核对依据)
// ---------------------------------------------------------------------------

interface PatchSpec {
  /** 源文件名 (两包 src/ 下, 含 .ts; 名字在两包内不重名, 定位见 locatePatchTarget) */
  file: string;
  /** 注入锚点: 必须在目标文件中恰好出现一次, 否则脚本失败 (源码漂移的显式信号) */
  find: string;
  replace: string;
  /** 这行补丁在行为面上的效果 (人读) */
  effect: string;
}

/** 预期抓住该 mutant 的测试面 (三态: cli / api / both) */
export type MutantSurface = 'cli' | 'api' | 'both';

interface MutantSpec {
  id: string;
  title: string;
  /** 预期被哪一面语料抓住 (三态: cli / api / both); 变异自证时按面核对 */
  expectCaughtBy: MutantSurface;
  /** 预期抓住它的典型用例说明 (人读, 随 mutant.json 存档) */
  expectNote: string;
  patches: PatchSpec[];
}

const MUTANTS: MutantSpec[] = [
  {
    id: 'prune-negated',
    title: '剪枝谓词取反',
    expectCaughtBy: 'both',
    expectNote:
      '任一命中 node_modules 的 CLI / API 用例 (stdoutExact / hits / fs 断言)',
    patches: [
      {
        file: 'scan-parallel.ts',
        find: "      if (nextIncluded && isPotentialTarget(name, 'dir', matcher)) {",
        replace:
          "      if (nextIncluded && !isPotentialTarget(name, 'dir', matcher)) {",
        effect:
          '命中判定反转: 普通目录被当作潜在目标剪枝, 真实目标反被下钻, 清单全面错乱',
      },
    ],
  },
  {
    id: 'exit-swallowed',
    title: '退出码吞掉',
    expectCaughtBy: 'cli',
    expectNote:
      '期望 exitCode 为 1 的 CLI 用例 (参数错误 / 配置损坏 / 删除失败 / 无配置 --yes)',
    patches: [
      {
        file: 'cli.ts',
        find: 'process.exitCode = await main();',
        replace: 'await main();',
        effect: 'main 的返回值被丢弃, 全部错误路径退出码退化为 0 (恒成功)',
      },
    ],
  },
  {
    id: 'sort-missing',
    title: '排序缺失',
    expectCaughtBy: 'both',
    expectNote:
      '≥2 个命中的 CLI / API 用例 (stdoutExact / hits 升序断言), 或复现性三连跑',
    patches: [
      {
        file: 'scan-parallel.ts',
        find: '      const hits = [...hitsByRealTarget.values()].sort(compareTarget);',
        replace: '      const hits = [...hitsByRealTarget.values()];',
        effect:
          '命中序退化为并发完成序 (不确定), 与「按 target 升序」的输出契约相悖',
      },
    ],
  },
  {
    id: 'exclude-silent',
    title: '排除静默失效',
    expectCaughtBy: 'both',
    expectNote:
      '使用 exclude 的 CLI / API 用例 (被排除子树重新出现在清单或 hits 里)',
    patches: [
      {
        file: 'scan-parallel.ts',
        find: '        if (exclude.has(name)) {',
        replace: '        if (false) {',
        effect:
          '排除判定被短路: 名单静默失效, 被排除子树照常扫出, 且无任何提示',
      },
    ],
  },
  {
    id: 'message-removed',
    title: '提示语删改',
    expectCaughtBy: 'cli',
    expectNote:
      '空结果 CLI 用例 (stdoutExact / stdoutContains 对「未发现」文案的断言)',
    patches: [
      {
        file: 'render.ts',
        find: '`${NEUTRAL_BLOCK} 未发现可清理目标`',
        replace: '`${NEUTRAL_BLOCK} 无结果`',
        effect: '空结果中性提示文案被改, 用户面文案与契约不符',
      },
    ],
  },
  {
    id: 'size-unit-wrong',
    title: '体积计数单位错',
    expectCaughtBy: 'cli',
    expectNote:
      '带体积数字断言的 CLI 用例; 注意: 仅 du 可用平台 (unix) 生效, Windows 走 js 候选时抓不住',
    patches: [
      {
        file: 'size-du-parse.ts',
        find: '        sizes.set(path, Number(numPart) * 1024);',
        replace: '        sizes.set(path, Number(numPart) * 1000);',
        effect: 'du 的 Ki 单位换算错误 (1024 → 1000), 展示体积全线偏移',
      },
    ],
  },
  {
    id: 'size-gone-dropped',
    title: '体积 gone 桶丢弃 (破坏 BC-43 三桶完备性)',
    expectCaughtBy: 'api',
    expectNote:
      '断言 SizeResult.gone 的 API 用例 (api-size-gone-bucket / api-size-three-buckets-and-warning)',
    patches: [
      {
        file: 'size-du.ts',
        find: '          gone.push(target);',
        replace: '          /* mutant: drop gone target */',
        effect:
          'du 候选丢弃已消失目标的 gone 记录, 破坏 SizeResult 三桶完备性恒等式',
      },
      {
        file: 'size-js.ts',
        find: '        else gone.push(outcome.target);',
        replace: '        /* mutant: drop gone target */',
        effect:
          'js 候选丢弃已消失目标的 gone 记录, 破坏 SizeResult 三桶完备性恒等式',
      },
    ],
  },
  {
    id: 'terminal-event-dropped',
    title: '编排终结事件丢失 (破坏 BC-44)',
    expectCaughtBy: 'api',
    expectNote:
      '断言 plan-done / done 终结事件的 API 用例 (api-sweep-plan-terminal-event / api-plan-onprogress-override / api-sweep-run-terminal-event)',
    patches: [
      {
        file: 'sweep.ts',
        find: "      planOptions?.onProgress?.({\n        kind: 'plan-done',\n        plan,\n        elapsedMs: Date.now() - startedAt,\n      });",
        replace: '      /* mutant: drop plan-done terminal event */',
        effect: 'sweeper.plan() 不再发射 plan-done 终结事件',
      },
      {
        file: 'sweep.ts',
        find: "  emit?.({ kind: 'done', status, elapsedMs: Date.now() - startedAt });",
        replace: '  /* mutant: drop done terminal event */',
        effect: 'sweeper.run() 不再发射 done 终结事件',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  '用法: bun scripts/transcription/make-mutants.ts',
  '',
  '  --help       显示本帮助',
  '',
  '产出: mutants/gen-<id>/<两包目录>/src/*.ts + mutant.json (幂等重建; 目录名由 workspaces 派生)',
].join('\n');

/** 统计 needle 在 text 中的出现次数 (不重叠) */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 找 needle 首次出现的行号 (从 1 起) */
const lineOf = (text: string, needle: string): number =>
  text.slice(0, text.indexOf(needle)).split('\n').length;

/** 递归取 src 下应复制的相对路径清单: 全部 .ts, 排除测试文件; 排序保证复制次序确定 */
async function listSourceFiles(srcDir: string, prefix = ''): Promise<string[]> {
  const dir = prefix === '' ? srcDir : join(srcDir, prefix);
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(srcDir, rel)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(rel);
    }
  }
  return files.sort();
}

interface AppliedPatch {
  file: string;
  anchorLine: number;
  find: string;
  replace: string;
  effect: string;
}

/**
 * 在 mutant 的两包副本中定位补丁目标文件 (文件名在两包内不重名)。
 * 外部副作用: 只读 (stat)。
 */
async function locatePatchTarget(
  outDir: string,
  file: string,
): Promise<string> {
  for (const pkg of [API_PKG, CLI_PKG]) {
    const candidate = join(outDir, pkg.dir, 'src', file);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // 继续找另一包
    }
  }
  throw new Error(`补丁目标不在两包副本中: ${file}`);
}

/**
 * 生成单个 mutant: 先清掉旧目录, 复制两包源码与 package.json, 建 api 副本链接, 再逐个应用补丁。
 * 外部副作用: 删除并重建 mutants/gen-<id>/。
 *
 * ### 数据流转示例
 * ```text
 * Input (真实 Payload):
 *   mutant = { id: 'exit-swallowed', patches: [{ file: 'cli.ts', find: 'process.exitCode = await main();', ... }] }
 *   sourceFiles = <api/cli 两包 src 下全部非测试 .ts>
 *
 * 步骤 1: 重建目录并复制两包源码 + api-harness.ts + 改写副本 package.json
 *         写入空 tsconfig.json ({}) 切断根 paths 继承, 建 node_modules/<api 包名> 软链指向副本 API
 * 步骤 2: 逐补丁 locatePatchTarget -> 校验锚点恰好出现 1 次 -> 替换并记录 anchorLine
 *
 * Output (数据契约):
 *   return AppliedPatch[] 并落盘 mutants/gen-<id>/mutant.json
 * ```
 */
async function makeMutant(mutant: MutantSpec): Promise<AppliedPatch[]> {
  const outDir = join(MUTANTS_DIR, `${GEN_PREFIX}${mutant.id}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, API_PKG.dir, 'src'), {
    recursive: true,
  });
  await mkdir(join(outDir, CLI_PKG.dir, 'src'), {
    recursive: true,
  });

  for (const [srcDir, pkgDir] of [
    [API_SRC_DIR, join(outDir, API_PKG.dir)],
    [CLI_SRC_DIR, join(outDir, CLI_PKG.dir)],
  ] as const) {
    for (const rel of await listSourceFiles(srcDir)) {
      const dest = join(pkgDir, 'src', rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(join(srcDir, rel)));
    }
  }
  // 套件的 API 参考 harness 副本: 按仓库同相对结构放入, 使 api 面语料可直接以
  // scripts/transcription/mutants/gen-<id>/scripts/transcription/api-harness.ts 为 --api-target
  // (其 resolveApiEntry 按副本内 packages/* 自动定位本副本的 API 源码)。
  await mkdir(join(outDir, 'scripts', 'transcription'), { recursive: true });
  await writeFile(
    join(outDir, 'scripts', 'transcription', 'api-harness.ts'),
    await readFile(join(HERE, 'api-harness.ts')),
  );
  // 空 tsconfig 就近切断对仓库根 tsconfig 的 paths 继承: 否则 bun 会把副本 cli.ts 的包名
  // import (即 API 包名) 解析到真 API 单源 (paths 优先于 node_modules 链接),
  // 变异自证静默失效 (2026-09-30 实测: 缺此文件时 bun 载体对注入副本零抓取)。node 载体不读
  // paths 可免此劫持, 但受「node_modules 下 .ts 拒绝类型剥离、副本无 dist」限制, 故变异自证
  // 的运行时以 bun 载体为准。
  await writeFile(join(outDir, 'tsconfig.json'), '{}\n');
  // 副本 API 的 package.json 改写为源码导出: bun 直跑副本 .ts, 不经真包的 exports→dist
  // (副本不含构建产物, 照抄真包 exports 会让 cli 副本的包名 import 解析失败, 2026-09-30 实测)。
  const apiPkg = JSON.parse(await readFile(API_PKG_JSON, 'utf8')) as {
    name?: unknown;
  };
  await writeFile(
    join(outDir, API_PKG.dir, 'package.json'),
    `${JSON.stringify(
      {
        name: typeof apiPkg.name === 'string' ? apiPkg.name : API_PKG_NAME,
        type: 'module',
        exports: { '.': './src/index.ts' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(outDir, CLI_PKG.dir, 'package.json'),
    await readFile(CLI_PKG_JSON),
  );

  // cli 副本对 API 包名的解析必须落在 api 副本上 (而非宿主仓库的真包);
  // 链接目标按 relative(dirname(apiLink), apiTarget) 动态算深度, 同时兼容 scoped (@scope/pkg → ../..) 与无 scope (pkg → ..)
  const apiLink = join(outDir, 'node_modules', API_PKG_NAME);
  const apiTarget = join(outDir, API_PKG.dir);
  await mkdir(dirname(apiLink), { recursive: true });
  await symlink(
    process.platform === 'win32'
      ? apiTarget
      : relative(dirname(apiLink), apiTarget),
    apiLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const applied: AppliedPatch[] = [];
  for (const patch of mutant.patches) {
    const target = await locatePatchTarget(outDir, patch.file);
    const text = await readFile(target, 'utf8');
    const occurrences = countOccurrences(text, patch.find);
    if (occurrences !== 1) {
      throw new Error(
        `mutant ${mutant.id}: 锚点失配 (${patch.file}, 出现 ${occurrences} 次, 期望 1 次): ${JSON.stringify(patch.find)}\n` +
          '  源码已漂移: 更新 make-mutants.ts 里的锚点后重跑, 严禁带着失配继续。',
      );
    }
    const anchorLine = lineOf(text, patch.find);
    await writeFile(target, text.split(patch.find).join(patch.replace));
    applied.push({ ...patch, anchorLine });
  }

  const manifest = {
    id: mutant.id,
    title: mutant.title,
    expectCaughtBy: mutant.expectCaughtBy,
    expectNote: mutant.expectNote,
    sourceDir: `${API_PKG.dir}/src + ${CLI_PKG.dir}/src`,
    runHint: `bun ${join(MUTANTS_DIR, `${GEN_PREFIX}${mutant.id}`, CLI_PKG.dir, 'src', 'cli.ts')}`,
    patches: applied,
  };
  await writeFile(
    join(outDir, 'mutant.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return applied;
}

/** 清掉清单之外的陈旧 gen-* 目录 (本脚本自己的产物命名空间, 不留垃圾) */
async function sweepStale(knownIds: Set<string>): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(MUTANTS_DIR, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GEN_PREFIX)) continue;
    if (knownIds.has(entry.name.slice(GEN_PREFIX.length))) continue;
    await rm(join(MUTANTS_DIR, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${HELP_TEXT}\n`);
      return 0;
    }
    process.stderr.write(`参数错误: 未知参数 ${arg}\n\n${HELP_TEXT}\n`);
    return 1;
  }

  for (const srcDir of [API_SRC_DIR, CLI_SRC_DIR]) {
    try {
      await readdir(srcDir);
    } catch (error) {
      process.stderr.write(
        `源目录不可读: ${srcDir} (${(error as Error).message})\n`,
      );
      return 1;
    }
  }

  const removed = await sweepStale(new Set(MUTANTS.map((mutant) => mutant.id)));
  for (const name of removed) {
    process.stdout.write(`清理陈旧产物: ${name}\n`);
  }

  for (const mutant of MUTANTS) {
    const applied = await makeMutant(mutant);
    process.stdout.write(`gen-${mutant.id} (${mutant.title})\n`);
    for (const patch of applied) {
      process.stdout.write(
        `  ${patch.file}:${patch.anchorLine}  ${patch.effect}\n`,
      );
    }
  }

  process.stdout.write(
    `\n合计 ${MUTANTS.length} 个 mutant → ${join(MUTANTS_DIR, `gen-*/${CLI_PKG.dir}/src/cli.ts`)}\n`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
