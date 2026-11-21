/**
 * 通用变异生成器与锚点守卫 (零领域硬编码): 从包级 `<api.dir>/docs/protocol/conformance/mutants.json`
 * 读取变异体清单, 对两包源码复制并注入单点缺陷到 `mutants/gen-<id>/`, 或经 `--check-anchors`
 * 执行零副作用只读锚点漂移校验 (接入 CI 门禁)。
 *
 * 用法:
 *   bun scripts/transcription/make-mutants.ts [--product <id|dir|name>] [--check-anchors] [--help]
 * 退出码: 0 成功; 1 锚点失配 / 配置非法 / 源目录不可读。
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

import {
  type ProtocolProduct,
  discoverProtocolProducts,
  resolveProtocolProduct,
} from './protocol-discovery.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MUTANTS_DIR = join(HERE, 'mutants');
const GEN_PREFIX = 'gen-';

export interface PatchSpec {
  file: string;
  find: string;
  replace: string;
  effect: string;
}

export type MutantSurface = 'cli' | 'api' | 'both';

export interface MutantSpec {
  id: string;
  title: string;
  expectCaughtBy: MutantSurface;
  expectNote: string;
  patches: PatchSpec[];
}

interface MutantsManifest {
  schemaVersion: 1;
  mutants: MutantSpec[];
}

interface AppliedPatch extends PatchSpec {
  anchorLine: number;
}

const HELP_TEXT = [
  '用法: bun scripts/transcription/make-mutants.ts [选项]',
  '',
  '  --product <id|dir|name>  指定要生成或校验变异体的协议产品 (缺省: 单产品自动选取; --check-anchors 默认遍历全部)',
  '  --check-anchors          只读校验所有已登记变异体补丁锚点精确出现 1 次 (零写盘, 供 CI 拦截源码漂移)',
  '  --help                   显示本帮助',
].join('\n');

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

const lineOf = (text: string, needle: string): number =>
  text.slice(0, text.indexOf(needle)).split('\n').length;

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

/** 读取并校验包级 `conformance/mutants.json` */
export async function loadProductMutants(
  root: string,
  product: ProtocolProduct,
): Promise<MutantSpec[]> {
  const path = join(root, product.mutantsRel);
  if (!existsSync(path)) {
    throw new Error(`产品 ${product.id} 缺少变异清单: ${product.mutantsRel}`);
  }
  const parsed = JSON.parse(
    await readFile(path, 'utf8'),
  ) as Partial<MutantsManifest>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.mutants)
  ) {
    throw new Error(`变异清单格式非法: ${product.mutantsRel}`);
  }
  return parsed.mutants;
}

async function locateSourceFile(
  baseRoot: string,
  product: ProtocolProduct,
  file: string,
): Promise<string> {
  for (const pkg of [product.api, product.cli]) {
    const candidate = join(baseRoot, pkg.dir, 'src', file);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // 继续查找另一包
    }
  }
  throw new Error(`补丁目标不在两包源码中: ${file} (产品 ${product.id})`);
}

/** 只读校验单个产品全部变异体锚点在源码中均精确出现 1 次 */
export async function checkProductAnchors(
  root: string,
  product: ProtocolProduct,
): Promise<{ checked: number; problems: string[] }> {
  const mutants = await loadProductMutants(root, product);
  const problems: string[] = [];
  let checked = 0;
  for (const mutant of mutants) {
    for (const patch of mutant.patches) {
      checked += 1;
      let target: string;
      try {
        target = await locateSourceFile(root, product, patch.file);
      } catch (error) {
        problems.push(
          `${product.id}/${mutant.id}: ${(error as Error).message}`,
        );
        continue;
      }
      const text = await readFile(target, 'utf8');
      const count = countOccurrences(text, patch.find);
      if (count !== 1) {
        problems.push(
          `${product.id}/${mutant.id} (${patch.file}): 锚点出现 ${count} 次 (期望 1 次): ${JSON.stringify(patch.find)}`,
        );
      }
    }
  }
  return { checked, problems };
}

