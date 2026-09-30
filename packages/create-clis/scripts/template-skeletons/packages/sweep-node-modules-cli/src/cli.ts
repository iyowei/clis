/**
 * 示例 CLI 入口 (模板骨架): 薄壳形态 —— 命令面在这里, 领域逻辑在 API 包 ({{SCOPE}}/{{NAME}})。
 *
 * 生成后的项目应把它替换为自己的命令实现 (打包与发布自证见 package.json 与 scripts/)。
 * 退出码: 0 成功; 值解析与命令分发按需要扩展。
 */
import { greet } from '{{SCOPE}}/{{NAME}}';

const HELP_TEXT = [
  '{{BIN_NAME}}: 示例命令行工具 (模板骨架)',
  '',
  '用法: {{BIN_NAME}} [--name <名字>] [--help]',
  '',
  '选项:',
  '  --name <名字>  要问候的名字 (缺省 world)',
  '  --help         打印本帮助',
].join('\n');

/** 取 `--name` 的取值; 缺省 world (演示最小解析, 替换时按需引入参数库) */
const parseName = (argv: readonly string[]): string => {
  const index = argv.indexOf('--name');
  if (index < 0) return 'world';
  return argv[index + 1] ?? 'world';
};

const main = (): number => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  process.stdout.write(`${greet({ who: parseName(argv) })}\n`);
  return 0;
};

process.exitCode = main();
