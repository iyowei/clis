/**
 * 聚类打分、紧密团划分、Infra 混聚检测与 Shingle 相似度纯计算工具。
 */
import { sha256Short } from './fingerprint.ts';
import type { ClusterMember, SimilarityCluster } from './types.ts';

export function shingleMetrics(
  a: readonly string[],
  b: readonly string[],
): { jaccard: number; intersection: number } {
  if (a.length === 0 || b.length === 0) return { jaccard: 0, intersection: 0 };
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const item of setA) {
    if (setB.has(item)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return { jaccard: union === 0 ? 0 : inter / union, intersection: inter };
}

export function clusterFingerprint(
  kind: SimilarityCluster['kind'],
  keys: readonly string[],
): string {
  const sorted = [...keys].sort().join('|');
  return sha256Short(`${kind}::${sorted}`, 14);
}

export function isEffectiveInfraOnly(
  members: readonly ClusterMember[],
): boolean {
  if (members.every((m) => m.isInfra)) return true;
  if (!members.some((m) => m.isInfra)) return false;
  const prodDomains = new Set(
    members.filter((m) => !m.isInfra).map((m) => m.domainId),
  );
  return prodDomains.size < 2;
}

/** 紧密团划分: 防止单链传递闭包 (A~B 与 B~C 把彼此无交集的 A、C 强行合并) */
export function splitDenseCliques(
  comp: readonly number[],
  edgeSims: ReadonlyMap<string, number>,
  adj: ReadonlyMap<number, number[]>,
  shinglesAt: (idx: number) => readonly string[],
): number[][] {
  if (comp.length <= 2) return [[...comp]];
  const remaining = new Set(comp);
  const denseGroups: number[][] = [];

  while (remaining.size >= 2) {
    let seed = -1;
    let bestDeg = -1;
    for (const idx of remaining) {
      const deg = (adj.get(idx) ?? []).filter((n) => remaining.has(n)).length;
      if (deg > bestDeg) {
        bestDeg = deg;
        seed = idx;
      }
    }
    if (seed < 0 || bestDeg <= 0) break;

    const group = [seed];
    remaining.delete(seed);
    const seedNeighbors = (adj.get(seed) ?? []).filter((n) => remaining.has(n));
    for (const cand of seedNeighbors) {
      const cohesive = group.every((gMember) => {
        const key = `${Math.min(cand, gMember)}-${Math.max(cand, gMember)}`;
        const direct = edgeSims.get(key);
        if (direct !== undefined) return true;
        return (
          shingleMetrics(shinglesAt(cand), shinglesAt(gMember)).jaccard >= 0.18
        );
      });
      if (cohesive) {
        group.push(cand);
        remaining.delete(cand);
      }
    }
    if (group.length >= 2) denseGroups.push(group);
  }
  return denseGroups;
}

export function computePriorityScore(
  kind: SimilarityCluster['kind'],
  distinctDomains: number,
  members: readonly ClusterMember[],
  similarity: number,
  isInfraOnly: boolean,
): number {
  const kindBonus: Record<SimilarityCluster['kind'], number> = {
    'exact-clone': 45,
    'structural-clone': 35,
    'file-structural-clone': 28,
    'filename-aligned': 15,
    'capability-cluster': 0,
    'migration-residue': 40,
  };
  const totalSloc = members.reduce((sum, m) => sum + m.sloc, 0);
  const avgCut =
    members.length === 0
      ? 0
      : members.reduce((sum, m) => sum + m.cutCost, 0) / members.length;
  const avgRust =
    members.length === 0
      ? 0
      : members.reduce((sum, m) => sum + m.rustReadinessScore, 0) /
        members.length;
  const infraPenalty = isInfraOnly ? 45 : 0;
  const score =
    kindBonus[kind] +
    distinctDomains * 30 +
    Math.min(totalSloc, 200) * 0.25 +
    similarity * 25 +
    avgRust * 0.15 -
    avgCut * 6 -
    infraPenalty;
  return Math.round(score * 100) / 100;
}

export function pairAvgSim(
  group: readonly number[],
  edgeSims: ReadonlyMap<string, number>,
  fallback: number,
): number {
  let sum = 0;
  let count = 0;
  for (let x = 0; x < group.length; x += 1) {
    for (let y = x + 1; y < group.length; y += 1) {
      const a = Math.min(group[x]!, group[y]!);
      const b = Math.max(group[x]!, group[y]!);
      const s = edgeSims.get(`${a}-${b}`);
      if (s !== undefined) {
        sum += s;
        count += 1;
      }
    }
  }
  return count === 0 ? fallback : Math.round((sum / count) * 100) / 100;
}
