/**
 * 本地 CI 预演 (闸门清单的单一事实来源): 全部步骤在此一处定义, 其余消费方 — 手动全链、
 * lefthook pre-push、CI 的两个 job、Release 的前置门禁 — 一律经本入口调用, 不再各自枚举。
 *
 * 分组:
 * - `--verify`      验证组 (ubuntu 可跑): build → typecheck → test → lint → format-check → 五闸门;
 * - `--conformance` 验收组 (语料为 macOS 口径): build → conformance (bun + node 双 target);
 * - (无旗标)        全链 = 验证组 + 验收组 (重复步骤去重);
 * - `--only <step>` 单步执行 (步骤名见 `--help`);
 * - `--help`        列出步骤与分组。
 *
 * 用法: bun scripts/ci.ts [--verify | --conformance | --only <step> | --help]
 * 退出码: 0 全绿; 2 参数非法; 其余为首个失败步骤的退出码。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from './lib/tmp-root.ts';
import { resolveProductPairs } from './lib/workspace.ts';

process.chdir(join(import.meta.dir, '..'));

/** 一个步骤: 展示名与命令参数 (args 支持惰性生成, 避免非验收场景耦合特定产品路径) */
interface Step {
  command: string;
  args: string[] | (() => string[]);
  /** 在隔离 HOME / USERPROFILE 下执行 (防「本地有而 CI 无」的环境态假设被本机状态掩盖) */
  isolatedHome?: boolean;
}

/** 惰性派生转写验收 CLI 入口坐标 (单产品仓取唯一对; 多产品仓按 docs/protocol 锚点唯一定位) */
function resolveConformanceCliSrc(): string {
  const root = process.cwd();
  const pairs = resolveProductPairs(root);
  const matched =
    pairs.length === 1
      ? pairs[0]
      : pairs.find(({ api }) =>
          fs.existsSync(join(root, api.dir, 'docs', 'protocol')),
        );
  if (matched === undefined) {
    throw new Error('未找到承接转写验收的 CLI + API 双包产品');
  }
  return `${matched.cli.dir}/src/cli.ts`;
}

/** 步骤表 (清单唯一来源): 键即 `--only` 接受的步骤名 */
const STEPS: Readonly<Record<string, Step>> = {
  build: { command: 'bun', args: ['run', 'build'] },
  typecheck: { command: 'bun', args: ['run', 'typecheck'] },
  test: { command: 'bun', args: ['run', 'test'], isolatedHome: true },
  lint: { command: 'bunx', args: ['oxlint'] },
  'format-check': { command: 'bunx', args: ['prettier', '--check', '.'] },
  'lint:refs': { command: 'bun', args: ['scripts/lint-doc-references.ts'] },
  'lint:examples': { command: 'bun', args: ['scripts/lint-doc-examples.ts'] },
  'lint:deps': {
    command: 'bun',
    args: ['scripts/lint-dependency-direction.ts'],
  },
  'lint:coverage': {
    command: 'bun',
    args: ['scripts/transcription/validate-coverage.ts'],
  },
  'lint:backups': { command: 'bun', args: ['scripts/lint-stray-backups.ts'] },
  // 发布凭据预检 (OIDC 换证): 发布特有, 不进任何组 — 仅 Release 的 release job (获批后)
  // 经 `--only npm-trust` 调用; 非 OIDC 环境下手动跑时脚本自行跳过。
  'npm-trust': {
    command: 'bun',
    args: ['scripts/npm-trust-guard.ts', 'verify-oidc'],
  },
  'conformance:bun': {
    command: 'bun',
    args: () => [
      'scripts/transcription/run-conformance.ts',
      '--target',
      `bun ${resolveConformanceCliSrc()}`,
      '--api-target',
      'bun scripts/transcription/api-harness.ts',
    ],
  },
  'conformance:node': {
    command: 'bun',
    args: () => [
      'scripts/transcription/run-conformance.ts',
      '--target',
      `node ${resolveConformanceCliSrc()}`,
      '--api-target',
      'node scripts/transcription/api-harness.ts',
    ],
  },
};

