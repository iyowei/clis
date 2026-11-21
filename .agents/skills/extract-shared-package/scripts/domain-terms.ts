/**
 * 领域专有词表通用派生与驼峰/蛇形拆词防泄漏匹配器 (无 package.json keywords 泛词污染)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WorkspaceGraph } from './types.ts';

const GENERIC_PACKAGE_PARTS = new Set([
  'node',
  'modules',
  'create',
  'utils',
  'core',
  'base',
  'lib',
  'app',
  'pkg',
]);

function readJsonRecord(absPath: string): Record<string, unknown> | null {
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从业务产品包标识与可选工作区根配置 `.extract-shared-package.json` 提取专有领域词 (不吞咽通用技术 keywords) */
export function deriveDomainLeakTerms(graph: WorkspaceGraph): string[] {
  const terms = new Set<string>();
  const scopeNames = new Set<string>();
  for (const pkg of graph.packages) {
    if (pkg.name.startsWith('@') && pkg.name.includes('/')) {
      scopeNames.add(pkg.name.slice(1, pkg.name.indexOf('/')).toLowerCase());
    }
  }

  const rootPkg = readJsonRecord(join(graph.repoRoot, 'package.json'));
  if (typeof rootPkg?.name === 'string' && rootPkg.name.length >= 4) {
    const rootLower = rootPkg.name.toLowerCase();
    if (!scopeNames.has(rootLower)) {
      terms.add(rootLower);
    }
  }

  const extraCfg = readJsonRecord(
    join(graph.repoRoot, '.extract-shared-package.json'),
  );
  if (Array.isArray(extraCfg?.domainTerms)) {
    for (const item of extraCfg.domainTerms) {
      if (typeof item === 'string' && item.trim().length >= 3) {
        terms.add(item.trim().toLowerCase());
      }
    }
  }

  for (const pkg of graph.packages) {
    if (pkg.layer === 'shared-lib') continue;
    const shortDir = pkg.dir.replace(/^packages\//, '');
    const stem = shortDir.replace(/-cli$/, '');
    if (stem.length >= 4) terms.add(stem.toLowerCase());

    const parts = stem.split('-').filter((p) => p.length > 0);
    for (const part of parts) {
      if (part.length >= 4 && !GENERIC_PACKAGE_PARTS.has(part)) {
        terms.add(part.toLowerCase());
      }
    }
    for (let i = 1; i + 1 < parts.length; i += 1) {
      const compound = parts.slice(i).join('-').toLowerCase();
      if (compound.length >= 6) terms.add(compound);
    }
  }

  return [...terms].sort();
}

/** 把驼峰、蛇形与连字符标识符拆词后再联合原串做词界匹配, 防驼峰业务词绕过 */
export function findMatchedTerms(
  text: string,
  terms: readonly string[],
): string[] {
  const camelSplit = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  const candidates = [text, camelSplit];
  const hits = new Set<string>();

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(?:^|[^a-zA-Z0-9])${escaped}(?:$|[^a-zA-Z0-9])`,
      'i',
    );
    const spaceTerm = term.replace(/[_-]+/g, ' ');
    const spaceRe = new RegExp(
      `(?:^|[^a-zA-Z0-9])${spaceTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-zA-Z0-9])`,
      'i',
    );
    if (candidates.some((c) => re.test(c) || spaceRe.test(c))) {
      hits.add(term);
    }
  }
  return [...hits].sort();
}
