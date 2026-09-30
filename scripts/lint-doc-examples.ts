/**
 * 文档示例闸门: ts 代码块的真实类型校验 + shell 块的 CLI 面核对。
 *
 * 动机: 2026-09-30 漂移复审实测抓到文档示例与真实签名不符 (api-surface 的
 * `isSuccessOutcome` 片段入参类型错误, 照抄编译报 TS2345), 属「只有人工审计才能发现」
 * 的类别; 示例可编译性是确定性事实, 故落为闸门 (镜像实现对: fiu-kits 的 lint-doc-examples)。
 *
 * 两档:
 * - 类型档: 采集「自足」ts 块 (判据: 块内出现行首 import 语句), 拼成临时 tsc 工程对 API 包
 *   真实类型校验 (临时工程 extends 仓库根 tsconfig, paths 直连源码单源; typeRoots 指回仓
 *   内 @types, 临时目录解析不到 bun 类型实测 TS2688)。报错分类: 全为「名字未找到」类
 *   (TS2304 等) 的块判为片段 (依赖上文块, 不做跨块拼接), 打印 INFO 跳过; 含其他错误
 *   (TS2345 签名不符 / TS2339 成员不存在等) 的块判为真断裂, 红灯。
 * - CLI 档: 采集 shell 块内以 `sweep-nm` 开头的命令, 提取旗标与子命令, 对照 `--help`
 *   输出逐一核对存在性 (抓「新增旗标漏登记进文档 / 文档写了不存在的旗标」)。
 *
 * 用法: bun scripts/lint-doc-examples.ts
 * 退出码: 0 全绿; 1 存在断裂。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT, walkFiles } from './lint-doc-shared.ts';

const CLI_ENTRY = 'packages/sweep-node-modules-cli/src/cli.ts';

/** 一个被采集到的 ts 代码块 */
export interface TsBlock {
  file: string;
  /** 块内容首行的行号 (1 起) */
  startLine: number;
  content: string;
}

/** 提取全文的 ```ts 块 (闭合围栏以 ``` 收尾; startLine 指向内容首行) */
export function extractTsBlocks(content: string, file = '<inline>'): TsBlock[] {
  const blocks: TsBlock[] = [];
  const lines = content.split('\n');
  let start: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (start === null && /^```ts\s*$/.test(lines[i]!)) {
      start = i + 1;
      continue;
    }
    if (start !== null && /^```\s*$/.test(lines[i]!)) {
      blocks.push({
        file,
        startLine: start + 1,
        content: lines.slice(start, i).join('\n'),
      });
      start = null;
    }
  }
  return blocks;
}

/** 自足判据: 块内出现行首 import 语句 (片段块依赖上文变量, 不参与编译) */
export function isSelfContained(block: string): boolean {
  return /^import\b/m.test(block);
}

/** 提取 shell 块中以 sweep-nm 开头的命令行 (跳过注释行) */
export function extractShellCommands(content: string): string[] {
  const commands: string[] = [];
  const lines = content.split('\n');
  let inShell = false;
  for (const line of lines) {
    if (/^```shell\s*$/.test(line)) {
      inShell = true;
      continue;
    }
    if (inShell && /^```\s*$/.test(line)) {
      inShell = false;
      continue;
    }
    if (!inShell) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !/^sweep-nm(\s|$)/.test(trimmed)) continue;
    commands.push(trimmed);
  }
  return commands;
}

/** 从一条命令提取待核对 token: --旗标 (去掉 =值, 去重) 与首个位置参数 (子命令) */
export function extractCommandTokens(command: string): string[] {
  const tokens: string[] = [];
  const parts = command.split(/\s+/).slice(1);
  for (const part of parts) {
    if (part.startsWith('-')) {
      tokens.push(part.split('=')[0]!);
      continue;
    }
    // 位置参数: 只认第一个 (子命令); 其余是旗标的值 (如 --exclude my-kits 的 my-kits)
    if (tokens.length === 0) tokens.push(part);
  }
  return [...new Set(tokens)];
}

/** 解析 tsc 输出为「块序号 -> 错误码集合」 */
export function parseTscErrors(output: string): Map<number, Set<string>> {
  const perBlock = new Map<number, Set<string>>();
  for (const line of output.split('\n')) {
    const m = line.match(/block-(\d+)\.ts\(\d+,\d+\): error (TS\d+)/);
    if (!m) continue;
    const idx = Number(m[1]);
    const set = perBlock.get(idx) ?? new Set<string>();
    set.add(m[2]!);
    perBlock.set(idx, set);
  }
  return perBlock;
}

/** 「名字 / 上下文未找到」类错误码: 全由此类构成的块判为片段 (依赖上文块) */
const FRAGMENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'TS2304', // Cannot find name
  'TS2552', // Cannot find name (did you mean ...)
  'TS18046', // 'x' is of type 'unknown' (收窄所需的守卫未定义时连带)
  'TS2580', // Cannot find name 'require'
  'TS2503', // Cannot find namespace
  'TS2307', // Cannot find module (片段引用未随块给出的模块)
]);

