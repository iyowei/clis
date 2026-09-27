/**
 * 跳过类目标 (删除面的两道保守默认) 的集册: 判定集、批次排除与文案单源在此, 编排层只消费。
 * 两类判定本体不在本模块: 疑似安装树见 classify.ts (纯路径形态, 零 IO), 跨设备目标见 guard.ts
 * (设备比对); 本模块只管「挡下之后怎么说、怎么放行」——放行通道两样, 互不通兑:
 * 疑似安装树是 `--force` (语义面: 删后能否由项目级重装恢复), 跨设备是声明独立根或先卸载
 * (授权面: 目标落在另一文件系统上, 旗标放行不了, 见 docs/designs/deletion-guard.md「设备边界」)。
 */
import type { CrossDeviceKind } from './guard.ts';
import type { RenderEntry } from './render.ts';

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
 * 该条目是否因保守默认被排除出删除批。
 * `--force` 只放行疑似安装树那一类; 跨设备两类一律排除 (解除路径是改配置或卸载, 不是旗标)。
 */
export function skipsBatch(
  entry: RenderEntry,
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  force: boolean,
): boolean {
  if (crossDevice.has(entry.target)) return true;
  return entry.suspect === true && !force;
}

/** 删除批次: 测到体积且未被保守默认挡下的目标 (保清单顺序); 体积测不到的只上占位行, 不执行删除 */
export function deletionBatch(
  entries: RenderEntry[],
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  force: boolean,
): string[] {
  return entries
    .filter(
      (entry) =>
        entry.bytes !== undefined && !skipsBatch(entry, crossDevice, force),
    )
    .map((entry) => entry.target);
}

/** 跳过集册: 末行说明行与行尾说明索引 (仅体积已测到的条目带说明, 理由见 cli.ts 的接线注释) */
export interface SkipBook {
  /** 末行说明行: 按类与形态各一行, 只在出现时出 (预览与执行同用) */
  readonly trailer: string[];
  /** 目标 → 行尾说明 (未测到体积的条目不入册: 其行尾已有体积失败注记, 不混同) */
  readonly hints: ReadonlyMap<string, string>;
}

/** 集册跳过类目标: 计数按清单上的标记行数 (与是否测得体积无关), 说明索引只收测得体积的条目 */
export function collectSkips(
  entries: RenderEntry[],
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  force: boolean,
): SkipBook {
  const suspectSkipped = force
    ? []
    : entries.filter((entry) => entry.suspect === true);
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

  return { trailer, hints };
}