/** 验证组 (ubuntu 可跑; CI 与 Release 的 verify job 即此组) */
const VERIFY_GROUP: readonly string[] = [
  'build',
  'typecheck',
  'test',
  'lint',
  'format-check',
  'lint:refs',
  'lint:examples',
  'lint:deps',
  'lint:coverage',
  'lint:backups',
];

/**
 * 验收组 (转写验收需 macOS 口径: 语料的 du 磁盘占用按 APFS 块分配录制)。
 * 组内含 build: node target 直跑 CLI 源码时按 exports 解析到 API 包 dist,
 * 而 node 不读 tsconfig paths (bun 独有), 无产物即全数 ERR_MODULE_NOT_FOUND。
 */
const CONFORMANCE_GROUP: readonly string[] = [
  'build',
  'conformance:bun',
  'conformance:node',
];

/** 跑一步 (stdio 透传), 失败即携其退出码终止 */
function runStep(name: string): void {
  const step = STEPS[name]!;
  process.stdout.write(`\n=== ${name} ===\n`);
  const args = typeof step.args === 'function' ? step.args() : step.args;
  const home = step.isolatedHome === true ? makeTmpRoot('ci-home-') : undefined;
  try {
    if (home !== undefined) process.stdout.write(`隔离 HOME: ${home}\n`);
    const env =
      home === undefined
        ? process.env
        : { ...process.env, HOME: home, USERPROFILE: home };
    const result = spawnSync(step.command, args, { stdio: 'inherit', env });
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    if (home !== undefined) fs.rmSync(home, { recursive: true, force: true });
  }
}

/** 帮助文本 */
const HELP_TEXT = [
  '本地 CI 预演 (闸门清单单一事实来源)',
  '',
  '用法: bun scripts/ci.ts [选项]',
  '  --verify         验证组: ' + VERIFY_GROUP.join(' → '),
  '  --conformance    验收组: ' + CONFORMANCE_GROUP.join(' → '),
  '  (无旗标)         全链 = 验证组 + 验收组 (去重)',
  '  --only <step>    单步执行',
  '  --help           本帮助',
  '',
  '步骤名: ' + Object.keys(STEPS).join(' / '),
].join('\n');

/** 解析入口旗标为待跑步骤序列 (显式拒绝未知旗标与互斥组合) */
function resolveSteps(argv: string[]): string[] {
  const modes: string[] = [];
  let onlyStep: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--verify' || arg === '--conformance') {
      modes.push(arg);
      continue;
    }
    if (arg === '--only') {
      const name = argv[i + 1];
      if (name === undefined || STEPS[name] === undefined) {
        process.stderr.write(
          `--only 缺步骤名或步骤不存在: ${String(name)}\n\n${HELP_TEXT}\n`,
        );
        process.exit(2);
      }
      onlyStep = name;
      modes.push('--only');
      i += 1;
      continue;
    }
    process.stderr.write(`未知参数: ${arg}\n\n${HELP_TEXT}\n`);
    process.exit(2);
  }

  if (modes.length > 1) {
    process.stderr.write(
      `旗标互斥, 一次只能指定一种模式: ${modes.join(', ')}\n\n${HELP_TEXT}\n`,
    );
    process.exit(2);
  }
  if (onlyStep !== undefined) return [onlyStep];
  if (modes[0] === '--verify') return [...VERIFY_GROUP];
  if (modes[0] === '--conformance') return [...CONFORMANCE_GROUP];
  // 全链: 验证组 + 验收组中未出现过的步骤 (build 去重)
  return [
    ...VERIFY_GROUP,
    ...CONFORMANCE_GROUP.filter((name) => !VERIFY_GROUP.includes(name)),
  ];
}

if (process.argv.includes('--help')) {
  process.stdout.write(`${HELP_TEXT}\n`);
} else {
  const steps = resolveSteps(process.argv.slice(2));
  for (const name of steps) runStep(name);
  process.stdout.write('\nCI 预演全绿 ✓\n');
}
