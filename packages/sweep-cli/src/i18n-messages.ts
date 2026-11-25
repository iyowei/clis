/**
 * `@iyowei/sweep-cli` 领域告警、错误与尾部摘要的英文转换层:
 * 保持 `@iyowei/sweep` API 主包内部协议文案与金样本语料零变更, 仅在 CLI 层 `locale === 'en'` 时做精确结构化翻译。
 */
import type { Locale } from '@iyowei/cli-i18n';
import { isSweepError } from '@iyowei/sweep';

export function localizeSweepError(
  error: unknown,
  activeConfigPath: string | undefined,
  locale: Locale,
): string {
  const baseMessage = error instanceof Error ? error.message : String(error);
  if (locale === 'zh') {
    return isSweepError(error) &&
      error.code === 'INVALID_ARGUMENT' &&
      activeConfigPath !== undefined
      ? `${baseMessage} (配置: ${activeConfigPath})`
      : baseMessage;
  }
  if (!isSweepError(error)) return baseMessage;

  switch (error.code) {
    case 'CONFIG_ABSENT':
      return `Configuration file not found (${error.details?.path ?? activeConfigPath ?? 'unknown'}); please check the path`;
    case 'CONFIG_READ_FAILED':
      return `Failed to read configuration (${error.details?.path ?? activeConfigPath ?? 'unknown'})${error.details?.errno ? ` [${error.details.errno}]` : ''}`;
    case 'CONFIG_CORRUPT_JSON':
      return `Invalid JSON in configuration (${error.details?.path ?? activeConfigPath ?? 'unknown'})`;
    case 'CONFIG_CORRUPT_SHAPE':
      return `Invalid configuration field '${error.details?.field ?? 'unknown'}' in ${error.details?.path ?? activeConfigPath ?? 'config'}`;
    case 'CONFIG_NEEDS_MIGRATION':
      return `Legacy configuration v${String(error.details?.version ?? 1)} requires migration (${error.details?.path ?? ''}); run 'sweep migrate'`;
    case 'CONFIG_MIGRATION_FAILED':
      return `Configuration migration failed (${error.details?.path ?? ''})`;
    case 'INVALID_ARGUMENT':
      return activeConfigPath !== undefined
        ? `Invalid configuration argument '${error.details?.field ?? ''}' (config: ${activeConfigPath})`
        : `Invalid argument '${error.details?.field ?? ''}'`;
    case 'CANCELLED':
      return `Operation cancelled during ${error.details?.phase ?? 'execution'}`;
  }
}

export function localizePlanTrailer(
  lines: readonly string[] | undefined,
  locale: Locale,
): string[] | undefined {
  if (lines === undefined || locale === 'zh') {
    return lines === undefined ? undefined : [...lines];
  }
  return lines.map((line) => {
    const suspectMatch = /^已跳过\s+(\d+)\s+处疑似安装树/.exec(line);
    if (suspectMatch !== null) {
      return `Skipped ${suspectMatch[1]} suspect install tree(s) · Pass --force to include`;
    }
    const crossMatch = /^已跳过\s+(\d+)\s+处跨设备挂载目标/.exec(line);
    if (crossMatch !== null) {
      return `Skipped ${crossMatch[1]} cross-device mount target(s)`;
    }
    const unmeasuredMatch = /^有\s+(\d+)\s+处目标未能统计体积/.exec(line);
    if (unmeasuredMatch !== null) {
      return `${unmeasuredMatch[1]} target(s) could not be sized and will be skipped`;
    }
    return line;
  });
}

export function localizeSweepWarningText(
  message: string,
  locale: Locale,
): string {
  if (locale === 'zh') return message;
  return message
    .replace(/^跳过不可读目录:\s*/, 'Skipped unreadable directory: ')
    .replace(/^体积统计降级:\s*/, 'Size measurement fallback: ')
    .replace(/^跨设备跳过:\s*/, 'Skipped cross-device target: ');
}
