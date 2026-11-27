/**
 * 示例 CLI 入口 (模板骨架): 薄壳形态 —— 命令面在这里, 领域逻辑在 API 包 ({{SCOPE}}/{{NAME}})。
 *
 * 生成后的项目应把它替换为自己的命令实现 (打包与发布自证见 package.json 与 scripts/)。
 * 退出码: 0 成功; 值解析与命令分发按需要扩展。
 */
import { readFileSync } from 'node:fs';

import { greet } from '{{SCOPE}}/{{NAME}}';

// 排版规范 (全仓所有 CLI 遵循): 多栏帮助文案按终端显示列宽 (CJK=2, ASCII=1) 将全部右栏左对齐到同一垂直列线
const HELP_TEXT = [
  '{{BIN_NAME}}: 示例命令行工具 (模板骨架)',
  '',
  '用法: {{BIN_NAME}} [--name <名字>] [--version] [--help]',
  '',
  '选项:',
  '  --name <名字>   要问候的名字 (缺省 world)',
  '  -V, --version   打印当前版本号',
  '  -h, --help      打印本帮助',
].join('\n');

/** 读取当前 CLI 包版本号 (源码态 src/cli.ts 与打包态 dist/cli.js 同位于包根下一级) */
const readCliVersion = (): string => {
  try {
    const raw = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
};

/** 解析最小示例参数: 支持 --version / -V、--help / -h 与 --name <名字> (演示最小解析, 替换时按需扩展) */
const parseArgs = (
  argv: readonly string[],
): { help: boolean; version: boolean; who: string } => {
  let help = false;
  let version = false;
  let who = 'world';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--version' || arg === '-V') version = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--name') {
      const next = argv[i + 1];
      if (next !== undefined) {
        who = next;
        i += 1;
      }
    } else if (arg?.startsWith('--name=')) {
      const value = arg.slice('--name='.length);
      if (value.length > 0) who = value;
    }
  }
  return { help, version, who };
};

const main = (): number => {
  const { help, version, who } = parseArgs(process.argv.slice(2));
  if (version) {
    process.stdout.write(`${readCliVersion()}\n`);
    return 0;
  }
  if (help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  process.stdout.write(`${greet({ who })}\n`);
  return 0;
};

process.exitCode = main();
