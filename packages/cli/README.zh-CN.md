# sweep-node-modules

[![CI](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml)

[English](README.md) | **中文**

工作区级 `node_modules` 清理工具: 一次扫描多个根目录, 跨项目列出各处 `node_modules` 与体积, 确认后批量删除, 回收磁盘空间。

> 分层说明: 单项目清理工具管「进入某个项目, 清它自己的产物」; 本工具管「站在工作区层面, 一次清理很多个项目」。两者分层共存, 见 [ADR 0001](../../docs/adrs/0001-workspace-level-cleaner.md)。

## 要求

- 业务逻辑**双运行时**: 有 bun 走 bun, 否则 node (功能一致, bun 启动更快)。
- 取最新一代运行时 API: bun 任意近期版本; node 需原生支持 TypeScript 直跑的版本 (源码方式与包方式取同一版本下限; 版本快照与实测记录见 [ADR 0006](../../docs/adrs/0006-dual-runtime-bun-first.md))。
- 零第三方运行时依赖 (只用运行时内置能力)。
- 平台: Windows / macOS / Linux 三平台均可运行 (见 [ADR 0007](../../docs/adrs/0007-platform-portability.md))。

## 安装

三种方式, 按你机器上已有的运行时挑。**每条下的「需要」是硬门槛**:

> **机器上只有 bun、没装 node?** 直接走 ① 或 ③; ② 的全局安装 (npm 与 bun 皆然) 都需要 node。

① ② 都经包注册表取包: 本机若配置了镜像源、且该镜像尚未同步到想装的版本, 可在命令后临时加 `--registry=https://registry.npmjs.org` 直连官方源。

### ① 免安装 (试用或偶尔用)

```shell
# 机器上有 bun
bunx @iyowei/sweep-node-modules-cli

# 机器上有 node (npx 随 npm 一同安装, 本身就需要 node)
npx @iyowei/sweep-node-modules-cli
```

- **需要**: bun 或 node, 与所选命令对应
- 特点: 零安装; 每次运行会解析一次包
- 注意: `bunx` 与 `npx` 各自依附一个运行时, 不是可互换的通用选项: 只有 bun 的机器没有 `npx`, 只有 node 的机器没有 `bunx`

### ② 包管理器全局安装 (常用推荐)

```shell
npm install -g @iyowei/sweep-node-modules-cli
bun install -g @iyowei/sweep-node-modules-cli
```

- **需要**: **node** (两条命令都要)。npm 本身跑在 node 上; `bun install -g` 生成的是指向入口文件的符号链接, 执行时由系统内核读该文件的 shebang (node) 来决定解释器, 应用层插不上手
- 特点: 装一次后直接敲 `sweep-nm`; 有 bun 时业务逻辑仍优先走 bun

### ③ 从源码 (开发, 或无 node 环境)

**macOS / Linux**:

```shell
# 克隆后进入仓库根 (路径按你的实际位置调整)
cd "<克隆位置>/sweep-node-modules"

chmod +x packages/cli/bin/sweep-nm

# 软链进 ~/.local/bin (通常已在 PATH 中), 启动器会挑选运行时
ln -sf "$PWD/packages/cli/bin/sweep-nm" ~/.local/packages/cli/bin/sweep-nm
```

**Windows** (PowerShell):

```powershell
# 把仓库的 bin 目录加入用户 PATH, 只需一次, 重开终端后生效
# 路径按你的实际克隆位置调整 (启动器靠自身位置定位 src, 故不能把脚本单独复制走)
$bin = "$env:USERPROFILE\tools\sweep-node-modules\packages\cli\bin"
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

> 也可以不经命令行: 在「系统属性 → 环境变量」里把该 `bin` 目录加到用户变量 `Path` 中。

- **需要**: bun 或 node 任一 (启动器是 shell / cmd 脚本, 由系统执行, 不依赖 node)
- 特点: 入口最直接; 之后直接敲 `sweep-nm` (Windows 经 `packages\cli\bin\sweep-nm.cmd`)

> 本工具同时提供可编程 API 包 `@iyowei/sweep-node-modules`, 供在程序或脚本中调用 (用法见该包文档)。

## 使用

```shell
# 预览: 列出配置中各根目录下所有 node_modules 与体积, 不动手
sweep-nm

# 复核无误后执行删除
sweep-nm --yes

# 连同「疑似安装树」一并删除 (包管理器 / 版本管理器 / 编辑器扩展等安装树, 默认跳过)
sweep-nm --yes --force

# 临时追加排除(可重复)
sweep-nm --exclude my-kits --exclude url-tool

# 只清理名单命中的目录(可重复, 与配置合并)
sweep-nm --include my-kits

# 查看实际生效的配置文件位置与状态 (来源 / 路径 / 是否存在)
sweep-nm config

# 初始化向导: 交互式生成配置文件
sweep-nm init
```

清单顶栏尾部会标注本次实际使用的运行时 (如 `bun 1.4.2`), 仅交互终端显示 (非 TTY 不增噪音)。

## 配置

配置文件位置 (平台自适应): Windows 为 `%APPDATA%\sweep-node-modules\config.json`, 其余为 `~/.config/sweep-node-modules/config.json`; 可用 `--config` 或环境变量 `SWEEP_NM_CONFIG` 覆盖, 本次实际生效的路径与文件状态用 `sweep-nm config` 查看。**写入侧须为真实路径形态**: 配置路径及其祖先链有符号链接介入 (系统链接 `/tmp`、`/var` 也在内) 时, `sweep-nm init` 落盘前会拒写并给出链接定位, 按提示改写成真实路径形态 (如 `/private/tmp/x`) 即放行。

```json
{
  "roots": [
    "/Users/iyowei/workspace/development",
    "/Users/iyowei/self/development"
  ],
  "exclude": ["my-kits"],
  "include": []
}
```

- `roots`: 扫描根目录, 任意多个; 重复或嵌套的根按真实路径去重。**删除侧须为真实路径形态**: 根及其祖先链不得有符号链接介入 (系统链接 `/tmp`、`/var` 也在内), 命中则 `--yes` 整批拒绝并按提示改写成真实路径 (如 `/private/tmp/x`) 即放行; 扫描侧不受此限 (根为符号链接照常扫描)。
- `exclude`: 排除名单; 从根到 `node_modules` 的任意一级目录名命中即跳过 (多排除 = 少删, 安全方向)。**不写该字段时取内置默认名单** (包管理器 / 版本管理器的安装树、编辑器扩展目录、系统与应用数据根, 词表与理由见[设计文档](../../docs/designs/config-and-initialization.md)「默认排除名单」; 这批名字零命中不告警, 它们依平台而异); 显式写出该字段 (含写空数组) 即以你自己的名单为准。
- **疑似安装树默认不进删除批**: 安装树形态的目标 (如 `~/.bun/install/global/node_modules`、`<版本目录>/lib/node_modules`、编辑器扩展目录) 在清单里带 `疑似安装树: <理由>` 标记且保留 `node_modules` 后缀, `--yes` 不删它们 (计失败并给跳过说明); 要清理须显式加 `--force`, 它只放行这一批目标, 不放宽删除安全闸。
- **跨设备目标默认不进删除批**: 目标与所属根不在同一文件系统时 (根之下挂了云盘 / 网络盘 / 容器卷, 条目落在那一卷上) 同样不删, 清单行尾标注 `跨设备: 根与目标之间有挂载点` 或 `跨设备: 目标本体即挂载点`; 前者把该挂载点加进 `roots` 即可照常清理, 后者 (目标本体就是挂载点) 只能先卸载该卷; `--force` 不放行这一类。
- `include`: 包含名单 (白名单); 命中才纳入, 口径与 `exclude` 同款; 缺省或空数组 = 不过滤 (多包含 = 多删); 与 `exclude` 同时命中时 `exclude` 优先。写错名字会让结果直接为空, 故未命中的名字会在 stderr 警示。
- 两份名单里的 `node_modules` 与 `.git` 一律被剔除: 前者是本工具的目标 (列入排除等于排掉唯一目标, 列入包含则永久零命中), 后者是扫描恒定跳过的目录; 剔除后 `include` 为空数组 = 不过滤 (不是「只扫 node_modules」)。
- 首次运行且无配置: 交互终端下自动进入初始化向导 (扫描根默认家目录); 非交互环境 (脚本等) 以当前工作目录为根并提示, 不询问; 随时可用 `sweep-nm init` 重进向导。

> 字段定义以[设计文档](../../docs/designs/config-and-initialization.md)为准。

## 安全防护

删除是这套工具唯一不可逆的动作, 围绕它攒下了一整套防护纪律。下面挑出分量最重的几条; 全量版 (含已知残余风险的诚实账) 见 [安全防护保障](../../docs/safety-guardrails.md)。

> 这套工具的性格, 一句话: 看不准的时候, 默认不删。

**默认什么都不做。** 预览是默认态, 删除要显式加 `--yes`; 没有配置文件时 `--yes` 被硬拒绝, 零删除; 向导刚写入配置的那一轮强制预览, 即便带了 `--yes` 也只预览。`--force` 只放行「疑似安装树」这一批目标, 不放宽任何删除安全闸。

**删什么, 由名字与归属双重判定。** 只认名字恰为 `node_modules` 的目录, 且必须落在声明的扫描根之下; 归属按路径层级判定, 不是字符串前缀, 上溯与冒名路径一概拒绝。体积测不到的目标一律不删: 宁可留着, 不猜。两类目标默认拦下: 删了装不回来的「疑似安装树」 (要清理须显式加 `--force`), 与落在另一文件系统上的跨设备目标 (`--force` 同样不放行); 另有一份缺省排除名单 (包管理器 / 版本管理器 / 编辑器扩展与系统数据根的名字) 挨着就不扫。

**一处不过, 整批不删; 动手前逐级复核。** 任一目标没通过检查, 整批一个都不删, 而不是逐条放行; 删除前自根至目标父目录逐级复核, 半路被掉包就整批停手。配置根或其祖先被换成符号链接时, 删除整批拒绝, 拒绝文案自带改写方向; 系统固有链接 (`/tmp`、`/var` 这类) 同样命中, 改写成真实路径形态即放行。

**符号链接: 门槛跟着可逆性走。** 同一份配置, 只读的扫描面照常跟进 (根为符号链接照常出清单), 不可逆的删除面整批拒绝, 写入面 (`init` 落盘) 有链接介入就一个字节不落。这个分叉是有意的: 链接的来路判不了, 就不放行不可逆的那一步。

**输出面不可伪造。** 一切外部数据 (磁盘上的目录名、命令报错、名单拼写) 进输出前先净化: 剥控制字节、折叠换行, 防终端控制序列注入, 也防换行劈出伪造的可信行; 名字被净化改写时行尾标注。被跳过的目标带标注留在清单里, 末尾有跳过计数。名单里没命中的名字会在 stderr 告警, 白名单全零命中还点明「结果必为空」; 错误文案含错误码、人话、目标定位与部分删除复查提示, 「没删」与「删失败」分开展示。

**分发链路可自证。** 零第三方运行时依赖, 运行路径无网络调用; npm 安装者拿到的产物用前先与随附清单对账摘要, 不符即拒收; 发布侧另设四重闸门: 干净检出、本提交产物、清单自洽、发布包文件白名单; 仓库根散落的文件 (如 README 的备份) 进不了包。

## 开发

环境准备、常用命令、双运行时验证与提交钩子, 见 [开发指南](../../docs/development.md)。

## 文档

- [工程技术文档总索引](../../docs/README.md)
