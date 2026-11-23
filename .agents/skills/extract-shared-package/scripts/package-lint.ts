/**
 * 落盘新包社区级规范、仓级挂载、消费方构建隔离与真实打包干跑体检器。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import {
  deriveDomainLeakTerms,
  findMatchedTerms,
  stripReadmeAllowedRefs,
  stripSourceComments,
} from './domain-terms.ts';
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

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
  if (!isPlainObj(paths) || Object.keys(paths).length > 0) {
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

  const rootExp = isPlainObj(manifest.exports) ? manifest.exports['.'] : null;
  if (!isPlainObj(rootExp)) {
    violations.push(
      `${pkgDirRel}/package.json exports["."] 须为包含 types 与 default/import 产物路径的对象`,
    );
  } else {
    if (!isDistArtifactPath(rootExp.default ?? rootExp.import, '.js')) {
      violations.push(
        `${pkgDirRel}/package.json exports["."] 的 default/import 须指向 dist/*.js 构建产物`,
      );
    }
    if (!isDistArtifactPath(rootExp.types, '.d.ts')) {
      violations.push(
        `${pkgDirRel}/package.json exports["."].types 须指向 dist/*.d.ts 声明产物`,
      );
    }
  }

  const files = normalizeFilesList(manifest.files);
  if (
    !files.some(
      (f) => f === 'dist' || f === 'dist/' || f === 'dist/**' || f === './dist',
    )
  ) {
    violations.push(
      `${pkgDirRel}/package.json 必须声明 "files": ["dist"], 否则受根 .gitignore 影响 npm pack 会丢弃全部构建产物`,
    );
  }

  const scripts = isPlainObj(manifest.scripts) ? manifest.scripts : {};
  for (const req of ['build', 'typecheck', 'test']) {
    if (typeof scripts[req] !== 'string') {
      violations.push(`${pkgDirRel}/package.json 缺少 scripts.${req}`);
    }
  }
}

export function stripFencedCode(content: string): string {
  let fenceChar: string | null = null;
  let fenceLen = 0;
  return content
    .split('\n')
    .map((line) => {
      if (fenceChar === null) {
        const open = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        const info = open?.[2] ?? '';
        if (open !== null && (open[1]![0] !== '`' || !info.includes('`'))) {
          fenceChar = open[1]![0]!;
          fenceLen = open[1]!.length;
          return '';
        }
        return line;
      }
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (
        close !== null &&
        close[1]![0] === fenceChar &&
        close[1]!.length >= fenceLen
      ) {
        fenceChar = null;
        fenceLen = 0;
      }
      return '';
    })
    .join('\n');
}

function parseGithubSlug(raw: string): string | null {
  const m = raw.match(
    /(?:github\.com[:/]|^github:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  );
  if (m?.[1] !== undefined) return m[1].toLowerCase();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)
    ? raw.toLowerCase()
    : null;
}

function resolveSelfGithubMatcher(
  repoRoot?: string,
): (ownerRepo: string) => boolean {
  if (repoRoot === undefined) return (slug) => slug === 'iyowei/clis';
  const slugs = new Set<string>();
  let repoShort = '';
  const pkgPath = join(repoRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<
        string,
        unknown
      >;
      if (typeof pkg.name === 'string')
        repoShort = pkg.name.replace(/^@[^/]+\//, '').toLowerCase();
      const repoVal = isPlainObj(pkg.repository)
        ? pkg.repository.url
        : pkg.repository;
      const parsed =
        typeof repoVal === 'string' ? parseGithubSlug(repoVal.trim()) : null;
      if (parsed !== null) slugs.add(parsed);
    } catch {
      // 忽略异常 package.json
    }
  }
  const gitCfg = join(repoRoot, '.git', 'config');
  if (existsSync(gitCfg)) {
    for (const m of readFileSync(gitCfg, 'utf8').matchAll(
      /^\s*url\s*=\s*(\S+)\s*$/gm,
    )) {
      const parsed = parseGithubSlug(m[1]!);
      if (parsed !== null) slugs.add(parsed);
    }
  }
  if (slugs.size > 0) return (slug) => slugs.has(slug);
  if (repoShort !== '') return (slug) => slug.endsWith(`/${repoShort}`);
  return (slug) => slug === 'iyowei/clis';
}

export function hasMarkdownLinkToPkgReadme(
  docText: string,
  docFile: string,
  cleanPkgDir: string,
  repoRoot?: string,
): boolean {
  const stripped = stripFencedCode(docText);
  const baseDir = posix.dirname(docFile);
  const isSelfRepo = resolveSelfGithubMatcher(repoRoot);
  const escapedDir = cleanPkgDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const readmeRe = new RegExp(
    `^${escapedDir}/README(?:\\.[^/]+)?(?:\\.md)?$`,
    'i',
  );

  for (const m of stripped.matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = m[1]!;
    if (raw.startsWith('#') || raw.startsWith('//')) continue;
    let resolved = '';
    if (raw.includes('://')) {
      const gh = raw.match(
        /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|tree)\/main\/([^#?\s]+)/i,
      );
      if (gh === null || !isSelfRepo(gh[1]!.toLowerCase())) continue;
      resolved = posix.normalize(gh[2]!).replace(/\/+$/, '');
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      continue;
    } else {
      const pathPart = (raw.split('#')[0] ?? '').split('?')[0] ?? '';
      if (pathPart === '') continue;
      const joined = pathPart.startsWith('/')
        ? pathPart.slice(1)
        : posix.join(baseDir, pathPart);
      resolved = posix.normalize(joined).replace(/\/+$/, '');
    }
    if (resolved === cleanPkgDir || readmeRe.test(resolved)) return true;
  }
  return false;
}

function checkRootDocRegistrations(
  repoRoot: string,
  cleanPkgDir: string,
  pkgName: string,
  isPrivate: boolean,
  violations: string[],
): void {
  const needsReadmeLink =
    existsSync(join(repoRoot, cleanPkgDir, 'README.md')) &&
    !existsSync(join(repoRoot, cleanPkgDir, 'docs', 'README.md'));

  for (const docFile of ['README.md', 'README.zh-CN.md', 'docs/README.md']) {
    const docAbs = join(repoRoot, docFile);
    if (!existsSync(docAbs)) continue;
    const text = readFileSync(docAbs, 'utf8');
    if (!text.includes(pkgName) && !text.includes(cleanPkgDir)) {
      violations.push(`${docFile} 尚未登记共享库 ${pkgName}`);
      continue;
    }
    const reqLink =
      needsReadmeLink && (docFile === 'docs/README.md' || !isPrivate);
    if (
      reqLink &&
      !hasMarkdownLinkToPkgReadme(text, docFile, cleanPkgDir, repoRoot)
    ) {
      const rel =
        docFile === 'docs/README.md'
          ? `../${cleanPkgDir}/README.md`
          : `${cleanPkgDir}/README.md`;
      violations.push(
        `${docFile} 登记 ${pkgName} 时须包含指向 ${rel} 的 Markdown 链接 (防止零入链孤儿包 README)`,
      );
    }
  }
}

function checkWorkspaceMountAndConsumers(
  repoRoot: string,
  graph: WorkspaceGraph,
  pkgDirRel: string,
  pkgName: string,
  isPrivate: boolean,
  violations: string[],
): void {
  const rootTsconfigPath = join(repoRoot, 'tsconfig.json');
  if (existsSync(rootTsconfigPath) && pkgName !== '') {
    if (!readFileSync(rootTsconfigPath, 'utf8').includes(`"${pkgName}"`)) {
      violations.push(`根 tsconfig.json paths 尚未登记 "${pkgName}"`);
    }
  }
  if (
    pkgName !== '' &&
    !existsSync(join(repoRoot, 'node_modules', ...pkgName.split('/')))
  ) {
    violations.push(
      `node_modules/${pkgName} 工作区软链缺失, 请执行 bun install 建立工作区链接`,
    );
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

  const cleanPkgDir = pkgDirRel.replace(/^\.\//, '').replace(/\/+$/, '');
  checkRootDocRegistrations(
    repoRoot,
    cleanPkgDir,
    pkgName,
    isPrivate,
    violations,
  );
  for (const existing of graph.existingViolations) {
    violations.push(`依赖拓扑违规: ${existing}`);
  }

  for (const node of graph.packages) {
    if (!node.internalDeps.includes(pkgName)) continue;
    const cPkg = JSON.parse(
      readFileSync(join(repoRoot, node.dir, 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const depVer =
      cPkg.dependencies?.[pkgName] ??
      cPkg.devDependencies?.[pkgName] ??
      cPkg.peerDependencies?.[pkgName] ??
      cPkg.optionalDependencies?.[pkgName];
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
    const packed = (parsed[0]?.files ?? [])
      .map((f) => f.path)
      .filter((p): p is string => typeof p === 'string');
    const hasJs = packed.some(
      (p) => p.startsWith('dist/') && p.endsWith('.js'),
    );
    const hasDts = packed.some(
      (p) => p.startsWith('dist/') && p.endsWith('.d.ts'),
    );
    if (!hasJs || !hasDts) {
      violations.push(
        `${pkgDirRel} npm pack --dry-run 产物缺少 dist/*.js 或 dist/*.d.ts (实际打包: ${packed.join(', ')})`,
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
    if (
      walkFilesUnder(repoRoot, srcRel, (r) => r.endsWith('.test.ts')).length ===
      0
    ) {
      violations.push(
        `${pkgDirRel}/src/ 至少须包含 1 个独立单元测试 (**/*.test.ts)`,
      );
    }
    for (const relFile of walkPackageSourceFiles(repoRoot, srcRel)) {
      const rawCode = readFileSync(join(repoRoot, relFile), 'utf8');
      const leaks = findMatchedTerms(stripSourceComments(rawCode), domainTerms);
      if (leaks.length > 0) {
        violations.push(`${relFile} 仍残留原业务领域词 (${leaks.join(', ')})`);
      }
    }
  }

  const readmePath = join(pkgAbs, 'README.md');
  if (!existsSync(readmePath)) {
    violations.push(`${pkgDirRel} 缺少社区化 README.md`);
  } else {
    const readmeText = stripReadmeAllowedRefs(
      readFileSync(readmePath, 'utf8'),
      graph,
      pkgName,
      manifest.private === true,
    );
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
    manifest.private === true,
    violations,
  );
  if (options.verifyPack === true)
    verifyNpmPackDryRun(pkgAbs, pkgDirRel, violations);
  return { passed: violations.length === 0, violations };
}
