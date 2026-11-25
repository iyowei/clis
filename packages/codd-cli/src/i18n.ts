/**
 * `@iyowei/codd-cli` 语言上下文与公式/警告/错误英文化映射层:
 * 保持 `@iyowei/codd` API 主包产出契约零改动, 在 CLI 与交互向导层按当前 `locale` 切换 Apple HIG 级英文界面。
 */
import { type Locale, t } from '@iyowei/cli-i18n';
import type { FormulaStep } from '@iyowei/codd';

let currentLocale: Locale = 'zh';

export function getCoddLocale(): Locale {
  return currentLocale;
}

export function setCoddLocale(locale: Locale): void {
  currentLocale = locale;
}

export function ct<T>(zh: T, en: T): T {
  return t(currentLocale, zh, en);
}

export function localizeHardwareSummary(
  summary: string,
  locale: Locale = currentLocale,
): string {
  if (locale === 'zh') return summary;
  return summary
    .replace(/\s*核\s*/g, ' Cores ')
    .replace(/\s*内存\s*/g, ' RAM ')
    .replace(/\s*硬盘\s*/g, ' Disk ')
    .replace('读写均衡', 'Balanced')
    .replace('高频写入', 'Write-Heavy')
    .replace('高频读取', 'Read-Heavy')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function localizeFormulaStep(
  step: FormulaStep,
  locale: Locale = currentLocale,
): FormulaStep {
  if (locale === 'zh') return step;
  switch (step.key) {
    case 'WT_CACHE_GB':
      return {
        ...step,
        label: 'WiredTiger Cache',
        plainReason:
          'Reserves headroom for OS page cache, sorting, and client connections',
      };
    case 'MEMORY_RESERVATION':
      return {
        ...step,
        label: 'Container Memory',
        plainReason: `Elastic memory usage capped safely at ${step.value}`,
      };
    case 'maxIncomingConnections':
      return {
        ...step,
        label: 'Max Connections',
        value: step.value.replace(/\s*个$/, ''),
        plainReason:
          'Derived from non-cache RAM headroom to prevent OOM under load',
      };
    case 'oplogSizeMB':
      return {
        ...step,
        label: 'Oplog Window',
        plainReason:
          'Supports multi-document transactions and replica catch-up',
      };
    case 'blockCompressor': {
      const codec = step.value.split(/\s+/)[0] ?? 'zstd';
      return {
        ...step,
        label: 'Compression',
        value: `${codec} enabled`,
        plainReason:
          codec === 'snappy'
            ? 'Low-CPU Snappy compression preserves write throughput & latency'
            : 'Zstd block & network compression saves ~70% storage and bandwidth',
      };
    }
    case 'ulimit / grace / slowOp':
      return {
        ...step,
        label: 'Limits & Grace',
        plainReason:
          'Raises nofile >= 65536 and grants safe checkpoint flush time on stop',
      };
    default:
      return step;
  }
}

export function localizeCoddWarning(
  warning: string,
  locale: Locale = currentLocale,
): string {
  if (locale === 'zh') return warning;
  const connMatch =
    /预期连接数\s+(\d+)\s+超出当前\s+(\S+)\s+内存的承受上限.*限制为\s+(\d+)/.exec(
      warning,
    );
  if (connMatch !== null) {
    return `Requested ${connMatch[1]} connections exceeds safe RAM ceiling (${connMatch[2]}): capped at ${connMatch[3]} connections`;
  }
  const lowMemMatch = /当前仅分配了\s+(\S+)\s+GB\s+内存/.exec(warning);
  if (lowMemMatch !== null) {
    return `Only ${lowMemMatch[1]} GB RAM allocated (< 2 GB recommended): heavy sorts or >50 connections may risk OOM`;
  }
  return warning;
}

export function localizeCoddError(
  message: string,
  locale: Locale = currentLocale,
): string {
  if (locale === 'zh') return message;
  return message
    .replace(/^未找到配置文件\s*/, 'Configuration file not found: ')
    .replace(/^无法读取配置文件\s*/, 'Failed to read configuration file: ')
    .replace(/^配置文件 JSON 语法错误/, 'Invalid JSON syntax in configuration')
    .replace(/请运行 codd --help 查看说明/g, "run 'codd --help' for usage")
    .replace(/请运行 codd --help 查看用法/g, "run 'codd --help' for usage");
}
