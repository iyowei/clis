/**
 * CLI 命令唯一权威注册表 (驱动参数校验、未知旗标防线、usage 输出与文档一致性自动验证)。
 */

export interface CliCommandSpec {
  required: readonly string[];
  optional: readonly string[];
  summary: string;
}

/** 纯布尔开关旗标集合 (其余已注册旗标均须携带非 -- 开头的参数值) */
export const CLI_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--full',
  '--skip-ci',
  '--unused',
]);

export const CLI_COMMAND_SPECS: Record<string, CliCommandSpec> = {
  scan: {
    required: [],
    optional: [
      '--repo',
      '--max-rounds',
      '--cooldown-days',
      '--dead-cooldown-days',
      '--full',
    ],
    summary:
      '全量扫描仓库双向拓扑、克隆、迁移残余、退化冷静期与 nextAction 路由',
  },
  summary: {
    required: [],
    optional: ['--repo', '--cooldown-days', '--dead-cooldown-days'],
    summary: '生成收敛收尾报告摘要 JSON',
  },
  'check-proposal': {
    required: ['--name', '--description', '--consumers', '--exports'],
    optional: ['--repo', '--internal-deps', '--signatures'],
    summary: '执行社区本质四道闸门预审',
  },
  'begin-round': {
    required: ['--name', '--dir'],
    optional: ['--repo', '--mode', '--into', '--touch'],
    summary: '开启单轮事务备份检查点并占用活跃轮次锁',
  },
  'backup-file': {
    required: ['--round', '--file'],
    optional: ['--repo'],
    summary: '为当前活跃轮次补充备份单个文件',
  },
  'verify-round': {
    required: ['--dir'],
    optional: ['--repo', '--round', '--mode', '--skip-ci'],
    summary: '验证抽包规范 / 残余清理与全仓 CI + npm pack',
  },
  'verify-reabsorb': {
    required: ['--name', '--dir'],
    optional: ['--repo', '--round', '--into', '--unused', '--skip-ci'],
    summary: '验证退化回收零残留、独立子模块隔离与全仓 CI',
  },
  'commit-round': {
    required: ['--fingerprint', '--name', '--reason'],
    optional: ['--repo', '--mode', '--round'],
    summary: '写入台账并核销关闭当前活跃轮次',
  },
  reject: {
    required: ['--fingerprint', '--reason'],
    optional: ['--repo', '--status'],
    summary: '按实时扫描指纹将候选簇或退化库记入 rejected / deferred 台账',
  },
  'rollback-round': {
    required: ['--round'],
    optional: ['--repo'],
    summary: '精确回滚并解锁轮次检查点',
  },
};
