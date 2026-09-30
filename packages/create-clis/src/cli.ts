/**
 * create-clis 入口。
 *
 * 当前是包骨架占位版: 只打印帮助并退 0。生成流程 (旗标解析 → 变量收集 → 复制裁剪替换 →
 * 收尾) 由后续任务接线, 命令契约见 docs/designs/scaffold-contract.md。
 */
const HELP_TEXT = [
  'create-clis: 从 clis 集合仓骨架快照生成独立的新集合仓',
  '',
  '用法: create-clis <目录> [选项]',
  '',
  '当前为包骨架占位版本: 生成流程尚未接线, 用法与旗标以正式发布版为准。',
].join('\n');

process.stdout.write(`${HELP_TEXT}\n`);
