/**
 * 全包判别值与枚举的唯一类型源: 错误码 / 告警码 / 跳过原因 / 体积口径 / 编排阶段 / 动作与 6 大预设名。
 * 上下游: 底层零依赖模块; 供 errors / types / presets / rules / guard / delete / sweep 与 index 消费。
 * 契约基准: packages/sweep/docs/designs/api-surface.md §3.2 与 §7.3; 命名规则 `<域>_<判定>` 全大写蛇形
 * (域含 SCAN / SIZE / GUARD / REMOVE / TRASH / CONFIG / REVIEW; 无域项为 INVALID_ARGUMENT / CANCELLED / BATCH_REJECTED)。
 * 核心红线: code 一经发布即冻结 (只增不改), 且处置方向相反的语义严禁合并为同一 code。
 */

/** 清理动作: 移入回收站 (可恢复) 或永久删除 (不可逆) */
export type CleanupAction = 'trash' | 'delete';

/** 磁盘目标实体形态 (预设与规则可区分文件或目录) */
export type EntryKind = 'file' | 'dir';

/** 自定义规则匹配的实体形态 */
export type RuleKind = EntryKind | 'any';

/** 6 大内置技术栈预设键名 (对象内出现键名即激活, 严禁 enabled 字段) */
export type PresetName =
  'node' | 'rust' | 'python' | 'java' | 'cpp' | 'os-junk';

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
 * 叶名守卫分工: node 严格模式走 GUARD_*LEAF_NOT_NODE_MODULES; 多预设与自定义规则通用模式走 GUARD_INVALID_LEAF。
 * realpath 失败按 errno 三分: MISSING 是唯一可被 staleTargets: 'missing' 容忍的一类
 * (目标已达成); 另两类必须维持整批拒绝。
 */
export type GuardCode =
  | 'GUARD_LEAF_NOT_NODE_MODULES'
  | 'GUARD_INVALID_LEAF'
  | 'GUARD_TARGET_MISSING'
  | 'GUARD_TARGET_UNREADABLE'
  | 'GUARD_REALPATH_FAILED'
  | 'GUARD_ROOT_ANCHOR_SYMLINK'
  | 'GUARD_FILESYSTEM_ROOT_BODY'
  | 'GUARD_HOME_BODY'
  | 'GUARD_REAL_LEAF_NOT_NODE_MODULES'
  | 'GUARD_OUTSIDE_ROOTS'
  | 'GUARD_DUPLICATE_TARGET';

/** 删除/回收站失败码 (含复核未完成的非失败条目) */
export type RemoveFailureCode =
  | 'REMOVE_FAILED'
  | 'REMOVE_ENOENT_SURVIVOR'
  | 'TRASH_FAILED'
  | 'REVIEW_UNVERIFIED'
  | 'REVIEW_COMPONENT_VANISHED';

/** 整批中止码 (复核阶段的致命信号) */
export type AbortCode =
  | 'REVIEW_NOT_UNDER_ANY_ROOT'
  | 'REVIEW_HEAD_SYMLINK'
  | 'REVIEW_COMPONENT_REPLACED';

/** 批次内未尝试码: 删除阶段复核整批中止 (AbortCode), 或安全闸整批拒绝连带未删 ('BATCH_REJECTED') */
export type NotAttemptedCode = AbortCode | 'BATCH_REJECTED';

/** 库抛出的错误码 (配置 / 迁移 / 参数 / 取消共享, 见 errors.ts 的 SweepError) */
export type SweepErrorCode =
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_CORRUPT_JSON'
  | 'CONFIG_CORRUPT_SHAPE'
  | 'CONFIG_ABSENT'
  | 'CONFIG_NEEDS_MIGRATION'
  | 'CONFIG_MIGRATION_FAILED'
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
