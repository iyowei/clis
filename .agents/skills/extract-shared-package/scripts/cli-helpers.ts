/**
 * CLI 参数严格解析、路径安全围栏、仓库根查找与多签名平衡拆分助手。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanWorkspace } from './analyzer.ts';
import { CLI_COMMAND_SPECS } from './cli-contract.ts';
import { assertInsideRepo } from './fs-utils.ts';
import { getLastScanPath, loadCheckpoint, loadLedger } from './ledger.ts';
import type { ScanReport } from './types.ts';

export { assertInsideRepo };

export function formatCliUsage(cmd: string): string {
  const spec = CLI_COMMAND_SPECS[cmd];
  if (spec === undefined) {
    return `可用命令: ${Object.keys(CLI_COMMAND_SPECS).join(' | ')}`;
  }
  const req = spec.required.map((f) => `${f} <val>`).join(' ');
  const opt = spec.optional.map((f) => `[${f}]`).join(' ');
  return `用法: ${cmd} ${req} ${opt}`.trim();
}

export function assertRoundCheckpointMatch(
  repoRoot: string,
  roundId: string,
  opts: {
    expectedMode?: 'extract' | 'reabsorb' | 'residue';
    expectedDir?: string;
    expectedPkgName?: string;
  },
): 'extract' | 'reabsorb' | 'residue' {
  const cp = loadCheckpoint(repoRoot, roundId);
  if (cp.committed === true || cp.rolledBack === true) {
    process.stderr.write(`轮次 ${roundId} 已结束 (committed/rolledBack)\n`);
    process.exit(1);
  }
  if (opts.expectedDir !== undefined && cp.candidateDir !== opts.expectedDir) {
    process.stderr.write(
      `轮次 ${roundId} 绑定目录 (${cp.candidateDir}) 与 --dir (${opts.expectedDir}) 不一致\n`,
    );
    process.exit(1);
  }
  if (opts.expectedMode !== undefined && cp.mode !== opts.expectedMode) {
    process.stderr.write(
      `活跃轮次 ${roundId} 模式 (${cp.mode}) 与提交参数 --mode ${opts.expectedMode} 不一致\n`,
    );
    process.exit(1);
  }
  if (
    opts.expectedPkgName !== undefined &&
    cp.mode !== 'residue' &&
    cp.candidatePkgName !== opts.expectedPkgName
  ) {
    process.stderr.write(
      `活跃轮次 ${roundId} 目标包 (${cp.candidatePkgName}) 与 --name ${opts.expectedPkgName} 不一致\n`,
    );
    process.exit(1);
  }
  return cp.mode;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** 严格读取旗标值: 若后续缺失或紧接着另一个 --flag 则视同缺失, 防止参数错位吞并 */
export function getFlag(
  argv: readonly string[],
  name: string,
): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  const val = argv[idx + 1];
  if (val === undefined || val.startsWith('--')) return undefined;
  return val;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

export function splitCsv(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 平衡括号拆分多签名 (支持多次传 --signatures、分号/竖线或括号外顶层逗号) */
export function collectSignatureArgs(argv: readonly string[]): string[] {
  const rawChunks: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--signatures') {
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) rawChunks.push(val);
    }
  }
  const out: string[] = [];
  for (const chunk of rawChunks) {
    let cur = '';
    let depth = 0;
    for (const ch of chunk) {
      if (ch === '(' || ch === '<' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '>' || ch === '}' || ch === ']') {
        depth = Math.max(0, depth - 1);
      }
      if (depth === 0 && (ch === ';' || ch === '|' || ch === ',')) {
        if (cur.trim().length > 0) out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim().length > 0) out.push(cur.trim());
  }
  return out;
}

export function writeOut(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** 严格校验显式传入的非负整数旗标, 拒绝负数或非数字输入 */
export function parseStrictNonNegativeInt(
  argv: readonly string[],
  flag: string,
  envKey?: string,
): number | undefined {
  const idx = argv.indexOf(flag);
  let raw: string | undefined;
  if (idx >= 0) {
    raw = getFlag(argv, flag);
    if (raw === undefined) {
      process.stderr.write(`参数错误: ${flag} 缺少非负整数值\n`);
      process.exit(2);
    }
  } else if (envKey !== undefined) {
    const envVal = process.env[envKey];
    if (envVal !== undefined && envVal.trim() !== '') raw = envVal.trim();
  }
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    process.stderr.write(`参数错误: ${flag} 需要非负整数, 收到 "${raw}"\n`);
    process.exit(2);
  }
  return Number.parseInt(raw.trim(), 10);
}

export function resolveRepoRoot(argv: readonly string[]): string {
  const explicit = getFlag(argv, '--repo');
  if (explicit !== undefined && explicit.trim() !== '') {
    return resolve(explicit.trim());
  }
  let cur = resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = join(cur, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          workspaces?: unknown;
        };
        if (Array.isArray(parsed.workspaces)) return cur;
      } catch {
        // 忽略无效清单继续向上定位
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(SCRIPT_DIR, '../../../..');
}

export function saveLastScanToTmp(
  repoRoot: string,
  report: ScanReport,
): string {
  const outPath = getLastScanPath(repoRoot);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

export function loadCachedOrScan(repoRoot: string): ScanReport {
  const cachedPath = getLastScanPath(repoRoot);
  if (existsSync(cachedPath)) {
    try {
      const cached = JSON.parse(readFileSync(cachedPath, 'utf8')) as ScanReport;
      if (resolve(cached.repoRoot) === resolve(repoRoot)) return cached;
    } catch {
      // 缓存损坏回退现场扫仓
    }
  }
  return scanWorkspace(repoRoot, loadLedger(repoRoot));
}

export function runWorkspaceCiVerify(
  repoRoot: string,
  phaseLabel: string,
): void {
  const ci = spawnSync('bun', ['scripts/ci.ts', '--verify'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (ci.status !== 0) {
    process.stderr.write(
      `\n${phaseLabel}: scripts/ci.ts --verify 退出码 ${ci.status ?? 1}\n`,
    );
    process.exit(ci.status ?? 1);
  }
}
