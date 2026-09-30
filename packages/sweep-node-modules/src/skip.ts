/**
 * 跳过类目标 (删除面的两道保守默认) 的集册: 判定集、批次排除与文案单源在此, 编排层只消费。
 * 两类判定本体不在本模块: 疑似安装树见 classify.ts (纯路径形态, 零 IO), 跨设备目标见 guard.ts
 * (设备比对); 本模块只管「挡下之后怎么说、怎么放行」——放行通道两样, 互不通兑:
 * 疑似安装树是 `--force` (语义面: 删后能否由项目级重装恢复), 跨设备是声明独立根或先卸载
 * (授权面: 目标落在另一文件系统上, 旗标放行不了, 见 docs/sweep/designs/deletion-guard.md「设备边界」)。
 * 入参为 SkipCandidate (非渲染类型): 判定被绑在渲染类型上会让写侧依赖读侧的展示形态。
 */
import { type ClassifyOptions, classifyTarget } from './classify.ts';
import type { SkipReason } from './codes.ts';
import type { CrossDeviceKind } from './guard.ts';
import type {
  ScanHit,
  SizeResult,
  SkipBook,
  SkipCandidate,
  SkippedTarget,
  SweepPolicy,
} from './types.ts';

/** 疑似安装树被跳过时的行尾说明 (与普通删除失败区分: 这一条从未进入删除批次) */
const SUSPECT_HINT = '已跳过 (加 --force 一并清理)';

/**
 * 跨设备目标的逐形态文案 (标注 / 行尾说明 / 末行说明的括注)。
 * 两形态的解除路径不同, 故分列: 入口在根与目标之间时, 把该挂载点声明为独立根即放行;
 * 目标本体是挂载点时, 卷上的数据不在本目标的删除面内, 只能先卸载 (声明根无济于事)。
 * 路径与设备号一律不进文案 (对人无行动价值, 也避免把外部数据带进输出面)。
 */
const CROSS_DEVICE_NOTES: Record<CrossDeviceKind, string> = {
  'on-path': '跨设备: 根与目标之间有挂载点',
  'target-itself': '跨设备: 目标本体即挂载点',
};
const CROSS_DEVICE_HINTS: Record<CrossDeviceKind, string> = {
  'on-path': '已跳过 (把该挂载点声明为独立根即可清理)',
  'target-itself': '已跳过 (挂载点无法删除, 需先卸载该卷)',
};
const CROSS_DEVICE_TRAILER_ACTIONS: Record<CrossDeviceKind, string> = {
  'on-path': '把根与目标之间的挂载点声明为独立根即可清理',
  'target-itself': '目标本体即挂载点, 需先卸载该卷',
};

/** 跨设备形态对应的清单行尾标注 */
export function crossDeviceNote(kind: CrossDeviceKind): string {
  return CROSS_DEVICE_NOTES[kind];
}

/**
 * 跳过原因的编码判定 (单源): null 即进批。
 * 判定顺序即优先级: 跨设备 (两类形态, 不受 policy 影响) → 体积未测到 → 疑似安装树
 * (仅 policy.releaseSuspects 放行); 同时命中时取更严的一侧, 与行尾/集册文案同源。
 */
export function skipReasonOf(
  entry: SkipCandidate,
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy,
): SkipReason | null {
  const deviceKind = crossDevice.get(entry.target);
  if (deviceKind !== undefined) {
    return deviceKind === 'on-path'
      ? 'cross-device:on-path'
      : 'cross-device:target-itself';
  }
  if (entry.bytes === undefined) return 'unmeasured';
  if (entry.suspect && !policy.releaseSuspects) return 'suspect-install-tree';
  return null;
}

/**
 * 该条目是否因保守默认 (或未测到体积) 被排除出删除批。
 * `releaseSuspects` 只放行疑似安装树那一类; 跨设备两类一律排除 (解除路径是改配置或卸载, 不是旗标)。
 */
export function skipsBatch(
  entry: SkipCandidate,
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy,
): boolean {
  return skipReasonOf(entry, crossDevice, policy) !== null;
}

