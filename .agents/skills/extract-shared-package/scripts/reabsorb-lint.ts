/**
 * 退化私有库内联回唯一消费方后的「模块独立性与单向边界」物理门禁 (无本仓过拟合名称硬编码):
 * 1. 验证旧共享库目录已删除, 且 tsconfig / template-manifest / README / 各消费方依赖无残留引用;
 * 2. 对于仅剩 1 消费方的内联回收 (非 --unused 零消费退役), 强制要求落入消费包独立子目录或独立文件名,
 *    严禁写入通用入口/泛化文件名 (`cli.ts` / `index.ts` / `utils.ts` 等);
 * 3. 检查消费方非测试生产代码存在对该独立模块的导入引用 (含 re-export);
 * 4. 禁止独立模块内部反向依赖消费方其他源码 (`../`), 保证未来随时零 cutCost 再抽回成独立包;
 * 5. 检查独立模块不含消费方业务专有词泄漏, 且保留配套独立单元测试 (*.test.ts)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

import {
  deriveDomainLeakTerms,
  findMatchedTerms,
  stripSourceComments,
} from './domain-terms.ts';
import { resolveRelativeModuleTarget, walkTsFiles } from './fs-utils.ts';
import { extractModuleSpecifiers } from './import-parser.ts';
import { countSloc, tokenizeSource } from './lexer.ts';
import type { WorkspaceGraph, WorkspacePackageNode } from './types.ts';

const GENERIC_MIXIN_STEMS = new Set([
  'index',
  'cli',
  'main',
  'app',
  'utils',
  'util',
  'helpers',
  'helper',
  'common',
  'commons',
  'shared',
  'misc',
  'tools',
  'toolkit',
  'stuff',
  'types',
]);

export interface ReabsorbLintOptions {
  /** 回收进唯一消费方后的独立模块相对路径 (目录 packages/<A>/src/<mod> 或文件 packages/<A>/src/<mod>.ts) */
  intoPath?: string;
  /** 明确声明本次清理的是 0 消费死库 (无唯一消费方需要承接模块) */
  unused?: boolean;
}

function findOwningConsumerPackage(
  graph: WorkspaceGraph,
  intoRelNormalized: string,
): WorkspacePackageNode | undefined {
  return graph.packages.find((pkg) =>
    intoRelNormalized.startsWith(`${pkg.dir}/src/`),
  );
}

function verifyStaticCleanup(
  repoRoot: string,
  graph: WorkspaceGraph,
  oldPkgName: string,
  oldPkgDir: string,
  violations: string[],
): void {
  if (existsSync(join(repoRoot, oldPkgDir))) {
    violations.push(`被回收旧包目录仍未移除: ${oldPkgDir}`);
  }
  const cleanupFiles = [
    'tsconfig.json',
    'packages/create-clis/scripts/template-manifest.ts',
    'README.md',
    'README.zh-CN.md',
    'docs/README.md',
  ];
  const pkgNameBoundaryRe = new RegExp(
    `(?:^|[^a-zA-Z0-9_/-])${oldPkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-zA-Z0-9_-])`,
  );
  for (const cfgFile of cleanupFiles) {
    const abs = join(repoRoot, cfgFile);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    if (
      text.includes(`"${oldPkgName}"`) ||
      text.includes(`${oldPkgDir}/`) ||
      pkgNameBoundaryRe.test(text)
    ) {
      violations.push(
        `${cfgFile} 仍残留被回收包引用 (${oldPkgName} / ${oldPkgDir})`,
      );
    }
  }
  for (const pkg of graph.packages) {
    if (pkg.internalDeps.includes(oldPkgName)) {
      violations.push(
        `${pkg.dir}/package.json 仍残留对已回收包 ${oldPkgName} 的依赖`,
      );
    }
    const pkgSrcRel = `${pkg.dir}/src`;
    for (const relFile of walkTsFiles(repoRoot, pkgSrcRel)) {
      const specs = extractModuleSpecifiers(
        tokenizeSource(readFileSync(join(repoRoot, relFile), 'utf8')),
      );
      if (
        specs.some((s) => s === oldPkgName || s.startsWith(`${oldPkgName}/`))
      ) {
        violations.push(`${relFile} 仍残留旧包导入 ${oldPkgName}`);
      }
    }
  }
}

