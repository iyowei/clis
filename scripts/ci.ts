/**
 * 本地 CI 预演 (闸门清单的单一事实来源): 全部步骤在此一处定义, 其余消费方 — 手动全链、
 * lefthook pre-push、CI 三路 job (Linux / Windows / macOS) 与 Release 前置门禁 —
 * 一律经本入口调用, 不再各自枚举。
 *
 * 分组:
 * - `--verify`         验证组 (ubuntu 权威全量): build → typecheck → test → 7 道只读 lint 并行;
 * - `--verify-windows` Windows OS 兼容组: build → 限并发 test:windows → test:scripts;
 * - `--conformance`    验收组 (语料为 macOS 口径): build → conformance (bun + node 双 target);
 * - (无旗标)           全链 = 验证组 + 验收组 (重复步骤去重);
 * - `--only <step>`    单步执行 (步骤名见 `--help`);
 * - `--help`           列出步骤与分组。
 *
 * 用法: bun scripts/ci.ts [--verify | --verify-windows | --conformance | --only <step> | --help]
 * 退出码: 0 全绿; 2 参数非法; 其余为首个失败步骤的退出码。
 */
import { spawn, spawnSync } from 'node:child_process';
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
  /** 叠加给子进程的环境变量 */
  env?: Readonly<Record<string, string>>;
  /** 纯只读无副作用闸门: 连续出现时自动并行执行, 输出按声明序回放 */
  parallel?: boolean;
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

/** Windows 兼容专项测试环境: 跳过已在 Linux 全量校验过的重复真机 npm pack, 禁用 npm 更新检查 */
const WINDOWS_TEST_ENV: Readonly<Record<string, string>> = {
  CI_SKIP_PACK_TEST: '1',
  NO_UPDATE_NOTIFIER: '1',
  npm_config_update_notifier: 'false',
};

