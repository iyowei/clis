/**
 * perf-loop 同产品双包协同作用域 (--allow-cross-pkg) 快照、依赖重构建与联动门禁编排。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProductPairs } from '../../../../scripts/lib/workspace.ts';
import {
  computeBenchDirHashes,
  diffSnapshotFiles,
  restorePackageSnapshot,
  savePackageSnapshot,
} from './fs-hash.ts';
import { runPackageValidationGates } from './workspace-ops.ts';

/** 同产品配对包快照状态 */
export interface CompanionPackageState {
  pkgName: string;
  pkgDir: string;
  baselineDir: string;
  candidateDir: string;
  baselineBenchHashes: Record<string, string>;
}

/** 解析与目标包同属一组双包产品的配对包列表 (如 API 主包 ↔ CLI 薄壳包) */
export function resolveCompanionPackages(
  repoRoot: string,
  pkgDir: string,
): Array<{ name: string; dir: string }> {
  try {
    const pairs = resolveProductPairs(repoRoot);
    const byDir = new Map<string, { name: string; dir: string }>();
    for (const pair of pairs) {
      if (pair.api.dir === pkgDir) {
        byDir.set(pair.cli.dir, { name: pair.cli.name, dir: pair.cli.dir });
      } else if (pair.cli.dir === pkgDir) {
        byDir.set(pair.api.dir, { name: pair.api.name, dir: pair.api.dir });
      }
    }
    return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  } catch {
    return [];
  }
}

/** 在 prepare 阶段为同产品配对包建立基线快照与 bench 防篡改指纹 */
export function prepareCompanionSnapshots(
  repoRoot: string,
  runDir: string,
  pkgDir: string,
): CompanionPackageState[] {
  const companions = resolveCompanionPackages(repoRoot, pkgDir);
  const states: CompanionPackageState[] = [];
  for (const comp of companions) {
    const safeKey = comp.dir.replaceAll('/', '__');
    const baselineDir = join(runDir, 'companions', safeKey, 'baseline');
    const candidateDir = join(runDir, 'companions', safeKey, 'candidate');
    savePackageSnapshot(repoRoot, comp.dir, baselineDir);
    states.push({
      pkgName: comp.name,
      pkgDir: comp.dir,
      baselineDir,
      candidateDir,
      baselineBenchHashes: computeBenchDirHashes(repoRoot, comp.dir),
    });
  }
  return states;
}

/** 在 evaluate 阶段保存主包与协同包候选快照并计算差异清单 */
export function captureScopedCandidates(
  repoRoot: string,
  pkgDir: string,
  baselineDir: string,
  candidateDir: string,
  companions: readonly CompanionPackageState[],
): {
  primaryTouched: string[];
  companionTouchedByDir: Record<string, string[]>;
  activeCompanions: CompanionPackageState[];
  allTouchedFiles: string[];
} {
  savePackageSnapshot(repoRoot, pkgDir, candidateDir);
  const primaryTouched = diffSnapshotFiles(baselineDir, candidateDir);
  const companionTouchedByDir: Record<string, string[]> = {};
  const activeCompanions: CompanionPackageState[] = [];
  const allTouchedFiles = [...primaryTouched];

  for (const comp of companions) {
    savePackageSnapshot(repoRoot, comp.pkgDir, comp.candidateDir);
    const diffs = diffSnapshotFiles(comp.baselineDir, comp.candidateDir);
    companionTouchedByDir[comp.pkgDir] = diffs;
    if (diffs.length > 0) {
      activeCompanions.push(comp);
      for (const rel of diffs) {
        allTouchedFiles.push(`${comp.pkgDir}/${rel}`);
      }
    }
  }

  return {
    primaryTouched,
    companionTouchedByDir,
    activeCompanions,
    allTouchedFiles,
  };
}

function readPkgManifestInfo(
  repoRoot: string,
  pkgDir: string,
): { hasBin: boolean; hasBuildScript: boolean } {
  const pkgJsonPath = join(repoRoot, pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { hasBin: false, hasBuildScript: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      bin?: unknown;
      scripts?: Record<string, unknown>;
    };
    const hasBuildScript =
      typeof parsed.scripts?.build === 'string' &&
      parsed.scripts.build.trim() !== '';
    return { hasBin: parsed.bin !== undefined, hasBuildScript };
  } catch {
    return { hasBin: false, hasBuildScript: false };
  }
}

