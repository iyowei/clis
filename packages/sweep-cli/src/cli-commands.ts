/**
 * CLI 子命令辅助 (`init` / `init --default` / `config`): 上游由 `cli.ts` 调度, 下游调用
 * `init.ts` / `render.ts` 与 `@iyowei/sweep` 锚点检查原语, 拆出以保持入口编排精炼并便于单测。
 * 红线: 路径探测坚持 `lstat` (不跟随软链); 非交互终端调用 `sweep init` 直接拒绝并退 1, 严禁阻塞 stdin。
 */
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type ConfigSource,
  type ResolvedConfigPath,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
} from '@iyowei/sweep';

import {
  type InitResult,
  createReadlineIO,
  runInit,
  runInitDefault,
} from './init.ts';
import { bannerLine, neutralLine, sanitizeLine } from './render.ts';

/** stdout / stderr 独立着色开关 */
export interface ColorChannels {
  stdout: boolean;
  stderr: boolean;
}

/** 路径存在判定 (lstat 语义: 悬空符号链接也算存在) */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 目录类型判定 (lstat + isDirectory) */
export async function rootIsDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 创建父目录并写入配置文件 */
export async function writeConfigFile(
  path: string,
  text: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

/** 启动交互式初始化向导 */
export function runWizard(
  configPath: string,
  stdoutColor: boolean,
  home: string,
): Promise<InitResult> {
  return runInit({
    configPath,
    configExists: pathExists,
    configIsDirectory: rootIsDirectory,
    rootExists: pathExists,
    rootIsDirectory,
    firstSymlinkOnRoot,
    firstSymlinkOnTarget,
    writeFile: writeConfigFile,
    home,
    io: createReadlineIO(stdoutColor),
  });
}

const SOURCE_LABELS: Record<ConfigSource, string> = {
  flag: '--config 指定',
  env: '环境变量 SWEEP_CONFIG',
  'platform-default': '平台默认',
};

/** `sweep config` 子命令: 报告本次实际生效的配置路径与存在状态 (恒退 0) */
export async function reportConfig(
  resolved: ResolvedConfigPath,
  stdoutColor: boolean,
  print: (line: string) => void,
): Promise<number> {
  const exists = await pathExists(resolved.path);
  print(
    bannerLine(`配置 · 来源: ${SOURCE_LABELS[resolved.source]}`, stdoutColor),
  );
  print(neutralLine(`配置路径: ${sanitizeLine(resolved.path)}`, stdoutColor));
  print(neutralLine(`文件状态: ${exists ? '存在' : '不存在'}`, stdoutColor));
  return 0;
}

/**
 * `sweep init` / `sweep init --default` 子命令入口:
 * - `--default` 路径: 走 `runInitDefault`, 冲突 (目录/软链/非交互已存在) 退 1, 写入或拒绝覆盖退 0;
 * - 交互向导路径: 非 TTY 拒绝并退 1, TTY 调 `runWizard` (写入 / 拒覆 / 取消均退 0)。
 */
export async function handleInitCommand(params: {
  configPath: string;
  defaultConfig: boolean;
  interactive: boolean;
  colors: ColorChannels;
  home: string;
  print: (line: string) => void;
  warn: (line: string) => void;
}): Promise<number> {
  const { configPath, defaultConfig, interactive, colors, home, print, warn } =
    params;

  if (defaultConfig) {
    const result = await runInitDefault({
      configPath,
      configExists: pathExists,
      configIsDirectory: rootIsDirectory,
      firstSymlinkOnTarget,
      writeFile: writeConfigFile,
      home,
      interactive,
      color: colors.stdout,
      print,
      warn,
      confirmOverwrite: interactive
        ? async (path) => {
            const io = createReadlineIO(colors.stdout);
            try {
              return await io.confirm(
                `配置已存在 (${sanitizeLine(path)}), 是否覆盖?`,
                false,
              );
            } finally {
              io.close?.();
            }
          }
        : undefined,
    });
    if (result.state === 'conflict') return 1;
    if (result.state === 'written') {
      print(neutralLine('运行 sweep 查看预览', colors.stdout));
    } else if (result.state === 'declined-overwrite') {
      print('配置未变更');
    }
    return 0;
  }

  if (!interactive) {
    warn(
      'init 需要交互终端 (请在终端直接运行, 或改用 sweep init --default 生成默认配置)',
    );
    return 1;
  }
  const result = await runWizard(configPath, colors.stdout, home);
  if (result.state === 'written') {
    print(neutralLine('运行 sweep 查看预览', colors.stdout));
  } else if (result.state === 'declined-overwrite') {
    print('配置未变更');
  }
  return 0;
}
