/**
 * `@iyowei/sweep` 包级 API harness 具名探针注册表 (协议规范见 api-harness-protocol.md §4)。
 * 由通用 `scripts/transcription/api-harness.ts` 按包目录动态加载, 消除通用引擎对领域符号的硬编码。
 */
export function createProbes(
  api: Record<string, unknown>,
): Record<string, unknown> {
  return {
    'pathops.posix': api.POSIX_STYLE,
    'pathops.win32': api.WIN32_STYLE,
    'deviceProbe.uniform': async () => 1,
  };
}