/** 为指定产品生成单个 mutant 独立副本 (含副本 api-harness.ts、可选 probes.ts 与空 tsconfig) */
async function makeMutant(
  product: ProtocolProduct,
  mutant: MutantSpec,
  multiProduct: boolean,
): Promise<AppliedPatch[]> {
  const dirName = multiProduct
    ? `${GEN_PREFIX}${product.id}-${mutant.id}`
    : `${GEN_PREFIX}${mutant.id}`;
  const outDir = join(MUTANTS_DIR, dirName);
  const apiSrcDir = join(REPO_ROOT, product.api.dir, 'src');
  const cliSrcDir = join(REPO_ROOT, product.cli.dir, 'src');

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, product.api.dir, 'src'), { recursive: true });
  await mkdir(join(outDir, product.cli.dir, 'src'), { recursive: true });

  for (const [srcDir, pkgDir] of [
    [apiSrcDir, join(outDir, product.api.dir)],
    [cliSrcDir, join(outDir, product.cli.dir)],
  ] as const) {
    for (const rel of await listSourceFiles(srcDir)) {
      const dest = join(pkgDir, 'src', rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(join(srcDir, rel)));
    }
  }

  await mkdir(join(outDir, 'scripts', 'transcription'), { recursive: true });
  await writeFile(
    join(outDir, 'scripts', 'transcription', 'api-harness.ts'),
    await readFile(join(HERE, 'api-harness.ts')),
  );
  const probesSrc = join(REPO_ROOT, product.probesRel);
  if (existsSync(probesSrc)) {
    const probesDest = join(outDir, product.probesRel);
    await mkdir(dirname(probesDest), { recursive: true });
    await writeFile(probesDest, await readFile(probesSrc));
  }

  await writeFile(join(outDir, 'tsconfig.json'), '{}\n');
  const apiPkg = JSON.parse(
    await readFile(join(REPO_ROOT, product.api.dir, 'package.json'), 'utf8'),
  ) as { name?: unknown };
  await writeFile(
    join(outDir, product.api.dir, 'package.json'),
    `${JSON.stringify(
      {
        name: typeof apiPkg.name === 'string' ? apiPkg.name : product.api.name,
        type: 'module',
        exports: { '.': './src/index.ts' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(outDir, product.cli.dir, 'package.json'),
    await readFile(join(REPO_ROOT, product.cli.dir, 'package.json')),
  );

  const apiLink = join(outDir, 'node_modules', product.api.name);
  const apiTarget = join(outDir, product.api.dir);
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
    const target = await locateSourceFile(outDir, product, patch.file);
    const text = await readFile(target, 'utf8');
    const occurrences = countOccurrences(text, patch.find);
    if (occurrences !== 1) {
      throw new Error(
        `mutant ${mutant.id}: 锚点失配 (${patch.file}, 出现 ${occurrences} 次, 期望 1 次): ${JSON.stringify(patch.find)}\n` +
          `  源码已漂移: 更新 ${product.mutantsRel} 里的锚点后重跑, 严禁带着失配继续。`,
      );
    }
    const anchorLine = lineOf(text, patch.find);
    await writeFile(target, text.split(patch.find).join(patch.replace));
    applied.push({ ...patch, anchorLine });
  }

  const manifest = {
    id: mutant.id,
    product: product.id,
    title: mutant.title,
    expectCaughtBy: mutant.expectCaughtBy,
    expectNote: mutant.expectNote,
    sourceDir: `${product.api.dir}/src + ${product.cli.dir}/src`,
    runHint: `bun ${join(outDir, product.cli.dir, 'src', 'cli.ts')}`,
    patches: applied,
  };
  await writeFile(
    join(outDir, 'mutant.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return applied;
}

async function sweepStale(knownDirNames: Set<string>): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(MUTANTS_DIR, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GEN_PREFIX)) continue;
    if (knownDirNames.has(entry.name)) continue;
    await rm(join(MUTANTS_DIR, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let productHint: string | undefined;
  let checkAnchorsOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${HELP_TEXT}\n`);
      return 0;
    }
    if (arg === '--check-anchors') {
      checkAnchorsOnly = true;
      continue;
    }
    if (arg === '--product') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        process.stderr.write(`参数错误: --product 缺少取值\n\n${HELP_TEXT}\n`);
        return 1;
      }
      productHint = value;
      i += 1;
      continue;
    }
    process.stderr.write(`参数错误: 未知参数 ${arg}\n\n${HELP_TEXT}\n`);
    return 1;
  }

  if (checkAnchorsOnly) {
    const products =
      productHint !== undefined
        ? [resolveProtocolProduct(REPO_ROOT, productHint)]
        : discoverProtocolProducts(REPO_ROOT).filter((p) =>
            existsSync(join(REPO_ROOT, p.mutantsRel)),
          );
    if (products.length === 0) {
      process.stdout.write(
        '变异锚点闸门: 无登记 mutants.json 的协议产品, 跳过\n',
      );
      return 0;
    }
    const allProblems: string[] = [];
    let totalChecked = 0;
    for (const product of products) {
      const res = await checkProductAnchors(REPO_ROOT, product);
      totalChecked += res.checked;
      allProblems.push(...res.problems);
    }
    if (allProblems.length === 0) {
      process.stdout.write(
        `变异锚点闸门全绿 ✓ (${products.length} 个产品 · ${totalChecked} 处锚点均精确唯一匹配)\n`,
      );
      return 0;
    }
    process.stderr.write(`变异锚点闸门检出 ${allProblems.length} 处漂移:\n`);
    for (const p of allProblems) process.stderr.write(`  ✗ ${p}\n`);
    return 1;
  }

  const product = resolveProtocolProduct(REPO_ROOT, productHint);
  const mutants = await loadProductMutants(REPO_ROOT, product);
  const allProducts = discoverProtocolProducts(REPO_ROOT);
  const multiProduct = allProducts.length > 1;
  const knownDirs = new Set(
    mutants.map((m) =>
      multiProduct
        ? `${GEN_PREFIX}${product.id}-${m.id}`
        : `${GEN_PREFIX}${m.id}`,
    ),
  );
  const removed = await sweepStale(knownDirs);
  for (const name of removed) {
    process.stdout.write(`清理陈旧产物: ${name}\n`);
  }

  for (const mutant of mutants) {
    const applied = await makeMutant(product, mutant, multiProduct);
    process.stdout.write(`gen-${mutant.id} (${mutant.title})\n`);
    for (const patch of applied) {
      process.stdout.write(
        `  ${patch.file}:${patch.anchorLine}  ${patch.effect}\n`,
      );
    }
  }
  process.stdout.write(
    `\n合计 ${mutants.length} 个 mutant (${product.id}) → ${MUTANTS_DIR}\n`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
