/**
 * codd CLI 纯参数解析模块 (支持中英双语错误提示, 供 `cli.ts` 与单元测试消费)。
 */
import {
  type LangPreference,
  type Locale,
  parseLangPreference,
  t,
} from '@iyowei/cli-i18n';
import { ConfigError, type RotateMode } from '@iyowei/codd';

export interface CliFlags {
  manifestPath?: string;
  outDir?: string;
  rotate: RotateMode;
  newFingerprint: boolean;
  dryRun: boolean;
  wizard: boolean;
  initSchema: boolean;
  lang?: LangPreference;
  langSubcommand?: boolean;
  langArgs?: string[];
  update: boolean;
  updateArgs?: string[];
  help: boolean;
  version: boolean;
}

const takeFlagValue = (
  argv: string[],
  index: number,
  flag: string,
  locale: Locale,
): string => {
  const next = argv[index + 1];
  if (next === undefined || next.trim() === '' || next.startsWith('-')) {
    throw new ConfigError(
      t(
        locale,
        `参数 ${flag} 缺少取值 (正确用法: ${flag} <路径>), 请运行 codd --help 查看说明`,
        `Option ${flag} requires a value (usage: ${flag} <path>); run 'codd --help' for details`,
      ),
    );
  }
  return next;
};

const takeInlineValue = (
  arg: string,
  prefix: string,
  locale: Locale,
): string => {
  const val = arg.slice(prefix.length);
  if (val.trim() === '') {
    throw new ConfigError(
      t(
        locale,
        `参数 ${prefix.slice(0, -1)} 缺少取值`,
        `Option ${prefix.slice(0, -1)} requires a value`,
      ),
    );
  }
  return val;
};

const assignManifestPath = (
  flags: CliFlags,
  token: string,
  source: string,
  locale: Locale,
): void => {
  if (token.trim() === '') {
    throw new ConfigError(
      t(
        locale,
        `${source} 不能为空字符串, 请提供有效的 JSON 清单路径`,
        `${source} cannot be empty; provide a valid JSON manifest path`,
      ),
    );
  }
  if (flags.manifestPath !== undefined) {
    throw new ConfigError(
      t(
        locale,
        `重复指定配置文件路径「${token}」(已指定「${flags.manifestPath}」), 请仅指定一份清单或运行 codd --help 查看用法`,
        `Duplicate manifest path '${token}' (already set to '${flags.manifestPath}'); specify only one manifest`,
      ),
    );
  }
  flags.manifestPath = token;
};

const validateExclusiveModes = (flags: CliFlags, locale: Locale): void => {
  if (flags.help || flags.version) return;
  if (flags.initSchema && flags.wizard) {
    throw new ConfigError(
      t(
        locale,
        'init 与 wizard 为互斥子命令, 请分别执行 codd init 或 codd wizard',
        "'init' and 'wizard' are mutually exclusive; run 'codd init' or 'codd wizard' separately",
      ),
    );
  }
  if (flags.initSchema && flags.manifestPath !== undefined) {
    throw new ConfigError(
      t(
        locale,
        `init 子命令仅用于导出参考模板, 不能与清单路径「${flags.manifestPath}」同时使用`,
        `'init' exports starter templates and cannot be combined with manifest path '${flags.manifestPath}'`,
      ),
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
      t(
        locale,
        'init 子命令会直接导出 schema/参考清单, 不支持与 --dry-run / --out / --rotate / --new-fingerprint 组合使用',
        "'init' cannot be combined with --dry-run, --out, --rotate, or --new-fingerprint",
      ),
    );
  }
};

export const parseCliArgs = (
  argv: string[],
  locale: Locale = 'zh',
): CliFlags => {
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

  if (argv[0] === 'update') {
    flags.update = true;
    flags.updateArgs = argv.slice(1);
    return flags;
  }

  if (argv[0] === 'lang') {
    flags.langSubcommand = true;
    flags.langArgs = argv.slice(1);
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
      assignManifestPath(
        flags,
        arg,
        t(locale, '位置参数', 'Positional argument'),
        locale,
      );
      i += 1;
      continue;
    }
    if (arg === '--') {
      afterDash = true;
      i += 1;
      continue;
    }
    if (arg === 'update' || arg === 'lang') {
      if (hasHelpFlag) {
        flags.help = true;
        i += 1;
        continue;
      }
      throw new ConfigError(
        arg === 'update'
          ? t(
              locale,
              'update 必须作为首个子命令使用 (正确用法: codd update [--check | --force | --pm <name> | --registry <url> | --verbose])',
              "'update' must be the first subcommand (usage: codd update [--check | --force | --pm <name> | --registry <url> | --verbose])",
            )
          : t(
              locale,
              'lang 必须作为首个子命令使用 (正确用法: codd lang [system|en|zh])',
              "'lang' must be the first subcommand (usage: codd lang [system|en|zh])",
            ),
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
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--new-fingerprint') {
      flags.newFingerprint = true;
    } else if (arg === '--rotate-all') {
      flags.rotate = 'all';
    } else if (arg === '--rotate') {
      if (flags.rotate !== 'all') flags.rotate = 'apps';
    } else if (arg === '--lang') {
      const next = argv[i + 1];
      if (next === undefined || next.trim() === '' || next.startsWith('-')) {
        throw new ConfigError(
          t(
            locale,
            '参数 --lang 缺少取值 (可选值: system | en | zh)',
            'Option --lang requires a value (expected: system | en | zh)',
          ),
        );
      }
      const parsed = parseLangPreference(next);
      if (parsed === null) {
        throw new ConfigError(
          t(
            locale,
            `参数 --lang 不支持 "${next}" (可选值: system | en | zh)`,
            `Invalid --lang value "${next}" (expected: system | en | zh)`,
          ),
        );
      }
      flags.lang = parsed;
      i += 1;
    } else if (arg.startsWith('--lang=')) {
      const raw = takeInlineValue(arg, '--lang=', locale);
      const parsed = parseLangPreference(raw);
      if (parsed === null) {
        throw new ConfigError(
          t(
            locale,
            `参数 --lang 不支持 "${raw}" (可选值: system | en | zh)`,
            `Invalid --lang value "${raw}" (expected: system | en | zh)`,
          ),
        );
      }
      flags.lang = parsed;
    } else if (arg === '-c' || arg === '--config') {
      assignManifestPath(
        flags,
        takeFlagValue(argv, i, arg, locale),
        arg,
        locale,
      );
      i += 1;
    } else if (arg.startsWith('--config=')) {
      assignManifestPath(
        flags,
        takeInlineValue(arg, '--config=', locale),
        '--config',
        locale,
      );
    } else if (arg === '-o' || arg === '--out') {
      flags.outDir = takeFlagValue(argv, i, arg, locale);
      i += 1;
    } else if (arg.startsWith('--out=')) {
      flags.outDir = takeInlineValue(arg, '--out=', locale);
    } else if (arg.startsWith('-')) {
      throw new ConfigError(
        t(
          locale,
          `未知选项「${arg}」, 请运行 codd --help 查看支持的命令与参数`,
          `Unknown option '${arg}'; run 'codd --help' for supported commands and flags`,
        ),
      );
    } else {
      assignManifestPath(
        flags,
        arg,
        t(locale, '位置参数', 'Positional argument'),
        locale,
      );
    }
    i += 1;
  }

  validateExclusiveModes(flags, locale);
  return flags;
};
