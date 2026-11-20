/**
 * 文档示例闸门: ts 代码块的真实类型校验 + shell 块的多 CLI 面核对。
 *
 * 两档:
 * - 类型档: 采集「自足」ts 块 (行首 import), 拼成临时 tsc 工程对 API 包真实类型校验。
 *   - 校验 tsc 执行本身未故障 (退出码非零且无块错误或 spawn 报错直接红灯, 防工具坏了假绿);
 *   - 若 TS2307 (Cannot find module) 指向本仓 scope/包名, 判为真断裂 (防改包名后示例假绿);
 *   - 仅非本仓虚构模块或未定义外部变量的块判为片段跳过。
 * - CLI 档: 自动发现仓内所有带 `bin` 且具备 `src/cli.ts` 的 CLI 工具,
 *   采集 shell 块内以对应命令名开头的行, 对照各自 `--help` 核对旗标与子命令。
 *
 * 用法: bun scripts/lint-doc-examples.ts
 * 退出码: 0 全绿; 1 存在断裂。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from './lib/tmp-root.ts';
import { listWorkspacePackages } from './lib/workspace.ts';
import { REPO_ROOT, walkFiles } from './lint-doc-shared.ts';

/** 一个被采集到的 ts 代码块 */
export interface TsBlock {
  file: string;
  /** 块内容首行的行号 (1 起) */
  startLine: number;
  content: string;
}

/** 被核对的一个 CLI 目标 */
export interface CliTarget {
  /** 命令名 (package.json 的 bin 字段声明的可执行名) */
  binName: string;
  /** CLI 源码入口相对仓库根路径 */
  entryPath: string;
}