function collectModuleFiles(
  repoRoot: string,
  intoAbs: string,
  intoRel: string,
  violations: string[],
): {
  isDirectory: boolean;
  prodFilesRel: string[];
  moduleBoundaryRel: string;
} {
  if (!existsSync(intoAbs)) {
    violations.push(`独立回收目标不存在: ${intoRel}`);
    return {
      isDirectory: false,
      prodFilesRel: [],
      moduleBoundaryRel: intoRel,
    };
  }
  const st = statSync(intoAbs);
  if (st.isDirectory()) {
    const stem = intoRel.split('/').pop() ?? '';
    if (GENERIC_MIXIN_STEMS.has(stem)) {
      violations.push(
        `回收模块子目录名 "${stem}" 属于禁止混合的泛化/入口名, 请使用独立能力命名`,
      );
    }
    const allTsRel = walkTsFiles(repoRoot, intoRel);
    const prodFilesRel = allTsRel.filter((f) => !f.endsWith('.test.ts'));
    const testFilesRel = allTsRel.filter((f) => f.endsWith('.test.ts'));
    if (!existsSync(join(intoAbs, 'index.ts'))) {
      violations.push(
        `独立子目录模式必须提供统一出口门面: ${intoRel}/index.ts`,
      );
    }
    if (testFilesRel.length === 0) {
      violations.push(
        `独立子目录 ${intoRel}/ 内至少须保留 1 个随包单元测试 (*.test.ts)`,
      );
    }
    return { isDirectory: true, prodFilesRel, moduleBoundaryRel: intoRel };
  }

  const fileName = intoRel.split('/').pop() ?? '';
  const stem = fileName.replace(/\.(?:ts|mts)$/, '');
  if (GENERIC_MIXIN_STEMS.has(stem)) {
    violations.push(
      `禁止将回收代码混入既有入口或泛化文件 (${intoRel}), 请落盘为独立子目录或独立命名模块`,
    );
  }
  const companionTestAbs = join(dirname(intoAbs), `${stem}.test.ts`);
  if (!existsSync(companionTestAbs)) {
    violations.push(
      `单文件独立回收模块 ${intoRel} 须同级保留配套单元测试 ${dirname(intoRel)}/${stem}.test.ts`,
    );
  }
  return {
    isDirectory: false,
    prodFilesRel: [intoRel],
    moduleBoundaryRel: intoRel,
  };
}

