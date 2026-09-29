/**
 * 判别值与枚举的类型集: 错误码 / 告警码 / 跳过原因 / 体积口径 / 编排阶段。
 *
 * 契约基准: docs/designs/api-surface.md §3.2 与 §7.3。
 * 命名规则: `<域>_<判定>`, 全大写蛇形; 域取自模块 (SCAN / SIZE / GUARD / REMOVE / CONFIG / SWEEP)。
 * 硬纪律: **code 一经发布即冻结, 只增不改** (废弃走文档标注, 不回收取值);
 * 且同一个 code 不得合并「处置方向相反」的语义 (调用方必须能不读 message 就决定下一步)。
 */

/** 扫描段告警码 (进 ScanResult.warnings) */
export type ScanWarningCode =
  | 'SCAN_ROOT_MISSING'
  | 'SCAN_ROOT_UNREADABLE'
  | 'SCAN_ROOT_NOT_DIR'
  | 'SCAN_ROOT_UNAVAILABLE'
  | 'SCAN_DIR_UNREADABLE';

/** 体积段告警码 (进 SizeResult.warnings, 只作事件、不作划分) */
export type SizeWarningCode =
  | 'SIZE_DU_OUTPUT_MISMATCH'
  | 'SIZE_DU_LINE_UNATTRIBUTED'
  | 'SIZE_SUBPATH_FAILED'
  | 'SIZE_TARGET_VANISHED'
  | 'SIZE_DU_UNAVAILABLE';

/** 并集别名: 后续新增告警域时随之扩展 */
export type SweepWarningCode = ScanWarningCode | SizeWarningCode;

/** 未测到原因码 (进 SizeResult.unmeasured[].code) */
export type UnmeasuredCode =
  | 'SIZE_UNMEASURED_PERMISSION'
  | 'SIZE_UNMEASURED_NOT_DIR'
  | 'SIZE_UNMEASURED_LOOP'
  | 'SIZE_UNMEASURED_UNPARSEABLE'
  | 'SIZE_UNMEASURED_CONTROL_CHAR'
  | 'SIZE_UNMEASURED_OTHER';

/**
 * 安全闸拒绝码 (逐条对应 validateTargets 分支)。
 * realpath 失败按 errno 三分: MISSING 是唯一可被 staleTargets: 'missing' 容忍的一类
 * (目标已达成); 另两类必须维持整批拒绝。
 */
export type GuardCode =
  | 'GUARD_LEAF_NOT_NODE_MODULES'
  | 'GUARD_TARGET_MISSING'
  | 'GUARD_TARGET_UNREADABLE'
  | 'GUARD_REALPATH_FAILED'
  | 'GUARD_ROOT_ANCHOR_SYMLINK'
  | 'GUARD_FILESYSTEM_ROOT_BODY'
  | 'GUARD_HOME_BODY'
  | 'GUARD_REAL_LEAF_NOT_NODE_MODULES'
  | 'GUARD_OUTSIDE_ROOTS'
  | 'GUARD_DUPLICATE_TARGET';

/** 删除失败码 (含复核未完成的非失败条目) */
export type RemoveFailureCode =
  | 'REMOVE_FAILED'
  | 'REMOVE_ENOENT_SURVIVOR'
  | 'REVIEW_UNVERIFIED'
  | 'REVIEW_COMPONENT_VANISHED';

/** 整批中止码 (复核阶段的致命信号) */
export type AbortCode =
  | 'REVIEW_NOT_UNDER_ANY_ROOT'
  | 'REVIEW_HEAD_SYMLINK'
  | 'REVIEW_COMPONENT_REPLACED';

/** 库抛出的错误码 (配置 / 参数 / 取消三档共用, 见 errors.ts 的 SweepError) */
export type SweepErrorCode =
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_CORRUPT_JSON'
  | 'CONFIG_CORRUPT_SHAPE'
  | 'CONFIG_ABSENT'
  | 'INVALID_ARGUMENT'
  | 'CANCELLED';

/**
 * 跳过原因 (与 classify.ts / guard.ts 的既有判定同源)。
 * 与 stale 的分界: 体积测不到是「存在但测不出」, 进不了批;
 * 目标已不存在是「没有东西可测」, 走 gone 桶与 staleTargets 策略, 二者不混。
 */
export type SkipReason =
  | 'suspect-install-tree' // 语义闸 (BC-37 / BC-38)
  | 'cross-device:on-path' // 设备边界 (BC-41)
  | 'cross-device:target-itself' // 设备边界 (BC-41)
  | 'unmeasured'; // 体积未测到, 不执行删除 (BC-15)

/**
 * 体积口径标识: du 快路径报磁盘占用, 纯实现报逻辑字节。
 * 一次 measure() 调用内口径恒一; win32 恒为 logical-bytes (EC-03 的平台守卫)。
 */
export type SizeBasis = 'disk-usage' | 'logical-bytes';

/** 编排阶段 (取消错误的 details.phase 取本全集) */
export type SweepPhase =
  'scan' | 'measure' | 'classify' | 'device' | 'plan' | 'validate' | 'remove';