/** 按「先无 bin 库包, 后有 bin CLI 包」拓扑序执行关联包 scripts.build */
export function rebuildPackagesInOrder(
  repoRoot: string,
  pkgDirs: readonly string[],
): { ok: boolean; failedDir?: string; output?: string } {
  const uniqueDirs = [...new Set(pkgDirs)];
  const ordered = uniqueDirs
    .map((dir) => ({ dir, info: readPkgManifestInfo(repoRoot, dir) }))
    .filter((item) => item.info.hasBuildScript)
    .sort((a, b) => Number(a.info.hasBin) - Number(b.info.hasBin));

  for (const item of ordered) {
    const res = spawnSync('bun', ['run', 'build'], {
      cwd: join(repoRoot, item.dir),
      encoding: 'utf8',
      timeout: 60000,
    });
    if (res.status !== 0) {
      return {
        ok: false,
        failedDir: item.dir,
        output: `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim(),
      };
    }
  }
  return { ok: true };
}

/** 原子切换主包与协同包快照, 并在需要时按拓扑序重跑构建 */
export function restoreScopedVariant(options: {
  repoRoot: string;
  pkgDir: string;
  primarySnapshotDir: string;
  companions?: readonly CompanionPackageState[];
  variant: 'baseline' | 'candidate';
  rebuildIfNeeded?: boolean;
  ignoreRebuildFailure?: boolean;
}): void {
  restorePackageSnapshot(
    options.repoRoot,
    options.pkgDir,
    options.primarySnapshotDir,
  );
  const companions = options.companions ?? [];
  for (const comp of companions) {
    const snapDir =
      options.variant === 'baseline' ? comp.baselineDir : comp.candidateDir;
    if (existsSync(join(snapDir, '.snapshot-manifest.json'))) {
      restorePackageSnapshot(options.repoRoot, comp.pkgDir, snapDir);
    }
  }
  if (options.rebuildIfNeeded === true) {
    const allDirs = [options.pkgDir, ...companions.map((c) => c.pkgDir)];
    const buildRes = rebuildPackagesInOrder(options.repoRoot, allDirs);
    if (!buildRes.ok && options.ignoreRebuildFailure !== true) {
      throw new Error(
        `切换 ${options.variant} 快照后构建 ${buildRes.failedDir ?? ''} 失败: ${buildRes.output ?? ''}`,
      );
    }
  }
}

/** 联动执行主包与 (--allow-cross-pkg 下) 协同包的构建、bun check、oxlint 与 bun test */
export function runScopedValidationGates(options: {
  repoRoot: string;
  pkgDir: string;
  primaryTouched: readonly string[];
  allowCrossPkg: boolean;
  companions: readonly CompanionPackageState[];
  companionTouchedByDir: Readonly<Record<string, readonly string[]>>;
}): { ok: boolean; stage: string; output: string } {
  const alreadyRebuilt = options.allowCrossPkg && options.companions.length > 0;
  if (alreadyRebuilt) {
    const buildRes = rebuildPackagesInOrder(options.repoRoot, [
      options.pkgDir,
      ...options.companions.map((c) => c.pkgDir),
    ]);
    if (!buildRes.ok) {
      return {
        ok: false,
        stage: `build (${buildRes.failedDir ?? options.pkgDir})`,
        output: buildRes.output ?? '',
      };
    }
  }

  const primaryGate = runPackageValidationGates(
    options.repoRoot,
    options.pkgDir,
    options.primaryTouched,
    { skipBuild: alreadyRebuilt },
  );
  if (!primaryGate.ok) return primaryGate;

  if (options.allowCrossPkg) {
    for (const comp of options.companions) {
      const compTouched = options.companionTouchedByDir[comp.pkgDir] ?? [];
      const compGate = runPackageValidationGates(
        options.repoRoot,
        comp.pkgDir,
        compTouched,
        { skipBuild: alreadyRebuilt },
      );
      if (!compGate.ok) {
        return {
          ok: false,
          stage: `${comp.pkgDir}:${compGate.stage}`,
          output: compGate.output,
        };
      }
    }
  }

  return { ok: true, stage: 'all', output: '' };
}
