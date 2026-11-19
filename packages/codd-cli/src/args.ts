/**
 * codd CLI 纯参数解析模块 (独立抽离便于直接单元测试)。
 */
import { ConfigError, type RotateMode } from '@iyowei/codd';

export interface CliFlags {
  manifestPath?: string;
  outDir?: string;
  rotate: RotateMode;
  newFingerprint: boolean;
  dryRun: boolean;
  wizard: boolean;
  initSchema: boolean;
  update: boolean;
  updateArgs?: string[];
  help: boolean;
  version: boolean;
}

const takeFlagValue = (argv: string[], index: number, flag: string): string => {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('-')) {
    throw new ConfigError(
      `参数 ${flag} 缺少取值 (正确用法: ${flag} <路径>), 请运行 codd --help 查看说明`,
    );
  }
  return next;
};

const takeInlineValue = (arg: string, prefix: string): string => {
  const val = arg.slice(prefix.length);
  if (val === '') {
    throw new ConfigError(`参数 ${prefix.slice(0, -1)} 缺少取值`);
  }
  return val;
};

const assignPositional = (flags: CliFlags, token: string): void => {
  if (flags.manifestPath !== undefined) {
    throw new ConfigError(
      `多余的位置参数「${token}」(已指定清单「${flags.manifestPath}」), 请运行 codd --help 查看用法`,
    );
  }
  flags.manifestPath = token;
};

export const parseCliArgs = (argv: string[]): CliFlags => {
  const flags: CliFlags = {
    rotate: 'none',
    newFingerprint: false,
    dryRun: false,
    wizard: false,
    initSchema: false,
    update: false,
    help: false,
    version: false,
  };

  // update 子命令自带独立旗标面 (--check / --pm / --registry / --force / --help)
  if (argv[0] === 'update') {
    flags.update = true;
    flags.updateArgs = argv.slice(1);
    return flags;
  }

  let afterDash = false;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;
    if (afterDash) {
      assignPositional(flags, arg);
      i += 1;
      continue;
    }
    if (arg === '--') {
      afterDash = true;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === 'wizard' || arg === '--wizard' || arg === '-i') {
      flags.wizard = true;
    } else if (arg === 'init' || arg === '--init-schema') {
      flags.initSchema = true;
    } else if (arg === '--config' || arg === '-c') {
      flags.manifestPath = takeFlagValue(argv, i, arg);
      i += 2;
      continue;
    } else if (arg.startsWith('--config=')) {
      flags.manifestPath = takeInlineValue(arg, '--config=');
    } else if (arg === '--out' || arg === '-o') {
      flags.outDir = takeFlagValue(argv, i, arg);
      i += 2;
      continue;
    } else if (arg.startsWith('--out=')) {
      flags.outDir = takeInlineValue(arg, '--out=');
    } else if (arg === '--rotate') {
      flags.rotate = flags.rotate === 'all' ? 'all' : 'apps';
    } else if (arg === '--rotate-all') {
      flags.rotate = 'all';
    } else if (arg === '--new-fingerprint') {
      flags.newFingerprint = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (!arg.startsWith('-')) {
      assignPositional(flags, arg);
    } else {
      throw new ConfigError(
        `不认识的参数「${arg}」, 请运行 codd --help 查看全部可用选项`,
      );
    }
    i += 1;
  }

  return flags;
};
