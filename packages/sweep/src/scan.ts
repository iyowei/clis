/**
 * 扫描模块门面: 向上游 (sweep.ts 与外部调用方) 提供统一的 createScanner() 入口, 换候选只改此一处。
 * 下游直连胜出实现 scan-parallel.ts (基准 r2: 契约/鲁棒双绿, 真实工作区 3.4s -> 0.7s, 4.8~5.0x);
 * 并发上限 32 与扫描算法裁定见 packages/sweep/docs/designs/scan-and-size.md「实现裁定」。
 * 红线: 显式包装而非直接重导出, 确保 dist/scan.d.ts 仅依赖 types.d.ts, 不把内部 scan-parallel.d.ts 泄入公开类型面。
 */
import { createParallelScanner } from './scan-parallel.ts';
import type { Scanner } from './types.ts';

export function createScanner(): Scanner {
  return createParallelScanner();
}