function verifyModuleIsolationAndReferences(
  repoRoot: string,
  graph: WorkspaceGraph,
  ownerPkg: WorkspacePackageNode,
  intoRel: string,
  collected: ReturnType<typeof collectModuleFiles>,
  violations: string[],
): void {
  let totalSloc = 0;
  const domainTerms = deriveDomainLeakTerms(graph);
  const ownerAllFiles = new Set(walkTsFiles(repoRoot, `${ownerPkg.dir}/src`));

  for (const prodRel of collected.prodFilesRel) {
    const content = readFileSync(join(repoRoot, prodRel), 'utf8');
    totalSloc += countSloc(content);

    const specs = extractModuleSpecifiers(tokenizeSource(content));
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      if (!collected.isDirectory) {
        violations.push(
          `单文件独立回收模块 ${prodRel} 不得产生相对依赖 "${spec}" (多文件耦合结构须采用独立子目录)`,
        );
        continue;
      }
      const resolvedRel = resolveRelativeModuleTarget(
        prodRel,
        spec,
        ownerAllFiles,
      );
      const boundaryPrefix = `${collected.moduleBoundaryRel}/`;
      const escapesBoundary =
        resolvedRel === null
          ? relative(
              resolve(repoRoot, collected.moduleBoundaryRel),
              resolve(dirname(join(repoRoot, prodRel)), spec),
            ).startsWith('..')
          : !resolvedRel.startsWith(boundaryPrefix);
      if (escapesBoundary) {
        violations.push(
          `回收子模块发生反向耦合逃逸: ${prodRel} 引用了模块边界外文件 "${spec}" (必须维持零 cutCost 独立境界)`,
        );
      }
    }

    const leaks = findMatchedTerms(stripSourceComments(content), domainTerms);
    if (leaks.length > 0) {
      violations.push(
        `回收入消费包后模块 ${prodRel} 混入了业务领域词 (${leaks.join(', ')}), 违反纯净独立原则`,
      );
    }
  }

  if (collected.prodFilesRel.length > 0 && totalSloc < 5) {
    violations.push(`独立回收模块 ${intoRel} 有效源码过少 (sloc=${totalSloc})`);
  }

  const boundaryPrefix = `${collected.moduleBoundaryRel}/`;
  const outsideProdRel = walkTsFiles(repoRoot, `${ownerPkg.dir}/src`).filter(
    (rel) => {
      if (rel.endsWith('.test.ts')) return false;
      return collected.isDirectory
        ? !rel.startsWith(boundaryPrefix) && rel !== collected.moduleBoundaryRel
        : rel !== collected.moduleBoundaryRel;
    },
  );

  const targetEntryRel = collected.isDirectory
    ? `${collected.moduleBoundaryRel}/index.ts`
    : collected.moduleBoundaryRel;
  let referencedByConsumer = false;

  for (const callerRel of outsideProdRel) {
    const specs = extractModuleSpecifiers(
      tokenizeSource(readFileSync(join(repoRoot, callerRel), 'utf8')),
    );
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const resolvedRel = resolveRelativeModuleTarget(
        callerRel,
        spec,
        ownerAllFiles,
      );
      if (resolvedRel === targetEntryRel) {
        referencedByConsumer = true;
      } else if (
        collected.isDirectory &&
        resolvedRel !== null &&
        resolvedRel.startsWith(boundaryPrefix)
      ) {
        violations.push(
          `${callerRel} 绕过门面直连内部文件 "${spec}", 应统一走 ${intoRel}/index.ts 导入`,
        );
      }
    }
  }

  if (!referencedByConsumer) {
    violations.push(
      `消费包 ${ownerPkg.name} (${ownerPkg.dir}/src/) 中未检测到对独立回收模块 ${intoRel} 的有效导入`,
    );
  }
}

/** 校验退化回收后的清理完备性与消费包内部独立子模块隔离度 */
export function lintReabsorbedTarget(
  repoRoot: string,
  graph: WorkspaceGraph,
  oldPkgName: string,
  oldPkgDir: string,
  options: ReabsorbLintOptions = {},
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  verifyStaticCleanup(repoRoot, graph, oldPkgName, oldPkgDir, violations);

  if (options.unused === true) {
    return { passed: violations.length === 0, violations };
  }

  if (options.intoPath === undefined || options.intoPath.trim() === '') {
    violations.push(
      '单消费者退化回收必须传入 --into <packages/<consumer>/src/<module-or-dir>> 以校验独立模块边界 (零消费死库请显式传 --unused)',
    );
    return { passed: false, violations };
  }

  const intoRel = normalize(options.intoPath.trim())
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  const ownerPkg = findOwningConsumerPackage(graph, intoRel);
  if (ownerPkg === undefined) {
    violations.push(
      `--into 路径 ${intoRel} 必须位于某个工作区消费包的 src/ 目录下 (形如 packages/<consumer>/src/<module>)`,
    );
    return { passed: false, violations };
  }

  const collected = collectModuleFiles(
    repoRoot,
    join(repoRoot, intoRel),
    intoRel,
    violations,
  );
  if (collected.prodFilesRel.length > 0) {
    verifyModuleIsolationAndReferences(
      repoRoot,
      graph,
      ownerPkg,
      intoRel,
      collected,
      violations,
    );
  }

  return { passed: violations.length === 0, violations };
}