/** 分类一个块的错误集合: 'clean' | 'fragment' | 'real' */
export function classifyBlock(
  codes: Set<string> | undefined,
): 'clean' | 'fragment' | 'real' {
  if (codes === undefined || codes.size === 0) return 'clean';
  return [...codes].every((code) => FRAGMENT_ERROR_CODES.has(code))
    ? 'fragment'
    : 'real';
}

/** 类型档: 采集自足块 → 临时工程编译 → 返回 (真断裂条目, 片段 INFO 列表) */
export function checkTsExamples(root: string = REPO_ROOT): {
  real: string[];
  fragments: string[];
} {
  const blocks: TsBlock[] = [];
  for (const file of walkFiles(root, ['.md'])) {
    for (const block of extractTsBlocks(
      readFileSync(join(root, file), 'utf8'),
      file,
    )) {
      if (isSelfContained(block.content)) blocks.push(block);
    }
  }
  if (blocks.length === 0) return { real: [], fragments: [] };

  // 临时工程: extends 仓库根 tsconfig (paths 直连单源), typeRoots 指回仓内 @types
  const tmp = mkdtempSync(join(homedir(), 'tmp', 'doc-examples-'));
  try {
    for (const [index, block] of blocks.entries()) {
      writeFileSync(join(tmp, `block-${index}.ts`), `${block.content}\n`);
    }
    writeFileSync(
      join(tmp, 'tsconfig.json'),
      `${JSON.stringify(
        {
          extends: join(root, 'tsconfig.json'),
          compilerOptions: {
            noEmit: true,
            typeRoots: [join(root, 'node_modules', '@types')],
          },
          include: ['./*.ts'],
        },
        null,
        2,
      )}\n`,
    );
    const result = spawnSync(
      'bunx',
      ['tsc', '-p', join(tmp, 'tsconfig.json')],
      { cwd: root, encoding: 'utf8' },
    );
    const perBlock = parseTscErrors(`${result.stdout ?? ''}`);
    const real: string[] = [];
    const fragments: string[] = [];
    for (const [index, block] of blocks.entries()) {
      const kind = classifyBlock(perBlock.get(index));
      const at = `${block.file}:${block.startLine}`;
      if (kind === 'fragment') {
        fragments.push(
          `${at} (引用块外上下文, ${[...(perBlock.get(index) ?? [])].join('/')})`,
        );
      } else if (kind === 'real') {
        const detail = `${result.stdout ?? ''}`
          .split('\n')
          .filter((line) => line.includes(`block-${index}.ts(`))
          .map((line) => line.replace(/^.*block-\d+\.ts/, '行内'))
          .join('; ');
        real.push(`${at} :: ${detail}`);
      }
    }
    return { real, fragments };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** CLI 档: 采集 README 类 shell 块的 sweep-nm 命令, 对照 --help 核对旗标与子命令 */
export function checkCliExamples(root: string = REPO_ROOT): string[] {
  const missing: string[] = [];
  const help = spawnSync('bun', [join(root, CLI_ENTRY), '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (help.status !== 0) {
    return [`CLI --help 执行失败 (exit ${String(help.status)}), 无法核对示例`];
  }
  const helpText = help.stdout ?? '';
  for (const file of walkFiles(root, ['.md'])) {
    const content = readFileSync(join(root, file), 'utf8');
    for (const command of extractShellCommands(content)) {
      for (const token of extractCommandTokens(command)) {
        if (!helpText.includes(token)) {
          missing.push(
            `${file} :: 命令 "${command}" 的 ${token} 在 --help 输出中不存在`,
          );
        }
      }
    }
  }
  return missing;
}

/** 主流程: 两档都跑, 断裂即红灯 */
function main(): void {
  const { real, fragments } = checkTsExamples();
  const missingCli = checkCliExamples();
  if (fragments.length > 0) {
    process.stdout.write(
      `类型档片段跳过 (依赖块外上下文, 非断裂): ${fragments.length} 块\n`,
    );
    for (const fragment of fragments) process.stdout.write(`  ${fragment}\n`);
  }
  if (real.length === 0 && missingCli.length === 0) {
    process.stdout.write('文档示例闸门全绿 ✓ (类型档 / CLI 档)\n');
    return;
  }
  process.stderr.write('文档示例闸门检出断裂:\n');
  for (const item of real) process.stderr.write(`  [类型档] ${item}\n`);
  for (const item of missingCli) process.stderr.write(`  [CLI 档] ${item}\n`);
  process.exitCode = 1;
}

// 仅作为入口执行时跑主流程 (被 import 时不执行, 供测试)
if (import.meta.main) main();
