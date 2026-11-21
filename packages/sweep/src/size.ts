/**
 * 体积模块门面 (策略 A 双轨): 向上游 (sweep.ts 与外部调用方) 暴露统一 createSizer() 入口, 换策略只改此一处。
 * 下游分流: `findDu()` 探测到可执行系统 du (非 win32) 时走 `size-du.ts` 磁盘占用快路径, 否则回退 `size-js.ts` 逻辑字节基线;
 * 策略与展示口径见 packages/sweep/docs/designs/scan-and-size.md「体积统计」。
 * 红线: 显式包装隔离内部模块类型, 保证公开类型面仅依赖 types.d.ts。
 */
import { createDuSizer, findDu } from './size-du.ts';
import { createJsSizer } from './size-js.ts';
import type { Sizer } from './types.ts';

export function createSizer(): Sizer {
  const bin = findDu();
  return bin !== null ? createDuSizer(bin) : createJsSizer();
}
