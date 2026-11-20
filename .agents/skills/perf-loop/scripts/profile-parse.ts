/**
 * 从 Bun (--cpu-prof-md / --heap-prof-md) 与 Node (--cpu-prof JSON) 剖析输出抽取紧凑摘要。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ProfileDigest } from './types.ts';

function extractTableRows(
  markdown: string,
  sectionHeader: string,
  maxRows: number,
): string[] {
  const lines = markdown.split('\n');
  const rows: string[] = [];
  let inSection = false;
  let seenSeparator = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inSection) break;
      inSection = line.includes(sectionHeader);
      seenSeparator = false;
      continue;
    }
    if (!inSection || !line.startsWith('|')) continue;
    if (line.includes('---')) {
      seenSeparator = true;
      continue;
    }
    if (!seenSeparator) continue;
    rows.push(line.trim());
    if (rows.length >= maxRows) break;
  }
  return rows;
}

function isSetupFrame(row: string): boolean {
  return (
    row.includes('/bench/') ||
    row.includes('fixtures.ts') ||
    row.includes('makeWorkspace') ||
    row.includes('`writeFile`') ||
    row.includes('`mkdir`')
  );
}

/** 抽取 Bun CPU / Heap Profile 摘要并分离测试搭建噪音与真实业务热点 */
export function parseProfileMarkdowns(
  cpuMdPath: string | null,
  heapMdPath: string | null,
  cpuRatio: number | null,
  userCpuShare: number | null = null,
): ProfileDigest {
  const allRows =
    cpuMdPath !== null && existsSync(cpuMdPath)
      ? extractTableRows(
          readFileSync(cpuMdPath, 'utf8'),
          'Hot Functions (Self Time)',
          24,
        )
      : [];

  const targetHotFunctions: string[] = [];
  const setupHotFunctions: string[] = [];
  for (const row of allRows) {
    if (isSetupFrame(row)) {
      if (setupHotFunctions.length < 6) setupHotFunctions.push(row);
    } else if (targetHotFunctions.length < 10) {
      targetHotFunctions.push(row);
    }
  }

  const heapTopTypes =
    heapMdPath !== null && existsSync(heapMdPath)
      ? extractTableRows(
          readFileSync(heapMdPath, 'utf8'),
          'Top 50 Types by Retained Size',
          12,
        )
      : [];

  const ioDominatedHint =
    (cpuRatio !== null && cpuRatio < 0.2) ||
    (userCpuShare !== null && userCpuShare < 0.3);

  return {
    targetHotFunctions,
    setupHotFunctions,
    heapTopTypes,
    cpuRatio,
    userCpuShare,
    ioDominatedHint,
  };
}

interface V8CpuProfileNode {
  id: number;
  hitCount?: number;
  callFrame?: {
    functionName?: string;
    url?: string;
    lineNumber?: number;
  };
}

/** 从 Node --cpu-prof 产出的 .cpuprofile JSON 中抽取 Top-8 热点函数 */
export function parseNodeCpuProfileDir(profDir: string): string[] {
  if (!existsSync(profDir)) return [];
  const file = readdirSync(profDir).find((name) =>
    name.endsWith('.cpuprofile'),
  );
  if (file === undefined) return [];

  const parsed = JSON.parse(readFileSync(join(profDir, file), 'utf8')) as {
    nodes?: V8CpuProfileNode[];
  };
  const nodes = parsed.nodes ?? [];
  let totalHits = 0;
  for (const node of nodes) totalHits += node.hitCount ?? 0;
  if (totalHits === 0) return [];

  const ranked = nodes
    .filter((node) => (node.hitCount ?? 0) > 0)
    .sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))
    .slice(0, 8);

  return ranked.map((node) => {
    const hits = node.hitCount ?? 0;
    const pct = ((hits / totalHits) * 100).toFixed(1);
    const fn = node.callFrame?.functionName || '(anonymous)';
    const url = node.callFrame?.url || '[native]';
    const line =
      node.callFrame?.lineNumber !== undefined
        ? `:${node.callFrame.lineNumber + 1}`
        : '';
    return `${pct}% (${hits} hits) ${fn} @ ${url}${line}`;
  });
}
