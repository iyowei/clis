/**
 * 设备边界探测内核 (内部模块, 供 `guard.ts` 的 `findCrossDeviceTargets` 委托实现)。
 * 职责: 为每条目标解析最具体归属根并按 `st_dev` 判别跨设备形态 (`on-path` / `target-itself`)。
 * 规则: 根用 `stat` (跟随链接取实际目录设备), 目标用 `lstat` (不跟随链接), 跨设备时再用 `stat(dirname)` 区分挂载点位置;
 * 红线: 任一探针不可核验 (返回 null) 时保守不判跨设备; 并发上限由上游注入, 结果保输入顺序去重输出。
 */
import type {
  CrossDeviceEntry,
  CrossDeviceKind,
  DeviceProbe,
  PathStyle,
} from './guard.ts';

/** 解析最具体归属根 (包含目标且层级最深的根, 使独立声明的挂载点根成为参照面); 无归属返回 null */
function owningRoot(
  target: string,
  roots: string[],
  style: PathStyle,
  insideAnyRoot: (
    realPath: string,
    roots: string[],
    style: PathStyle,
  ) => boolean,
): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (!insideAnyRoot(target, [root], style)) continue;
    if (best === null || insideAnyRoot(root, [best], style)) best = root;
  }
  return best;
}

export async function runCrossDeviceProbe(params: {
  targets: string[];
  roots: string[];
  style: PathStyle;
  probe: DeviceProbe;
  concurrency: number;
  insideAnyRoot: (
    realPath: string,
    roots: string[],
    style: PathStyle,
  ) => boolean;
}): Promise<CrossDeviceEntry[]> {
  const { targets, roots, style, probe, concurrency, insideAnyRoot } = params;
  if (targets.length === 0 || roots.length === 0) return [];

  const owners: (string | null)[] = Array.from({ length: targets.length });
  const uniqueRoots: string[] = [];
  const rootSeen = new Set<string>();
  for (let i = 0; i < targets.length; i += 1) {
    const owner = owningRoot(targets[i]!, roots, style, insideAnyRoot);
    owners[i] = owner;
    if (owner !== null && !rootSeen.has(owner)) {
      rootSeen.add(owner);
      uniqueRoots.push(owner);
    }
  }

  const devices = new Map<string, number | null>();
  await Promise.all(
    uniqueRoots.map(async (root) => {
      devices.set(root, await probe(root, true));
    }),
  );

  const probedKinds: (CrossDeviceKind | null)[] = Array.from({
    length: targets.length,
  });
  let next = 0;
  const workerCount = Math.min(concurrency, targets.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < targets.length) {
        const index = next;
        next += 1;
        const target = targets[index]!;
        const root = owners[index];
        if (root === null || root === undefined) {
          probedKinds[index] = null;
          continue;
        }
        const rootDev = devices.get(root);
        if (rootDev === null || rootDev === undefined) {
          probedKinds[index] = null;
          continue;
        }
        const targetDev = await probe(target, false);
        if (targetDev === null || targetDev === rootDev) {
          probedKinds[index] = null;
          continue;
        }
        const parentDev = await probe(style.ops.dirname(target), true);
        probedKinds[index] =
          parentDev !== null && parentDev !== targetDev
            ? 'target-itself'
            : 'on-path';
      }
    }),
  );

  const found = new Map<string, CrossDeviceKind>();
  for (let i = 0; i < targets.length; i += 1) {
    const kind = probedKinds[i];
    if (kind !== null && kind !== undefined) found.set(targets[i]!, kind);
  }
  return [...found.entries()].map(([target, kind]) => ({ target, kind }));
}
