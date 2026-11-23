/**
 * codd CLI 纯参数解析模块 (独立抽离供 `cli.ts` 与单元测试消费)。
 * 关键约束: `update` 仅作首子命令并原样透传剩余参数; `--` 终止选项解析 (其后均作清单路径);
 * 重复指定清单路径、未知旗标或 `init` 与 `wizard`/生成类选项互斥组合均抛 `ConfigError`; `--rotate-all` 覆盖 `--rotate`。
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
  if (next === undefined || next.trim() === '' || next.startsWith('-')) {
    throw new ConfigError(
      `参数 ${flag} 缺少取值 (正确用法: ${flag} <路径>), 请运行 codd --help 查看说明`,
    );
  }
  return next;
};

const takeInlineValue = (arg: string, prefix: string): string => {
  const val = arg.slice(prefix.length);
  if (val.trim() === '') {
    throw new ConfigError(`参数 ${prefix.slice(0, -1)} 缺少取值`);
  }
  return val;
};

const assignManifestPath = (
  flags: CliFlags,
  token: string,
  source: string,
): void => {
  if (token.trim() === '') {
    throw new ConfigError(
      `${source} 不能为空字符串, 请提供有效的 JSON 清单路径`,
    );
  }
  if (flags.manifestPath !== undefined) {
    throw new ConfigError(
      `重复指定配置文件路径「${token}」(已指定「${flags.manifestPath}」), 请仅指定一份清单或运行 codd --help 查看用法`,
    );
  }
  flags.manifestPath = token;
};

const validateExclusiveModes = (flags: CliFlags): void => {
  if (flags.help || flags.version) return;
  if (flags.initSchema && flags.wizard) {
    throw new ConfigError(
      'init 与 wizard 为互斥子命令, 请分别执行 codd init 或 codd wizard',
    );
  }
  if (flags.initSchema && flags.manifestPath !== undefined) {
    throw new ConfigError(
      `init 子命令仅用于导出参考模板, 不能与清单路径「${flags.manifestPath}」同时使用`,
    );
  }
  if (
    flags.initSchema &&
    (flags.dryRun ||
      flags.outDir !== undefined ||
      flags.rotate !== 'none' ||
      flags.newFingerprint)
  ) {
    throw new ConfigError(
      'init 子命令会直接导出 schema/参考清单, 不支持与 --dry-run / --out / --rotate / --new-fingerprint 组合使用',
    );
  }
};

/**
 * 将命令行参数列表解析为强类型 `CliFlags` 并执行互斥模式校验。
 *
 * ### 数据流转示例
 * ```text
 * Input:  argv = ['deploy-prod.json', '--out=out', '--rotate', '--dry-run']
 * Step 1: 优先判定 `argv[0] === 'update'` (若命中则直接返回 `{ update: true, updateArgs }`)
 * Step 2: 顺序消费位置参数与开关/值旗标 (`--config`/`--out` 支持空格与 `=` 两种写法, `--` 后全作位置参数)
 * Step 3: validateExclusiveModes 校验 `init` 与 `wizard` / 清单路径 / `--dry-run` / `--out` / `--rotate` 互斥
 * Output: { manifestPath: 'deploy-prod.json', outDir: 'out', rotate: 'apps',
 *           newFingerprint: false, dryRun: true, wizard: false, initSchema: false, update: false, help: false, version: false }
 * ```
 */
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

  // update 子命令自带独立旗标面 (--check / --force / --pm / --registry / --verbose / --help)
  if (argv[0] === 'update') {
    flags.update = true;
    flags.updateArgs = argv.slice(1);
    return flags;
  }

  const dashIdx = argv.indexOf('--');
  const preDashArgs = dashIdx === -1 ? argv : argv.slice(0, dashIdx);
  const hasHelpFlag =
    preDashArgs.includes('--help') || preDashArgs.includes('-h');

  let afterDash = false;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;
    if (afterDash) {
      assignManifestPath(flags, arg, '位置参数');
      i += 1;
      continue;
    }
    if (arg === '--') {
      afterDash = true;
      i += 1;
      continue;
    }
    if (arg === 'update') {
      if (hasHelpFlag) {
        flags.help = true;
        i += 1;
        continue;
      }
      throw new ConfigError(
        'update 必须作为首个子命令使用 (正确用法: codd update [--check | --force | --pm <name> | --registry <url> | --verbose])',
      );
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-V' || arg === '-v') {
      flags.version = true;
    } else if (arg === 'wizard' || arg === '--wizard' || arg === '-i') {
      flags.wizard = true;
    } else if (arg === 'init' || arg === '--init-schema') {
      flags.initSchema = true;
    } else if (arg === '--config' || arg === '-c') {
      assignManifestPath(flags, takeFlagValue(argv, i, arg), arg);
      i += 2;
      continue;
    } else if (arg.startsWith('--config=')) {
      assignManifestPath(flags, takeInlineValue(arg, '--config='), '--config');
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
      assignManifestPath(flags, arg, '位置参数');
    } else {
      throw new ConfigError(
        `不认识的参数「${arg}」, 请运行 codd --help 查看全部可用选项`,
      );
    }
    i += 1;
  }

  validateExclusiveModes(flags);
  return flags;
};