/** 从文本提取的带命令名的 shell 示例 */
export interface NamedShellCommand {
  binName: string;
  command: string;
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

/** 构造命令名前缀正则 (转义正则元字符) */
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 提取 shell/bash/sh 块中以指定命令名集合开头的命令行 (跳过注释行) */
export function extractNamedShellCommands(
  content: string,
  cliNames: readonly string[],
): NamedShellCommand[] {
  if (cliNames.length === 0) return [];
  const patterns = cliNames.map((binName) => ({
    binName,
    re: new RegExp(`^${escapeRegex(binName)}(?:\\s|$)`),
  }));
  const commands: NamedShellCommand[] = [];
  const lines = content.split('\n');
  let inShell = false;
  for (const line of lines) {
    if (/^```(?:shell|bash|sh)\s*$/.test(line)) {
      inShell = true;
      continue;
    }
    if (inShell && /^```\s*$/.test(line)) {
      inShell = false;
      continue;
    }
    if (!inShell) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    for (const { binName, re } of patterns) {
      if (re.test(trimmed)) {
        commands.push({ binName, command: trimmed });
        break;
      }
    }
  }
  return commands;
}

/** 兼容旧签名: 提取 shell 块中以 sweep-nm 开头的命令行 */
export function extractShellCommands(
  content: string,
  cliName = 'sweep-nm',
): string[] {
  return extractNamedShellCommands(content, [cliName]).map(
    (item) => item.command,
  );
}

/** 从一条命令提取待核对 token: --旗标 (去掉 =值, 去重) 与纯标识符形态的首个子命令 */
export function extractCommandTokens(command: string): string[] {
  const tokens: string[] = [];
  const parts = command.split(/\s+/).slice(1);
  let sawFlag = false;
  let sawSubcommand = false;
  for (const part of parts) {
    if (part === '--') break;
    if (part === '\\' || part === '&&' || part === '||' || part === '|') break;
    if (part.startsWith('-')) {
      sawFlag = true;
      tokens.push(part.split('=')[0]!);
      continue;
    }
    // 仅在首个旗标之前、且形状为纯小写子命令标识符 (不含路径/扩展名/占位符) 时作为子命令核对
    if (!sawFlag && !sawSubcommand && /^[a-z][a-z0-9-]*$/.test(part)) {
      sawSubcommand = true;
      tokens.push(part);
    }
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
  'TS2307', // Cannot find module (仅限非本仓包名的片段模块; 本仓 scope 见下单独拦)
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

/** 收集工作区 scope 前缀与包名, 防止本仓包改名后被 TS2307 静默豁免 */
function collectWorkspaceScopes(root: string): {
  names: Set<string>;
  scopes: Set<string>;
} {
  const names = new Set<string>();
  const scopes = new Set<string>();
  if (!existsSync(join(root, 'package.json'))) return { names, scopes };
  try {
    for (const pkg of listWorkspacePackages(root)) {
      names.add(pkg.name);
      if (pkg.name.startsWith('@') && pkg.name.includes('/')) {
        scopes.add(`${pkg.name.slice(0, pkg.name.indexOf('/'))}/`);
      }
    }
  } catch {
    // 迷你测试根无 workspaces 时忽略
  }
  return { names, scopes };
}

/** 检查报错行里的 TS2307 是否指向本仓包/scope (是则真断裂, 不可豁免) */
function hitsWorkspaceModuleNotFound(
  blockLines: readonly string[],
  workspace: { names: Set<string>; scopes: Set<string> },
): boolean {
  for (const line of blockLines) {
    const match = line.match(
      /error TS2307: Cannot find module ['"]([^'"]+)['"]/,
    );
    if (!match) continue;
    const mod = match[1]!;
    if (workspace.names.has(mod)) return true;
    for (const scope of workspace.scopes) {
      if (mod.startsWith(scope)) return true;
    }
  }
  return false;
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

  const workspace = collectWorkspaceScopes(root);
  const tmp = makeTmpRoot('doc-examples-');
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
    const rootTsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    const repoTsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const localTsc = existsSync(rootTsc) ? rootTsc : repoTsc;
    const result = existsSync(localTsc)
      ? spawnSync(
          process.execPath,
          [localTsc, '-p', join(tmp, 'tsconfig.json')],
          { cwd: root, encoding: 'utf8' },
        )
      : spawnSync(
          'bun',
          ['x', '--no-install', 'tsc', '-p', join(tmp, 'tsconfig.json')],
          { cwd: root, encoding: 'utf8' },
        );
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.error !== undefined) {
      return {
        real: [`tsc 执行失败: ${result.error.message}`],
        fragments: [],
      };
    }
    const perBlock = parseTscErrors(combinedOutput);
    if (result.status !== 0 && perBlock.size === 0) {
      const snippet = combinedOutput.trim().slice(0, 300);
      return {
        real: [
          `tsc 异常退出 (exit ${String(result.status)}): ${snippet || '(无输出)'}`,
        ],
        fragments: [],
      };
    }

    const allLines = combinedOutput.split('\n');
    const real: string[] = [];
    const fragments: string[] = [];
    for (const [index, block] of blocks.entries()) {
      const codes = perBlock.get(index);
      const blockLines = allLines.filter((line) =>
        line.includes(`block-${index}.ts(`),
      );
      let kind = classifyBlock(codes);
      if (
        kind === 'fragment' &&
        hitsWorkspaceModuleNotFound(blockLines, workspace)
      ) {
        kind = 'real';
      }
      const at = `${block.file}:${block.startLine}`;
      if (kind === 'fragment') {
        fragments.push(
          `${at} (引用块外上下文, ${[...(codes ?? [])].join('/')})`,
        );
      } else if (kind === 'real') {
        const detail = blockLines
          .map((line) => line.replace(/^.*block-\d+\.ts/, '行内'))
          .join('; ');
        real.push(`${at} :: ${detail}`);
      }
    }
    return { real, fragments };
  } finally {
    rmSync(tmp, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

/** 从 package.json 的 bin 字段提取可执行命令名列表 */
function extractBinNames(pkgName: string, binField: unknown): string[] {
  if (typeof binField === 'string') {
    return [
      pkgName.includes('/') ? pkgName.slice(pkgName.indexOf('/') + 1) : pkgName,
    ];
  }
  if (binField !== null && typeof binField === 'object') {
    return Object.keys(binField as Record<string, unknown>);
  }
  return [];
}

/** 发现仓内全部可核对的 CLI 工具目标 (兼容无根 package.json 的迷你测试根) */
export function discoverCliTargets(root: string): CliTarget[] {
  const targets: CliTarget[] = [];
  if (existsSync(join(root, 'package.json'))) {
    try {
      for (const pkg of listWorkspacePackages(root)) {
        const entryPath = `${pkg.dir}/src/cli.ts`;
        if (!existsSync(join(root, entryPath))) continue;
        for (const binName of extractBinNames(pkg.name, pkg.manifest.bin)) {
          targets.push({ binName, entryPath });
        }
      }
    } catch {
      // 忽略非标准迷你根
    }
  }
  if (targets.length === 0) {
    const fallback = 'packages/sweep-node-modules-cli/src/cli.ts';
    if (existsSync(join(root, fallback))) {
      targets.push({ binName: 'sweep-nm', entryPath: fallback });
    }
  }
  return targets.sort((a, b) => a.binName.localeCompare(b.binName));
}

/** CLI 档: 采集 shell 块内全部已发现 CLI 命令, 对照各自 --help 核对旗标与子命令 */
export function checkCliExamples(root: string = REPO_ROOT): string[] {
  const targets = discoverCliTargets(root);
  if (targets.length === 0) return [];

  const missing: string[] = [];
  const helpByBin = new Map<string, string>();
  for (const target of targets) {
    const help = spawnSync('bun', [join(root, target.entryPath), '--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (help.status !== 0) {
      missing.push(
        `CLI (${target.binName}) --help 执行失败 (exit ${String(help.status)}), 无法核对示例`,
      );
      continue;
    }
    helpByBin.set(target.binName, `${help.stdout ?? ''}\n${help.stderr ?? ''}`);
  }

  const cliNames = [...helpByBin.keys()];
  if (cliNames.length === 0) return missing;

  for (const file of walkFiles(root, ['.md'])) {
    const content = readFileSync(join(root, file), 'utf8');
    for (const { binName, command } of extractNamedShellCommands(
      content,
      cliNames,
    )) {
      const helpText = helpByBin.get(binName)!;
      for (const token of extractCommandTokens(command)) {
        if (!helpText.includes(token)) {
          missing.push(
            `${file} :: 命令 "${command}" 的 ${token} 在 ${binName} --help 输出中不存在`,
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

if (import.meta.main) main();