/**
 * 候选构造器: 由扫描命中 + 体积结果 + 类别判定组装 SkipCandidate[]。
 * 与 CLI 的条目构造前半段同源 (target / bytes / suspect 三项), 把「三份数据手工 join」
 * 收进库内; size.gone 里的目标同样产出候选 (bytes 为 undefined), 天然被挡。
 */
export function toSkipCandidates(
  hits: readonly ScanHit[],
  size: SizeResult,
  options?: ClassifyOptions,
): SkipCandidate[] {
  const bytesOf = new Map(
    size.entries.map((entry): [string, number] => [entry.target, entry.bytes]),
  );
  const reasonOf = new Map(
    size.unmeasured.map((item): [string, string] => [item.target, item.reason]),
  );
  return hits.map((hit) => {
    const classification = classifyTarget(hit.target, options);
    return {
      target: hit.target,
      bytes: bytesOf.get(hit.target),
      unmeasuredReason:
        bytesOf.get(hit.target) === undefined
          ? reasonOf.get(hit.target)
          : undefined,
      suspect: classification.kind === 'suspect-install-tree',
    };
  });
}

/** 删除批次: 测到体积且未被保守默认挡下的目标 (保清单顺序) */
export function deletionBatch(
  entries: SkipCandidate[],
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy,
): string[] {
  return entries
    .filter((entry) => !skipsBatch(entry, crossDevice, policy))
    .map((entry) => entry.target);
}

/**
 * 条目的人话说明 (单源): 跨设备与疑似取本模块既有文案常量;
 * 未测到体积的取「体积统计失败: <原因>」, 与 CLI 现行行尾注记同源。
 */
function noteOf(entry: SkipCandidate, reason: SkipReason): string {
  if (reason === 'suspect-install-tree') return SUSPECT_HINT;
  if (reason === 'unmeasured') {
    return `体积统计失败: ${entry.unmeasuredReason ?? '原因未知'}`;
  }
  return CROSS_DEVICE_HINTS[
    reason === 'cross-device:on-path' ? 'on-path' : 'target-itself'
  ];
}

/** 集册跳过类目标: 计数按清单上的标记行数 (与是否测得体积无关), 说明索引只收测得体积的条目 */
export function collectSkips(
  entries: SkipCandidate[],
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy,
): SkipBook {
  const suspectSkipped = policy.releaseSuspects
    ? []
    : entries.filter((entry) => entry.suspect);
  const deviceSkipped = entries.filter((entry) =>
    crossDevice.has(entry.target),
  );

  const trailer = [
    ...(suspectSkipped.length > 0
      ? [`疑似安装树 ${suspectSkipped.length} 处默认跳过 (加 --force 一并清理)`]
      : []),
    ...(['on-path', 'target-itself'] as const).flatMap((kind) => {
      const count = deviceSkipped.filter(
        (entry) => crossDevice.get(entry.target) === kind,
      ).length;
      return count === 0
        ? []
        : [
            `跨设备目标 ${count} 处默认跳过 (${CROSS_DEVICE_TRAILER_ACTIONS[kind]})`,
          ];
    }),
  ];

  // 两类同时命中时设备说明后写入胜出: --force 放行不了它, 提示取更严的一侧 (行尾 note 两类理由均在)
  const hints = new Map<string, string>();
  for (const entry of suspectSkipped) {
    if (entry.bytes !== undefined) hints.set(entry.target, SUSPECT_HINT);
  }
  for (const entry of deviceSkipped) {
    const kind = crossDevice.get(entry.target);
    if (entry.bytes !== undefined && kind !== undefined) {
      hints.set(entry.target, CROSS_DEVICE_HINTS[kind]);
    }
  }

  // 码话合一集册 (与 plan.skipped 同源同值): 含未测到条目 (它们同属批次外目标)
  const book: SkippedTarget[] = [];
  for (const entry of entries) {
    const reason = skipReasonOf(entry, crossDevice, policy);
    if (reason === null) continue;
    book.push({ target: entry.target, reason, note: noteOf(entry, reason) });
  }

  return { entries: book, trailer, hints };
}
