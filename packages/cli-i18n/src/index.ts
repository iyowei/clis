/**
 * `@iyowei/cli-i18n` 公共导出面: 系统语言探测、按工具独立偏好持久化、`--lang` 剥离与 `lang` 子命令。
 */
export {
  classifyLocaleTag,
  detectSystemLocale,
  type DetectSystemLocaleOptions,
  parseLangPreference,
} from './detect.ts';
export { formatLangHelp, runLangCommand } from './lang-command.ts';
export {
  alignHelpRow,
  computeHelpDescColumn,
  defaultToolLangEnvVar,
  displayWidth,
  padEndDisplay,
  padStartDisplay,
  readPersistedLang,
  resolveCliLocale,
  resolveLangConfigPath,
  type StripLangResult,
  stripLangArgs,
  t,
  writePersistedLang,
} from './resolve.ts';
export type {
  DetectedSystemLocale,
  LangCommandOptions,
  LangPreference,
  LangSource,
  Locale,
  ResolveLocaleOptions,
  ResolvedLocale,
} from './types.ts';