/** 步骤表 (清单唯一来源): 键即 `--only` 接受的步骤名 */
const STEPS: Readonly<Record<string, Step>> = {
  build: { command: 'bun', args: ['run', 'build'] },
  typecheck: { command: 'bun', args: ['run', 'typecheck'] },
  test: { command: 'bun', args: ['run', 'test'], isolatedHome: true },
  'test:windows': {
    command: 'bun',
    args: [
      'x',
      '--no-install',
      'turbo',
      'run',
      'test',
      '--concurrency=2',
      '--continue=dependencies-successful',
    ],
    isolatedHome: true,
    env: WINDOWS_TEST_ENV,
  },
  'test:scripts': {
    command: 'bun',
    args: ['test', 'scripts/'],
    isolatedHome: true,
    env: WINDOWS_TEST_ENV,
  },
  lint: {
    command: 'bun',
    args: ['x', '--no-install', 'oxlint'],
    parallel: true,
  },
  'format-check': {
    command: 'bun',
    args: ['fmt', '--check'],
    parallel: true,
  },
  'lint:refs': {
    command: 'bun',
    args: ['scripts/lint-doc-references.ts'],
    parallel: true,
  },
  'lint:examples': {
    command: 'bun',
    args: ['scripts/lint-doc-examples.ts'],
    parallel: true,
  },
  'lint:deps': {
    command: 'bun',
    args: ['scripts/lint-dependency-direction.ts'],
    parallel: true,
  },
  'lint:coverage': {
    command: 'bun',
    args: ['scripts/transcription/validate-coverage.ts'],
    parallel: true,
  },
  'lint:backups': {
    command: 'bun',
    args: ['scripts/lint-stray-backups.ts'],
    parallel: true,
  },
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

/** 验证组 (ubuntu 权威全量; CI 的 verify job 即此组) */
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

/** Windows OS 兼容组 (跳过 OS 无关静态检查与已在 Linux 全量校验的重复 npm pack) */
const VERIFY_WINDOWS_GROUP: readonly string[] = [
  'build',
  'test:windows',
  'test:scripts',
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

/** 预建隔离家目录内的标准配置子目录 (Windows 上 SHGetKnownFolderPath 校验 AppData\Roaming 存在) */
function prepareIsolatedHome(home: string): void {
  for (const parts of [
    ['.config', 'turborepo'],
    ['.config', 'vercel'],
    ['AppData', 'Roaming'],
    ['AppData', 'Local'],
  ]) {
    fs.mkdirSync(join(home, ...parts), { recursive: true });
  }
}

/** 组装单步环境变量 (可选叠加隔离 HOME / XDG / AppData / Turbo 配置路径与步骤专有 env) */
function buildStepEnv(step: Step, home: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...step.env };
  if (home !== undefined) {
    const configDir = join(home, '.config');
    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = configDir;
    env.APPDATA = join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    env.TURBO_CONFIG_DIR_PATH = join(configDir, 'turborepo');
    env.VERCEL_CONFIG_DIR_PATH = join(configDir, 'vercel');
  }
  return env;
}

/** 跑一步串行步骤 (stdio 透传), 失败即携其退出码终止 */
function runStep(name: string): void {
  const step = STEPS[name]!;
  process.stdout.write(`\n=== ${name} ===\n`);
  const args = typeof step.args === 'function' ? step.args() : step.args;
  const home = step.isolatedHome === true ? makeTmpRoot('ci-home-') : undefined;
  try {
    if (home !== undefined) {
      prepareIsolatedHome(home);
      process.stdout.write(`隔离 HOME: ${home}\n`);
    }
    const result = spawnSync(step.command, args, {
      stdio: 'inherit',
      env: buildStepEnv(step, home),
    });
    if (result.error !== undefined) {
      process.stderr.write(`步骤 ${name} 启动失败: ${result.error.message}\n`);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    if (home !== undefined) {
      fs.rmSync(home, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }
}

interface ParallelResult {
  name: string;
  status: number;
  stdout: string;
  stderr: string;
}

/** 异步执行单条只读并行步骤并收集输出 */
function spawnParallelStep(name: string): Promise<ParallelResult> {
  const step = STEPS[name]!;
  const args = typeof step.args === 'function' ? step.args() : step.args;
  return new Promise((resolve) => {
    const child = spawn(step.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildStepEnv(step, undefined),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({
        name,
        status: 1,
        stdout,
        stderr: `${stderr}步骤 ${name} 启动失败: ${error.message}\n`,
      });
    });
    child.on('close', (code) => {
      resolve({ name, status: code ?? 1, stdout, stderr });
    });
  });
}

/** 并行执行连续的只读检查步骤, 按原声明顺序整块回放输出并在首个失败处退出 */
async function runParallelBatch(names: readonly string[]): Promise<void> {
  const results = await Promise.all(names.map(spawnParallelStep));
  let firstFailure = 0;
  for (const res of results) {
    process.stdout.write(`\n=== ${res.name} ===\n`);
    if (res.stdout.length > 0) process.stdout.write(res.stdout);
    if (res.stderr.length > 0) process.stderr.write(res.stderr);
    if (res.status !== 0 && firstFailure === 0) firstFailure = res.status;
  }
  if (firstFailure !== 0) process.exit(firstFailure);
}

/** 按步骤序列编排执行: 连续的 parallel 步骤自动成批并发, 其余严格串行 */
async function runSteps(names: readonly string[]): Promise<void> {
  let index = 0;
  while (index < names.length) {
    const name = names[index]!;
    if (STEPS[name]?.parallel === true) {
      const batch: string[] = [];
      while (index < names.length && STEPS[names[index]!]?.parallel === true) {
        batch.push(names[index]!);
        index += 1;
      }
      if (batch.length === 1) runStep(batch[0]!);
      else await runParallelBatch(batch);
      continue;
    }
    runStep(name);
    index += 1;
  }
}

/** 帮助文本 */
const HELP_TEXT = [
  '本地 CI 预演 (闸门清单单一事实来源)',
  '',
  '用法: bun scripts/ci.ts [选项]',
  '  --verify           验证组 (Linux 全量): ' + VERIFY_GROUP.join(' → '),
  '  --verify-windows   Windows 兼容组: ' + VERIFY_WINDOWS_GROUP.join(' → '),
  '  --conformance      验收组 (macOS 口径): ' + CONFORMANCE_GROUP.join(' → '),
  '  (无旗标)           全链 = 验证组 + 验收组 (去重)',
  '  --only <step>      单步执行',
  '  --help             本帮助',
  '',
  '步骤名: ' + Object.keys(STEPS).join(' / '),
].join('\n');

/** 解析入口旗标为待跑步骤序列 (显式拒绝未知旗标与互斥组合) */
function resolveSteps(argv: string[]): string[] {
  const modes: string[] = [];
  let onlyStep: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (
      arg === '--verify' ||
      arg === '--verify-windows' ||
      arg === '--conformance'
    ) {
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
  if (modes[0] === '--verify-windows') return [...VERIFY_WINDOWS_GROUP];
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
  await runSteps(steps);
  process.stdout.write('\nCI 预演全绿 ✓\n');
}
