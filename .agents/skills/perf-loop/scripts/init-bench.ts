/**
 * 为缺乏 bench 基建的包创建符合 BenchJsonReport v1 契约的标准 bench/run.ts 骨架,
 * 并同步更新包级 package.json 与 tsconfig.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InitBenchResult {
  pkgName: string;
  pkgDir: string;
  createdFiles: string[];
  updatedFiles: string[];
  manifestWarning: string | null;
}

function buildBenchTemplate(pkgName: string): string {
  return `// @perf-loop:stub — 请先替换为该包真实核心热点负载并删除本行标记
/**
 * ${pkgName} 基准套件 (符合 perf-loop BenchJsonReport v1 协议)。
 *
 * 约定:
 * 1. 支持 \`--json\` (stdout 末行输出单行 JSON)、\`--quick\` 与 \`--case <name>\`;
 * 2. 兼容 Bun 与 Node 双运行时直接执行 (禁止使用 import.meta.dir 等单端属性);
 * 3. 零第三方依赖 (仅使用 node:* / bun:* 与相对导入);
 * 4. 每个用例必须产出确定的校验摘要 digest, 防止优化破坏语义。
 */
import { createHash } from 'node:crypto';

interface BenchCaseSample {
  name: string;
  role?: 'primary' | 'reference';
  iterations: number;
  samplesMs: number[];
  minMs: number;
  medianMs: number;
  p95Ms: number;
  heapDeltaMB?: number;
  peakRssMB?: number;
  cpuUserMs?: number;
  cpuSysMs?: number;
  size?: number;
  unit?: string;
  digest?: string;
}

interface BenchJsonReport {
  schemaVersion: 1;
  package: string;
  runtime: 'bun' | 'node';
  runtimeVersion: string;
  suite: 'quick' | 'full';
  cases: BenchCaseSample[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  const weight = pos - low;
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * weight;
}

/** TODO: 替换为该包真实核心热点负载 (避免死代码消除: 把输出喂入 digest) */
function runCoreWorkload(): string {
  // 示例占位: 请在基准建设阶段替换为目标包公开/核心函数的代表性输入场景
  let acc = 0;
  for (let i = 0; i < 10000; i += 1) {
    acc += i;
  }
  return String(acc);
}

function measureCase(name: string, iterations: number): BenchCaseSample {
  // 预热
  runCoreWorkload();

  const cpuBefore = process.cpuUsage();
  const heapBefore = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  const samplesMs: number[] = [];
  let lastResult = '';

  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    lastResult = runCoreWorkload();
    samplesMs.push(performance.now() - start);
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }

  const cpuDiff = process.cpuUsage(cpuBefore);
  const heapAfter = process.memoryUsage().heapUsed;
  const sorted = [...samplesMs].sort((a, b) => a - b);

  return {
    name,
    role: 'primary',
    iterations,
    samplesMs,
    minMs: sorted[0] ?? 0,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    heapDeltaMB: Math.round(((heapAfter - heapBefore) / 1048576) * 10) / 10,
    peakRssMB: Math.round((peakRss / 1048576) * 10) / 10,
    cpuUserMs: Math.round((cpuDiff.user / 1000) * 100) / 100,
    cpuSysMs: Math.round((cpuDiff.system / 1000) * 100) / 100,
    size: 1,
    unit: 'ops',
    digest: createHash('sha256').update(lastResult).digest('hex').slice(0, 16),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const quickMode = argv.includes('--quick');
  const caseIdx = argv.indexOf('--case');
  const caseFilter = caseIdx >= 0 ? argv[caseIdx + 1] : undefined;

  const iterations = quickMode ? 15 : 30;
  const allCases = ['core-workload'];
  const selected =
    caseFilter !== undefined
      ? allCases.filter((name) => name === caseFilter)
      : allCases;

  const cases = selected.map((name) => measureCase(name, iterations));
  const isBun = typeof Bun !== 'undefined';

  const report: BenchJsonReport = {
    schemaVersion: 1,
    package: '${pkgName}',
    runtime: isBun ? 'bun' : 'node',
    runtimeVersion: isBun ? Bun.version : process.version.replace(/^v/, ''),
    suite: quickMode ? 'quick' : 'full',
    cases,
  };

  if (jsonMode) {
    process.stdout.write(\`\${JSON.stringify(report)}\\n\`);
    return;
  }

  process.stdout.write(\`=== \${report.package} bench (\${report.runtime} \${report.runtimeVersion}) ===\\n\`);
  for (const c of cases) {
    process.stdout.write(
      \`\${c.name.padEnd(20)} min=\${c.minMs.toFixed(2)}ms median=\${c.medianMs.toFixed(2)}ms p95=\${c.p95Ms.toFixed(2)}ms rss=\${c.peakRssMB ?? '-'}MB\\n\`,
    );
  }
}

if (import.meta.main) main();
`;
}

/** 检查 template-manifest.ts 是否已覆盖新生成的 packages/<pkg>/bench/ */
function checkTemplateManifestCoverage(
  repoRoot: string,
  pkgDir: string,
): string | null {
  const manifestFile = join(
    repoRoot,
    'packages',
    'create-clis',
    'scripts',
    'template-manifest.ts',
  );
  if (!existsSync(manifestFile)) return null;
  const content = readFileSync(manifestFile, 'utf8');
  if (
    content.includes(`'${pkgDir}/'`) ||
    content.includes(`'${pkgDir}/bench/'`)
  ) {
    return null;
  }
  return `注意: ${pkgDir}/bench/ 尚未在 packages/create-clis/scripts/template-manifest.ts 登记排除, 须补加 excl('${pkgDir}/bench/', '...'), 否则模板完备测试会红灯`;
}

/** 为无 bench 包初始化标准骨架 */
export function initBenchForPackage(
  repoRoot: string,
  pkgDir: string,
  pkgName: string,
): InitBenchResult {
  const pkgAbs = join(repoRoot, pkgDir);
  const benchDir = join(pkgAbs, 'bench');
  const benchRunPath = join(benchDir, 'run.ts');
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];

  if (existsSync(benchRunPath)) {
    throw new Error(
      `${pkgDir}/bench/run.ts 已存在, 请手工确认是否仅需补充 --json 协议`,
    );
  }

  mkdirSync(benchDir, { recursive: true });
  writeFileSync(benchRunPath, buildBenchTemplate(pkgName), 'utf8');
  createdFiles.push(`${pkgDir}/bench/run.ts`);

  const pkgJsonPath = join(pkgAbs, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  if (pkgJson.scripts === undefined) pkgJson.scripts = {};
  if (pkgJson.scripts.bench === undefined) {
    pkgJson.scripts.bench = 'bun bench/run.ts';
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8');
    updatedFiles.push(`${pkgDir}/package.json`);
  }

  const tsconfigPath = join(pkgAbs, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as {
      include?: string[];
    };
    if (
      Array.isArray(tsconfig.include) &&
      !tsconfig.include.includes('bench')
    ) {
      tsconfig.include.push('bench');
      writeFileSync(
        tsconfigPath,
        `${JSON.stringify(tsconfig, null, 2)}\n`,
        'utf8',
      );
      updatedFiles.push(`${pkgDir}/tsconfig.json`);
    }
  }

  return {
    pkgName,
    pkgDir,
    createdFiles,
    updatedFiles,
    manifestWarning: checkTemplateManifestCoverage(repoRoot, pkgDir),
  };
}
