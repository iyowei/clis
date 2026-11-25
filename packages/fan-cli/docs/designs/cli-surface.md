# `fan` CLI 命令面与输出契约

> 文档类型: CLI 薄壳包契约
> 所属包: `@iyowei/fan-cli` (见[CLI 包文档入口](../README.md))

## 1. 命令面

- `fan` / `fan status`: 读取并展示所有风扇的当前转速、目标转速、区间与模式 (`auto` / `manual`), 若存在持久化配置一并展示摘要。
- `fan set <speed>`: 手动设定全部风扇或 `--fan <index>` 指定风扇的目标转速 (支持绝对 RPM 如 `4000` 或百分比如 `60%`), 默认自动记住并确保后台守护就绪 (接管无外接屏合盖/睡眠停转与开盖/重启恢复)。
- `fan max`: 将目标风扇切为手动模式并设为各自最大转速 (`maxRpm`), 默认自动记住并确保后台守护就绪。
- `fan min`: 将目标风扇切为手动模式并设为各自最小转速 (`minRpm`), 默认自动记住并确保后台守护就绪。
- `fan auto`: 恢复目标风扇为系统自动温控 (`F{i}md = 0`), 并更新持久化状态为 `auto`。
- `fan apply`: 立即读取 `/Library/Application Support/iyowei-fan/state.json` 并应用至全部对应风扇。
- `fan persist [status|install|uninstall]`: 查看、安装或卸载系统级 `LaunchDaemon` (`com.iyowei.fan`), 负责开机/唤醒恢复与合盖/睡眠自动停转。
- `fan lang [system|en|zh]`: 查看或独立持久化 `fan` 的显示语言偏好 (`~/.config/fan/lang.json`, 默认 `system` 自动探测 macOS 系统首选语言)。
- `fan update`: 委托 `@iyowei/cli-updater` 执行跨包管理器自更新 (须作首个子命令)。

## 2. 选项

- `--fan <index>`: 仅作用于指定编号的风扇 (`status` / `set` / `max` / `min` / `auto`)。
- `--once`, `--no-save`: 仅用于 `set` / `max` / `min` / `auto`, 只改写当前硬件转速而不保存至持久化文件。
- `--json`: 以 JSON 格式输出 `FanStatusReport` 或 `PersistDaemonStatus`。
- `-w, --watch [sec]`: 仅用于 `status`, 按指定秒数 (默认 `1`) 持续刷新输出。
- `--lang <system|en|zh>`: 单次覆盖显示语言 (优先级: `--lang` > `FAN_LANG` > `CLIS_LANG` > `~/.config/fan/lang.json` > 系统语言)。
- `-V, --version` / `-h, --help`: 输出版本号或统一左对齐的分层帮助页。

## 3. 退出码与渲染降级

- 退出码 `0`: 正常完成 (含 `--version`、`--help`、`persist`、`apply`、`lang`、`update` 及正常读写控制)。
- 退出码 `1`: 参数校验失败、平台不支持、SMC/守护操作异常或 `sudo` 提权失败。
- 当 `NO_COLOR` 存在、`TERM=dumb` 或输出流非 TTY 时, 自动省略 ANSI 转义序列输出纯文本。
