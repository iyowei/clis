/**
 * 本地 CI 预演 (闸门清单的单一事实来源): 全部步骤在此一处定义, 其余消费方——手动全链、
 * lefthook pre-push、CI 的两个 job、Release 的 verify job——一律经本入口调用, 不再各自枚举
 * (此前清单散布五处, 每加一个闸门需五处同步; 见 docs/designs/tech-debt.md 的历史登记 TD-03)。
 *
 * 分组:
 * - `--verify`      验证组 (ubuntu 可跑): build → typecheck → test → lint → format-check → 四闸门;
 * - `--conformance` 验收组 (语料为 macOS 口径): build → conformance (bun + node 双 target);
 * - (无旗标)        全链 = 验证组 + 验收组 (重复步骤去重);
 * - `--only <step>` 单步执行 (步骤名见 `--help`);
 * - `--help`        列出步骤与分组。
 *
 * 用法: bun scripts/ci.ts [--verify | --conformance | --only <step> | --help]
 * 退出码: 0 全绿; 其余为首个失败步骤的退出码。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

process.chdir(join(import.meta.dir, '..'));

/** 一个步骤: 展示名与命令参数 */
interface Step {
  command: string;
  args: string[];
}

/** CLI 入口坐标 (chdir 之后相对仓库根) */
const CLI_SRC = 'packages/sweep-node-modules-cli/src/cli.ts';

/** 步骤表 (清单唯一来源): 键即 `--only` 接受的步骤名 */
const STEPS: Readonly<Record<string, Step>> = {
  build: { command: 'bun', args: ['run', 'build'] },
  typecheck: { command: 'bun', args: ['run', 'typecheck'] },
  test: { command: 'bun', args: ['run', 'test'] },
  lint: { command: 'bunx', args: ['oxlint'] },
  'format-check': { command: 'bunx', args: ['prettier', '--check', '.'] },
  'lint:refs': { command: 'bun', args: ['scripts/lint-doc-references.ts'] },
  'lint:examples': { command: 'bun', args: ['scripts/lint-doc-examples.ts'] },
  'lint:coverage': {
    command: 'bun',
    args: ['scripts/transcription/validate-coverage.ts'],
  },
  'lint:backups': { command: 'bun', args: ['scripts/lint-stray-backups.ts'] },
  'conformance:bun': {
    command: 'bun',
    args: [
      'scripts/transcription/run-conformance.ts',
      '--target',
      `bun ${CLI_SRC}`,
      '--api-target',
      'bun scripts/transcription/api-harness.ts',
    ],
  },
  'conformance:node': {
    command: 'bun',
    args: [
      'scripts/transcription/run-conformance.ts',
      '--target',
      `node ${CLI_SRC}`,
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
  'lint:coverage',
  'lint:backups',
];

/**
 * 验收组 (转写验收需 macOS 口径: 语料的 du 磁盘占用按 APFS 块分配录制)。
 * 组内含 build: node target 直跑 CLI 源码时按 exports 解析到 API 包 dist,
 * 而 node 不读 tsconfig paths (bun 独有), 无产物即全数 ERR_MODULE_NOT_FOUND (2026-09-29 CI 实翻)。
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
  const result = spawnSync(step.command, step.args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
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

/** 解析入口旗标为待跑步骤序列 */
function resolveSteps(argv: string[]): string[] | null {
  const onlyIndex = argv.indexOf('--only');
  if (onlyIndex >= 0) {
    const name = argv[onlyIndex + 1];
    if (name === undefined || STEPS[name] === undefined) {
      process.stderr.write(
        `--only 缺步骤名或步骤不存在: ${String(name)}\n\n${HELP_TEXT}\n`,
      );
      process.exit(2);
    }
    return [name];
  }
  if (argv.includes('--verify')) return [...VERIFY_GROUP];
  if (argv.includes('--conformance')) return [...CONFORMANCE_GROUP];
  // 全链: 验证组 + 验收组中未出现过的步骤 (build 去重)
  return [
    ...VERIFY_GROUP,
    ...CONFORMANCE_GROUP.filter((name) => !VERIFY_GROUP.includes(name)),
  ];
}

if (process.argv.includes('--help')) {
  process.stdout.write(`${HELP_TEXT}\n`);
} else {
  const steps = resolveSteps(process.argv.slice(2))!;
  for (const name of steps) runStep(name);
  process.stdout.write('\nCI 预演全绿 ✓\n');
}
