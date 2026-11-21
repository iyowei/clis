/**
 * 落盘新包社区级规范、仓级挂载、消费方构建隔离与真实打包干跑体检器。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveDomainLeakTerms, findMatchedTerms } from './domain-terms.ts';
import { walkFilesUnder, walkPackageSourceFiles } from './fs-utils.ts';
import type { WorkspaceGraph } from './types.ts';

export interface PackageLintOptions {
  /** 是否运行真实 `npm pack --dry-run --json` 检验 dist/ 打包可达性 (需先完成 build) */
  verifyPack?: boolean;
}

function normalizeFilesList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function hasValidBuildTsconfig(
  tsBuildPath: string,
  pkgDirRel: string,
  violations: string[],
): void {
  if (!existsSync(tsBuildPath)) {
    violations.push(`${pkgDirRel} 缺少 tsconfig.build.json`);
    return;
  }
  const tsBuild = JSON.parse(readFileSync(tsBuildPath, 'utf8')) as {
    compilerOptions?: { paths?: unknown; noEmitOnError?: unknown };
  };
  const paths = tsBuild.compilerOptions?.paths;
  if (
    paths === null ||
    typeof paths !== 'object' ||
    Array.isArray(paths) ||
    Object.keys(paths as Record<string, unknown>).length > 0
  ) {
    violations.push(
      `${pkgDirRel}/tsconfig.build.json compilerOptions.paths 必须显式设为 {}, 防止引用其他工作区库时触发 TS6059`,
    );
  }
  if (tsBuild.compilerOptions?.noEmitOnError !== true) {
    violations.push(
      `${pkgDirRel}/tsconfig.build.json 须设 "noEmitOnError": true 防失败时向源码目录溢出脏 .d.ts`,
    );
  }
}

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isDistArtifactPath(p: unknown, ext: '.js' | '.d.ts'): boolean {
  if (typeof p !== 'string') return false;
  const clean = p.replace(/^\.\//, '');
  return clean.startsWith('dist/') && clean.endsWith(ext);
}

function checkExportsAndManifest(
  pkgDirRel: string,
  manifest: Record<string, unknown>,
  violations: string[],
): void {
  if (manifest.private !== true) {
    violations.push(`${pkgDirRel}/package.json 必须默认标为 "private": true`);
  }
  if (manifest.clisRole !== 'shared-lib') {
    violations.push(
      `${pkgDirRel}/package.json 须声明 "clisRole": "shared-lib"`,
    );
  }
  if (manifest.bin !== undefined) {
    violations.push(`${pkgDirRel} 抽离的是共享库包, 不得声明 bin 字段`);
  }
  if (manifest.sideEffects !== false) {
    violations.push(`${pkgDirRel}/package.json 必须声明 "sideEffects": false`);
  }
  if (manifest.type !== 'module') {
    violations.push(`${pkgDirRel}/package.json 必须声明 "type": "module"`);
  }
  if (!isDistArtifactPath(manifest.main, '.js')) {
    violations.push(
      `${pkgDirRel}/package.json 须声明指向构建产物的 "main": "./dist/index.js" (禁直接指源码)`,
    );
  }
  if (!isDistArtifactPath(manifest.types, '.d.ts')) {
    violations.push(
      `${pkgDirRel}/package.json 须声明指向声明产物的 "types": "./dist/index.d.ts"`,
    );
  }

  const exportsField = manifest.exports;
  if (
    exportsField === undefined ||
    exportsField === null ||
    typeof exportsField !== 'object' ||
    Array.isArray(exportsField)
  ) {
    violations.push(
      `${pkgDirRel}/package.json 必须以对象形态声明 exports["."]`,
    );
  } else {
    const rootExp = (exportsField as Record<string, unknown>)['.'];
    if (
      rootExp === null ||
      typeof rootExp !== 'object' ||
      Array.isArray(rootExp)
    ) {
      violations.push(
        `${pkgDirRel}/package.json exports["."] 须为包含 types 与 default/import 产物路径的对象`,
      );
    } else {
      const expObj = rootExp as Record<string, unknown>;
      const runtimeTarget = expObj.default ?? expObj.import;
      if (!isDistArtifactPath(runtimeTarget, '.js')) {
        violations.push(
          `${pkgDirRel}/package.json exports["."] 的 default/import 须指向 dist/*.js 构建产物`,
        );
      }
      if (!isDistArtifactPath(expObj.types, '.d.ts')) {
        violations.push(
          `${pkgDirRel}/package.json exports["."].types 须指向 dist/*.d.ts 声明产物`,
        );
      }
    }
  }

  const files = normalizeFilesList(manifest.files);
  const coversDist = files.some(
    (f) => f === 'dist' || f === 'dist/' || f === 'dist/**' || f === './dist',
  );
  if (!coversDist) {
    violations.push(
      `${pkgDirRel}/package.json 必须声明 "files": ["dist"], 否则受根 .gitignore 影响 npm pack 会丢弃全部构建产物`,
    );
  }

  const scripts =
    manifest.scripts !== null &&
    typeof manifest.scripts === 'object' &&
    !Array.isArray(manifest.scripts)
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  for (const requiredScript of ['build', 'typecheck', 'test']) {
    if (typeof scripts[requiredScript] !== 'string') {
      violations.push(
        `${pkgDirRel}/package.json 缺少 scripts.${requiredScript}`,
      );
    }
  }
}

function checkWorkspaceMountAndConsumers(
  repoRoot: string,
  graph: WorkspaceGraph,
  pkgDirRel: string,
  pkgName: string,
  violations: string[],
): void {
  const rootTsconfigPath = join(repoRoot, 'tsconfig.json');
  if (existsSync(rootTsconfigPath)) {
    const tsconfigText = readFileSync(rootTsconfigPath, 'utf8');
    if (pkgName !== '' && !tsconfigText.includes(`"${pkgName}"`)) {
      violations.push(`根 tsconfig.json paths 尚未登记 "${pkgName}"`);
    }
  }

  if (pkgName !== '') {
    const linkPath = join(repoRoot, 'node_modules', ...pkgName.split('/'));
    if (!existsSync(linkPath)) {
      violations.push(
        `node_modules/${pkgName} 工作区软链缺失, 请执行 bun install 建立工作区链接`,
      );
    }
  }

  const tmPath = join(
    repoRoot,
    'packages/create-clis/scripts/template-manifest.ts',
  );
  if (existsSync(tmPath)) {
    const tmText = readFileSync(tmPath, 'utf8');
    const normalizedDir = pkgDirRel.endsWith('/') ? pkgDirRel : `${pkgDirRel}/`;
    if (!tmText.includes(normalizedDir) && !tmText.includes(pkgDirRel)) {
      violations.push(
        `packages/create-clis/scripts/template-manifest.ts 尚未登记 ${normalizedDir}`,
      );
    }
  }

  if (pkgName === '') return;

  for (const docFile of ['README.md', 'README.zh-CN.md', 'docs/README.md']) {
    const docAbs = join(repoRoot, docFile);
    if (!existsSync(docAbs)) continue;
    const text = readFileSync(docAbs, 'utf8');
    if (!text.includes(pkgName) && !text.includes(pkgDirRel)) {
      violations.push(`${docFile} 尚未登记共享库 ${pkgName}`);
    }
  }

  for (const node of graph.packages) {
    if (!node.internalDeps.includes(pkgName)) continue;
    const consumerPkgJson = JSON.parse(
      readFileSync(join(repoRoot, node.dir, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const depVer =
      consumerPkgJson.dependencies?.[pkgName] ??
      consumerPkgJson.devDependencies?.[pkgName];
    if (depVer !== undefined && !EXACT_SEMVER_RE.test(depVer)) {
      violations.push(
        `${node.dir}/package.json 必须使用精确 semver 引用 ${pkgName} (当前 "${depVer}", 禁止 workspace:/file:/^/~)`,
      );
    }
    const consumerBuildCfg = join(repoRoot, node.dir, 'tsconfig.build.json');
    if (existsSync(consumerBuildCfg)) {
      hasValidBuildTsconfig(consumerBuildCfg, node.dir, violations);
    }
  }
}

function verifyNpmPackDryRun(
  pkgAbs: string,
  pkgDirRel: string,
  violations: string[],
): void {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgAbs,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    violations.push(
      `${pkgDirRel} npm pack --dry-run 执行失败: ${res.stderr.trim()}`,
    );
    return;
  }
  try {
    const parsed = JSON.parse(res.stdout) as Array<{
      files?: Array<{ path?: string }>;
    }>;
    const packedPaths = (parsed[0]?.files ?? [])
      .map((f) => f.path)
      .filter((p): p is string => typeof p === 'string');
    const hasDistJs = packedPaths.some(
      (p) => p.startsWith('dist/') && p.endsWith('.js'),
    );
    const hasDistDts = packedPaths.some(
      (p) => p.startsWith('dist/') && p.endsWith('.d.ts'),
    );
    if (!hasDistJs || !hasDistDts) {
      violations.push(
        `${pkgDirRel} npm pack --dry-run 产物缺少 dist/*.js 或 dist/*.d.ts (实际打包: ${packedPaths.join(', ')})`,
      );
    }
  } catch {
    violations.push(`${pkgDirRel} npm pack --dry-run JSON 输出解析失败`);
  }
}

/** 落盘后对实际新建包、深层源码防泄漏、仓级挂载与外部可打包性执行确定性体检 */
export function lintExtractedPackage(
  repoRoot: string,
  graph: WorkspaceGraph,
  pkgDirRel: string,
  options: PackageLintOptions = {},
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  const pkgAbs = join(repoRoot, pkgDirRel);
  const manifestPath = join(pkgAbs, 'package.json');

  if (!existsSync(manifestPath)) {
    return { passed: false, violations: [`缺少 ${pkgDirRel}/package.json`] };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const pkgName = typeof manifest.name === 'string' ? manifest.name : '';

  checkExportsAndManifest(pkgDirRel, manifest, violations);
  hasValidBuildTsconfig(
    join(pkgAbs, 'tsconfig.build.json'),
    pkgDirRel,
    violations,
  );

  const domainTerms = deriveDomainLeakTerms(graph);
  const srcRel = `${pkgDirRel.replace(/\/+$/, '')}/src`;
  if (!existsSync(join(pkgAbs, 'src'))) {
    violations.push(`${pkgDirRel} 缺少 src/ 目录`);
  } else {
    const testFiles = walkFilesUnder(repoRoot, srcRel, (rel) =>
      rel.endsWith('.test.ts'),
    );
    if (testFiles.length === 0) {
      violations.push(
        `${pkgDirRel}/src/ 至少须包含 1 个独立单元测试 (**/*.test.ts)`,
      );
    }
    const prodFiles = walkPackageSourceFiles(repoRoot, srcRel);
    for (const relFile of prodFiles) {
      const text = readFileSync(join(repoRoot, relFile), 'utf8');
      const leaks = findMatchedTerms(text, domainTerms);
      if (leaks.length > 0) {
        violations.push(`${relFile} 仍残留原业务领域词 (${leaks.join(', ')})`);
      }
    }
  }

  const readmePath = join(pkgAbs, 'README.md');
  if (!existsSync(readmePath)) {
    violations.push(`${pkgDirRel} 缺少社区化 README.md`);
  } else {
    const rawReadme = readFileSync(readmePath, 'utf8');
    // 允许 README 中引用包自身的完整 npm 名称 (例如 # @scope/pkg)
    const readmeText =
      pkgName !== '' ? rawReadme.replaceAll(pkgName, '') : rawReadme;
    const leaks = findMatchedTerms(readmeText, domainTerms);
    if (leaks.length > 0) {
      violations.push(
        `${pkgDirRel}/README.md 仍残留原业务领域词 (${leaks.join(', ')})`,
      );
    }
  }

  checkWorkspaceMountAndConsumers(
    repoRoot,
    graph,
    pkgDirRel,
    pkgName,
    violations,
  );

  if (options.verifyPack === true) {
    verifyNpmPackDryRun(pkgAbs, pkgDirRel, violations);
  }

  return { passed: violations.length === 0, violations };
}
