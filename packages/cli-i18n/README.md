# `@iyowei/cli-i18n`

> 仓内共享私有库 (`"private": true`, `"clisRole": "shared-lib"`), 零第三方运行时依赖, 为 `clis` 集合内全部 CLI 工具提供统一的操作系统语言探测、按工具独立持久化的语言偏好 (`system | en | zh`)、`lang` 子命令、`--lang` 旗标解析与中英混排终端列宽计算。

## 核心设计

1. **按工具独立持久化 (默认 `system`)**:
   - 每个 CLI 工具独立维护自己的语言偏好文件: POSIX 为 `~/.config/<tool>/lang.json`, Windows 为 `%APPDATA%\<tool>\lang.json`;
   - 默认值为 `"system"`, 互不干扰; 当某个工具显式设为 `"en"` 时, 即使宿主机操作系统语言为中文, 该工具也固定以英文展示。
2. **四层确定性优先级**:
   - `--lang <system|en|zh>` (单次命令行旗标) > `<TOOL>_LANG` (工具专属环境变量, 如 `FAN_LANG` / `SWEEP_LANG` / `CODD_LANG` / `CREATE_CLIS_LANG`) > `CLIS_LANG` (全集合环境变量兜底) > `lang.json` 落盘配置 (缺省 `"system"`)。
3. **原生操作系统界面语言识别 (`system`)**:
   - **macOS**: 直接零子进程解析 `~/Library/Preferences/.GlobalPreferences.plist` (`bplist00` 二进制与 XML 双格式) 中的 `AppleLanguages` / `AppleLocale`, 避免被终端常见的默认 `LANG=en_US.UTF-8` 误判;
   - **Windows**: 读取注册表 `HKCU\Control Panel\Desktop\PreferredUILanguages` / `LocaleName`, 回退 `Intl`;
   - **Linux**: 按 `LC_ALL` > `LC_MESSAGES` > `LANG` 读取, 遇 `C` / `C.UTF-8` / `POSIX` 时回退读取 `/etc/locale.conf` 或 `/etc/default/locale`。
