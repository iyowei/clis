/**
 * 帮助页文案: 命令面速查 + 关键口径 (零 IO 的静态文本拼装)。
 * 独立于 cli 编排: 命令面 (packages/sweep-node-modules-cli/docs/designs/cli-surface.md) 是这里唯一的事实来源,
 * 新增旗标时此文件与规格、语料 `cli-help` 三处同批更新 (见 behavior-contract.md BC-30)。
 */
import { resolveConfigPath } from '@iyowei/sweep-node-modules';

import { bannerLine, sanitizeLine } from './render.ts';

/** 帮助页命令列宽度 (元变量取 ASCII, 免去全角宽度换算) */
const COMMAND_COLUMN = 25;

/** 平台默认配置路径 (帮助里的「默认配置位置」; 屏蔽环境变量, 只答平台默认) */
function defaultConfigPath(): string {
  return resolveConfigPath({ env: {} }).path;
}

/** 帮助: 命令面速查 + 关键口径 (简洁; 顶栏着色, 降级纯文本) */
export function helpText(color: boolean): string {
  const row = (command: string, desc: string): string =>
    `  ${command.padEnd(COMMAND_COLUMN)}  ${desc}`;
  return [
    bannerLine('工作区 node_modules 清理', color),
    '',
    row('sweep-nm', '预览: 清单 + 体积 + 合计, 零副作用'),
    row('sweep-nm --yes', '执行删除'),
    row('sweep-nm --force', '连同疑似安装树一并删除 (默认跳过)'),
    row('sweep-nm --exclude <name>', '临时追加排除 (可重复, 与配置合并)'),
    row(
      'sweep-nm --include <name>',
      '只清理命中名单的目录 (可重复, 与配置合并)',
    ),
    row('sweep-nm --config <path>', '指定配置文件 (优先于 SWEEP_NM_CONFIG)'),
    row('sweep-nm config', '查看实际生效的配置: 来源 + 路径 + 文件状态'),
    row('sweep-nm init', '初始化向导: 交互生成配置文件'),
    row('sweep-nm --help', '帮助'),
    row('sweep-nm -h', '--help 的别名'),
    '',
    '说明:',
    '  --exclude 按目录名精确匹配 (区分大小写), 从根到命中点的任意一级命中即跳过',
    '  --include 同款匹配口径, 命中才纳入; 同时命中 exclude 的照旧跳过',
    '  配置未写 exclude 字段时使用内置默认名单 (包管理器 / 版本管理器 / 编辑器扩展等安装树目录)',
    '  --force 只放行「疑似安装树」(安装树形态的目标), 不放宽删除安全闸',
    '  删除侧要求扫描根为真实路径 (根及其祖先链不含符号链接): 命中 (如 /tmp、/var 形态) 则 --yes 整批拒绝, 改写为真实路径形态 (如 /private/tmp/x) 即放行',
    // 该路径源自 os.homedir() (外部数据), 与 config 报告面同坐标经同一净化, 防控制序列改写帮助行
    `  默认配置位置 (平台自适应; 用了 --config 或 SWEEP_NM_CONFIG 时实际读的不是它): ${sanitizeLine(defaultConfigPath())}`,
    '  查实际生效的路径: sweep-nm config',
    '',
    '退出码: 0 成功 (含预览与空结果); 1 删除失败或跳过 / 配置损坏 / 参数错误',
  ].join('\n');
}
