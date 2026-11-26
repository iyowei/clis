# `wake` CLI 命令面与输出契约

> 文档类型: CLI 薄壳包契约
> 所属包: `@iyowei/wake-cli` (见[CLI 包文档入口](../README.md))

## 1. 命令面

- `wake` / `wake <target>`: 读取 `~/.config/wake/config.json` (或 `%APPDATA%\wake\config.json`) 解析目标或 `defaultTarget`, 先探在线态再按中继故障转移或本机直发唤醒包并默认等待端口上线。
- `wake list`: 只读展示已配置目标清单、MAC、探测主机、中继链表与默认目标。
- `wake init`: 在 TTY 下自动探测局域网 ARP 邻接表辅助交互录入, 或凭 `--name` + `--mac` 非交互写入目标配置。
- `wake doctor [<target>]`: 严格只读排查配置文件、本机物理/虚拟网卡、目标在线状态及关联 SSH 中继节点可用性 (绝不发 WoL 包)。
- `wake lang [system|en|zh]`: 查看或独立持久化 `wake` 界面语言偏好 (`~/.config/wake/lang.json`)。
- `wake update`: 委托 `@iyowei/cli-updater` 执行跨包管理器自更新 (须作首个子命令)。

## 2. 选项

- `-c, --config <path>`: 显式覆盖配置文件路径 (优先级高于 `WAKE_CONFIG`)。
- `-m, --mac <mac>` / `-H, --host <host>` / `-p, --port <port>` / `-b, --broadcast <ip>` / `-r, --relay <ssh>`: 覆盖配置或免配置直发目标参数 (`--mac` / `--broadcast` / `--relay` 可重复传值)。
- `-t, --timeout <sec>` / `--no-wait` / `--force`: 控制就绪等待超时 (`1-600s`, 缺省 `90s`)、发包即退及忽略在线短路强制重发 (`init` 下 `--force` 允许覆盖同名目标)。
- `--local-only` / `--no-local-fallback`: 强制绕过中继仅本机广播, 或中继全失败时严禁回退本机发包。
- `--name <target>` / `--default` / `--yes`: 专用于 `wake init` 非交互模式配置录入。
- `--json` / `--lang <system|en|zh>` / `-V, --version` / `-h, --help`: 结构化输出、语言覆盖、版本与双语分层帮助。

## 3. 退出码与渲染降级

- 退出码 `0`: 已在线、成功唤醒就绪、无等待发包完成 (`--no-wait`) 及 `list`/`init`/`doctor`/`lang`/`update`/`-V`/`-h`。
- 退出码 `1`: 参数校验失败、配置缺失或损坏、全部传输路径失败或等待上线超时 (`timeout`)。
- 当 `NO_COLOR` 为真值、`TERM=dumb` 或输出流非 TTY 时, 自动省略 ANSI 转义与动态进度覆盖。
