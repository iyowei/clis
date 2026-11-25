/**
 * Bun 测试宿主确定性隔离:
 * 1. 默认系统语言固定为 `zh-CN` (仅当用例未显式覆写 `CLIS_TEST_OS_LOCALE` 时生效);
 * 2. 记录真实宿主机 `HOME` (`CLIS_TEST_REAL_HOME`), 防止开发者本机 `~/.config/<tool>/lang.json`
 *    泄漏进未隔离 `HOME` 的直接 `bun test` 单测调用 (显式传临时 `HOME`/`homedir` 的用例照常读写 `lang.json`)。
 */
process.env.CLIS_TEST_OS_LOCALE ??= 'zh-CN';
process.env.CLIS_TEST_REAL_HOME ??=
  process.env.HOME ?? process.env.USERPROFILE ?? '';
