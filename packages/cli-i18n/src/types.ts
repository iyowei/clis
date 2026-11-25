/**
 * `@iyowei/cli-i18n` 公共类型定义: 语言标识、用户偏好、系统语言探测快照与 `lang` 子命令入参。
 */

/** CLI 实际生效的界面语言 (`zh`: 简体中文; `en`: 英文) */
export type Locale = 'zh' | 'en';

/** 用户可设置的语言偏好 (`system` 默认跟随操作系统语言) */
export type LangPreference = 'system' | Locale;

/** 当前语言偏好的命中来源 */
export type LangSource =
  'flag' | 'tool-env' | 'suite-env' | 'config' | 'default';

/** 操作系统原生语言探测结果 */
export interface DetectedSystemLocale {
  locale: Locale;
  rawTag: string;
  method:
    | 'test-override'
    | 'macos-prefs'
    | 'windows-ui'
    | 'linux-conf'
    | 'env'
    | 'intl'
    | 'fallback';
}

/** 完整语言决策快照 */
export interface ResolvedLocale {
  /** 本次实际生效的展示语言 */
  locale: Locale;
  /** 本次命中的偏好设定 (`system` | `en` | `zh`) */
  preference: LangPreference;
  /** 偏好设定来源 */
  source: LangSource;
  /** 工具专属环境变量名 (如 `FAN_LANG`) */
  envVarName: string;
  /** 该工具独立的持久化配置文件路径 */
  configPath: string;
  /** 底层操作系统语言探测结果 */
  system: DetectedSystemLocale;
}

/** 解析当前 CLI 生效语言的选项 */
export interface ResolveLocaleOptions {
  /** 工具配置目录标识 (如 `fan` / `sweep` / `codd` / `create-clis`) */
  toolName: string;
  /** 命令行 `--lang` 传入的偏好值 */
  flag?: LangPreference | string;
  /** 自定义工具专属环境变量名 (缺省由 `toolName` 派生 `<TOOL>_LANG`) */
  envVarName?: string;
  /** 目标平台 (测试可注入, 缺省 `process.platform`) */
  platform?: NodeJS.Platform;
  /** 家目录 (测试可注入, 缺省 `os.homedir()`) */
  homedir?: string;
  /** 环境变量表 (测试可注入, 缺省 `process.env`) */
  env?: Record<string, string | undefined>;
  /** 显式覆写语言配置文件路径 (测试可注入) */
  configPath?: string;
  /** 显式注入系统语言探测函数 (测试可注入) */
  detectSystem?: () => DetectedSystemLocale;
}

/** 统一 `<cli> lang` 子命令执行选项 */
export interface LangCommandOptions extends ResolveLocaleOptions {
  /** CLI 命令名 (如 `fan` / `sweep` / `codd` / `create-clis`) */
  binName: string;
  /** `lang` 子命令之后的参数列表 */
  argv: readonly string[];
  /** 双通道着色开关 */
  color?: { stdout: boolean; stderr: boolean };
  /** 参数错误时的退出码 (默认 1; 像 `fan` 这类区分用法错误的 CLI 可传 2) */
  invalidExitCode?: number;
  /** 标准输出写行钩子 */
  out?: (line: string) => void;
  /** 标准错误写行钩子 */
  err?: (line: string) => void;
}
